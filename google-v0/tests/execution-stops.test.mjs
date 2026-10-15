import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {SmartRetry,settledRetryId,settledRetryAuthorizationPath} from '../lib/smart-retry.mjs';
import {failureDigest} from '../lib/firestore-recovery.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const now=Date.now(),videoId='Stop_Reel',batchId='pilot_stop',revision='megabrain-video-text-v4',recoveryId='owner_retry_20261015',quotes={upload:50,transcription:120,analysis:250};
 const originalId=executionId(videoId,'analysis',revision),id=settledRetryId(originalId),docs=new Map();let version=0,calls=0,restores=0,settlements=0;
 const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){if(docs.get(path)?.updateTime!==updateTime)throw Object.assign(Error('Conflict'),{status:412});seed(path,{...docs.get(path).data,...changes});if(path==='settings/financial'&&changes.jobs?.[id]?.status==='completed')settlements++;return this.get(path);}};
 const diagnostic={operation_step:'submit_analysis',http_status:400,provider:{status:'INVALID_ARGUMENT',message:'response schemas specified other fields alongside any_of'}};
 seed(`jobs/${originalId}`,{video_id:videoId,stage:'analysis',status:'uncertain',failure_diagnostic:diagnostic,analysis_attempts:[{number:1,status:'uncertain'}]});
 seed(`videos/${videoId}`,{id:videoId,status:'needs_attention',error:'Original failure',media_verified:true,audio_status:'present',video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'1',transcript:'Existing transcript',transcript_key:`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`,transcript_generation:'2'});
 seed(settledRetryAuthorizationPath(originalId),{schema_version:1,status:'authorized',kind:'confirmed_schema_rejection',original_execution_id:originalId,video_id:videoId,stage:'analysis',maximum_cents:250,recovery_id:recoveryId,failure_digest:failureDigest(diagnostic),authorization_ref:'owner:test:20261015',authorized_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString()});
 seed('settings/automation',{enabled:true,analysis_enabled:true,transcription_enabled:true,parallelism:4});
 seed('settings/financial',{...newLedger(),paused:false,allocation_cents:150000,coverage_verified:true,ongoing_commitment_cents:9400,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:170140,balance_observed_at:new Date(now).toISOString(),balance_max_age_seconds:86400,credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true},spent_cents:250,reserved_cents:0,jobs:{[originalId]:{video_id:videoId,stage:'analysis',status:'completed',maximum_cents:250,actual_cents:250,batch_id:batchId,analysis_revision:revision,manual_reconciliation:'confirmed_schema400_full_estimate_accounted_analysis_pending'}},batch:{schema_version:1,id:batchId,status:'active',budget_cents:120000,overhead_cents:2400,parallelism:4,video_ids:[videoId,...Array.from({length:261},(_,i)=>`Reel_${i+2}`)],active_video_ids:[]}});
 const sourceState=docs.get('settings/financial').data;
 for(const stage of ['upload','transcription']){const sourceId=executionId(videoId,stage),cost=quotes[stage];seed(`jobs/${sourceId}`,{video_id:videoId,stage,status:'completed'});sourceState.jobs[sourceId]={video_id:videoId,stage,status:'completed',maximum_cents:cost,actual_cents:cost,batch_id:batchId};sourceState.spent_cents+=cost;}
 seed('settings/financial',sourceState);
 const saved={video_id:videoId,stage:'analysis',actual_cents:250,artifact:{key:`results/instagram/${videoId}/${id}/analysis.json`,generation:'4'},changes:{analysis:{title:'Existing saved response'},analysis_key:`results/instagram/${videoId}/${id}/analysis.json`,analysis_generation:'4',analysis_quality_status:'accepted'}};
 // Exercise the actual runtime wiring. Only its I/O and provider operations are
 // replaced; the real producer, verifier, flow and financial ledger remain.
 const flow=workerRuntime({project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',analysis_revision:revision,batch_id:batchId,pilot_video_ids:[videoId],quotes},{version:revision});
 Object.assign(flow.store,store);flow.ledger=new FinancialLedger(flow.store,{clock:()=>now});
 const operations={async prepareSettledAnalysisRetry(){},async analysis(){calls++;return structuredClone(saved);},async restoreAnalysisResult({executionId}){assert.equal(executionId,id);restores++;return structuredClone(saved);}};
 flow.operations=operations;
 const retry=new SmartRetry({store:flow.store,queue:{enqueue(){assert.fail('Saved response cannot dispatch');}},quotes,batchId,flow,artifactInspector:async()=>saved.artifact});
 const task={videoId,stage:'analysis',recoverSettled:true,recoveryId},action={videoId,recoveryId,authorizationRef:'owner:reconcile:20261015'};
 return {docs,seed,store:flow.store,flow,operations,retry,task,action,videoId,originalId,id,saved,revision,resetSettlements:n=>{settlements=n;},stats:()=>({calls,restores,settlements})};
}
const proofEntry=f=>[...f.docs].find(([path])=>path.startsWith('execution_stops/'));
async function exitedAt(boundary,{failProof=false}={}){
 const f=fixture(),patch=f.store.patch.bind(f.store);let snapshot;
 f.operations.analysis=async()=>{if(boundary==='artifact_saved')snapshot=structuredClone(f.docs);return structuredClone(f.saved);};
 if(failProof){const create=f.store.create.bind(f.store);f.store.create=(path,data)=>path.startsWith('execution_stops/')?Promise.reject(Error('Evidence unavailable')):create(path,data);}
 const runOperation=f.operations.analysis;f.operations.analysis=async input=>{f.submissions=(f.submissions??0)+1;return runOperation(input);};
 f.store.patch=async(path,changes,options)=>{
  if(path===`jobs/${f.id}`&&['uncertain','completed'].includes(changes.status))throw Error('Claim write unavailable after result');
  if(boundary==='video_saved'&&path==='settings/financial'&&changes.jobs?.[f.id]?.status==='completed')throw Error('Settlement write unavailable');
  const result=await patch(path,changes,options);
  if(boundary==='video_saved'&&path===`videos/${f.videoId}`&&changes.analysis||boundary==='settlement_saved'&&path==='settings/financial'&&changes.jobs?.[f.id]?.status==='completed')snapshot=structuredClone(f.docs);
  return result;
 };
 await assert.rejects(f.flow.run(f.task));assert.ok(snapshot);const proof=proofEntry(f);if(failProof)assert.equal(proof,undefined);else assert.ok(proof);
 // A captured pre-finally image models abrupt loss: it contains no end proof.
 f.docs.clear();for(const [path,value]of snapshot)f.docs.set(path,value);
 f.store.patch=patch;f.resetSettlements(boundary==='settlement_saved'?1:0);
 return {...f,proof};
}
function pause(f){const state=structuredClone(f.docs.get('settings/financial').data);state.paused=true;state.batch.status='paused';f.seed('settings/financial',state);f.seed('settings/automation',{enabled:false});}

test('real runtime withholds proof until analysis and its awaited cleanup have exited',async()=>{
 const f=fixture(),entered=deferred(),cleanup=deferred();f.operations.analysis=async()=>{entered.resolve();await cleanup.promise;return structuredClone(f.saved);};
 const run=f.flow.run({...f.task,attemptId:'client-forgery',ended:true,evidence_ref:'client:fake'});await entered.promise;
 const claim=await f.store.get(`jobs/${f.id}`);assert.match(claim.data.execution_attempt_id,/^[a-f0-9-]{36}$/);assert.notEqual(claim.data.execution_attempt_id,'client-forgery');
 const before=structuredClone(f.docs);assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(proofEntry(f),undefined);
 cleanup.resolve();assert.equal((await run).status,'completed');assert.ok(proofEntry(f));assert.equal(f.stats().restores,0);
});

test('tracked uncertain claim is still blocked while error cleanup is running',async()=>{
 const f=fixture(),entered=deferred(),cleanup=deferred(),patch=f.store.patch.bind(f.store);
 f.operations.analysis=async()=>{throw Error('Handled provider failure');};
 f.store.patch=async(path,changes,options)=>{const out=await patch(path,changes,options);if(path===`jobs/${f.id}`&&changes.status==='uncertain'){entered.resolve();await cleanup.promise;}return out;};
 const run=f.flow.run(f.task);await entered.promise;const before=structuredClone(f.docs);
 assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(f.stats().restores,0);
 cleanup.resolve();assert.equal((await run).status,'uncertain');assert.ok(proofEntry(f));
});

for(const boundary of ['artifact_saved','video_saved','settlement_saved'])test(`real ended proof recovers ${boundary} once; abrupt loss without proof stays blocked`,async()=>{
 const f=await exitedAt(boundary);pause(f);const before=structuredClone(f.docs),parent=await f.store.get(`jobs/${f.originalId}`),parentFinancial=structuredClone((await f.store.get('settings/financial')).data.jobs[f.originalId]);
 assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);
 // Only evidence actually produced by the exited server attempt is restored.
 f.docs.set(...f.proof);
 assert.equal((await f.retry.request(f.action)).status,'completed');
 const state=(await f.store.get('settings/financial')).data,claim=(await f.store.get(`jobs/${f.id}`)).data;
 assert.equal(state.spent_cents,670);assert.equal(state.reserved_cents,0);assert.equal(state.paused,true);assert.equal(state.batch.status,'paused');assert.deepEqual(state.jobs[f.originalId],parentFinancial);assert.deepEqual(await f.store.get(`jobs/${f.originalId}`),parent);assert.equal(claim.status,'completed');assert.equal(claim.reconciliation_stop_proof.evidence_ref,f.proof[0]);
 assert.equal((await f.retry.request({...f.action,recoveryId:'another_click_20261015'})).status,'completed');assert.equal(f.submissions,1);assert.equal(f.stats().restores,1);assert.equal(f.stats().settlements,1);
 f.flow.operations={};f.retry.artifactInspector=undefined;assert.equal((await f.retry.request(f.action)).status,'completed');
});

for(const defect of ['absent','foreign_video','foreign_execution','foreign_attempt','foreign_revision','stale_version','malformed','numeric_date','ended_false','schema','unavailable','changed_claim'])test(`real verifier fails closed for ${defect} evidence`,async()=>{
 const f=await exitedAt('artifact_saved');f.docs.set(...f.proof);
 const proof=f.docs.get(f.proof[0]);
 if(defect==='absent')f.docs.delete(f.proof[0]);
 if(defect==='foreign_video')proof.data.video_id='Other_Reel';
 if(defect==='foreign_execution')proof.data.execution_id=executionId('Other_Reel','analysis',f.revision);
 if(defect==='foreign_attempt')proof.data.attempt_id=randomUUID();
 if(defect==='foreign_revision')proof.data.analysis_revision='megabrain-video-text-v3';
 if(defect==='stale_version')proof.data.claim_update_time='old';
 if(defect==='malformed')proof.data.ended_at='not-a-date';
 if(defect==='numeric_date')proof.data.ended_at=0;
 if(defect==='ended_false')proof.data.ended=false;
 if(defect==='schema')proof.data.schema_version=2;
 if(defect==='changed_claim'){const j=await f.store.get(`jobs/${f.id}`);await f.store.patch(`jobs/${f.id}`,{execution_attempt_id:randomUUID()},{updateTime:j.updateTime});}
 if(defect==='unavailable'){const get=f.store.get.bind(f.store);f.store.get=path=>path.startsWith('execution_stops/')?Promise.reject(Error('Unavailable')):get(path);}
 const before=structuredClone(f.docs);assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(f.stats().restores,0);
});

test('claim change during artifact restoration is rejected before video or accounting changes',async()=>{
 const f=await exitedAt('artifact_saved');f.docs.set(...f.proof);const video=await f.store.get(`videos/${f.videoId}`),financial=await f.store.get('settings/financial');
 f.operations.restoreAnalysisResult=async()=>{const j=await f.store.get(`jobs/${f.id}`);await f.store.patch(`jobs/${f.id}`,{observation:'changed'},{updateTime:j.updateTime});return structuredClone(f.saved);};
 await assert.rejects(f.retry.request(f.action),e=>e.status===412);assert.deepEqual(await f.store.get(`videos/${f.videoId}`),video);assert.deepEqual(await f.store.get('settings/financial'),financial);
});

test('concurrent recovery requests converge through CAS without duplicate settlement or inference',async()=>{
 const f=await exitedAt('artifact_saved');f.docs.set(...f.proof);
 const results=await Promise.allSettled([f.retry.request(f.action),f.retry.request(f.action)]);
 assert.ok(results.some(x=>x.status==='fulfilled'&&x.value.status==='completed'));assert.ok(results.every(x=>x.status==='fulfilled'||x.reason.status===412));
 assert.equal((await f.retry.request(f.action)).status,'completed');assert.equal(f.stats().settlements,1);assert.equal(f.submissions,1);
});

test('missing legacy attempt identity and unavailable end-record writes cannot manufacture proof',async()=>{
 const f=await exitedAt('artifact_saved');const claim=(await f.store.get(`jobs/${f.id}`)).data;delete claim.execution_attempt_id;f.seed(`jobs/${f.id}`,claim);
 const stops=new ExecutionStops({store:f.store,analysisRevision:f.revision});assert.equal(await stops.record({executionId:f.id,videoId:f.videoId,stage:'analysis',attemptId:randomUUID()}),false);
 const before=structuredClone(f.docs);assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);
 const g=fixture(),create=g.store.create.bind(g.store);g.store.create=(path,data)=>path.startsWith('execution_stops/')?Promise.reject(Error('Evidence write unavailable')):create(path,data);
 assert.equal((await g.flow.run(g.task)).status,'completed');assert.equal(proofEntry(g),undefined);assert.equal((await g.retry.request(g.action)).status,'completed');
});

test('rejected candidates are retained and never overwrite an earlier published analysis',async()=>{
 const f=fixture();const published={title:'Previously accepted'};const v=(await f.store.get(`videos/${f.videoId}`)).data;
 // Exercise a regular original attempt, independently of paid-retry eligibility.
 f.docs.delete(`jobs/${f.originalId}`);const state=(await f.store.get('settings/financial')).data;state.jobs={};state.spent_cents=0;f.seed('settings/financial',state);
 f.seed(`videos/${f.videoId}`,{...v,analysis:published,analysis_key:'results/prior.json',analysis_generation:'8'});
 f.operations.analysis=async({executionId:id})=>({video_id:f.videoId,stage:'analysis',actual_cents:250,changes:{analysis:published,analysis_key:'results/prior.json',analysis_generation:'8',analysis_quality_status:'review_required',analysis_review_reasons:['invalid_categories'],analysis_candidate:{title:'Candidate'},candidate_analysis_key:`results/instagram/${f.videoId}/${id}/analysis.json`,candidate_analysis_generation:'9'}});
 assert.equal((await f.flow.run({videoId:f.videoId,stage:'analysis'})).status,'completed');const result=(await f.store.get(`videos/${f.videoId}`)).data;
 assert.deepEqual(result.analysis,published);assert.equal(result.analysis_generation,'8');assert.equal(result.candidate_analysis_generation,'9');assert.equal(result.status,'needs_attention');assert.ok(proofEntry(f));
});


test('failure to persist end proof leaves a started response blocked without hiding the original error',async()=>{
 const f=await exitedAt('artifact_saved',{failProof:true}),before=structuredClone(f.docs);
 assert.equal((await f.store.get(`jobs/${f.id}`)).data.status,'started');assert.equal(proofEntry(f),undefined);
 assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(f.stats().restores,0);
});

test('an existing server proof is immutable and old evidence cannot attest another attempt',async()=>{
 const f=await exitedAt('artifact_saved');f.docs.set(...f.proof);const stops=new ExecutionStops({store:f.store,analysisRevision:f.revision}),j=await f.store.get(`jobs/${f.id}`),before=structuredClone(f.docs);
 assert.equal(await stops.record({executionId:f.id,videoId:f.videoId,stage:'analysis',attemptId:j.data.execution_attempt_id}),false);assert.deepEqual(f.docs,before);
 assert.equal(await stops.record({executionId:f.id,videoId:f.videoId,stage:'analysis',attemptId:randomUUID()}),false);assert.deepEqual(f.docs,before);
});


test('runtime never treats an untracked legacy uncertain record as positive end evidence',async()=>{
 const f=await exitedAt('artifact_saved'),claim=(await f.store.get(`jobs/${f.id}`)).data;
 delete claim.execution_attempt_id;delete claim.analysis_revision;claim.status='uncertain';f.seed(`jobs/${f.id}`,claim);
 const before=structuredClone(f.docs);assert.deepEqual(await f.retry.request(f.action),{status:'blocked',reason:'execution_stop_unconfirmed'});assert.deepEqual(f.docs,before);assert.equal(f.stats().restores,0);
});
