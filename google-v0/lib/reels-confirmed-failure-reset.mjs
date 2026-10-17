import {createHash} from 'node:crypto';
import {canonical} from './reels-runtime.mjs';

export const confirmedFailureResetRule='confirmed-legacy-failure-reset-v1';
const sha=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const need=(v,message)=>{if(!v)throw Error(message);};
const idPattern=/^[A-Za-z0-9_-]{5,32}$/;
const version=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const array=v=>Array.isArray(v)?v:[];
export const resetClassifications=Object.freeze(['no_audio_no_stt_call','stt_terminal_no_speech','download_terminal_failure','instagram_access_denied','non_video_terminal']);
const sourceStatuses={no_audio_no_stt_call:['needs_attention'],stt_terminal_no_speech:['no_speech'],download_terminal_failure:['needs_attention'],instagram_access_denied:['needs_attention'],non_video_terminal:['skipped']};
const relatedCollections=Object.freeze(['jobs','reels_executions','execution_stops','analyses','reels_reconciliations','reels_events','reels_command_items','reels_commands','reels_historical_activity']);
const deletableCollections=new Set(['reels_legacy_content','reels_events','reels_command_items','reels_historical_activity']);
export const resetSnapshotFields=Object.freeze({
 videos:['id','status','stage','import_hold','reels_v2','failure_confirmed','uncertain','paid_result_uncertain','error.uncertain','error.code','analysis_key','analysis_generation','analysis_quality_status','analysis.summary','analysis.categories','analysis_candidate','candidate_analysis_key','publication.available','operational_reset'],
 reels_legacy_content:['schemaVersion','reelId','status','originalStatus','historical','executable','provenance.recordHash','provenance.sourceSnapshotHash','analysis.summary'],
 jobs:['video_id','reelId','payload.videoId','status','paid_result_uncertain','operation_name','operationName'],
 reels_executions:['reelId','status','operationName','error.uncertain'],execution_stops:['video_id','reelId','stage','ended'],analyses:['video_id','reelId','status'],
 reels_reconciliations:['reelId','status'],reels_events:['reelId','type'],reels_command_items:['reelId','status'],reels_commands:['selected','accepted','status'],reels_historical_activity:['reelId','historical','executable','sourceStatus'],
 settings:['claims','jobs','control_fragments'],control_chunks:['owner','entries']
});
// A sanitation boundary for inspection exports. No diagnostic text, transcript,
// analysis body, token or before-image is copied into the evidence/manifest.
export function resetMetadataRecord(record){
 const d=record.data??{},collection=record.path.split('/')[0],data={};
 if(collection==='videos'){
  Object.assign(data,{id:d.id??record.path.split('/')[1],status:d.status??null,importHeld:d.import_hold?.active===true,legacyImportPlaceholder:d.status==='uncertain'&&d.import_hold?.active===true&&d.import_hold?.reason==='migration_not_activated'&&d.error?.code==='LEGACY_RECONCILIATION_REQUIRED'&&!d.reels_v2,uncertain:d.uncertain===true,paidUncertain:d.paid_result_uncertain===true,operationalStatus:d.reels_v2?.status??null,errorUncertain:d.error?.uncertain===true||d.reels_v2?.error?.uncertain===true,publicationProtected:!!(d.publication?.available||d.analysis_key||d.analysis_generation||d.analysis||d.analysis_candidate||d.candidate_analysis_key||d.reels_v2?.candidate),resetRule:d.operational_reset?.rule??null,resetPlan:d.operational_reset?.planSHA256??null});
 }else if(collection==='reels_legacy_content'){
  Object.assign(data,{reelId:d.reelId??null,publicationProtected:d.originalStatus==='analyzed'||!!d.analysis?.summary,originalStatus:d.originalStatus??null,provenanceRecordSHA256:d.provenance?.recordHash??null,provenanceSnapshotSHA256:d.provenance?.sourceSnapshotHash??null});
 }else if(collection==='settings'||collection==='control_chunks'){
  const rows=collection==='control_chunks'?Object.values(d.entries??{}):[...Object.values(d.claims??{}),...Object.values(d.jobs??{})];
  data.protectedReelIds=[...new Set(rows.map(x=>x?.video_id??x?.reelId??x?.videoId).filter(x=>idPattern.test(x??'')))].sort();
 }else if(collection==='reels_commands'){data.reelIds=[...new Set([...array(d.selected),...array(d.accepted)])].filter(x=>idPattern.test(x??'')).sort();data.status=d.status??null;
 }else{
  Object.assign(data,{reelId:d.reelId??d.video_id??d.payload?.videoId??null,status:d.status??null,historical:d.historical===true,executable:d.executable===true});
 }
 return {path:record.path,updateTime:record.updateTime,data};
}
const byId=(record,id)=>record.data?.reelId===id||array(record.data?.reelIds).includes(id)||record.path==='videos/'+id||record.path==='reels_legacy_content/'+id;
function cleanReset(id,records,planSHA256){const video=records.find(r=>r.path==='videos/'+id)?.data;return !!video&&video.status==='registered'&&video.resetRule===confirmedFailureResetRule&&video.resetPlan===planSHA256&&!video.publicationProtected&&!video.uncertain&&!video.errorUncertain&&!video.paidUncertain&&!video.importHeld&&!video.operationalStatus&&!protectedIds(records).has(id)&&!records.some(r=>relatedCollections.includes(r.path.split('/')[0])&&byId(r,id))&&!records.some(r=>r.path==='reels_legacy_content/'+id);}
function validateRecord(r){need(typeof r?.path==='string'&&/^[a-z_]+\/[A-Za-z0-9_-]{1,128}$/.test(r.path)&&version(r.updateTime),'Versioned metadata record required.');}
function protectedIds(records){return new Set(records.filter(r=>['settings','control_chunks'].includes(r.path.split('/')[0])).flatMap(r=>array(r.data.protectedReelIds)));}
function assessment(id,records){
 const video=records.find(r=>r.path==='videos/'+id),legacy=records.find(r=>r.path==='reels_legacy_content/'+id),related=records.filter(r=>relatedCollections.includes(r.path.split('/')[0])&&byId(r,id));
 if(!video)return {reason:'not_found'};
 if(video.data.publicationProtected||legacy?.data.publicationProtected)return {reason:'published_or_saved_result_protected'};
 if(protectedIds(records).has(id))return {reason:'claim_or_financial_operation_protected'};
 if(related.some(r=>['jobs','reels_executions','execution_stops','analyses','reels_reconciliations','reels_commands'].includes(r.path.split('/')[0])))return {reason:'execution_or_result_requires_reconciliation'};
 if(['queued','running','started','waiting','submitting','collecting','applying'].includes(video.data.operationalStatus??video.data.status))return {reason:'active_or_queued'};
 if((video.data.uncertain||video.data.errorUncertain)&&!video.data.legacyImportPlaceholder)return {reason:'explicit_uncertainty_requires_reconciliation'};
 if(video.data.paidUncertain)return {reason:'paid_result_uncertain'};
 if(!['uncertain','needs_attention','no_speech','skipped','failed'].includes(video.data.status))return {reason:'not_old_unpublished_failure'};
 const deletions=[...(legacy?[legacy]:[]),...related];
 if(deletions.some(r=>!deletableCollections.has(r.path.split('/')[0])||r.path.startsWith('reels_command_items/')&&r.data.status&&!['completed','failed','cancelled'].includes(r.data.status)))return {reason:'nonterminal_related_operation'};
 return {video,deletions};
}
export function prepareConfirmedFailureReset(input){
 need(input?.schemaVersion===1&&input.observationComplete===true&&Array.isArray(input.records)&&Array.isArray(input.attestations),'Complete metadata inspection and explicit attestations required.');
 need(digest(input.source?.legacySnapshotSHA256)&&digest(input.source?.auditSHA256),'Reviewed source provenance required.');
 input.records.forEach(validateRecord);need(new Set(input.records.map(r=>r.path)).size===input.records.length,'Duplicate record path.');
 const rows=[],excluded=[],ids=new Set();
 for(const attestation of input.attestations){
  const {id,classification,sourceStatus,sourceRecordSHA256,diagnosticSHA256}=attestation;
  need(idPattern.test(id??'')&&!ids.has(id),'Invalid or duplicate identity.');ids.add(id);
  need(resetClassifications.includes(classification)&&sourceStatuses[classification].includes(sourceStatus)&&digest(sourceRecordSHA256)&&digest(diagnosticSHA256),'Positive normalized terminal source evidence required.');
  const a=assessment(id,input.records);if(a.reason){excluded.push({id,reason:a.reason});continue;}
  const legacy=input.records.find(r=>r.path==='reels_legacy_content/'+id);
  if(legacy){need(legacy.data.originalStatus===sourceStatus&&legacy.data.provenanceRecordSHA256===sourceRecordSHA256&&digest(input.source.legacySnapshotCanonicalSHA256)&&legacy.data.provenanceSnapshotSHA256===input.source.legacySnapshotCanonicalSHA256,'Legacy provenance differs from normalized attestation.');}
  const deletions=a.deletions.map(r=>({path:r.path,expectedUpdateTime:r.updateTime,metadataSHA256:sha(r.data)})).sort((a,b)=>a.path.localeCompare(b.path));
  need(deletions.length+input.records.filter(r=>['settings','control_chunks'].includes(r.path.split('/')[0])).length<440,'History exceeds atomic reset transaction size; no partial cleanup permitted.');
  rows.push({legacyAbsent:!input.records.some(r=>r.path==='reels_legacy_content/'+id),id,classification,sourceStatus,sourceRecordSHA256,diagnosticSHA256,video:{path:a.video.path,expectedUpdateTime:a.video.updateTime,metadataSHA256:sha(a.video.data)},deletions});
 }
 const guardRecords=input.records.filter(r=>['settings','control_chunks'].includes(r.path.split('/')[0])).map(r=>({path:r.path,expectedUpdateTime:r.updateTime,metadataSHA256:sha(r.data)})).sort((a,b)=>a.path.localeCompare(b.path));
 const body={schemaVersion:1,guardRecords,rule:confirmedFailureResetRule,source:{legacySnapshotSHA256:input.source.legacySnapshotSHA256,auditSHA256:input.source.auditSHA256,legacySnapshotCanonicalSHA256:digest(input.source.legacySnapshotCanonicalSHA256)?input.source.legacySnapshotCanonicalSHA256:null,observedAt:version(input.source.observedAt)?input.source.observedAt:null},observationComplete:true,rows:rows.sort((a,b)=>a.id.localeCompare(b.id)),excluded:excluded.sort((a,b)=>a.id.localeCompare(b.id)),approved:false,createsErrorBackup:false,startsProcessing:false,providerCalls:0};
 return {...body,planSHA256:sha(body)};
}
export function validateResetPlan(plan){const {planSHA256,...body}=plan??{};need(plan?.rule===confirmedFailureResetRule&&digest(planSHA256)&&sha(body)===planSHA256,'Reset plan hash differs.');need(plan.createsErrorBackup===false&&plan.startsProcessing===false&&plan.providerCalls===0,'Operation exceeds reset scope.');need(Array.isArray(plan.rows)&&new Set(plan.rows.map(r=>r.id)).size===plan.rows.length,'Invalid reset membership.');return true;}
// Leaves listed but omitted from data are deleted by Firestore updateMask. This
// removes diagnostics and stale pipeline pointers rather than hiding them in UI.
export const resetDeletedFields=Object.freeze(['error','error_code','failure_confirmed','uncertain','paid_result_uncertain','executions','reels_v2','import_hold','instagram_error_case','instagram_review_status','retry_status','analysis_review_reasons','candidate_terminal_decision','analysis_candidate','candidate_analysis_key','candidate_analysis_generation','worker','operation_id','execution_id','analysis_quality_status']);
export function resetWrites(row,planSHA256,{project,at,guardRecords=[]}){
 need(idPattern.test(row.id)&&project==='megabrain-v0-1017370021431'&&digest(planSHA256)&&version(at),'Exact project, plan and observation required.');
 const prefix=`projects/${project}/databases/(default)/documents/`;
 const fields={status:{stringValue:'registered'},stage:{nullValue:null},updated_at:{stringValue:at},operational_reset:{mapValue:{fields:{rule:{stringValue:confirmedFailureResetRule},planSHA256:{stringValue:planSHA256}}}}};
 const updates={update:{name:prefix+row.video.path,fields},updateMask:{fieldPaths:[...Object.keys(fields),...resetDeletedFields]},currentDocument:{updateTime:row.video.expectedUpdateTime}};
 return [...row.deletions.map(d=>({delete:prefix+d.path,currentDocument:{updateTime:d.expectedUpdateTime}})),updates];
}
// Store adapter has GET/query and one atomic commit only. It has no enqueue,
// provider, object-write or backup interface. Ambiguous responses are read back;
// never retry a stale transaction or proceed to a different membership silently.
export async function applyConfirmedFailureReset({plan,approvedPlanSHA256,store,project,assertClosed,onReceipt=async()=>{},clock=Date.now}){
 validateResetPlan(plan);need(approvedPlanSHA256===plan.planSHA256,'Exact reviewed plan approval required.');need(typeof assertClosed==='function'&&['beginResetTransaction','rollbackResetTransaction','atomicResetCommit','inspectResetMetadata'].every(k=>typeof store[k]==='function'),'Closed runtime guard and transactional adapter required.');
 const receipts=[];
 for(const row of plan.rows){
  await assertClosed();
  const transaction=await store.beginResetTransaction();need(typeof transaction==='string'&&transaction.length>0,'Read/write transaction missing.');
  let commitAttempted=false,ambiguous=false;
  try{
   const current=await store.inspectResetMetadata(row.id,{transaction});current.forEach(validateRecord);const a=assessment(row.id,current),video=current.find(r=>r.path===row.video.path);
   if(video?.data.resetRule===confirmedFailureResetRule&&video.data.resetPlan===plan.planSHA256&&video.data.status==='registered'){
    need(cleanReset(row.id,current,plan.planSHA256),'Previously reset history reappeared or new work exists.');
    await store.rollbackResetTransaction(transaction);const receipt={id:row.id,status:'already_reset',planSHA256:plan.planSHA256};await onReceipt(receipt);receipts.push(receipt);continue;
   }
   need(!a.reason,'Reset stopped: protected or changed record.');
   need(video.updateTime===row.video.expectedUpdateTime&&sha(video.data)===row.video.metadataSHA256,'Video changed since reviewed inspection.');
   need(canonical(current.filter(r=>['settings','control_chunks'].includes(r.path.split('/')[0])).map(r=>r.path).sort())===canonical((plan.guardRecords??[]).map(r=>r.path).sort()),'Protected control membership changed.');
   for(const guard of plan.guardRecords??[]){const fresh=current.find(r=>r.path===guard.path);need(fresh?.updateTime===guard.expectedUpdateTime&&sha(fresh.data)===guard.metadataSHA256,'Protected control state changed.');}
   const expected=row.deletions.map(d=>d.path).sort(),actual=a.deletions.map(d=>d.path).sort();need(canonical(expected)===canonical(actual),'Related history membership changed.');
   for(const d of row.deletions){const v=current.find(r=>r.path===d.path);need(v?.updateTime===d.expectedUpdateTime&&sha(v.data)===d.metadataSHA256,'History version changed.');}
   await assertClosed();await onReceipt({id:row.id,status:'intent',planSHA256:plan.planSHA256,expectedUpdateTime:row.video.expectedUpdateTime});commitAttempted=true;
   try{await store.atomicResetCommit(resetWrites(row,plan.planSHA256,{project,at:new Date(clock()).toISOString()}),{transaction});}catch{ambiguous=true;}
  }catch(error){if(!commitAttempted)await store.rollbackResetTransaction(transaction).catch(()=>{});throw error;}
  // A lost commit acknowledgement may mean the transaction was applied. Never
  // retry it. End the old transaction and reconcile via fresh read-only queries.
  if(ambiguous)await store.rollbackResetTransaction(transaction).catch(()=>{});
  const after=await store.inspectResetMetadata(row.id),saved=after.find(r=>r.path===row.video.path);
  need(cleanReset(row.id,after,plan.planSHA256),'Reset response unconfirmed; stop and inspect without replay.');
  need(!row.deletions.some(d=>after.some(r=>r.path===d.path)),'History removal unconfirmed; stop without replay.');
  const receipt={id:row.id,status:'reset',planSHA256:plan.planSHA256,observedUpdateTime:saved.updateTime,deletedHistoryRecords:row.deletions.length,ambiguousResponseReconciled:ambiguous};await onReceipt(receipt);receipts.push(receipt);
 }
 return {rule:confirmedFailureResetRule,planSHA256:plan.planSHA256,receipts,resetCount:receipts.filter(r=>r.status==='reset').length,alreadyReset:receipts.filter(r=>r.status==='already_reset').length,createsErrorBackup:false,providerCalls:0,startedReels:0};
}
