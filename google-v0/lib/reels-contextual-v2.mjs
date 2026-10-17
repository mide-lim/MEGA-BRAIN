import {recipeRecurrence} from './reels-taxonomy.mjs';
import {categoryDefinitions} from './category-taxonomy.mjs';
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
  proofs.set(p.id,{...normalized,id:p.id,sourceIdentity:p.sourceIdentity,state,reason,verificationLevel:state==='supported'?'semantic_support_reviewed':literalIds.has(p.id)?'literal_anchor_verified':'source_present'});
 }
 for(const duplicate of duplicateIds)proofs.set(duplicate,{...proofs.get(duplicate),state:'invalid',reason:'DUPLICATE_EVIDENCE_REFERENCE'});
 const refs=input=>list(input).slice(0,8).map(ref=>proofs.get(ref)??{id:typeof ref==='string'?ref:'unknown',source:'unknown',excerpt:'',state:'invalid',reason:'EVIDENCE_REFERENCE_MISSING'});
 const completeEvidence=ev=>ev.length>0&&ev.every(p=>p.state==='supported');
 const contextSignal=signal.primaryContext,definition=categoryDefinitions.find(c=>c.id===contextSignal?.categoryId),contextProof=refs(contextSignal?.evidenceRefs);
 const context=definition?{value:groupContext[definition.group]??null,state:completeEvidence(contextProof)?'supported':'present_unverified',categoryId:definition.id,reason:completeEvidence(contextProof)?'INDEPENDENT_CONTEXT_SUPPORT_REVIEWED':'PUBLISHED_CONTEXT_CANDIDATE'}:null;
 const units=list(signal.units).slice(0,64).filter(u=>object(u)&&id(u.unitId)).map(u=>({id:u.unitId,kind:u.type,title:u.unitId,state:'present_unverified',complete:false,claimedCompleteness:u.completeness,evidence:refs(u.evidenceRefs)}));
 let verifiedUnits=[],independentUnitCount=null,format=null;
 // Recipe unit independence remains the existing temporal contract, augmented
 // with independent evidence review. A model's complete/state flags alone never
 // make an enumeration known.
 if(context?.value==='recipe'&&units.length&&new Set(units.map(u=>u.id)).size===units.length&&units.every((u,i)=>u.kind==='recipe'&&signal.units[i]?.completeness==='complete'&&completeEvidence(u.evidence))){
  const adapted={...raw,analysis:{...raw.analysis,knowledge:{...(raw.analysis.knowledge??{}),context:'recipe'},taxonomySignals:{version:1,parentCategoryId:context.categoryId,complete:true,confidence:1,units:units.map(u=>({id:u.id,kind:'recipe',title:u.id,evidence:u.evidence.map(p=>({source:p.source,excerpt:p.excerpt,start_seconds:p.startSeconds,end_seconds:p.endSeconds}))}))}}};
  const recurrence=recipeRecurrence(adapted);
  if(recurrence.state==='supported'){
   verifiedUnits=units.map(u=>({...u,state:'supported',complete:true}));independentUnitCount=verifiedUnits.length;format={dimensionId:'format',value:recurrence.value,label:recurrence.label,state:'supported',reason:'INDEPENDENT_REVIEW_AND_RECIPE_TEMPORAL_PROOF'};
  }
 }
 const attributes=[];
 for(const a of list(signal.attributes).slice(0,64)){
  if(!object(a)||!dimensions.has(a.dimension)||!id(a.valueId))continue;
  const ev=refs(a.evidenceRefs),semantic=trusted&&completeEvidence(ev),scope=['video','unit'].includes(a.scope)?a.scope:null;
  let state=states.has(a.state)?a.state:'invalid',reason=states.has(a.state)?'SAVED_CONTEXTUAL_ATTRIBUTE':'INVALID_COVERAGE_STATE';
  if(state==='supported'&&!semantic)state=ev.some(p=>p.state==='invalid')?'invalid':'present_unverified',reason='INDEPENDENT_ATTRIBUTE_SUPPORT_NOT_VERIFIED';
  const requestedUnits=list(a.unitIds),unitIds=[...new Set(requestedUnits.filter(unit=>verifiedUnits.some(u=>u.id===unit)))];
  if(!scope||scope==='unit'&&(!requestedUnits.length||unitIds.length!==requestedUnits.length))state=state==='invalid'?'invalid':'unknown',reason='UNIT_SCOPE_NOT_PROVEN';
  const pol=['positive','negated','unknown'].includes(a.polarity)?a.polarity:'unknown',role=roles.has(a.role)?a.role:'unknown';
  if(!roles.has(a.role)||!['positive','negated','unknown'].includes(a.polarity))state='invalid',reason='INVALID_ROLE_OR_POLARITY';
  if(a.dimension==='format'&&state==='supported'&&(!format||format.value!==a.valueId))state='unknown',reason='FORMAT_ENUMERATION_NOT_PROVEN';
  attributes.push({dimensionId:a.dimension,dimension:a.dimension,valueId:a.valueId,label:a.valueId.replace(/[_-]+/g,' '),scope,unitIds,role:pol==='negated'?'excluded':role==='central'&&!semantic?'unknown':role,claimedRole:role,polarity:pol==='positive'?'affirmed':pol,state,reason,evidence:ev});
 }
 return {context,units:verifiedUnits,unitCandidates:units,independentUnitCount,format,attributes,evidence:[...proofs.values()],receiptTrusted:trusted};
}
