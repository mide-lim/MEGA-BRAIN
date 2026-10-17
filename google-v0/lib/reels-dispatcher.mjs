import {hash,canonical,ensure,cas,nowISO,fail} from './reels-runtime.mjs';
const PROJECT='megabrain-v0-1017370021431';
const queues={acquisition:'v0-acquisition',transcription:'v0-transcription',analysis:'v0-analysis'};
const legacy={acquisition:'upload',transcription:'transcription',analysis:'analysis'};
const validId=id=>/^[a-f0-9]{64}$/.test(id??'');
export class ReelsDispatcher {
 constructor({api,store,routes,enabled=false,clock=Date.now}){Object.assign(this,{api,store,routes,clock});this.enabled=enabled===true;if(api.project!==PROJECT)throw Error('Projeto de filas inválido.');}
 async enqueueControl(operation,{sequence=operation.cursor??0,recoveryId=null}={}){
  if(!this.enabled)return {status:'disabled'};
  if(!validId(operation?.id)||!Number.isSafeInteger(sequence)||sequence<0||recoveryId!==null&&!validId(recoveryId))throw Error('Controle inválido.');
  const id=hash('control:'+operation.id+':'+sequence+(recoveryId?':recovery:'+recoveryId:''));
  await ensure(this.store,'reels_command_items/'+id,{id,kind:'control',operationId:operation.id,sequence,...(recoveryId?{recoveryId}:{}),stage:'acquisition',status:'pending',createdAt:nowISO(this.clock)});
  return this.dispatch({outboxId:id,stage:'acquisition',kind:'control',operationId:operation.id,sequence,recoveryId});
 }
 async enqueue(job){
  if(!this.enabled)return {status:'disabled'};
  if(!job||!queues[job.stage]||!validId(job.id)||!validId(job.outboxId))throw Error('Dispatch inválido.');
  return this.dispatch({...job,kind:'stage'});
 }
 task(intent){
  const route=this.routes?.[legacy[intent.stage]],origin=new URL(route?.workerOrigin??'https://invalid.invalid');
  if(route?.queue!==queues[intent.stage]||origin.protocol!=='https:'||!origin.hostname.endsWith('.run.app')||origin.origin!==route.workerOrigin)throw Error('Destino de etapa inválido.');
  const parent=`projects/${PROJECT}/locations/us-central1/queues/${queues[intent.stage]}`;
  const name=parent+'/tasks/reels_'+hash(intent.outboxId);
  const body=intent.kind==='control'?{operationId:intent.operationId,sequence:intent.sequence,outboxId:intent.outboxId}:{executionId:intent.id,poll:Boolean(intent.poll),outboxId:intent.outboxId};
  const task={name,scheduleTime:new Date(this.clock()+(intent.poll?30000:0)).toISOString(),dispatchDeadline:'900s',httpRequest:{httpMethod:'POST',url:origin.origin+(intent.kind==='control'?'/tasks/control':'/tasks/run'),headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(body)).toString('base64'),oidcToken:{serviceAccountEmail:`v0-queue@${PROJECT}.iam.gserviceaccount.com`,audience:origin.origin}}};
  return {parent,task};
 }
 sameTask(expected,actual){
  if(!actual||actual.name!==expected.name)return false;
  const a=actual.httpRequest,b=expected.httpRequest;
  // FULL view is mandatory: an opaque 409 or tombstone proves no payload.
  return a?.httpMethod===b.httpMethod&&a.url===b.url&&a.body===b.body&&canonical(a.oidcToken)===canonical(b.oidcToken);
 }
 async dispatch(intent){
  const {parent,task}=this.task(intent),path='reels_command_items/'+intent.outboxId;
  let snapshot=await this.store.get(path);const data=snapshot?.data;
  if(!data||data.stage!==intent.stage||(intent.kind==='control'?(data.kind!=='control'||data.operationId!==intent.operationId||data.sequence!==intent.sequence||(data.recoveryId??null)!==(intent.recoveryId??null)):(data.executionId!==intent.id||data.poll!==Boolean(intent.poll))))throw Error('Outbox não corresponde à execução.');
  if(data.status==='sent')return {status:'sent',duplicate:true,taskName:data.taskName??task.name};
  if(!['pending','creating','uncertain'].includes(data.status))throw Error('Outbox inválida.');
  await cas(this.store,path,current=>current.status==='sent'?null:{status:'creating',taskName:task.name,requestHash:hash(task.httpRequest)});
  let confirmed=false;
  try{const created=await this.api.request('https://cloudtasks.googleapis.com/v2/'+parent+'/tasks',{method:'POST',json:{task,responseView:'FULL'}});confirmed=this.sameTask(task,created);}
  catch(error){if(error.status===409){try{const existing=await this.api.request('https://cloudtasks.googleapis.com/v2/'+task.name+'?responseView=FULL');confirmed=this.sameTask(task,existing);}catch{/* Missing payload/tombstone remains uncertain. */}}}
  snapshot=await cas(this.store,path,current=>({status:current.workerReceivedAt||current.status==='sent'||confirmed?'sent':'uncertain',observedAt:nowISO(this.clock)}));
  return {status:snapshot.data.status,taskName:task.name};
 }
 async acknowledge({outboxId,executionId,operationId,sequence,stage,poll=false}){
  if(!validId(outboxId))throw fail('INVALID_OUTBOX','Outbox ausente.',409);
  const path='reels_command_items/'+outboxId,snapshot=await this.store.get(path),data=snapshot?.data;
  if(!data||data.stage!==stage||(operationId?(data.kind!=='control'||data.operationId!==operationId||data.sequence!==sequence):(data.executionId!==executionId||data.poll!==poll)))throw fail('INVALID_OUTBOX','Entrega fora da outbox.',409);
  await cas(this.store,path,current=>current.workerReceivedAt?null:{status:'sent',workerReceivedAt:nowISO(this.clock)});
 }
}
