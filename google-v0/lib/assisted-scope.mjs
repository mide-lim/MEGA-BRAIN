import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const scopes=new WeakSet();
const execution=video=>'job_'+createHash('sha256').update(`${video}:upload:v0`).digest('hex');
const approvalFields=['schema_version','kind','request_id','authorization_ref','authorized_at','expires_at','maximum_cents','task','consumed_at'];
// Minted only from a confirmed consumed private approval; never deserialized
// from HTTP, a task flag, the ledger, or a caller-provided scope-shaped object.
export async function createAssistedScope({store,path,receipt,now=Date.now()}){
 const current=await store.get(path),a=current?.data;
 if(!a||current.updateTime!==receipt?.updateTime||!isDeepStrictEqual(a,receipt.data)||a.status!=='consumed'||a.schema_version!==1||a.kind!=='assisted_upload'||!/^[A-Za-z0-9_-]{16,64}$/.test(a.request_id??'')||path!==`jobs/assisted_upload_${a.request_id}`||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(a.authorization_ref??'')||Object.keys(a.task??{}).sort().join(',')!=='poll,stage,videoId'||a.task.stage!=='upload'||a.task.poll!==0||!/^[A-Za-z0-9_-]{5,32}$/.test(a.task.videoId??'')||!Number.isSafeInteger(a.maximum_cents)||a.maximum_cents<1||a.maximum_cents>100||a.outcome!==undefined)throw Error('Escopo assistido sem autorização consumida.');
 const start=Date.parse(a.authorized_at),end=Date.parse(a.expires_at),consumed=Date.parse(a.consumed_at);
 if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(consumed)||start>consumed||consumed>now||end<=now||end<=start||end-start>3600000)throw Error('Escopo assistido expirado.');
 const fields=Object.fromEntries(approvalFields.map(k=>[k,structuredClone(a[k])]));Object.freeze(fields.task);Object.freeze(fields);
 const scope=Object.freeze({reference:path,videoId:a.task.videoId,executionId:execution(a.task.videoId),maximumCents:a.maximum_cents,fields});scopes.add(scope);return scope;
}
export function assertAssistedScope(scope,{videoId=scope?.videoId,stage=scope?.stage??'upload',executionId=scope?.executionId,maximumCents=scope?.maximumCents}={}){
 if(!scope||!scopes.has(scope)||videoId!==scope.videoId||stage!==(scope.stage??'upload')||executionId!==scope.executionId||maximumCents!==scope.maximumCents)throw Error('Escopo assistido inválido.');
 return scope;
}
// Admission expiry is checked at minting. In-flight completion may outlive it;
// only the same consumed immutable approval and started ledger entry can finish.
export async function verifyAssistedScope(store,scope){
 assertAssistedScope(scope);if(scope.pipeline){const a=(await store.get(scope.reference))?.data;if(a?.status!=='consumed'||!isDeepStrictEqual(pipelineFields(a),scope.fields))throw Error('Autorização unitária alterada.');return;}const a=(await store.get(scope.reference))?.data;
 if(a?.status!=='consumed'||!isDeepStrictEqual(Object.fromEntries(approvalFields.map(k=>[k,a[k]])),scope.fields))throw Error('Autorização assistida alterada.');
}
export function assertAssistedJob(scope,id,job){
 assertAssistedScope(scope,{executionId:id,videoId:job?.video_id,stage:job?.stage,maximumCents:job?.maximum_cents});
 if(scope.pipeline){assertPipelineHistory(scope,{jobs:{[id]:job}},{checkPredecessors:false});return;}
 if(!job||job.video_id!==scope.videoId||job.stage!=='upload'||job.maximum_cents!==scope.maximumCents||job.assisted_scope_ref!==scope.reference||job.batch_id!==undefined)throw Error('Reserva fora do escopo assistido.');
}

const pipelineStages=['upload','transcription','analysis'];
export const pipelineExecution=(video,stage,revision)=>'job_'+createHash('sha256').update(video+':'+stage+':'+(stage==='analysis'?revision:'v0')).digest('hex');
const pipelineFields=a=>Object.fromEntries([...approvalFields,'stage_maximum_cents','analysis_revision'].map(k=>[k,structuredClone(a[k])]));
export function validatePipelineApproval(a,{path,videoId,quotes,analysisRevision,now=Date.now(),allowExpired=false}){
 if(!a||a.schema_version!==1||a.kind!=='assisted_pipeline'||!/^[A-Za-z0-9_-]{16,64}$/.test(a.request_id??'')||path!==`jobs/assisted_upload_${a.request_id}`||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(a.authorization_ref??'')||!isDeepStrictEqual(a.task,{videoId,stage:'upload',poll:0})||!/^[A-Za-z0-9_-]{5,32}$/.test(videoId??'')||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision)||a.analysis_revision!==analysisRevision||!isDeepStrictEqual(a.stage_maximum_cents,quotes)||Object.keys(quotes??{}).sort().join(',')!=='analysis,transcription,upload'||pipelineStages.some(s=>!Number.isSafeInteger(quotes[s])||quotes[s]<1)||quotes.upload>100||!Number.isSafeInteger(a.maximum_cents)||a.maximum_cents!==pipelineStages.reduce((n,s)=>n+quotes[s],0)||a.maximum_cents>2000||a.outcome!==undefined)throw Error('Autorização das três etapas inválida.');
 const start=Date.parse(a.authorized_at),end=Date.parse(a.expires_at);
 if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=start||end-start>3600000||!allowExpired&&end<=now)throw Error('Autorização das três etapas expirada.');
}
export async function createPipelineScope({store,path,receipt,videoId,stage,quotes,analysisRevision,now=Date.now(),allowExpired=false}){
 if(!pipelineStages.includes(stage))throw Error('Etapa unitária inválida.');
 const current=await store.get(path),a=current?.data;
 validatePipelineApproval(a,{path,videoId,quotes,analysisRevision,now,allowExpired});
 const consumed=Date.parse(a.consumed_at);
 if(a.status!=='consumed'||!receipt?.updateTime||current.updateTime!==receipt.updateTime||!isDeepStrictEqual(a,receipt.data)||!Number.isFinite(consumed)||consumed<Date.parse(a.authorized_at)||consumed>now||consumed>=Date.parse(a.expires_at))throw Error('Consumo unitário não confirmado.');
 const fields=pipelineFields(a);Object.freeze(fields.task);Object.freeze(fields.stage_maximum_cents);Object.freeze(fields);
 const ids=Object.freeze(Object.fromEntries(pipelineStages.map(s=>[s,pipelineExecution(videoId,s,analysisRevision)])));
 const scope=Object.freeze({pipeline:true,reference:path,videoId,stage,executionId:ids[stage],executionIds:ids,maximumCents:quotes[stage],totalMaximumCents:a.maximum_cents,analysisRevision,fields});scopes.add(scope);return scope;
}
export function assertPipelineHistory(scope,state,{checkPredecessors=true}={}){
 assertAssistedScope(scope);if(!scope.pipeline)throw Error('Escopo de pipeline obrigatório.');
 let total=0;
 for(const [id,j] of Object.entries(state.jobs??{})){
  if(j?.video_id!==scope.videoId)continue;
  if(!pipelineStages.includes(j.stage)||id!==scope.executionIds[j.stage]||j.assisted_scope_ref!==scope.reference||j.assisted_scope_kind!=='pipeline_v1'||j.assisted_scope_total_cents!==scope.totalMaximumCents||j.maximum_cents!==scope.fields.stage_maximum_cents[j.stage]||j.batch_id!==undefined||j.recovery_of!==undefined||(j.stage==='analysis'?j.analysis_revision!==scope.analysisRevision:j.analysis_revision!==undefined))throw Error('Histórico unitário conflitante.');
  total+=j.maximum_cents;
 }
 if(total>scope.totalMaximumCents)throw Error('Teto total unitário excedido.');
 if(checkPredecessors)for(const s of pipelineStages.slice(0,pipelineStages.indexOf(scope.stage))){if(state.jobs?.[scope.executionIds[s]]?.status!=='completed')throw Error('Etapa anterior não concluída.');}
}
export function assertAssistedObject(scope,key){
 assertAssistedScope(scope);
 const video=scope.videoId,original=`originals/instagram/${video}/video.mp4`;
 const allowed=!scope.pipeline?[original]:scope.stage==='upload'?[original,`results/instagram/${video}/${scope.executionIds.transcription}/audio.flac`]:scope.stage==='transcription'?[`results/instagram/${video}/${scope.executionIds.transcription}/audio.flac`,`results/instagram/${video}/${scope.executionId}/transcription.json`]:[`results/instagram/${video}/${scope.executionId}/analysis.json`,`results/instagram/${video}/${scope.executionId}/caption.json`];
 if(!allowed.includes(key))throw Error('Objeto fora da etapa unitária.');
}
