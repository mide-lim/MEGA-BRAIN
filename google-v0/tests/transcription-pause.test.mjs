import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {WorkerQueue,workerHandler,validateTask} from '../lib/worker-queue.mjs';
import {stageBoundFlow} from '../lib/stage-contract.mjs';
import {WorkerRecovery} from '../lib/worker-recovery.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';

const videoId='Reel_1',project='megabrain-v0-1017370021431';
const operationName='projects/'+project+'/locations/global/operations/offline_123';
const routes={
  upload:{queue:'v0-acquisition',workerOrigin:'https://v0-acquisition-test.run.app'},
  transcription:{queue:'v0-transcription',workerOrigin:'https://v0-transcription-test.run.app'},
  analysis:{queue:'v0-analysis',workerOrigin:'https://v0-analysis-test.run.app'}
};
const transcriptionTask={videoId,stage:'transcription',poll:0};
const result=(changes={transcript:'Transcrição persistida'})=>({video_id:videoId,stage:'transcription',actual_cents:5,changes});
const request=task=>new Request(routes.transcription.workerOrigin+'/tasks/run',{method:'POST',body:JSON.stringify(task)});
async function delivery(f,task=transcriptionTask){
  const response=await f.handler(request(task));return {code:response.status,body:await response.json()};
}
function fixture(operations={}){
  let version=0;const now=Date.now(),docs=new Map(),events=[],sent=[];
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true});
  seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,
    ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),
    remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),
    credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
  seed('videos/'+videoId,{media_verified:true,audio_status:'present'});
  const store={
    async get(path){events.push(['get',path]);return structuredClone(docs.get(path)??null);},
    async create(path,data){events.push(['create',path]);if(docs.has(path))return {created:false};seed(path,data);return {created:true};},
    async patch(path,changes,{updateTime}){
      events.push(['patch',path,structuredClone(changes)]);
      if(docs.get(path)?.updateTime!==updateTime)throw Error('CAS conflict');
      seed(path,{...docs.get(path).data,...changes});return this.get(path);
    }
  };
  const api={project,async request(url,options){
    events.push(['dispatch',url]);sent.push(structuredClone(options.json.task));
  }};
  const ledger=new FinancialLedger(store,{clock:()=>now});
  const flow=new WorkerFlow({store,ledger,operations,quotes:{upload:10,transcription:10,analysis:10},clock:()=>now});
  const bound=stageBoundFlow(flow,'transcription');
  const queue=new WorkerQueue({api,store,stageRoutes:routes,workerOrigin:routes.transcription.workerOrigin,enabled:true,clock:()=>now});
  const handler=workerHandler({flow:bound,queue,stage:'transcription',authorize:async()=>true});
  return {store,docs,events,sent,flow,bound,queue,handler,seed};
}
const payload=task=>JSON.parse(Buffer.from(task.httpRequest.body,'base64').toString());
const jobPath='jobs/'+executionId(videoId,'transcription');

async function change(f,path,values){const row=await f.store.get(path);return f.store.patch(path,values,{updateTime:row.updateTime});}
const finance=f=>f.store.get('settings/financial').then(row=>row.data);
test('soft pause blocks new STT, preserves known operation and collects pending/completed once',async()=>{
 let submits=0,polls=0;
 const f=fixture({
  transcription:async()=>{submits++;return {video_id:videoId,stage:'transcription',operation_name:operationName};},
  pollTranscription:async args=>{
   polls++;assert.equal(args.operationName,operationName);
   await workerReservationGate(f.store)({executionId:args.executionId,stage:'transcription',videoId});
   return polls===1?{video_id:videoId,stage:'transcription',pending:true}:result();
  }
 });
 await change(f,'settings/automation',{transcription_enabled:false});
 const untouched=await finance(f);
 assert.equal((await delivery(f)).body.status,'paused');
 assert.deepEqual(await finance(f),untouched);assert.equal((await f.store.get(jobPath)),null);
 await change(f,'settings/automation',{transcription_enabled:true});
 assert.equal((await delivery(f)).body.status,'waiting');
 const reserved=await finance(f);
 await change(f,'settings/automation',{transcription_enabled:false});
 assert.equal((await delivery(f)).body.status,'paused');
 assert.equal((await delivery(f,{videoId,stage:'transcription',poll:1})).body.status,'waiting');
 assert.deepEqual(await finance(f),reserved);
 assert.equal((await f.store.get(jobPath)).data.operation_name,operationName);
 assert.equal((await delivery(f,{videoId,stage:'transcription',poll:2})).body.status,'completed');
 const settled=await finance(f);
 assert.equal(settled.spent_cents,5);assert.equal(settled.reserved_cents,0);
 assert.equal(Object.keys(settled.jobs).length,1);
 await delivery(f,{videoId,stage:'transcription',poll:2});
 await change(f,'settings/automation',{transcription_enabled:true});
 assert.equal((await delivery(f)).body.status,'completed');
 assert.deepEqual(await finance(f),settled);assert.equal(submits,1);assert.equal(polls,2);
});
for(const hardStop of ['global','finance','stage-finance','stale-credit','wrong-reservation','wrong-claim','quote']){
 test('collection '+hardStop+' preserves waiting claim and reservation without provider call',async()=>{
  let polls=0;const f=fixture({
   transcription:async()=>({video_id:videoId,stage:'transcription',operation_name:operationName}),
   pollTranscription:async()=>{polls++;return result();}
  });
  await delivery(f);await change(f,'settings/automation',{transcription_enabled:false});
  if(hardStop==='global')await change(f,'settings/automation',{enabled:false});
  if(hardStop==='finance')await change(f,'settings/financial',{paused:true});
  if(hardStop==='stage-finance')await change(f,'settings/financial',{enabled_stages:{upload:true,transcription:false,analysis:true}});
  if(hardStop==='stale-credit')await change(f,'settings/financial',{balance_observed_at:'2000-01-01T00:00:00Z'});
  if(hardStop==='wrong-reservation'){const row=await finance(f);row.jobs[executionId(videoId,'transcription')].video_id='Other_1';await change(f,'settings/financial',{jobs:row.jobs});}
  if(hardStop==='wrong-claim')await change(f,jobPath,{video_id:'Other_1'});
  if(hardStop==='quote')f.flow.quotes.transcription=11;
  const beforeClaim=await f.store.get(jobPath),beforeFinance=await finance(f);
  const response=await delivery(f,{videoId,stage:'transcription',poll:1});
  assert.equal(response.body.status,hardStop==='global'?'paused':'blocked');
  assert.deepEqual(await f.store.get(jobPath),beforeClaim);assert.deepEqual(await finance(f),beforeFinance);assert.equal(polls,0);
  if(hardStop==='global'){await change(f,'settings/automation',{enabled:true});assert.equal((await delivery(f,{videoId,stage:'transcription',poll:1})).body.status,'completed');assert.equal(polls,1);}
 });
}
test('fixed disabled service, unauthenticated requests and foreign stages cannot collect a known operation',async()=>{
 let calls=0;const f=fixture({transcription:async()=>({video_id:videoId,stage:'transcription',operation_name:operationName}),pollTranscription:async()=>{calls++;return result();}});
 await delivery(f);const previous=await finance(f),claim=await f.store.get(jobPath);
 const closed=stageBoundFlow(f.flow,'transcription',{enabled:false});
 assert.equal((await closed.poll({videoId})).reason,'stage_disabled');
 const unauthorized=workerHandler({flow:f.bound,queue:f.queue,stage:'transcription',authorize:async()=>false});
 assert.equal((await unauthorized(request({videoId,stage:'transcription',poll:1}))).status,401);
 assert.equal((await delivery(f,{videoId,stage:'analysis',poll:0})).code,409);
 assert.equal(calls,0);assert.deepEqual(await finance(f),previous);assert.deepEqual(await f.store.get(jobPath),claim);
});
const audioRef=()=>({audio_key:'results/instagram/'+videoId+'/'+executionId(videoId,'transcription')+'/audio.flac',audio_generation:'21',audio_bytes:9,audio_sha256:'a'.repeat(64),audio_source_key:'originals/instagram/'+videoId+'/video.mp4',audio_source_generation:'11'});
test('prepared legacy audio is persisted before paid STT submission and known operation survives pause',async()=>{
 let calls=0;
 const f=fixture({transcription:async({recordPreparedAudio})=>{
  await recordPreparedAudio(audioRef());calls++;
  assert.equal((await f.store.get('videos/'+videoId)).data.audio_generation,'21');
  return {video_id:videoId,stage:'transcription',operation_name:operationName};
 }});
 await change(f,'videos/'+videoId,{video_key:'originals/instagram/'+videoId+'/video.mp4',video_generation:'11'});
 assert.equal((await delivery(f)).body.status,'waiting');assert.equal(calls,1);
 await change(f,'settings/automation',{transcription_enabled:false});await delivery(f);assert.equal(calls,1);
});
for(const invalid of ['partial','lineage','overwrite','persist']){
 test('invalid audio callback '+invalid+' cannot reach paid submission',async()=>{
  let calls=0;
  const f=fixture({transcription:async({recordPreparedAudio})=>{
   const refs=audioRef();if(invalid==='partial')delete refs.audio_sha256;
   if(invalid==='lineage')refs.audio_source_generation='999';
   await recordPreparedAudio(refs);calls++;return result();
  }});
  await change(f,'videos/'+videoId,{video_key:'originals/instagram/'+videoId+'/video.mp4',video_generation:'11',...(invalid==='overwrite'?{...audioRef(),audio_generation:'22'}:{})});
  if(invalid==='persist'){const patch=f.store.patch.bind(f.store);f.store.patch=async(path,changes,opts)=>{if(changes.audio_key)throw Error('write failed');return patch(path,changes,opts);};}
  assert.equal((await delivery(f)).body.status,'uncertain');assert.equal(calls,0);
  assert.equal((await finance(f)).reserved_cents,10);
 });
}

async function completedUpload(f){
 const id=executionId(videoId,'upload'),state=await finance(f);
 f.seed('jobs/'+id,{video_id:videoId,stage:'upload',status:'completed'});
 await change(f,'settings/financial',{spent_cents:3,jobs:{...state.jobs,[id]:{video_id:videoId,stage:'upload',maximum_cents:10,actual_cents:3,status:'completed'}}});
}
test('paused delivery remains tracked and explicit resume dispatches without erasing outbox or replaying paid work',async()=>{
 let submits=0;const f=fixture({transcription:async()=>{submits++;return result();}});
 await completedUpload(f);await f.queue.enqueue(transcriptionTask);
 const originalDispatch=f.queue.dispatchPath(transcriptionTask),outbox=await f.store.get(originalDispatch);
 await change(f,'settings/automation',{transcription_enabled:false});
 assert.equal((await delivery(f)).body.status,'paused');assert.equal(submits,0);
 const recovery=new WorkerRecovery({store:f.store,queue:f.queue});
 assert.equal((await recovery.resume({videoId,recoveryId:'admin_resume_pause1'})).status,'paused');
 await change(f,'settings/automation',{transcription_enabled:true});
 assert.equal((await recovery.resume({videoId,recoveryId:'admin_resume_pause1'})).status,'queued');
 const resumed=payload(f.sent.at(-1));assert.equal(resumed.recoveryId,'admin_resume_pause1');
 assert.equal((await delivery(f,resumed)).body.status,'completed');
 const settled=await finance(f);await delivery(f,resumed);
 assert.equal(submits,1);assert.deepEqual(await finance(f),settled);
 assert.deepEqual(await f.store.get(originalDispatch),outbox);
});
test('explicit recovery can resume known-operation collection while new submissions remain soft-paused',async()=>{
 let submits=0,polls=0;const f=fixture({
  transcription:async()=>{submits++;return {video_id:videoId,stage:'transcription',operation_name:operationName};},
  pollTranscription:async()=>{polls++;return result();}
 });
 await completedUpload(f);await delivery(f);
 await change(f,'settings/automation',{transcription_enabled:false});
 const recovery=new WorkerRecovery({store:f.store,queue:f.queue}),reserved=await finance(f);
 assert.equal((await recovery.inspect(videoId)).status,'operation_pending');
 assert.equal((await recovery.resume({videoId,recoveryId:'admin_resume_poll_1'})).status,'queued');
 assert.deepEqual(await finance(f),reserved);
 const poll=payload(f.sent.at(-1));assert.equal(poll.poll,1);
 assert.equal((await delivery(f,poll)).body.status,'completed');
 assert.equal(submits,1);assert.equal(polls,1);
});
