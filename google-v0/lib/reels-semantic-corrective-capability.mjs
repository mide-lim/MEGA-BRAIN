import {semanticHash} from './reels-semantic-source.mjs';
import {semanticPromptHash,semanticWireSchemaVersion,semanticSchemaForPhase} from './reels-semantic-provider.mjs';
import {semanticSourceRecoveryReceiptValid} from './reels-semantic-source-recovery.mjs';
import {rejectedSemanticRecoveryScope as S,rejectedSemanticRecoveryPath,rejectedSemanticAttemptIdentity,prepareRejectedSemanticAttemptRecovery,validateRejectedSemanticAttemptRecovery} from './reels-semantic-rejected-attempt-recovery.mjs';
const equal=(a,b)=>semanticHash(a)===semanticHash(b),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const failure=()=>{throw Object.assign(Error('Permissão corretiva finita inválida; não repetir inferência.'),{code:'SEMANTIC_CORRECTIVE_CAPABILITY_INVALID',status:409});};
export const semanticCorrectiveCapabilityVersion='semantic-corrective-capability-v1';
export const semanticCorrectiveCapabilityPath=receipt=>'reels_index/semantic_corrective_capability_'+semanticHash({jobId:receipt.jobId,receiptHash:receipt.receiptHash});
const checkedApproval=(approval,receipt,policy,now)=>{
 const keys=['kind','approvalId','packageHash','sourceCommit','actorId','approvedAt','expiresAt','humanAuthorizationRef'];
 return approval&&Object.keys(approval).sort().join(',')===keys.sort().join(',')&&approval.kind==='explicit_owner_finite_authorization'&&typeof approval.approvalId==='string'&&approval.approvalId.length>=8&&approval.approvalId.length<=160&&hex(approval.packageHash)&&approval.sourceCommit===receipt.binding.newContract.sourceCommit&&/^[a-f0-9]{40}$/.test(approval.sourceCommit??'')&&typeof approval.actorId==='string'&&approval.actorId.trim()&&approval.actorId.length<=200&&typeof approval.humanAuthorizationRef==='string'&&approval.humanAuthorizationRef.trim()&&approval.humanAuthorizationRef.length<=300&&date(approval.approvedAt)&&Date.parse(approval.approvedAt)<=Date.parse(now)&&date(approval.expiresAt)&&Date.parse(now)<Date.parse(approval.expiresAt)&&Date.parse(approval.expiresAt)<=Date.parse(policy.expiresAt);
};
function receiptIntegrity(receipt){
 if(!receipt||receipt.kind!==S.version||receipt.status!=='prepared_only'||receipt.executionAuthorized!==false||receipt.jobId!==S.jobId||receipt.oldBatchId!==S.oldBatchId||receipt.callsBefore!==2||receipt.callsAfterNewIntent!==3||receipt.maximumCalls!==127||!equal(receipt.checkpoint,S.checkpoint)||!hex(receipt.receiptHash))return false;
 const {receiptHash,...body}=receipt;return semanticHash(body)===receiptHash;
}
function historyMatches(history,first,ledger,job){
 const r=history?.data;
 return history?.path==='reels_index/semantic_source_recovery_'+S.firstBatchId&&date(history.updateTime)&&semanticSourceRecoveryReceiptValid(r)&&r.jobId===S.jobId&&r.batchId===S.firstBatchId&&r.savedRawHash===S.firstRawHash&&r.originalBindingHash===S.firstBindingHash&&r.promptHash===job.promptHash&&r.approvedNextPromptHash===S.oldPromptHash&&r.transitionHash===S.promptTransitionHash&&first?.data?.processed===true&&first.data.id===S.firstBatchId&&first.data.rawHash===S.firstRawHash&&first.data.bindingHash===S.firstBindingHash&&semanticHash(first.data.binding)===S.firstBindingHash&&first.data.binding.promptHash===job.promptHash&&ledger.data.promptHash===job.promptHash;
}
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value??{},k)).map(k=>[k,structuredClone(value[k])]));
const snapshot=s=>pick(s,['path','data','updateTime','readTime']);
const absence=s=>pick(s,['path','exists','updateTime','readTime']);
const source=s=>pick(s,['id','sourceProjectionVersion','semanticProofHash','sourceVersions','editorialHash','readTime']);
function originalInput(input){
 // Snapshot data are already hash-bound to the exact original document by the
 // prepared receipt. Unused transport/source/review extras are never persisted.
 const out={now:input.now};
 for(const k of ['job','policy','authorization','firstResult','editorial'])out[k]=snapshot(input[k]);
 out.sources=(input.sources??[]).map(source);out.resultAbsence=absence(input.resultAbsence);
 out.rawAbsence={query:pick(input.rawAbsence?.query,['collection','filters','records','complete','readTime']),documents:(input.rawAbsence?.documents??[]).map(absence)};
 out.recoveryAbsence=absence(input.recoveryAbsence);out.queue=pick(input.queue,['name','state','readTime']);
 out.newContract=pick(input.newContract,['wireVersion','promptHash','schemaHash','schema','sourceCommit']);
 out.evidence={references:(input.evidence?.references??[]).map(r=>pick(r,['file','sha256'])),correlation:pick(input.evidence?.correlation,['credentialId','model','invocation','serviceRuntime','selectedQueriesComplete','attribution','requestIdAvailable','responseBodyAvailable','billingEstablished','schemaCauseEstablished','universalAbsenceClaim'])};
 out.review=pick(input.review,['path','sha256','data']);
 if(out.review.data)out.review.data=pick(out.review.data,['kind','executor','role','actorId','accepted','scopeHash','reviewedAt','assignment','limits']);
 if(Object.hasOwn(input,'recoveryConsumed'))out.recoveryConsumed=input.recoveryConsumed;
 return out;
}
// Pure sealed-plan construction. Returning an authorization document does not
// apply it: only the separately reviewed owner operation may create it. No API
// command calls this factory, and a prepared-only receipt is never a capability.
// Identity is sealed in authorizationHash; the reviewed owner client must verify
// that exact actor against its private approved identity. A literal email in
// application source would not prove control of the Google owner session.
export function prepareSemanticCorrectiveCapability({receipt,preparationInput,trustedReview,historicalRecovery,historicalRawChunks,coordinator,approval,now}={}){
 if(!date(now)||!receiptIntegrity(receipt)||!validateRejectedSemanticAttemptRecovery(receipt,{...preparationInput,now},{trustedReview})||!checkedApproval(approval,receipt,preparationInput.policy.data,now))failure();
 preparationInput=originalInput(preparationInput);if(!validateRejectedSemanticAttemptRecovery(receipt,{...preparationInput,now},{trustedReview}))failure();
 const old=preparationInput.job,first=preparationInput.firstResult,ledger=preparationInput.authorization,history=historicalRecovery;
 if(!historyMatches(history,first,ledger,old.data)||coordinator?.path!=='reels_index/semantic_coordinator'||coordinator.data?.kind!=='semantic_coordinator'||coordinator.data.jobId!==S.jobId||coordinator.data.authorizationId!==old.data.policy.authorizationId||coordinator.data.cohortHash!==old.data.cohortHash||!date(coordinator.updateTime)||!Array.isArray(historicalRawChunks)||!equal(historicalRawChunks.map(r=>r.path),first.data.rawChunks))failure();
 for(const r of historicalRawChunks)if(r.data?.kind!=='semantic_raw'||!date(r.updateTime)||r.data.sha256!==semanticHash(r.data.text))failure();
 let historicalRawResponse;try{historicalRawResponse=JSON.parse(historicalRawChunks.map(r=>r.data.text).join(''));}catch{failure();}if(semanticHash(historicalRawResponse)!==S.firstRawHash)failure();
 const expectedSchema=semanticSchemaForPhase('extract',{sources:S.sourceIds.map(id=>({id})),catalogue:{groups:[]}});
 if(receipt.binding.newContract.wireVersion!==semanticWireSchemaVersion||receipt.binding.newContract.promptHash!==semanticPromptHash||receipt.binding.newContract.schemaHash!==semanticHash(expectedSchema)||!equal(receipt.binding.newContract.schema,expectedSchema))failure();
 const nextAttempt=rejectedSemanticAttemptIdentity(receipt);
 if(nextAttempt.attemptId===S.oldBatchId||nextAttempt.sequence!==2||nextAttempt.outboxId!==semanticHash({jobId:S.jobId,sequence:2}))failure();
 const authorization={version:semanticCorrectiveCapabilityVersion,jobId:S.jobId,receiptPath:rejectedSemanticRecoveryPath(),receiptHash:receipt.receiptHash,preparationInput:originalInput(preparationInput),trustedReview:structuredClone(trustedReview),historicalRecovery:{path:history.path,updateTime:history.updateTime,receiptHash:history.data.receiptHash},firstResult:{path:first.path,updateTime:first.updateTime,dataHash:semanticHash(first.data)},authorizationLedger:{path:ledger.path,updateTime:ledger.updateTime,dataHash:semanticHash(ledger.data)},nextAttempt,approval:structuredClone(approval)};
 const authorizationHash=semanticHash(authorization),path=semanticCorrectiveCapabilityPath(receipt),capability={kind:'semantic_corrective_capability',version:semanticCorrectiveCapabilityVersion,authorization,authorizationHash,state:'available',consumption:null};
 const correctiveRecovery={version:semanticCorrectiveCapabilityVersion,capabilityPath:path,authorizationHash,receiptPath:authorization.receiptPath,receiptHash:receipt.receiptHash,attemptId:nextAttempt.attemptId,sequence:2};
 const preparedJob={...structuredClone(old.data),status:'prepared',reason:'OWNER_AUTHORIZED_FINITE_CORRECTION_AWAITING_DELIVERY',batch:null,callsUsed:2,correctiveRecovery,dispatch:{sequence:2,outboxId:nextAttempt.outboxId,status:'pending',reason:null},updatedAt:now};
 const prepared=prepareRejectedSemanticAttemptRecovery({...preparationInput,now},{trustedReview});if(!prepared.report.ready)failure();
 const checks=[...new Map([...prepared.plan.checks,{path,updateTime:null},{path:history.path,updateTime:history.updateTime},{path:coordinator.path,updateTime:coordinator.updateTime},...historicalRawChunks.map(r=>({path:r.path,updateTime:r.updateTime}))].map(c=>[c.path,c])).values()],writes=[{path:authorization.receiptPath,data:receipt,createOnly:true},{path,data:capability,createOnly:true},{path:old.path,data:preparedJob,updateTime:old.updateTime}];
 return {kind:'semantic_corrective_owner_preparation',executable:false,executionAuthorized:false,requiresOwnerApprovalAndApplication:true,path,capability,preparedJob,oldJobSnapshot:authorization.preparationInput.job,receiptPath:authorization.receiptPath,receiptData:receipt,checks,writes,preCommitRechecks:prepared.plan.preCommitRechecks,queryRechecks:prepared.plan.queryRechecks,providerCalls:0,writesPerformed:0};
}
export function validateSemanticCorrectiveCapability({capability,receipt,job,policy,ledger,firstResult,historicalRecovery,coordinator,now,forSubmission=false}){
 try{
  if(capability?.kind!=='semantic_corrective_capability'||capability.version!==semanticCorrectiveCapabilityVersion||!hex(capability.authorizationHash)||semanticHash(capability.authorization)!==capability.authorizationHash||!receiptIntegrity(receipt))return null;
  const a=capability.authorization,old=a.preparationInput?.job,ref=job.correctiveRecovery;
  if(!date(now)||a.version!==semanticCorrectiveCapabilityVersion||a.jobId!==S.jobId||job.id!==S.jobId||a.receiptPath!==rejectedSemanticRecoveryPath()||a.receiptHash!==receipt.receiptHash||!validateRejectedSemanticAttemptRecovery(receipt,a.preparationInput,{trustedReview:a.trustedReview})||!equal(a.nextAttempt,rejectedSemanticAttemptIdentity(receipt))||!checkedApproval(a.approval,receipt,policy,now)||!old||semanticHash(old.data)!==receipt.binding.job.dataHash||old.updateTime!==S.jobUpdateTime)return null;
  if(!ref||ref.version!==semanticCorrectiveCapabilityVersion||ref.authorizationHash!==capability.authorizationHash||ref.capabilityPath!==semanticCorrectiveCapabilityPath(receipt)||ref.receiptPath!==a.receiptPath||ref.receiptHash!==receipt.receiptHash||ref.attemptId!==a.nextAttempt.attemptId||ref.sequence!==2)return null;
  if(job.promptHash!==old.data.promptHash||job.policyHash!==S.policyHash||semanticHash(job.policy)!==S.policyHash||semanticHash(policy)!==S.policyHash||job.cohortHash!==old.data.cohortHash||semanticHash(job.pins)!==job.cohortHash||!equal(job.pins,old.data.pins)||job.maxCalls!==127||job.total!==499||job.callsUsed<2||job.callsUsed>127||job.cursor<8||job.cursor>499||Date.parse(policy.expiresAt)<=Date.parse(now))return null;
  if(receipt.binding.newContract.promptHash!==semanticPromptHash||receipt.binding.newContract.wireVersion!==semanticWireSchemaVersion||receipt.binding.newContract.schemaHash!==semanticHash(semanticSchemaForPhase('extract',{sources:S.sourceIds.map(id=>({id})),catalogue:{groups:[]}})))return null;
  if(!historyMatches(historicalRecovery,firstResult,ledger,job)||historicalRecovery.path!==a.historicalRecovery.path||historicalRecovery.updateTime!==a.historicalRecovery.updateTime||historicalRecovery.data.receiptHash!==a.historicalRecovery.receiptHash||firstResult.path!==a.firstResult.path||firstResult.updateTime!==a.firstResult.updateTime||semanticHash(firstResult.data)!==a.firstResult.dataHash||ledger.path!==a.authorizationLedger.path||ledger.updateTime!==a.authorizationLedger.updateTime||semanticHash(ledger.data)!==a.authorizationLedger.dataHash)return null;
  if(coordinator?.data.kind!=='semantic_coordinator'||coordinator.data.jobId!==job.id||coordinator.data.authorizationId!==job.policy.authorizationId||coordinator.data.cohortHash!==job.cohortHash)return null;
  if(capability.state==='available'){
   if(capability.consumption!==null||Date.parse(now)>=Date.parse(receipt.validUntil)||job.status!=='prepared'||job.phase!=='extract'||job.cursor!==8||job.callsUsed!==2||job.batch!==null||job.dispatch.sequence!==2||job.dispatch.outboxId!==a.nextAttempt.outboxId||ref.consumptionHash)return null;
  }else if(capability.state==='consumed'){
   const c=capability.consumption;
   if(!c||c.jobId!==job.id||c.attemptId!==ref.attemptId||c.callsUsed!==3||c.phase!=='extract'||c.cursor!==8||c.promptHash!==semanticPromptHash||c.authorizationHash!==capability.authorizationHash||!hex(c.bindingHash)||ref.consumptionHash!==semanticHash(c)||job.callsUsed<3)return null;
   if(forSubmission&&job.cursor<16)return null;
   if(forSubmission&&job.cursor>=16&&(job.alignmentCheckpoint?.version!=='semantic-corrective-alignment-checkpoint-v1'||job.alignmentCheckpoint.status!=='released'||job.alignmentCheckpoint.callsUsed!==3||job.alignmentCheckpoint.cursor!==16||job.alignmentCheckpoint.capabilityAuthorizationHash!==capability.authorizationHash))return null;
  }else return null;
  const transitionHash=semanticHash({version:'semantic-corrective-prompt-transition-v1',originalTransitionHash:historicalRecovery.data.transitionHash,authorizationHash:capability.authorizationHash,fromPromptHash:job.promptHash,throughPromptHash:S.oldPromptHash,toPromptHash:semanticPromptHash});
  return {authorization:a,transitionHash,consumeRequired:capability.state==='available',attemptId:a.nextAttempt.attemptId,capabilityAuthorizationHash:capability.authorizationHash};
 }catch{return null;}
}
export function consumeSemanticCorrectiveCapability(capability,{jobId,binding,bindingHash,attemptId,now}){
 if(capability?.state!=='available'||jobId!==S.jobId||attemptId!==capability.authorization.nextAttempt.attemptId||binding?.jobId!==jobId||binding.phase!=='extract'||binding.cursor!==8||binding.promptHash!==semanticPromptHash||semanticHash(binding)!==bindingHash)failure();
 return {...structuredClone(capability),state:'consumed',consumption:{jobId,attemptId,phase:'extract',cursor:8,callsUsed:3,promptHash:semanticPromptHash,authorizationHash:capability.authorizationHash,bindingHash,consumedAt:now}};
}
