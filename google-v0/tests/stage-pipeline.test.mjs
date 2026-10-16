import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';
import {WorkerQueue,workerHandler} from '../lib/worker-queue.mjs';
import {stageBoundFlow,workerStages} from '../lib/stage-contract.mjs';

function fixture(failure=null){
 const project='megabrain-v0-1017370021431',videoId='Reel_pipeline',now=Date.now(),docs=new Map(),sent=[],calls={upload:0,transcription:0,polls:0,analysis:0};let version=0;
 const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true,parallelism:1});
 seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 seed(`videos/${videoId}`,{id:videoId,status:'pending'});
 const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
 const stageRoutes=Object.fromEntries(workerStages.map(stage=>[stage,{queue:stage==='upload'?'v0-acquisition':`v0-${stage}`,workerOrigin:`https://${stage}-pipeline.run.app`}]));
 const api={project,async request(url,options){
  const task=options.json.task,payload=JSON.parse(Buffer.from(task.httpRequest.body,'base64'));
  assert.equal(task.httpRequest.oidcToken.audience,stageRoutes[payload.stage].workerOrigin);
  assert.ok(url.includes(`/queues/${stageRoutes[payload.stage].queue}/tasks`));
  const previous=payload.stage==='transcription'&&payload.poll===0?'upload':payload.stage==='analysis'?'transcription':null;
  if(previous){
   assert.equal((await store.get(`jobs/${executionId(videoId,previous)}`)).data.status,'completed');
   assert.equal((await store.get('settings/financial')).data.reserved_cents,0);
   assert.ok((await store.get(`videos/${videoId}`)).data[previous==='upload'?'video_key':'transcript_key']);
  }
  sent.push({payload,task});return {};
 }};
 const stops=new ExecutionStops({store,clock:()=>now});
 const acquisition=new AcquisitionControl({store,maximumParallelism:1,verifyExecutionStopped:input=>stops.verify(input),clock:()=>now});
 const operations={
  async upload({recordAcquisitionExtraction}){calls.upload++;const ended=recordAcquisitionExtraction();ended();if(failure==='upload')throw Error('Download failed');return {video_id:videoId,stage:'upload',actual_cents:3,changes:{video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'1',video_bytes:10,media_verified:true,audio_status:'present'}};},
  async transcription(){calls.transcription++;if(failure==='transcription')throw Error('STT uncertain');return {video_id:videoId,stage:'transcription',operation_name:`projects/${project}/locations/us/operations/stage_pipeline`};},
  async pollTranscription(){calls.polls++;return calls.polls===1?{video_id:videoId,stage:'transcription',pending:true}:{video_id:videoId,stage:'transcription',actual_cents:4,changes:{transcript:'Original speech',transcript_key:`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`,transcript_generation:'2'}};},
  async analysis(){calls.analysis++;if(failure==='analysis')throw Error('Analysis uncertain');return {video_id:videoId,stage:'analysis',actual_cents:5,changes:{analysis:{title:'Categorized result'},analysis_key:`results/instagram/${videoId}/${executionId(videoId,'analysis')}/analysis.json`,analysis_generation:'3'}};}
 };
 const handlers={};
 for(const stage of workerStages){
  const owned=stage==='transcription'?{transcription:operations.transcription,pollTranscription:operations.pollTranscription}:{[stage]:operations[stage]};
  const flow=new WorkerFlow({store,ledger:new FinancialLedger(store,{clock:()=>now}),operations:owned,quotes:{upload:10,transcription:10,analysis:10},clock:()=>now,acquisition,recordExecutionStopped:input=>stops.record(input),verifyExecutionStopped:input=>stops.verify(input)});
  const queue=new WorkerQueue({api,store,workerOrigin:stageRoutes[stage].workerOrigin,stageRoutes,enabled:true,clock:()=>now});
  handlers[stage]=workerHandler({stage,flow:stageBoundFlow(flow,stage),queue,authorize:async()=>true});
 }
 const deliver=async task=>(await handlers[task.stage](new Request('https://worker.invalid/tasks/run',{method:'POST',body:JSON.stringify(task)}))).json();
 return {videoId,store,sent,calls,deliver};
}

test('three isolated queues process persisted media -> one STT operation -> polls -> published analysis exactly once',async()=>{
 const f=fixture(),first={videoId:f.videoId,stage:'upload',poll:0};
 assert.equal((await f.deliver(first)).status,'completed');
 for(let index=0;index<4;index++)await f.deliver(f.sent[index].payload);
 assert.deepEqual(f.calls,{upload:1,transcription:1,polls:2,analysis:1});
 assert.deepEqual(f.sent.map(x=>[x.payload.stage,x.payload.poll]),[['transcription',0],['transcription',1],['transcription',2],['analysis',0]]);
 assert.equal((await f.store.get(`videos/${f.videoId}`)).data.status,'analyzed');
 assert.equal((await f.store.get('settings/financial')).data.spent_cents,12);
 assert.equal((await f.store.get('settings/financial')).data.reserved_cents,0);
 assert.deepEqual((await f.store.get('settings/acquisition')).data.active,{});
 await f.deliver(first);for(const message of [...f.sent])await f.deliver(message.payload);
 assert.deepEqual(f.calls,{upload:1,transcription:1,polls:2,analysis:1});assert.equal(f.sent.length,4);
 assert.equal((await f.store.get('settings/financial')).data.spent_cents,12);
});
test('uncertain stage retains money and stops its successor without repeating paid work',async()=>{
 const f=fixture('transcription');await f.deliver({videoId:f.videoId,stage:'upload',poll:0});
 assert.equal((await f.deliver(f.sent[0].payload)).status,'uncertain');
 await f.deliver(f.sent[0].payload);
 assert.deepEqual(f.calls,{upload:1,transcription:1,polls:0,analysis:0});assert.equal(f.sent.length,1);
 const financial=(await f.store.get('settings/financial')).data;
 assert.equal(financial.reserved_cents,10);assert.equal(financial.spent_cents,3);assert.equal(financial.paused,true);
});
