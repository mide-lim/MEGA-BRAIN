import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {pipelineFlow} from '../lib/assisted-pipeline.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {WorkerQueue,workerHandler} from '../lib/worker-queue.mjs';
import {stageBoundFlow} from '../lib/stage-contract.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';

const stages=['upload','transcription','analysis'],revision='megabrain-video-text-v4';
const quotes={upload:20,transcription:120,analysis:240},project='megabrain-v0-1017370021431';
const ids=n=>Array.from({length:n},(_,i)=>'Batch_reel_'+String(i).padStart(2,'0'));
const routes=Object.fromEntries(stages.map(s=>[s,{queue:s==='upload'?'v0-acquisition':'v0-'+s,workerOrigin:'https://'+s+'-batch.run.app'}]));
function fixture({size=50,ttl=size>1?172800000:3600000,asyncSTT=false,missingEnd=false,reviewRequired=false}={}){
 const videoIds=ids(size),docs=new Map(),sent=[],pending=[],scopes=[],faults=new Map(),calls={upload:0,transcription:0,analysis:0,poll:0};let now=Date.now(),version=0;
 const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,c,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('CAS'),{status:412});seed(p,{...docs.get(p).data,...c});return this.get(p);}};
 const originalBatch={schema_version:1,id:'pilot_30_oct12',status:'active',budget_cents:120000,overhead_cents:2400,video_ids:Array.from({length:262},(_,i)=>'Legacy_'+i),parallelism:4,active_video_ids:[]};
 const retained={old_paid:{video_id:'Retained_reel',stage:'analysis',maximum_cents:1500,status:'uncertain'}};
 seed('settings/financial',{...newLedger(),paused:false,pilot_envelope_cents:100+1500+380*50,spent_cents:100,reserved_cents:1500,jobs:retained,batch:originalBatch,enabled_stages:{upload:true,transcription:true,analysis:true,media_access:false}});
 seed('settings/automation',{enabled:true,parallelism:1,transcription_enabled:true,analysis_enabled:true});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 const requestId=video=>'batch_approval_'+video+'_20261016',approvalPath=video=>'jobs/assisted_upload_'+requestId(video);
 for(const video of videoIds){
  seed('videos/'+video,{id:video,status:'queued'});
  seed(approvalPath(video),{schema_version:1,kind:'assisted_pipeline',status:'authorized',request_id:requestId(video),authorization_ref:'MEG-109:owner50reels',authorized_at:new Date(now-1000).toISOString(),expires_at:new Date(now-1000+ttl).toISOString(),maximum_cents:380,stage_maximum_cents:quotes,analysis_revision:revision,task:{videoId:video,stage:'upload',poll:0}});
 }
 const stops=new ExecutionStops({store,analysisRevision:revision,clock:()=>now}),acquisition=new AcquisitionControl({store,maximumParallelism:1,clock:()=>now,verifyExecutionStopped:x=>stops.verify(x)});
 const api={project,async request(_url,o){const payload=JSON.parse(Buffer.from(o.json.task.httpRequest.body,'base64'));assert.equal(payload.unitRequestId,requestId(payload.videoId));assert.ok(videoIds.includes(payload.videoId));sent.push(payload);pending.push(payload);return {};}};
 const makeFlow=scope=>{
  scopes.push(scope);
  const operations=Object.fromEntries(stages.map(stage=>[stage,async({video,executionId:id,recordAcquisitionExtraction})=>{
   calls[stage]++;
   if(stage==='upload'){const ended=recordAcquisitionExtraction();if(!missingEnd)ended();}
   if(faults.get(video.id)===stage)throw Error('synthetic unknown paid outcome');
   if(stage==='transcription'&&asyncSTT)return {video_id:video.id,stage,operation_name:'projects/'+project+'/locations/us/operations/'+video.id};
   const changes=stage==='upload'?{media_verified:true,video_key:'originals/instagram/'+video.id+'/video.mp4',video_generation:'1',duration_seconds:30,audio_status:'present'}:stage==='transcription'?{transcript:'one preserved transcript',transcript_key:'results/instagram/'+video.id+'/transcription.json'}:reviewRequired?{analysis_quality_status:'review_required',analysis_candidate:{title:'saved candidate'},analysis_review_reasons:['missing_knowledge'],candidate_analysis_key:'results/instagram/'+video.id+'/'+id+'/analysis.json',candidate_analysis_generation:'1'}:{analysis:{title:'one result'},analysis_quality_status:'accepted'};
   return {video_id:video.id,stage,actual_cents:quotes[stage],changes};
  }]));
  operations.pollTranscription=async({videoId})=>{calls.poll++;return {video_id:videoId,stage:'transcription',actual_cents:quotes.transcription,changes:{transcript:'one collected operation'}};};
  return new WorkerFlow({store,ledger:new FinancialLedger(store,{assistedScope:scope,clock:()=>now}),operations,quotes,eligibleVideos:videoIds,analysisRevision:revision,batchId:originalBatch.id,assistedScope:scope,acquisition,recordExecutionStopped:x=>stops.record(x),verifyExecutionStopped:x=>stops.verify(x),clock:()=>now});
 };
 const mint=(task,stage,create=makeFlow)=>pipelineFlow({store,task,stage,allowedVideoIds:videoIds,quotes,analysisRevision:revision,makeFlow:create,verifyExecutionStopped:x=>stops.verify(x),clock:()=>now});
 const handlers=Object.fromEntries(stages.map(stage=>[stage,workerHandler({stage,flow:null,queue:new WorkerQueue({api,store,workerOrigin:routes[stage].workerOrigin,stageRoutes:routes,enabled:true,clock:()=>now}),authorize:async()=>true,unitFlow:async t=>stageBoundFlow(await mint(t,stage),stage),requireUnitRequest:true})]));
 const first=i=>({videoId:videoIds[i],stage:'upload',poll:0,unitRequestId:requestId(videoIds[i])});
 const deliver=async task=>{const response=await handlers[task.stage](new Request('https://batch.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)}));return {http:response.status,...await response.json()};};
 const run=async i=>{const results=[await deliver(first(i))];while(pending.length)results.push(await deliver(pending.shift()));return results;};
 return {videoIds,store,docs,seed,sent,pending,scopes,faults,calls,first,deliver,run,mint,approvalPath,originalBatch,retained,clock:()=>now,advance:ms=>now+=ms};
}
test('server runtime accepts1/50unique IDs, rejects empty/51/duplicates/malformed IDs',()=>{
 const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
 const config={project,cost_accounting:'conservative_estimate_not_invoice',worker_stage:'upload',worker_origin:routes.upload.workerOrigin,stage_routes:routes,enabled:false,dispatch_enabled:false,admission_enabled:false,single_reel_pipeline_enabled:true,batch_id:'pilot_30_oct12',analysis_revision:revision,quotes};
 for(const list of [ids(1),ids(50)])assert.doesNotThrow(()=>workerRuntime({...config,pilot_video_ids:list},preset,{stage:'upload'}));
 for(const list of [[],ids(51),[ids(1)[0],ids(1)[0]],['tiny'],['bad/id'],[123],{length:2}])assert.throws(()=>workerRuntime({...config,pilot_video_ids:list},preset,{stage:'upload'}));
});
test('50 server-approved Reels cross three queues with separate authority and unchanged262/history',async()=>{
 const f=fixture();
 for(let i=0;i<50;i++){const result=await f.run(i);assert.ok(result.every(r=>r.http===200));}
 const state=(await f.store.get('settings/financial')).data;
 assert.deepEqual(state.batch,f.originalBatch);assert.deepEqual(state.jobs.old_paid,f.retained.old_paid);assert.equal(state.reserved_cents,1500);assert.equal(state.spent_cents,19100);assert.equal(state.paused,false);
 assert.equal(Object.keys(state.jobs).length,151);assert.equal(f.sent.length,100);assert.deepEqual(f.calls,{upload:50,transcription:50,analysis:50,poll:0});
 for(const video of f.videoIds)for(const stage of stages){const job=state.jobs[executionId(video,stage,stage==='analysis'?revision:null)];assert.equal(job.status,'completed');assert.equal(job.assisted_scope_ref,f.approvalPath(video));assert.equal(job.batch_id,undefined);assert.equal(job.maximum_cents,quotes[stage]);}
 for(const scope of f.scopes){assert.equal(scope.batch,true);assert.equal(Object.isFrozen(scope),true);assert.equal(scope.videoId,scope.fields.task.videoId);}
 assert.deepEqual((await f.store.get('settings/acquisition')).data.active,{});
 const before={...f.calls};await f.run(0);assert.deepEqual(f.calls,before);
});
test('outside allowlist, foreign approval ID, mutated quote/revision and forged scope cannot acquire authority',async()=>{
 const outside=fixture();assert.equal((await outside.deliver({...outside.first(0),videoId:'Outside_reel'})).http,500);assert.equal(outside.calls.upload,0);
 for(const mutation of ['task','stage_maximum_cents','analysis_revision']){
  const f=fixture(),p=f.approvalPath(f.videoIds[0]),snapshot=await f.store.get(p);
  const delta=mutation==='task'?{task:{...snapshot.data.task,videoId:f.videoIds[1]}}:mutation==='stage_maximum_cents'?{stage_maximum_cents:{...quotes,upload:21}}:{analysis_revision:'megabrain-video-text-v3'};
  f.seed(p,{...snapshot.data,...delta});assert.equal((await f.deliver(f.first(0))).http,500);assert.equal(f.calls.upload,0);
 }
 const f=fixture(),scope=await f.mint(f.first(0),'upload',s=>s);
 assert.throws(()=>new FinancialLedger(f.store,{assistedScope:{...scope}}),/Escopo assistido/);
 assert.equal((await f.deliver({...f.first(1),batch:true})).http,400);
});
test('48h TTL belongs only to server multi-ID batch; single-ID stays1h and expired new stage rejects',async()=>{
 for(const [size,ttl,valid] of [[1,3600000,true],[1,3600001,false],[50,172800000,true],[50,172800001,false]]){
  const f=fixture({size,ttl});const result=await f.deliver(f.first(0));assert.equal(result.http,valid?200:500);
  if(valid)assert.equal(f.scopes[0].batch,size>1?true:undefined);else assert.equal(f.calls.upload,0);
 }
 const f=fixture();await f.deliver(f.first(0));f.advance(172800000);assert.equal((await f.deliver(f.pending.shift())).http,500);assert.equal(f.calls.transcription,0);
});
for(const stage of stages)test('batch uncertain '+stage+' retains money/no retry/no successor but another Reel continues',async()=>{
 const f=fixture();f.faults.set(f.videoIds[0],stage);const results=await f.run(0);assert.equal(results.at(-1).status,'uncertain');
 let state=(await f.store.get('settings/financial')).data;const id=executionId(f.videoIds[0],stage,stage==='analysis'?revision:null);
 assert.equal(state.jobs[id].status,'uncertain');assert.equal(state.reserved_cents,1500+quotes[stage]);assert.equal(state.paused,false);assert.equal(f.sent.length,stages.indexOf(stage));assert.deepEqual(state.jobs.old_paid,f.retained.old_paid);
 const calls={...f.calls};await f.run(0);assert.deepEqual(f.calls,calls);
 assert.equal((await f.run(1)).at(-1).status,'completed');state=(await f.store.get('settings/financial')).data;assert.equal(state.jobs[id].status,'uncertain');assert.equal(state.reserved_cents,1500+quotes[stage]);assert.equal(state.paused,false);
});
test('unit and unscoped uncertainty still pause globally; batch overestimate completion still pauses',async()=>{
 const unit=fixture({size:1});unit.faults.set(unit.videoIds[0],'upload');await unit.run(0);assert.equal((await unit.store.get('settings/financial')).data.paused,true);
 const ordinary=fixture(),snap=await ordinary.store.get('settings/financial');ordinary.seed('settings/financial',{...snap.data,jobs:{...snap.data.jobs,normal:{video_id:'Normal_video',stage:'upload',status:'started',maximum_cents:20}},reserved_cents:1520});await new FinancialLedger(ordinary.store).transition('normal','uncertain');assert.equal((await ordinary.store.get('settings/financial')).data.paused,true);
 const batch=fixture(),scope=await batch.mint(batch.first(0),'upload',s=>s),ledger=new FinancialLedger(batch.store,{assistedScope:scope,clock:batch.clock});
 await ledger.reserve({executionId:scope.executionId,videoId:scope.videoId,stage:'upload',maximumCents:20});await ledger.transition(scope.executionId,'start');await ledger.transition(scope.executionId,'complete',{actualCents:21});assert.equal((await batch.store.get('settings/financial')).data.paused,true);
});
test('missing upload end proof keeps its slot and blocks next stage/other Reel without another acquisition',async()=>{
 const f=fixture({missingEnd:true});assert.equal((await f.deliver(f.first(0))).status,'completed');
 assert.equal(Object.keys((await f.store.get('settings/acquisition')).data.active).length,1);
 assert.equal((await f.deliver(f.pending.shift())).http,500);assert.equal(f.calls.transcription,0);
 assert.equal((await f.deliver(f.first(1))).status,'blocked');assert.equal(f.calls.upload,1);assert.equal(Object.keys((await f.store.get('settings/acquisition')).data.active).length,1);
});
test('expired batch approval still collects owned waiting STT once, never starts next paid analysis',async()=>{
 const f=fixture({asyncSTT:true});await f.deliver(f.first(0));assert.equal((await f.deliver(f.pending.shift())).status,'waiting');f.advance(172800000);
 assert.equal((await f.deliver(f.pending.shift())).status,'completed');assert.equal(f.calls.transcription,1);assert.equal(f.calls.poll,1);
 assert.equal((await f.deliver(f.pending.shift())).http,500);assert.equal(f.calls.analysis,0);
});

test('batch uncertainty never reopens an operator pause',async()=>{
 const f=fixture(),scope=await f.mint(f.first(0),'upload',s=>s),ledger=new FinancialLedger(f.store,{assistedScope:scope,clock:f.clock});
 await ledger.reserve({executionId:scope.executionId,videoId:scope.videoId,stage:'upload',maximumCents:20});await ledger.transition(scope.executionId,'start');
 const state=(await f.store.get('settings/financial')).data;f.seed('settings/financial',{...state,paused:true});await ledger.transition(scope.executionId,'uncertain');
 assert.equal((await f.store.get('settings/financial')).data.paused,true);
});

test('batch quality-review candidate is preserved without global hold; unit262 retains its original hold',async()=>{
 for(const size of [1,50]){
  const f=fixture({size,reviewRequired:true});assert.equal((await f.run(0)).at(-1).status,'completed');
  const state=(await f.store.get('settings/financial')).data,video=(await f.store.get('videos/'+f.videoIds[0])).data;
  assert.equal(video.status,'needs_attention');assert.equal(video.analysis,undefined);assert.equal(video.candidate_analysis_key,'results/instagram/'+f.videoIds[0]+'/'+executionId(f.videoIds[0],'analysis',revision)+'/analysis.json');
  assert.equal(state.paused,size===1);assert.equal(state.reserved_cents,1500);assert.equal(state.jobs[executionId(f.videoIds[0],'analysis',revision)].status,'completed');
  const before={...f.calls};await f.run(0);assert.deepEqual(f.calls,before);
  if(size>1){assert.equal((await f.run(1)).at(-1).status,'completed');assert.equal((await f.store.get('settings/financial')).data.paused,false);}
 }
});
