import {categoryDefinitions} from './category-taxonomy.mjs';
import {contextualPropositionHash,semanticQualityPolicyVersion} from './reels-quality-semantic-policy.mjs';
import {evidenceWindow} from './reels-speech-evidence.mjs';
const states=new Set(['supported','present_unverified','not_recorded','not_applicable','unknown','inconclusive','invalid']);
const roles=new Set(['central','supporting','mentioned','excluded','unknown']);
const dimensions=new Set(['ingredient','format','method','practicality_basis','tool','place','purpose','other']);
const list=v=>Array.isArray(v)?v:[];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const groupContext={'Alimentação':'recipe','Tecnologia':'technology','Saúde e bem-estar':'health','Trabalho e negócios':'business','Casa e estilo':'home','Viagens e lugares':'travel','Outros temas':'general'};
function boundSource(raw,proof){
 if(typeof proof.sourceIdentity!=='string')return false;
 if(proof.sourceKind==='caption')return !!raw.source_caption?.capture_id&&proof.sourceIdentity===raw.source_caption.capture_id;
 if(proof.sourceKind==='transcript')return !!raw.transcript_key&&!!raw.transcript_generation&&proof.sourceIdentity===raw.transcript_key+'@'+raw.transcript_generation;
 if(proof.sourceKind==='video')return !!raw.video_key&&!!raw.video_generation&&proof.sourceIdentity===raw.video_key+'@'+raw.video_generation;
 return false; // No automatic saved_analysis support rule has been calibrated.
}
export function normalizeContextualSignalsV2({raw,identity,verification,makeEvidence}){
 const signal=raw.analysis?.contextualSignals;
 if(!object(signal)||signal.version!==2)return null;
 const trusted=verification?.trusted===true&&verification.policyVersion==='gate_v2';
 const reviewedIds=new Set(trusted?list(verification.verifiedEvidenceIds):[]),literalIds=new Set(trusted?list(verification.literalEvidenceIds):[]);
 const propositionReviewed=(entry,path,proposition)=>trusted&&entry?.state==='supported'&&entry.fieldPath===path&&entry.policyVersion===semanticQualityPolicyVersion&&entry.propositionHash===contextualPropositionHash(proposition)&&entry.reportHash===verification.candidateContentHash&&typeof entry.sourceManifestHash==='string'&&/^[a-f0-9]{64}$/.test(entry.sourceManifestHash)&&typeof entry.reviewReceiptId==='string'&&entry.reviewReceiptId.length>0&&JSON.stringify(entry.evidenceRefs)===JSON.stringify(proposition.evidenceRefs);
 const proofs=new Map(),duplicateIds=new Set();
 for(const p of list(signal.evidence).slice(0,128)){
  if(!object(p)||!id(p.id))continue;
  if(proofs.has(p.id)){duplicateIds.add(p.id);continue;}
  const source=boundSource(raw,p),range=p.timeRange??{},proof=makeEvidence(raw,[{source:p.sourceKind,excerpt:p.excerpt,start_seconds:range.startSeconds??range.start_seconds??range.start,end_seconds:range.endSeconds??range.end_seconds??range.end}],identity)[0];
  const normalized=proof??{source:p.sourceKind,excerpt:typeof p.excerpt==='string'?p.excerpt.slice(0,2000):'',startSeconds:null,endSeconds:null,state:'unknown',reason:'SOURCE_ANCHOR_UNAVAILABLE'};
  let state=normalized.state,reason=normalized.reason;
  if(!source)state='invalid',reason='VERSIONED_SOURCE_IDENTITY_MISMATCH';
  else if(!trusted)state=state==='invalid'?'invalid':'present_unverified',reason='TRUSTED_PUBLICATION_RECEIPT_MISSING';
  else if(!reviewedIds.has(p.id))state=state==='invalid'?'invalid':'present_unverified',reason=literalIds.has(p.id)?'LITERAL_ANCHOR_NOT_SEMANTIC_REVIEW':'SEMANTIC_SUPPORT_NOT_REVIEWED';
  else if(state==='supported'||p.sourceKind==='video'&&state==='present_unverified')state='supported',reason='INDEPENDENT_SOURCE_SUPPORT_REVIEWED';
  proofs.set(p.id,{...normalized,id:p.id,sourceIdentity:p.sourceIdentity,anchorVerified:source&&normalized.state==='supported'&&trusted&&(literalIds.has(p.id)||reviewedIds.has(p.id)),state,reason,verificationLevel:state==='supported'?'semantic_support_reviewed':literalIds.has(p.id)?'literal_anchor_verified':'source_present'});
 }
 for(const duplicate of duplicateIds)proofs.set(duplicate,{...proofs.get(duplicate),state:'invalid',reason:'DUPLICATE_EVIDENCE_REFERENCE'});
 const refs=input=>list(input).slice(0,8).map(ref=>proofs.get(ref)??{id:typeof ref==='string'?ref:'unknown',source:'unknown',excerpt:'',state:'invalid',reason:'EVIDENCE_REFERENCE_MISSING'});
 const propositionProofs=(input,reviewed)=>refs(input).map(p=>reviewed&&(p.anchorVerified||p.state==='supported')?{...p,state:'supported',reason:'EXACT_PROPOSITION_AND_SOURCE_ANCHOR_REVIEWED'}:p);
 const contextSignal=signal.primaryContext,definition=categoryDefinitions.find(c=>c.id===contextSignal?.categoryId),contextReviewed=contextSignal&&propositionReviewed(verification?.verifiedPrimaryContext,'contextualSignals.primaryContext',contextSignal),contextProof=propositionProofs(contextSignal?.evidenceRefs,contextReviewed);
 const context=definition?{value:definition.id==='receitas'?'recipe':definition.id==='nutricao'?'health':definition.group==='Alimentação'?'general':groupContext[definition.group]??null,state:contextProof.some(p=>p.state==='invalid')?'invalid':contextReviewed&&contextProof.length&&contextProof.every(p=>p.state==='supported')?'supported':contextProof.length?'present_unverified':'not_recorded',categoryId:definition.id,reason:contextReviewed?'EXACT_CONTEXT_PROPOSITION_REVIEWED':'CONTEXT_PROPOSITION_NOT_INDEPENDENTLY_REVIEWED'}:null;
 const units=list(signal.units).slice(0,64).map((u,index)=>{
  if(!object(u)||!id(u.unitId))return null;
  const reviewed=propositionReviewed(list(verification?.verifiedUnits).find(r=>r.fieldPath==='contextualSignals.units.'+index),'contextualSignals.units.'+index,u),ev=propositionProofs(u.evidenceRefs,reviewed);
  const temporal=ev.some(p=>p.state==='supported'&&p.source==='transcript'&&evidenceWindow(raw,{source:'transcript',excerpt:p.excerpt,start_seconds:p.startSeconds,end_seconds:p.endSeconds}));
  const complete=reviewed&&u.type==='recipe'&&u.completeness==='complete'&&ev.length>0&&ev.every(p=>p.state==='supported')&&temporal;
  return {id:u.unitId,kind:u.type,title:u.unitId,state:complete?'supported':'present_unverified',complete,claimedCompleteness:u.completeness,evidence:ev};
 }).filter(Boolean);
 // Reviewed complete units must remain independent in real saved timing.
 const duplicateUnitIds=new Set(units.filter((u,i)=>units.findIndex(v=>v.id===u.id)!==i).map(u=>u.id));
 const overlaps=(a,b)=>a.evidence.some(p=>p.source==='transcript'&&p.state==='supported'&&b.evidence.some(q=>q.source==='transcript'&&q.state==='supported'&&Math.max(p.startSeconds,q.startSeconds)<Math.min(p.endSeconds,q.endSeconds)));
 for(const u of units)if(duplicateUnitIds.has(u.id)||u.complete&&units.some(v=>v!==u&&v.complete&&overlaps(u,v))){u.complete=false;u.state='inconclusive';}
 const verifiedUnits=units.filter(u=>u.complete&&u.state==='supported');
 let independentUnitCount=null,format=null;
 const attributes=[];
 for(const [index,a] of list(signal.attributes).slice(0,64).entries()){
  if(!object(a)||!dimensions.has(a.dimension)||!id(a.valueId))continue;
  const reviewed=propositionReviewed(list(verification?.verifiedAttributes).find(r=>r.fieldPath==='contextualSignals.attributes.'+index),'contextualSignals.attributes.'+index,a);
  const ev=propositionProofs(a.evidenceRefs,reviewed),scope=['video','unit'].includes(a.scope)?a.scope:null;
  let state=states.has(a.state)?a.state:'invalid',reason=states.has(a.state)?'SAVED_CONTEXTUAL_ATTRIBUTE':'INVALID_COVERAGE_STATE';
  if(state==='supported'){state=ev.some(p=>p.state==='invalid')?'invalid':reviewed&&ev.length&&ev.every(p=>p.state==='supported')?'supported':'present_unverified';reason=state==='supported'?'EXACT_ATTRIBUTE_PROPOSITION_REVIEWED':'ATTRIBUTE_PROPOSITION_NOT_INDEPENDENTLY_REVIEWED';}
  const requestedUnits=list(a.unitIds),unitIds=[...new Set(requestedUnits.filter(unit=>verifiedUnits.some(u=>u.id===unit&&ev.some(p=>p.state==='supported'&&u.evidence.some(up=>up.state==='supported'&&up.source==='transcript'&&up.excerpt.includes(p.excerpt)&&(p.source==='caption'||p.source==='transcript'&&p.startSeconds>=up.startSeconds&&p.endSeconds<=up.endSeconds))))))];
  if(!scope||scope==='unit'&&(!requestedUnits.length||unitIds.length!==requestedUnits.length))state=state==='invalid'?'invalid':'unknown',reason='UNIT_SCOPE_NOT_PROVEN';
  const pol=['positive','negated','unknown'].includes(a.polarity)?a.polarity:'unknown',role=roles.has(a.role)?a.role:'unknown';
  if(!roles.has(a.role)||!['positive','negated','unknown'].includes(a.polarity))state='invalid',reason='INVALID_ROLE_OR_POLARITY';
  if(a.dimension==='format'&&state==='supported'){
   const allUnitsKnown=units.length>0&&verifiedUnits.length===units.length&&new Set(requestedUnits).size===verifiedUnits.length&&verifiedUnits.every(u=>requestedUnits.includes(u.id));
   const correctFormat=a.valueId==='single_recipe'&&verifiedUnits.length===1||a.valueId==='recipe_collection'&&verifiedUnits.length>1;
   if(allUnitsKnown&&correctFormat){independentUnitCount=verifiedUnits.length;format={dimensionId:'format',value:a.valueId,label:a.valueId==='single_recipe'?'Receita única':'Lista de receitas',state:'supported',reason:'EXACT_FORMAT_AND_INDEPENDENT_UNITS_REVIEWED'};}
   else state='unknown',reason='FORMAT_ENUMERATION_NOT_PROVEN';
  }
  attributes.push({dimensionId:a.dimension,dimension:a.dimension,valueId:a.valueId,label:a.valueId.replace(/[_-]+/g,' '),scope,unitIds,role:pol==='negated'?'excluded':state==='supported'?role:'unknown',claimedRole:role,polarity:pol,state,reason,evidence:ev});
 }
 return {context,units:verifiedUnits,unitCandidates:units,independentUnitCount,format,attributes,evidence:[...proofs.values()],receiptTrusted:trusted};
}
