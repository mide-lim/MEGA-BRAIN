import {mutateDocument} from './firestore.mjs';
// This is a source verdict hold, not a declaration that a reel is invalid.
// Authentication, rate limits, network, timeout and transfer failures do not fit.
export function terminalSourceFailure(d){
 const x=d?.download;
 return d?.operation_step==='download_media'&&d.tool_code===1&&d.http_status===null&&x?.exit_code===1&&(
  x.phase==='metadata'&&['unknown','unavailable','http_404','format_unavailable'].includes(x.cause)||
  x.phase==='format_selection'&&x.cause==='format_unavailable'
 );
}
export async function recordSourceHold(store,{videoId,executionId,diagnostic,observedAt}){
 if(!terminalSourceFailure(diagnostic))throw Error('Origem não admite isolamento.');
 const path=`analyses/ig_error_${videoId}`;
 const event={event_id:`source_${executionId}`,kind:'worker_failure',observed_at:observedAt,diagnostic,environment:'Cloud Run worker'};
 const previous=await store.get(path);
 const fields={video_id:videoId,instagram_url:`https://www.instagram.com/p/${videoId}/`,review_status:'awaiting_user_verdict',processing_status:'needs_attention',private_or_deleted_not_confirmed:true,updated_at:observedAt};
 if(!previous){const created=await store.create(path,{...fields,user_verdict:null,events:[event]});if(!created.created)throw Error('Registro de veredito concorrente; conferir antes de continuar.');}
 else await mutateDocument(store,path,async snapshot=>{
  const events=snapshot.data.events??[];
  return {changes:{...fields,events:events.some(x=>x.event_id===event.event_id)?events:[...events,event]}};
 });
 const audit={kind:'terminal_source_verdict_hold',video_id:videoId,execution_id:executionId,diagnostic,original_object_absent:true,previous_review:previous?.data??null,provider_inference_submitted:false,not_actual_billing:true,created_at:observedAt};
 const result=await store.create(`analyses/source_hold_${executionId}`,audit);
 if(!result.created)throw Error('Auditoria de isolamento já existe; conferir estado.');
 return path;
}
