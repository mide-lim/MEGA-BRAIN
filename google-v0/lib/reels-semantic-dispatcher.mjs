import {semanticHash} from './reels-semantic-source.mjs';
const PROJECT='megabrain-v0-1017370021431',QUEUE='v0-curation';
const origins=['https://megabrain-v0-analysis-711042421394.us-central1.run.app','https://megabrain-v0-analysis-i5gepiv7hq-uc.a.run.app'];
export class ReelsSemanticDispatcher{
 constructor({api,workerOrigin}){if(api?.project!==PROJECT)throw Error('Projeto de curadoria inválido.');this.api=api;this.workerOrigin=workerOrigin;}
 task(job){
  if(!origins.includes(this.workerOrigin)||!/^[a-f0-9]{64}$/.test(job?.id??'')||!Number.isSafeInteger(job.dispatch?.sequence)||job.dispatch.sequence<0||job.dispatch.outboxId!==semanticHash({jobId:job.id,sequence:job.dispatch.sequence}))throw Error('Entrega de curadoria inválida.');
  const parent='projects/'+PROJECT+'/locations/us-central1/queues/'+QUEUE,body={jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId};
  const task={name:parent+'/tasks/curation_'+job.dispatch.outboxId,dispatchDeadline:'600s',httpRequest:{httpMethod:'POST',url:this.workerOrigin+'/tasks/curation',headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(body)).toString('base64'),oidcToken:{serviceAccountEmail:'v0-queue@'+PROJECT+'.iam.gserviceaccount.com',audience:this.workerOrigin}}};
  return {parent,task};
 }
 same(a,b){return !!b&&a.name===b.name&&a.httpRequest.httpMethod===b.httpRequest?.httpMethod&&a.httpRequest.url===b.httpRequest.url&&a.httpRequest.body===b.httpRequest.body&&semanticHash(a.httpRequest.oidcToken)===semanticHash(b.httpRequest.oidcToken);}
 async enqueue(job){
  const {parent,task}=this.task(job);
  try{const r=await this.api.request('https://cloudtasks.googleapis.com/v2/'+parent+'/tasks',{method:'POST',json:{task,responseView:'FULL'}});if(this.same(task,r))return {status:'sent',taskName:task.name};}catch{/* A metadata-only lookup reconciles an ambiguous create; no provider submission. */}
  try{const existing=await this.api.request('https://cloudtasks.googleapis.com/v2/'+task.name+'?responseView=FULL');if(this.same(task,existing))return {status:'sent',taskName:task.name};}catch{}
  return {status:'pending',reason:'CURATION_TASK_UNCONFIRMED',taskName:task.name};
 }
}
