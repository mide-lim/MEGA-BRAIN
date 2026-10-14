import {createHash} from 'node:crypto';
const sorted=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(sorted):Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
const canonical=value=>JSON.stringify(sorted(value));
export const failureDigest=diagnostic=>createHash('sha256').update(canonical(diagnostic)).digest('hex');
export const recoveryAuthorizationPath=id=>`jobs/firestore_recovery_${id}`;
export const uploadRecoveryId=id=>'job_'+createHash('sha256').update(`${id}:firestore-upload-recovery-v1`).digest('hex');
export const settledMetadataUpload=job=>job?.stage==='upload'&&job.status==='completed'&&job.maximum_cents>0&&job.actual_cents===job.maximum_cents&&job.manual_reconciliation==='confirmed_firestore_metadata_rejection_full_estimate_accounted_upload_pending'&&!job.recovery_of;
// Authorization is a separately persisted operator verdict about the service,
// not an inference from a generic429 or a field supplied by the task payload.
export function metadataRecoveryAllowed({authorization:a,claim:c,financial:f,video:v,originalId,videoId,stage,maximumCents,recoveryId,now=Date.now()}){
 if(!['upload','transcription'].includes(stage)||!a||!c||!f||!v)return false;
 const observed=Date.parse(a.authorized_at),expires=Date.parse(a.expires_at);
 if(a.schema_version!==1||a.status!=='authorized'||a.verified_service!=='firestore.googleapis.com'||a.kind!=='confirmed_firestore_metadata_rejection'||a.original_execution_id!==originalId||a.video_id!==videoId||a.stage!==stage||a.maximum_cents!==maximumCents||a.recovery_id!==recoveryId||!/^[A-Za-z0-9_-]{16,64}$/.test(recoveryId??'')||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(a.authorization_ref??'')||!Number.isFinite(observed)||observed>now||!Number.isFinite(expires)||expires<=now||expires-observed>86400000)return false;
 const d=c.failure_diagnostic;
 if(!d||JSON.stringify(d).length>8000||d.http_status!==429||d.provider?.status!=='RESOURCE_EXHAUSTED'||d.operation_step!==(stage==='upload'?'persist_download':'adapter_or_reservation')||a.failure_digest!==failureDigest(d)||c.video_id!==videoId||c.stage!==stage||c.firestore_recovery_count||c.operation_name||c.analysis_attempts?.length||f.video_id!==videoId||f.stage!==stage||f.maximum_cents!==maximumCents||f.recovery_of||v.transcript_key||v.transcript_generation||v.transcript_status||v.transcript?.trim()||v.analysis||v.analysis_key||v.candidate_analysis_key)return false;
 if(stage==='transcription')return a.evidence==='provider_not_submitted'&&c.status==='blocked'&&f.status==='reserved'&&f.operation_name===undefined&&f.actual_cents===undefined&&v.media_verified===true&&v.audio_status==='present'&&v.video_key===`originals/instagram/${videoId}/video.mp4`&&/^\d+$/.test(v.video_generation??'');
 return a.evidence==='media_absence_verified'&&c.status==='uncertain'&&settledMetadataUpload(f)&&!v.media_verified&&!v.video_key&&!v.video_generation;
}
