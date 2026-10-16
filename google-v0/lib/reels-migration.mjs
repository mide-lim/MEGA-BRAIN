import {createHash} from 'node:crypto';
import {reelIdPattern,publicationAvailable} from './reels-model.mjs';
const clone=v=>structuredClone(v);
function canonical(v){if(v===undefined)throw Error('Valor indefinido no inventário.');if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
export const migrationHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const active=new Set(['claimed','reserved','started','waiting','polling','running','queued','submitting','collecting','applying','uncertain','reconciling_result','reconciliation_failed','recovering_upload','recovering_429','recovering_firestore_metadata']);
const artifactFields=['video','audio','transcript','analysis','candidate_analysis'];
// A saved candidate is not a terminal decision. Bind an explicit decision to the
// exact candidate, including an inline result and its review metadata.
export function migrationCandidateHash(v){return migrationHash({key:v.candidate_analysis_key??null,generation:v.candidate_analysis_generation??null,analysis:v.analysis_candidate??null,review:v.reels_v2?.candidate??null});}
function candidatePending(v){
 if(!(v.candidate_analysis_key||v.analysis_candidate||v.reels_v2?.candidate))return false;
 const d=v.candidate_terminal_decision;
 const exact=d?.terminal_confirmed===true&&['accepted','rejected','superseded'].includes(d.state)&&/^[a-f0-9]{64}$/.test(d.evidence_hash??'')&&d.candidate_hash===migrationCandidateHash(v);
 if(!exact)return true;
 if(d.state==='rejected')return false;
 // Acceptance is not publication. Only the same generation actually published
 // can cease being pending; a superseded/unpublished result remains protected.
 return !(d.state==='accepted'&&publicationAvailable(v)&&v.candidate_analysis_key===v.analysis_key&&v.candidate_analysis_generation===v.analysis_generation);
}
function artifacts(v){return artifactFields.filter(k=>v[k+'_key']).map(kind=>({kind,key:v[kind+'_key'],bucket:v[kind+'_bucket']??v.storage_bucket??null,generation:v[kind+'_generation']??null,sha256:v[kind+'_sha256']??null}));}
function artifactProofs(v,inventory){return artifacts(v).map(a=>({...a,proofs:inventory.filter(x=>x.key===a.key&&String(x.generation)===String(a.generation)&&(!a.bucket||x.bucket===a.bucket)).map(x=>({bucket:x.bucket??null,key:x.key,generation:String(x.generation),size:x.size??x.bytes??null,sha256:x.sha256??null,sourceVerified:x.sourceVerified===true})).sort((a,b)=>canonical(a).localeCompare(canonical(b)))}));}
function validArtifacts(v,inventory){return artifactProofs(v,inventory).every(a=>/^\d+$/.test(String(a.generation??''))&&a.proofs.length&&a.proofs.every(x=>typeof x.bucket==='string'&&x.bucket.length>0&&Number.isSafeInteger(x.size)&&x.size>=0&&x.sourceVerified&&/^[a-f0-9]{64}$/.test(x.sha256??'')&&(!a.sha256||a.sha256===x.sha256))&&new Set(a.proofs.map(x=>canonical([x.bucket,x.size,x.sha256]))).size===1);}
export function buildMigrationManifest({videos,executionEvidence=[],ledgerEvidence=[],artifactInventory=[],evidenceComplete=false,source,sourceRevision}){
 if(!source||!sourceRevision||!Array.isArray(videos))throw Error('Origem e revisão obrigatórias.');
 const ids=new Set(),entries=[];
 for(const original of videos){const v=clone(original);if(!reelIdPattern.test(v.id??'')||ids.has(v.id))throw Error('Identidade inválida/duplicada.');ids.add(v.id);
  const stable=(a,b)=>canonical(a).localeCompare(canonical(b));const jobs=executionEvidence.filter(x=>(x.video_id??x.reelId)===v.id).sort(stable),ledger=ledgerEvidence.filter(x=>(x.video_id??x.reelId)===v.id).sort(stable),proof=[...jobs,...ledger];
  const unpublishedSavedResult=!publicationAvailable(v)&&!!(v.analysis_key||v.analysis);
  const unresolved=active.has(v.status)||active.has(v.reels_v2?.status)||v.uncertain===true||v.error?.uncertain===true||v.reels_v2?.error?.uncertain===true||v.reels_v2?.uncertain===true||v.paid_result_uncertain===true||candidatePending(v)||unpublishedSavedResult||proof.some(x=>active.has(x.status)||x.uncertain===true||x.error?.uncertain===true||x.paid_result_uncertain===true||(x.operation_name||x.operationName)&&x.external_terminal_confirmed!==true);
  let disposition='retain_reconciliation',reason='insufficient_evidence';
  if(unresolved)reason='active_or_uncertain';
  else if(publicationAvailable(v)){if(validArtifacts(v,artifactInventory)){disposition='preserve_success';reason='published_artifacts_verified';}else reason='artifact_provenance_unverified';}
  else if(evidenceComplete&&v.failure_confirmed===true&&['failed','needs_attention'].includes(v.status)&&proof.length&&proof.every(x=>x.terminal_confirmed===true&&['failed','completed','cancelled','not_started'].includes(x.status)&&x.paid_result_uncertain!==true)&&validArtifacts(v,artifactInventory)){disposition='reset_confirmed_error';reason='terminal_failure_verified';}
  entries.push({id:v.id,disposition,reason,sourceHash:migrationHash(v),artifacts:artifactProofs(v,artifactInventory),evidenceHash:migrationHash({jobs,ledger}),target:disposition==='reset_confirmed_error'?{id:v.id,source_url:v.source_url??v.sourceUrl??null,status:'registered',stage:null,created_at:v.created_at??null,updated_at:v.updated_at??null,media_verified:false,video_key:null,video_generation:null,source_caption:null,transcript:null,analysis:null,error:null}:v});
 }
 entries.sort((a,b)=>a.id.localeCompare(b.id));const body={schemaVersion:1,source,sourceRevision,evidenceComplete,entries};return {...body,hash:migrationHash(body)};
}
export function verifyManifest(manifest,videos){const {hash,...body}=manifest;if(hash!==migrationHash(body))throw Error('Manifesto alterado.');const map=new Map(videos.map(v=>[v.id,v]));if(map.size!==videos.length||map.size!==manifest.entries.length)throw Error('Inventário divergente.');for(const e of manifest.entries)if(!map.has(e.id)||migrationHash(map.get(e.id))!==e.sourceHash)throw Error('Origem alterada.');return true;}
export function createMigrationBackup({videos,source,sourceRevision}){const body={schemaVersion:1,source,sourceRevision,videos:clone(videos)};return {...body,hash:migrationHash(body)};}
export function restoreMigrationBackup(backup){const {hash,...body}=backup;if(hash!==migrationHash(body))throw Error('Backup corrompido.');return clone(body.videos);}
// Pure-copy rehearsal. No store/provider/runtime adapter is accepted here.
export function rehearseMigration(input){const sourceBefore=migrationHash(input.videos),manifest=buildMigrationManifest(input);verifyManifest(manifest,input.videos);const backup=createMigrationBackup(input),restored=restoreMigrationBackup(backup);if(migrationHash(restored)!==sourceBefore)throw Error('Restauração divergente.');const copy=manifest.entries.map(e=>clone(e.target));if(migrationHash(input.videos)!==sourceBefore)throw Error('Origem alterada.');return {manifest,backup,copy,proof:{sourceUnchanged:true,restorationVerified:true,repeatable:buildMigrationManifest(input).hash===manifest.hash,counts:Object.fromEntries(['preserve_success','reset_confirmed_error','retain_reconciliation'].map(d=>[d,manifest.entries.filter(e=>e.disposition===d).length]))}};}
export function planWriterCutover({activeWriters,sourceWriter,targetWriter,manifestHash,backupVerified}){if(!Array.isArray(activeWriters)||activeWriters.length!==1||activeWriters[0]!==sourceWriter||!targetWriter||sourceWriter===targetWriter||!backupVerified||!/^[a-f0-9]{64}$/.test(manifestHash??''))throw Error('Corte exige um escritor, manifesto e restauração verificados.');return {phase:'planned',from:sourceWriter,to:targetWriter,manifestHash,sequence:['freeze_source','verify_no_inflight_writes','activate_target'],requiresExclusiveLease:true,executed:false};}
// A rollback is a merge into a copy. Post-cutover writes always win, including new IDs.
export function planMigrationRollback({backup,migratedAtCutover,currentTarget}){const originals=restoreMigrationBackup(backup),cut=new Map(migratedAtCutover.map(v=>[v.id,v])),current=new Map(currentTarget.map(v=>[v.id,v])),result=new Map(originals.map(v=>[v.id,v])),preserved=[];for(const id of cut.keys())if(!current.has(id)){result.delete(id);preserved.push(id);}for(const [id,v]of current){if(!cut.has(id)||migrationHash(v)!==migrationHash(cut.get(id))){result.set(id,clone(v));preserved.push(id);}}return {records:[...result.values()].sort((a,b)=>a.id.localeCompare(b.id)),preservedPostCutoverIds:preserved.sort(),requiresExclusiveLease:true,executed:false};}
