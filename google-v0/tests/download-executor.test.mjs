import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {executeDownloadProcess,downloadProcessEnded} from '../lib/download-executor.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=(source,options)=>executeDownloadProcess(process.execPath,['-e',source],options);
async function failure(action){
  try{await action;assert.fail('Expected command failure');}catch(error){
    if(error.code==='ERR_ASSERTION')throw error;
    return error;
  }
}
async function untilFile(path){
  for(let attempt=0;attempt<200;attempt++){
    try{return await readFile(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    await delay(10);
  }
  assert.fail('Fixture did not become ready');
}
function kill(pid){try{process.kill(Number(pid),'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
async function fixture(action){
  const folder=await mkdtemp(join(tmpdir(),'megabrain-supervisor-test-'));
  const pidFile=join(folder,'pid'),gate=join(folder,'gate');let pending;
  try{await action({folder,pidFile,gate,setPending:value=>{pending=value;}});}
  finally{
    await writeFile(gate,'stop');
    try{kill(await readFile(pidFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(pending)await pending.catch(()=>{});
    await rm(folder,{recursive:true,force:true});
  }
}

test('normal stdout/stderr and exit 1 have private positive receipts',async()=>{
  const result=await run('console.log("ok");console.error("diagnostic")');
  assert.deepEqual(result,{stdout:'ok\n',stderr:'diagnostic\n'});
  assert.equal(downloadProcessEnded(result),true);
  const error=await failure(run('console.error("normal failure");process.exit(1)'));
  assert.equal(error.code,1);assert.equal(error.killed,false);
  assert.equal(error.stderr,'normal failure\n');assert.equal(downloadProcessEnded(error),true);
  assert.equal(downloadProcessEnded({...error}),false);
  assert.equal(downloadProcessEnded(JSON.parse(JSON.stringify(result))),false);
  assert.equal(downloadProcessEnded({processEnded:true,code:1}),false);
});

test('receipt scope binds identity to its exact call, including concurrent calls',async()=>{
  const first={},second={};
  const [a,b]=await Promise.all([run('',{receiptScope:first}),run('',{receiptScope:second})]);
  assert.equal(downloadProcessEnded(a,first),true);
  assert.equal(downloadProcessEnded(a,second),false);
  assert.equal(downloadProcessEnded(a),false);
  assert.equal(downloadProcessEnded(b,first),false);
  assert.equal(downloadProcessEnded(b,second),true);
  const error=await failure(run('process.exit(1)',{receiptScope:first}));
  assert.equal(downloadProcessEnded(error,first),true);
  assert.equal(downloadProcessEnded(error,second),false);
});

test('normal exit 1 waits for detached descendant with closed stdout/stderr',async()=>{
  await fixture(async({pidFile,gate,setPending})=>{
    const descendant='const fs=require("fs");fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(gate)+')){clearInterval(timer);process.exit(0)}},10)';
    const source='const {spawn}=require("child_process");const child=spawn(process.execPath,["-e",'+JSON.stringify(descendant)+'],{detached:true,stdio:"ignore"});child.unref();process.exit(1)';
    let settled=false;
    const pending=failure(run(source,{timeout:3000})).then(value=>{settled=true;return value;});
    setPending(pending);await untilFile(pidFile);await delay(60);
    assert.equal(settled,false,'parent exit/pipe EOF is insufficient');
    await writeFile(gate,'finish');
    const error=await pending;
    assert.equal(error.code,1);assert.equal(downloadProcessEnded(error),true);
  });
});

test('normal exit 1 waits for setsid and double-fork descendant',async()=>{
  await fixture(async({pidFile,gate,setPending})=>{
    const script=[
      'import os,time',
      'if os.fork(): os._exit(1)',
      'os.setsid()',
      'if os.fork(): os._exit(0)',
      'os.close(0);os.close(1);os.close(2)',
      'open('+JSON.stringify(pidFile)+',"w").write(str(os.getpid()))',
      'while not os.path.exists('+JSON.stringify(gate)+'): time.sleep(.01)',
      'os._exit(0)'
    ].join('\n');
    let settled=false;
    const pending=failure(executeDownloadProcess('python3',['-c',script],{timeout:3000}))
      .then(value=>{settled=true;return value;});
    setPending(pending);await untilFile(pidFile);await delay(60);
    assert.equal(settled,false);
    await writeFile(gate,'finish');
    const error=await pending;
    assert.equal(error.code,1);assert.equal(downloadProcessEnded(error),true);
  });
});

test('timeout kills adopted detached tree but never supplies positive proof',async()=>{
  await fixture(async({pidFile,setPending})=>{
    const script='import os,time\nif os.fork(): os._exit(1)\nos.setsid()\nif os.fork(): os._exit(0)\nopen('+JSON.stringify(pidFile)+',"w").write(str(os.getpid()))\nos.close(1);os.close(2)\ntime.sleep(20)';
    const pending=failure(executeDownloadProcess('python3',['-c',script],{timeout:300}));
    setPending(pending);const pid=Number(await untilFile(pidFile));
    const error=await pending;
    assert.equal(error.code,'ETIMEDOUT');assert.equal(downloadProcessEnded(error),false);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  });
});

test('abort remains uncertain after supervisor cleanup',async()=>{
  const controller=new AbortController();
  const pending=failure(run('setInterval(()=>{},1000)',{signal:controller.signal,timeout:2000}));
  await delay(60);controller.abort();
  const error=await pending;
  assert.equal(error.code,'ABORT_ERR');assert.equal(downloadProcessEnded(error),false);
  const already=new AbortController();already.abort();
  assert.equal(downloadProcessEnded(await failure(run('',{signal:already.signal}))),false);
});

test('bounded stdout and stderr overflow never produce proof',async()=>{
  for(const stream of ['stdout','stderr']){
    const error=await failure(run('process.'+stream+'.write("x".repeat(65536))',{maxBuffer:1024}));
    assert.equal(error.code,'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.ok(Buffer.byteLength(error[stream])<=1024);
    assert.equal(downloadProcessEnded(error),false);
  }
});

test('helper death loses receipt; error message never contains raw tool arguments',async()=>{
  const marker='PRIVATE_URL_TOKEN_MARKER';
  const error=await failure(run('process.kill(process.ppid,"SIGKILL");process.exit(0)//'+marker));
  assert.equal(error.code,'ERR_DOWNLOAD_SUPERVISOR');
  assert.equal(downloadProcessEnded(error),false);
  assert.equal(error.message.includes(marker),false);
});

test('tool JSON cannot replace a lost supervisor receipt',async()=>{
  const error=await failure(run('console.log(JSON.stringify({processEnded:true,subreaper:true,wait:"ECHILD",nonce:"fake"}));process.kill(process.ppid,"SIGKILL");process.exit(1)'));
  assert.equal(downloadProcessEnded(error),false);
  assert.equal(downloadProcessEnded({stdout:'{"status":"normal","wait":"ECHILD"}',code:0}),false);
});

test('signals and unavailable executables fail closed; shell execution is refused',async()=>{
  const signalled=await failure(run('process.kill(process.pid,"SIGTERM")'));
  assert.equal(downloadProcessEnded(signalled),false);
  const missing=await failure(executeDownloadProcess('/nonexistent/megabrain-test-executable',[]));
  assert.equal(downloadProcessEnded(missing),false);
  await assert.rejects(()=>executeDownloadProcess('sh',['-c','true'],{shell:true}),TypeError);
  await assert.rejects(()=>run('',{timeout:0}),TypeError);
});

test('lost, malformed, wrong invocation and inconsistent receipts fail closed',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'megabrain-receipt-test-'));
  try{
    await writeFile(join(folder,'download-executor.mjs'),
      await readFile(new URL('../lib/download-executor.mjs',import.meta.url)));
    const {executeDownloadProcess:execute,downloadProcessEnded:proved}=await import(
      pathToFileURL(join(folder,'download-executor.mjs')).href);
    const mutations=[
      'receipt = None',
      'receipt = "{"',
      'receipt["nonce"] = "0" * 64',
      'receipt["stdout_bytes"] = 1',
      'receipt["stderr_sha256"] = "0" * 64',
      'receipt["wait"] = "EMPTY_GROUP"',
      'receipt["subreaper"] = False',
      'receipt["extra"] = True',
      'receipt["exit_code"] = True',
    ];
    for(const mutation of mutations){
      const script=[
        'import sys,os,json,hashlib',
        'request=json.loads(sys.stdin.readline())',
        'h=hashlib.sha256(b"").hexdigest()',
        'receipt={"v":1,"nonce":request["nonce"],"status":"normal","exit_code":0,"subreaper":True,"wait":"ECHILD","stdout_bytes":0,"stderr_bytes":0,"stdout_sha256":h,"stderr_sha256":h}',
        mutation,
        'if receipt is not None: os.write(3,(receipt if isinstance(receipt,str) else json.dumps(receipt)).encode())',
      ].join('\n');
      await writeFile(join(folder,'download-supervisor.py'),script);
      const error=await failure(execute(process.execPath,['-e','']));
      assert.equal(proved(error),false,mutation);
      assert.equal(error.code,'ERR_DOWNLOAD_SUPERVISOR',mutation);
    }
    await writeFile(join(folder,'download-supervisor.py'),
      'import sys,json\nsys.stdin.readline()\nprint(json.dumps({"status":"normal","processEnded":True,"subreaper":True,"wait":"ECHILD"}))');
    const forged=await failure(execute(process.execPath,['-e','']));
    assert.equal(proved(forged),false);
    assert.equal(JSON.parse(forged.stdout).processEnded,true);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('private receipt descriptor is closed before executing the tool',async()=>{
  const script='import os\ntry:\n os.fstat(3)\n print("inherited")\nexcept OSError:\n print("closed")';
  const result=await executeDownloadProcess('python3',['-c',script]);
  assert.equal(result.stdout,'closed\n');
  assert.equal(downloadProcessEnded(result),true);
});

test('invalid options reject before spawn and buffer encoding preserves bytes',async()=>{
  for(const options of [{encoding:'invalid-encoding'},{signal:{}},{receiptScope:null},{cwd:3},null]){
    await assert.rejects(()=>run('',options),TypeError);
  }
  const result=await run('process.stdout.write(Buffer.from([0,255]))',{encoding:'buffer'});
  assert.deepEqual(result.stdout,Buffer.from([0,255]));
  assert.equal(downloadProcessEnded(result),true);
});

test('selector initialization failures kill and reap the already-started child',async()=>{
  for(const failurePoint of ['construction','first_registration','second_registration']){
    await fixture(async({folder,pidFile,gate,setPending})=>{
      await writeFile(join(folder,'download-executor.mjs'),
        await readFile(new URL('../lib/download-executor.mjs',import.meta.url)));
      const {executeDownloadProcess:execute,downloadProcessEnded:proved}=await import(
        pathToFileURL(join(folder,'download-executor.mjs')).href);
      const reportFile=join(folder,'report');
      const original=new URL('../lib/download-supervisor.py',import.meta.url).pathname;
      const injected=[
        'import importlib.util,os,time,errno,json,sys',
        'sys.dont_write_bytecode=True',
        'spec=importlib.util.spec_from_file_location("tested_supervisor",'+JSON.stringify(original)+')',
        'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
        'def fail():',
        ' deadline=time.monotonic()+2',
        ' while not os.path.exists('+JSON.stringify(pidFile)+') and time.monotonic()<deadline: time.sleep(.01)',
        ' if not os.path.exists('+JSON.stringify(pidFile)+'): raise RuntimeError("fixture never started")',
        ' raise OSError(errno.EMFILE,"injected selector initialization failure")',
        'RealSelector=module.selectors.DefaultSelector',
        'class FailingSelector(RealSelector):',
        ' def register(self,*args,**kwargs):',
        '  self.calls=getattr(self,"calls",0)+1',
        '  if self.calls=='+(failurePoint==='first_registration'?1:2)+': fail()',
        '  return super().register(*args,**kwargs)',
        'module.selectors.DefaultSelector='+(failurePoint==='construction'?'fail':'FailingSelector'),
        'try:',
        ' result=module.main()',
        'except OSError:',
        ' result=2',
        'no_children=False',
        'try: os.waitpid(-1,os.WNOHANG)',
        'except ChildProcessError: no_children=True',
        'open('+JSON.stringify(reportFile)+',"w").write(json.dumps({"no_children":no_children}))',
        'sys.exit(result)',
      ].join('\n');
      await writeFile(join(folder,'download-supervisor.py'),injected);
      const forks=failurePoint==='second_registration'?'if os.fork(): os._exit(1)\nos.setsid()\nif os.fork(): os._exit(0)\n':'';
      // Existence must mean the complete PID is visible to both readiness readers.
      const childScript=[
        'import os,time',
        forks,
        'with open('+JSON.stringify(pidFile+'.tmp')+',"w") as stream:',
        ' stream.write(str(os.getpid()))',
        'os.replace('+JSON.stringify(pidFile+'.tmp')+','+JSON.stringify(pidFile)+')',
        'while not os.path.exists('+JSON.stringify(gate)+'): time.sleep(.01)',
      ].join('\n');
      const pending=failure(execute('python3',['-c',childScript],{timeout:3000}));
      setPending(pending);
      const pid=Number(await untilFile(pidFile));
      assert.ok(Number.isSafeInteger(pid)&&pid>1,failurePoint+' requires a complete child PID');
      const error=await pending;
      assert.equal(error.code,'ERR_DOWNLOAD_SUPERVISOR',failurePoint);
      assert.equal(proved(error),false,failurePoint);
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},failurePoint);
      assert.deepEqual(JSON.parse(await readFile(reportFile,'utf8')),{no_children:true},failurePoint);
    });
  }
});
