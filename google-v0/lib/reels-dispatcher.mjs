import {createHash} from 'node:crypto';
const PROJECT='megabrain-v0-1017370021431';
const queues={acquisition:'v0-acquisition',transcription:'v0-transcription',analysis:'v0-analysis'};
const legacy={acquisition:'upload',transcription:'transcription',analysis:'analysis'};
export class ReelsDispatcher {
 constructor({api,store,routes,enabled=false,clock=Date.now}){Object.assign(this,{api,store,routes,clock});this.enabled=enabled===true;if(api.project!==PROJECT)throw Error('Projeto de filas inválido.');}
 async enqueue(job){
  if(!this.enabled)return {status:'disabled'};
  if(!job||!queues[job.stage]||!/^[a-f0-9]{64}$/.test(job.id??'')||!/^[a-f0-9]{64}$/.test(job.outboxId??''))throw Error('Dispatch inválido.');
  const route=this.routes?.[legacy[job.stage]],origin=new URL(route?.workerOrigin??'https://invalid.invalid');
  if(route?.queue!==queues[job.stage]||origin.protocol!=='https:'||!origin.hostname.endsWith('.run.app')||origin.origin!==route.workerOrigin)throw Error('Destino de etapa inválido.');
  const path='reels_command_items/'+job.outboxId,snapshot=await this.store.get(path);
  if(!snapshot||snapshot.data.executionId!==job.id||snapshot.data.stage!==job.stage||snapshot.data.poll!==Boolean(job.poll))throw Error('Outbox não corresponde à execução.');
  if(snapshot.data.status==='sent')return {status:'sent',duplicate:true};
  if(!['pending','creating','uncertain'].includes(snapshot.data.status))throw Error('Outbox inválida.');
  const parent=`projects/${PROJECT}/locations/us-central1/queues/${queues[job.stage]}`;
  const name=parent+'/tasks/reels_'+createHash('sha256').update(job.outboxId).digest('hex');
  // A deterministic task name is the reconciliation key after lost create responses.
  const current=await this.store.patch(path,{status:'creating',taskName:name},{updateTime:snapshot.updateTime});
  let status='sent';
  try {await this.api.request('https://cloudtasks.googleapis.com/v2/'+parent+'/tasks',{method:'POST',json:{task:{name,scheduleTime:new Date(this.clock()+(job.poll?30000:0)).toISOString(),dispatchDeadline:'900s',httpRequest:{httpMethod:'POST',url:origin.origin+'/tasks/run',headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify({executionId:job.id,poll:Boolean(job.poll)})).toString('base64'),oidcToken:{serviceAccountEmail:`v0-queue@${PROJECT}.iam.gserviceaccount.com`,audience:origin.origin}}}}});}
  catch(error){if(error.status!==409)status='uncertain';}
  // Do not fabricate dispatch success when acknowledgement was lost.
  await this.store.patch(path,{status,observedAt:new Date(this.clock()).toISOString()},{updateTime:current.updateTime});return {status,taskName:name};
 }
}
