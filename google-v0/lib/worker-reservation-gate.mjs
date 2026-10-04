import {reservationDecision} from './financial-ledger.mjs';

export function workerReservationGate(store,{clock=()=>Date.now()}={}){
  return async({executionId,stage,videoId})=>{
    const state=(await store.get('settings/financial'))?.data;
    const job=state?.jobs?.[executionId];
    if(job?.status!=='started'||job.stage!==stage||job.video_id!==videoId)throw new Error('Reserva iniciada da tarefa obrigatória.');
    const decision=reservationDecision({...state,reserved_cents:state.reserved_cents-job.maximum_cents,jobs:Object.fromEntries(Object.entries(state.jobs).filter(([id])=>id!==executionId))},{now:clock(),maximumCents:job.maximum_cents,stage});
    if(!decision.ready)throw new Error('Reserva pausada ou sem cobertura financeira atual.');
    return {maximum_cents:job.maximum_cents};
  };
}
