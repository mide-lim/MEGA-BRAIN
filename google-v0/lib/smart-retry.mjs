import {createHash} from 'node:crypto';
import {failureDigest} from './firestore-recovery.mjs';
import {mutateDocument} from './firestore.mjs';
import {terminalSourceFailure} from './source-hold.mjs';
import {executionId,completedEmptyTranscript} from './worker-flow.mjs';

export const settledRetryId=id=>'job_'+createHash('sha256').update(`${id}:settled-retry-v1`).digest('hex');
export const settledRetryAuthorizationPath=id=>`jobs/settled_retry_${id}`;
const validRecovery=id=>/^[A-Za-z0-9_-]{16,64}$/.test(id??'');
const validReference=ref=>/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(ref??'');
export function settledRetryKind({claim:c,financial:f,video:v,videoId,stage}){
 if(!c||!f||!v||c.video_id!==videoId||f.video_id!==videoId||c.stage!==stage||f.stage!==stage||c.status!=='uncertain'||f.status!=='completed'||f.actual_cents!==f.maximum_cents||f.maximum_cents<1||c.recovery_of||f.recovery_of||c.operation_name||v.analysis||v.analysis_key||v.candidate_analysis_key)return null;
 if(stage==='upload'&&!c.analysis_attempts?.length&&terminalSourceFailure(c.failure_diagnostic)&&f.manual_reconciliation==='terminal_metadata_estimate_accounted_user_verdict_pending'&&!v.media_verified&&!v.video_key&&!v.video_generation&&!v.transcript_key&&!v.transcript_generation&&!v.transcript?.trim())return 'source_acquisition';
 const d=c.failure_diagnostic;
 if(stage==='analysis'&&f.analysis_revision==='megabrain-video-text-v4'&&f.manual_reconciliation==='confirmed_schema400_full_estimate_accounted_analysis_pending'&&d?.operation_step==='submit_analysis'&&d.http_status===400&&d.provider?.status==='INVALID_ARGUMENT'&&/response schemas.*any_of|any_of.*only field/i.test(d.provider.message??'')&&c.analysis_attempts?.length===1&&c.analysis_attempts[0].number===1&&c.analysis_attempts[0].status==='uncertain'&&v.media_verified===true&&v.audio_status==='present'&&v.video_key===`originals/instagram/${videoId}/video.mp4`&&/^\d+$/.test(v.video_generation??'')&&v.transcript_key===`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`&&/^\d+$/.test(v.transcript_generation??'')&&(v.transcript?.trim()||completedEmptyTranscript(v,videoId)))return 'confirmed_schema_rejection';
 return null;
}
export function settledRetryAllowed({authorization:a,claim:c,financial:f,video:v,originalId,videoId,stage,maximumCents,recoveryId,now=Date.now()}){
 const kind=settledRetryKind({claim:c,financial:f,video:v,videoId,stage});
 if(!kind||!a||!validRecovery(recoveryId)||!Number.isSafeInteger(maximumCents)||maximumCents<1)return false;
 const start=Date.parse(a.authorized_at),end=Date.parse(a.expires_at);
 return a.schema_version===1&&a.status==='authorized'&&a.kind===kind&&a.original_execution_id===originalId&&a.video_id===videoId&&a.stage===stage&&a.maximum_cents===maximumCents&&f.maximum_cents===maximumCents&&a.recovery_id===recoveryId&&a.failure_digest===failureDigest(c.failure_diagnostic)&&validReference(a.authorization_ref)&&Number.isFinite(start)&&start<=now&&Number.isFinite(end)&&end>now&&end-start>0&&end-start<=86400000;
}
// Call request only after an explicit owner retry action. Inspection is read-only.
// No claim, financial attempt or candidate is deleted to make a retry possible.
export class SmartRetry{
 constructor({store,queue,quotes,batchId,analysisRevision='megabrain-video-text-v4',artifactInspector,flow,clock=()=>Date.now()}){Object.assign(this,{store,queue,quotes,batchId,analysisRevision,artifactInspector,flow,clock});}
 async inspect(videoId){
  if(!/^[A-Za-z0-9_-]{5,32}$/.test(videoId??''))throw Error('Vídeo inválido.');
  const video=await this.store.get(`videos/${videoId}`),financial=await this.store.get('settings/financial');
  if(!video||!financial||financial.data.batch?.id!==this.batchId||!financial.data.batch.video_ids.includes(videoId))return {status:'blocked',reason:'outside_batch'};
  const v=video.data;
  if(v.status==='analyzed'&&v.analysis_quality_status==='accepted'){
   const original=executionId(videoId,'analysis',this.analysisRevision);
   const pending=await Promise.all([original,settledRetryId(original)].map(async id=>{
    const claim=await this.store.get(`jobs/${id}`),reservation=financial.data.jobs?.[id];
    return !!(claim||reservation)&&!(claim?.data.status==='completed'&&reservation?.status==='completed');
   }));
   if(!pending.some(Boolean))return {status:'completed'};
  }
  for(const stage of ['upload','transcription','analysis']){
   const originalId=executionId(videoId,stage,stage==='analysis'?this.analysisRevision:null),snapshot=await this.store.get(`jobs/${originalId}`),reservation=financial.data.jobs?.[originalId];
   const childId=settledRetryId(originalId),child=await this.store.get(`jobs/${childId}`),childReservation=financial.data.jobs?.[childId];
   if(child){
    if(stage==='analysis'&&this.artifactInspector){
     const artifact=await this.artifactInspector({videoId,executionId:childId,stage});
     if(artifact)return {status:'reconcile_saved_result',stage,execution_id:childId,artifact};
    }
    if(child.data.status==='completed'&&childReservation?.status==='completed'&&(stage!=='upload'||v.media_verified===true))continue;
    return {status:'needs_reconciliation',stage,execution_id:childId,reason:'retry_already_claimed'};
   }
   if(snapshot?.data.status==='completed'&&reservation?.status==='completed'&&stage!=='analysis')continue;
   if(this.artifactInspector&&stage==='analysis'){
    const artifact=await this.artifactInspector({videoId,executionId:originalId,stage});
    if(artifact)return {status:'reconcile_saved_result',stage,execution_id:originalId,artifact};
   }
   if(!snapshot&&!reservation&&(stage==='upload'&&v.media_verified||stage==='transcription'&&(v.media_verified!==true||v.audio_status!=='present')||stage==='analysis'&&(v.media_verified!==true||!v.transcript?.trim()&&!completedEmptyTranscript(v,videoId))))return {status:'blocked',reason:'preserved_source_requires_reconciliation',stage};
   if(!snapshot&&!reservation)return {status:'ready_for_dispatch',stage,task:{videoId,stage,poll:0}};
   if(['blocked','retry_ready'].includes(snapshot?.data.status)&&!reservation&&!snapshot.data.operation_name&&!snapshot.data.analysis_attempts?.length)return {status:'unsubmitted',stage,execution_id:originalId,task:{videoId,stage,poll:0}};
   if(stage==='transcription'&&snapshot?.data.status==='waiting'&&reservation?.status==='started'&&/^projects\/(?:megabrain-v0-1017370021431|711042421394)\/locations\/(?:us|global)\/operations\/[A-Za-z0-9_-]+$/.test(snapshot.data.operation_name??''))return {status:'operation_pending',stage,task:{videoId,stage,poll:1}};
   const kind=settledRetryKind({claim:snapshot?.data,financial:reservation,video:v,videoId,stage});
   if(kind)return {status:'explicit_retry_available',kind,stage,execution_id:originalId};
   return {status:'needs_reconciliation',stage,execution_id:originalId,reason:'existing_attempt_or_unknown_result'};
  }
  return {status:'needs_reconciliation',reason:'completed_jobs_without_accepted_video'};
 }
 async request({videoId,recoveryId,authorizationRef}){
  if(!validRecovery(recoveryId)||!validReference(authorizationRef))throw Error('Identificador e autorização explícita obrigatórios.');
  const plan=await this.inspect(videoId);
  if(plan.status==='reconcile_saved_result')return this.flow?.reconcileAnalysis?this.flow.reconcileAnalysis({videoId,authorizationRef,executionId:plan.execution_id}):plan;
  if(!['ready_for_dispatch','unsubmitted','operation_pending','explicit_retry_available'].includes(plan.status))return plan;
  const f=(await this.store.get('settings/financial'))?.data,a=(await this.store.get('settings/automation'))?.data;
  if(f?.paused!==false||f.batch?.status!=='active'||a?.enabled!==true||plan.stage==='analysis'&&!a.analysis_enabled||plan.stage==='transcription'&&!a.transcription_enabled)return {status:'paused'};
  if(plan.status==='unsubmitted'){
   const dispatchId=await mutateDocument(this.store,`jobs/${plan.execution_id}`,async j=>{
    const current=(await this.store.get('settings/financial'))?.data,c=j.data;
    if(!current||current.jobs?.[plan.execution_id]||c.video_id!==videoId||c.stage!==plan.stage||!['blocked','retry_ready'].includes(c.status)||c.operation_name||c.analysis_attempts?.length||c.retry_recovery_id!==undefined&&!validRecovery(c.retry_recovery_id))return {changes:null,result:null};
    const id=c.retry_recovery_id??recoveryId;
    return {changes:c.status==='retry_ready'&&c.retry_recovery_id?null:{status:'retry_ready',retry_recovery_id:id,original_failure_diagnostic:c.original_failure_diagnostic??c.failure_diagnostic??null,recovery_authorization_ref:c.recovery_authorization_ref??authorizationRef},result:id};
   });
   if(!dispatchId)return {status:'needs_reconciliation'};
   recoveryId=dispatchId;
  }
  if(plan.status!=='explicit_retry_available')return this.queue.enqueue({...plan.task,recoveryId});
  const c=(await this.store.get(`jobs/${plan.execution_id}`))?.data,v=(await this.store.get(`videos/${videoId}`))?.data;
  const now=this.clock(),authorization={schema_version:1,status:'authorized',kind:plan.kind,original_execution_id:plan.execution_id,video_id:videoId,stage:plan.stage,maximum_cents:this.quotes[plan.stage],recovery_id:recoveryId,failure_digest:failureDigest(c.failure_diagnostic),authorization_ref:authorizationRef,authorized_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),previous_error:v.error??null};
  if(!settledRetryAllowed({authorization,claim:c,financial:f.jobs[plan.execution_id],video:v,originalId:plan.execution_id,videoId,stage:plan.stage,maximumCents:this.quotes[plan.stage],recoveryId,now}))return {status:'needs_reconciliation'};
  const path=settledRetryAuthorizationPath(plan.execution_id),created=await this.store.create(path,authorization);
  if(!created.created){const prior=(await this.store.get(path))?.data;if(!settledRetryAllowed({authorization:prior,claim:c,financial:f.jobs[plan.execution_id],video:v,originalId:plan.execution_id,videoId,stage:plan.stage,maximumCents:this.quotes[plan.stage],recoveryId,now}))return {status:'needs_reconciliation',reason:'authorization_already_exists'};}
  return this.queue.enqueue({videoId,stage:plan.stage,poll:0,recoveryId,recoverSettled:true});
 }
}
