import {createHash} from 'node:crypto';

// Pure preparation only. All observations and the native review are supplied by
// trusted server/operator loaders. This module has no store, network or provider.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const rejectedRecoveryHash=v=>createHash('sha256').update((JSON.stringify(canonical(v))??'undefined')).digest('hex');
const equal=(a,b)=>rejectedRecoveryHash(a)===rejectedRecoveryHash(b);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const rejectedSemanticRecoveryScope=freeze({
 version:'semantic-rejected-attempt-recovery-v1',
 jobId:'e79360382d0231e58861f62238ecb166541d15b0247c98e65c22ab6e87630197',
 jobUpdateTime:'2026-10-18T05:55:25.349512Z',
 oldBatchId:'329f1e1297721c60c514687aac0575d90caf32d41e70f020f4a1854ec3d8e98b',
 oldBindingHash:'9d4919c965da1e0e63552e73d2fe35b4e4c23338867abc302117d29b27b587c8',
 oldPromptHash:'599038589ef3d3c55d614bc9f7fe390e23ca3b8a29a7c0cf5d19ccdf63f69f72',
 policyHash:'1ae6bfc8be5bcbe321ecf8e731b6030502aafde7332d85b385ec5d3183c4ff2a',
 catalogueHash:'3fdc0558d8ed9dc8c88f9fa9400e75e20a18565a1eb42f8f3ba3b864b8136399',
 promptTransitionHash:'94955236ab26dcd3a9262e2f42c926065fe6ca39fa8cd080bd95d26ad4e16c6b',
 oldOutboxId:'3f1bfb4c266f4a9cec713e3c94da7b21654342f1dea12db789da52bcd8046c68',
 firstBatchId:'3b13566530aaade0978c6f5a2a703ae35dedf7a119b1b613f54b8c5a6ae184fb',
 firstRawHash:'7141be0388caa6cef5034f19c5c92eab97fb0ea7358165324ceadf44d03656a5',
 firstBindingHash:'9ae32eae1eb4795460e39a743ef6be2f471e6c89baff3d95b2b409fa6df4075d',
 sourceIds:['C_N6GLrpgI1','C_P8TJ2y_oL','C_QsrpPC3gm','C_sWZFSRMSz','C_Tgw5VSB1z','C_WS2WOR4bX','C_x4pCmit9z','C--mliLp-DA'],
 queueName:'projects/megabrain-v0-1017370021431/locations/us-central1/queues/v0-curation',
 maximumCalls:127,total:499,oldCursor:8,oldCalls:2,newCalls:3,
 checkpoint:{cursor:16,callsUsed:3,reason:'SEMANTIC_REJECTED_ATTEMPT_CHECKPOINT'},
 wireVersion:'semantic-wire-flat-v1',maximumObservationAgeMs:300000,
 evidence:[
  {file:'next8-vertex-metrics-observation-v1.json',sha256:'be69b2af98fe9801ebe0d2466657dde17dca0815b58e0b08580bd19b338a8a80'},
  {file:'next8-worker-identity-correlation-v1.json',sha256:'56885dbf9104e29605f7263a5fc059442142ec736fca3cda16959a9edbb7435e'},
  {file:'next8-intent-binding-and-worker-identity-v1.json',sha256:'9b59c6d17949d5b313881ec8916726631ae0d5684f777d3291867ee071e196e0'}
 ],
 correlation:{credentialId:'102639932314670195592',model:'gemini-3.5-flash',invocation:{start:'2026-10-18T05:55:23Z',end:'2026-10-18T05:56:23Z',count:1,httpStatus:400},serviceRuntime:{start:'2026-10-18T05:54:46Z',end:'2026-10-18T05:55:46Z',count:1,httpStatus:400,grpcStatus:3},selectedQueriesComplete:true,attribution:'circumstantial_aggregate_only',requestIdAvailable:false,responseBodyAvailable:false,billingEstablished:false,schemaCauseEstablished:false,universalAbsenceClaim:false}
});
const S=rejectedSemanticRecoveryScope;
export const rejectedSemanticRecoveryPath=()=> 'reels_index/semantic_rejected_recovery_'+rejectedRecoveryHash({version:S.version,jobId:S.jobId,oldBatchId:S.oldBatchId});
const rawPaths=()=>Array.from({length:12},(_,index)=>'reels_index/semantic_raw_'+S.oldBatchId+'_'+index);
const resultPath='reels_index/semantic_result_'+S.oldBatchId;
const sourceMetadata=s=>({id:s.id,sourceProjectionVersion:s.sourceProjectionVersion,semanticProofHash:s.semanticProofHash,sourceVersions:s.sourceVersions,editorialHash:s.editorialHash});
const snapshotBinding=s=>({path:s?.path,updateTime:s?.updateTime,dataHash:s?.data?rejectedRecoveryHash(s.data):null});
function metadataBinding(input){
 return {scopeVersion:S.version,job:snapshotBinding(input.job),policy:snapshotBinding(input.policy),authorization:snapshotBinding(input.authorization),firstResult:snapshotBinding(input.firstResult),editorial:snapshotBinding(input.editorial),sources:(input.sources??[]).map(sourceMetadata),newContract:input.newContract,evidence:input.evidence};
}
// Independent native review must bind exactly the metadata and proposed wire.
// The caller pins the review artifact separately; a request-body accepted:true is
// deliberately insufficient. This is not a cryptographic signer or permission.
export const rejectedSemanticRecoveryReviewScope=input=>rejectedRecoveryHash(metadataBinding(input));
function flatWire(schema,ids){
 const allowed=new Set(['type','properties','required','items','enum','nullable','description','propertyOrdering']);
 let nodes=0;
 const visit=(node,depth,seen)=>{
  if(!node||typeof node!=='object'||Array.isArray(node)||seen.has(node)||depth>20||++nodes>1000)return false;
  if(!['OBJECT','ARRAY','STRING','INTEGER','NUMBER','BOOLEAN'].includes(node.type)||Object.keys(node).some(k=>!allowed.has(k)))return false;
  if(node.enum&&(!Array.isArray(node.enum)||!node.enum.length||node.enum.some(x=>typeof x!=='string')))return false;
  const branch=new Set(seen);branch.add(node);
  if(node.type==='ARRAY'&&!visit(node.items,depth+1,branch))return false;
  if(node.type==='OBJECT'){
   if(!node.properties||typeof node.properties!=='object'||Array.isArray(node.properties)||!Array.isArray(node.required)||node.required.some(k=>!Object.hasOwn(node.properties,k)))return false;
   if(!Object.values(node.properties).every(child=>visit(child,depth+1,branch)))return false;
  }
  return true;
 };
 if(!visit(schema,0,new Set()))return false;
 const p=schema.properties,profile=p?.profiles?.items,group=p?.groups?.items;
 return schema.type==='OBJECT'&&['version','profiles','groups'].every(k=>schema.required.includes(k))&&profile?.type==='OBJECT'&&group?.type==='OBJECT'&&equal(profile.properties?.reelId?.enum,ids)&&equal(group.properties?.kind?.enum,['context','format','facet','segment'])&&equal(group.properties?.context?.enum,['recipe','technology','health','travel','business','home','general'])&&equal(group.properties?.dimension?.enum,['ingredient','tool','method','place','purpose','other'])&&group.properties.dimension.nullable===true;
}
function evaluate(input,{trustedReview=null}={}){
 const errors=[],captures=[],checks=[];
 const need=(ok,code)=>{if(!ok)errors.push(code);return Boolean(ok);};
 const now=Date.parse(input?.now),fresh=(value,label)=>{
  const time=Date.parse(value);
  const ok=need(Number.isFinite(now)&&date(value)&&time<=now&&now-time<=S.maximumObservationAgeMs,label+'_CAPTURE_NOT_FRESH');
  if(ok)captures.push(time);return ok;
 };
 const snapshot=(s,path,label)=>{
  if(!need(s?.path===path&&date(s?.updateTime)&&s?.data&&typeof s.data==='object',label+'_SNAPSHOT_MISSING'))return;
  fresh(s.readTime,label);checks.push({path,updateTime:s.updateTime});
 };
 const absent=(row,path,label)=>{
  need(row?.path===path&&row.exists===false&&row.updateTime===null,label+'_ABSENCE_REQUIRED');
  fresh(row?.readTime,label);checks.push({path,updateTime:null});
 };
 if(!need(input&&typeof input==='object','METADATA_INPUT_REQUIRED'))return {errors,captures,checks};
 const j=input.job?.data??{},b=j.batch??{},binding=b.binding??{},policy=input.policy?.data??{},ledger=input.authorization?.data??{};
 snapshot(input.job,'reels_index/semantic_job_'+S.jobId,'JOB');
 need(input.job?.updateTime===S.jobUpdateTime&&j.id===S.jobId&&j.kind==='semantic_job'&&j.status==='uncertain'&&j.reason==='PAID_SUBMISSION_OR_PERSISTENCE_UNCERTAIN'&&j.phase==='extract'&&j.cursor===8&&j.callsUsed===2&&j.total===499&&j.maxCalls===127,'FINITE_OLD_JOB_MISMATCH');
 need(b.id===S.oldBatchId&&b.status==='submitting'&&b.phase==='extract'&&b.offset===8&&b.bindingHash===S.oldBindingHash&&rejectedRecoveryHash(binding)===S.oldBindingHash,'OLD_INTENT_BINDING_MISMATCH');
 need(date(b.leaseUntil)&&Date.parse(b.leaseUntil)<=now,'LEASE_NOT_EXPIRED');
 need(j.dispatch?.sequence===1&&j.dispatch.outboxId===S.oldOutboxId,'OLD_DELIVERY_MISMATCH');
 need(binding.jobId===S.jobId&&binding.phase==='extract'&&binding.cursor===8&&binding.promptHash===S.oldPromptHash&&binding.policyHash===S.policyHash&&binding.catalogueHash===S.catalogueHash&&binding.promptTransitionHash===S.promptTransitionHash,'OLD_BINDING_SCOPE_MISMATCH');
 need(equal(b.sourceIds,S.sourceIds)&&Array.isArray(binding.pins)&&equal(binding.pins.map(p=>p.id),S.sourceIds),'OLD_BATCH_IDS_MISMATCH');
 snapshot(input.policy,'settings/reels_v2_semantic_policy','POLICY');
 need(equal(policy,j.policy)&&rejectedRecoveryHash(policy)===S.policyHash&&j.policyHash===S.policyHash&&policy.enabled===true&&policy.model===S.correlation.model&&policy.verifierModel===S.correlation.model&&policy.batchSize===8&&policy.maxSources===499&&policy.maxCalls===127&&policy.autoPromotionEnabled===false,'POLICY_OR_CAP_CHANGED');
 need(date(policy.expiresAt)&&Date.parse(policy.expiresAt)>now,'POLICY_EXPIRED');
 need(Array.isArray(j.pins)&&j.pins.length===499&&new Set(j.pins.map(p=>p.id)).size===499&&rejectedRecoveryHash(j.pins)===j.cohortHash&&j.cohortHash===policy.authorizedCohortHash,'COHORT_CHANGED');
 snapshot(input.authorization,'reels_index/semantic_authorization_'+rejectedRecoveryHash(policy.authorizationId),'AUTHORIZATION');
 need(ledger.kind==='semantic_authorization'&&ledger.jobId===S.jobId&&ledger.authorizationId===policy.authorizationId&&ledger.cohortHash===j.cohortHash&&ledger.maximumCalls===127&&ledger.promptHash===j.promptHash&&hex(j.promptHash)&&j.promptHash!==S.oldPromptHash,'ORIGINAL_LEDGER_CHANGED');
 snapshot(input.firstResult,'reels_index/semantic_result_'+S.firstBatchId,'FIRST_RESULT');
 const first=input.firstResult?.data??{};
 need(first.kind==='semantic_result'&&first.id===S.firstBatchId&&first.processed===true&&first.rawHash===S.firstRawHash&&first.bindingHash===S.firstBindingHash&&rejectedRecoveryHash(first.binding??{})===S.firstBindingHash&&first.binding?.jobId===S.jobId&&first.binding?.cursor===0&&first.binding?.promptHash===j.promptHash,'FIRST_RESPONSE_PROVENANCE_CHANGED');
 snapshot(input.editorial,'settings/reels_v2_taxonomy','EDITORIAL');
 need(Array.isArray(input.sources)&&input.sources.length===8&&equal(input.sources.map(s=>s.id),S.sourceIds),'CURRENT_SOURCE_METADATA_MISSING');
 for(const [i,source] of (input.sources??[]).entries()){
  const pin=binding.pins?.[i];
  need(equal(sourceMetadata(source),pin)&&equal(j.pins?.[8+i],{id:source.id,sourceVersions:source.sourceVersions}),'SOURCE_EPOCH_CHANGED');
  fresh(source.readTime,'SOURCE_'+i);
  need(hex(source.semanticProofHash)&&hex(source.editorialHash)&&source.sourceProjectionVersion==='saved-text-projection-v2'&&date(source.sourceVersions?.video),'SOURCE_PROOF_MISSING');
  if(source.sourceVersions)for(const [kind,updateTime]of Object.entries(source.sourceVersions)){
   need(['video','legacy'].includes(kind)&&date(updateTime),'SOURCE_VERSION_UNSUPPORTED');
   if(['video','legacy'].includes(kind))checks.push({path:(kind==='video'?'videos/':'reels_legacy_content/')+source.id,updateTime});
  }
 }
 absent(input.resultAbsence,resultPath,'RESULT');
 const query=input.rawAbsence?.query;
 need(query?.collection==='reels_index'&&equal(query.filters,[{field:'kind',op:'eq',value:'semantic_raw'},{field:'batchId',op:'eq',value:S.oldBatchId}])&&query.complete===true&&Array.isArray(query.records)&&query.records.length===0,'COMPLETE_RAW_ABSENCE_QUERY_REQUIRED');
 fresh(query?.readTime,'RAW_QUERY');
 const raw=input.rawAbsence?.documents;
 need(Array.isArray(raw)&&raw.length===12,'ALL_RAW_CHUNK_ABSENCES_REQUIRED');
 for(const [i,path]of rawPaths().entries())absent(raw?.[i],path,'RAW_'+i);
 absent(input.recoveryAbsence,rejectedSemanticRecoveryPath(),'RECOVERY');
 need(input.queue?.name===S.queueName&&input.queue.state==='PAUSED','QUEUE_NOT_PAUSED');
 fresh(input.queue?.readTime,'QUEUE');
 const nc=input.newContract??{};
 need(nc.wireVersion===S.wireVersion&&hex(nc.promptHash)&&nc.promptHash!==S.oldPromptHash&&nc.promptHash!==j.promptHash&&hex(nc.schemaHash)&&nc.schemaHash===rejectedRecoveryHash(nc.schema)&&/^[a-f0-9]{40}$/.test(nc.sourceCommit??'')&&flatWire(nc.schema,S.sourceIds),'REVIEWED_FLAT_CONTRACT_REQUIRED');
 need(equal(input.evidence?.references,S.evidence)&&equal(input.evidence?.correlation,S.correlation),'HISTORICAL_EVIDENCE_OR_LIMITS_MISMATCH');
 const review=input.review,rd=review?.data??{},scopeHash=rejectedSemanticRecoveryReviewScope(input);
 need(trustedReview&&review?.path===trustedReview.path&&review?.sha256===trustedReview.sha256&&hex(review.sha256)&&trustedReview.dataHash===rejectedRecoveryHash(rd)&&trustedReview.scopeHash===scopeHash&&trustedReview.actorId===rd.actorId&&rd.kind==='native_independent_review'&&rd.executor==='codex-native'&&rd.role==='Revisor'&&typeof rd.actorId==='string'&&rd.actorId.startsWith('/root/')&&rd.actorId!=='/root/alignment_frontend'&&rd.accepted===true&&rd.scopeHash===scopeHash&&date(rd.reviewedAt)&&Date.parse(rd.reviewedAt)<=now&&rd.assignment==='exact_http400_recovery_preparation_only'&&equal(rd.limits,{circumstantialAggregateOnly:true,noRequestId:true,noBody:true,billingNotEstablished:true,schemaCauseNotEstablished:true,noUniversalAbsenceClaim:true}),'TRUSTED_INDEPENDENT_REVIEW_REQUIRED');
 fresh(rd.reviewedAt,'REVIEW');
 need(input.recoveryConsumed!==true,'RECOVERY_ALREADY_CONSUMED');
 return {errors:[...new Set(errors)],captures,checks,scopeHash};
}
export function rejectedSemanticAttemptIdentity(receipt){
 const attemptId=rejectedRecoveryHash({jobId:S.jobId,oldBatchId:S.oldBatchId,receiptHash:receipt.receiptHash,newPromptHash:receipt.binding.newContract.promptHash,callsUsed:3});
 return {attemptId,sequence:2,outboxId:rejectedRecoveryHash({jobId:S.jobId,sequence:2}),callsBefore:2,callsAfterIntent:3,logicalCursor:8,checkpoint:structuredClone(S.checkpoint)};
}
export function prepareRejectedSemanticAttemptRecovery(input,options={}){
 const result=evaluate(input,options);
 const report={kind:S.version,ready:result.errors.length===0,errors:result.errors,executionAuthorized:false,providerCalls:0,writes:0,oldIntentPreserved:true,oldCallsUsed:2,maximumCalls:127,historicalAttribution:'circumstantial_aggregate_only',freshStateObservedByModule:false};
 if(!report.ready)return {report,receipt:null,plan:null};
 const validUntil=new Date(Math.min(...result.captures.map(t=>t+S.maximumObservationAgeMs),Date.parse(input.policy.data.expiresAt))).toISOString();
 const receipt={kind:S.version,schemaVersion:1,status:'prepared_only',jobId:S.jobId,oldBatchId:S.oldBatchId,preparedAt:input.now,validUntil,binding:metadataBinding(input),scopeHash:result.scopeHash,review:{path:input.review.path,sha256:input.review.sha256,dataHash:rejectedRecoveryHash(input.review.data)},callsBefore:2,callsAfterNewIntent:3,maximumCalls:127,checkpoint:structuredClone(S.checkpoint),executionAuthorized:false};
 receipt.receiptHash=rejectedRecoveryHash(receipt);
 const nextAttempt=rejectedSemanticAttemptIdentity(receipt);
 const checks=[...new Map(result.checks.map(c=>[c.path,c])).values()];
 const plan={kind:'semantic_rejected_attempt_preparation_plan',receiptHash:receipt.receiptHash,executable:false,executionAuthorized:false,requiresSeparateExactAuthorization:true,checks,queryRechecks:[structuredClone(input.rawAbsence.query)],preCommitRechecks:{queueName:S.queueName,requiredState:'PAUSED',validUntil,jobEpoch:S.jobUpdateTime,leaseMustRemainExpired:true},createOnly:[{path:rejectedSemanticRecoveryPath(),data:receipt}],nextAttempt,oldIntentWrites:[],jobWrites:[],queueWrites:[],providerCalls:0};
 plan.planHash=rejectedRecoveryHash(plan);return {report,receipt,plan};
}
export function validateRejectedSemanticAttemptRecovery(receipt,current,options={}){
 try{
  if(!receipt||receipt.executionAuthorized!==false||receipt.status!=='prepared_only'||!date(receipt.validUntil)||Date.parse(current.now)>=Date.parse(receipt.validUntil))return false;
  if(!date(receipt.preparedAt)||Date.parse(receipt.validUntil)>Date.parse(receipt.preparedAt)+S.maximumObservationAgeMs||Date.parse(receipt.validUntil)>Date.parse(current.policy?.data?.expiresAt)||!date(current.review?.data?.reviewedAt)||Date.parse(receipt.validUntil)>Date.parse(current.review.data.reviewedAt)+S.maximumObservationAgeMs)return false;
  const {receiptHash,...body}=receipt;if(!hex(receiptHash)||rejectedRecoveryHash(body)!==receiptHash)return false;
  const prepared=prepareRejectedSemanticAttemptRecovery(current,options);
  return prepared.report.ready&&equal(receipt.binding,prepared.receipt.binding)&&receipt.scopeHash===prepared.receipt.scopeHash&&equal(receipt.review,prepared.receipt.review)&&equal(receipt.checkpoint,S.checkpoint)&&receipt.callsBefore===2&&receipt.callsAfterNewIntent===3&&receipt.maximumCalls===127&&receipt.jobId===S.jobId&&receipt.oldBatchId===S.oldBatchId&&receipt.kind===S.version&&receipt.schemaVersion===1&&date(receipt.preparedAt)&&Date.parse(receipt.preparedAt)<=Date.parse(current.now)&&Object.keys(receipt).sort().join(',')===Object.keys(prepared.receipt).sort().join(',');
 }catch{return false;}
}
