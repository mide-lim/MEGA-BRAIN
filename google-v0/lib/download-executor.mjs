import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ended=new WeakMap();
const helper=fileURLToPath(new URL('./download-supervisor.py',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function downloadProcessEnded(value,receiptScope=undefined){
  return value!==null&&(typeof value==='object'||typeof value==='function')&&ended.has(value)&&ended.get(value)===receiptScope;
}
// This API is for existing internal executable/argument lists, never shell text.
export async function executeDownloadProcess(file,args=[],options={}){
  if(!options||typeof options!=='object')throw new TypeError('Invalid supervised command options.');
  const timeout=options.timeout??180000,maxBuffer=options.maxBuffer??262144;
  const encoding=options.encoding??'utf8';
  if(typeof file!=='string'||!file||!Array.isArray(args)||args.some(x=>typeof x!=='string')||
    !Number.isSafeInteger(timeout)||timeout<1||timeout>600000||
    !Number.isSafeInteger(maxBuffer)||maxBuffer<1||maxBuffer>16777216||options.shell||
    (encoding!=='buffer'&&(typeof encoding!=='string'||!Buffer.isEncoding(encoding)))||
    (options.signal!==undefined&&!(options.signal instanceof AbortSignal))||
    (options.cwd!==undefined&&options.cwd!==null&&typeof options.cwd!=='string')||
    (options.receiptScope!==undefined&&(options.receiptScope===null||typeof options.receiptScope!=='object')))
    throw new TypeError('Invalid supervised command options.');
  const nonce=randomBytes(32).toString('hex');
  const request=JSON.stringify({nonce,file,args,timeout,max_buffer:maxBuffer,
    cwd:options.cwd??null,env:options.env??null});
  if(Buffer.byteLength(request)>1048576)throw new TypeError('Supervised request exceeds limit.');
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['-I',helper],{stdio:['pipe','pipe','pipe','pipe'],windowsHide:true});
    const chunks=[[],[]],lengths=[0,0];let receipt='',issue=null,settled=false;
    const interrupt=code=>{
      issue??=code;
      if(child.pid)child.kill('SIGTERM');
    };
    const aborted=()=>interrupt('ABORT_ERR');
    const timer=setTimeout(()=>interrupt('ETIMEDOUT'),timeout+1000);
    const hardTimer=setTimeout(()=>{interrupt('ETIMEDOUT');child.kill('SIGKILL');},timeout+2000);
    const finish=()=>{
      settled=true;clearTimeout(timer);clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort',aborted);
    };
    for(let i=0;i<2;i++)[child.stdout,child.stderr][i].on('data',chunk=>{
      const keep=Math.min(chunk.length,Math.max(0,maxBuffer-lengths[i]));
      if(keep)chunks[i].push(chunk.subarray(0,keep));
      lengths[i]+=chunk.length;
      if(lengths[i]>maxBuffer)interrupt('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });
    child.stdio[3].on('data',chunk=>{
      if(Buffer.byteLength(receipt)+chunk.length>4096){interrupt('ERR_DOWNLOAD_SUPERVISOR');return;}
      receipt+=chunk.toString('utf8');
    });
    child.stdio[3].on('error',()=>interrupt('ERR_DOWNLOAD_SUPERVISOR'));
    child.stdin.on('error',()=>{issue??='ERR_DOWNLOAD_SUPERVISOR';});
    child.on('error',error=>{
      if(settled)return;finish();
      reject(Object.assign(new Error('Download supervisor unavailable.'),{
        code:error.code??'ERR_DOWNLOAD_SUPERVISOR',stdout:'',stderr:'',killed:false,signal:null}));
    });
    child.on('close',(supervisorCode,signal)=>{
      if(settled)return;finish();
      const bytes=chunks.map(x=>Buffer.concat(x));
      const output=bytes.map(x=>encoding==='buffer'?x:x.toString(encoding));
      let proof=null;
      try{proof=JSON.parse(receipt);}catch{/* A missing or malformed receipt fails closed. */}
      const keys=['v','nonce','status','exit_code','subreaper','wait','stdout_bytes','stderr_bytes','stdout_sha256','stderr_sha256'];
      const shape=proof&&typeof proof==='object'&&!Array.isArray(proof)&&
        Object.keys(proof).length===keys.length&&keys.every(key=>Object.hasOwn(proof,key));
      const verified=shape&&supervisorCode===0&&signal===null&&proof.v===1&&proof.nonce===nonce&&
        proof.subreaper===true&&proof.wait==='ECHILD'&&
        Number.isInteger(proof.exit_code)&&proof.exit_code>=0&&proof.exit_code<=255&&
        proof.stdout_bytes===lengths[0]&&proof.stderr_bytes===lengths[1]&&
        lengths.every(x=>x<=maxBuffer)&&proof.stdout_sha256===digest(bytes[0])&&proof.stderr_sha256===digest(bytes[1]);
      const normal=verified&&proof.status==='normal'&&!issue;
      if(normal&&proof.exit_code===0){
        const result={stdout:output[0],stderr:output[1]};ended.set(result,options.receiptScope);resolve(result);return;
      }
      if(!issue&&shape&&proof.nonce===nonce){
        if(proof.status==='timeout')issue='ETIMEDOUT';
        if(proof.status==='output_limit')issue='ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if(proof.status==='interrupted')issue='ABORT_ERR';
      }
      const code=issue??(normal?proof.exit_code:'ERR_DOWNLOAD_SUPERVISOR');
      const error=Object.assign(new Error('Supervised download command failed.'),{
        code,stdout:output[0],stderr:output[1],killed:!normal,signal:signal??null});
      if(normal)ended.set(error,options.receiptScope);
      reject(error);
    });
    if(options.signal){
      options.signal.addEventListener('abort',aborted,{once:true});
      if(options.signal.aborted)aborted();
    }
    child.stdin.end(request+'\n');
  });
}
