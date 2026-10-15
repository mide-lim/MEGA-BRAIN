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

function completeSources(f){
 const state=f.docs.get('settings/financial').data;
 for(const stage of ['upload','transcription']){
  const id=executionId(f.videoId,stage),cost=f.quotes[stage];
  f.seed(`jobs/${id}`,{video_id:f.videoId,stage,status:'completed'});
  state.jobs[id]={video_id:f.videoId,stage,status:'completed',maximum_cents:cost,actual_cents:cost,batch_id:f.batchId};state.spent_cents+=cost;
 }
 f.seed('settings/financial',state);
}
function savedResult(f,id=f.originalId){
 const key=`results/instagram/${f.videoId}/${id}/analysis.json`;
 return {video_id:f.videoId,stage:'analysis',actual_cents:250,artifact:{key,generation:'8'},changes:{analysis:{title:'Recovered'},analysis_key:key,analysis_generation:'8',analysis_quality_status:'accepted'}};
}
async function interruptedChild(point='video'){
 const f=fixture('analysis');completeSources(f);
 const childId=settledRetryId(f.originalId),saved=new Map(),operation=f.operations.analysis,patch=f.store.patch.bind(f.store);let fail=true,restores=0;
 f.operations.analysis=async args=>{await operation(args);const result=savedResult(f,args.executionId);saved.set(result.artifact.key,result);return result;};
 f.operations.restoreAnalysisResult=async({executionId:id})=>{restores++;assert.equal(id,childId);return structuredClone(saved.get(`results/instagram/${f.videoId}/${id}/analysis.json`));};
 f.store.patch=async(path,changes,options)=>{
  if(fail&&(point==='video'&&path===`videos/${f.videoId}`&&changes.analysis||point==='financial'&&path==='settings/financial'&&changes.jobs?.[childId]?.status==='completed'||point==='claim'&&path===`jobs/${childId}`&&changes.status==='completed')){fail=false;throw Error('Injected persistence failure');}
  return patch(path,changes,options);
 };
 assert.equal((await f.flow.run(f.task)).status,'uncertain');assert.equal(f.calls(),1);assert.equal(saved.size,1);
 return {...f,childId,saved,restores:()=>restores};
}
for(const point of ['video','financial','claim'])test(`saved child response survives ${point} failure and reconciles while paused without another inference or parent change`,async()=>{
 const f=await interruptedChild(point),parentClaim=await f.store.get(`jobs/${f.originalId}`),parentFinancial=(await f.store.get('settings/financial')).data.jobs[f.originalId];
 const state=(await f.store.get('settings/financial')).data;state.paused=true;state.batch.status='paused';f.seed('settings/financial',state);f.seed('settings/automation',{enabled:false});
 const retry=new SmartRetry({store:f.store,queue:{enqueue(){assert.fail('No dispatch during saved-result recovery');}},quotes:f.quotes,batchId:f.batchId,flow:f.flow,artifactInspector:async({executionId:id})=>f.saved.get(`results/instagram/${f.videoId}/${id}/analysis.json`)?.artifact??null});
 assert.equal((await retry.inspect(f.videoId)).execution_id,f.childId);
 assert.equal((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:child:20261015'})).status,'completed');
 const after=(await f.store.get('settings/financial')).data;
 assert.equal(after.reserved_cents,0);assert.equal(after.spent_cents,670);assert.equal(after.paused,true);assert.equal(after.batch.status,'paused');assert.deepEqual(after.jobs[f.originalId],parentFinancial);assert.deepEqual(await f.store.get(`jobs/${f.originalId}`),parentClaim);
 assert.equal(after.jobs[f.childId].status,'completed');assert.equal(after.jobs[f.childId].actual_cents,250);assert.equal((await f.store.get(`videos/${f.videoId}`)).data.analysis_generation,'8');
 await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:child:20261015',executionId:f.childId});
 assert.deepEqual((await f.store.get('settings/financial')).data,after);assert.equal(f.calls(),1);assert.equal(f.restores(),1);
});
test('child recovery rejects arbitrary execution IDs, broken linkage, wrong generation and missing artifact without submitting',async()=>{
 for(const change of ['identity','linkage','generation','missing']){
  const f=await interruptedChild();
  if(change==='identity')assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:child:20261015',executionId:executionId('OtherReel','analysis','megabrain-video-text-v4')})).reason,'result_execution_mismatch');
  if(change==='linkage'){const child=(await f.store.get(`jobs/${f.childId}`)).data;child.recovery_of='job_wrong_parent';f.seed(`jobs/${f.childId}`,child);assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:child:20261015',executionId:f.childId})).reason,'result_retry_linkage_mismatch');}
  if(change==='generation'){f.saved.values().next().value.artifact.generation='invalid';await assert.rejects(f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:child:20261015',executionId:f.childId}));}
  if(change==='missing'){f.saved.clear();const retry=new SmartRetry({store:f.store,queue:{enqueue(){assert.fail('Unknown child cannot dispatch');}},quotes:f.quotes,batchId:f.batchId,flow:f.flow,artifactInspector:async()=>null});assert.equal((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:child:20261015'})).reason,'retry_already_claimed');}
  assert.equal(f.calls(),1);assert.equal((await f.store.get('settings/financial')).data.reserved_cents,250);
 }
});
for(const revision of [null,'megabrain-video-text-v3'])test(`completed ${revision??'v0'} history survives recovery of the current result and rejected candidates preserve the published analysis`,async()=>{
 const f=fixture('analysis'),oldId=executionId(f.videoId,'analysis',revision),oldFinancial={video_id:f.videoId,stage:'analysis',status:'completed',maximum_cents:250,actual_cents:250,...(revision?{analysis_revision:revision}:{})};
 const state=(await f.store.get('settings/financial')).data;state.jobs[oldId]=oldFinancial;state.spent_cents+=250;f.seed('settings/financial',state);
 f.seed(`jobs/${oldId}`,{video_id:f.videoId,stage:'analysis',status:'completed',legacy_evidence:'Preserve this history'});const oldClaim=await f.store.get(`jobs/${oldId}`);
 const published={title:'Previous accepted analysis'},oldKey=`results/instagram/${f.videoId}/${oldId}/analysis.json`,v=(await f.store.get(`videos/${f.videoId}`)).data;Object.assign(v,{analysis:published,analysis_key:oldKey,analysis_generation:'6',analysis_quality_status:'accepted'});f.seed(`videos/${f.videoId}`,v);
 f.operations.restoreAnalysisResult=async()=>{const result=savedResult(f);result.changes={analysis:published,analysis_key:oldKey,analysis_generation:'6',analysis_quality_status:'review_required',analysis_review_reasons:['invalid_categories'],analysis_candidate:{title:'Candidate'},candidate_analysis_key:result.artifact.key,candidate_analysis_generation:'8'};return result;};
 assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:history:20261015'})).status,'completed');
 const after=(await f.store.get(`videos/${f.videoId}`)).data;assert.deepEqual(after.analysis,published);assert.equal(after.analysis_key,oldKey);assert.equal(after.analysis_generation,'6');assert.equal(after.candidate_analysis_generation,'8');assert.deepEqual(await f.store.get(`jobs/${oldId}`),oldClaim);assert.deepEqual((await f.store.get('settings/financial')).data.jobs[oldId],oldFinancial);assert.equal((await f.store.get('settings/financial')).data.spent_cents,state.spent_cents);assert.equal(f.calls(),0);
});
test('active, uncertain and completed same-revision competitors still block before restoring or mutating',async()=>{
 for(const status of ['reserved','started','uncertain','completed']){
  const f=fixture('analysis'),state=(await f.store.get('settings/financial')).data,id='job_competing_analysis';state.jobs[id]={video_id:f.videoId,stage:'analysis',status,maximum_cents:250,...(status==='completed'?{actual_cents:250,analysis_revision:'megabrain-video-text-v4'}:{analysis_revision:'megabrain-video-text-v3'})};
  if(status==='completed')state.spent_cents+=250;else{state.reserved_cents=250;state.batch.active_video_ids=[f.videoId];}f.seed('settings/financial',state);
  f.operations.restoreAnalysisResult=async()=>assert.fail('Conflicting work must block before reading result');const before=structuredClone(f.docs);
  assert.equal((await f.flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:history:20261015'})).status,'blocked');assert.deepEqual(f.docs,before);assert.equal(f.calls(),0);
 }
});
function unsubmittedFixture(){
 const f=fixture('analysis');completeSources(f);const state=structuredClone(f.docs.get('settings/financial').data);delete state.jobs[f.originalId];state.spent_cents-=250;f.seed('settings/financial',state);f.seed(`jobs/${f.originalId}`,{video_id:f.videoId,stage:'analysis',status:'blocked',failure_diagnostic:{operation_step:'adapter_or_reservation',http_status:null,tool_code:null}});return f;
}
function retryQueue(f,request=async()=>{}){
 return new WorkerQueue({api:{project:'megabrain-v0-1017370021431',request},store:f.store,workerOrigin:'https://retry-worker.run.app',enabled:true});
}
function planner(f,queue){return new SmartRetry({store:f.store,queue,quotes:f.quotes,batchId:f.batchId,flow:f.flow,artifactInspector:async()=>null});}
for(const point of ['ready_receipt','before_outbox','outbox_receipt'])test(`unsubmitted dispatch resumes after ${point} interruption with its original identity`,async()=>{
 const f=unsubmittedFixture(),patch=f.store.patch.bind(f.store),create=f.store.create.bind(f.store);let fail=true,calls=0,firstTask;
 if(point==='ready_receipt')f.store.patch=async(path,changes,options)=>{const saved=await patch(path,changes,options);if(fail&&path===`jobs/${f.originalId}`&&changes.status==='retry_ready'){fail=false;throw Error('Lost ready receipt');}return saved;};
 if(point==='before_outbox'||point==='outbox_receipt')f.store.create=async(path,data)=>{if(fail&&path.startsWith('jobs/dispatch_')){fail=false;if(point==='outbox_receipt')await create(path,data);throw Error('Interrupted dispatch intent');}return create(path,data);};
 const queue=retryQueue(f,async(url,{json})=>{calls++;firstTask=JSON.parse(Buffer.from(json.task.httpRequest.body,'base64'));}),retry=planner(f,queue),action={videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:dispatch:20261015'};
 await assert.rejects(retry.request(action));
 const second=await retry.request({...action,recoveryId:'different_click_20261015'});
 assert.equal(second.status,point==='outbox_receipt'?'duplicate':'queued');assert.equal(calls,point==='outbox_receipt'?0:1);
 assert.equal((await f.store.get(`jobs/${f.originalId}`)).data.retry_recovery_id,f.recoveryId);
 if(firstTask)assert.equal(firstTask.recoveryId,f.recoveryId);
 assert.equal((await retry.request({...action,recoveryId:'third_click_20261015'})).status,'duplicate');assert.equal(f.calls(),0);
});
test('concurrent unsubmitted requests converge, execute once and keep the first authorization and failure',async()=>{
 const f=unsubmittedFixture(),sent=[],queue=retryQueue(f,async(url,{json})=>sent.push(JSON.parse(Buffer.from(json.task.httpRequest.body,'base64')))),retry=planner(f,queue),before=(await f.store.get(`jobs/${f.originalId}`)).data.failure_diagnostic;
 const results=await Promise.all([retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:first:20261015'}),retry.request({videoId:f.videoId,recoveryId:'second_click_20261015',authorizationRef:'owner:second:20261015'})]);
 assert.ok(results.some(x=>x.status==='queued'));assert.equal(sent.length,1);assert.equal(sent[0].recoveryId,f.recoveryId);
 const claim=(await f.store.get(`jobs/${f.originalId}`)).data;assert.deepEqual(claim.original_failure_diagnostic,before);assert.equal(claim.recovery_authorization_ref,'owner:first:20261015');
 assert.equal((await f.flow.run(sent[0])).status,'completed');assert.equal((await f.flow.run(sent[0])).duplicate,true);assert.equal(f.calls(),1);assert.equal((await f.store.get('settings/financial')).data.spent_cents,420);
});
test('uncertain outbox is retained and never resubmitted by a later click',async()=>{
 const f=unsubmittedFixture();let calls=0;const queue=retryQueue(f,async()=>{calls++;throw Error('Unknown Cloud Tasks response');}),retry=planner(f,queue),action={videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:dispatch:20261015'};
 assert.equal((await retry.request(action)).status,'uncertain');const outbox=await f.store.get(queue.dispatchPath({...action,authorizationRef:undefined,stage:'analysis',poll:0}));
 assert.equal(outbox.data.status,'uncertain');assert.equal((await retry.request({...action,recoveryId:'different_click_20261015'})).status,'duplicate');assert.equal(calls,1);assert.equal(f.calls(),0);
});
test('legacy retry_ready continues with the original request, while reservation, operation, attempts and pause stay protected',async()=>{
 const f=unsubmittedFixture(),claim=(await f.store.get(`jobs/${f.originalId}`)).data;f.seed(`jobs/${f.originalId}`,{...claim,status:'retry_ready',recovery_authorization_ref:'owner:original:20261014'});
 const sent=[],retry=planner(f,retryQueue(f,async(url,{json})=>sent.push(JSON.parse(Buffer.from(json.task.httpRequest.body,'base64')))));
 assert.equal((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:current:20261015'})).status,'queued');assert.equal(sent[0].recoveryId,f.recoveryId);assert.equal((await f.store.get(`jobs/${f.originalId}`)).data.recovery_authorization_ref,'owner:original:20261014');
 for(const kind of ['reservation','operation','attempts','pause','corrupt_identity']){
  const g=unsubmittedFixture(),job=(await g.store.get(`jobs/${g.originalId}`)).data,state=(await g.store.get('settings/financial')).data;
  if(kind==='reservation'){state.jobs[g.originalId]={...g.financial,status:'reserved'};state.reserved_cents=250;state.batch.active_video_ids=[g.videoId];}
  if(kind==='operation')job.operation_name='provider_operation';if(kind==='attempts')job.analysis_attempts=[{number:1,status:'uncertain'}];if(kind==='pause')state.paused=true;if(kind==='corrupt_identity')job.retry_recovery_id='invalid';
  g.seed(`jobs/${g.originalId}`,job);g.seed('settings/financial',state);const guarded=planner(g,{enqueue(){assert.fail('Unsafe unsubmitted work cannot dispatch');}});
  const result=await guarded.request({videoId:g.videoId,recoveryId:g.recoveryId,authorizationRef:'owner:guard:20261015'});assert.ok(['needs_reconciliation','paused'].includes(result.status));assert.equal(g.calls(),0);
 }
});

async function processLossSnapshot(boundary){
 const f=fixture('analysis');completeSources(f);
 const childId=settledRetryId(f.originalId),patch=f.store.patch.bind(f.store);let snapshot,submissions=0,restores=0;
 const saved=savedResult(f,childId);
 f.operations.analysis=async()=>{submissions++;if(boundary==='artifact_saved')snapshot=structuredClone(f.docs);return structuredClone(saved);};
 f.operations.restoreAnalysisResult=async({executionId:id})=>{assert.equal(id,childId);restores++;return structuredClone(saved);};
 f.store.patch=async(path,changes,options)=>{
  const out=await patch(path,changes,options);
  if(boundary==='video_saved'&&path===`videos/${f.videoId}`&&changes.analysis||boundary==='settlement_saved'&&path==='settings/financial'&&changes.jobs?.[childId]?.status==='completed')snapshot=structuredClone(f.docs);
  return out;
 };
 assert.equal((await f.flow.run(f.task)).status,'completed');assert.ok(snapshot);
 f.docs.clear();for(const [key,value]of snapshot)f.docs.set(key,value);
 const makeRetry=flow=>new SmartRetry({store:f.store,queue:{enqueue(){assert.fail('Persisted response cannot dispatch');}},quotes:f.quotes,batchId:f.batchId,flow,artifactInspector:async({executionId:id})=>id===childId?saved.artifact:null});
 const stoppedFlow=verifyExecutionStopped=>new WorkerFlow({store:f.store,ledger:f.ledger,operations:f.operations,quotes:f.quotes,batchId:f.batchId,analysisRevision:'megabrain-video-text-v4',clock:()=>f.now,verifyExecutionStopped});
 return {...f,childId,makeRetry,stoppedFlow,submissions:()=>submissions,restores:()=>restores};
}
const stoppedProof=info=>({ended:true,execution_id:info.executionId,claim_update_time:info.claimUpdateTime,evidence_ref:'operator:ended:20261015'});
for(const boundary of ['artifact_saved','video_saved','settlement_saved'])test(`process loss after ${boundary} requires stopped-worker evidence, then settles the saved child once while paused`,async()=>{
 const f=await processLossSnapshot(boundary),before=structuredClone(f.docs),retry=f.makeRetry(f.flow);
 assert.equal((await retry.inspect(f.videoId)).status,'reconcile_saved_result');
 assert.deepEqual(await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:hardstop:20261015'}),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);
 const parent=await f.store.get(`jobs/${f.originalId}`),state=(await f.store.get('settings/financial')).data,parentFinancial=structuredClone(state.jobs[f.originalId]);state.paused=true;state.batch.status='paused';f.seed('settings/financial',state);f.seed('settings/automation',{enabled:false});
 let verifications=0;const confirmed=f.makeRetry(f.stoppedFlow(async info=>{verifications++;assert.equal(info.executionId,f.childId);assert.equal(info.videoId,f.videoId);assert.equal(info.stage,'analysis');assert.equal(info.claimUpdateTime,(await f.store.get(`jobs/${f.childId}`)).updateTime);return stoppedProof(info);}));
 assert.equal((await confirmed.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:hardstop:20261015'})).status,'completed');
 const ledger=(await f.store.get('settings/financial')).data,claim=(await f.store.get(`jobs/${f.childId}`)).data;
 assert.equal(ledger.reserved_cents,0);assert.equal(ledger.spent_cents,670);assert.equal(ledger.jobs[f.childId].status,'completed');assert.equal(ledger.paused,true);assert.equal(ledger.batch.status,'paused');assert.equal(claim.status,'completed');assert.equal(claim.reconciliation_stop_proof.execution_id,f.childId);assert.equal(claim.reconciliation_stop_proof.evidence_ref,'operator:ended:20261015');assert.deepEqual(ledger.jobs[f.originalId],parentFinancial);assert.deepEqual(await f.store.get(`jobs/${f.originalId}`),parent);
 assert.equal((await confirmed.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:hardstop:20261015'})).status,'completed');assert.deepEqual((await f.store.get('settings/financial')).data,ledger);assert.equal(verifications,1);assert.equal(f.restores(),1);assert.equal(f.submissions(),1);
});
test('live, unconfirmed, stale, foreign or unavailable stopped-worker evidence never writes or restores',async()=>{
 const cases=[async()=>false,async()=>({ended:false}),async info=>({...stoppedProof(info),execution_id:'job_other'}),async info=>({...stoppedProof(info),claim_update_time:'stale'}),async info=>({...stoppedProof(info),evidence_ref:'bad'}),async()=>{throw Error('Evidence source unavailable');}];
 for(const verify of cases){
  const f=await processLossSnapshot('video_saved'),before=structuredClone(f.docs);
  const result=await f.makeRetry(f.stoppedFlow(verify)).request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:hardstop:20261015'});
  assert.deepEqual(result,{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(f.restores(),0);assert.equal(f.submissions(),1);
 }
});
test('claim change during stopped-worker verification fails its version fence before video or accounting changes',async()=>{
 const f=await processLossSnapshot('artifact_saved'),video=await f.store.get(`videos/${f.videoId}`),ledger=await f.store.get('settings/financial');
 const flow=f.stoppedFlow(async info=>{const claim=await f.store.get(`jobs/${f.childId}`);await f.store.patch(`jobs/${f.childId}`,{concurrent_observation:'changed'},{updateTime:claim.updateTime});return stoppedProof(info);});
 await assert.rejects(f.makeRetry(flow).request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:hardstop:20261015'}),error=>error.status===412);
 assert.deepEqual(await f.store.get(`videos/${f.videoId}`),video);assert.deepEqual(await f.store.get('settings/financial'),ledger);assert.equal((await f.store.get(`jobs/${f.childId}`)).data.status,'started');assert.equal(f.submissions(),1);
});
test('v0 normalizes missing/null competitor revision and blocks the same revision before restoration',async()=>{
 for(const explicitDefault of [false,true])for(const revision of [undefined,null]){
  const f=fixture('analysis'),id=executionId(f.videoId,'analysis'),state=(await f.store.get('settings/financial')).data,job={...f.financial};delete job.analysis_revision;delete state.jobs[f.originalId];state.jobs[id]=job;state.jobs.job_same_v0={...job,...(revision===undefined?{}:{analysis_revision:revision})};state.spent_cents+=250;f.seed('settings/financial',state);f.seed(`jobs/${id}`,{...f.claim});
  f.operations.restoreAnalysisResult=async()=>assert.fail('Same v0 revision must block');
  const flow=new WorkerFlow({store:f.store,ledger:f.ledger,operations:f.operations,quotes:f.quotes,batchId:f.batchId,...(explicitDefault?{analysisRevision:null}:{})}),before=structuredClone(f.docs);
  assert.deepEqual(await flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:v0:20261015'}),{status:'blocked',reason:'result_requires_reconciliation'});assert.deepEqual(f.docs,before);assert.equal(f.calls(),0);
 }
});
test('v0 without a same-revision competitor still reconciles its own saved result',async()=>{
 const f=fixture('analysis'),id=executionId(f.videoId,'analysis'),state=(await f.store.get('settings/financial')).data,job={...f.financial};delete job.analysis_revision;delete state.jobs[f.originalId];state.jobs[id]=job;f.seed('settings/financial',state);f.seed(`jobs/${id}`,{...f.claim});f.operations.restoreAnalysisResult=async()=>savedResult(f,id);
 const flow=new WorkerFlow({store:f.store,ledger:f.ledger,operations:f.operations,quotes:f.quotes,batchId:f.batchId});
 assert.equal((await flow.reconcileAnalysis({videoId:f.videoId,authorizationRef:'owner:v0:20261015'})).status,'completed');assert.equal((await f.store.get(`videos/${f.videoId}`)).data.analysis_key,savedResult(f,id).artifact.key);assert.equal(f.calls(),0);
});

for(const inspector of ['omitted','absent','present'])for(const withFlow of [false,true])test(`completed child remains completed with ${inspector} inspector and flow=${withFlow}`,async()=>{
 const f=await processLossSnapshot('video_saved');
 assert.equal((await f.makeRetry(f.stoppedFlow(stoppedProof)).request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:complete:20261015'})).status,'completed');
 const before=structuredClone(f.docs),restores=f.restores();
 const retry=new SmartRetry({store:f.store,queue:{enqueue(){assert.fail('Completed child cannot dispatch');}},quotes:f.quotes,batchId:f.batchId,...(withFlow?{flow:f.flow}:{}),...(inspector==='omitted'?{}:{artifactInspector:async()=>inspector==='absent'?null:savedResult(f,f.childId).artifact})});
 assert.deepEqual(await retry.inspect(f.videoId),{status:'completed'});
 assert.deepEqual(await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:complete:20261015'}),{status:'completed'});
 assert.deepEqual(f.docs,before);assert.equal(f.restores(),restores);assert.equal(f.submissions(),1);assert.equal((await f.store.get(`jobs/${f.originalId}`)).data.status,'uncertain');
});
test('accepted child with unfinished or mismatched recovery evidence never hides its pending parent',async()=>{
 const edits=[
  f=>f.docs.delete(`jobs/${f.originalId}`),
  f=>f.docs.get(`jobs/${f.originalId}`).data.status='started',
  f=>f.docs.get(`jobs/${f.originalId}`).data.video_id='Foreign',
  f=>f.docs.get(`jobs/${f.childId}`).data.status='started',
  f=>f.docs.get('settings/financial').data.jobs[f.childId].status='started',
  f=>f.docs.get(`jobs/${f.childId}`).data.recovery_of='job_foreign',
  f=>f.docs.get(`jobs/${f.childId}`).data.recovery_authorization='jobs/foreign',
  f=>f.docs.get(`jobs/${f.childId}`).data.settled_retry_count=2,
  f=>f.docs.get('settings/financial').data.jobs[f.childId].recovery_of='job_foreign',
  f=>f.docs.get('settings/financial').data.jobs[f.childId].recovery_kind='foreign',
  f=>f.docs.get('settings/financial').data.jobs[f.originalId].status='uncertain',
  f=>f.docs.get('settings/financial').data.jobs[f.originalId].actual_cents=0,
  f=>f.docs.get('settings/financial').data.jobs[f.childId].analysis_revision='foreign',
  f=>f.docs.get('settings/financial').data.jobs[f.childId].batch_id='foreign',
  f=>f.docs.get(`videos/${f.videoId}`).data.analysis_key=savedResult(f,f.originalId).artifact.key,
  f=>delete f.docs.get(`videos/${f.videoId}`).data.analysis_generation,
 ];
 for(const edit of edits){
  const f=await processLossSnapshot('video_saved');await f.makeRetry(f.stoppedFlow(stoppedProof)).request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:complete:20261015'});edit(f);const before=structuredClone(f.docs);
  const retry=new SmartRetry({store:f.store,queue:{enqueue(){assert.fail('Incomplete recovery cannot dispatch');}},quotes:f.quotes,batchId:f.batchId});
  assert.notEqual((await retry.inspect(f.videoId)).status,'completed');assert.notEqual((await retry.request({videoId:f.videoId,recoveryId:f.recoveryId,authorizationRef:'owner:complete:20261015'})).status,'completed');assert.deepEqual(f.docs,before);assert.equal(f.submissions(),1);
 }
});
