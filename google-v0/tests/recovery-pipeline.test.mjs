import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {googleOperations} from '../lib/google-operations.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {pipelineFlow} from '../lib/assisted-pipeline.mjs';
import {recoverySnapshotDigest} from '../lib/assisted-scope.mjs';
import {settledRetryId} from '../lib/smart-retry.mjs';
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
function fixture({size=2,ttl=172800000,asyncSTT=false,missingEnd=false,reviewRequired=false,recent=false,oldProof=true,mediaObjectExists=false,absenceHelper=true}={}){
 const videoIds=ids(size),docs=new Map(),sent=[],pending=[],scopes=[],faults=new Map(),calls={upload:0,transcription:0,analysis:0,poll:0,absence:0};let now=Date.now(),version=0;
 const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,c,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('CAS'),{status:412});seed(p,{...docs.get(p).data,...c});return this.get(p);}};
 const originalBatch={schema_version:1,id:'pilot_30_oct12',status:'active',budget_cents:120000,overhead_cents:2400,video_ids:[...videoIds,...Array.from({length:262-size},(_,i)=>'Legacy_'+i)],parallelism:4,active_video_ids:[]};
 const retained={old_paid:{video_id:'Retained_reel',stage:'analysis',maximum_cents:1500,status:'uncertain'}};
 seed('settings/financial',{...newLedger(),paused:false,pilot_envelope_cents:100+1500+50*size+380*100,spent_cents:100,reserved_cents:1500,jobs:retained,batch:originalBatch,enabled_stages:{upload:true,transcription:true,analysis:true,media_access:false}});
 seed('settings/automation',{enabled:true,parallelism:1,transcription_enabled:true,analysis_enabled:true});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 const requestId=video=>'batch_approval_'+video+'_20261016',approvalPath=video=>'jobs/assisted_upload_'+requestId(video);
 for(const video of videoIds){
  seed('videos/'+video,{id:video,status:'needs_attention'});
  const id=executionId(video,'upload'),claim={video_id:video,stage:'upload',status:'uncertain',failure_diagnostic:{operation_step:'download_media',tool_code:1,http_status:null,download:{phase:'metadata',cause:'unknown',exit_code:1}},...(recent?{assisted_scope_ref:'jobs/assisted_upload_previous_20261016',execution_attempt_id:'00000000-0000-4000-8000-000000000001',analysis_revision:null}:{})};
  const job={video_id:video,stage:'upload',maximum_cents:50,status:recent?'uncertain':'completed',...(recent?{assisted_scope_ref:claim.assisted_scope_ref}:{actual_cents:50,batch_id:originalBatch.id,manual_reconciliation:'terminal_metadata_estimate_accounted_user_verdict_pending'})};
  seed('jobs/'+id,claim);
  const financial=docs.get('settings/financial').data;seed('settings/financial',{...financial,jobs:{...financial.jobs,[id]:job},spent_cents:financial.spent_cents+(recent?0:50),reserved_cents:financial.reserved_cents+(recent?50:0)});
  if(recent&&oldProof)seed('execution_stops/'+id+'_'+claim.execution_attempt_id,{schema_version:1,ended:true,execution_id:id,attempt_id:claim.execution_attempt_id,video_id:video,stage:'upload',analysis_revision:null,claim_update_time:docs.get('jobs/'+id).updateTime,ended_at:new Date(now-500).toISOString()});
  seed(approvalPath(video),{schema_version:1,kind:'assisted_pipeline_recovery',recovery_parent:{execution_id:id,claim_digest:recoverySnapshotDigest(claim),financial_digest:recoverySnapshotDigest(job)},status:'authorized',request_id:requestId(video),authorization_ref:'MEG-109:owner50reels',authorized_at:new Date(now-1000).toISOString(),expires_at:new Date(now-1000+ttl).toISOString(),maximum_cents:380,stage_maximum_cents:quotes,analysis_revision:revision,task:{videoId:video,stage:'upload',poll:0}});
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
  if(absenceHelper)operations.prepareUploadRecovery=async({sourceOnlyRecovery})=>{assert.equal(sourceOnlyRecovery,true);calls.absence++;if(mediaObjectExists)throw Error('immutable media object already exists');};
  operations.pollTranscription=async({videoId})=>{calls.poll++;return {video_id:videoId,stage:'transcription',actual_cents:quotes.transcription,changes:{transcript:'one collected operation'}};};
  return new WorkerFlow({store,ledger:new FinancialLedger(store,{assistedScope:scope,clock:()=>now}),operations,quotes,eligibleVideos:videoIds,analysisRevision:revision,batchId:originalBatch.id,assistedScope:scope,acquisition,recordExecutionStopped:x=>stops.record(x),verifyExecutionStopped:x=>stops.verify(x),clock:()=>now});
 };
 const mint=(task,stage,create=makeFlow)=>pipelineFlow({store,task,stage,allowedVideoIds:['Fresh_reel_00','Fresh_reel_01'],recoveryVideoIds:videoIds,quotes,analysisRevision:revision,makeFlow:create,verifyExecutionStopped:x=>stops.verify(x),clock:()=>now});
 const handlers=Object.fromEntries(stages.map(stage=>[stage,workerHandler({stage,flow:null,queue:new WorkerQueue({api,store,workerOrigin:routes[stage].workerOrigin,stageRoutes:routes,enabled:true,clock:()=>now}),authorize:async()=>true,unitFlow:async t=>stageBoundFlow(await mint(t,stage),stage),requireUnitRequest:true})]));
 const first=i=>({videoId:videoIds[i],stage:'upload',poll:0,unitRequestId:requestId(videoIds[i])});
 const deliver=async task=>{const response=await handlers[task.stage](new Request('https://batch.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)}));return {http:response.status,...await response.json()};};
 const run=async i=>{const results=[await deliver(first(i))];while(pending.length)results.push(await deliver(pending.shift()));return results;};
 return {videoIds,store,docs,seed,sent,pending,scopes,faults,calls,first,deliver,run,mint,approvalPath,originalBatch,retained,clock:()=>now,advance:ms=>now+=ms};
}

const patch=async(f,path,changes)=>{const s=await f.store.get(path);f.seed(path,{...s.data,...changes});};
const refresh=async(f,i=0)=>{const video=f.videoIds[i],id=executionId(video,'upload'),a=(await f.store.get(f.approvalPath(video))).data,fin=(await f.store.get('settings/financial')).data;await patch(f,f.approvalPath(video),{recovery_parent:{execution_id:id,claim_digest:recoverySnapshotDigest((await f.store.get('jobs/'+id)).data),financial_digest:recoverySnapshotDigest(fin.jobs[id])}});};
test('50 old sources each create one child, preserve accounted parents and cross existing three queues',async()=>{
 const f=fixture({size:50}),before=(await f.store.get('settings/financial')).data,claims=await Promise.all(f.videoIds.map(v=>f.store.get('jobs/'+executionId(v,'upload'))));
 for(let i=0;i<50;i++)assert.ok((await f.run(i)).every(r=>r.http===200&&r.status==='completed'));
 const after=(await f.store.get('settings/financial')).data;
 assert.deepEqual(after.batch,before.batch);assert.equal(after.reserved_cents,before.reserved_cents);assert.equal(after.spent_cents,before.spent_cents+19000);assert.equal(after.paused,false);
 for(let i=0;i<50;i++){
  const v=f.videoIds[i],parent=executionId(v,'upload'),child=settledRetryId(parent);
  assert.deepEqual(after.jobs[parent],before.jobs[parent]);assert.deepEqual(await f.store.get('jobs/'+parent),claims[i]);
  for(const [s,id]of [['upload',child],['transcription',executionId(v,'transcription')],['analysis',executionId(v,'analysis',revision)]])assert.equal(after.jobs[id].status,'completed');
  assert.ok(await f.store.get('execution_stops/'+child+'_'+(await f.store.get('jobs/'+child)).data.execution_attempt_id));
 }
 const called={...f.calls};await f.run(0);assert.deepEqual(f.calls,called);assert.equal(f.sent.length,100);assert.equal(f.scopes[0].recovery,true);assert.equal(f.scopes[0].batch,true);
});
test('closed private uncertain source keeps old reservation while child completes; proof is mandatory',async()=>{
 const f=fixture({recent:true}),before=(await f.store.get('settings/financial')).data;
 assert.equal((await f.run(0)).at(-1).status,'completed');
 const after=(await f.store.get('settings/financial')).data,id=executionId(f.videoIds[0],'upload');
 assert.deepEqual(after.jobs[id],before.jobs[id]);assert.equal(after.reserved_cents,before.reserved_cents);assert.equal((await f.store.get('jobs/'+id)).data.status,'uncertain');
 const missing=fixture({recent:true,oldProof:false});assert.equal((await missing.deliver(missing.first(0))).http,500);assert.equal(missing.calls.upload,0);
});
test('unsupported legacy markers, generic failure and unproved private source never gain recovery authority',async()=>{
 for(const mode of ['marker','generic','retired','paid']){
  const f=fixture({recent:mode==='retired'}),v=f.videoIds[0],id=executionId(v,'upload'),fin=(await f.store.get('settings/financial')).data;
  if(mode==='marker'){fin.jobs[id].manual_reconciliation='some_previous_equivalence';f.seed('settings/financial',fin);}
  if(mode==='generic')await patch(f,'jobs/'+id,{failure_diagnostic:{operation_step:'download_media',tool_code:1}});
  if(mode==='retired')f.docs.delete('execution_stops/'+id+'_00000000-0000-4000-8000-000000000001');
  if(mode==='paid'){fin.jobs.paid={video_id:v,stage:'analysis',status:'uncertain',maximum_cents:240};fin.reserved_cents+=240;f.seed('settings/financial',fin);}
  await refresh(f);assert.equal((await f.deliver(f.first(0))).http,500,mode);assert.equal(f.calls.upload,0);
 }
});
test('any preexisting paid claim or saved media/result blocks source replay before consuming approval',async()=>{
 for(const type of ['stt_claim','v3_claim','analysis_claim','analysis_child','candidate','transcript','original_object']){
  const f=fixture({mediaObjectExists:type==='original_object'}),v=f.videoIds[0];
  if(type==='stt_claim')f.seed('jobs/'+executionId(v,'transcription'),{video_id:v,stage:'transcription',status:'waiting'});
  if(type==='v3_claim')f.seed('jobs/'+executionId(v,'analysis','megabrain-video-text-v3'),{video_id:v,stage:'analysis',status:'uncertain'});
  if(type==='analysis_claim')f.seed('jobs/'+executionId(v,'analysis',revision),{video_id:v,stage:'analysis',status:'uncertain'});
  if(type==='analysis_child')f.seed('jobs/'+settledRetryId(executionId(v,'analysis',revision)),{video_id:v,stage:'analysis',status:'uncertain'});
  if(type==='candidate')await patch(f,'videos/'+v,{candidate_analysis_key:'saved/candidate'});
  if(type==='transcript')await patch(f,'videos/'+v,{transcript:'preserve paid text'});
  const result=await f.deliver(f.first(0));assert.equal(result.http,type==='original_object'?200:500,type);if(type==='original_object')assert.equal(result.status,'blocked');assert.equal(f.calls.upload,0);
  assert.equal((await f.store.get('settings/financial')).data.jobs[settledRetryId(executionId(v,'upload'))],undefined);
 }
});
test('claim/financial snapshot drift, wrong parent and fresh authority mismatch reject',async()=>{
 for(const mode of ['claim','financial','parent','kind','foreign','expired']){
  const f=fixture(),v=f.videoIds[0],id=executionId(v,'upload');
  if(mode==='claim')await patch(f,'jobs/'+id,{diagnostic_updated:true});
  if(mode==='financial'){const fin=(await f.store.get('settings/financial')).data;fin.jobs[id].memo='changed';f.seed('settings/financial',fin);}
  if(mode==='parent'){const a=(await f.store.get(f.approvalPath(v))).data;await patch(f,f.approvalPath(v),{recovery_parent:{...a.recovery_parent,execution_id:executionId(f.videoIds[1],'upload')}});}
  if(mode==='kind')await patch(f,f.approvalPath(v),{kind:'assisted_pipeline'});
  if(mode==='expired')f.advance(172800000);
  const result=await f.deliver(mode==='foreign'?{...f.first(0),videoId:'Fresh_reel_00'}:f.first(0));
  assert.equal(result.http,500,mode);assert.equal(f.calls.upload,0);
 }
});
test('recovery child uncertain retains both reservations, no retry/successor; another source can continue',async()=>{
 const f=fixture({recent:true});f.faults.set(f.videoIds[0],'upload');const old=(await f.store.get('settings/financial')).data;
 assert.equal((await f.run(0)).at(-1).status,'uncertain');const child=settledRetryId(executionId(f.videoIds[0],'upload'));
 let fin=(await f.store.get('settings/financial')).data;assert.equal(fin.jobs[child].status,'uncertain');assert.equal(fin.reserved_cents,old.reserved_cents+20);assert.equal(fin.paused,false);assert.equal(f.sent.length,0);
 const before={...f.calls};await f.run(0);assert.deepEqual(f.calls,before);
 assert.equal((await f.run(1)).at(-1).status,'completed');fin=(await f.store.get('settings/financial')).data;assert.equal(fin.reserved_cents,old.reserved_cents+20);assert.deepEqual(fin.jobs[executionId(f.videoIds[0],'upload')],old.jobs[executionId(f.videoIds[0],'upload')]);
});
test('child positive end proof is required for STT; missing closure keeps capacity',async()=>{
 const f=fixture({missingEnd:true});assert.equal((await f.deliver(f.first(0))).status,'completed');assert.equal((await f.deliver(f.pending.shift())).http,500);assert.equal(f.calls.transcription,0);assert.equal(Object.keys((await f.store.get('settings/acquisition')).data.active).length,1);
});
test('parent drift after upload blocks next paid stage, without altering saved child artifact',async()=>{
 const f=fixture(),v=f.videoIds[0];assert.equal((await f.deliver(f.first(0))).status,'completed');await patch(f,'jobs/'+executionId(v,'upload'),{changed_after_approval:true});assert.equal((await f.deliver(f.pending.shift())).http,500);assert.equal(f.calls.transcription,0);assert.equal((await f.store.get('videos/'+v)).data.media_verified,true);
});
test('server recovery allowlist is separate, bounded100, unique and disjoint from unchanged50',()=>{
 const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
 const config={project,cost_accounting:'conservative_estimate_not_invoice',worker_stage:'upload',worker_origin:routes.upload.workerOrigin,stage_routes:routes,enabled:false,dispatch_enabled:false,admission_enabled:false,single_reel_pipeline_enabled:true,batch_id:'pilot_30_oct12',analysis_revision:revision,quotes,pilot_video_ids:ids(50)};
 const list=Array.from({length:100},(_,i)=>'Recovery_'+i);
 assert.doesNotThrow(()=>workerRuntime({...config,recovery_video_ids:list},preset,{stage:'upload'}));
 for(const recovery_video_ids of [[...list,'extra_recovery'],[list[0],list[0]],[ids(1)[0]],['bad/id'],{}])assert.throws(()=>workerRuntime({...config,recovery_video_ids},preset,{stage:'upload'}));
});

test('source-only preflight rejects orphan audio, STT or canonical/settled analysis objects using metadata only',async()=>{
 const v='Recovery_object',transcription=executionId(v,'transcription'),analyses=[executionId(v,'analysis'),executionId(v,'analysis','megabrain-video-text-v3'),executionId(v,'analysis',revision)];
 const keys=['originals/instagram/'+v+'/video.mp4','results/instagram/'+v+'/'+transcription+'/audio.flac','results/instagram/'+v+'/'+transcription+'/transcription.json',...analyses.flatMap(id=>[id,settledRetryId(id)].map(job=>'results/instagram/'+v+'/'+job+'/analysis.json'))];
 for(const found of [null,...keys]){
  const seen=[],storage={bucket:project+'-media',async metadata(k){seen.push(k);return k===found?{generation:'17'}:null;},async read(){assert.fail('preflight must not read artifact contents');},async writeImmutable(){assert.fail('preflight must not mutate');}};
  const operations=googleOperations({api:{project,async request(){assert.fail('no provider request');}},storage,tools:{},preset:{version:revision},config:{},gate:async()=>assert.fail('no financial or provider admission')});
  const action=()=>operations.prepareUploadRecovery({video:{id:v},sourceOnlyRecovery:true});
  if(found)await assert.rejects(action,/existente|preservado/);else{await action();assert.deepEqual(seen,keys);}
 }
});

test('missing source absence preflight fails closed before another download or financial reservation',async()=>{
 const f=fixture({absenceHelper:false}),before=(await f.store.get('settings/financial')).data;
 assert.equal((await f.deliver(f.first(0))).status,'blocked');assert.equal(f.calls.upload,0);
 const after=(await f.store.get('settings/financial')).data;assert.deepEqual(after.jobs,before.jobs);assert.equal(after.reserved_cents,before.reserved_cents);
});
