import {semanticCalibrationReceiptValid,semanticDefinitionHash} from './reels-semantic-calibration.mjs';
import {semanticHash,semanticContexts,semanticGroupKinds} from './reels-semantic-source.mjs';
export const semanticContractVersion='semantic-curator-contract-v1';
const text=(x,max=3000)=>typeof x==='string'&&x.trim()&&x.length<=max;
const list=x=>Array.isArray(x)?x:[];
const fail=code=>{throw Object.assign(Error('Resposta da curadoria requer conferência; nenhuma inferência será repetida.'),{code,paidResponseReceived:true});};
export function validateSemanticOutput(output,sources,catalogue={groups:[]}){
 if(!output||output.version!==1||!Array.isArray(output.profiles)||!Array.isArray(output.groups)||output.groups.length>24||JSON.stringify(output).length>800000)fail('SEMANTIC_RESPONSE_INVALID');
 const sourceById=new Map(sources.map(s=>[s.id,s])),profiles=[],byId=new Map(),groups=[];
 const proof=(p,source)=>{
  const field=source.fields.find(f=>f.fieldPath===p?.fieldPath);
  if(!field||!text(p.excerpt,1600)||!field.text.includes(p.excerpt))fail('SEMANTIC_EVIDENCE_NOT_IN_SAVED_SOURCE');
  return {source:field.source,sourceIdentity:field.sourceIdentity,fieldPath:field.fieldPath,excerpt:p.excerpt,anchorHash:semanticHash({identity:source.sourceIdentity,path:field.fieldPath,excerpt:p.excerpt}),verification:'literal_source_anchor_semantic_proposal'};
 };
 const proofs=(p,s)=>{if(!Array.isArray(p)||!p.length||p.length>8)fail('SEMANTIC_EVIDENCE_REQUIRED');return p.map(v=>proof(v,s));};
 for(const p of output.profiles){
  const source=sourceById.get(p?.reelId);
  if(!source||byId.has(p.reelId)||!semanticContexts.includes(p.context)||!['proposed','unknown','inconclusive'].includes(p.state)||!text(p.reason)||!Array.isArray(p.units)||p.units.length>32)fail('SEMANTIC_PROFILE_INVALID');
  const unitIds=new Set(),usedQuotes=new Set(),units=p.units.map(u=>{
   if(!/^[A-Za-z0-9_-]{1,80}$/.test(u?.unitId??'')||unitIds.has(u.unitId)||!['recipe','concept','place','other'].includes(u.type)||!['complete','partial','unknown'].includes(u.completeness))fail('SEMANTIC_UNIT_INVALID');
   unitIds.add(u.unitId);const evidence=proofs(u.evidence,source);
   if(u.type==='recipe'&&u.completeness==='complete')for(const e of evidence){const key=e.fieldPath+':'+e.excerpt;if(usedQuotes.has(key))fail('SEMANTIC_RECIPE_UNITS_SHARE_PROOF');usedQuotes.add(key);}
   return {unitId:u.unitId,type:u.type,completeness:u.completeness,evidence};
  });
  const entry={reelId:p.reelId,context:p.context,state:p.state,reason:p.reason,units,sourceIdentity:source.sourceIdentity,semanticProofHash:source.semanticProofHash,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash,manualProtected:source.editorial.manual,truncated:source.truncated,truncationReasons:source.truncationReasons??[],semanticVerification:'model_inference_source_anchored_not_independent_accuracy_measurement'};
  profiles.push(entry);byId.set(p.reelId,entry);
 }
 if(byId.size!==sourceById.size)fail('SEMANTIC_PROFILE_COVERAGE_INCOMPLETE');
 const seen=new Set(),known=new Map(list(catalogue.groups).map(g=>[g.id,g]));
 for(const g of output.groups){
  if(!/^[a-z][a-z0-9_-]{2,80}$/.test(g?.key??'')||!text(g.name,120)||!text(g.definition,2400)||!semanticContexts.includes(g.context)||!semanticGroupKinds.includes(g.kind)||!Array.isArray(g.members)||!g.members.length||g.members.length>sources.length||!list(g.positiveCriteria).length||!list(g.negativeCriteria).length||[...list(g.aliases),...list(g.positiveCriteria),...list(g.negativeCriteria)].some(v=>!text(v,500)))fail('SEMANTIC_GROUP_INVALID');
  if(g.kind==='format'&&(g.context!=='recipe'||!['single_recipe','recipe_collection'].includes(g.key)))fail('SEMANTIC_FORMAT_NOT_CANONICAL');
  if(g.kind==='facet'&&!['ingredient','tool','method','place','purpose','other'].includes(g.dimension))fail('SEMANTIC_FACET_INVALID');
  if(g.dimension==='ingredient'&&g.kind!=='facet')fail('SEMANTIC_INGREDIENT_IS_FACET');
  const existing=g.existingGroupId?known.get(g.existingGroupId):null;
  if(g.existingGroupId&&(!existing||existing.context!==g.context||existing.kind!==g.kind||(existing.dimension??null)!==(g.dimension??null)))fail('SEMANTIC_EXISTING_GROUP_INCOMPATIBLE');
  const id=existing?.id??semanticHash({version:semanticContractVersion,context:g.context,kind:g.kind,dimension:g.dimension??null,key:g.key});
  if(seen.has(id))fail('SEMANTIC_DUPLICATE_GROUP');seen.add(id);
  const memberIds=new Set(),members=g.members.map(m=>{
   const source=sourceById.get(m?.reelId),profile=byId.get(m?.reelId);
   if(!source||memberIds.has(m.reelId)||!['central','supporting','mentioned','unknown'].includes(m.role)||!Array.isArray(m.unitIds)||m.unitIds.some(id=>!profile.units.some(u=>u.unitId===id))||profile.state!=='proposed'||g.context!==profile.context&&g.kind!=='facet')fail('SEMANTIC_MEMBERSHIP_INVALID');
   memberIds.add(m.reelId);const evidence=proofs(m.evidence,source);
   for(const id of m.unitIds)if(!evidence.some(e=>profile.units.find(u=>u.unitId===id).evidence.some(up=>up.fieldPath===e.fieldPath&&up.excerpt===e.excerpt)))fail('SEMANTIC_UNIT_MEMBERSHIP_UNBOUND');
   if(g.kind==='format'){const complete=profile.units.filter(u=>u.type==='recipe'&&u.completeness==='complete');if(m.unitIds.length!==complete.length||complete.some(u=>!m.unitIds.includes(u.unitId)))fail('SEMANTIC_FORMAT_RELEVANT_UNITS_REQUIRED');const n=complete.length;if(g.key==='single_recipe'?n!==1:n<2)fail('SEMANTIC_FORMAT_UNIT_COUNT_INVALID');}
   return {id:source.id,title:source.title,sourceIdentity:source.sourceIdentity,semanticProofHash:source.semanticProofHash,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash,manualProtected:source.editorial.manual,role:m.role,unitIds:[...new Set(m.unitIds)],evidence};
  });
  const negativeExamples=list(g.negativeExamples).map(n=>{const source=sourceById.get(n?.reelId);if(!source||memberIds.has(n.reelId)||!text(n.reason,1000))fail('SEMANTIC_NEGATIVE_EXAMPLE_INVALID');return {id:n.reelId,reason:n.reason,evidence:proofs(n.evidence,source),semanticProofHash:source.semanticProofHash,sourceIdentity:source.sourceIdentity,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash};});
  const aliasKey=v=>v.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
  const aliases=[...new Set([g.name,...list(g.aliases)].map(aliasKey))];
  const possibleDuplicates=list(catalogue.groups).filter(k=>k.id!==id&&k.context===g.context&&k.kind===g.kind&&[k.name,...list(k.aliases)].some(a=>aliases.includes(aliasKey(a)))).map(k=>k.id);
  groups.push({id,key:existing?.key??g.key,name:existing?.name??g.name,context:g.context,parentId:existing?.parentId??({recipe:'receitas',technology:'group-tecnologia',health:'group-saude',travel:'group-viagens',business:'group-trabalho',home:'group-casa',general:'group-outros'}[g.context]),kind:g.kind,dimension:g.dimension??null,definition:existing?.definition??g.definition,aliases:[...new Set([...(existing?.aliases??[]),...list(g.aliases)])],positiveCriteria:existing?.positiveCriteria??g.positiveCriteria,negativeCriteria:existing?.negativeCriteria??g.negativeCriteria,members,negativeExamples,possibleDuplicates,status:'candidate',reason:possibleDuplicates.length?'POSSIBLE_SEMANTIC_DUPLICATE_REVIEW_REQUIRED':'SEMANTIC_MODEL_PROPOSAL_SOURCE_ANCHORED',semanticVerification:'model_inference_source_anchored_not_independent_accuracy_measurement'});
 }
 return {version:1,profiles,groups};
}
export function automaticSemanticPromotion(group,policy,{promptHash}={}){
 const c=policy.calibrationReceipt,metrics=c?.holdout;
 if(group.verification?.status!=='supported'||group.verification?.independentPhase!==true||group.verification?.promptHash!==promptHash)return {allowed:false,reason:'INDEPENDENT_PROPOSITION_VERIFICATION_REQUIRED'};
 if(policy.autoPromotionEnabled!==true)return {allowed:false,reason:'AUTOMATIC_PROMOTION_DISABLED'};
 if(!semanticCalibrationReceiptValid(c)||!c.definitionHashes.includes(semanticDefinitionHash(group))||c.version!==1||c.verdict!=='accepted'||c.model!==policy.model||c.verifierModel!==policy.verifierModel||c.promptHash!==promptHash||c.policyVersion!==policy.version||c.reviewerKind!=='independent_source_review'||!text(c.reviewId,200)||!/^[a-f0-9]{64}$/.test(c.evaluationHash??'')||!/^[a-f0-9]{64}$/.test(c.trainingSourceHash??'')||!/^[a-f0-9]{64}$/.test(c.holdoutSourceHash??'')||c.trainingSourceHash===c.holdoutSourceHash||![metrics?.tp,metrics?.fp,metrics?.fn,metrics?.tn].every(v=>Number.isSafeInteger(v)&&v>=0))return {allowed:false,reason:'CALIBRATION_RECEIPT_UNVERIFIED'};
 const total=metrics.tp+metrics.fp+metrics.fn+metrics.tn,positive=metrics.tp+metrics.fp,precision=positive?metrics.tp/positive:0,minPrecision=c.minimumPrecision;
 if(!Number.isFinite(minPrecision)||minPrecision<0.9||minPrecision>1||total<20||metrics.tp<5||metrics.tn<5||precision<minPrecision||!list(c.contexts).includes(group.context)||!list(c.kinds).includes(group.kind))return {allowed:false,reason:'CALIBRATION_SCOPE_OR_METRICS_INSUFFICIENT'};
 if(group.protected||group.manual||group.possibleDuplicates?.length||group.members.some(m=>m.manualProtected)||new Set(group.members.filter(m=>m.role!=='mentioned'&&m.role!=='unknown').map(m=>m.id)).size<policy.minUniqueMembers||!group.negativeExamples.length)return {allowed:false,reason:'GROUP_NOT_ELIGIBLE_FOR_CALIBRATED_PROMOTION'};
 return {allowed:true,reason:'CALIBRATED_POLICY_AND_SOURCE_BOUND_SUPPORT',calibrationReviewId:c.reviewId,precision,holdoutCount:total};
}
