import {mutateDocument} from './firestore.mjs';
import {executionId} from './worker-flow.mjs';

const path='settings/acquisition';
const job=id=>typeof id==='string'&&/^job_[a-f0-9]{64}$/.test(id);
const attempt=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const video=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
const keyFor=x=>`${x.executionId}_${x.attemptId.replaceAll('-','')}`;
const validEntry=x=>x&&job(x.execution_id)&&attempt(x.attempt_id)&&video(x.video_id)&&typeof x.acquired_at==='string'&&Number.isFinite(Date.parse(x.acquired_at));
function validate(data){
 if(data?.schema_version!==1||typeof data.enabled!=='boolean'||!Number.isInteger(data.parallelism)||data.parallelism<1||data.parallelism>4||!data.active||typeof data.active!=='object'||Array.isArray(data.active)||Object.keys(data.active).length>4||Object.entries(data.active).some(([key,x])=>!validEntry(x)||key!==keyFor({executionId:x.execution_id,attemptId:x.attempt_id})))throw Error('Controle de aquisição ausente ou inválido.');
 return data;
}
// No lease expiry. Only positive evidence from the awaited worker lifecycle
// may release an entry. A lost receipt is held, never guessed to have failed.
export class AcquisitionControl{
 constructor({store,verifyExecutionStopped,maximumParallelism=4,clock=()=>Date.now()}){if(!Number.isInteger(maximumParallelism)||maximumParallelism<1||maximumParallelism>4)throw Error('Limite de aquisição inválido.');if(!store||typeof verifyExecutionStopped!=='function')throw Error('Verificador de encerramento obrigatório.');Object.assign(this,{store,verifyExecutionStopped,maximumParallelism,clock});}
 async acquire(input){
  if(!job(input.executionId)||!attempt(input.attemptId)||!video(input.videoId))throw Error('Identidade de aquisição inválida.');
  return mutateDocument(this.store,path,async snapshot=>{
   const state=validate(snapshot.data),active=state.active;
   if(!state.enabled||Object.keys(active).length>=Math.min(state.parallelism,this.maximumParallelism)||Object.values(active).some(x=>x.execution_id===input.executionId||x.video_id===input.videoId))return {result:false,changes:null};
   return {result:true,changes:{active:{...active,[keyFor(input)]:{execution_id:input.executionId,attempt_id:input.attemptId,video_id:input.videoId,acquired_at:new Date(this.clock()).toISOString()}}}};
  });
 }
 async ended(executionId,videoId,expectedAttempt){
  const claim=await this.store.get(`jobs/${executionId}`);
  if(!claim||expectedAttempt&&claim.data.execution_attempt_id!==expectedAttempt)return false;
  const proof=await this.verifyExecutionStopped({executionId,videoId,stage:'upload',claimUpdateTime:claim.updateTime});
  return proof?.ended===true&&proof.execution_id===executionId&&proof.claim_update_time===claim.updateTime;
 }
 async release(input){
  if(!job(input.executionId)||!attempt(input.attemptId)||!video(input.videoId))return false;
  if(!await this.ended(input.executionId,input.videoId,input.attemptId))return false;
  return mutateDocument(this.store,path,async snapshot=>{
   const state=validate(snapshot.data),active={...state.active},key=keyFor(input),entry=active[key];
   if(!entry)return {result:true,changes:null};
   if(entry.video_id!==input.videoId)return {result:false,changes:null};
   delete active[key];return {result:true,changes:{active}};
  });
 }
 async admissionCapacity({intents,financial}){
  const state=validate((await this.store.get(path))?.data);
  if(!state.enabled)return 0;
  const busy=new Set(Object.values(state.active).map(x=>x.video_id));
  for(const id of Object.keys(intents)){
   if(busy.has(id))continue;
   const execution=executionId(id,'upload'),claim=await this.store.get(`jobs/${execution}`);
   // Definite pre-payment blocks did not invoke an extractor. Ambiguous writes,
   // legacy claims and settled money alone cannot establish that work ended.
   const unpaidBlock=claim?.data.status==='blocked'&&!claim.data.execution_attempt_id&&!Object.values(financial.jobs??{}).some(x=>x.video_id===id&&['reserved','started','uncertain','completed'].includes(x.status));
   if(!unpaidBlock&&!await this.ended(execution,id))busy.add(id);
  }
  return Math.max(0,Math.min(state.parallelism,this.maximumParallelism)-busy.size);
 }
}
