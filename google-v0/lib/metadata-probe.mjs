import {safeDownloadDiagnostic} from './media-tools.mjs';
// Queue identity only, one claim per original upload attempt. This handler has
// no processing flow, ledger mutation, storage or dispatch capability.
export function metadataProbeHandler({store,tools,authorize,batchId,eligibleVideos=[],clock=()=>Date.now()}){
 return async request=>{
  if(await authorize(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
  if(request.method!=='POST')return Response.json({error:'Método inválido.'},{status:405});
  let task;
  try{
   const text=await request.text();if(text.length>2048)throw new Error();task=JSON.parse(text);
   if(!task||Object.keys(task).sort().join(',')!=='jobId,videoId'||!/^job_[a-f0-9]{64}$/.test(task.jobId)||!/^[A-Za-z0-9_-]{5,32}$/.test(task.videoId))throw new Error();
  }catch{return Response.json({error:'Pedido inválido.'},{status:400});}
  try{
   const financial=(await store.get('settings/financial'))?.data,controls=(await store.get('settings/automation'))?.data;
   const job=financial?.jobs?.[task.jobId],original=(await store.get('jobs/'+task.jobId))?.data,video=(await store.get('videos/'+task.videoId))?.data;
   if(!batchId||financial?.paused!==true||controls?.enabled!==false||financial?.batch?.id!==batchId||financial.batch.status!=='paused'||!financial.batch.video_ids?.includes(task.videoId)||!eligibleVideos.includes(task.videoId)||job?.batch_id!==batchId||job?.status!=='uncertain'||job.stage!=='upload'||job.video_id!==task.videoId||original?.status!=='uncertain'||original.stage!=='upload'||original.video_id!==task.videoId||video?.status!=='needs_attention'||video.id!==task.videoId)return Response.json({status:'blocked'},{status:409});
   const path='jobs/probe_'+task.jobId;
   const claim=await store.create(path,{kind:'metadata_probe',status:'started',video_id:task.videoId,original_job_id:task.jobId,created_at:new Date(clock()).toISOString()});
   if(!claim.created)return Response.json({status:'already_claimed'});
   // Recheck pause after acquiring the claim; never release a claim for replay.
   const f=(await store.get('settings/financial'))?.data,c=(await store.get('settings/automation'))?.data;
   if(f?.paused!==true||f?.batch?.status!=='paused'||f?.batch?.id!==batchId||f?.jobs?.[task.jobId]?.status!=='uncertain'||c?.enabled!==false){await store.patch(path,{status:'blocked'},{updateTime:claim.updateTime});return Response.json({status:'blocked'},{status:409});}
   const result=await tools.probeMetadata(video);
   const status=result?.status==='metadata_available'?'metadata_available':'metadata_failed';
   await store.patch(path,{status,diagnostic:safeDownloadDiagnostic(result?.diagnostic),completed_at:new Date(clock()).toISOString()},{updateTime:claim.updateTime});
   return Response.json({status},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Diagnóstico precisa de conferência.'},{status:500});}
 };
}
