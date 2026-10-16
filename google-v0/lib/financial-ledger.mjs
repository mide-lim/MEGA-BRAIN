import {assertAssistedScope,verifyAssistedScope,assertAssistedJob,assertPipelineHistory} from './assisted-scope.mjs';
import {settledRetryId,settledRetryAllowed,settledRetryAuthorizationPath} from './smart-retry.mjs';
import {metadataRecoveryAllowed,recoveryAuthorizationPath,uploadRecoveryId,settledMetadataUpload} from './firestore-recovery.mjs';
import {terminalSourceFailure} from './source-hold.mjs';
import {mutateDocument} from './firestore.mjs';
import {recoverableUploadFailure} from './upload-recovery.mjs';
import {recoverableAnalysis429} from './analysis-retry.mjs';
import {batchLimits,jobLimit,validateBatch,batchUsage,batchDecision,isolatedAnalysisTimeout} from './batch-budget.mjs';
import {ongoingCostPlan} from './ongoing-costs.mjs';
// One versioned Firestore document makes reservation and claim atomic.
// A timeout never permits replay of a paid operation.
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const executionPattern=/^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const stages=new Set(['upload','transcription','analysis','media_access']);
const cents=value=>Number.isSafeInteger(value)&&value>=0;
function validate(state){
  if(!state||state.schema_version!==1||!['allocation_cents','reserve_cents','spent_cents','reserved_cents','remaining_credit_cents'].every(k=>cents(state[k])))throw new Error('Controle financeiro inválido.');
  if(!state.jobs||typeof state.jobs!=='object'||Array.isArray(state.jobs)||Object.keys(state.jobs).length>jobLimit(state))throw new Error('Livro do piloto inválido ou completo.');
  if(state.ongoing_commitment_cents!==undefined&&!cents(state.ongoing_commitment_cents))throw new Error('Compromisso persistente inválido.');
  if(state.pilot_envelope_cents!==undefined&&state.pilot_envelope_cents!==null&&(!cents(state.pilot_envelope_cents)||state.pilot_envelope_cents<1||state.pilot_envelope_cents>state.allocation_cents))throw new Error('Orçamento do piloto inválido.');
  if(Buffer.byteLength(JSON.stringify(state))>600000)throw new Error('Livro excede tamanho seguro do piloto.');
  if(state.batch){validateBatch(state.batch);batchUsage(state);}else if(Object.values(state.jobs).some(j=>j?.batch_id!==undefined))throw new Error('Execução de lote sem configuração.');
  let reserved=0;
  for(const [id,j]of Object.entries(state.jobs)){
    if(j.recovery_of!==undefined){const parent=state.jobs[j.recovery_of];const settled=j.recovery_kind==='settled_retry_v1'&&id===settledRetryId(j.recovery_of)&&parent?.status==='completed'&&!parent.recovery_of&&parent.actual_cents===parent.maximum_cents&&((j.stage==='upload'&&parent.manual_reconciliation==='terminal_metadata_estimate_accounted_user_verdict_pending')||(j.stage==='analysis'&&parent.manual_reconciliation==='confirmed_schema400_full_estimate_accounted_analysis_pending'&&j.analysis_revision===parent.analysis_revision));if(!(settled||j.stage==='upload'&&id===uploadRecoveryId(j.recovery_of)&&settledMetadataUpload(parent))||parent?.stage!==j.stage||parent.video_id!==j.video_id||parent.maximum_cents!==j.maximum_cents||parent.batch_id!==j.batch_id)throw Error('Tentativa vinculada inválida.');}
    if(j.assisted_scope_ref!==undefined&&(j.batch_id!==undefined||j.recovery_of!==undefined||!/^jobs\/assisted_upload_[A-Za-z0-9_-]{16,64}$/.test(j.assisted_scope_ref)||j.maximum_cents<1||(j.assisted_scope_kind==='pipeline_v1'?(!['upload','transcription','analysis'].includes(j.stage)||!Number.isSafeInteger(j.assisted_scope_total_cents)||j.assisted_scope_total_cents<1||j.assisted_scope_total_cents>2000||j.maximum_cents>j.assisted_scope_total_cents||j.stage==='upload'&&j.maximum_cents>100):(j.assisted_scope_kind!==undefined||j.stage!=='upload'||j.maximum_cents>100))))throw Error('Reserva unitária inválida.');
    if(j.analysis_revision!==undefined&&(j.stage!=='analysis'||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(j.analysis_revision)))throw new Error('Revisão de análise inválida.');
    if(!executionPattern.test(id)||!j||!idPattern.test(j.video_id??'')||!stages.has(j.stage)||!cents(j.maximum_cents)||!['reserved','started','uncertain','completed','cancelled'].includes(j.status))throw new Error('Reserva inválida.');
    if(['reserved','started','uncertain'].includes(j.status))reserved+=j.maximum_cents;
    if(j.individual_isolation!==undefined&&!isolatedAnalysisTimeout(j,state.batch))throw Error('Isolamento individual inválido.');
    if(state.batch?.video_ids.length===262&&j.batch_id===state.batch.id&&['reserved','started','uncertain'].includes(j.status)&&!isolatedAnalysisTimeout(j,state.batch)&&!state.batch.active_video_ids.includes(j.video_id))throw Error('Etapa aberta sem via reservada.');
  }
  if(!Number.isSafeInteger(reserved)||reserved!==state.reserved_cents)throw new Error('Saldo de reservas inconsistente.');
}
export function newLedger(){return {schema_version:1,allocation_cents:150000,reserve_cents:25000,spent_cents:0,reserved_cents:0,remaining_credit_cents:0,
  coverage_verified:false,balance_observed_at:null,credit_expires_at:null,balance_max_age_seconds:3600,expiry_margin_hours:72,
  ongoing_commitment_cents:0,ongoing_storage_planned_bytes:0,ongoing_costs_observed_at:null,ongoing_costs_valid_until:null,
  paused:true,enabled_stages:{upload:false,transcription:false,analysis:false,media_access:false},jobs:{}};}
export function reservationDecision(state,{now=Date.now(),maximumCents,stage,videoId,assistedScope=null}={}){
  validate(state);if(assistedScope)assertAssistedScope(assistedScope,{stage,videoId,maximumCents});const reasons=[];
  if(!cents(maximumCents)||maximumCents===0||!stages.has(stage))reasons.push('Estimativa positiva e etapa válidas são obrigatórias.');
  if(state.paused!==false||state.enabled_stages?.[stage]!==true)reasons.push('Etapa pausada ou desligada.');
  // The owner's one-Reel <=R$5 approval uses its explicit pilot envelope;
  // promotional-credit evidence is not renewed or required for this scope.
  const unitBudget=assistedScope?.pipeline===true&&assistedScope.totalMaximumCents<=500;
  if(unitBudget){
    if(!cents(state.pilot_envelope_cents)||state.pilot_envelope_cents<1)reasons.push('Orçamento unitário explícito obrigatório.');
  }else{
    if(state.coverage_verified!==true)reasons.push('Cobertura dos créditos não confirmada.');
    const ongoingObserved=Date.parse(state.ongoing_costs_observed_at),ongoingUntil=Date.parse(state.ongoing_costs_valid_until);
    if(!cents(state.ongoing_commitment_cents)||!Number.isFinite(ongoingObserved)||ongoingObserved>now||now-ongoingObserved>86400000||!Number.isFinite(ongoingUntil)||ongoingUntil<=now)reasons.push('Custos persistentes ausentes ou desatualizados.');
    const observed=Date.parse(state.balance_observed_at),age=state.balance_max_age_seconds;
    if(!Number.isFinite(observed)||!Number.isSafeInteger(age)||age<1||age>86400||observed>now||now-observed>age*1000)reasons.push('Saldo financeiro ausente ou desatualizado.');
    const expiry=Date.parse(state.credit_expires_at),margin=state.expiry_margin_hours;
    if(!Number.isFinite(expiry)||!Number.isFinite(margin)||margin<72||expiry<=now+margin*3600000)reasons.push('Crédito próximo do vencimento.');
  }
  // remaining_credit_cents must conservatively include account-wide consumption.
  const accountAvailable=Math.min(state.remaining_credit_cents,state.allocation_cents-state.spent_cents)-state.reserve_cents-state.reserved_cents-(state.ongoing_commitment_cents??0);
  const pilotAvailable=state.pilot_envelope_cents==null?accountAvailable:state.pilot_envelope_cents-state.spent_cents-state.reserved_cents-(state.ongoing_commitment_cents??0);
  const batch=assistedScope?{reasons:[],available_cents:assistedScope.maximumCents}:batchDecision(state,{videoId,maximumCents});reasons.push(...batch.reasons);
  const available=unitBudget?Math.min(pilotAvailable,batch.available_cents):Math.min(accountAvailable,pilotAvailable,batch.available_cents);
  if(!Number.isSafeInteger(available)||maximumCents>available)reasons.push('Reserva insuficiente.');
  return {ready:reasons.length===0,reasons,available_cents:Math.max(0,available),uploads_enabled:stage==='upload'&&state.enabled_stages.upload===true,
    media_access_enabled:stage==='media_access'&&state.enabled_stages.media_access===true,
    paid_calls_enabled:stage!=='upload'&&state.enabled_stages?.[stage]===true};
}
export class FinancialLedger{
  constructor(store,{clock=()=>Date.now(),path='settings/financial',assistedScope=null}={}){if(path!=='settings/financial')throw new Error('Livro financeiro deve usar documento fixo.');if(assistedScope)assertAssistedScope(assistedScope);Object.assign(this,{store,clock,path,assistedScope});}
  async recordOngoingCosts(estimates){
    return mutateDocument(this.store,this.path,async snapshot=>{
    if(!snapshot)throw new Error('Controle financeiro ausente.');
    const state=snapshot.data;validate(state);
    const {storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents}=estimates;
    const plan=ongoingCostPlan({storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents,remainingCreditCents:state.remaining_credit_cents,allocationRemainingCents:Math.max(0,state.allocation_cents-state.spent_cents),reserveCents:state.reserve_cents,inflightCents:state.reserved_cents});
    const until=this.clock()+daysUntilCleanup*86400000,expiry=Date.parse(state.credit_expires_at);
    if(!Number.isFinite(expiry)||until>expiry-72*3600000)throw new Error('Planeje encerramento antes do vencimento.');
    return {changes:{ongoing_commitment_cents:plan.commitment_cents,ongoing_storage_planned_bytes:storageBytes,ongoing_costs_observed_at:new Date(this.clock()).toISOString(),ongoing_costs_valid_until:new Date(until).toISOString(),...(!plan.ready?{paused:true}:{})},result:plan};
    });
  }
  async reserve({executionId,videoId,stage,maximumCents,analysisRevision,recoveryOf,recoveryId,settledRetry=false}){
    if(analysisRevision!==undefined&&(stage!=='analysis'||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision)))throw new Error('Revisão de análise inválida.');
    if(!executionPattern.test(executionId??'')||!idPattern.test(videoId??'')||!stages.has(stage)||!cents(maximumCents)||maximumCents===0)throw new Error('Reserva inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
    if(!snapshot)throw new Error('Controle financeiro não inicializado.');
    const state=snapshot.data;validate(state);
    if(this.assistedScope){assertAssistedScope(this.assistedScope,{executionId,videoId,stage,maximumCents});await verifyAssistedScope(this.store,this.assistedScope);if(recoveryOf!==undefined||settledRetry)throw Error('Recuperação fora do escopo unitário.');if(this.assistedScope.pipeline){if(stage==='analysis'?analysisRevision!==this.assistedScope.analysisRevision:analysisRevision!==undefined)throw Error('Revisão unitária divergente.');assertPipelineHistory(this.assistedScope,state);}else if(analysisRevision!==undefined||Object.values(state.jobs).some(j=>j.video_id===videoId))throw Error('Aquisição unitária exige vídeo sem histórico.');}
    if(state.jobs[executionId])throw new Error('Execução já registrada; não iniciar novamente.');
    if(settledRetry!==false&&settledRetry!==true||settledRetry&&recoveryOf===undefined)throw Error('Retomada explícita inválida.');
    if(settledRetry){
      const claim=(await this.store.get(`jobs/${recoveryOf}`))?.data,child=(await this.store.get(`jobs/${executionId}`))?.data,authorization=(await this.store.get(settledRetryAuthorizationPath(recoveryOf)))?.data,video=(await this.store.get(`videos/${videoId}`))?.data;
      if(executionId!==settledRetryId(recoveryOf)||child?.status!=='claimed'||child.video_id!==videoId||child.stage!==stage||child.recovery_of!==recoveryOf||child.settled_retry_count!==1||child.recovery_authorization!==settledRetryAuthorizationPath(recoveryOf)||state.jobs[recoveryOf]?.batch_id!==state.batch?.id||stage==='analysis'&&analysisRevision!==state.jobs[recoveryOf]?.analysis_revision||!settledRetryAllowed({authorization,claim,financial:state.jobs[recoveryOf],video,originalId:recoveryOf,videoId,stage,maximumCents,recoveryId,now:this.clock()}))throw Error('Retomada exige autorização e histórico conferidos.');
    }else if(recoveryOf!==undefined){
      const claim=(await this.store.get(`jobs/${recoveryOf}`))?.data,child=(await this.store.get(`jobs/${executionId}`))?.data,authorization=(await this.store.get(recoveryAuthorizationPath(recoveryOf)))?.data,video=(await this.store.get(`videos/${videoId}`))?.data;
      if(stage!=='upload'||executionId!==uploadRecoveryId(recoveryOf)||child?.recovery_of!==recoveryOf||child.firestore_recovery_count!==1||child.status!=='claimed'||child.video_id!==videoId||child.stage!==stage||child.firestore_recovery_authorization!==recoveryAuthorizationPath(recoveryOf)||state.jobs[recoveryOf]?.batch_id!==state.batch?.id||!metadataRecoveryAllowed({authorization,claim,financial:state.jobs[recoveryOf],video,originalId:recoveryOf,videoId,stage,maximumCents,recoveryId,now:this.clock()}))throw Error('Retomada financeira exige autorização e histórico conferidos.');
    }
    if(Object.entries(state.jobs).some(([id,j])=>id!==recoveryOf&&j.video_id===videoId&&j.stage===stage&&j.status!=='cancelled'&&(state.batch||['reserved','started','uncertain'].includes(j.status)||j.analysis_revision===analysisRevision)))throw new Error('Etapa do vídeo já reservada, concluída ou com resultado incerto.');
    if(Object.keys(state.jobs).length>=jobLimit(state))throw new Error('Livro do piloto completo; reconciliação necessária.');
    if(!this.assistedScope&&state.batch?.video_ids.length===262){
      const controls=(await this.store.get('settings/automation'))?.data;
      if(!Number.isInteger(controls?.parallelism)||controls.parallelism<1||controls.parallelism>4||controls.enabled!==true)throw Error('Automacao paralela nao liberada.');
      if(!state.batch.active_video_ids.includes(videoId)&&state.batch.active_video_ids.length>=controls.parallelism)throw Error('Vias ocupadas conforme controle atual.');
    }
    const decision=reservationDecision(state,{now:this.clock(),maximumCents,stage,videoId,assistedScope:this.assistedScope});if(!decision.ready)throw new Error(decision.reasons.join(' '));
    const job={video_id:videoId,stage,maximum_cents:maximumCents,status:'reserved',created_at:new Date(this.clock()).toISOString()};
    if(analysisRevision!==undefined)job.analysis_revision=analysisRevision;
    if(recoveryOf!==undefined)job.recovery_of=recoveryOf;
    if(settledRetry)job.recovery_kind='settled_retry_v1';
    if(this.assistedScope){job.assisted_scope_ref=this.assistedScope.reference;if(this.assistedScope.pipeline){job.assisted_scope_kind='pipeline_v1';job.assisted_scope_total_cents=this.assistedScope.totalMaximumCents;}}else if(state.batch)job.batch_id=state.batch.id;
    const batch=!this.assistedScope&&state.batch?.video_ids.length===262?{...state.batch,active_video_ids:[...new Set([...state.batch.active_video_ids,videoId])]}:null;
    return {changes:{jobs:{...state.jobs,[executionId]:job},reserved_cents:state.reserved_cents+maximumCents,...(batch?{batch}:{})},result:{...decision,execution_id:executionId}};
    });
  }
  // Operator-only reconciliation primitive. No automatic timeout retry and no
  // global resume: paused/coverage/system controls remain unchanged.
  async isolateAnalysisTimeout(executionId,{authorizationRef,verifiedFailure,legacyServerStatus}={}){
    if(!executionPattern.test(executionId??'')||verifiedFailure!=='client_timeout'||typeof authorizationRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(authorizationRef))throw Error('Autorização e diagnóstico específico de timeout obrigatórios.');
    return mutateDocument(this.store,this.path,async snapshot=>{
      const state=snapshot?.data;validate(state);
      const job=state.jobs[executionId],claim=(await this.store.get(`jobs/${executionId}`))?.data,video=(await this.store.get(`videos/${job?.video_id}`))?.data;
      if(state.batch?.video_ids.length!==262||job?.batch_id!==state.batch.id||job?.stage!=='analysis'||job.status!=='uncertain'||!claim||claim.video_id!==job.video_id||claim.stage!=='analysis'||claim.status!=='uncertain'||claim.failure_diagnostic?.operation_step!=='submit_analysis'||claim.failure_diagnostic.http_status!==null||!Array.isArray(claim.analysis_attempts)||claim.analysis_attempts.at(-1)?.status!=='uncertain'||!video||video.analysis||video.analysis_key||video.candidate_analysis_key)throw Error('Somente timeout de envio individual conferido pode ser isolado.');
      const d=claim.failure_diagnostic;
      const evidence=d.error_name==='TimeoutError'?{kind:'client_timeout'}:d.tool_code===23&&legacyServerStatus===499?{kind:'legacy_client_cancel',server_status:499,client_code:23}:null;
      if(!evidence)throw Error('Timeout explícito ou evidência legada499/code23 obrigatória.');
      if(Object.entries(state.jobs).some(([id,j])=>id!==executionId&&j.video_id===job.video_id&&['reserved','started','uncertain'].includes(j.status)))throw Error('Outro trabalho deste vídeo exige conferência.');
      if(isolatedAnalysisTimeout(job,state.batch)){
        if(job.individual_isolation.authorization_ref!==authorizationRef)throw Error('Isolamento já autorizado por outro registro.');
        return {changes:{jobs:state.jobs},result:job};
      }
      const updated={...job,individual_isolation:{schema_version:1,reason:'verified_client_timeout',authorization_ref:authorizationRef,authorized_at:new Date(this.clock()).toISOString(),evidence}};
      return {changes:{jobs:{...state.jobs,[executionId]:updated},batch:{...state.batch,active_video_ids:state.batch.active_video_ids.filter(v=>v!==job.video_id)}},result:updated};
    });
  }
  async resumeUpload(executionId){
    if(!executionPattern.test(executionId??''))throw Error('Execução inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
    const state=snapshot?.data;validate(state);
    const job=state.jobs[executionId],claim=(await this.store.get(`jobs/${executionId}`))?.data,probe=(await this.store.get('jobs/probe_'+executionId))?.data;
    if(job?.status!=='uncertain'||job.stage!=='upload'||job.upload_recovery_count||claim?.status!=='recovering_upload'||claim.upload_recovery_count!==1||claim.video_id!==job.video_id||probe?.status!=='metadata_available'||probe.original_job_id!==executionId||probe.video_id!==job.video_id||!recoverableUploadFailure({...claim,status:'uncertain',upload_recovery_count:0}))throw Error('Upload não admite retomada.');
    const decision=reservationDecision({...state,reserved_cents:state.reserved_cents-job.maximum_cents,jobs:Object.fromEntries(Object.entries(state.jobs).filter(([id])=>id!==executionId))},{now:this.clock(),maximumCents:job.maximum_cents,stage:job.stage,videoId:job.video_id});
    if(!decision.ready)throw Error(decision.reasons.join(' '));
    return {changes:{jobs:{...state.jobs,[executionId]:{...job,status:'started',upload_recovery_count:1,updated_at:new Date(this.clock()).toISOString()}}}};
    });
  }
  async resumeAnalysis429(executionId){
    if(!executionPattern.test(executionId??''))throw Error('Execução inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
    const state=snapshot?.data;validate(state);
    const job=state.jobs[executionId],claim=(await this.store.get(`jobs/${executionId}`))?.data;
    if(job?.status!=='uncertain'||job.stage!=='analysis'||claim?.status!=='recovering_429'||claim.video_id!==job.video_id||!recoverableAnalysis429({...claim,status:'uncertain'}))throw Error('Retomada exige429 confirmado e histórico limitado.');
    const decision=reservationDecision({...state,reserved_cents:state.reserved_cents-job.maximum_cents,jobs:Object.fromEntries(Object.entries(state.jobs).filter(([id])=>id!==executionId))},{now:this.clock(),maximumCents:job.maximum_cents,stage:job.stage,videoId:job.video_id});
    if(!decision.ready)throw Error(decision.reasons.join(' '));
    return {changes:{jobs:{...state.jobs,[executionId]:{...job,status:'started',recovery_429_count:(job.recovery_429_count??0)+1,updated_at:new Date(this.clock()).toISOString()}}}};
    });
  }
  async pauseFailedSourceReconciliation(executionId){
    if(!executionPattern.test(executionId??''))throw Error('Execução inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
      const state=snapshot?.data;validate(state);const job=state.jobs[executionId];
      if(state.batch?.video_ids.length!==262||job?.batch_id!==state.batch.id||job.stage!=='upload'||!['started','uncertain','completed'].includes(job.status))throw Error('Pausa exige a própria reserva de origem.');
      return {changes:{paused:true}};
    });
  }
  async settleTerminalSourceFailure(executionId){
    if(!executionPattern.test(executionId??''))throw Error('Execução inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
      const state=snapshot?.data;validate(state);const job=state.jobs[executionId];
      if(state.batch?.video_ids.length!==262||job?.batch_id!==state.batch.id||job.stage!=='upload'||job.status!=='started')throw Error('Isolamento exige upload iniciado do lote ativo.');
      const claim=(await this.store.get(`jobs/${executionId}`))?.data,video=(await this.store.get(`videos/${job.video_id}`))?.data,review=(await this.store.get(`analyses/ig_error_${job.video_id}`))?.data,audit=(await this.store.get(`analyses/source_hold_${executionId}`))?.data;
      if(claim?.video_id!==job.video_id||claim.stage!=='upload'||claim.status!=='uncertain'||!terminalSourceFailure(claim.failure_diagnostic)||claim.source_hold_proof?.media_absent!==true||claim.source_hold_proof.review_record!==`analyses/ig_error_${job.video_id}`||video?.status!=='needs_attention'||video.media_verified||video.video_key||video.transcript_key||video.analysis||review?.review_status!=='awaiting_user_verdict'||!review.events?.some(x=>x.event_id===`source_${executionId}`)||audit?.execution_id!==executionId||audit.original_object_absent!==true)throw Error('Prova, mídia ausente e veredito obrigatórios.');
      const updated={...job,status:'completed',actual_cents:job.maximum_cents,manual_reconciliation:'terminal_metadata_estimate_accounted_user_verdict_pending',updated_at:new Date(this.clock()).toISOString()};
      return {changes:{jobs:{...state.jobs,[executionId]:updated},spent_cents:state.spent_cents+job.maximum_cents,reserved_cents:state.reserved_cents-job.maximum_cents,remaining_credit_cents:Math.max(0,state.remaining_credit_cents-job.maximum_cents),batch:{...state.batch,active_video_ids:state.batch.active_video_ids.filter(id=>id!==job.video_id)}},result:updated};
    });
  }
  async reconcileAnalysisResult(executionId,{actualCents}){
    if(!executionPattern.test(executionId??'')||!cents(actualCents))throw Error('Reconciliação inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
      const state=snapshot?.data;validate(state);const job=state.jobs[executionId],claim=(await this.store.get(`jobs/${executionId}`))?.data,video=(await this.store.get(`videos/${job?.video_id}`))?.data,artifact=claim?.result_artifact;
      if(job?.stage!=='analysis'||!['started','uncertain','completed'].includes(job.status)||claim?.stage!=='analysis'||claim.video_id!==job.video_id||claim.status!=='reconciling_result'||!claim.reconciliation_authorization_ref||actualCents!==job.maximum_cents||artifact?.key!==`results/instagram/${job.video_id}/${executionId}/analysis.json`||!/^\d+$/.test(artifact.generation??'')||!((video?.analysis_key===artifact.key&&video.analysis_generation===artifact.generation)||(video?.candidate_analysis_key===artifact.key&&video.candidate_analysis_generation===artifact.generation)))throw Error('Resposta persistida e metadados da própria execução obrigatórios.');
      if(job.status==='completed'){if(job.actual_cents!==actualCents)throw Error('Custo já conciliado diverge.');return {changes:null,result:job};}
      const updated={...job,status:'completed',actual_cents:actualCents,manual_reconciliation:'persisted_analysis_result_reconciled_without_inference',updated_at:new Date(this.clock()).toISOString()};
      return {changes:{jobs:{...state.jobs,[executionId]:updated},spent_cents:state.spent_cents+actualCents,reserved_cents:state.reserved_cents-job.maximum_cents,remaining_credit_cents:Math.max(0,state.remaining_credit_cents-actualCents),...(state.batch?.active_video_ids?{batch:{...state.batch,active_video_ids:state.batch.active_video_ids.filter(id=>id!==job.video_id)}}:{})},result:updated};
    });
  }
  async transition(executionId,action,{actualCents,pause=false}={}){
    if(!executionPattern.test(executionId??''))throw new Error('Execução inválida.');
    return mutateDocument(this.store,this.path,async snapshot=>{
    if(!snapshot)throw new Error('Controle financeiro ausente.');
    const state=snapshot.data;validate(state);const job=state.jobs[executionId];if(!job)throw new Error('Reserva ausente.');
    if(this.assistedScope){assertAssistedJob(this.assistedScope,executionId,job);await verifyAssistedScope(this.store,this.assistedScope);}
    const updated={...job},changes={};
    if(action==='start'){
      if(job.status!=='reserved')throw new Error('Execução não pode ser repetida.');
      const decision=reservationDecision({...state,reserved_cents:state.reserved_cents-job.maximum_cents,jobs:Object.fromEntries(Object.entries(state.jobs).filter(([id])=>id!==executionId))},{now:this.clock(),maximumCents:job.maximum_cents,stage:job.stage,videoId:job.video_id,assistedScope:this.assistedScope});
      if(!decision.ready)throw new Error(decision.reasons.join(' '));updated.status='started';
    }else if(action==='uncertain'){
      if(job.status!=='started')throw new Error('Apenas execução iniciada pode ficar incerta.');updated.status='uncertain';changes.paused=true;
    }else if(action==='cancel'){
      if(job.status!=='reserved')throw new Error('Não liberar reserva de uma operação iniciada.');updated.status='cancelled';changes.reserved_cents=state.reserved_cents-job.maximum_cents;
    }else if(action==='complete'){
      if(job.status!=='started'||!cents(actualCents))throw new Error('Resultado deve ter custo conservador conhecido.');
      updated.status='completed';updated.actual_cents=actualCents;
      changes.reserved_cents=state.reserved_cents-job.maximum_cents;changes.spent_cents=state.spent_cents+actualCents;
      changes.remaining_credit_cents=Math.max(0,state.remaining_credit_cents-actualCents);
      if(actualCents>job.maximum_cents)changes.paused=true;
    }else throw new Error('Transição não permitida.');
    updated.updated_at=new Date(this.clock()).toISOString();
    if(pause===true)changes.paused=true;
    if(!job.assisted_scope_ref&&state.batch?.video_ids.length===262&&((action==='complete'&&job.stage==='analysis')||(action==='cancel'&&job.stage==='upload')))changes.batch={...state.batch,active_video_ids:state.batch.active_video_ids.filter(v=>v!==job.video_id)};
    return {changes:{...changes,jobs:{...state.jobs,[executionId]:updated}},result:updated};
    });
  }
}
