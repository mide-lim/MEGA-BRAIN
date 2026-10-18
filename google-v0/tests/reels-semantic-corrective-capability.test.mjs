import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeFields} from '../lib/firestore.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {semanticHash,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {GoogleREST} from '../lib/google-rest.mjs';
import {ReelsSemanticProvider,semanticPromptHash,semanticWireSchemaVersion,semanticSchemaForPhase} from '../lib/reels-semantic-provider.mjs';
import {semanticUnknownProvider} from './reels-semantic-fixture.mjs';
import {rejectedSemanticRecoveryScope as S,rejectedSemanticRecoveryPath,rejectedSemanticRecoveryReviewScope,prepareRejectedSemanticAttemptRecovery} from '../lib/reels-semantic-rejected-attempt-recovery.mjs';
import {prepareSemanticCorrectiveCapability,validateSemanticCorrectiveCapability,semanticCorrectiveCapabilityPath} from '../lib/reels-semantic-corrective-capability.mjs';
const clone=v=>structuredClone(v),eq=(a,b)=>assert.equal(semanticHash(a),semanticHash(b));
const envs=['SEMANTIC_HISTORICAL_RECOVERY_RECEIPT','SEMANTIC_HISTORICAL_RECOVERY_SOURCE','SEMANTIC_REJECTED_RECOVERY_INPUT'];
const missing=!envs.every(k=>process.env[k]);
test('prepared-only objects and arbitrary browser-like approval never create a capability',()=>{
 assert.throws(()=>prepareSemanticCorrectiveCapability({}),{code:'SEMANTIC_CORRECTIVE_CAPABILITY_INVALID'});
 assert.equal(validateSemanticCorrectiveCapability({capability:{kind:'semantic_corrective_capability'},receipt:{executionAuthorized:false}}),null);
 assert.match(semanticCorrectiveCapabilityPath({jobId:'synthetic',receiptHash:'f'.repeat(64)}),/^reels_index\/semantic_corrective_capability_[a-f0-9]{64}$/);
});
async function setup(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REPOSITORY,'mide-lim/MEGA-BRAIN');
 const [history,input,paid]=await Promise.all(envs.map(async k=>JSON.parse(await readFile(process.env[k],'utf8'))));
 assert.equal(input.observation.readOnly,true);assert.equal(paid.providerCalls,0);assert.equal(paid.writes,0);assert.equal(input.sourceObservationSHA256,paid.sourceObservationSHA256);
 const store=memoryReelsStore();for(const row of input.observation.records)store.docs.set(row.path,{data:clone(row.data),updateTime:row.updateTime});
 const taxonomy=input.observation.taxonomy;store.docs.set('settings/reels_v2_taxonomy',{data:clone(taxonomy.data??taxonomy),updateTime:taxonomy.updateTime??'historical-ci-taxonomy'});
 const records=paid.records.map(r=>({path:r.path,data:decodeFields(r.document.fields),updateTime:r.document.updateTime}));
 for(const r of records)store.docs.set(r.path,{data:clone(r.data),updateTime:r.updateTime});
 const original=records.find(r=>r.data.kind==='semantic_job'),first=records.find(r=>r.data.kind==='semantic_result'),ledger=records.find(r=>r.data.kind==='semantic_authorization');
 assert.equal(original.data.id,S.jobId);assert.equal(first.data.id,S.firstBatchId);assert.ok(ledger);
 const now=new Date(Date.parse(S.jobUpdateTime)+275000).toISOString(),epoch=new Date(Date.parse(now)-1000).toISOString(),time={value:Date.parse(now)},deliveries=[],provider=semanticUnknownProvider();
 const firstIds=new Set(original.data.pins.slice(0,8).map(p=>p.id)),infer=provider.infer;
 provider.infer=async value=>{assert.equal(value.sources.some(s=>firstIds.has(s.id)),false,'the first saved batch must never be extracted again');return infer(value);};
 const repository=new ReelsRepository({store,cacheTtlMs:0}),curator=new ReelsSemanticCurator({repository,provider,clock:()=>time.value,enqueue:async j=>{deliveries.push(clone(j));return {status:'sent'};}});
 const sources=[];for(const id of S.sourceIds)sources.push(semanticSourceFromSaved(await curator.catalogue.loadSource(id)));
 const metadata=s=>({id:s.id,sourceProjectionVersion:s.sourceProjectionVersion,semanticProofHash:s.semanticProofHash,sourceVersions:s.sourceVersions,editorialHash:s.editorialHash});
 const pins=sources.map(metadata),binding={jobId:S.jobId,phase:'extract',cursor:8,pins,catalogueHash:S.catalogueHash,policyHash:S.policyHash,promptHash:S.oldPromptHash,promptTransitionHash:S.promptTransitionHash};
 assert.equal(semanticHash(binding),S.oldBindingHash,'same immutable historical fields and versions');
 const old={...clone(original.data),status:'uncertain',reason:'PAID_SUBMISSION_OR_PERSISTENCE_UNCERTAIN',phase:'extract',cursor:8,callsUsed:2,dispatch:{sequence:1,status:'pending',outboxId:S.oldOutboxId,reason:null},batch:{id:S.oldBatchId,status:'submitting',phase:'extract',offset:8,sourceIds:clone(S.sourceIds),bindingHash:S.oldBindingHash,binding,groupVersions:[],leaseOwner:'synthetic-expired-lease',leaseUntil:new Date(Date.parse(now)-1000).toISOString(),startedAt:S.jobUpdateTime}};
 const jobPath=original.path,firstResult={path:first.path,data:{...clone(first.data),processed:true},updateTime:first.updateTime};
 store.docs.set(jobPath,{data:clone(old),updateTime:S.jobUpdateTime});store.docs.set(first.path,{data:clone(firstResult.data),updateTime:firstResult.updateTime});
 const policyPath='settings/reels_v2_semantic_policy';store.docs.set(policyPath,{data:clone(old.policy),updateTime:epoch});
 const coordinator={path:'reels_index/semantic_coordinator',data:{kind:'semantic_coordinator',jobId:S.jobId,authorizationId:old.policy.authorizationId,cohortHash:old.cohortHash,createdAt:epoch},updateTime:epoch};store.docs.set(coordinator.path,{data:clone(coordinator.data),updateTime:epoch});
 const historySnapshot={path:'reels_index/semantic_source_recovery_'+S.firstBatchId,data:history,updateTime:epoch};store.docs.set(historySnapshot.path,{data:clone(history),updateTime:epoch});
 const snapshot=(path,data,updateTime=epoch)=>({path,data:clone(data),updateTime,readTime:now}),absence=path=>({path,exists:false,updateTime:null,readTime:now});
 const schema=semanticSchemaForPhase('extract',{sources:S.sourceIds.map(id=>({id})),catalogue:{groups:[]}});
 const preparationInput={now,job:snapshot(jobPath,old,S.jobUpdateTime),policy:snapshot(policyPath,old.policy),authorization:snapshot(ledger.path,ledger.data,ledger.updateTime),firstResult:{...firstResult,readTime:now},editorial:{path:'settings/reels_v2_taxonomy',...await store.get('settings/reels_v2_taxonomy'),readTime:now},sources:pins.map(p=>({...p,readTime:now})),resultAbsence:absence('reels_index/semantic_result_'+S.oldBatchId),rawAbsence:{query:{collection:'reels_index',filters:[{field:'kind',op:'eq',value:'semantic_raw'},{field:'batchId',op:'eq',value:S.oldBatchId}],records:[],complete:true,readTime:now},documents:Array.from({length:12},(_,i)=>absence('reels_index/semantic_raw_'+S.oldBatchId+'_'+i))},recoveryAbsence:absence(rejectedSemanticRecoveryPath()),queue:{name:S.queueName,state:'PAUSED',readTime:now},newContract:{wireVersion:semanticWireSchemaVersion,promptHash:semanticPromptHash,schemaHash:semanticHash(schema),schema,sourceCommit:process.env.GITHUB_SHA},evidence:{references:clone(S.evidence),correlation:clone(S.correlation)}};
 const scopeHash=rejectedSemanticRecoveryReviewScope(preparationInput);
 preparationInput.review={path:'native-review/synthetic-finite-corrective.json',sha256:semanticHash('synthetic independent artifact'),data:{kind:'native_independent_review',executor:'codex-native',role:'Revisor',actorId:'/root/synthetic_independent_reviewer',accepted:true,scopeHash,reviewedAt:now,assignment:'exact_http400_recovery_preparation_only',limits:{circumstantialAggregateOnly:true,noRequestId:true,noBody:true,billingNotEstablished:true,schemaCauseNotEstablished:true,noUniversalAbsenceClaim:true}}};
 const trustedReview={path:preparationInput.review.path,sha256:preparationInput.review.sha256,dataHash:semanticHash(preparationInput.review.data),scopeHash,actorId:preparationInput.review.data.actorId};
 const prepared=prepareRejectedSemanticAttemptRecovery(preparationInput,{trustedReview});assert.equal(prepared.report.ready,true,JSON.stringify(prepared.report.errors));
 const historicalRawChunks=first.data.rawChunks.map(path=>({path,...store.docs.get(path)})),approval={kind:'explicit_owner_finite_authorization',approvalId:'synthetic-owner-finite-correction',packageHash:semanticHash('synthetic reviewed package'),sourceCommit:process.env.GITHUB_SHA,actorId:'ci-synthetic-owner',approvedAt:now,expiresAt:new Date(Math.min(Date.parse(now)+1800000,Date.parse(old.policy.expiresAt))).toISOString(),humanAuthorizationRef:'synthetic central-CI operator approval; no live operation'};
 const factoryInput={receipt:prepared.receipt,preparationInput,trustedReview,historicalRecovery:historySnapshot,historicalRawChunks,coordinator,approval,now};
 const plan=prepareSemanticCorrectiveCapability(factoryInput);
 const immutable=()=>semanticHash({source:[...store.docs].filter(([p])=>p.startsWith('videos/')||p.startsWith('reels_legacy_content/')),ledger:store.docs.get(ledger.path),first:store.docs.get(first.path),raw:first.data.rawChunks.map(p=>store.docs.get(p)),history:store.docs.get(historySnapshot.path)});
 const before=immutable();
 async function apply(){const result=await store.commitSemantic({checks:plan.checks,writes:plan.writes});assert.equal(result.applied,true);}
 const delivery=()=>({jobId:S.jobId,sequence:2,outboxId:plan.preparedJob.dispatch.outboxId,maxBatches:3});
 return {store,curator,provider,deliveries,old,jobPath,firstResult,ledger,historySnapshot,coordinator,plan,factoryInput,preparationInput,time,now,immutable,before,apply,delivery};
}
test('sealed historical simulation: owner capability consumes atomically once and stops at exact corrective checkpoint',{skip:missing?'private historical artifacts supplied only by central GitHub Actions':false},async t=>{
 const s=await setup();assert.equal(s.plan.executable,false);assert.equal(s.plan.executionAuthorized,false);assert.equal(s.plan.writes.length,3);assert.equal(s.plan.oldJobSnapshot.data.callsUsed,2);
 eq(s.plan.oldJobSnapshot.data,s.old);assert.equal(s.plan.preparedJob.promptHash,s.old.promptHash);assert.equal(s.plan.preparedJob.callsUsed,2);assert.equal(s.plan.preparedJob.batch,null);
 assert.notEqual(s.plan.capability.authorization.nextAttempt.attemptId,S.oldBatchId);
 await s.apply();
 const initialCalls=s.provider.calls.length;
 await s.curator.runDelivery({jobId:S.jobId,sequence:1,outboxId:S.oldOutboxId,maxBatches:3});
 assert.equal(s.provider.calls.length,initialCalls);assert.equal(s.deliveries.length,0);
 await s.curator.runDelivery(s.delivery());
 const job=(await s.store.get(s.jobPath)).data,cap=(await s.store.get(s.plan.path)).data,second=await s.store.get('reels_index/semantic_result_'+s.plan.capability.authorization.nextAttempt.attemptId);
 assert.equal(job.status,'paused');assert.equal(job.reason,'SEMANTIC_REJECTED_ATTEMPT_CHECKPOINT');assert.equal(job.cursor,16);assert.equal(job.callsUsed,3);assert.equal(job.batch,null);assert.equal(s.provider.calls.length,1);assert.equal(s.provider.calls[0].phase,'extract');assert.equal(s.deliveries.length,0);
 assert.equal(cap.state,'consumed');assert.equal(cap.consumption.callsUsed,3);assert.equal(job.correctiveRecovery.consumptionHash,semanticHash(cap.consumption));
 assert.equal(second.data.processed,true);assert.equal(second.data.binding.promptHash,semanticPromptHash);assert.equal(second.data.binding.cursor,8);assert.equal(second.data.id,job.alignmentCheckpoint.resultId);assert.equal(await s.store.get('reels_index/semantic_result_'+S.oldBatchId),null);
 assert.equal(s.immutable(),s.before);
 const view=await s.curator.overview();assert.equal(view.jobs.find(j=>j.id===S.jobId).canContinueAlignmentCheckpoint,true);
 await s.curator.runDelivery(s.delivery());assert.equal(s.provider.calls.length,1);assert.equal(s.deliveries.length,0);
 const key='synthetic-release-corrective-checkpoint';
 await s.curator.command({action:'advance',jobId:S.jobId,idempotencyKey:key});assert.equal(s.provider.calls.length,1);assert.equal(s.deliveries.length,1);
 await s.curator.command({action:'advance',jobId:S.jobId,idempotencyKey:key});assert.equal(s.provider.calls.length,1);assert.equal(s.deliveries.length,1);assert.equal((await s.store.get(s.jobPath)).data.alignmentCheckpoint.status,'released');
 assert.equal((await s.store.get(s.jobPath)).data.promptHash,s.old.promptHash);assert.equal(s.immutable(),s.before);
 console.log(JSON.stringify({kind:'finite_corrective_runtime_simulation',historicalInputsOnly:true,actualGoogleObservations:false,oldCounter:2,newCounter:3,checkpointCursor:16,syntheticInferenceCalls:1,realProviderCalls:0,oldRawBindingLedgerAndSourcesUnchanged:true,oldDeliveryIgnored:true}));
});
test('corrective startup gates and competing intents fail closed without provider replay',{skip:missing},async t=>{
 for(const [name,change]of Object.entries({
  expired:s=>{s.time.value=Date.parse(s.plan.receiptData.validUntil);},
  badCapability:s=>{s.store.docs.get(s.plan.path).data.authorizationHash=semanticHash('forged');},
  preparedReceiptOnly:s=>{s.store.docs.delete(s.plan.path);},
  counterChanged:s=>{s.store.docs.get(s.jobPath).data.callsUsed=1;},
  sourceChanged:s=>{const p='videos/'+S.sourceIds[0],r=s.store.docs.get(p);r.updateTime=new Date(Date.parse(r.updateTime)+1).toISOString();},
  oldResultAppears:s=>{s.store.docs.set('reels_index/semantic_result_'+S.oldBatchId,{data:{kind:'semantic_result'},updateTime:s.now});},
  oldRawAppears:s=>{s.store.docs.set('reels_index/semantic_raw_'+S.oldBatchId+'_11',{data:{kind:'semantic_raw'},updateTime:s.now});},
  ledgerChanged:s=>{s.store.docs.get(s.ledger.path).data.maximumCalls=128;},
  policyChanged:s=>{s.store.docs.get('settings/reels_v2_semantic_policy').data.maxCalls=128;},
  approvalExpired:s=>{s.time.value=Date.parse(s.plan.capability.authorization.approval.expiresAt);}
 })){await t.test(name,async()=>{const s=await setup();await s.apply();change(s);await s.curator.runDelivery(s.delivery());assert.equal(s.provider.calls.length,0);const j=(await s.store.get(s.jobPath)).data;assert.notEqual(j.status,'running');assert.equal((await s.store.get(s.plan.path))?.data.state??'missing',name==='preparedReceiptOnly'?'missing':'available');});}
 await t.test('unused extra source and snapshot transport fields are not persisted',async()=>{const s=await setup(),value=clone(s.factoryInput),marker='synthetic-unused-secret';value.preparationInput.sources[0].unexpectedText=marker;value.preparationInput.job.unexpectedText=marker;value.preparationInput.newContract.unexpectedText=marker;value.preparationInput.rawAbsence.query.unexpectedText=marker;value.preparationInput.evidence.unexpectedText=marker;value.preparationInput.review.unexpectedText=marker;const plan=prepareSemanticCorrectiveCapability(value);assert.equal(JSON.stringify(plan).includes(marker),false);eq(plan.capability,s.plan.capability);});
 await t.test('consumed capability at cursor8 cannot authorize a regular replacement intent',async()=>{const s=await setup();await s.apply();await s.curator.runDelivery(s.delivery());const j=s.store.docs.get(s.jobPath);j.data={...j.data,status:'prepared',phase:'extract',cursor:8,batch:null,alignmentCheckpoint:undefined};const count=s.provider.calls.length,current=j.data.dispatch;await s.curator.runDelivery({jobId:S.jobId,sequence:current.sequence,outboxId:current.outboxId,maxBatches:3});assert.equal(s.provider.calls.length,count);assert.equal((await s.store.get(s.jobPath)).data.callsUsed,3);assert.equal((await s.store.get(s.jobPath)).data.reason,'SEMANTIC_CORRECTIVE_CAPABILITY_INVALID');assert.equal(await s.store.get('reels_index/semantic_result_'+S.oldBatchId),null);});
 await t.test('two deliveries race for the same available capability',async()=>{const s=await setup();await s.apply();await Promise.allSettled([s.curator.runDelivery(s.delivery()),s.curator.runDelivery(s.delivery())]);assert.equal(s.provider.calls.length,1);assert.equal((await s.store.get(s.jobPath)).data.callsUsed,3);assert.equal((await s.store.get(s.plan.path)).data.state,'consumed');});
 await t.test('real adapter HTTP400 is retained on the new attempt without replay or counter rollback',async()=>{const s=await setup();await s.apply();let requests=0;const api=new GoogleREST({project:'megabrain-v0-1017370021431',tokenProvider:async()=>'synthetic-private-token',fetchImpl:async()=>{requests++;return Response.json({error:{status:'INVALID_ARGUMENT',message:'synthetic private source marker'}},{status:400});}});s.curator.provider=new ReelsSemanticProvider({api});await s.curator.runDelivery(s.delivery());const j=(await s.store.get(s.jobPath)).data,attempt=await s.store.get('reels_index/semantic_attempt_'+s.plan.capability.authorization.nextAttempt.attemptId);assert.equal(requests,1);assert.equal(j.status,'uncertain');assert.equal(j.callsUsed,3);assert.equal(attempt.data.diagnostic.httpStatus,400);assert.equal(attempt.data.diagnostic.retryAllowed,false);assert.equal(JSON.stringify(attempt.data).includes('synthetic private source marker'),false);assert.equal(await s.store.get('reels_index/semantic_result_'+attempt.data.id),null);await s.curator.runDelivery(s.delivery());assert.equal(requests,1);assert.equal(s.immutable(),s.before);});
 await t.test('five-minute startup TTL is not extended but consumed future calls use the sealed approval expiry and remaining cap',async()=>{const s=await setup();await s.apply();await s.curator.runDelivery(s.delivery());await s.curator.command({action:'advance',jobId:S.jobId,idempotencyKey:'synthetic-future-approval-release'});s.deliveries.length=0;s.time.value=Date.parse(s.plan.receiptData.validUntil)+1000;let j=(await s.store.get(s.jobPath)).data;await s.curator.runDelivery({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches:1});j=(await s.store.get(s.jobPath)).data;assert.equal(j.cursor,24);assert.equal(j.callsUsed,4);assert.equal(s.provider.calls.length,2);const record=s.store.docs.get(s.jobPath);record.data={...record.data,status:'prepared',callsUsed:127};await s.curator.runDelivery({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches:3});assert.equal(s.provider.calls.length,2);assert.equal((await s.store.get(s.jobPath)).data.callsUsed,127);assert.equal((await s.store.get(s.jobPath)).data.reason,'FINITE_CALL_BUDGET_EXHAUSTED');});
 await t.test('paid transport error consumes exactly one intent and never repeats',async()=>{const s=await setup();await s.apply();let calls=0;s.curator.provider={infer:async()=>{calls++;throw Object.assign(Error('synthetic acknowledgement loss'),{api_service:'vertex',request_stage:'fetch',dispatch_attempted:true});}};await s.curator.runDelivery(s.delivery());assert.equal(calls,1);let j=(await s.store.get(s.jobPath)).data;assert.equal(j.status,'uncertain');assert.equal(j.callsUsed,3);assert.equal(j.cursor,8);s.time.value+=300000;await s.curator.runDelivery(s.delivery());assert.equal(calls,1);assert.equal((await s.store.get(s.jobPath)).data.callsUsed,3);});
 await t.test('unknown intent commit acknowledgement stops instead of looping or dispatching',async()=>{const s=await setup();await s.apply();const commit=s.store.commitSemantic.bind(s.store);let once=true;s.store.commitSemantic=async input=>{const isIntent=input.writes.some(w=>w.path===s.plan.path&&w.data.state==='consumed');const r=await commit(input);if(isIntent&&once){once=false;throw Error('synthetic commit response lost');}return r;};await s.curator.runDelivery(s.delivery());assert.equal(s.provider.calls.length,0);assert.equal(s.deliveries.length,0);const j=(await s.store.get(s.jobPath)).data;assert.equal(j.status,'uncertain');assert.equal(j.callsUsed,3);await s.curator.runDelivery(s.delivery());assert.equal(s.provider.calls.length,0);});
});
