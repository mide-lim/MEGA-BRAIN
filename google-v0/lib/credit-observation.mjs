// Administrative input from a real credit observation, never from a model or UI user.
// A billing export query time is not the time a remaining credit was observed.
import {createHash} from 'node:crypto';
const money=n=>Number.isSafeInteger(n)&&n>=0;
export function creditObservationChanges(state,input,{account,now=Date.now()}={}){
  if(!/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(account??'')||input?.billing_account!==account||input.currency!=='BRL'||input.source!=='google_console_credit'||input.schema_version!==1)throw new Error('Observação da conta de créditos inválida.');
  const observed=Date.parse(input.observed_at),expiry=Date.parse(input.expires_at);
  if(!Number.isFinite(observed)||observed>now||now-observed>3600000||!Number.isFinite(expiry)||expiry<=now+72*3600000||!money(input.remaining_cents)||!money(input.pending_account_cents)||typeof input.credit_id!=='string'||!input.credit_id||input.credit_id.length>200)throw new Error('Saldo, vencimento ou consumo pendente inválidos.');
  const previous=Date.parse(state.balance_observed_at);
  if(Number.isFinite(previous)&&observed<=previous)throw new Error('Não renovar uma observação antiga.');
  let completedAfterObservation=0;
  for(const job of Object.values(state.jobs??{})){
    if(job.status!=='completed')continue;
    const completed=Date.parse(job.updated_at);
    if(!money(job.actual_cents)||!Number.isFinite(completed))throw new Error('Execução concluída sem custo/data para conciliação.');
    if(completed>observed)completedAfterObservation+=job.actual_cents;
  }
  const deductions=input.pending_account_cents+completedAfterObservation;
  if(!Number.isSafeInteger(deductions))throw new Error('Conciliação fora da precisão permitida.');
  const remaining=Math.max(0,input.remaining_cents-deductions);
  return {remaining_credit_cents:remaining,balance_observed_at:new Date(observed).toISOString(),credit_expires_at:new Date(expiry).toISOString(),
    credit_observation_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    credit_observation_source:input.source,pending_account_cents:input.pending_account_cents,
    // Observation never grants coverage, activates a stage or releases a pause.
    ...(remaining<state.reserve_cents+state.reserved_cents+(state.ongoing_commitment_cents??0)?{paused:true}:{})};
}
export async function recordCreditObservation(store,input,options){
  const snapshot=await store.get('settings/financial');
  if(!snapshot?.data||snapshot.data.schema_version!==1)throw new Error('Controle financeiro ausente.');
  const changes=creditObservationChanges(snapshot.data,input,options);
  await store.patch('settings/financial',changes,{updateTime:snapshot.updateTime});
  return {recorded:true,remaining_credit_cents:changes.remaining_credit_cents,activation_changed:false};
}
