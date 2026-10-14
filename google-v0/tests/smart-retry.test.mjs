import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {SmartRetry,settledRetryId,settledRetryAuthorizationPath,settledRetryAllowed} from '../lib/smart-retry.mjs';
import {failureDigest} from '../lib/firestore-recovery.mjs';
import {WorkerQueue,workerHandler,validateTask} from '../lib/worker-queue.mjs';
function fixture(stage='upload'){
 const now=Date.now(),videoId='Reel_1',batchId='pilot_retry',recoveryId='owner_retry_20261014',revision='megabrain-video-text-v4',originalId=executionId(videoId,stage,stage==='analysis'?revision:null),max=stage==='upload'?50:250;
 const diagnostic=stage==='upload'?{operation_step:'download_media',tool_code:1,http_status:null,download:{phase:'metadata',cause:'unknown',exit_code:1}}:{operation_step:'submit_analysis',http_status:400,provider:{status:'INVALID_ARGUMENT',message:'response schemas specified other fields alongside any_of'}};
 const claim={video_id:videoId,stage,status:'uncertain',failure_diagnostic:diagnostic,...(stage==='analysis'?{analysis_attempts:[{number:1,status:'uncertain'}]}:{})};
 const financial={video_id:videoId,stage,status:'completed',maximum_cents:max,actual_cents:max,batch_id:batchId,manual_reconciliation:stage==='upload'?'terminal_metadata_estimate_accounted_user_verdict_pending':'confirmed_schema400_full_estimate_accounted_analysis_pending',...(stage==='analysis'?{analysis_revision:revision}:{})};
 const video={id:videoId,status:'needs_attention',error:'Original failure',...(stage==='analysis'?{media_verified:true,audio_status:'present',video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'1',transcript:'Saved text',transcript_key:`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`,transcript_generation:'2'}:{media_verified:false,instagram_review_status:'awaiting_user_verdict'})};
 const authorization={schema_version:1,status:'authorized',kind:stage==='upload'?'source_acquisition':'confirmed_schema_rejection',original_execution_id:originalId,video_id:videoId,stage,maximum_cents:max,recovery_id:recoveryId,failure_digest:failureDigest(diagnostic),authorization_ref:'owner:test:20261014',authorized_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString()};
 const docs=new Map();let version=0;const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 seed(`jobs/${originalId}`,claim);seed(`videos/${videoId}`,video);seed(settledRetryAuthorizationPath(originalId),authorization);
 seed('settings/automation',{enabled:true,analysis_enabled:true,transcription_enabled:true,parallelism:4});
 seed('settings/financial',{...newLedger(),paused:false,allocation_cents:150000,coverage_verified:true,ongoing_commitment_cents:9400,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:170140,balance_observed_at:new Date(now).toISOString(),balance_max_age_seconds:86400,credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true},spent_cents:max,reserved_cents:0,jobs:{[originalId]:financial},batch:{schema_version:1,id:batchId,status:'active',budget_cents:120000,overhead_cents:2400,parallelism:4,video_ids:[videoId,...Array.from({length:261},(_,i)=>`Reel_${i+2}`)],active_video_ids:[]}});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,data,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('Conflict'),{status:412});seed(p,{...docs.get(p).data,...data});return this.get(p);}};
 const ledger=new FinancialLedger(store,{clock:()=>now});let calls=0,checks=0;
 const operations={async prepareUploadRecovery(){checks++;},async prepareSettledAnalysisRetry(){checks++;},async [stage]({executionId:id}){calls++;return {video_id:videoId,stage,actual_cents:max,changes:stage==='upload'?{media_verified:true,audio_status:'present',video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'3'}:{analysis:{title:'Accepted result'},analysis_key:`results/instagram/${videoId}/${id}/analysis.json`,analysis_generation:'4',analysis_quality_status:'accepted'}};}};
 const quotes={upload:50,transcription:120,analysis:250},flow=new WorkerFlow({store,ledger,operations,quotes,batchId,analysisRevision:revision,clock:()=>now});
 const task={videoId,stage,poll:0,recoveryId,recoverSettled:true};
 return {store,seed,docs,flow,ledger,operations,task,originalId,claim,financial,video,authorization,now,quotes,batchId,videoId,recoveryId,calls:()=>calls,checks:()=>checks};
}
for(const stage of ['upload','analysis'])test(`${stage}: concurrent explicit retries preserve original claims and cover one linked attempt`,async()=>{
 const f=fixture(stage),original=await f.store.get(`jobs/${f.originalId}`);
 const results=await Promise.allSettled([f.flow.run(f.task),f.flow.run(f.task)]);
 assert.ok(results.some(r=>r.value?.status==='completed'),JSON.stringify({results,child:await f.store.get('jobs/'+settledRetryId(f.originalId))}));assert.equal(f.calls(),1);assert.equal(f.checks(),1);
 assert.deepEqual(await f.store.get(`jobs/${f.originalId}`),original);
 const ledger=(await f.store.get('settings/financial')).data;
 assert.deepEqual(ledger.jobs[f.originalId],f.financial);assert.equal(Object.keys(ledger.jobs).length,2);
 assert.equal(ledger.jobs[settledRetryId(f.originalId)].recovery_of,f.originalId);assert.equal(ledger.spent_cents,2*f.financial.maximum_cents);assert.equal(ledger.reserved_cents,0);
 await f.flow.run({...f.task,recoveryId:'another_owner_retry_2026'});assert.equal(f.calls(),1);
 if(stage==='upload')assert.equal((await f.store.get(`videos/${f.videoId}`)).data.instagram_review_status,null);
});
for(const stage of ['upload','analysis'])test(`${stage}: stale authorization, altered failure, unknown results and completed artifacts block`,async()=>{
 for(const change of [f=>f.authorization.expires_at=new Date(0).toISOString(),f=>f.authorization.recovery_id='different_owner_retry_2026',f=>f.authorization.failure_digest='a'.repeat(64),f=>f.claim.failure_diagnostic.operation_step='submit_stt',f=>f.claim.operation_name='submitted_operation',f=>f.video.analysis_key='existing.json',f=>f.financial.status='uncertain',f=>f.financial.actual_cents=0]){
  const f=fixture(stage);change(f);f.seed(settledRetryAuthorizationPath(f.originalId),f.authorization);f.seed(`jobs/${f.originalId}`,f.claim);f.seed(`videos/${f.videoId}`,f.video);const state=(await f.store.get('settings/financial')).data;state.jobs[f.originalId]=f.financial;f.seed('settings/financial',state);
  assert.equal((await f.flow.run(f.task)).status,'blocked');assert.equal(f.calls(),0);assert.equal(f.checks(),0);
 }
});
test('existing immutable original stops download and the retained child prevents repeated attempts',async()=>{
 const f=fixture();f.operations.prepareUploadRecovery=async()=>{throw Error('Object exists');};
 assert.equal((await f.flow.run(f.task)).status,'blocked');assert.equal(f.calls(),0);await f.flow.run(f.task);assert.equal(f.calls(),0);assert.equal(Object.keys((await f.store.get('settings/financial')).data.jobs).length,1);
});
test('partial failure after new submission holds coverage and never submits twice',async()=>{
 const f=fixture('analysis');f.operations.analysis=async()=>{throw Object.assign(Error('Unknown result'),{operation_step:'submit_analysis'});};
 assert.equal((await f.flow.run(f.task)).status,'uncertain');assert.equal((await f.flow.run(f.task)).duplicate,true);
 const ledger=(await f.store.get('settings/financial')).data;assert.equal(ledger.paused,true);assert.equal(ledger.reserved_cents,250);assert.deepEqual(ledger.jobs[f.originalId],f.financial);
});
test('explicit settled retry cannot bypass financial authorization or global budget',async()=>{
 const f=fixture();await assert.rejects(f.ledger.reserve({executionId:settledRetryId(f.originalId),videoId:f.videoId,stage:'upload',maximumCents:50,recoveryOf:f.originalId,settledRetry:true,recoveryId:f.recoveryId}));
 const state=(await f.store.get('settings/financial')).data;state.remaining_credit_cents=1;f.seed('settings/financial',state);
 assert.equal((await f.flow.run(f.task)).status,'blocked');assert.equal(f.calls(),0);
});
test('retry identity is distinct and mixed flags, polling and missing authorization cannot dispatch',async()=>{
 const f=fixture(),q=new WorkerQueue({api:{project:'megabrain-v0-1017370021431'},store:f.store,workerOrigin:'https://retry-worker.run.app',enabled:true});
 assert.notEqual(q.dispatchPath(f.task),q.dispatchPath({...f.task,recoverSettled:undefined}));
 for(const edit of [{stage:'transcription'},{poll:1},{recoveryId:undefined},{recoverUpload:true},{recoverAnalysis429:true},{recoverFirestoreWrite:true}])assert.throws(()=>validateTask({...f.task,...edit}));
 const sent=[],handler=workerHandler({flow:f.flow,queue:{async enqueue(task){sent.push(task);return {status:'queued'};}},authorize:async()=>true});
 await handler(new Request('https://retry-worker.run.app/tasks/run',{method:'POST',body:JSON.stringify(f.task)}));assert.equal(sent[0].stage,'transcription');assert.equal(sent[0].recoverSettled,undefined);assert.equal(sent[0].recoveryId,f.recoveryId);
});
test('planner uses configured analysis revision and chooses artifact reconciliation before a paid retry',async()=>{
 const f=fixture('analysis');
 for(const stage of ['upload','transcription']){const id=executionId(f.videoId,stage);f.seed(`jobs/${id}`,{status:'completed'});const s=(await f.store.get('settings/financial')).data;s.jobs[id]={status:'completed'};f.seed('settings/financial',s);}
 const q={async enqueue(){assert.fail('Saved response must not dispatch inference');}},artifact={key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,generation:'7'};let reconciled=0;
 const retry=new SmartRetry({store:f.store,queue:q,quotes:f.quotes,batchId:f.batchId,artifactInspector:async()=>artifact,flow:{async reconcileAnalysis(){reconciled++;return {status:'completed'};}}});
 assert.equal((await retry.inspect(f.videoId)).status,'reconcile_saved_result');assert.equal((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:test:20261014'})).status,'completed');assert.equal(reconciled,1);
});
test('planner never turns accounted client timeout into permission to resubmit',async()=>{
 const f=fixture('analysis');f.claim.failure_diagnostic={operation_step:'submit_analysis',http_status:null,tool_code:23};f.seed(`jobs/${f.originalId}`,f.claim);
 const guard={authorization:f.authorization,claim:f.claim,financial:f.financial,video:f.video,originalId:f.originalId,videoId:f.videoId,stage:'analysis',maximumCents:250,recoveryId:f.recoveryId,now:f.now};
 assert.equal(settledRetryAllowed(guard),false);
});
test('persisted response reconciliation completes metadata without another inference or accounting charge',async()=>{
 const f=fixture('analysis');let restores=0;
 f.operations.analysis=async()=>assert.fail('Must never call model');
 f.operations.restoreAnalysisResult=async()=>{restores++;return {video_id:f.videoId,stage:'analysis',actual_cents:250,artifact:{key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,generation:'8'},changes:{analysis:{title:'Recovered'},analysis_key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,analysis_generation:'8',analysis_quality_status:'accepted'}};};
 const before=(await f.store.get('settings/financial')).data;
 assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:test:20261014'})).status,'completed');
 assert.deepEqual((await f.store.get('settings/financial')).data,before);assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:test:20261014'})).duplicate,true);assert.equal(restores,1);
});
test('a reconciliation lost receipt can be resumed without repeating the model or settling cost twice',async()=>{
 const f=fixture('analysis');const original=f.store.patch.bind(f.store);let fail=true;
 f.operations.restoreAnalysisResult=async()=>({video_id:f.videoId,stage:'analysis',actual_cents:250,artifact:{key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,generation:'8'},changes:{analysis:{title:'Recovered'},analysis_key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,analysis_generation:'8',analysis_quality_status:'accepted'}});
 f.store.patch=async(path,changes,options)=>{if(path===`jobs/${f.originalId}`&&changes.status==='completed'&&fail){fail=false;throw Error('lost write');}return original(path,changes,options);};
 await assert.rejects(f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:test:20261014'}));
 assert.equal((await f.store.get(`jobs/${f.originalId}`)).data.status,'reconciliation_failed');
 assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:test:20261014'})).status,'completed');assert.equal((await f.store.get('settings/financial')).data.spent_cents,250);
});

test('source retry request creates a durable authorization and duplicate dispatch converges',async()=>{
 const f=fixture(),sent=[];f.docs.delete(settledRetryAuthorizationPath(f.originalId));
 const q=new WorkerQueue({api:{project:'megabrain-v0-1017370021431',async request(url,options){sent.push(options.json.task);}},store:f.store,workerOrigin:'https://retry-worker.run.app',enabled:true});
 const retry=new SmartRetry({store:f.store,queue:q,quotes:f.quotes,batchId:f.batchId,clock:()=>f.now});
 const action={videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:test:20261014'};
 await Promise.all([retry.request(action),retry.request(action)]);assert.equal(sent.length,1);assert.equal(JSON.parse(Buffer.from(sent[0].httpRequest.body,'base64')).recoverSettled,true);
 assert.deepEqual((await f.store.get(`jobs/${f.originalId}`)).data,f.claim);assert.deepEqual((await f.store.get('settings/financial')).data.jobs[f.originalId],f.financial);
});
test('paid retry stays paused while saved-result reconciliation leaves the pause intact',async()=>{
 const f=fixture('analysis'),state=(await f.store.get('settings/financial')).data;state.paused=true;state.batch.status='paused';f.seed('settings/financial',state);f.seed('settings/automation',{enabled:false});
 const retry=new SmartRetry({store:f.store,queue:{async enqueue(){assert.fail('Paused queue');}},quotes:f.quotes,batchId:f.batchId});
 // Upload and transcription are already complete for this preserved analysis.
 for(const stage of ['upload','transcription']){const id=executionId(f.videoId,stage);f.seed(`jobs/${id}`,{status:'completed'});state.jobs[id]={video_id:f.videoId,stage,status:'completed',maximum_cents:1,actual_cents:1,batch_id:f.batchId};}
 f.seed('settings/financial',state);assert.equal((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:test:20261014'})).status,'paused');
 f.operations.restoreAnalysisResult=async()=>({video_id:f.videoId,stage:'analysis',actual_cents:250,artifact:{key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,generation:'8'},changes:{analysis:{title:'Recovered'},analysis_key:`results/instagram/${f.videoId}/${f.originalId}/analysis.json`,analysis_generation:'8',analysis_quality_status:'accepted'}});
 assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:test:20261014'})).status,'completed');assert.equal((await f.store.get('settings/financial')).data.paused,true);assert.equal((await f.store.get('settings/automation')).data.enabled,false);
});
