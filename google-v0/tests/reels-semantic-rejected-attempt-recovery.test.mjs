import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeFields} from '../lib/firestore.mjs';
import {semanticHash} from '../lib/reels-semantic-source.mjs';
import {rejectedRecoveryHash as hash,rejectedSemanticRecoveryScope as S,rejectedSemanticRecoveryPath,rejectedSemanticRecoveryReviewScope,prepareRejectedSemanticAttemptRecovery,validateRejectedSemanticAttemptRecovery,rejectedSemanticAttemptIdentity} from '../lib/reels-semantic-rejected-attempt-recovery.mjs';

test('pure preparation fails closed without complete fresh metadata and a pinned native review',()=>{
 const result=prepareRejectedSemanticAttemptRecovery({});
 assert.equal(result.report.ready,false);assert.equal(result.report.executionAuthorized,false);
 assert.equal(result.receipt,null);assert.equal(result.plan,null);assert.equal(result.report.providerCalls,0);assert.equal(result.report.writes,0);
 assert.ok(result.report.errors.includes('TRUSTED_INDEPENDENT_REVIEW_REQUIRED'));
 assert.equal(validateRejectedSemanticAttemptRecovery(null,{}),false);
});
test('hash is canonical, preserves array order and matches the existing engine',()=>{
 const value={z:[{b:2,a:1},3],a:'metadata'};
 assert.equal(hash(value),semanticHash(value));assert.equal(hash(value),hash({a:'metadata',z:[{a:1,b:2},3]}));
 assert.notEqual(hash(value),hash({a:'metadata',z:[3,{a:1,b:2}]}));
 assert.match(rejectedSemanticRecoveryPath(),/^reels_index\/semantic_rejected_recovery_[a-f0-9]{64}$/);
 assert.ok(Object.isFrozen(S.correlation));assert.ok(Object.isFrozen(S.sourceIds));
});

// These eight historical pins are metadata, not a corpus fixture or source text.
// Fresh observations below are SIMULATED. No test reports an actual Google read.
const pinProofs=[
 ['C_N6GLrpgI1','4109d18074959c5feed2d5baff89f75ce15608a15cc386d8b16f3bfdb9771ba9'],
 ['C_P8TJ2y_oL','86ba5172a40b1b3ca2601f1335c166bed3583c60286c6c3c7c625cf80986bc6a'],
 ['C_QsrpPC3gm','a6a802ff57336df216ffe606ebc7caad7a9b9f82ead4427439bcd7418ec01c5a'],
 ['C_sWZFSRMSz','efd55961f14254d2c85b555c9c688159195a13bc2b3afad9222f7816294648c6'],
 ['C_Tgw5VSB1z','856a8be2d415957c16b7b9033fe55d6fe9c526bd2081e95bf2d87d9611dfbaa9'],
 ['C_WS2WOR4bX','7958364a8ccf37c2a289f330bfa07999af3c2837e55f76ddbd513dcb899dd4d9'],
 ['C_x4pCmit9z','6171b7f159b337ec47c01d16dd512c0372367f9c6e418b069a48403a6e17e21e'],
 ['C--mliLp-DA','d95be548b165c3141e855a617ff7960647145eb821da0c90b1c945a263ed76e6']
];
const now='2026-10-18T06:00:00.000Z',epoch='2026-10-18T05:59:59.000Z';
const snapshot=(path,data,updateTime=epoch)=>({path,data:structuredClone(data),updateTime,readTime:now});
const absence=path=>({path,exists:false,updateTime:null,readTime:now});
function sign(input){
 const scopeHash=rejectedSemanticRecoveryReviewScope(input);
 input.review={path:'native-review/synthetic-rejected-recovery.json',sha256:hash('synthetic native attestation artifact'),data:{kind:'native_independent_review',executor:'codex-native',role:'Revisor',actorId:'/root/synthetic_independent_reviewer',accepted:true,scopeHash,reviewedAt:now,assignment:'exact_http400_recovery_preparation_only',limits:{circumstantialAggregateOnly:true,noRequestId:true,noBody:true,billingNotEstablished:true,schemaCauseNotEstablished:true,noUniversalAbsenceClaim:true}}};
 return {trustedReview:{path:input.review.path,sha256:input.review.sha256,dataHash:hash(input.review.data),scopeHash,actorId:input.review.data.actorId}};
}
function simulatedInput(paid){
 assert.ok([1,2].includes(paid.schemaVersion));assert.equal(paid.kind,'saved_semantic_first_response_reconciliation_input');
 assert.equal(paid.readOnly,true);assert.equal(paid.providerCalls,0);assert.equal(paid.writes,0);assert.equal(paid.records.length,4);
 const records=paid.records.map(row=>{assert.equal(row.document.name,'projects/megabrain-v0-1017370021431/databases/(default)/documents/'+row.path);return {path:row.path,data:decodeFields(row.document.fields),updateTime:row.document.updateTime};});
 const original=records.find(r=>r.data.kind==='semantic_job'),authorization=records.find(r=>r.data.kind==='semantic_authorization'),first=records.find(r=>r.data.kind==='semantic_result');
 assert.equal(original.data.id,S.jobId);assert.equal(hash(original.data.policy),S.policyHash);
 const j=structuredClone(original.data),pins=pinProofs.map(([id,semanticProofHash],i)=>{assert.equal(j.pins[8+i].id,id);return {id,sourceProjectionVersion:'saved-text-projection-v2',semanticProofHash,sourceVersions:j.pins[8+i].sourceVersions,editorialHash:'440cc852445f1b4dcaa9e0147259120f7201c90fff59780fa11d4ce66dfbd490'};});
 const binding={jobId:S.jobId,phase:'extract',cursor:8,pins,catalogueHash:S.catalogueHash,policyHash:S.policyHash,promptHash:S.oldPromptHash,promptTransitionHash:S.promptTransitionHash};
 assert.equal(hash(binding),S.oldBindingHash);
 Object.assign(j,{status:'uncertain',reason:'PAID_SUBMISSION_OR_PERSISTENCE_UNCERTAIN',phase:'extract',cursor:8,callsUsed:2,dispatch:{sequence:1,status:'pending',outboxId:S.oldOutboxId,reason:null},batch:{id:S.oldBatchId,status:'submitting',phase:'extract',offset:8,sourceIds:S.sourceIds,bindingHash:S.oldBindingHash,binding,leaseOwner:'synthetic-expired-lease',leaseUntil:'2026-10-18T05:58:24.000Z',startedAt:'2026-10-18T05:55:24.000Z'}});
 // The schema is synthetic flat metadata. It is NOT a claim about a deployed
 // wire hash. A future operator must bind the actual reviewed provider schema.
 const str={type:'STRING'};
 const schema={type:'OBJECT',required:['version','profiles','groups'],properties:{version:{type:'INTEGER'},profiles:{type:'ARRAY',items:{type:'OBJECT',required:['reelId'],properties:{reelId:{type:'STRING',enum:S.sourceIds}}}},groups:{type:'ARRAY',items:{type:'OBJECT',required:['kind','context','key'],properties:{kind:{type:'STRING',enum:['context','format','facet','segment']},context:{type:'STRING',enum:['recipe','technology','health','travel','business','home','general']},key:str,dimension:{type:'STRING',nullable:true,enum:['ingredient','tool','method','place','purpose','other']}}}}}};
 const input={fixtureKind:'assembled_simulation_from_historical_metadata',now,job:snapshot(original.path,j,S.jobUpdateTime),policy:snapshot('settings/reels_v2_semantic_policy',j.policy),authorization:snapshot(authorization.path,authorization.data,authorization.updateTime),firstResult:snapshot(first.path,{...first.data,processed:true},first.updateTime),editorial:snapshot('settings/reels_v2_taxonomy',{revision:15,nodes:[],synthetic:true}),sources:pins.map(p=>({...p,readTime:now})),resultAbsence:absence('reels_index/semantic_result_'+S.oldBatchId),rawAbsence:{query:{collection:'reels_index',filters:[{field:'kind',op:'eq',value:'semantic_raw'},{field:'batchId',op:'eq',value:S.oldBatchId}],records:[],complete:true,readTime:now},documents:Array.from({length:12},(_,i)=>absence('reels_index/semantic_raw_'+S.oldBatchId+'_'+i))},recoveryAbsence:absence(rejectedSemanticRecoveryPath()),queue:{name:S.queueName,state:'PAUSED',readTime:now},newContract:{wireVersion:S.wireVersion,promptHash:hash('synthetic flat prompt'),schemaHash:hash(schema),schema,sourceCommit:'a'.repeat(40)},evidence:{references:structuredClone(S.evidence),correlation:structuredClone(S.correlation)}};
 return {input,options:sign(input)};
}
const paidPath=process.env.SEMANTIC_REJECTED_RECOVERY_INPUT;
test('historical metadata simulation: finite receipt, every guard, no execution or write', {skip:!paidPath?'sealed paid4 input is only supplied by central GitHub Actions':false},async t=>{
 assert.equal(process.env.GITHUB_ACTIONS,'true','sealed inputs may be read only in central CI');assert.equal(process.env.GITHUB_REPOSITORY,'mide-lim/MEGA-BRAIN');
 const text=await readFile(paidPath,'utf8');
 assert.equal(createHash('sha256').update(text).digest('hex'),'0b32ed9bf7d4759d80b1e723aa775356eafb6c017a6f59a3890398c92a9440cc');
 const paid=JSON.parse(text),{input,options}=simulatedInput(paid),before=hash(input);
 const result=prepareRejectedSemanticAttemptRecovery(input,options);
 assert.equal(result.report.ready,true,JSON.stringify(result.report.errors));assert.equal(hash(input),before);
 const {receipt,plan}=result;
 assert.equal(receipt.executionAuthorized,false);assert.equal(plan.executionAuthorized,false);assert.equal(plan.executable,false);assert.equal(plan.providerCalls,0);
 assert.equal(plan.createOnly.length,1);assert.equal(plan.createOnly[0].path,rejectedSemanticRecoveryPath());assert.deepEqual(plan.jobWrites,[]);assert.deepEqual(plan.oldIntentWrites,[]);assert.deepEqual(plan.queueWrites,[]);
 assert.equal(plan.nextAttempt.callsBefore,2);assert.equal(plan.nextAttempt.callsAfterIntent,3);assert.equal(plan.nextAttempt.logicalCursor,8);assert.deepEqual(plan.nextAttempt.checkpoint,{cursor:16,callsUsed:3,reason:'SEMANTIC_REJECTED_ATTEMPT_CHECKPOINT'});
 assert.equal(plan.nextAttempt.sequence,2);assert.notEqual(plan.nextAttempt.outboxId,S.oldOutboxId);assert.notEqual(plan.nextAttempt.attemptId,S.oldBatchId);
 assert.deepEqual(plan.nextAttempt,rejectedSemanticAttemptIdentity(receipt));assert.equal(validateRejectedSemanticAttemptRecovery(receipt,input,options),true);
 assert.equal(plan.checks.filter(c=>c.path.startsWith('reels_index/semantic_raw_')&&c.updateTime===null).length,12);
 assert.equal(plan.checks.find(c=>c.path===input.job.path).updateTime,S.jobUpdateTime);
 assert.equal(result.report.historicalAttribution,'circumstantial_aggregate_only');
 await t.test('independent review is separately pinned and cannot be an accepted request flag',()=>{
  assert.equal(prepareRejectedSemanticAttemptRecovery(input).report.ready,false);
  const changed=structuredClone(input);changed.review.data.accepted=false;assert.equal(prepareRejectedSemanticAttemptRecovery(changed,options).report.ready,false);
 });
 const changes={
  genericJob:x=>x.job.data.id=hash('otherjob'),
  jobEpoch:x=>x.job.updateTime=epoch,
  originalCounter:x=>x.job.data.callsUsed=1,
  oldCursor:x=>x.job.data.cursor=0,
  cap:x=>x.job.data.maxCalls=128,
  cohort:x=>x.job.data.pins.pop(),
  ledger:x=>x.authorization.data.maximumCalls=128,
  policy:x=>x.policy.data.autoPromotionEnabled=true,
  expiry:x=>x.policy.data.expiresAt='2026-10-18T05:59:00Z',
  source:x=>x.sources[0].sourceVersions.video=epoch,
  proof:x=>x.sources[0].semanticProofHash=hash('changedproof'),
  liveLease:x=>x.job.data.batch.leaseUntil='2026-10-18T06:01:00Z',
  oldSequence:x=>x.job.data.dispatch.sequence=0,
  notPaused:x=>x.queue.state='RUNNING',
  oldQueueCapture:x=>x.queue.readTime='2026-10-18T05:54:59Z',
  futureCapture:x=>x.resultAbsence.readTime='2026-10-18T06:00:01Z',
  resultExists:x=>x.resultAbsence.exists=true,
  rawExists:x=>x.rawAbsence.documents[11].exists=true,
  rawQueryIncomplete:x=>x.rawAbsence.query.complete=false,
  rawQueryRows:x=>x.rawAbsence.query.records.push({path:'metadata-only'}),
  rawPathMissing:x=>x.rawAbsence.documents.pop(),
  recoveryExists:x=>x.recoveryAbsence.exists=true,
  consumed:x=>x.recoveryConsumed=true,
  oldPrompt:x=>x.newContract.promptHash=S.oldPromptHash,
  wrongWire:x=>x.newContract.wireVersion='unreviewed',
  schemaChanged:x=>x.newContract.schema.properties.version.type='STRING',
  firstRawChanged:x=>x.firstResult.data.rawHash=hash('otherraw'),
  firstNotApplied:x=>x.firstResult.data.processed=false,
  evidenceChanged:x=>x.evidence.references[0].sha256=hash('untrusted'),
  falseBillingClaim:x=>x.evidence.correlation.billingEstablished=true,
  falseRequestLevel:x=>x.evidence.correlation.attribution='request_level'
 };
 for(const[name,change]of Object.entries(changes))await t.test('reject '+name,()=>{
  const changed=structuredClone(input);change(changed);
  // Even a new independent review cannot waive the finite hard guards.
  const changedOptions=sign(changed),r=prepareRejectedSemanticAttemptRecovery(changed,changedOptions);
  assert.equal(r.report.ready,false,name);assert.equal(r.receipt,null);assert.equal(r.plan,null);
  assert.equal(validateRejectedSemanticAttemptRecovery(receipt,changed,changedOptions),false);
 });
 await t.test('flat wire constraints cannot be replaced with unsupported anyOf or numeric bounds',()=>{
  for(const[key,value]of Object.entries({anyOf:[{type:'OBJECT'}],maxItems:24,minimum:1})){
   const changed=structuredClone(input);changed.newContract.schema[key]=value;changed.newContract.schemaHash=hash(changed.newContract.schema);
   assert.equal(prepareRejectedSemanticAttemptRecovery(changed,sign(changed)).report.ready,false);
  }
 });
 await t.test('receipt validity is bounded and old receipt/old sequence cannot become a new attempt',()=>{
  const later=structuredClone(input);later.now='2026-10-18T06:05:00.000Z';
  assert.equal(validateRejectedSemanticAttemptRecovery(receipt,later,options),false);
  const forgedTTL=structuredClone(receipt);forgedTTL.validUntil='2026-10-18T07:00:00.000Z';
  const {receiptHash:oldHash,...ttlBody}=forgedTTL;forgedTTL.receiptHash=hash(ttlBody);
  const refreshed=structuredClone(input);refreshed.now='2026-10-18T06:06:00.000Z';
  for(const row of [refreshed.job,refreshed.policy,refreshed.authorization,refreshed.firstResult,refreshed.editorial,...refreshed.sources,refreshed.resultAbsence,refreshed.rawAbsence.query,...refreshed.rawAbsence.documents,refreshed.recoveryAbsence,refreshed.queue])row.readTime=refreshed.now;
  assert.equal(validateRejectedSemanticAttemptRecovery(forgedTTL,refreshed,options),false,'re-hashing cannot extend the old five-minute receipt with renewed capture timestamps');
  const forged=structuredClone(receipt);forged.executionAuthorized=true;assert.equal(validateRejectedSemanticAttemptRecovery(forged,input,options),false);
  const forgedCheckpoint=structuredClone(receipt);forgedCheckpoint.checkpoint.callsUsed=2;const {receiptHash,...body}=forgedCheckpoint;forgedCheckpoint.receiptHash=hash(body);assert.equal(validateRejectedSemanticAttemptRecovery(forgedCheckpoint,input,options),false);
 });
 console.log(JSON.stringify({kind:'semantic_rejected_recovery_contract_simulation',fixtureKind:input.fixtureKind,ready:true,sourcePinCount:8,historicalReferencesOnly:true,freshGoogleObservations:false,providerCalls:0,writes:0,executionAuthorized:false}));
});
