import {createPipelineScope,validatePipelineApproval,assertPipelineHistory,assertAssistedJob,pipelineExecution} from './assisted-scope.mjs';

// Queue input carries a reference, never a capability. Every invocation reloads
// the same consumed approval and composes fresh stage-bound dependencies.
export async function pipelineFlow({store,task,stage,allowedVideoIds,quotes,analysisRevision,makeFlow,verifyExecutionStopped,clock=()=>Date.now()}){
 if(!task.unitRequestId||task.stage!==stage||allowedVideoIds?.length!==1||allowedVideoIds[0]!==task.videoId)throw Error('Pedido fora do escopo unitário.');
 const path='jobs/assisted_upload_'+task.unitRequestId,now=clock(),id=pipelineExecution(task.videoId,stage,analysisRevision);
 let receipt=await store.get(path);
 const existing=await store.get('jobs/'+id),financial=(await store.get('settings/financial'))?.data;
 const known=existing?.data.assisted_scope_ref===path&&financial?.jobs?.[id]?.assisted_scope_ref===path;
 const allowExpired=known&&(existing.data.status==='completed'||stage==='transcription'&&task.poll>0&&existing.data.status==='waiting');
 validatePipelineApproval(receipt?.data,{path,videoId:task.videoId,quotes,analysisRevision,now,allowExpired});
 const controls=(await store.get('settings/automation'))?.data,acquisition=(await store.get('settings/acquisition'))?.data;
 if(controls?.parallelism!==1||acquisition?.schema_version!==1||acquisition.parallelism!==1)throw Error('Concorrência unitária obrigatória.');
 if(receipt.data.status==='authorized'){
  if(controls.enabled!==true||acquisition.enabled!==true||stage!=='upload'||task.poll!==0||receipt.data.consumed_at!==undefined)throw Error('Somente aquisição pode consumir autorização.');
  const video=(await store.get('videos/'+task.videoId))?.data;
  if(!video||Object.values(financial?.jobs??{}).some(j=>j.video_id===task.videoId)||['media_verified','video_key','video_generation','audio_key','transcript_key','transcript','analysis','analysis_key','candidate_analysis_key'].some(k=>!!video[k]))throw Error('Reel unitário deve ser novo.');
  for(const s of ['upload','transcription','analysis'])if(await store.get('jobs/'+pipelineExecution(task.videoId,s,analysisRevision)))throw Error('Claim anterior impede nova aquisição.');
  // Unknown CAS outcome is never retried or inferred from a later GET.
  const consumedAt=new Date(now).toISOString();
  receipt=await store.patch(path,{status:'consumed',consumed_at:consumedAt},{updateTime:receipt.updateTime});
  if(!receipt?.updateTime||receipt.data?.status!=='consumed'||receipt.data.consumed_at!==consumedAt)throw Error('Consumo não confirmado.');
 }else if(receipt.data.status!=='consumed'||stage==='upload'&&!known)throw Error('Autorização já consumida sem execução confirmada.');
 const scope=await createPipelineScope({store,path,receipt,videoId:task.videoId,stage,quotes,analysisRevision,now,allowExpired});
 if(existing&&existing.data.assisted_scope_ref!==path)throw Error('Claim pertence a outro pedido.');
 assertPipelineHistory(scope,financial??{jobs:{}});
 if(known)assertAssistedJob(scope,id,financial.jobs[id]);
 if(stage!=='upload'){
  const prior=stage==='transcription'?'upload':'transcription',priorId=scope.executionIds[prior],claim=await store.get('jobs/'+priorId);
  if(claim?.data.status!=='completed'||claim.data.assisted_scope_ref!==path||claim.data.stage!==prior||claim.data.video_id!==task.videoId)throw Error('Encaminhamento sem conclusão persistida.');
  if(stage==='transcription'){
   const proof=await verifyExecutionStopped?.({executionId:priorId,videoId:task.videoId,stage:'upload',claimUpdateTime:claim.updateTime});
   if(proof?.ended!==true||proof.execution_id!==priorId||proof.claim_update_time!==claim.updateTime)throw Error('Encerramento da aquisição não confirmado.');
  }
 }
 if(task.poll>0&&(!known||!['waiting','completed'].includes(existing.data.status)))throw Error('Consulta sem operação própria.');
 return makeFlow(scope);
}
