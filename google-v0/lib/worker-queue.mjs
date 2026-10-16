import {createHash} from 'node:crypto';
const project='megabrain-v0-1017370021431';
const stageQueues={upload:'v0-acquisition',transcription:'v0-transcription',analysis:'v0-analysis'};
const privateOrigin=value=>{
  const origin=new URL(value);
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.run.app')||origin.origin!==value||origin.username||origin.password)throw new Error('Destino privado Google obrigatório.');
  return value;
};
const routesFor=routes=>{
  if(!routes||typeof routes!=='object'||Array.isArray(routes)||Object.keys(routes).length!==3||Object.keys(routes).some(stage=>!Object.hasOwn(stageQueues,stage)))throw Error('Rotas das três etapas obrigatórias.');
  const result={};
  for(const [stage,queue] of Object.entries(stageQueues)){
    const route=routes[stage];
    if(!route||typeof route!=='object'||Array.isArray(route)||Object.keys(route).length!==2||Object.keys(route).some(key=>!['queue','workerOrigin'].includes(key))||route.queue!==queue)throw Error('Fila da etapa inválida.');
    result[stage]=Object.freeze({queue,workerOrigin:privateOrigin(route.workerOrigin)});
  }
  if(new Set(Object.values(result).map(route=>route.workerOrigin)).size!==3)throw Error('Destinos das etapas devem ser distintos.');
  return Object.freeze(result);
};
export function validateTask(task){
  if(!task||(task.unitRequestId!==undefined&&(typeof task.unitRequestId!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(task.unitRequestId)||['recoveryId','recoverSettled','recoverUpload','recoverAnalysis429','recoverFirestoreWrite'].some(k=>task[k]!==undefined)))||(task.recoverSettled!==undefined&&(task.recoverSettled!==true||!['upload','analysis'].includes(task.stage)||task.poll!==0||!task.recoveryId||task.recoverUpload||task.recoverAnalysis429||task.recoverFirestoreWrite))||(task.recoverFirestoreWrite!==undefined&&(task.recoverFirestoreWrite!==true||!['upload','transcription'].includes(task.stage)||task.poll!==0||!task.recoveryId||task.recoverUpload||task.recoverAnalysis429))||(task.recoverUpload!==undefined&&(task.recoverUpload!==true||task.stage!=='upload'||task.poll!==0||!task.recoveryId||task.recoverAnalysis429))||(task.recoverAnalysis429!==undefined&&(task.recoverAnalysis429!==true||task.stage!=='analysis'||task.poll!==0||!task.recoveryId))||Object.keys(task).some(k=>!['videoId','stage','poll','recoveryId','recoverAnalysis429','recoverUpload','recoverFirestoreWrite','recoverSettled','unitRequestId'].includes(k))||(task.recoveryId!==undefined&&!/^[A-Za-z0-9_-]{16,64}$/.test(task.recoveryId))||!/^[A-Za-z0-9_-]{5,32}$/.test(task.videoId??'')||!['upload','transcription','analysis'].includes(task.stage)||!Number.isInteger(task.poll)||task.poll<0||task.poll>120||(task.poll>0&&task.stage!=='transcription'))throw new Error('Tarefa inválida.');
  return task;
}
export class WorkerQueue{
  constructor({api,store,workerOrigin,stageRoutes=null,enabled=false,clock=()=>Date.now()}){
    if(api.project!==project)throw new Error('Destino privado Google obrigatório.');
    privateOrigin(workerOrigin);
    Object.assign(this,{api,store,workerOrigin,enabled,clock});
    Object.defineProperty(this,'stageRoutes',{value:stageRoutes===null?null:routesFor(stageRoutes),enumerable:true});
    this.parent=`projects/${project}/locations/us-central1/queues/v0-processing`;
  }
  destination(stage){
    const route=this.stageRoutes?.[stage];
    return route?{parent:`projects/${project}/locations/us-central1/queues/${route.queue}`,workerOrigin:route.workerOrigin}:{parent:this.parent,workerOrigin:this.workerOrigin};
  }
  dispatchPath(task){return `jobs/dispatch_${createHash('sha256').update(JSON.stringify([task.videoId,task.stage,task.poll,...(task.unitRequestId?['unit_pipeline_v1',task.unitRequestId]:[]),...(task.recoveryId?[task.recoveryId]:[]),...(task.recoverAnalysis429?[true]:[]),...(task.recoverUpload?['upload_recovery']:[]),...(task.recoverFirestoreWrite?['firestore_metadata_recovery']:[]),...(task.recoverSettled?['settled_retry_v1']:[])])).digest('hex')}`;}
  async enqueueAdmission(task){
    if(!this.enabled)throw Error('Dispatch desativado.');
    if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(task.batchId??'')||!/^[A-Za-z0-9_-]{16,64}$/.test(task.runId??'')||!Number.isSafeInteger(task.tick)||task.tick<0||task.tick>10000)throw Error('Tick inválido.');
    const {parent,workerOrigin}=this.destination('upload');
    const id='admit_'+createHash('sha256').update(JSON.stringify([task.batchId,task.runId,task.tick])).digest('hex');
    try{await this.api.request(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`,{method:'POST',json:{task:{name:`${parent}/tasks/${id}`,scheduleTime:new Date(this.clock()+60000).toISOString(),dispatchDeadline:'900s',httpRequest:{httpMethod:'POST',url:workerOrigin+'/tasks/admit',headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(task)).toString('base64'),oidcToken:{serviceAccountEmail:`v0-queue@${project}.iam.gserviceaccount.com`,audience:workerOrigin}}}}});}catch(error){if(error.status!==409)throw error;}
    return {status:'queued'};
  }
  async enqueue(input){
    const task=validateTask(input);
    if(!this.enabled)return {status:'disabled'};
    const id='dispatch_'+createHash('sha256').update(JSON.stringify([task.videoId,task.stage,task.poll,...(task.unitRequestId?['unit_pipeline_v1',task.unitRequestId]:[]),...(task.recoveryId?[task.recoveryId]:[]),...(task.recoverAnalysis429?[true]:[]),...(task.recoverUpload?['upload_recovery']:[]),...(task.recoverFirestoreWrite?['firestore_metadata_recovery']:[]),...(task.recoverSettled?['settled_retry_v1']:[])])).digest('hex');
    const {parent,workerOrigin}=this.destination(task.stage);
    const path=`jobs/${id}`,name=`${parent}/tasks/${id}`;
    // Outbox first. An unknown create response is reconciled manually against
    // the deterministic task name, never blindly enqueued again.
    const claim=await this.store.create(path,{kind:'dispatch',status:'creating',task_name:name,payload:task});
    if(!claim.created){
      const existing=await this.store.get(path);
      if(existing?.data.task_name&&existing.data.task_name!==name)return {status:'blocked',reason:'requires_queue_migration'};
      return {status:'duplicate'};
    }
    const update=async status=>{const current=await this.store.get(path);await this.store.patch(path,{status},{updateTime:current.updateTime});};
    try{
      await this.api.request(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`,{method:'POST',json:{task:{name,scheduleTime:new Date(this.clock()+(task.poll?60000:0)).toISOString(),dispatchDeadline:'900s',httpRequest:{httpMethod:'POST',url:workerOrigin+'/tasks/run',headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(task)).toString('base64'),oidcToken:{serviceAccountEmail:`v0-queue@${project}.iam.gserviceaccount.com`,audience:workerOrigin}}}}});
      await update('queued');return {status:'queued'};
    }catch(error){
      await update(error.status===409?'queued':'uncertain');
      return {status:error.status===409?'queued':'uncertain'};
    }
  }
}
export function workerHandler({flow,queue,authorize,stage=null,unitFlow=null,requireUnitRequest=false}){
  if(stage!==null&&!Object.hasOwn(stageQueues,stage))throw new Error('Etapa do worker inválida.');
  if(typeof authorize!=='function')throw new Error('Autenticação do worker obrigatória.');
  return async request=>{
    // Must validate Google OIDC issuer, signature, audience and v0-queue
    // identity. Task headers alone are not authentication.
    if(await authorize(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
    if(request.method!=='POST')return Response.json({error:'Método inválido.'},{status:405});
    let task;
    try{const text=await request.text();if(text.length>2048)throw new Error();task=validateTask(JSON.parse(text));}catch{return Response.json({error:'Tarefa inválida.'},{status:400});}
    if(stage!==null&&task.stage!==stage)return Response.json({status:'blocked',reason:'wrong_stage'},{status:409,headers:{'Cache-Control':'no-store'}});
    try{
      if((task.unitRequestId&&!unitFlow)||(requireUnitRequest&&!task.unitRequestId))return Response.json({status:'blocked',reason:'unit_authorization_required'},{status:409});
      const currentFlow=task.unitRequestId?await unitFlow(task):flow;
      const result=task.poll?await currentFlow.poll({videoId:task.videoId}):await currentFlow.run(task);
      let next=null;
      if(result.status==='waiting'&&task.stage==='transcription'&&task.poll<120)next={videoId:task.videoId,stage:'transcription',poll:task.poll+1};
      if(result.status==='completed'&&task.stage!=='analysis')next={videoId:task.videoId,stage:task.stage==='upload'?'transcription':'analysis',poll:0};
      if(next&&task.unitRequestId)next.unitRequestId=task.unitRequestId;
      if(next&&task.recoveryId)next.recoveryId=task.recoveryId;
      const dispatch=next?await queue.enqueue(next):null;
      return Response.json({status:result.status,dispatch:dispatch?.status??null,...(dispatch?.reason?{dispatch_reason:dispatch.reason}:{}),poll_limit:result.status==='waiting'&&task.poll===120},{headers:{'Cache-Control':'no-store'}});
    }catch{return Response.json({error:'Execução precisa de conferência.'},{status:500});}
  };
}
