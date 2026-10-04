import {ongoingCostPlan} from './ongoing-costs.mjs';
// One versioned Firestore document makes reservation and claim atomic.
// A timeout never permits replay of a paid operation.
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const executionPattern=/^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const stages=new Set(['upload','transcription','analysis','media_access']);
const cents=value=>Number.isSafeInteger(value)&&value>=0;
function validate(state){
  if(!state||state.schema_version!==1||!['allocation_cents','reserve_cents','spent_cents','reserved_cents','remaining_credit_cents'].every(k=>cents(state[k])))throw new Error('Controle financeiro inválido.');
  if(!state.jobs||typeof state.jobs!=='object'||Array.isArray(state.jobs)||Object.keys(state.jobs).length>100)throw new Error('Livro do piloto inválido ou completo.');
  if(state.ongoing_commitment_cents!==undefined&&!cents(state.ongoing_commitment_cents))throw new Error('Compromisso persistente inválido.');
  if(state.pilot_envelope_cents!==undefined&&state.pilot_envelope_cents!==null&&(!cents(state.pilot_envelope_cents)||state.pilot_envelope_cents<1||state.pilot_envelope_cents>state.allocation_cents))throw new Error('Orçamento do piloto inválido.');
  let reserved=0;
  for(const [id,j]of Object.entries(state.jobs)){
    if(j.analysis_revision!==undefined&&(j.stage!=='analysis'||j.analysis_revision!=='megabrain-video-text-v3'))throw new Error('Revisão de análise inválida.');
    if(!executionPattern.test(id)||!j||!idPattern.test(j.video_id??'')||!stages.has(j.stage)||!cents(j.maximum_cents)||!['reserved','started','uncertain','completed','cancelled'].includes(j.status))throw new Error('Reserva inválida.');
    if(['reserved','started','uncertain'].includes(j.status))reserved+=j.maximum_cents;
  }
  if(!Number.isSafeInteger(reserved)||reserved!==state.reserved_cents)throw new Error('Saldo de reservas inconsistente.');
}
export function newLedger(){return {schema_version:1,allocation_cents:150000,reserve_cents:25000,spent_cents:0,reserved_cents:0,remaining_credit_cents:0,
  coverage_verified:false,balance_observed_at:null,credit_expires_at:null,balance_max_age_seconds:3600,expiry_margin_hours:72,
  ongoing_commitment_cents:0,ongoing_storage_planned_bytes:0,ongoing_costs_observed_at:null,ongoing_costs_valid_until:null,
  paused:true,enabled_stages:{upload:false,transcription:false,analysis:false,media_access:false},jobs:{}};}
export function reservationDecision(state,{now=Date.now(),maximumCents,stage}={}){
  validate(state);const reasons=[];
  if(!cents(maximumCents)||maximumCents===0||!stages.has(stage))reasons.push('Estimativa positiva e etapa válidas são obrigatórias.');
  if(state.paused!==false||state.enabled_stages?.[stage]!==true)reasons.push('Etapa pausada ou desligada.');
  if(state.coverage_verified!==true)reasons.push('Cobertura dos créditos não confirmada.');
  const ongoingObserved=Date.parse(state.ongoing_costs_observed_at),ongoingUntil=Date.parse(state.ongoing_costs_valid_until);
  if(!cents(state.ongoing_commitment_cents)||!Number.isFinite(ongoingObserved)||ongoingObserved>now||now-ongoingObserved>3600000||!Number.isFinite(ongoingUntil)||ongoingUntil<=now)reasons.push('Custos persistentes ausentes ou desatualizados.');
  const observed=Date.parse(state.balance_observed_at),age=state.balance_max_age_seconds;
  if(!Number.isFinite(observed)||!Number.isSafeInteger(age)||age<1||age>3600||observed>now||now-observed>age*1000)reasons.push('Saldo financeiro ausente ou desatualizado.');
  const expiry=Date.parse(state.credit_expires_at),margin=state.expiry_margin_hours;
  if(!Number.isFinite(expiry)||!Number.isFinite(margin)||margin<72||expiry<=now+margin*3600000)reasons.push('Crédito próximo do vencimento.');
  // remaining_credit_cents must conservatively include account-wide consumption.
  const accountAvailable=Math.min(state.remaining_credit_cents,state.allocation_cents-state.spent_cents)-state.reserve_cents-state.reserved_cents-(state.ongoing_commitment_cents??0);
  const pilotAvailable=state.pilot_envelope_cents==null?accountAvailable:state.pilot_envelope_cents-state.spent_cents-state.reserved_cents-(state.ongoing_commitment_cents??0);
  const available=Math.min(accountAvailable,pilotAvailable);
  if(!Number.isSafeInteger(available)||maximumCents>available)reasons.push('Reserva insuficiente.');
  return {ready:reasons.length===0,reasons,available_cents:Math.max(0,available),uploads_enabled:stage==='upload'&&state.enabled_stages.upload===true,
    media_access_enabled:stage==='media_access'&&state.enabled_stages.media_access===true,
    paid_calls_enabled:stage!=='upload'&&state.enabled_stages?.[stage]===true};
}
export class FinancialLedger{
  constructor(store,{clock=()=>Date.now(),path='settings/financial'}={}){if(path!=='settings/financial')throw new Error('Livro financeiro deve usar documento fixo.');Object.assign(this,{store,clock,path});}
  async recordOngoingCosts(estimates){
    const snapshot=await this.store.get(this.path);if(!snapshot)throw new Error('Controle financeiro ausente.');
    const state=snapshot.data;validate(state);
    const {storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents}=estimates;
    const plan=ongoingCostPlan({storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents,remainingCreditCents:state.remaining_credit_cents,allocationRemainingCents:Math.max(0,state.allocation_cents-state.spent_cents),reserveCents:state.reserve_cents,inflightCents:state.reserved_cents});
    const until=this.clock()+daysUntilCleanup*86400000,expiry=Date.parse(state.credit_expires_at);
    if(!Number.isFinite(expiry)||until>expiry-72*3600000)throw new Error('Planeje encerramento antes do vencimento.');
    await this.store.patch(this.path,{ongoing_commitment_cents:plan.commitment_cents,ongoing_storage_planned_bytes:storageBytes,ongoing_costs_observed_at:new Date(this.clock()).toISOString(),ongoing_costs_valid_until:new Date(until).toISOString(),...(!plan.ready?{paused:true}:{})},{updateTime:snapshot.updateTime});
    return plan;
  }
  async reserve({executionId,videoId,stage,maximumCents,analysisRevision}){
    if(analysisRevision!==undefined&&(stage!=='analysis'||analysisRevision!=='megabrain-video-text-v3'))throw new Error('Revisão de análise inválida.');
    if(!executionPattern.test(executionId??'')||!idPattern.test(videoId??'')||!stages.has(stage)||!cents(maximumCents)||maximumCents===0)throw new Error('Reserva inválida.');
    const snapshot=await this.store.get(this.path);if(!snapshot)throw new Error('Controle financeiro não inicializado.');
    const state=snapshot.data;validate(state);
    if(state.jobs[executionId])throw new Error('Execução já registrada; não iniciar novamente.');
    if(Object.values(state.jobs).some(j=>j.video_id===videoId&&j.stage===stage&&j.status!=='cancelled'&&(['reserved','started','uncertain'].includes(j.status)||j.analysis_revision===analysisRevision)))throw new Error('Etapa do vídeo já reservada, concluída ou com resultado incerto.');
    if(Object.keys(state.jobs).length>=100)throw new Error('Livro do piloto completo; reconciliação necessária.');
    const decision=reservationDecision(state,{now:this.clock(),maximumCents,stage});if(!decision.ready)throw new Error(decision.reasons.join(' '));
    const job={video_id:videoId,stage,maximum_cents:maximumCents,status:'reserved',created_at:new Date(this.clock()).toISOString()};
    if(analysisRevision!==undefined)job.analysis_revision=analysisRevision;
    await this.store.patch(this.path,{jobs:{...state.jobs,[executionId]:job},reserved_cents:state.reserved_cents+maximumCents},{updateTime:snapshot.updateTime});
    return {...decision,execution_id:executionId};
  }
  async transition(executionId,action,{actualCents}={}){
    if(!executionPattern.test(executionId??''))throw new Error('Execução inválida.');
    const snapshot=await this.store.get(this.path);if(!snapshot)throw new Error('Controle financeiro ausente.');
    const state=snapshot.data;validate(state);const job=state.jobs[executionId];if(!job)throw new Error('Reserva ausente.');
    const updated={...job},changes={};
    if(action==='start'){
      if(job.status!=='reserved')throw new Error('Execução não pode ser repetida.');
      const decision=reservationDecision({...state,reserved_cents:state.reserved_cents-job.maximum_cents,jobs:Object.fromEntries(Object.entries(state.jobs).filter(([id])=>id!==executionId))},{now:this.clock(),maximumCents:job.maximum_cents,stage:job.stage});
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
    await this.store.patch(this.path,{...changes,jobs:{...state.jobs,[executionId]:updated}},{updateTime:snapshot.updateTime});
    return updated;
  }
}
