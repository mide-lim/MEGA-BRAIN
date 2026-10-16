import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeDownloadProcess,downloadProcessEnded} from '../lib/download-executor.mjs';
import {mediaTools} from '../lib/media-tools.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';

const video={id:'Synthetic_Reel',source_url:'https://www.instagram.com/reel/Synthetic_Reel/'};
const js=(script,options)=>executeDownloadProcess(process.execPath,['-e',script],options);
function fixture(run){
 const docs=new Map(),reservations=new Map();let version=0;
 const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
 seed('settings/automation',{enabled:true});seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 seed(`videos/${video.id}`,{...video,status:'pending'});
 // Historical uncertainty is immutable reference state, never reconciled here.
 seed('jobs/legacy_attempt',{status:'uncertain',execution_attempt_id:'legacy'});
 reservations.set('legacy_attempt',{status:'uncertain',maximumCents:1850});
 const ledger={async reserve(input){reservations.set(input.executionId,{...input,status:'reserved'});},async transition(id,status){reservations.get(id).status=status;}};
 const proofs=new ExecutionStops({store}),acquisition=new AcquisitionControl({store,verifyExecutionStopped:input=>proofs.verify(input),maximumParallelism:1});
 const tools=mediaTools({downloadEnabled:true,run});
 const operations=googleOperations({api:{project:'megabrain-v0-1017370021431',request(){assert.fail('Provider requests forbidden');}},storage:{bucket:'megabrain-v0-1017370021431-media',async metadata(){return null;},writeImmutable(){assert.fail('Storage writes forbidden after failed download');}},tools,preset:{},config:{enabled:true,uploads_enabled:true,quotes:{upload:100}},gate:async()=>({maximum_cents:100}),inspect(){assert.fail('Inspection forbidden after failed download');}});
 const flow=new WorkerFlow({store,ledger,operations,quotes:{upload:100},acquisition,recordExecutionStopped:input=>proofs.record(input)});
 return {docs,reservations,store,flow,active:async()=>Object.values((await store.get('settings/acquisition')).data.active),stops:()=>[...docs.keys()].filter(key=>key.startsWith('execution_stops/'))};
}
async function assertFailureState(f,proof){
 const first=await f.flow.run({videoId:video.id,stage:'upload'});
 assert.equal(first.status,'uncertain');
 assert.deepEqual(f.reservations.get(first.execution_id),{executionId:first.execution_id,videoId:video.id,stage:'upload',maximumCents:100,status:'uncertain'});
 assert.equal((await f.active()).length,proof?0:1);assert.equal(f.stops().length,proof?1:0);
 const claim=(await f.store.get(`jobs/${executionId(video.id,'upload')}`)).data;
 assert.equal(claim.acquisition_metrics?.extractions??(await f.store.get(f.stops()[0]))?.data.acquisition.extractions,1);
 assert.equal(claim.acquisition_end_status,proof?undefined:'unconfirmed');
 assert.deepEqual(f.reservations.get('legacy_attempt'),{status:'uncertain',maximumCents:1850});
 assert.deepEqual((await f.store.get('jobs/legacy_attempt')).data,{status:'uncertain',execution_attempt_id:'legacy'});
 assert.equal((await f.flow.run({videoId:video.id,stage:'upload'})).duplicate,true);
 return first;
}
function supervisedFailure({untrackedVersion=false}={}){
 let extractions=0,versions=0;
 return {stats:()=>({extractions,versions}),async run(tool,args,options){
  if(args.length===1){versions++;if(untrackedVersion&&tool==='ffmpeg')return {stdout:'ffmpeg version 8.0\n',ended:true};return js(`process.stdout.write(${JSON.stringify(tool==='yt-dlp'?'2026.10.01\n':'ffmpeg version 8.0\n')})`,options);}
  extractions++;
  for(const flag of ['--retries','--fragment-retries','--extractor-retries'])assert.equal(args[args.indexOf(flag)+1],'0');
  assert.ok(args.includes('--write-info-json'));
  return js(`process.stdout.write('[Instagram] metadata SECRET https://private.invalid/\\n');process.stderr.write('Unable to extract shared data Cookie: SECRET');process.exitCode=1`,options);
 }};
}
test('normal supervised exit 1 ends future invocation slot while reservation and old uncertainty remain',async()=>{
 const command=supervisedFailure(),f=fixture(command.run);await assertFailureState(f,true);
 assert.deepEqual(command.stats(),{extractions:1,versions:2});
 const claim=(await f.store.get(`jobs/${executionId(video.id,'upload')}`)).data;
 assert.equal(claim.failure_diagnostic.download.detail_code,'metadata_extraction_failed');
 assert.doesNotMatch(JSON.stringify(claim),/SECRET|Cookie|https:|private/);
});
test('normal extraction plus an untracked version command retains slot and no stop proof',async()=>{
 const command=supervisedFailure({untrackedVersion:true}),f=fixture(command.run);await assertFailureState(f,false);
 assert.deepEqual(command.stats(),{extractions:1,versions:2});
});
test('plain rejected helper cannot forge proof from numeric exit or receipt JSON',async()=>{
 const f=fixture(async(_tool,args)=>{if(args.length===1)return {stdout:'2026.10.01'};throw Object.assign(Error('synthetic'),{code:1,killed:false,signal:null,ended:true,receipt:{ended:true},stdout:'{"ended":true}',stderr:''});});
 await assertFailureState(f,false);
});
test('surviving detached descendant retains slot even after parent exit and cleanup',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'megabrain-flow-descendant-')),ready=join(folder,'ready'),pidfile=join(folder,'pid');let childPid;
 try{
  const child=`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const parent=`const fs=require('node:fs'),child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidfile)},String(child.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(1);}},5);`;
  const f=fixture(async(tool,args,options)=>{
   if(args.length===1)return js(`process.stdout.write(${JSON.stringify(tool==='yt-dlp'?'2026.10.01':'ffmpeg version 8.0')})`,options);
   return js(parent,{...options,timeout:2000});
  });
  const running=assertFailureState(f,false);
  let childReady=false;
  for(let i=0;i<200;i++){try{await access(ready);childReady=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}
  assert.equal(childReady,true);childPid=Number(await readFile(pidfile,'utf8'));
  assert.doesNotThrow(()=>process.kill(childPid,0));assert.equal((await f.active()).length,1);assert.equal(f.stops().length,0);
  await running;
 }finally{
  if(!childPid)try{childPid=Number(await readFile(pidfile,'utf8'));}catch{}
  if(Number.isSafeInteger(childPid)&&childPid>1)try{process.kill(childPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  await rm(folder,{recursive:true,force:true});
 }
});

test('successful supervised media and caption preserve bytes; closure runs after cleanup',async()=>{
 let path,calls=0,stops=0;
 const tools=mediaTools({downloadEnabled:true,run:async(_tool,args,options)=>{
  calls++;path=args[args.indexOf('-o')+1];
  const metadata=JSON.stringify({display_id:video.id,description:'Legenda sintética',signed_url:'SECRET'});
  return js(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path)},'media');fs.writeFileSync(${JSON.stringify(path.replace(/\.mp4$/,'.info.json'))},${JSON.stringify(metadata)});`,options);
 }});
 const result=await tools.download(video,{withMetadata:true,onExecutionStopped:async()=>{await assert.rejects(access(path));stops++;}});
 assert.equal(stops,1);assert.equal(calls,1);assert.equal(result.bytes.toString(),'media');assert.equal(result.source_caption.text,'Legenda sintética');assert.doesNotMatch(JSON.stringify(result.source_caption),/SECRET/);
});
test('normal version query errors may prove stop; callback waits for both queries and cleanup',async()=>{
 let path,versions=0,stops=0;
 const tools=mediaTools({downloadEnabled:true,run:async(_tool,args,options)=>{
  assert.equal(stops,0);
  if(args.length===1){versions++;await assert.rejects(access(path));return js('process.exit(1)',options);}
  path=args[args.indexOf('-o')+1];return js('process.exit(1)',options);
 }});
 await assert.rejects(tools.download(video,{onExecutionStopped:()=>{assert.equal(versions,2);stops++;}}));assert.equal(stops,1);
});
test('receipt from another invocation and cloned trusted result cannot end a later scope',async()=>{
 let trusted,stops=0,calls=0;
 const tools=mediaTools({downloadEnabled:true,run:async(_tool,args,options)=>{
  const path=args[args.indexOf('-o')+1];await writeFile(path,'media');calls++;
  if(calls===1){trusted=await js('',options);assert.equal(downloadProcessEnded(trusted,options.receiptScope),true);return trusted;}
  return calls===2?trusted:{...trusted,ended:true};
 }});
 for(let i=0;i<3;i++)assert.equal((await tools.download(video,{onExecutionStopped:()=>stops++})).toString(),'media');
 assert.equal(stops,1);
});
