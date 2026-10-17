import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const example=JSON.parse(await readFile(new URL('../config/stage-workers.example.json',import.meta.url),'utf8'));
const entrypoint=fileURLToPath(new URL('./serve-stage-worker.mjs',import.meta.url));
const folder=await mkdtemp(join(tmpdir(),'v0-stage-smoke-'));
async function availablePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}
async function checkStage(stage,{v2=false,closedEnv=false}={}){
  const port=await availablePort(),configPath=join(folder,stage+(v2?'-v2':'')+(closedEnv?'-env':'')+'.json');
  const config={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',
    ...(v2?{reels_runtime_version:'v2',reels_processing_enabled:closedEnv}:{}),worker_stage:stage,worker_origin:example.stage_routes[stage].workerOrigin,stage_routes:example.stage_routes,
    enabled:false,dispatch_enabled:false,admission_enabled:false,downloads_enabled:false,
    assisted_upload_enabled:false,assisted_single_upload_enabled:false,pilot_video_ids:[],quotes:{}};
  await writeFile(configPath,JSON.stringify(config));
  // The real entrypoint receives no inherited credentials. Its preload denies
  // outbound sockets and fetches; only the parent makes loopback HTTP requests.
  const child=spawn(process.execPath,['--import',pathToFileURL(join(folder,'deny-outbound.mjs')).href,entrypoint,stage],{
    env:{...(closedEnv?{MEGABRAIN_REELS_CLOSED_RELEASE:'v2'}:{}),NODE_ENV:'test',PORT:String(port),MEGABRAIN_V0_WORKER_CONFIG:configPath},stdio:['ignore','pipe','pipe']
  });
  let output='',spawnError=null;
  const capture=chunk=>{output=(output+chunk).slice(-8192);};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{spawnError=error;resolve();});});
  const url='http://127.0.0.1:'+port;
  try{
    let response=null;const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(spawnError)throw spawnError;
      assert.equal(child.exitCode,null,'Stage entrypoint exited early: '+output);
      try{response=await fetch(url+'/tasks/run',{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});break;}catch{await delay(50);}
    }
    assert.ok(response,'Stage entrypoint did not become ready: '+output);
    assert.equal(response.status,v2?423:401,stage+' accepts no anonymous run');
    await response.text();
    if(v2){
      const control=await fetch(url+'/tasks/control',{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});assert.equal(control.status,423);await control.text();
      assert.doesNotMatch(output,/Unexpected outbound I\/O/);return;
    }
    for(const path of ['/tasks/diagnose','/tasks/assisted-upload','/not-a-task']){
      const result=await fetch(url+path,{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
      assert.equal(result.status,404,stage+' exposes unexpected route '+path);await result.text();
    }
    const admission=await fetch(url+'/tasks/admit',{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
    assert.equal(admission.status,stage==='upload'?401:404);await admission.text();
    assert.doesNotMatch(output,/Unexpected outbound I\/O/);
  }finally{
    // Terminate only this synthetic child; never search for or kill other PIDs.
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    let timer;
    try{
      await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);
    }finally{clearTimeout(timer);}
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  }
}
try{
  await writeFile(join(folder,'deny-outbound.mjs'),`import net from 'node:net';
const denied=()=>{console.error('Unexpected outbound I/O');throw Error('Outbound I/O forbidden in offline smoke');};
net.Socket.prototype.connect=denied;
globalThis.fetch=denied;
`);
  for(const stage of ['upload','transcription','analysis']){await checkStage(stage);await checkStage(stage,{v2:true});await checkStage(stage,{v2:true,closedEnv:true});}
}finally{await rm(folder,{recursive:true,force:true});}
console.log('Stage worker smoke passed: three real entrypoints in legacy and v2 modes, closed synthetic configs, anonymous rejection, isolated routes and no outbound I/O.');
