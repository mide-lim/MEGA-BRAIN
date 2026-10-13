import {mutateDocument} from './firestore.mjs';
import {reservationDecision} from './financial-ledger.mjs';
import {validateBatch,isolatedAnalysisTimeout} from './batch-budget.mjs';
import {executionId} from './worker-flow.mjs';

const runPattern=/^[A-Za-z0-9_-]{16,64}$/;
export function validateAdmissionTask(task){
 if(!task||Object.keys(task).some(k=>!['batchId','runId','tick'].includes(k))||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(task.batchId??'')||!runPattern.test(task.runId??'')||!Number.isSafeInteger(task.tick)||task.tick<0||task.tick>10000)throw Error('Admissão inválida.');
 return task;
}
function validControl(control,batch,task){
 if(!control||control.schema_version!==1||control.batch_id!==batch.id||control.run_id!==task.runId||!runPattern.test(control.run_id)||!control.intents||Array.isArray(control.intents)||Object.keys(control.intents).some(id=>!batch.video_ids.includes(id))||Object.values(control.intents).some(x=>!x||!['pending','queued','uncertain'].includes(x.status)))throw Error('Controle durável de admissão inválido.');
}
export class WorkerAdmission{
 constructor({store,queue,batchId,quotes,enabled=false,clock=()=>Date.now()}){Object.assign(this,{store,queue,batchId,quotes,enabled,clock});}
 async reconcilePlayback(control,financial){
  for(const [videoId,intent] of Object.entries(control.intents)){
   if(intent.playback_reconciled||!Object.values(financial.jobs??{}).some(j=>j.video_id===videoId&&j.stage==='analysis'&&j.status==='completed'))continue;
   const video=(await this.store.get(`videos/${videoId}`))?.data;
   const accepted=video?.status==='analyzed'&&video.analysis_quality_status==='accepted'&&!video.error&&video.media_verified===true&&video.video_key===`originals/instagram/${videoId}/video.mp4`&&video.analysis_key&&video.transcript_key;
   if(accepted)await mutateDocument(this.store,'settings/media_delivery',async snapshot=>{
    const policy=snapshot?.data;if(policy?.schema_version!==1||!Array.isArray(policy.allowed_ids))throw Error('Política de reprodução ausente.');
    return {changes:policy.allowed_ids.includes(videoId)?null:{allowed_ids:[...policy.allowed_ids,videoId]}};
   });
   await mutateDocument(this.store,'settings/admission',async snapshot=>({changes:{intents:{...snapshot.data.intents,[videoId]:{...snapshot.data.intents[videoId],playback_reconciled:accepted?'allowed':'not_accepted'}}}}));
  }
 }
 async run(input){
  const task=validateAdmissionTask(input);
  if(!this.enabled||task.batchId!==this.batchId)return {status:'disabled'};
  const financial=(await this.store.get('settings/financial'))?.data;
  const batch=validateBatch(financial?.batch);
  const controls=(await this.store.get('settings/automation'))?.data;
  const initial=(await this.store.get('settings/admission'))?.data;
  validControl(initial,batch,task);
  if(initial.enabled!==true||batch.id!==task.batchId||batch.video_ids.length!==262||batch.status!=='active'||financial.paused!==false||controls?.enabled!==true||controls.transcription_enabled!==true||controls.analysis_enabled!==true)return {status:'paused'};
  if(!Number.isInteger(controls.parallelism)||controls.parallelism<1||controls.parallelism>4)throw Error('Paralelismo inválido.');
  if(Object.values(initial.intents).some(x=>x.status==='uncertain'))return {status:'attention'};
  const probeId=batch.video_ids.find(id=>!initial.intents[id]&&!Object.values(financial.jobs??{}).some(j=>j.video_id===id))??batch.active_video_ids[0];
  if(probeId){const check=reservationDecision(financial,{now:this.clock(),maximumCents:this.quotes.upload,stage:'upload',videoId:probeId});if(!check.ready&&check.reasons.some(r=>!['Quatro videos em andamento.','Uma etapa deste video ja esta em andamento.'].includes(r)))return {status:'paused'};}
  let candidates=false;
  for(const id of batch.video_ids){if(initial.intents[id]||Object.values(financial.jobs??{}).some(j=>j.video_id===id))continue;const video=(await this.store.get(`videos/${id}`))?.data;if(video?.status==='pending'&&!video.instagram_review_status&&!video.analysis&&!video.media_verified){candidates=true;break;}}
  const publicationPending=Object.entries(initial.intents).some(([id,x])=>!x.playback_reconciled&&Object.values(financial.jobs??{}).some(j=>j.video_id===id&&j.stage==='analysis'&&j.status==='completed'));
  if(!candidates&&!publicationPending&&!batch.active_video_ids.length&&!Object.values(initial.intents).some(x=>x.status==='pending'))return {status:'idle'};
  // Install the successor before changing any admission intent. If this process
  // crashes, its deterministic successor reconciles pending intents on restart.
  if(task.tick===10000)return {status:'tick_limit'};
  await this.queue.enqueueAdmission({...task,tick:task.tick+1});
  await this.reconcilePlayback(initial,financial);
  const selected=await mutateDocument(this.store,'settings/admission',async snapshot=>{
   const state=snapshot.data;validControl(state,batch,task);
   if(state.enabled!==true||Object.values(state.intents).some(x=>x.status==='uncertain'))return {result:[],changes:null};
   const current=(await this.store.get('settings/financial'))?.data;
   const currentBatch=validateBatch(current.batch);
   const automation=(await this.store.get('settings/automation'))?.data;
   if(currentBatch.id!==task.batchId||currentBatch.status!=='active'||current.paused!==false||automation?.enabled!==true||!automation.transcription_enabled||!automation.analysis_enabled)return {result:[],changes:null};
   const limit=automation.parallelism;if(!Number.isInteger(limit)||limit<1||limit>4)throw Error('Paralelismo inválido.');
   const busy=new Set(currentBatch.active_video_ids);
   for(const id of Object.keys(state.intents)){
    const jobs=Object.values(current.jobs??{}).filter(j=>j.video_id===id);
    const settled=jobs.some(j=>j.stage==='analysis'&&j.status==='completed')||jobs.some(j=>isolatedAnalysisTimeout(j,currentBatch));
    if(settled)continue;
    const claim=(await this.store.get(`jobs/${executionId(id,'upload')}`))?.data;
    const d=claim?.failure_diagnostic;
    const sourceAccounted=jobs.some(j=>j.stage==='upload'&&j.status==='completed'&&j.manual_reconciliation==='terminal_metadata_estimate_accounted_user_verdict_pending');
    if(sourceAccounted&&claim?.status==='uncertain'&&d?.operation_step==='download_media'&&d.tool_code===1&&d.download?.exit_code===1&&(d.download.phase==='metadata'||d.download.phase==='format_selection'&&d.download.cause==='format_unavailable')){
     const v=(await this.store.get(`videos/${id}`))?.data,review=(await this.store.get(`analyses/ig_error_${id}`))?.data;
     if(v?.status==='needs_attention'&&!v.media_verified&&!v.video_key&&review?.review_status==='awaiting_user_verdict')continue;
    }
    const blockedBeforePayment=claim?.status==='blocked'&&!jobs.some(j=>['reserved','started','uncertain'].includes(j.status));
    if(!settled&&!blockedBeforePayment)busy.add(id);
   }
   const intents={...state.intents};const chosen=[];
   for(const id of currentBatch.video_ids){
    if(busy.size>=limit)break;
    if(intents[id]||busy.has(id)||Object.values(current.jobs??{}).some(j=>j.video_id===id))continue;
    const video=(await this.store.get(`videos/${id}`))?.data;
    if(video?.status!=='pending'||video.instagram_review_status||video.analysis||video.media_verified)continue;
    if(await this.store.get(`jobs/${executionId(id,'upload')}`))continue;
    const decision=reservationDecision(current,{now:this.clock(),maximumCents:this.quotes.upload,stage:'upload',videoId:id});
    if(!decision.ready)return {result:chosen,changes:chosen.length?{intents}:null};
    intents[id]={status:'pending',created_at:new Date(this.clock()).toISOString()};chosen.push(id);busy.add(id);
   }
   return {result:chosen,changes:chosen.length?{intents}:null};
  });
  // Include intents left before a crash. Only the deterministic create-only
  // upload outbox can dispatch them. Unknown outboxes remain held for review.
  const persisted=(await this.store.get('settings/admission')).data;
  let dispatched=0;
  for(const [videoId,intent] of Object.entries(persisted.intents)){
   if(intent.status!=='pending')continue;
   const receipt=await this.queue.enqueue({videoId,stage:'upload',poll:0});
   let status=receipt.status==='queued'?'queued':'uncertain';
   if(receipt.status==='duplicate')status=(await this.store.get(this.queue.dispatchPath({videoId,stage:'upload',poll:0})))?.data.status==='queued'?'queued':'uncertain';
   await mutateDocument(this.store,'settings/admission',async snapshot=>({changes:{intents:{...snapshot.data.intents,[videoId]:{...snapshot.data.intents[videoId],status}}}}));
   if(status==='uncertain')return {status:'attention',dispatched};
   dispatched++;
  }
  return {status:'running',selected:selected.length,dispatched};
 }
}
export function admissionHandler({admission,authorize}){
 if(typeof authorize!=='function')throw Error('Autenticação obrigatória.');
 return async request=>{
  if(await authorize(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
  if(request.method!=='POST')return Response.json({error:'Método inválido.'},{status:405});
  let task;try{const text=await request.text();if(text.length>2048)throw Error();task=validateAdmissionTask(JSON.parse(text));}catch{return Response.json({error:'Admissão inválida.'},{status:400});}
  try{return Response.json(await admission.run(task),{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'Admissão precisa de conferência.'},{status:500});}
 };
}
