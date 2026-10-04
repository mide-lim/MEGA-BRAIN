import {executionId,completedEmptyTranscript} from './worker-flow.mjs';
const project='megabrain-v0-1017370021431';
// Read-only diagnosis. No reset, cancellation, inference or enqueue is hidden
// in inspecting an interrupted video. Claims are never erased to allow replay.
export class WorkerRecovery{
 constructor({store,queue}){this.store=store;this.queue=queue;}
 async resume({videoId,recoveryId}){
  if(!this.queue||!/^[A-Za-z0-9_-]{16,64}$/.test(recoveryId??''))throw new Error('Fila e identificador administrativo obrigatórios.');
  const plan=await this.inspect(videoId);
  const controls=(await this.store.get('settings/automation'))?.data;
  if(plan.financial_paused||!controls?.enabled)return {status:'paused'};
  if(!['ready_for_dispatch','operation_pending'].includes(plan.status))return {status:plan.status};
  const action=plan.actions[0],task=action.kind==='dispatch_stage'?action.task:{videoId,stage:'transcription',poll:1};
  if(task.stage==='transcription'&&!controls.transcription_enabled||task.stage==='analysis'&&!controls.analysis_enabled)return {status:'paused'};
  // A new dispatch identifier never changes the paid execution identifier.
  // WorkerFlow still refuses replay of any claimed/started/completed stage.
  return this.queue.enqueue({...task,recoveryId});
 }
 async inspect(videoId){
  if(!/^[A-Za-z0-9_-]{5,32}$/.test(videoId??''))throw new Error('Vídeo inválido.');
  const video=await this.store.get(`videos/${videoId}`),financial=await this.store.get('settings/financial');
  if(!video||!financial)return {status:'blocked',reason:'missing_state',actions:[]};
  const rows=[];
  for(const stage of ['upload','transcription','analysis']){
   const id=executionId(videoId,stage),snapshot=await this.store.get(`jobs/${id}`);
   rows.push({stage,id,job:snapshot?.data??null,reservation:financial.data.jobs?.[id]??null});
  }
  for(const row of rows){
   if(row.job?.status==='completed'&&row.reservation?.status==='completed')continue;
   const {stage,job,reservation}=row;
   if(!job&&!reservation){
    if(stage!=='upload'&&video.data.media_verified!==true)return {status:'blocked',reason:'media_not_verified',actions:[]};
    if(stage==='transcription'&&video.data.audio_status!=='present')return {status:'blocked',reason:'audio_not_verified',actions:[]};
    if(stage==='analysis'&&!video.data.transcript?.trim()&&!completedEmptyTranscript(video.data,videoId))return {status:'blocked',reason:'transcript_missing',actions:[]};
    return {status:'ready_for_dispatch',actions:[{kind:'dispatch_stage',task:{videoId,stage,poll:0}}],financial_paused:financial.data.paused!==false};
   }
   if(stage==='transcription'&&job?.status==='waiting'&&reservation?.status==='started'&&typeof job.operation_name==='string'&&/^projects\/(?:megabrain-v0-1017370021431|711042421394)\/locations\/(?:us|global)\/operations\/[A-Za-z0-9_-]+$/.test(job.operation_name)){
    return {status:'operation_pending',actions:[{kind:'consult_existing_operation',operation_name:job.operation_name}],financial_paused:financial.data.paused!==false};
   }
   return {status:'needs_reconciliation',stage,execution_id:row.id,job_status:job?.status??'absent',reservation_status:reservation?.status??'absent',actions:[]};
  }
  return {status:'completed',actions:[]};
 }
}
