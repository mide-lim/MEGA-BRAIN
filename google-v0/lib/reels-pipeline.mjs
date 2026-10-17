import {randomUUID} from 'node:crypto';
import {qualityPublicationRevision,verifyPublicationQualityReceipt} from './reels-quality-gate.mjs';
import {reconciliationEvidence,reconciliationOwnership} from './reels-reconciliation.mjs';
import {hash,nowISO,fail,ensure,cas,event,safeError,queueOutbox} from './reels-runtime.mjs';
export const STAGES=['acquisition','transcription','analysis'];
export const executionId=(operationId,reelId,stage)=>hash({operationId,reelId,stage});
const workerFor=stage=>STAGES.includes(stage)?'reels-'+stage:null;
const publicationTags=analysis=>{const result=[],seen=new Set();for(const value of Array.isArray(analysis?.knowledge?.keywords)?analysis.knowledge.keywords:[]){const term=typeof value==='string'?value:value?.term;if(typeof term!=='string'||!term.trim()||term.trim().length>120)continue;const text=term.trim(),key=text.normalize('NFKC').toLocaleLowerCase('pt-BR');if(seen.has(key))continue;seen.add(key);result.push(text);if(result.length===100)break;}return result;};
const diagnosticFor=(job,status,error)=>({...safeError(error),stage:job.stage,worker:job.worker??workerFor(job.stage),destination:status==='uncertain'?'reconcile':'retry',uncertain:status==='uncertain',retryable:status==='failed'});
export class ReelsPipeline {
 constructor({repository,store=repository.store,operations,processingEnabled=false,clock=Date.now,effectiveCapacity={acquisition:1,transcription:1,analysis:1},onQueued,onPublished,claimTimeoutMs=900000,requiredQualityPolicyVersion=null}){if(!Number.isInteger(claimTimeoutMs)||claimTimeoutMs<60000||claimTimeoutMs>3600000)throw Error('Prazo de claim inválido.');Object.assign(this,{repository,store,operations,clock,effectiveCapacity,onQueued,onPublished,claimTimeoutMs,requiredQualityPolicyVersion});this.processingEnabled=processingEnabled===true;}
 async capacity(job,{collect=false}={}){
  const path='reels_controls/'+job.stage;await ensure(this.store,path,{id:job.stage,paused:false,desiredConcurrency:1,effectiveConcurrency:0,active:[],appliedCommands:[]});
  let allowed=false;await cas(this.store,path,data=>{allowed=false;const active=data.active??[],limit=Math.min(data.desiredConcurrency??1,this.effectiveCapacity[job.stage]??0);
   if(data.paused&&!collect)return null;if(active.includes(job.id)){allowed=true;return null;}if(active.length>=limit)return null;allowed=true;return {active:[...active,job.id],effectiveConcurrency:limit,observedAt:nowISO(this.clock)};});return allowed;
 }
 async release(job){await cas(this.store,'reels_controls/'+job.stage,data=>({active:(data.active??[]).filter(id=>id!==job.id),observedAt:nowISO(this.clock)}));}
 async run({executionId:id}){
  if(!this.processingEnabled)throw fail('PROCESSING_DISABLED','Processamento desabilitado.',423);
  const path='reels_executions/'+id;let snapshot=await this.store.get(path);if(!snapshot)throw fail('NOT_FOUND','Execução ausente.',404);let job=snapshot.data;
  if(job.status==='applying')return this.apply(job);
  if(['running','submitting'].includes(job.status)){
   if(Number.isFinite(Date.parse(job.startedAt))&&this.clock()-Date.parse(job.startedAt)<this.claimTimeoutMs)return {status:job.status,reason:'EXECUTION_IN_PROGRESS',executionId:id};
   // A dead executor is not proof a paid operation did not happen. Keep its
   // capacity reserved and expose reconciliation rather than resubmit it.
   return this.failure(job,Object.assign(Error('Executor sem confirmação.'),{code:'EXECUTOR_INTERRUPTED_UNCONFIRMED'}),{submitted:true});
  }
  if(job.status==='waiting'&&job.operationName)await queueOutbox(this.store,job,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:job.pollSequence??0});
  if(['completed','failed','uncertain'].includes(job.status))await this.emit(job,job.status==='completed'?'stage_completed':'stage_'+job.status,job.status==='completed'?'info':'error');
  if(job.status!=='queued')return {status:job.status,duplicate:true,executionId:id};
  if(!await this.capacity(job))return {status:'waiting',reason:'TECHNICAL_BACKPRESSURE',executionId:id};
  const owner=randomUUID();try{snapshot=await this.store.patch(path,{status:'running',owner,worker:workerFor(job.stage),attempt:Number.isSafeInteger(job.attempt)&&job.attempt>=1?job.attempt:1,queuedAt:job.queuedAt??job.createdAt??null,startedAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});}catch(error){if(error.status===412)return {status:'claimed',reason:'EXECUTION_IN_PROGRESS',duplicate:true};throw error;}
  job=snapshot.data;let submitted=false;
  try{
   await this.markVideo(job,'running');
   const video=await this.repository.raw(job.reelId);if(video?.import_hold?.active===true||video?.reels_v2?.operationId&&(video.reels_v2.operationId!==job.operationId||video.reels_v2.executionId!==job.id))throw Object.assign(fail('EXECUTION_SUPERSEDED','Execução não possui mais o Reel.',409),{definitive:true});if(!video)throw Object.assign(fail('NOT_FOUND','Reel ausente.',404),{definitive:true});
   const method={acquisition:'acquire',transcription:'transcribe',analysis:'analyze'}[job.stage];if(typeof this.operations?.[method]!=='function')throw Object.assign(fail('ADAPTER_MISSING','Adaptador não disponível.',503),{definitive:true});
   snapshot=await this.store.patch(path,{status:'submitting',submittedAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});submitted=true;
   const recordPreparedAudio=async changes=>{await cas(this.store,'videos/'+job.reelId,()=>changes);};
   const result=await this.operations[method]({video,videoId:job.reelId,reelId:job.reelId,executionId:id,claim:{owner,updateTime:snapshot.updateTime},recordPreparedAudio});
   if(result?.pending===true||result?.operationName){if(typeof result.operationName!=='string'||!result.operationName)throw Error('Nome de operação ausente.');
    await this.store.patch(path,{status:'waiting',operationName:result.operationName,operationEvidence:{schemaVersion:1,executionId:job.id,reelId:job.reelId,operationId:job.operationId,stage:job.stage,owner:job.owner,operationName:result.operationName},providerChanges:result.changes??{},waitingAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});
    await this.markVideo(job,'waiting');await this.emit(job,'stage_waiting');await queueOutbox(this.store,{...job,operationName:result.operationName},{onQueued:this.onQueued,clock:this.clock,poll:true});return {status:'waiting',operationName:result.operationName};}
   return await this.saveAndApply(job,result,snapshot.updateTime);
  }catch(error){return this.failure(job,error,{submitted});}
 }
 async collect({executionId:id}){
  if(!this.processingEnabled)throw fail('PROCESSING_DISABLED','Processamento desabilitado.',423);
  const path='reels_executions/'+id;let snapshot=await this.store.get(path);if(!snapshot)throw fail('NOT_FOUND','Execução ausente.',404);const job=snapshot.data;
  if(job.status==='applying')return this.apply(job);
  // Polling reads the same saved external operation. Resuming a collecting
  // delivery never submits STT again, including after an executor crash.
  if(!['waiting','collecting'].includes(job.status)||!job.operationName)return {status:job.status,duplicate:true};
  if(!reconciliationEvidence(job).operation)throw fail('EVIDENCE_UNPROVEN','Operação salva sem vínculo demonstrado.',409);
  const video=await this.repository.raw(job.reelId);if(video?.import_hold?.active===true||video?.reels_v2?.operationId&&(video.reels_v2.operationId!==job.operationId||video.reels_v2.executionId!==job.id))throw fail('EXECUTION_SUPERSEDED','Coleta não possui mais o Reel.',409);
  const pollOwner=randomUUID();try{snapshot=await this.store.patch(path,{status:'collecting',pollOwner,worker:workerFor(job.stage)},{updateTime:snapshot.updateTime});}catch(error){if(error.status===412)return {status:'collecting',duplicate:true};throw error;}
  try{const result=await this.operations.pollTranscription({operationName:job.operationName,videoId:job.reelId,reelId:job.reelId,executionId:id,claim:{owner:job.owner,updateTime:snapshot.updateTime}});
   if(result?.pending){await this.store.patch(path,{status:'waiting',pollSequence:(job.pollSequence??0)+1},{updateTime:snapshot.updateTime});await queueOutbox(this.store,job,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:(job.pollSequence??0)+1});return {status:'waiting'};}
   return await this.saveAndApply(job,result,snapshot.updateTime);
  }catch(error){
   // A failed acknowledgement may follow a successful save. Recover from the
   // durable state before deciding whether another poll needs scheduling.
   const current=await this.store.get(path);
   if(current.data.status==='applying')return this.apply(current.data);
   if(['completed','failed','uncertain'].includes(current.data.status))return {status:current.data.status,executionId:id};
   if(current.data.status==='waiting'){await queueOutbox(this.store,current.data,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:current.data.pollSequence??0});return {status:'waiting'};}
   if(current.data.pollOwner!==pollOwner)return {status:current.data.status,duplicate:true};
   if(error.definitive!==true){const sequence=(current.data.pollSequence??0)+1;await this.store.patch(path,{status:'waiting',pollSequence:sequence,lastCollectionError:safeError(error)},{updateTime:current.updateTime});await queueOutbox(this.store,current.data,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence});return {status:'waiting',reason:'COLLECTION_UNAVAILABLE'};}
   return this.failure(job,error,{submitted:true});
  }
 }
 async saveAndApply(job,result,updateTime){
  if(!result||typeof result!=='object')throw Error('Resultado ausente.');
  // Persist the entire adapter receipt before any publication or next-stage outbox.
  const snapshot=await this.store.patch('reels_executions/'+job.id,{status:'applying',rawResult:result,resultEvidence:{schemaVersion:1,executionId:job.id,reelId:job.reelId,operationId:job.operationId,stage:job.stage,owner:job.owner,resultHash:hash(result)},resultSavedAt:nowISO(this.clock)},{updateTime});
  return this.apply(snapshot.data);
 }
 async recover({executionId:id,action,evidenceVersion,recoveryId}){
  if(!this.processingEnabled)throw fail('PROCESSING_DISABLED','Processamento desabilitado.',423);
  const snapshot=await this.store.get('reels_executions/'+id);if(!snapshot)throw fail('NOT_FOUND','Execução ausente.',404);
  if(typeof evidenceVersion!=='string'||snapshot.updateTime!==evidenceVersion)throw fail('EVIDENCE_CHANGED','Evidência mudou; confira novamente.',409);
  const job=snapshot.data,video=await this.repository.raw(job.reelId),ownership=await reconciliationOwnership(this.store,job,video);
  if(video?.import_hold?.active===true||!(ownership.exact||action==='apply_saved_result'&&ownership.successor))throw fail('RECONCILIATION_OWNERSHIP','Posse atual não corresponde à execução.',409);
  const proof=action==='apply_saved_result'?job.resultEvidence:action==='collect_saved_operation'?job.operationEvidence:null;
  if(!proof||proof.schemaVersion!==1||proof.executionId!==job.id||proof.reelId!==job.reelId||proof.operationId!==job.operationId||proof.stage!==job.stage||!job.owner||proof.owner!==job.owner)throw fail('EVIDENCE_UNPROVEN','Vínculo da evidência não demonstrado.',409);
  if(action==='apply_saved_result'){
   if(!['applying','uncertain'].includes(job.status)||!job.rawResult||proof.resultHash!==hash(job.rawResult))throw fail('EVIDENCE_UNPROVEN','Resultado salvo sem prova válida.',409);
   if(job.status!=='applying')await this.store.patch('reels_executions/'+id,{status:'applying'},{updateTime:snapshot.updateTime});
   return this.apply(job);
  }
  if(action!=='collect_saved_operation'||job.stage!=='transcription'||!['waiting','collecting','uncertain'].includes(job.status)||!job.operationName||proof.operationName!==job.operationName)throw fail('EVIDENCE_UNPROVEN','Operação salva sem prova válida.',409);
  // The web has no provider adapters: resume the durable polling task only.
  if(typeof recoveryId!=='string'||!/^[a-f0-9]{64}$/.test(recoveryId))throw fail('INVALID_RECOVERY_ID','Identidade de conciliação obrigatória.',409);
  const resumed=job.recoveryPollId===recoveryId?snapshot:await this.store.patch('reels_executions/'+id,{status:'waiting',recoveryPollId:recoveryId,pollSequence:(job.pollSequence??0)+1},{updateTime:snapshot.updateTime});
  if(typeof this.onQueued!=='function')throw fail('DISPATCH_UNAVAILABLE','Coleta requer despacho autenticado.',503);
  await queueOutbox(this.store,resumed.data,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:resumed.data.pollSequence??0});
  return {status:'waiting',executionId:id,collectionQueued:true};
 }
 async apply(job){
  if(job.status==='completed')return {status:'completed',executionId:job.id,duplicate:true};
  const video=await this.repository.raw(job.reelId),ownership=await reconciliationOwnership(this.store,job,video);
  if(!video||video.import_hold?.active===true||!ownership.exact&&!ownership.successor)throw fail('EXECUTION_SUPERSEDED','Execução não possui mais o Reel.',409);
  if(!reconciliationEvidence(job).result)throw fail('EVIDENCE_UNPROVEN','Resultado sem vínculo demonstrado.',409);
  const result=job.rawResult;if(!result)throw fail('RESULT_MISSING','Resultado preservado ausente.',409);
  let qualityReceipt=null,qualityProposal=null;
  if(job.stage==='analysis'&&this.requiredQualityPolicyVersion==='gate_v2'){
   qualityProposal=result.qualityPublication;
   if(result.valid!==true||qualityProposal?.policyVersion!=='gate_v2'||!qualityProposal.qualityReceipt?.receiptId)return this.rejectCandidate(job,result,{state:result.quality?.state==='invalid'?'invalid':'inconclusive'});
   qualityReceipt=(await this.store.get('reels_quality_receipts/'+qualityProposal.qualityReceipt.receiptId))?.data;
   const proposed={...video,...result.changes,publication:{...(video.publication??{}),qualityPolicyVersion:'gate_v2',qualityReceipt:qualityProposal.qualityReceipt}};
   if(!verifyPublicationQualityReceipt({video:proposed,receipt:qualityReceipt}).trusted)return this.rejectCandidate(job,result,{reason:'QUALITY_RECEIPT_UNVERIFIED',state:'inconclusive'});
  }
  if(job.stage==='analysis'&&result.valid!==true)return this.rejectCandidate(job,result,{state:result.quality?.state==='inconclusive'?'inconclusive':'invalid'});
  // Publication fields require explicit valid proof. A candidate never replaces them.
  const changes={...(job.providerChanges??{}),...(result.changes??{})};delete changes.reels_v2;
  if(job.stage!=='analysis'){for(const key of ['analysis','publication','published_analysis','analysis_revision'])delete changes[key];}
  let publicationConflict=false,ownershipConflict=false;
  await cas(this.store,'videos/'+job.reelId,current=>{
   publicationConflict=false;ownershipConflict=false;
   if(current.reels_v2?.operationId&&(current.reels_v2.operationId!==job.operationId||current.reels_v2.executionId!==job.id)){ownershipConflict=true;return null;}
   if(qualityProposal){
    const proposed={...current,...changes,publication:{...(current.publication??{}),qualityPolicyVersion:'gate_v2',qualityReceipt:qualityProposal.qualityReceipt}};
    const already=current.analysis_key===qualityProposal.publicationIdentity?.key&&String(current.analysis_generation)===String(qualityProposal.publicationIdentity?.generation)&&current.publication?.qualityReceipt?.receiptId===qualityProposal.qualityReceipt.receiptId&&verifyPublicationQualityReceipt({video:current,receipt:qualityReceipt}).trusted;
    if(!verifyPublicationQualityReceipt({video:proposed,receipt:qualityReceipt}).trusted||!already&&qualityPublicationRevision(current)!==qualityProposal.expectedPublicationRevision){publicationConflict=true;return null;}
   }
   const video=current;
   return {...changes,...(qualityProposal?{publication:{...(current.publication??{}),qualityPolicyVersion:'gate_v2',qualityReceipt:qualityProposal.qualityReceipt},candidate_quality_receipt:null}:{}),...(job.stage==='analysis'?{taxonomy_baseline_execution_id:job.id}:{}),...(job.stage==='analysis'&&video.taxonomy_baseline_execution_id!==job.id?{published_tags:publicationTags(changes.analysis)}:{}),...(job.stage==='analysis'&&video.taxonomy_baseline_execution_id!==job.id&&video.taxonomy_override?.manual!==true&&Array.isArray(changes.analysis?.categories)?{categoryIds:[...new Set(changes.analysis.categories.filter(id=>typeof id==='string'))]}:{}),...(!qualityProposal&&job.stage==='analysis'&&result.publication?{publication:result.publication}:{}),reels_v2:{...(video.reels_v2??{}),status:'completed',stage:job.stage,executionId:job.id,operationId:job.operationId,updatedAt:nowISO(this.clock)}};
  });
  if(ownershipConflict)throw fail('EXECUTION_SUPERSEDED','Execução não possui mais o Reel.',409);
  if(publicationConflict)return this.rejectCandidate(job,result,{reason:'QUALITY_PUBLICATION_REVISION_CONFLICT',state:'inconclusive'});
  const nextStage=STAGES[STAGES.indexOf(job.stage)+1];
  if(nextStage){const nextId=executionId(job.operationId,job.reelId,nextStage),queuedAt=nowISO(this.clock);await ensure(this.store,'reels_executions/'+nextId,{id:nextId,operationId:job.operationId,reelId:job.reelId,stage:nextStage,status:'queued',attempt:1,predecessorId:job.id,queuedAt,createdAt:queuedAt});
   await this.markVideo({...job,stage:nextStage,id:nextId},'queued',{},job.id);const next=await this.store.get('reels_executions/'+nextId);await queueOutbox(this.store,next.data,{onQueued:this.onQueued,clock:this.clock});}
  await this.repository.refresh?.(job.reelId);
  if(job.stage==='analysis'&&this.onPublished)await this.onPublished(job);
  await this.release(job);await this.emit(job,'stage_completed');
  await cas(this.store,'reels_executions/'+job.id,data=>data.status==='completed'?null:{status:'completed',completedAt:nowISO(this.clock)});
  return {status:'completed',executionId:job.id,nextStage:nextStage??null};
 }
 async rejectCandidate(job,result,{reason='QUALITY_VALIDATION_FAILED',state='invalid'}={}){
  const diagnostic={...diagnosticFor(job,'failed',{code:reason}),message:'Resultado salvo requer revisão; publicação anterior preservada.',destination:'review',retryable:false};
  const candidateChanges=Object.fromEntries(Object.entries(result.changes??{}).filter(([key])=>key.startsWith('candidate_analysis_')||['analysis_candidate','analysis_review_reasons','review_reasons','candidate_quality_receipt'].includes(key)));
  if(result.qualityPublication){Object.assign(candidateChanges,{analysis_candidate:result.changes?.analysis??null,candidate_analysis_key:result.changes?.analysis_key??null,candidate_analysis_generation:result.changes?.analysis_generation??null,candidate_quality_receipt:result.qualityPublication.qualityReceipt??null});}
  if(Object.keys(candidateChanges).length)await cas(this.store,'videos/'+job.reelId,video=>video.reels_v2?.operationId&&(video.reels_v2.operationId!==job.operationId||video.reels_v2.executionId!==job.id)?null:candidateChanges);
  await this.markVideo(job,'failed',{candidate:{available:true,state,reason,executionId:job.id},error:diagnostic});
  await this.release(job);await this.emit(job,'candidate_rejected');await cas(this.store,'reels_executions/'+job.id,()=>({status:'failed',failedAt:nowISO(this.clock),error:diagnostic}));
  return {status:'failed',published:false,reason,qualityState:state};
 }
 async markVideo(job,status,extra={},predecessorId=null){await cas(this.store,'videos/'+job.reelId,video=>{const current=video.reels_v2;if(current?.operationId&&(current.operationId!==job.operationId||current.executionId!==job.id&&current.executionId!==predecessorId))return null;if(current?.executionId===job.id&&status==='queued'&&current.status!=='queued')return null;return {reels_v2:{...(video.reels_v2??{}),status,stage:job.stage,worker:job.worker===workerFor(job.stage)?job.worker:null,executionId:job.id,operationId:job.operationId,updatedAt:nowISO(this.clock),...extra}};});await this.repository.refresh?.(job.reelId);}
 async failure(job,error,{submitted}){
  const status=error.requiresReconciliation===true||submitted&&error.definitive!==true?'uncertain':'failed',diagnostic=diagnosticFor(job,status,error);
  await cas(this.store,'reels_executions/'+job.id,data=>data.status==='completed'||data.status==='applying'||data.status==='waiting'?null:{status,error:diagnostic,failedAt:nowISO(this.clock)});
  const current=await this.store.get('reels_executions/'+job.id);if(current.data.status==='completed')return {status:'completed',executionId:job.id};if(current.data.status==='waiting'){await queueOutbox(this.store,current.data,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:current.data.pollSequence??0});return {status:'waiting',operationName:current.data.operationName};}if(current.data.status==='applying')return {status:'applying',reason:'RESULT_SAVED_RECONCILIATION_REQUIRED'};
  await this.markVideo(job,status,{error:{...diagnostic,uncertain:status==='uncertain',retryable:status==='failed'}});if(status==='failed')await this.release(job);await this.emit(job,'stage_'+status,'error');return {status,executionId:job.id,error:diagnostic};
 }
 async emit(job,type,level='info'){await event(this.store,{id:hash(job.id+':'+type),reelId:job.reelId,stage:job.stage,worker:job.worker??workerFor(job.stage),operationId:job.operationId,type,level,message:type==='stage_uncertain'?'Operação externa sem confirmação; não repetir.':'Estado da etapa atualizado.'},this.clock);}
}
