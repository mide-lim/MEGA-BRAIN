import {createHash} from 'node:crypto';
import {publicationAvailable} from './reels-model.mjs';
import {preservedContentAvailable} from './reels-preserved-content.mjs';
import {recipeRecurrence} from './reels-taxonomy.mjs';
import {normalizeContextualSignalsV2} from './reels-contextual-v2.mjs';

export const contextualVersion='contextual-curation-v1';
export const coverageStates=Object.freeze(['supported','present_unverified','not_recorded','not_applicable','unknown','inconclusive','invalid']);
const roles=new Set(['central','supporting','mentioned','excluded','unknown']);
const list=v=>Array.isArray(v)?v:[];
const text=(v,max=2000)=>typeof v==='string'?v.slice(0,max):'';
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const normalize=v=>text(v).normalize('NFKC').normalize('NFD').replace(/\p{M}/gu,'').trim().toLocaleLowerCase('pt-BR').replace(/\s+/g,' ');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v??null);
export const contextualHash=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const dimensionDefinitions=Object.freeze([
 {id:'format',label:'Formato',contexts:['recipe']},
 {id:'ingredient',label:'Ingredientes',contexts:['recipe']},
 {id:'tool',label:'Equipamentos e ferramentas',contexts:null},
 {id:'method',label:'Método de preparo',contexts:['recipe']},
 {id:'practicality_basis',label:'Bases de praticidade',contexts:['recipe']},
 {id:'place',label:'Lugares',contexts:['travel']},
 {id:'purpose',label:'Finalidade',contexts:null},
 {id:'other',label:'Outros atributos',contexts:null}
]);
const vocabulary={
 ingredient:[
  ['frango','Frango',['frango','peito de frango','file de frango','coxa de frango','sobrecoxa de frango','chicken','chicken breast']],
  ['carne-bovina','Carne bovina',['carne bovina','carne de boi','beef']],
  ['peixe','Peixe',['peixe','fish']],['ovo','Ovo',['ovo','ovos','egg','eggs']]
 ],
 tool:[
  ['air-fryer','Air fryer',['air fryer','airfryer','fritadeira eletrica']],
  ['frigideira','Frigideira',['frigideira','skillet','frying pan']],
  ['forno','Forno',['forno','oven']],
  ['panela-pressao','Panela de pressão',['panela de pressao','pressure cooker']]
 ],
 method:[
  ['assar','Assar',['assar','assado','assada','roasting','baking']],
  ['grelhar','Grelhar',['grelhar','grelhado','grelhada','grilling']],
  ['cozinhar','Cozinhar',['cozinhar','cozido','cozida','boiling']],
  ['fritar','Fritar',['fritar','frito','frita','frying']]
 ]
};
export const contextualRuleHash=contextualHash({version:contextualVersion,vocabulary,states:coverageStates,dimensions:dimensionDefinitions,evidence:'literal-captured-caption-or-transcript;visual-candidate;recipe-independent-temporal-v1',role:'typed-inclusion-is-supporting-not-primary-protein',contextualV2:'server-bound-independent-review-and-versioned-source-v2',automatic:false});
const emptyDimension=(dimensionId,state,reason)=>({dimensionId,state,reason});
const validNumber=v=>Number.isFinite(v)&&v>=0;
const captionText=raw=>typeof raw.source_caption==='string'?raw.source_caption:raw.source_caption?.text;
const quoteHas=(quote,term)=>(' '+normalize(quote).replace(/[^\p{L}\p{N}]+/gu,' ')+' ').includes(' '+normalize(term)+' ');
function evidence(raw,input,identity){
 const proofs=[];
 for(const p of list(input).slice(0,8)){
  if(!plain(p)||!['caption','transcript','video'].includes(p.source)||!text(p.excerpt).trim())continue;
  if(typeof p.excerpt!=='string'||p.excerpt.length>2000){proofs.push({source:p.source,sourceKind:p.source,excerpt:'',startSeconds:null,endSeconds:null,state:'invalid',reason:'EVIDENCE_EXCERPT_TOO_LONG',id:contextualHash({identity,reason:'EVIDENCE_EXCERPT_TOO_LONG'})});continue;}
  const excerpt=text(p.excerpt),start=p.start_seconds,end=p.end_seconds;
  let state='invalid',reason='SOURCE_EVIDENCE_MISMATCH';
  if(p.source==='caption'){
   if(!raw.source_caption?.capture_id)state='unknown',reason='CAPTION_CAPTURE_UNAVAILABLE';
   else if(typeof captionText(raw)==='string'&&captionText(raw).includes(excerpt))state='supported',reason='LITERAL_CAPTURED_CAPTION';
  }else if(p.source==='transcript'){
   if(typeof raw.transcript!=='string')state='unknown',reason='TRANSCRIPT_UNAVAILABLE';
   else if(raw.transcript.includes(excerpt)&&validNumber(start)&&validNumber(end)&&end>start&&end<=raw.duration_seconds)state='supported',reason='LITERAL_TRANSCRIPT_WINDOW';
  }else if(validNumber(start)&&validNumber(end)&&end>start&&end<=raw.duration_seconds)state='present_unverified',reason='SAVED_VISUAL_OBSERVATION';
  const proof={source:p.source,sourceKind:p.source,excerpt,startSeconds:validNumber(start)?start:null,endSeconds:validNumber(end)?end:null,state,reason};
  proofs.push({...proof,id:contextualHash({identity,proof})});
 }
 return proofs;
}
function attributeState(proofs){
 if(proofs.some(p=>p.state==='supported'))return 'supported';
 if(proofs.some(p=>p.state==='present_unverified'))return 'present_unverified';
 if(proofs.some(p=>p.state==='unknown'))return 'unknown';
 return proofs.length?'invalid':'not_recorded';
}
function termFor(dimension,field){
 // Only a typed field's complete name/value can map a controlled facet.
 // Free title, tags, summary and transcript keywords never create membership.
 const values=[normalize(field.name),normalize(field.value)];
 return vocabulary[dimension]?.find(([, ,aliases])=>aliases.some(alias=>values.includes(alias)))??null;
}
function safeRole(value,fallback){return roles.has(value)?value:fallback;}
function polarity(field,proofs){
 if(['positive','affirmed','negated','unknown'].includes(field.polarity))return field.polarity==='affirmed'?'positive':field.polarity;
 // A literal negative is not affirmative inclusion. No positive inference is
 // made from an untyped keyword in a source sentence.
 return proofs.some(p=>/\b(nao|sem|not|without|never)\b/.test(normalize(p.excerpt)))?'unknown':'positive';
}
function sourceIdentity(raw,legacy,id){
 if(publicationAvailable(raw))return {kind:'native',reelId:id,analysisKey:raw.analysis_key,analysisGeneration:raw.analysis_generation,qualityPolicyVersion:'historical_baseline',sourceHash:contextualHash({key:raw.analysis_key,generation:raw.analysis_generation})};
 if(preservedContentAvailable(legacy,id))return {kind:'legacy_preserved',reelId:id,recordHash:legacy.provenance.recordHash,sourceSnapshotHash:legacy.provenance.sourceSnapshotHash,qualityPolicyVersion:'historical_baseline',sourceHash:contextualHash({recordHash:legacy.provenance.recordHash,sourceSnapshotHash:legacy.provenance.sourceSnapshotHash})};
 return null;
}
const contexts=new Set(['recipe','technology','health','travel','business','home','general']);
export function projectContextualPublication({video:raw={},legacy=null,item={},qualityVerification=null}={}){
 const id=item.id??raw.id,identity=sourceIdentity(raw,legacy,id);
 if(!identity||!id||item.publication?.available===false)return null;
 const modern=identity.kind==='native',analysis=modern?raw.analysis:legacy.analysis,k=modern&&plain(analysis.knowledge)?analysis.knowledge:null;
 const context={value:contexts.has(k?.context)?k.context:null,state:contexts.has(k?.context)?'supported':modern&&k?'invalid':'unknown',reason:k?'SAVED_PUBLISHED_CONTEXT':'STRUCTURED_CONTEXT_NOT_RECORDED'};
 const attributes=[],validUnits=[],format={dimensionId:'format',value:null,label:null,state:context.value&&context.value!=='recipe'?'not_applicable':'not_recorded',reason:'FORMAT_NOT_RECORDED'};
 let unitCount=null;
 if(modern&&context.value==='recipe'){
  const r=recipeRecurrence(raw);
  if(r.state==='supported'){
   format.value=r.value;format.label=r.label;format.state='supported';format.reason='INDEPENDENT_RECIPE_UNITS_VERIFIED';unitCount=r.unitIds.length;
   for(const u of raw.analysis.taxonomySignals.units)validUnits.push({id:u.id,kind:'recipe',title:text(u.title,160),state:'supported',complete:true,evidence:evidence(raw,u.evidence,identity)});
   attributes.push({id:contextualHash({identity,format:r.value}),dimensionId:'format',dimension:'format',valueId:r.value,label:r.label,state:'supported',role:'central',polarity:'positive',unitIds:r.unitIds,evidence:validUnits.flatMap(u=>u.evidence)});
  }else{
   format.state=r.state==='missing'?'not_recorded':r.state==='notApplicable'?'not_applicable':['TEMPORAL_PROOF_UNAVAILABLE','SOURCE_OR_UNITS_MISSING','INCOMPLETE_OR_UNSUPPORTED_SIGNAL'].includes(r.reason)?'unknown':'invalid';
   format.reason=r.reason??'FORMAT_NOT_RECORDED';
  }
 }
 for(const f of list(k?.fields).slice(0,40)){
  if(!plain(f))continue;
  const dimension=f.kind==='ingredient'&&context.value==='recipe'?'ingredient':f.kind==='tool'?'tool':f.kind==='procedure'&&context.value==='recipe'?'method':null;
  if(!dimension)continue;
  const term=termFor(dimension,f);if(!term)continue;
  const [valueId,label,aliases]=term,proofs=evidence(raw,f.evidence,identity);
  // A typed label alone is not evidence of inclusion. The source quotation must
  // contain the mapped ingredient/tool/method alias, otherwise keep it unverified.
  let state=attributeState(proofs);
  if(state==='supported'&&!proofs.some(p=>p.state==='supported'&&aliases.some(a=>quoteHas(p.excerpt,a))))state='present_unverified';
  const pol=polarity(f,proofs),requestedRole=safeRole(f.role,'supporting'),role=pol==='negated'?'excluded':requestedRole==='central'?'supporting':requestedRole;
  const requestedUnits=list(f.unit_ids??f.unitIds),unitIds=requestedUnits.filter(x=>validUnits.some(u=>u.id===x));
  if(requestedUnits.length!==unitIds.length){state='unknown';unitIds.splice(0);}
  // Only one independently verified unit makes a field's recipe association
  // unambiguous. Multi-unit association always requires explicit unit IDs.
  if(!requestedUnits.length&&unitCount===1)unitIds.push(validUnits[0].id);
  attributes.push({id:contextualHash({identity,dimension,valueId,field:f}),dimensionId:dimension,dimension,valueId,label,state,role,claimedRole:requestedRole,polarity:pol,unitIds:[...new Set(unitIds)],evidence:proofs});
 }
 const v2=modern?normalizeContextualSignalsV2({raw,identity,verification:qualityVerification,makeEvidence:evidence}):null;
 if(v2){
  if(v2.context&&(v2.context.state==='supported'||context.state!=='supported')){
   const prior=context.value;Object.assign(context,v2.context);
   if(prior&&prior!==context.value){
    for(const a of attributes)if(['ingredient','method','format'].includes(a.dimensionId)){a.state='inconclusive';a.reason='CONTEXTUAL_SOURCE_CONTEXT_CONFLICT';a.unitIds=[];}
    validUnits.splice(0);unitCount=null;Object.assign(format,{value:null,label:null,state:context.value==='recipe'?'unknown':'not_applicable',reason:'CONTEXTUAL_SOURCE_CONTEXT_CONFLICT'});
   }
  }
  if(v2.format){Object.assign(format,v2.format);unitCount=v2.independentUnitCount;validUnits.splice(0,validUnits.length,...v2.units);}
  for(const a of v2.attributes)attributes.push({...a,id:contextualHash({identity,attribute:a})});
  if(qualityVerification?.trusted===true&&qualityVerification.policyVersion==='gate_v2')identity.qualityPolicyVersion='gate_v2';
 }
 // Legacy text and model keywords remain visible evidence candidates only;
 // neither is searched to manufacture controlled attributes.
 const coverage=dimensionDefinitions.map(d=>{
  if(d.contexts&&context.value&&!d.contexts.includes(context.value))return emptyDimension(d.id,'not_applicable','OTHER_CONTEXT');
  if(d.id==='format')return {...format};
  const a=attributes.filter(x=>x.dimensionId===d.id);
  const state=coverageStates.find(s=>a.some(x=>x.state===s));
  return emptyDimension(d.id,state??(context.value===null?'unknown':'not_recorded'),a.length?'SAVED_TYPED_ATTRIBUTE':modern?'ATTRIBUTE_NOT_RECORDED':'LEGACY_STRUCTURED_ATTRIBUTE_UNAVAILABLE');
 });
 const proofContentHash=contextualHash({context,format,units:validUnits,attributes,contextualSignals:modern?raw.analysis.contextualSignals??null:null,legacy:modern?null:{claims:legacy.analysis.claims,topics:legacy.analysis.topics,references:legacy.analysis.candidate_relations}});
 return {id,title:text(item.title??analysis.title??raw.title,300),categoryIds:list(item.categoryIds).filter(x=>typeof x==='string'),sourceIdentity:identity,context,format,units:validUnits,independentUnitCount:unitCount,attributes,coverage,contextualSignals:v2?{version:2,receiptTrusted:v2.receiptTrusted,unitCandidates:v2.unitCandidates}:null,legacyEvidence:modern?null:{claims:list(legacy.analysis.claims).length,references:list(legacy.analysis.candidate_relations).length,topics:list(legacy.analysis.topics).length,state:'present_unverified'},proofContentHash,indexVersion:contextualVersion,ruleHash:contextualRuleHash,fingerprint:contextualHash({identity,proofContentHash,ruleHash:contextualRuleHash,categories:item.categoryIds,manual:item.categoryOverride??null})};
}
