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
export function assertAssistedScope(scope,{videoId=scope?.videoId,stage='upload',executionId=scope?.executionId,maximumCents=scope?.maximumCents}={}){
 if(!scope||!scopes.has(scope)||videoId!==scope.videoId||stage!=='upload'||executionId!==scope.executionId||maximumCents!==scope.maximumCents)throw Error('Escopo assistido inválido.');
 return scope;
}
// Admission expiry is checked at minting. In-flight completion may outlive it;
// only the same consumed immutable approval and started ledger entry can finish.
export async function verifyAssistedScope(store,scope){
 assertAssistedScope(scope);const a=(await store.get(scope.reference))?.data;
 if(a?.status!=='consumed'||!isDeepStrictEqual(Object.fromEntries(approvalFields.map(k=>[k,a[k]])),scope.fields))throw Error('Autorização assistida alterada.');
}
export function assertAssistedJob(scope,id,job){
 assertAssistedScope(scope,{executionId:id,videoId:job?.video_id,stage:job?.stage,maximumCents:job?.maximum_cents});
 if(!job||job.video_id!==scope.videoId||job.stage!=='upload'||job.maximum_cents!==scope.maximumCents||job.assisted_scope_ref!==scope.reference||job.batch_id!==undefined)throw Error('Reserva fora do escopo assistido.');
}
