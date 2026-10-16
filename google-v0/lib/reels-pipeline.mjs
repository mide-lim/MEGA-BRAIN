import {randomUUID} from 'node:crypto';
import {hash,nowISO,fail,ensure,cas,event,safeError,queueOutbox} from './reels-runtime.mjs';
export const STAGES=['acquisition','transcription','analysis'];
export const executionId=(operationId,reelId,stage)=>hash({operationId,reelId,stage});
export class ReelsPipeline {
 constructor({repository,store=repository.store,operations,processingEnabled=false,clock=Date.now,effectiveCapacity={acquisition:1,transcription:1,analysis:1},onQueued,onPublished,claimTimeoutMs=900000}){if(!Number.isInteger(claimTimeoutMs)||claimTimeoutMs<60000||claimTimeoutMs>3600000)throw Error('Prazo de claim inválido.');Object.assign(this,{repository,store,operations,clock,effectiveCapacity,onQueued,onPublished,claimTimeoutMs});this.processingEnabled=processingEnabled===true;}
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
  const owner=randomUUID();try{snapshot=await this.store.patch(path,{status:'running',owner,startedAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});}catch(error){if(error.status===412)return {status:'claimed',reason:'EXECUTION_IN_PROGRESS',duplicate:true};throw error;}
  job=snapshot.data;let submitted=false;
  try{
   await this.markVideo(job,'running');
   const video=await this.repository.raw(job.reelId);if(!video)throw Object.assign(fail('NOT_FOUND','Reel ausente.',404),{definitive:true});
   const method={acquisition:'acquire',transcription:'transcribe',analysis:'analyze'}[job.stage];if(typeof this.operations?.[method]!=='function')throw Object.assign(fail('ADAPTER_MISSING','Adaptador não disponível.',503),{definitive:true});
   snapshot=await this.store.patch(path,{status:'submitting',submittedAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});submitted=true;
   const recordPreparedAudio=async changes=>{await cas(this.store,'videos/'+job.reelId,()=>changes);};
   const result=await this.operations[method]({video,videoId:job.reelId,reelId:job.reelId,executionId:id,claim:{owner,updateTime:snapshot.updateTime},recordPreparedAudio});
   if(result?.pending===true||result?.operationName){if(typeof result.operationName!=='string'||!result.operationName)throw Error('Nome de operação ausente.');
    await this.store.patch(path,{status:'waiting',operationName:result.operationName,providerChanges:result.changes??{},waitingAt:nowISO(this.clock)},{updateTime:snapshot.updateTime});
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
  const pollOwner=randomUUID();try{snapshot=await this.store.patch(path,{status:'collecting',pollOwner},{updateTime:snapshot.updateTime});}catch(error){if(error.status===412)return {status:'collecting',duplicate:true};throw error;}
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
  const snapshot=await this.store.patch('reels_executions/'+job.id,{status:'applying',rawResult:result,resultSavedAt:nowISO(this.clock)},{updateTime});
  return this.apply(snapshot.data);
 }
 async apply(job){
  const result=job.rawResult;if(!result)throw fail('RESULT_MISSING','Resultado preservado ausente.',409);
  if(job.stage==='analysis'&&result.valid!==true){const candidateChanges=Object.fromEntries(Object.entries(result.changes??{}).filter(([key])=>key.startsWith('candidate_analysis_')||['analysis_candidate','analysis_review_reasons','review_reasons'].includes(key)));if(Object.keys(candidateChanges).length)await cas(this.store,'videos/'+job.reelId,()=>candidateChanges);await this.markVideo(job,'failed',{candidate:{available:true,state:'invalid',reason:'QUALITY_VALIDATION_FAILED',executionId:job.id}});
   await this.release(job);await this.emit(job,'candidate_rejected');await cas(this.store,'reels_executions/'+job.id,()=>({status:'failed',failedAt:nowISO(this.clock),error:{code:'QUALITY_VALIDATION_FAILED',message:'Resultado requer revisão.'}}));return {status:'failed',published:false};}
  // Publication fields require explicit valid proof. A candidate never replaces them.
  const changes={...(job.providerChanges??{}),...(result.changes??{})};delete changes.reels_v2;
  if(job.stage!=='analysis'){for(const key of ['analysis','publication','published_analysis','analysis_revision'])delete changes[key];}
  await cas(this.store,'videos/'+job.reelId,video=>video.reels_v2?.operationId&& (video.reels_v2.operationId!==job.operationId||video.reels_v2.executionId!==job.id)?null:({...changes,...(job.stage==='analysis'&&result.publication?{publication:result.publication}:{}),reels_v2:{...(video.reels_v2??{}),status:'completed',stage:job.stage,executionId:job.id,operationId:job.operationId,updatedAt:nowISO(this.clock)}}));
  const nextStage=STAGES[STAGES.indexOf(job.stage)+1];
  if(nextStage){const nextId=executionId(job.operationId,job.reelId,nextStage);await ensure(this.store,'reels_executions/'+nextId,{id:nextId,operationId:job.operationId,reelId:job.reelId,stage:nextStage,status:'queued',attempt:1,predecessorId:job.id,createdAt:nowISO(this.clock)});
   await this.markVideo({...job,stage:nextStage,id:nextId},'queued',{},job.id);const next=await this.store.get('reels_executions/'+nextId);await queueOutbox(this.store,next.data,{onQueued:this.onQueued,clock:this.clock});}
  await this.repository.refresh?.(job.reelId);
  if(job.stage==='analysis'&&this.onPublished)await this.onPublished(job);
  await this.release(job);await this.emit(job,'stage_completed');
  await cas(this.store,'reels_executions/'+job.id,data=>data.status==='completed'?null:{status:'completed',completedAt:nowISO(this.clock)});
  return {status:'completed',executionId:job.id,nextStage:nextStage??null};
 }
 async markVideo(job,status,extra={},predecessorId=null){await cas(this.store,'videos/'+job.reelId,video=>{const current=video.reels_v2;if(current?.operationId&&(current.operationId!==job.operationId||current.executionId!==job.id&&current.executionId!==predecessorId))return null;if(current?.executionId===job.id&&status==='queued'&&current.status!=='queued')return null;return {reels_v2:{...(video.reels_v2??{}),status,stage:job.stage,executionId:job.id,operationId:job.operationId,updatedAt:nowISO(this.clock),...extra}};});await this.repository.refresh?.(job.reelId);}
 async failure(job,error,{submitted}){
  const status=submitted&&error.definitive!==true?'uncertain':'failed',diagnostic=safeError(error);
  await cas(this.store,'reels_executions/'+job.id,data=>data.status==='completed'||data.status==='applying'||data.status==='waiting'?null:{status,error:diagnostic,failedAt:nowISO(this.clock)});
  const current=await this.store.get('reels_executions/'+job.id);if(current.data.status==='completed')return {status:'completed',executionId:job.id};if(current.data.status==='waiting'){await queueOutbox(this.store,current.data,{onQueued:this.onQueued,clock:this.clock,poll:true,sequence:current.data.pollSequence??0});return {status:'waiting',operationName:current.data.operationName};}if(current.data.status==='applying')return {status:'applying',reason:'RESULT_SAVED_RECONCILIATION_REQUIRED'};
  await this.markVideo(job,status,{error:{...diagnostic,uncertain:status==='uncertain',retryable:status==='failed'}});if(status==='failed')await this.release(job);await this.emit(job,'stage_'+status,'error');return {status,executionId:job.id,error:diagnostic};
 }
 async emit(job,type,level='info'){await event(this.store,{id:hash(job.id+':'+type),reelId:job.reelId,stage:job.stage,operationId:job.operationId,type,level,message:type==='stage_uncertain'?'Operação externa sem confirmação; não repetir.':'Estado da etapa atualizado.'},this.clock);}
}
