import {isDeepStrictEqual} from 'node:util';
import {validateTask} from './worker-queue.mjs';

const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(value);
const videoId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{5,32}$/.test(value);
const reference=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(value);
const blocked=reason=>({status:'blocked',reason});
const uncertain=reason=>({status:'uncertain',reason});

// Internal composition only: the caller supplies trusted server dependencies,
// a server-owned allowlist and a request ID, never a task/HTTP bypass flag.
// Approvals live in the existing private jobs collection; this does not issue one.
export async function runAssistedUpload({store,flow,requestId:id,allowedVideoIds,clock=()=>Date.now(),...extra}){
  if(Object.keys(extra).length||!requestId(id)||!Array.isArray(allowedVideoIds)||!allowedVideoIds.length||allowedVideoIds.length>6||allowedVideoIds.some(x=>!videoId(x))||new Set(allowedVideoIds).size!==allowedVideoIds.length)return blocked('assisted_scope_invalid');
  const allowed=new Set(allowedVideoIds),path='jobs/assisted_upload_'+id;
  let snapshot;
  try{snapshot=await store.get(path);}catch{return blocked('assisted_authorization_unavailable');}
  const approval=snapshot?.data,now=clock();
  if(!approval||approval.schema_version!==1||approval.kind!=='assisted_upload'||approval.request_id!==id||!reference(approval.authorization_ref)||typeof snapshot.updateTime!=='string'||!snapshot.updateTime)return blocked('assisted_authorization_invalid');
  let task;
  try{task=structuredClone(validateTask(approval.task));}catch{return blocked('assisted_task_invalid');}
  if(task.stage!=='upload'||task.poll!==0||!allowed.has(task.videoId))return blocked('assisted_scope_invalid');
  const start=Date.parse(approval.authorized_at),end=Date.parse(approval.expires_at);
  if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end<=start||end-start>3600000)return blocked('assisted_authorization_expired');
  if(!Number.isSafeInteger(approval.maximum_cents)||approval.maximum_cents<1||approval.maximum_cents!==flow?.quotes?.upload)return blocked('assisted_quote_mismatch');
  if(approval.status!=='authorized')return blocked('assisted_already_requested');
  if(approval.consumed_at!==undefined||approval.outcome!==undefined)return blocked('assisted_already_requested');
  const consumedAt=new Date(now).toISOString();
  let receipt;
  // No automatic retry on CAS conflict, unknown commit outcome or lost receipt.
  try{receipt=await store.patch(path,{status:'consumed',consumed_at:consumedAt},{updateTime:snapshot.updateTime});}catch{return uncertain('assisted_acquisition_unconfirmed');}
  if(!receipt?.updateTime||receipt.data?.status!=='consumed'||receipt.data.consumed_at!==consumedAt)return uncertain('assisted_acquisition_unconfirmed');
  let outcome;
  try{
    // WorkerFlow.run owns all eligibility, financial, acquisition and end-proof
    // guards. No WorkerQueue, handler, poll or admission is composed here.
    const result=await flow.run(task);
    if(typeof result?.status!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(result.status))throw Error('Unknown result');
    outcome={status:result.status};
    if(typeof result.reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(result.reason))outcome.reason=result.reason;
    if(typeof result.execution_id==='string'&&/^job_[a-f0-9]{64}$/.test(result.execution_id))outcome.execution_id=result.execution_id;
    if(typeof result.duplicate==='boolean')outcome.duplicate=result.duplicate;
  }catch{outcome=uncertain('assisted_execution_unconfirmed');}
  // This is a request outcome, never an execution_stops proof. A lost receipt
  // keeps the consumed authorization and the real flow's result/reservation.
  try{
    const observedAt=new Date(clock()).toISOString();
    const finalReceipt=await store.patch(path,{outcome,observed_at:observedAt},{updateTime:receipt.updateTime});
    if(typeof finalReceipt?.updateTime!=='string'||!finalReceipt.updateTime||finalReceipt.updateTime===receipt.updateTime||finalReceipt.data?.status!=='consumed'||finalReceipt.data.consumed_at!==consumedAt||finalReceipt.data.observed_at!==observedAt||!isDeepStrictEqual(finalReceipt.data.outcome,outcome))return uncertain('assisted_result_unconfirmed');
  }catch{return uncertain('assisted_result_unconfirmed');}
  return outcome;
}

// Private entrypoint: the payload identifies an existing server approval only.
// Neither this handler nor the helper creates approvals or enqueues work.
export function assistedUploadHandler({store,flow,authorize,enabled=false,allowedVideoIds=[]}){
  if(typeof authorize!=='function')throw Error('Autenticação do worker obrigatória.');
  const ids=structuredClone(allowedVideoIds);
  const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  return async request=>{
    if(await authorize(request)!==true)return reply({error:'Acesso negado.'},401);
    if(request.method!=='POST')return reply({error:'Método inválido.'},405);
    if(enabled!==true)return reply(blocked('assisted_disabled'),409);
    let input;
    try{
      const text=await request.text();if(Buffer.byteLength(text)>2048)throw Error();
      input=JSON.parse(text);
      if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length!==1||!requestId(input.requestId))throw Error();
    }catch{return reply({error:'Pedido assistido inválido.'},400);}
    try{
      const controls=(await store.get('settings/automation'))?.data;
      const acquisition=(await store.get('settings/acquisition'))?.data;
      if(controls?.enabled!==true||controls.parallelism!==1||controls.transcription_enabled!==false||controls.analysis_enabled!==false||acquisition?.schema_version!==1||acquisition.enabled!==true||acquisition.parallelism!==1)return reply(blocked('assisted_controls_invalid'));
    }catch{return reply(blocked('assisted_controls_unavailable'));}
    return reply(await runAssistedUpload({store,flow,requestId:input.requestId,allowedVideoIds:ids}));
  };
}
