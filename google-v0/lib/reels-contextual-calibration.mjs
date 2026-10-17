import {createHash} from 'node:crypto';
import {projectContextualPublication,contextualHash,contextualRuleHash} from './reels-contextual-projection.mjs';
import {reelIdPattern} from './reels-model.mjs';
const list=v=>Array.isArray(v)?v:[];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const str=v=>typeof v==='string'&&v.length>0;
const hashPattern=/^[a-f0-9]{64}$/;
const normal=v=>String(v??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').replace(/\s+/g,' ').trim();
const hasTerm=(quote,term)=>(' '+normal(quote).replace(/[^\p{L}\p{N}]+/gu,' ')+' ').includes(' '+normal(term)+' ');
const fail=code=>{throw Object.assign(Error('Não foi possível preparar a calibração das fontes salvas.'),{code,status:409});};
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const ruleDefinitions=[
 ['frango','Frango',['frango','peito de frango','file de frango','coxa de frango','sobrecoxa de frango','chicken','chicken breast']],
 ['ovo','Ovo',['ovo','ovos','egg','eggs']],
 ['peixe','Peixe',['peixe','fish']],
 ['carne-bovina','Carne bovina',['carne bovina','carne de boi','beef']]
];
export const contextualCalibrationPolicy=Object.freeze({
 version:'ingredient-any-finite-v1',scope:'finite_corpus_only',parentCategoryId:'receitas',
 implementationIdentity:'/root/alignment_backend',maxGroups:3,minMembers:3,
 minTrainPositive:2,minTrainNegative:2,minHoldoutPositive:2,minHoldoutNegative:2,
 minEmpiricalPrecision:1,minRecall:0.5,maxFalsePositives:0,
 generalizationAllowed:false,unseenAutomaticMembership:false,
 rules:Object.freeze(ruleDefinitions.map(([valueId,name,aliases])=>Object.freeze({ruleId:'recipe-ingredient-'+valueId+'-any-v1',valueId,dimension:'ingredient',name,label:'Receitas com '+name+' (em ao menos um preparo)',aliases:Object.freeze(aliases)})))
});
export const contextualCalibrationPolicyHash=contextualHash({policy:contextualCalibrationPolicy,projectionRule:contextualRuleHash});
const sameIdentity=(a,b)=>a?.kind===b?.kind&&(a.kind==='native'?a.analysisKey===b.analysisKey&&String(a.analysisGeneration)===String(b.analysisGeneration):a.kind==='legacy_preserved'&&a.recordHash===b.recordHash&&a.sourceSnapshotHash===b.sourceSnapshotHash);
const validTime=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function sourceText(record,kind){
 if(kind==='caption')return record.source.video?.source_caption?.text;
 if(kind==='transcript')return record.source.video?.transcript??record.source.legacy?.transcript;
 if(kind==='saved_analysis')return JSON.stringify(record.source.video?.analysis??record.source.legacy?.analysis??{});
 return null;
}
function sourceAnchorIdentity(record,kind){
 const v=record.source.video,l=record.source.legacy;
 if(kind==='caption')return v?.source_caption?.capture_id??null;
 if(kind==='transcript')return v?.transcript_key&&v?.transcript_generation?v.transcript_key+'@'+v.transcript_generation:l?.provenance?.recordHash?'legacy:'+l.provenance.recordHash:null;
 if(kind==='saved_analysis')return record.entry.sourceIdentity.kind==='native'?record.entry.sourceIdentity.analysisKey+'@'+record.entry.sourceIdentity.analysisGeneration:record.entry.sourceIdentity.recordHash;
 return null;
}
function buildCorpus(input){
 if(!object(input)||input.schemaVersion!==1||!validTime(input.observedAt)||!Array.isArray(input.catalog)||!input.catalog.length||input.catalog.length>20000||!Array.isArray(input.records)||!input.records.length||input.records.length>40)fail('CALIBRATION_INPUT_INVALID');
 const catalog=new Map();
 for(const c of input.catalog){
  if(!reelIdPattern.test(c?.id??'')||catalog.has(c.id)||c.publicationAvailable!==true||typeof c.manual!=='boolean'||!Array.isArray(c.categoryIds)||!validTime(c.updateTime)||!['native','legacy_preserved'].includes(c.sourceIdentity?.kind))fail('CALIBRATION_CATALOG_INVALID');
  catalog.set(c.id,c);
 }
 const records=new Map();
 for(const r of input.records){
  if(!str(r?.sourceJson)||r.sourceJson.length>250000||!hashPattern.test(r.sourceSnapshotHash??'')||digest(r.sourceJson)!==r.sourceSnapshotHash)fail('CALIBRATION_SOURCE_HASH_MISMATCH');
  let source;try{source=JSON.parse(r.sourceJson);}catch{fail('CALIBRATION_SOURCE_JSON_INVALID');}
  if(!object(source)||Object.keys(source).some(k=>!['item','video','legacy','sourceUpdateTime'].includes(k)))fail('CALIBRATION_SOURCE_FIELDS_INVALID');
  const id=source.item?.id,c=catalog.get(id);
  if(!c||records.has(id))fail('CALIBRATION_SOURCE_ID_INVALID');
  if(source.video?.id&&source.video.id!==id||source.legacy?.reelId&&source.legacy.reelId!==id)fail('CALIBRATION_SOURCE_ID_MISMATCH');
  const actualManual=source.video?.taxonomy_override?.manual===true||source.item?.categoryOverride?.manual===true||source.item?.categoryResolution?.mode==='manual';
  if(actualManual&&!c.manual)fail('CALIBRATION_MANUAL_METADATA_MISMATCH');
  const item={...source.item,id,categoryIds:c.categoryIds,categoryOverride:{...(source.item?.categoryOverride??{}),manual:c.manual},publication:{...(source.item?.publication??{}),available:true,...(c.sourceIdentity.kind==='legacy_preserved'?{source:'legacy_preserved'}:{})}};
  const entry=projectContextualPublication({video:source.video??{},legacy:source.legacy??null,item});
  if(!entry||!sameIdentity(entry.sourceIdentity,c.sourceIdentity))fail('CALIBRATION_PUBLICATION_BINDING_MISMATCH');
  records.set(id,{id,source,entry,catalog:c,sourceSnapshotHash:r.sourceSnapshotHash,publicationProofHash:entry.sourceProofHash??entry.proofContentHash,manual:c.manual});
 }
 const bindings=[...records.values()].map(r=>({reelId:r.id,sourceSnapshotHash:r.sourceSnapshotHash,publicationProofHash:r.publicationProofHash,sourceIdentity:r.entry.sourceIdentity,sourceUpdateTime:r.source.sourceUpdateTime??null,catalogUpdateTime:r.catalog.updateTime,manual:r.manual})).sort((a,b)=>a.reelId.localeCompare(b.reelId));
 return {records,catalog,bindings,sourceCorpusHash:contextualHash(bindings),catalogHash:contextualHash([...catalog.values()].sort((a,b)=>a.id.localeCompare(b.id)))};
}
function sourcePredicate(record,rule){
 if(record.manual)return {state:'excluded',reason:'MANUAL_CURATION_PROTECTED',attributes:[],evidenceIds:[]};
 if(record.entry.context.value!=='recipe')return {state:'abstain',reason:'RECIPE_CONTEXT_NOT_SUPPORTED',attributes:[],evidenceIds:[]};
 const attrs=record.entry.attributes.filter(a=>a.dimensionId==='ingredient'&&a.valueId===rule.valueId&&a.state==='supported'&&['central','supporting'].includes(a.role)&&['positive','affirmed'].includes(a.polarity));
 const proofs=attrs.flatMap(a=>a.evidence).filter(p=>p.state==='supported'&&['caption','transcript'].includes(p.source)&&rule.aliases.some(alias=>hasTerm(p.excerpt,alias))&&!/\b(nao|sem|not|without|never)\b/.test(normal(p.excerpt)));
 if(!proofs.length)return {state:'abstain',reason:'POSITIVE_TYPED_LITERAL_INCLUSION_NOT_PROVEN',attributes:[],evidenceIds:[]};
 return {state:'positive',reason:'TYPED_RECIPE_INGREDIENT_LITERAL_ANY',attributes:attrs.map(a=>a.id),evidenceIds:[...new Set(proofs.map(p=>p.id))]};
}
function splitAndAnnotations(input,corpus){
 const split=input.splitManifest;
 if(!object(split)||!validTime(split.lockedAt)||split.predictionsUnseen!==true||!Array.isArray(split.trainIds)||!Array.isArray(split.holdoutIds)||!split.trainIds.length||!split.holdoutIds.length)fail('CALIBRATION_SPLIT_INVALID');
 const train=new Set(split.trainIds),holdout=new Set(split.holdoutIds);
 if(train.size!==split.trainIds.length||holdout.size!==split.holdoutIds.length||[...train].some(id=>holdout.has(id)))fail('CALIBRATION_HOLDOUT_LEAKAGE');
 if([...train,...holdout].some(id=>!corpus.records.has(id)))fail('CALIBRATION_SPLIT_SOURCE_MISMATCH');
 if(!Array.isArray(input.annotations)||input.annotations.length>1000)fail('CALIBRATION_ANNOTATIONS_INVALID');
 const annotations=new Map(),allowed=new Set(contextualCalibrationPolicy.rules.map(r=>r.ruleId));
 for(const a of input.annotations){
  const r=corpus.records.get(a?.reelId),annotator=a?.annotator;
  if(!r||!allowed.has(a.ruleId)||!['positive','negative','unknown','not_applicable'].includes(a.label)||!str(a.reason)||!validTime(a.reviewedAt)||Date.parse(a.reviewedAt)<Date.parse(split.lockedAt))fail('CALIBRATION_ANNOTATION_INVALID');
  if(a.sourceSnapshotHash!==r.sourceSnapshotHash)fail('CALIBRATION_ANNOTATION_SOURCE_MISMATCH');
  if(!object(annotator)||annotator.kind!=='independent_source_review'||!str(annotator.identity)||annotator.identity===contextualCalibrationPolicy.implementationIdentity||annotator.predictionsSeen!==false)fail('CALIBRATION_SELF_ANNOTATION_OR_LEAKAGE');
  const key=a.reelId+':'+a.ruleId;if(annotations.has(key))fail('CALIBRATION_DUPLICATE_ANNOTATION');
  const anchors=list(a.anchors);
  if(['positive','negative','not_applicable'].includes(a.label)&&!anchors.length)fail('CALIBRATION_ANNOTATION_ANCHOR_MISSING');
  for(const anchor of anchors){
   const source=sourceText(r,anchor?.sourceKind),expected=sourceAnchorIdentity(r,anchor?.sourceKind);
   if(!expected||expected!==anchor.sourceIdentity||!str(anchor.excerpt)||anchor.excerpt.length>2000||typeof source!=='string'||!source.includes(anchor.excerpt))fail('CALIBRATION_ANNOTATION_ANCHOR_MISMATCH');
  }
  if(a.label==='positive'&&!anchors.some(x=>['caption','transcript'].includes(x.sourceKind)))fail('CALIBRATION_POSITIVE_ORIGINAL_SOURCE_MISSING');
  annotations.set(key,a);
 }
 return {train,holdout,annotations,splitHash:contextualHash({trainIds:[...train].sort(),holdoutIds:[...holdout].sort(),lockedAt:split.lockedAt,predictionsUnseen:true,sourceCorpusHash:corpus.sourceCorpusHash}),annotationsHash:contextualHash([...annotations.values()].sort((a,b)=>(a.reelId+':'+a.ruleId).localeCompare(b.reelId+':'+b.ruleId)))};
}
export function wilsonPrecisionInterval(tp,fp){
 const n=tp+fp;if(!n)return null;
 const z=1.959963984540054,p=tp/n,den=1+z*z/n,mid=(p+z*z/(2*n))/den,delta=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
 return {lower:Math.max(0,mid-delta),upper:Math.min(1,mid+delta),confidence:0.95,denominator:n,interpretation:'descriptive_sample_interval_not_unseen_certification'};
}
function measure(ids,rule,corpus,annotations){
 const m={total:ids.size,labeled:0,knownPositive:0,knownNegative:0,tp:0,fp:0,tn:0,fn:0,abstainPositive:0,abstainNegative:0,abstainUnknown:0,unlabeled:0,excluded:0,predictedPositive:0,unknownPositivePrediction:0};
 for(const id of ids){
  const a=annotations.get(id+':'+rule.ruleId),prediction=sourcePredicate(corpus.records.get(id),rule);
  if(prediction.state==='excluded'){m.excluded++;continue;}
  if(!a){m.unlabeled++;continue;}m.labeled++;
  if(a.label==='unknown'){if(prediction.state==='positive')m.unknownPositivePrediction++;else m.abstainUnknown++;continue;}
  const positive=a.label==='positive';if(positive)m.knownPositive++;else m.knownNegative++;
  if(prediction.state==='positive'){m.predictedPositive++;if(positive)m.tp++;else m.fp++;}
  else if(positive)m.abstainPositive++;else m.abstainNegative++;
 }
 m.abstained=m.abstainPositive+m.abstainNegative+m.abstainUnknown;
 m.precision=m.tp+m.fp?m.tp/(m.tp+m.fp):null;
 m.recall=m.knownPositive?m.tp/m.knownPositive:null;
 m.coverage=m.knownPositive+m.knownNegative?(m.tp+m.fp+m.tn+m.fn)/(m.knownPositive+m.knownNegative):null;
 m.precisionInterval95=wilsonPrecisionInterval(m.tp,m.fp);
 return m;
}
function runCalibration(input){
 const corpus=buildCorpus(input),labels=splitAndAnnotations(input,corpus),p=contextualCalibrationPolicy,rules=[];
 for(const rule of p.rules){
  const train=measure(labels.train,rule,corpus,labels.annotations),holdout=measure(labels.holdout,rule,corpus,labels.annotations),reasons=[];
  if(train.knownPositive<p.minTrainPositive||train.knownNegative<p.minTrainNegative)reasons.push('TRAIN_POSITIVE_OR_NEGATIVE_SAMPLE_INSUFFICIENT');
  if(holdout.knownPositive<p.minHoldoutPositive||holdout.knownNegative<p.minHoldoutNegative)reasons.push('HOLDOUT_POSITIVE_OR_NEGATIVE_SAMPLE_INSUFFICIENT');
  if(train.fp||holdout.fp)reasons.push('FALSE_POSITIVE_OBSERVED');
  if(train.precision!==p.minEmpiricalPrecision||holdout.precision!==p.minEmpiricalPrecision)reasons.push('EMPIRICAL_PRECISION_TARGET_NOT_MET');
  if(train.recall===null||holdout.recall===null||train.recall<p.minRecall||holdout.recall<p.minRecall)reasons.push('RECALL_OR_SOURCE_COVERAGE_INSUFFICIENT');
  if(train.unknownPositivePrediction||holdout.unknownPositivePrediction)reasons.push('POSITIVE_PREDICTION_REQUIRES_ADJUDICATION');
  const members=[],withheld=[];
  for(const r of corpus.records.values()){
   const prediction=sourcePredicate(r,rule),a=labels.annotations.get(r.id+':'+rule.ruleId);
   if(prediction.state!=='positive')continue;
   if(a?.label==='positive')members.push({id:r.id,title:r.entry.title,sourceIdentity:r.entry.sourceIdentity,sourceSnapshotHash:r.sourceSnapshotHash,publicationProofHash:r.publicationProofHash,evidenceIds:prediction.evidenceIds,attributeIds:prediction.attributes,annotationHash:contextualHash(a),sourceUpdateTime:r.source.sourceUpdateTime??null,catalogUpdateTime:r.catalog.updateTime,priorCategoryIds:r.catalog.categoryIds});
   else withheld.push({id:r.id,reason:!a?'NO_INDEPENDENT_ANNOTATION':a.label==='unknown'?'ANNOTATION_UNRESOLVED':'ANNOTATED_NOT_A_MEMBER'});
  }
  members.sort((a,b)=>a.id.localeCompare(b.id));withheld.sort((a,b)=>a.id.localeCompare(b.id));
  if(members.length<p.minMembers)reasons.push('FINITE_REVIEWED_SUPPORT_INSUFFICIENT');
  const insufficient=reasons.some(x=>x.includes('INSUFFICIENT')),status=!reasons.length?'calibrated':insufficient?'insufficient':'candidate';
  rules.push({ruleId:rule.ruleId,parentCategoryId:p.parentCategoryId,dimension:'ingredient',valueId:rule.valueId,label:rule.label,status,reasonCodes:reasons,supportCount:members.length,reviewedMemberCount:members.length,sourceCount:corpus.records.size,memberIds:members.map(m=>m.id),members,withheld,train,holdout,filter:{category:p.parentCategoryId,facets:[{dimension:'ingredient',value:rule.valueId,quantifier:'ANY'}]},calibrationScope:p.scope,generalizationAllowed:false,automaticUnseen:false});
 }
 const report={version:p.version,policyHash:contextualCalibrationPolicyHash,projectionRuleHash:contextualRuleHash,status:rules.some(r=>r.status==='calibrated')?'calibrated':rules.every(r=>r.status==='insufficient')?'insufficient':'candidate',scope:p.scope,generalizationAllowed:false,automaticUnseen:false,observedAt:input.observedAt,corpus:{inventoryCount:corpus.catalog.size,evaluatedCount:corpus.records.size,unevaluatedCount:corpus.catalog.size-corpus.records.size,sourceCorpusHash:corpus.sourceCorpusHash,catalogHash:corpus.catalogHash},annotationsHash:labels.annotationsHash,splitHash:labels.splitHash,sourceBindings:corpus.bindings,rules,limitations:['Calibration concerns the exact saved-source cohort and independently annotated finite members only.','Sample intervals do not certify unseen precision, independence of Reels or whole-video semantic quality.','Unobserved or unlabeled members are unknown, never negative by absence.','Ingredient ANY means inclusion in at least one preparation; no centrality, whole collection focus, practicality or complete enumeration is inferred.','Manual edits and suppressed rules take precedence; no source analysis is rewritten.']};
 report.reportHash=contextualHash(report);
 return {report,corpus};
}
export function calibrateContextualPolicy(input){return runCalibration(input).report;}
const groupIdentity=rule=>contextualHash({kind:'calibrated_ingredient_any',parentCategoryId:rule.parentCategoryId,valueId:rule.valueId,quantifier:'ANY'});
export function prepareContextualCategoryPlan(input){
 const {report,corpus}=runCalibration(input),wrapper=input.taxonomy,t=wrapper?.data;
 if(!object(t)||!Number.isSafeInteger(t.revision)||!validTime(wrapper.updateTime)||!Array.isArray(t.nodes)||!Array.isArray(t.rules??[])||t.pendingOperationId)fail('CALIBRATION_TAXONOMY_PRECONDITION_INVALID');
 const groups=[],suppressed=[];
 for(const rule of report.rules.filter(r=>r.status==='calibrated')){
  const identity=groupIdentity(rule),categoryId='ctx_'+identity.slice(0,28),ruleId='cal_'+identity.slice(0,32),parent=t.nodes.find(n=>n.id===rule.parentCategoryId),node=t.nodes.find(n=>n.id===categoryId),existingRule=list(t.rules).find(r=>r.id===ruleId||r.kind==='calibrated_ingredient_any'&&r.parentCategoryId===rule.parentCategoryId&&r.valueId===rule.valueId);
  let reason=!parent?'PARENT_CATEGORY_MISSING':existingRule?.enabled===false?'RULE_SUPPRESSED':node?.manual===true?'MANUAL_NODE_PROTECTED':node&&node.parentId!==rule.parentCategoryId?'NODE_PARENT_CHANGED':list(t.nodes).some(n=>n.id!==categoryId&&n.parentId===rule.parentCategoryId&&normal(n.name)===normal(rule.label))?'EXISTING_EDITORIAL_CATEGORY_PROTECTED':null;
  if(list(t.suppressed).some(x=>x===ruleId||x===categoryId||x?.ruleId===ruleId||x?.valueId===rule.valueId&&x?.dimension==='ingredient'))reason='EXPLICIT_SUPPRESSION';
  if(groups.length>=contextualCalibrationPolicy.maxGroups)reason='FINITE_GROUP_LIMIT';
  const manualIds=new Set(list(t.assignments).filter(a=>a.manual===true).map(a=>a.reelId));
  const members=rule.members.filter(m=>!corpus.catalog.get(m.id).manual&&!manualIds.has(m.id));
  if(members.length<contextualCalibrationPolicy.minMembers)reason='MANUAL_PROTECTION_REDUCES_FINITE_SUPPORT';
  if(reason){suppressed.push({ruleId:rule.ruleId,categoryId,reason});continue;}
  groups.push({id:ruleId,calibrationRuleId:rule.ruleId,categoryId,parentCategoryId:rule.parentCategoryId,label:node?.name??rule.label,nodeAction:node?'retain':'create',members:members.map(m=>({...m,categoryIds:[...new Set([...m.priorCategoryIds,categoryId])]})),rule:{id:ruleId,kind:'calibrated_ingredient_any',version:1,enabled:true,categoryId,parentCategoryId:rule.parentCategoryId,dimension:'ingredient',valueId:rule.valueId,quantifier:'ANY',scope:'finite_corpus_only',policyVersion:report.version,policyHash:report.policyHash,calibrationReportHash:report.reportHash,sourceCorpusHash:report.corpus.sourceCorpusHash,memberIds:members.map(m=>m.id),generalizationAllowed:false}});
 }
 const plan={schemaVersion:1,kind:'finite_contextual_category_plan',status:groups.length?'ready_for_independent_review':'no_eligible_group',scope:'finite_corpus_only',automaticUnseen:false,policyVersion:report.version,policyHash:report.policyHash,calibrationReportHash:report.reportHash,sourceCorpusHash:report.corpus.sourceCorpusHash,annotationsHash:report.annotationsHash,splitHash:report.splitHash,preconditions:{taxonomyRevision:t.revision,taxonomyUpdateTime:wrapper.updateTime,taxonomyContentHash:contextualHash(t),catalogHash:report.corpus.catalogHash,pendingOperationAbsent:true,sourceBindings:report.sourceBindings},groups,suppressed,affectedIds:[...new Set(groups.flatMap(g=>g.members.map(m=>m.id)))].sort(),operations:'additive_metadata_only',sourceAnalysisWrites:false,providerCalls:false,processingStarted:false,approvedForApply:false};
 plan.planHash=contextualHash(plan);return {calibration:report,plan};
}
