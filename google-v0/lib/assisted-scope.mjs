import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {settledRetryId,settledRetryKind} from './smart-retry.mjs';
import {terminalSourceFailure} from './source-hold.mjs';

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
 assertAssistedScope(scope);if(scope.pipeline){const a=(await store.get(scope.reference))?.data;if(a?.status!=='consumed'||!isDeepStrictEqual(pipelineFields(a),scope.fields))throw Error('Autorização unitária alterada.');if(scope.recovery){const parent=await store.get('jobs/'+scope.recoveryParent.execution_id),f=(await store.get('settings/financial'))?.data;if(recoverySnapshotDigest(parent?.data)!==scope.recoveryParent.claim_digest||recoverySnapshotDigest(f?.jobs?.[scope.recoveryParent.execution_id])!==scope.recoveryParent.financial_digest)throw Error('Histórico de origem alterado.');}return;}const a=(await store.get(scope.reference))?.data;
 if(a?.status!=='consumed'||!isDeepStrictEqual(Object.fromEntries(approvalFields.map(k=>[k,a[k]])),scope.fields))throw Error('Autorização assistida alterada.');
}
export function assertAssistedJob(scope,id,job){
 assertAssistedScope(scope,{executionId:id,videoId:job?.video_id,stage:job?.stage,maximumCents:job?.maximum_cents});
 if(scope.pipeline){assertPipelineHistory(scope,{jobs:{[id]:job}},{checkPredecessors:false});return;}
 if(!job||job.video_id!==scope.videoId||job.stage!=='upload'||job.maximum_cents!==scope.maximumCents||job.assisted_scope_ref!==scope.reference||job.batch_id!==undefined)throw Error('Reserva fora do escopo assistido.');
}

const pipelineStages=['upload','transcription','analysis'];
export const pipelineExecution=(video,stage,revision)=>'job_'+createHash('sha256').update(video+':'+stage+':'+(stage==='analysis'?revision:'v0')).digest('hex');
const pipelineFields=a=>Object.fromEntries([...approvalFields,'stage_maximum_cents','analysis_revision',...(a.kind==='assisted_pipeline_recovery'?['recovery_parent']:[])].map(k=>[k,structuredClone(a[k])]));
export function validatePipelineApproval(a,{path,videoId,quotes,analysisRevision,now=Date.now(),allowExpired=false,batch=false,recovery=false}){
 if(typeof batch!=='boolean')throw Error('Modo de lote privado inválido.');
 if(!a||a.schema_version!==1||a.kind!==(recovery?'assisted_pipeline_recovery':'assisted_pipeline')||!/^[A-Za-z0-9_-]{16,64}$/.test(a.request_id??'')||path!==`jobs/assisted_upload_${a.request_id}`||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(a.authorization_ref??'')||!isDeepStrictEqual(a.task,{videoId,stage:'upload',poll:0})||!/^[A-Za-z0-9_-]{5,32}$/.test(videoId??'')||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision)||a.analysis_revision!==analysisRevision||!isDeepStrictEqual(a.stage_maximum_cents,quotes)||Object.keys(quotes??{}).sort().join(',')!=='analysis,transcription,upload'||pipelineStages.some(s=>!Number.isSafeInteger(quotes[s])||quotes[s]<1)||quotes.upload>100||!Number.isSafeInteger(a.maximum_cents)||a.maximum_cents!==pipelineStages.reduce((n,s)=>n+quotes[s],0)||a.maximum_cents>2000||a.outcome!==undefined)throw Error('Autorização das três etapas inválida.');
 if(recovery&&(Object.keys(a.recovery_parent??{}).sort().join(',')!=='claim_digest,execution_id,financial_digest'||a.recovery_parent.execution_id!==pipelineExecution(videoId,'upload')||!['claim_digest','financial_digest'].every(k=>/^[a-f0-9]{64}$/.test(a.recovery_parent[k]??''))))throw Error('Snapshot de origem inválido.');
 const start=Date.parse(a.authorized_at),end=Date.parse(a.expires_at);
 if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=start||end-start>(batch?172800000:3600000)||!allowExpired&&end<=now)throw Error('Autorização das três etapas expirada.');
}
export async function createPipelineScope({store,path,receipt,videoId,stage,quotes,analysisRevision,now=Date.now(),allowExpired=false,batch=false,recovery=false,verifyExecutionStopped}){
 if(!pipelineStages.includes(stage))throw Error('Etapa unitária inválida.');
 const current=await store.get(path),a=current?.data;
 validatePipelineApproval(a,{path,videoId,quotes,analysisRevision,now,allowExpired,batch,recovery});
 if(recovery)await verifyPipelineRecovery({store,approval:a,videoId,verifyExecutionStopped});
 const consumed=Date.parse(a.consumed_at);
 if(a.status!=='consumed'||!receipt?.updateTime||current.updateTime!==receipt.updateTime||!isDeepStrictEqual(a,receipt.data)||!Number.isFinite(consumed)||consumed<Date.parse(a.authorized_at)||consumed>now||consumed>=Date.parse(a.expires_at))throw Error('Consumo unitário não confirmado.');
 const fields=pipelineFields(a);Object.freeze(fields.task);Object.freeze(fields.stage_maximum_cents);if(recovery)Object.freeze(fields.recovery_parent);Object.freeze(fields);
 const ids=Object.freeze(Object.fromEntries(pipelineStages.map(s=>[s,recovery&&s==='upload'?settledRetryId(pipelineExecution(videoId,s,analysisRevision)):pipelineExecution(videoId,s,analysisRevision)])));
 const scope=Object.freeze({pipeline:true,...(batch?{batch:true}:{}),...(recovery?{recovery:true,recoveryParent:fields.recovery_parent}:{}),reference:path,videoId,stage,executionId:ids[stage],executionIds:ids,maximumCents:quotes[stage],totalMaximumCents:a.maximum_cents,analysisRevision,fields});scopes.add(scope);return scope;
}
export function assertPipelineHistory(scope,state,{checkPredecessors=true}={}){
 assertAssistedScope(scope);if(!scope.pipeline)throw Error('Escopo de pipeline obrigatório.');
 let total=0;
 for(const [id,j] of Object.entries(state.jobs??{})){
  if(j?.video_id!==scope.videoId)continue;
  if(scope.recovery&&id===scope.recoveryParent.execution_id){if(j.stage!=='upload'||recoverySnapshotDigest(j)!==scope.recoveryParent.financial_digest)throw Error('Reserva de origem alterada.');continue;}
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

// Snapshots bind the immutable original claim and ledger entry, without resetting
// either. Sorting makes operator-produced approvals independent of object order.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const recoverySnapshotDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value??null))).digest('hex');
export async function verifyPipelineRecovery({store,approval:a,videoId,verifyExecutionStopped}){
 const p=a.recovery_parent,id=p?.execution_id,claim=await store.get('jobs/'+id),financial=(await store.get('settings/financial'))?.data,f=financial?.jobs?.[id],video=(await store.get('videos/'+videoId))?.data,c=claim?.data;
 if(id!==pipelineExecution(videoId,'upload')||!c||!f||!video||recoverySnapshotDigest(c)!==p.claim_digest||recoverySnapshotDigest(f)!==p.financial_digest||c.video_id!==videoId||f.video_id!==videoId||c.stage!=='upload'||f.stage!=='upload'||c.status!=='uncertain'||c.recovery_of||f.recovery_of||c.operation_name||c.analysis_attempts?.length)throw Error('Origem sem snapshot recuperável.');
 // Artifact absence is enforced before consumption; later stages own new media.
 const legacy=settledRetryKind({claim:c,financial:f,video:{},videoId,stage:'upload'})==='source_acquisition';
 if(!legacy){
  if(f.status!=='uncertain'||typeof c.assisted_scope_ref!=='string'||f.assisted_scope_ref!==c.assisted_scope_ref||!terminalSourceFailure(c.failure_diagnostic))throw Error('Origem não admite nova aquisição privada.');
  const proof=await verifyExecutionStopped?.({executionId:id,videoId,stage:'upload',claimUpdateTime:claim.updateTime});
  if(proof?.ended!==true||proof.execution_id!==id||proof.claim_update_time!==claim.updateTime)throw Error('Encerramento anterior não confirmado.');
 }
 return true;
}
