import {hash,nowISO,fail,identifier,key,ensure,cas,event} from './reels-runtime.mjs';
import {projectExecution} from './reels-model.mjs';

const actions={apply_saved_result:'Aplicar resultado salvo e verificado',collect_saved_operation:'Consultar operação externa já registrada'};
const recoverable=['uncertain','applying','waiting','collecting'];
export function reconciliationEvidence(job){
 const matches=proof=>proof?.schemaVersion===1&&['acquisition','transcription','analysis'].includes(job.stage)&&['executionId','reelId','operationId','stage','owner'].every(field=>{const value=field==='executionId'?job.id:job[field];return typeof value==='string'&&value.length>0&&proof[field]===value;});
 const result=!!job.rawResult&&matches(job.resultEvidence)&&job.resultEvidence.resultHash===hash(job.rawResult);
 const operation=job.stage==='transcription'&&typeof job.operationName==='string'&&job.operationName.length>0&&matches(job.operationEvidence)&&job.operationEvidence.operationName===job.operationName;
 return {result,operation};
}
export async function reconciliationOwnership(store,job,video){
 const current=video?.reels_v2,stages=['acquisition','transcription','analysis'];
 const same=!!current&&current.operationId===job.operationId,exact=same&&current.executionId===job.id;
 if(exact)return {exact:true,successor:false};
 const start=stages.indexOf(job.stage),end=stages.indexOf(current?.stage);
 if(!same||start<0||end<=start)return {exact:false,successor:false};
 let predecessor=job.id;
 for(const stage of stages.slice(start+1,end+1)){
  const id=hash({operationId:job.operationId,reelId:job.reelId,stage}),next=(await store.get('reels_executions/'+id))?.data;
  if(!next||next.id!==id||next.operationId!==job.operationId||next.reelId!==job.reelId||next.stage!==stage||next.predecessorId!==predecessor)return {exact:false,successor:false};
  predecessor=id;
 }
 return {exact:false,successor:current.executionId===predecessor};
}
export class ReelsReconciliation {
 constructor({repository,store=repository.store,pipeline,processingEnabled=false,clock=Date.now}){Object.assign(this,{repository,store,pipeline,clock});this.processingEnabled=processingEnabled===true;}
 async snapshot(id){
  identifier(id,'Execução');const snapshot=await this.store.get('reels_executions/'+id);
  if(!snapshot)throw fail('NOT_FOUND','Execução não encontrada.',404);
  const job=snapshot.data;if(job.id!==id)throw fail('EXECUTION_IDENTITY_MISMATCH','Identidade da execução não confere.',409);
  return snapshot;
 }
 async inspect(id){
  const snapshot=await this.snapshot(id),job=snapshot.data,video=await this.repository.raw(job.reelId),proof=reconciliationEvidence(job);
  const ownership=await reconciliationOwnership(this.store,job,video),owned=ownership.exact;
  const reason=video?.import_hold?.active===true?'MIGRATION_HOLD':!owned&&!ownership.successor?'EXECUTION_SUPERSEDED':!recoverable.includes(job.status)?'EXECUTION_NOT_RECOVERABLE':null;
  const available=reason?[]:[...(proof.result&&['uncertain','applying'].includes(job.status)&&(owned||ownership.successor)?['apply_saved_result']:[]),...(!proof.result&&proof.operation&&owned&&['uncertain','waiting','collecting'].includes(job.status)?['collect_saved_operation']:[])];
  return {execution:projectExecution(job),evidence:{savedResult:proof.result?'verified':job.rawResult?'unverified':'absent',savedOperation:proof.operation?'verified':job.operationName?'unverified':'absent',currentExecution:owned,verifiedSuccessor:ownership.successor,version:snapshot.updateTime},actions:available.map(action=>({action,label:actions[action],enabled:this.processingEnabled&&typeof this.pipeline?.recover==='function',reason:!this.processingEnabled?'PROCESSING_DISABLED':typeof this.pipeline?.recover!=='function'?'RECOVERY_ADAPTER_REQUIRED':null})),blockedReason:reason??(!available.length?'VERIFIABLE_EVIDENCE_REQUIRED':null),processingAllowed:this.processingEnabled,observedAt:nowISO(this.clock),note:'Ausência de prova local não confirma falha externa. A publicação, os candidatos e a ocupação permanecem preservados.'};
 }
 async command(input){
  if(!input||Object.keys(input).some(field=>!['executionId','idempotencyKey','action'].includes(field)))throw fail('INVALID_RECONCILIATION','Envie somente execução, ação e chave idempotente.');
  const {executionId,action}=input;identifier(executionId,'Execução');key(input.idempotencyKey);
  if(!Object.hasOwn(actions,action))throw fail('INVALID_RECONCILIATION_ACTION','Ação de conciliação inválida.');
  if(!this.processingEnabled)throw fail('PROCESSING_DISABLED','Conciliação aplicada desabilitada nesta entrega.',423);
  const id=hash('reconciliation:'+input.idempotencyKey),path='reels_reconciliations/'+id,fingerprint=hash({executionId,action});
  let saved=await this.store.get(path);
  if(saved&&saved.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já usada para outra conciliação.',409);
  if(saved?.data.status==='completed')return this.deliverReceipt(saved.data);
  const inspection=await this.inspect(executionId),allowed=inspection.actions.find(item=>item.action===action&&item.enabled);
  if(!allowed){
   // A response can be lost after the execution finished. Recover the receipt
   // without applying or polling again, and without inferring paid failure.
   if(saved&&inspection.execution.status==='completed'){
    saved=await cas(this.store,path,()=>({status:'completed',executionStatus:'completed',completedAt:nowISO(this.clock)}));return this.deliverReceipt(saved.data);
   }
   throw fail('RECONCILIATION_UNAVAILABLE','Não há prova verificável e posse atual para esta ação.',409);
  }
  saved=await ensure(this.store,path,{id,fingerprint,executionId,reelId:inspection.execution.reelId,action,status:'pending',createdAt:nowISO(this.clock)});
  if(saved.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já usada para outra conciliação.',409);
  if(saved.data.status==='completed')return this.deliverReceipt(saved.data);
  // Recovery is fenced by the execution version. Its only external continuation
  // is a durable poll outbox; the web never installs provider adapters.
  await this.pipeline.recover({executionId,action,evidenceVersion:inspection.evidence.version,recoveryId:id});
  const current=await this.snapshot(executionId),status=current.data.status;
  saved=await cas(this.store,path,()=>({status:'completed',executionStatus:status,completedAt:nowISO(this.clock)}));
  return this.deliverReceipt(saved.data);
 }
 async deliverReceipt(data){
  await event(this.store,{id:hash(data.id+':completed'),operationId:data.id,reelId:data.reelId??null,type:'reconciliation_completed',message:'Comando de conciliação concluído; consulte o percurso da execução.',executionId:data.executionId},this.clock);
  return {reconciliation:this.receipt(data)};
 }
 receipt(data){return {id:data.id,executionId:data.executionId,action:data.action,status:data.status,executionStatus:data.executionStatus??null,createdAt:data.createdAt,completedAt:data.completedAt??null};}
}
