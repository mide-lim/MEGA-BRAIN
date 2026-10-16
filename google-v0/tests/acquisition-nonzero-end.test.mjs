import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mediaTools} from '../lib/media-tools.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';

// Numeric exit is not a process-tree receipt: a child can close inherited pipes
// and outlive its parent. This test does not change production end semantics.
test('normal execFile exit 1 with closed streams and a live descendant retains acquisition',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'megabrain-nonzero-end-'));
 const pidfile=join(folder,'descendant.pid'),ready=join(folder,'ready');
 let childPid,toolFailure,downloads=0,version=0;
 const exec=promisify(execFile),docs=new Map(),reservations=new Map();
 const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
 seed('settings/automation',{enabled:true});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 for(const id of ['Reel_first','Reel_second'])seed(`videos/${id}`,{status:'pending',source_url:'https://www.instagram.com/reel/DGXmHhAIOXN/'});
 const ledger={async reserve(input){reservations.set(input.executionId,{...input,status:'reserved'});},async transition(id,status){reservations.get(id).status=status;}};
 const proofs=new ExecutionStops({store}),acquisition=new AcquisitionControl({store,verifyExecutionStopped:input=>proofs.verify(input),maximumParallelism:1});
 try{
  const child=`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},3000);`;
  const parent=`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidfile)},String(child.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(1);}},5);`;
  const tools=mediaTools({downloadEnabled:true,run:async(_tool,args,options)=>{
   if(args.includes('--version'))return {stdout:'2026.10.01\n'};
   if(args.includes('-version'))return {stdout:'ffmpeg version 8.0\n'};
   downloads++;
   try{return await exec(process.execPath,['-e',parent],{...options,timeout:1500});}
   catch(error){toolFailure=error;throw error;}
  }});
  // All adapters are real except in-memory persistence/finance and synthetic
  // downloader executable. No network, Google request, or storage write occurs.
  const operations=googleOperations({api:{project:'megabrain-v0-1017370021431',request(){assert.fail('Provider request forbidden');}},storage:{bucket:'megabrain-v0-1017370021431-media',async metadata(){return null;},writeImmutable(){assert.fail('Storage write forbidden');}},tools:{download:()=>tools.download({id:'DGXmHhAIOXN',source_url:'https://www.instagram.com/reel/DGXmHhAIOXN/'},{withMetadata:true})},preset:{},config:{enabled:true,uploads_enabled:true,quotes:{upload:100}},gate:async()=>({maximum_cents:100}),inspect(){assert.fail('Media inspection forbidden after failed download');}});
  const flow=new WorkerFlow({store,ledger,operations,quotes:{upload:100},acquisition,recordExecutionStopped:input=>proofs.record(input)});
  const first=await flow.run({videoId:'Reel_first',stage:'upload'});
  childPid=Number(await readFile(pidfile,'utf8'));
  assert.equal(toolFailure.code,1);assert.equal(toolFailure.killed,false);assert.equal(toolFailure.signal,null);
  assert.equal(toolFailure.stdout,'');assert.equal(toolFailure.stderr,'');
  assert.doesNotThrow(()=>process.kill(childPid,0));
  assert.equal(first.status,'uncertain');assert.equal(downloads,1);
  const claim=await store.get(`jobs/${executionId('Reel_first','upload')}`);
  assert.equal(claim.data.acquisition_end_status,'unconfirmed');
  assert.equal(claim.data.acquisition_metrics.extractions,1);
  assert.equal(reservations.get(first.execution_id).status,'uncertain');
  assert.equal(reservations.get(first.execution_id).maximumCents,100);
  assert.equal([...docs.keys()].filter(key=>key.startsWith('execution_stops/')).length,0);
  const active=Object.values((await store.get('settings/acquisition')).data.active);assert.equal(active.length,1);
  assert.equal(await acquisition.release({executionId:first.execution_id,videoId:'Reel_first',attemptId:active[0].attempt_id}),false);
  assert.equal((await flow.run({videoId:'Reel_second',stage:'upload'})).reason,'acquisition_capacity');
  assert.equal(downloads,1);assert.equal(reservations.size,1);
 }finally{
  if(!childPid)try{childPid=Number(await readFile(pidfile,'utf8'));}catch{}
  if(Number.isSafeInteger(childPid)&&childPid>1)try{process.kill(childPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  await rm(folder,{recursive:true,force:true});
 }
});
