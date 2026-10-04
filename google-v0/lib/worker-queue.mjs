import {createHash} from 'node:crypto';
const project='megabrain-v0-1017370021431';
export function validateTask(task){
  if(!task||Object.keys(task).some(k=>!['videoId','stage','poll','recoveryId'].includes(k))||(task.recoveryId!==undefined&&!/^[A-Za-z0-9_-]{16,64}$/.test(task.recoveryId))||!/^[A-Za-z0-9_-]{5,32}$/.test(task.videoId??'')||!['upload','transcription','analysis'].includes(task.stage)||!Number.isInteger(task.poll)||task.poll<0||task.poll>120||(task.poll>0&&task.stage!=='transcription'))throw new Error('Tarefa inválida.');
  return task;
}
export class WorkerQueue{
  constructor({api,store,workerOrigin,enabled=false,clock=()=>Date.now()}){
    const origin=new URL(workerOrigin);
    if(api.project!==project||origin.protocol!=='https:'||!origin.hostname.endsWith('.run.app')||origin.origin!==workerOrigin||origin.username||origin.password)throw new Error('Destino privado Google obrigatório.');
    Object.assign(this,{api,store,workerOrigin,enabled,clock});
    this.parent=`projects/${project}/locations/us-central1/queues/v0-processing`;
  }
  async enqueue(input){
    const task=validateTask(input);
    if(!this.enabled)return {status:'disabled'};
    const id='dispatch_'+createHash('sha256').update(JSON.stringify([task.videoId,task.stage,task.poll,...(task.recoveryId?[task.recoveryId]:[])])).digest('hex');
    const path=`jobs/${id}`,name=`${this.parent}/tasks/${id}`;
    // Outbox first. An unknown create response is reconciled manually against
    // the deterministic task name, never blindly enqueued again.
    const claim=await this.store.create(path,{kind:'dispatch',status:'creating',task_name:name,payload:task});
    if(!claim.created)return {status:'duplicate'};
    const update=async status=>{const current=await this.store.get(path);await this.store.patch(path,{status},{updateTime:current.updateTime});};
    try{
      await this.api.request(`https://cloudtasks.googleapis.com/v2/${this.parent}/tasks`,{method:'POST',json:{task:{name,scheduleTime:new Date(this.clock()+(task.poll?60000:0)).toISOString(),dispatchDeadline:'900s',httpRequest:{httpMethod:'POST',url:this.workerOrigin+'/tasks/run',headers:{'Content-Type':'application/json'},body:Buffer.from(JSON.stringify(task)).toString('base64'),oidcToken:{serviceAccountEmail:`v0-queue@${project}.iam.gserviceaccount.com`,audience:this.workerOrigin}}}}});
      await update('queued');return {status:'queued'};
    }catch(error){
      await update(error.status===409?'queued':'uncertain');
      return {status:error.status===409?'queued':'uncertain'};
    }
  }
}
export function workerHandler({flow,queue,authorize}){
  if(typeof authorize!=='function')throw new Error('Autenticação do worker obrigatória.');
  return async request=>{
    // Must validate Google OIDC issuer, signature, audience and v0-queue
    // identity. Task headers alone are not authentication.
    if(await authorize(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
    if(request.method!=='POST')return Response.json({error:'Método inválido.'},{status:405});
    let task;
    try{const text=await request.text();if(text.length>2048)throw new Error();task=validateTask(JSON.parse(text));}catch{return Response.json({error:'Tarefa inválida.'},{status:400});}
    try{
      const result=task.poll?await flow.poll({videoId:task.videoId}):await flow.run(task);
      let next=null;
      if(result.status==='waiting'&&task.poll<120)next={videoId:task.videoId,stage:'transcription',poll:task.poll+1};
      if(result.status==='completed'&&task.stage!=='analysis')next={videoId:task.videoId,stage:task.stage==='upload'?'transcription':'analysis',poll:0};
      if(next&&task.recoveryId)next.recoveryId=task.recoveryId;
      const dispatch=next?await queue.enqueue(next):null;
      return Response.json({status:result.status,dispatch:dispatch?.status??null,poll_limit:result.status==='waiting'&&task.poll===120},{headers:{'Cache-Control':'no-store'}});
    }catch{return Response.json({error:'Execução precisa de conferência.'},{status:500});}
  };
}
