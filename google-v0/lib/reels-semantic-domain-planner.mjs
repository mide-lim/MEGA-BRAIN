import {publicationAvailable} from './reels-model.mjs';
import {semanticHash,semanticSourceFromSaved} from './reels-semantic-source.mjs';
import {semanticSourceRecoveryReceiptValid} from './reels-semantic-source-recovery.mjs';
import {semanticDomainVersion,semanticDomainProfiles,semanticDomainProfile,routeExistingSemanticDomain} from './reels-semantic-domain-contract.mjs';
import {semanticDomainBudget,measureSemanticDomainRequest} from './reels-semantic-domain-budget.mjs';
export {semanticDomainBudget,measureSemanticDomainRequest} from './reels-semantic-domain-budget.mjs';
const same=(a,b)=>semanticHash(a)===semanticHash(b);
export const domainSourcePin=s=>({id:s.id,sourceIdentity:s.sourceIdentity,sourceVersions:s.sourceVersions,semanticProofHash:s.semanticProofHash,editorialHash:s.editorialHash,sourceProjectionVersion:s.sourceProjectionVersion});
function disposition(source,histories){
 if(!Array.isArray(histories))return {state:'historical_coverage_unconfirmed',reason:'HISTORICAL_SUBMISSIONS_NOT_OBSERVED'};if(!histories.length)return {state:'eligible',reason:'COMPLETE_SUBMISSION_INVENTORY_EMPTY',historicalRefs:[]};
 let retained=false,protectedAttempt=false,unconfirmed=false,refs=[];
 for(const h of histories){const j=h.job?.data??h.job;if(!j||!Array.isArray(j.pins))return {state:'historical_coverage_unconfirmed',reason:'HISTORICAL_JOB_INVALID'};
  const index=j.pins.findIndex(p=>p.id===source.id);if(index<0)continue;const pin=j.pins[index];
  if(!same(pin.sourceVersions,source.sourceVersions)){unconfirmed=true;refs.push({jobId:j.id,state:'source_epoch_changed'});continue;}
  if(index<(j.cursor??0)){
   const results=(h.results??[]).map(r=>r.data??r).filter(r=>r.processed===true&&r.binding?.jobId===j.id&&r.binding.phase==='extract'&&r.binding.pins?.some(p=>p.id===source.id)&&r.bindingHash===semanticHash(r.binding));
   const matching=results.some(r=>{const p=r.binding.pins.find(p=>p.id===source.id);if(p.semanticProofHash===source.semanticProofHash&&p.editorialHash===source.editorialHash)return true;const receipt=(h.recoveries??[]).map(x=>x.data??x).find(x=>x.batchId===r.id);return semanticSourceRecoveryReceiptValid(receipt)&&receipt.jobId===j.id&&receipt.savedRawHash===r.rawHash&&receipt.originalBindingHash===r.bindingHash&&receipt.rows.some(row=>row.id===source.id&&row.canonicalSemanticProofHash===source.semanticProofHash&&row.editorialHash===source.editorialHash&&same(row.sourceIdentity,source.sourceIdentity)&&same(row.sourceVersions,source.sourceVersions));});
   if(matching){retained=true;refs.push({jobId:j.id,state:'retained_applied'});}else{unconfirmed=true;refs.push({jobId:j.id,state:'processed_result_proof_unconfirmed'});}
  }
  const b=j.batch,submittedPins=Array.isArray(b?.binding?.pins)?b.binding.pins:[],attemptTouchesSource=b?.status==='submitting'&&(submittedPins.some(p=>p.id===source.id)||(b.sourceIds??[]).includes(source.id)||index>=j.cursor&&index<j.cursor+(submittedPins.length||(b.sourceIds??[]).length||j.policy?.batchSize||8));
  if(attemptTouchesSource){
   const boundJobPins=j.pins.slice(j.cursor,j.cursor+submittedPins.length),validIntent=j.cohortHash===semanticHash(j.pins)&&b.binding&&b.bindingHash===semanticHash(b.binding)&&b.binding.jobId===j.id&&b.binding.phase==='extract'&&b.binding.cursor===j.cursor&&b.offset===j.cursor&&submittedPins.length>0&&new Set(submittedPins.map(p=>p.id)).size===submittedPins.length&&same(submittedPins.map(p=>({id:p.id,sourceVersions:p.sourceVersions})),boundJobPins.map(p=>({id:p.id,sourceVersions:p.sourceVersions})))&&(!b.sourceIds||same(b.sourceIds,submittedPins.map(p=>p.id)));
   const p=submittedPins.find(p=>p.id===source.id);
   if(validIntent&&p&&same(p.sourceVersions,source.sourceVersions)){protectedAttempt=true;refs.push({jobId:j.id,batchId:b.id,state:'protected_attempt',basis:'submitted_identity_and_source_epoch',submittedSemanticProofHash:p.semanticProofHash??null,currentSemanticProofHash:source.semanticProofHash,submittedEditorialHash:p.editorialHash??null,currentEditorialHash:source.editorialHash,submittedProjectionVersion:p.sourceProjectionVersion??null,currentProjectionVersion:source.sourceProjectionVersion,equivalenceUnproven:p.semanticProofHash!==source.semanticProofHash||p.editorialHash!==source.editorialHash});}else{unconfirmed=true;refs.push({jobId:j.id,batchId:b.id,state:'submitted_binding_unconfirmed'});}
  }
 }
 return {state:protectedAttempt?'protected_uncertain':unconfirmed?'historical_coverage_unconfirmed':retained?'retained_applied':'eligible',reason:protectedAttempt?'EXISTING_SUBMITTED_ATTEMPT_NO_REPLAY':unconfirmed?'HISTORICAL_SOURCE_PROOF_UNCONFIRMED':retained?'SAVED_APPLIED_RESULT_RETAINED':'NO_PRIOR_SUBMISSION_FOR_THIS_SOURCE_EPOCH',historicalRefs:refs};
}
export function prepareSemanticDomainManifest({records,taxonomy={nodes:[]},histories,catalogue={groups:[]},budget:rawBudget={},prepareRequest,observedAt,historyCoverageConfirmed=false}){
 if(!Array.isArray(records)||typeof prepareRequest!=='function'||!Number.isFinite(Date.parse(observedAt)))throw Error('DOMAIN_MANIFEST_INPUT_INVALID');
 const budget=semanticDomainBudget(rawBudget),seen=new Set(),sources=[],original=new Map();
 for(const record of [...records].sort((a,b)=>(a.source?.id??a.id)<(b.source?.id??b.id)?-1:1)){
  const source=record.source??{id:record.id,sourceVersions:record.sourceVersions,sourceIdentity:record.sourceIdentity??null,semanticProofHash:null,editorialHash:null,sourceProjectionVersion:null,fields:[],editorial:{manual:record.manual===true},truncated:false};if(!source||seen.has(source.id)||!Array.isArray(source.fields)||!source.sourceVersions?.video)throw Error('DOMAIN_SOURCE_INVALID');seen.add(source.id);original.set(source.id,source);
  const route=routeExistingSemanticDomain(record.categoryIds??[],taxonomy.nodes),prior=source.fields.length?(historyCoverageConfirmed?disposition(source,histories):{state:'historical_coverage_unconfirmed',reason:'HISTORICAL_COVERAGE_NOT_FRESH_CONFIRMED'}):{state:'source_unavailable',reason:record.reason??'PUBLISHED_ANALYSIS_TEXT_UNAVAILABLE'};
  sources.push({...domainSourcePin(source),...prior,domainId:route.domainId,routing:route,manual:source.editorial.manual,sourceTruncated:source.truncated===true,sourceTruncationReasons:source.truncationReasons??[],analysisCoverage:{analysisPresent:record.analysisPresent===true,analysisAcceptance:record.analysisAcceptance??null,sourceKind:source.sourceIdentity?.kind??null,savedTextPresent:source.fields.length>0,captionPresent:source.fields.some(f=>f.source==='caption'),transcriptPresent:source.fields.some(f=>f.source==='transcript'),fieldCount:source.fields.length}});
 }
 const domains=[];
 for(const profile of semanticDomainProfiles){
  const members=sources.filter(s=>s.domainId===profile.id);
  const measure=ids=>{const request=prepareRequest({phase:'extract',payload:{sources:ids.map(id=>original.get(id)),catalogue},requestId:'0'.repeat(64),domainId:profile.id,measurementOnly:true});return measureSemanticDomainRequest(request,budget);};
  function pack(candidates,markBlocked){const batches=[];let pending=[];const flush=()=>{if(!pending.length)return;const pins=pending.map(id=>domainSourcePin(original.get(id))),from=batches.reduce((n,b)=>n+b.sourceIds.length,0),measurement=measure(pending);batches.push({id:semanticHash({version:semanticDomainVersion,domainId:profile.id,pins,budget}),fromCursor:from,toCursor:from+pending.length,sourceIds:pending,pins,measurement});pending=[];};
   for(const source of candidates){const next=[...pending,source.id];if(next.length<=budget.maxSources&&measure(next).withinBudget){pending=next;continue;}flush();const measurement=measure([source.id]);if(measurement.withinBudget)pending=[source.id];else{source.measurement=measurement;source.measurementState='single_source_over_budget';if(markBlocked){source.state='input_over_budget';source.reason='SINGLE_SOURCE_FULL_REQUEST_OVER_BUDGET';}}}flush();return batches;
  }
  const batches=pack(members.filter(s=>s.state==='eligible'),true),measurementBatches=pack(members.filter(s=>['eligible','historical_coverage_unconfirmed'].includes(s.state)&&original.get(s.id).fields.length),false).map(({pins,...batch})=>({...batch,pinsHash:semanticHash(pins)}));
  domains.push({id:profile.id,label:profile.label,profileVersion:profile.version,profileHash:semanticHash(profile),memberIds:members.map(s=>s.id),eligibleIds:batches.flatMap(b=>b.sourceIds),batches,measurementBatches,maximumNewCalls:batches.length*2+(batches.length?1:0),measurementCallUpperBound:measurementBatches.length*2+(measurementBatches.length?1:0),inventoryCount:members.length,eligibleCount:batches.reduce((n,b)=>n+b.sourceIds.length,0),retainedCount:members.filter(s=>s.state==='retained_applied').length,protectedCount:members.filter(s=>s.state==='protected_uncertain').length,historicalUnconfirmedCount:members.filter(s=>s.state==='historical_coverage_unconfirmed').length,inputOverBudgetCount:members.filter(s=>s.measurementState==='single_source_over_budget').length});
 }
 const baseline=historyCoverageConfirmed?(histories??[]).reduce((n,h)=>{const j=h.job?.data??h.job;return n+(Number.isSafeInteger(j?.callsUsed)?j.callsUsed:0);},0):null;
 const body={kind:'semantic_domain_manifest',storagePolicy:{version:'firestore-native-size-v1',maximumNativeBytes:900000,hardDocumentLimitBytes:1048576},version:semanticDomainVersion,observedAt,budget,budgetHash:semanticHash(budget),catalogueHash:semanticHash(catalogue),taxonomyHash:semanticHash(taxonomy),inventoryCount:sources.length,inventoryHash:semanticHash(sources.map(s=>({id:s.id,sourceVersions:s.sourceVersions}))),sources,domains,historicalBindings:(histories??[]).flatMap(h=>[h.job,...(h.results??[]),...(h.recoveries??[])].filter(r=>r?.path&&r?.updateTime&&r?.data).map(r=>({path:r.path,updateTime:r.updateTime,dataHash:semanticHash(r.data)}))),historyCoverageConfirmed,globalMaximumCalls:127,baselineConsumedCalls:baseline,remainingGlobalCalls:baseline===null?null:Math.max(0,127-baseline),measurementCallUpperBound:domains.reduce((n,d)=>n+d.measurementCallUpperBound,0),newCallUpperBound:domains.reduce((n,d)=>n+d.maximumNewCalls,0),fitsRemainingGlobalBudget:baseline===null?null:domains.reduce((n,d)=>n+d.maximumNewCalls,0)<=127-baseline,executionAuthorized:false,globalConcurrency:1,automaticPolicyInstall:false,providerCalls:0,sourceWrites:0,limits:['Token counts are conservative UTF8 estimates, not provider counts.','Routing from existing categories is operational and not semantic certification.','Historical coverage requires positive applied-result and submitted-binding evidence.']};
 return {...body,manifestHash:semanticHash(body)};
}

export function measureSemanticDomainManifestStorage(value){
 const stringBytes=s=>Buffer.byteLength(s,'utf8')+1;
 const fieldBytes=v=>v===null||typeof v==='boolean'?1:typeof v==='number'?8:typeof v==='string'?stringBytes(v):Array.isArray(v)?v.reduce((n,x)=>n+fieldBytes(x),0):v&&typeof v==='object'?32+Object.entries(v).reduce((n,[key,x])=>n+stringBytes(key)+fieldBytes(x),0):0;
 const nativeDocumentBytes=stringBytes('settings')+stringBytes('reels_v2_semantic_domain_plan')+16+fieldBytes(value);
 return {version:'firestore-native-size-v1',nativeDocumentBytes,compactJsonUtf8Bytes:Buffer.byteLength(JSON.stringify(value),'utf8'),maximumNativeBytes:900000,hardDocumentLimitBytes:1048576,withinLimit:nativeDocumentBytes<=900000,scope:'native_document_size_estimate_not_rest_encoding'};
}

export function semanticDomainManifestValid(value){
 try{const {manifestHash,...body}=value;if(!measureSemanticDomainManifestStorage(value).withinLimit||value.storagePolicy?.maximumNativeBytes!==900000)return false;if(value.kind!=='semantic_domain_manifest'||value.version!==semanticDomainVersion||semanticHash(body)!==manifestHash||value.executionAuthorized!==false||value.globalConcurrency!==1||value.inventoryCount!==value.sources.length||new Set(value.sources.map(s=>s.id)).size!==value.sources.length||!same(value.budget,semanticDomainBudget(value.budget))||value.budgetHash!==semanticHash(value.budget))return false;
  const all=value.domains.flatMap(d=>d.memberIds);if(all.length!==value.sources.length||new Set(all).size!==all.length)return false;
  return value.domains.length===semanticDomainProfiles.length&&value.domains.every(d=>{const profile=semanticDomainProfile(d.id);if(!profile||d.profileHash!==semanticHash(profile)||!same(d.memberIds,value.sources.filter(s=>s.domainId===d.id).map(s=>s.id)))return false;let offset=0;for(const b of d.batches){if(b.fromCursor!==offset||b.toCursor!==offset+b.sourceIds.length||!b.sourceIds.length||b.sourceIds.length>value.budget.maxSources||!b.measurement.withinBudget||!same(b.sourceIds,b.pins.map(p=>p.id))||!b.pins.every(p=>same(p,domainSourcePin(value.sources.find(s=>s.id===p.id))))||b.sourceIds.some(id=>value.sources.find(s=>s.id===id)?.state!=='eligible'))return false;offset=b.toCursor;}return same(d.eligibleIds,d.batches.flatMap(b=>b.sourceIds))&&d.maximumNewCalls===d.batches.length*2+(d.batches.length?1:0);});
 }catch{return false;}
}

export function prepareDomainSemanticJobPlan({inventory,selection,policy,manifest,observedAt,promptHash}){
 const dc=policy.domainCuration;if(!dc||dc.version!=='semantic-domain-job-v1'||!semanticDomainManifestValid(manifest)||dc.planHash!==manifest.manifestHash||!semanticDomainProfile(dc.domainId)||selection?.domainId!==dc.domainId||Object.keys(selection).some(k=>k!=='domainId'))throw Object.assign(Error('DOMAIN_SELECTION_OR_MANIFEST_INVALID'),{code:'DOMAIN_SELECTION_OR_MANIFEST_INVALID',status:409});
 const domain=manifest.domains.find(d=>d.id===dc.domainId),byId=new Map(inventory.map(s=>[s.id,s])),pins=domain.batches.flatMap(b=>b.pins).map(s=>({id:s.id,sourceVersions:s.sourceVersions})),cohortHash=semanticHash(pins),maximumCalls=domain.maximumNewCalls,blockingReasons=[];
 if(!pins.length)blockingReasons.push('DOMAIN_HAS_NO_ELIGIBLE_SOURCES');
 if(pins.some(p=>!byId.has(p.id)||!same(byId.get(p.id).sourceVersions,p.sourceVersions)))blockingReasons.push('DOMAIN_SOURCE_EPOCH_CHANGED');
 if(!policy.enabled)blockingReasons.push('CURATION_NOT_AUTHORIZED');
 if(!policy.model||!policy.verifierModel)blockingReasons.push('MODEL_NOT_CONFIGURED');
 if(!policy.authorizationId||policy.authorizedCohortHash!==cohortHash)blockingReasons.push('COHORT_NOT_AUTHORIZED');
 if(!stamp(observedAt)||!stamp(policy.expiresAt)||Date.parse(policy.expiresAt)<=Date.parse(observedAt))blockingReasons.push('AUTHORIZATION_EXPIRED');
 if(maximumCalls>policy.maxCalls||maximumCalls>125)blockingReasons.push('DOMAIN_EXCEEDS_REMAINING_GLOBAL_CAP');
 if(!dc.authorizationGroupId)blockingReasons.push('OWNER_QUARANTINE_AUTHORITY_REQUIRED');
 const domainCuration={version:dc.version,domainId:dc.domainId,planHash:dc.planHash,authorizationGroupId:dc.authorizationGroupId,profileHash:domain.profileHash,promptHash,budget:manifest.budget,batches:domain.batches};
 const preview={publishedCount:inventory.length,selectedCount:pins.length,cohortHash,batchSize:null,variableBatches:true,batchCount:domain.batches.length,maximumCalls,model:policy.model,promptHash,providerEnabled:blockingReasons.length===0,blockingReasons,domainId:dc.domainId,globalMaximumCalls:127,baselineConsumedCalls:2,remainingGlobalCalls:125,estimated:true};
 return {version:semanticDomainVersion,pins,policy,preview,domainCuration,previewHash:semanticHash({pins,policy,domainCuration,maximumCalls}),observedAt,providerCalls:0,inferenceStarted:false};
}
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));

export function semanticDomainRecordFromSaved(raw={}){
 const video=raw.video??{},legacy=raw.legacy??null,item=raw.item??{},native=publicationAvailable(video),report=native?video.analysis:legacy?.analysis,analysisPresent=!!report&&typeof report==='object'&&!Array.isArray(report),base={id:item.id??video.id,categoryIds:item.categoryIds??[],sourceVersions:raw.sourceVersions??{},analysisPresent,analysisAcceptance:native?'native_published':legacy?'legacy_preserved':'unavailable'};
 try{return {...base,source:semanticSourceFromSaved(raw)};}catch{return {...base,source:null,sourceIdentity:null,reason:'ACCEPTED_SAVED_ANALYSIS_TEXT_UNAVAILABLE'};}
}
