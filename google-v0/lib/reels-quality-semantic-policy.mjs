import {createHash} from 'node:crypto';
export const semanticQualityPolicyVersion='source-propositions-v1';
const list=v=>Array.isArray(v)?v:[];
const present=v=>typeof v==='string'&&v.trim().length>0;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const contextualPropositionHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function contextualPropositionEntries(report={}){
 const signals=report.contextualSignals,entries=[];
 if(!signals)return entries;
 if(signals.primaryContext)entries.push({kind:'primaryContext',fieldPath:'contextualSignals.primaryContext',proposition:signals.primaryContext});
 for(const [index,proposition]of list(signals.units).entries())entries.push({kind:'unit',fieldPath:'contextualSignals.units.'+index,proposition});
 for(const [index,proposition]of list(signals.attributes).entries())entries.push({kind:'attribute',fieldPath:'contextualSignals.attributes.'+index,proposition});
 return entries.map(e=>({...e,propositionHash:contextualPropositionHash(e.proposition)}));
}
// Literal presence certifies attribution only. A partial noun extracted from a
// negated clause does not certify a positive statement or an ingredient role.
export function literalClaimSupport(value,excerpt){
 const norm=v=>String(v??'').normalize('NFC').replace(/\s+/g,' ').trim();
 const claim=norm(value),source=norm(excerpt),index=source.indexOf(claim);
 if(!claim||index<0)return 'unverified';
 const prefix=source.slice(0,index).split(/[.!?;:\n]/u).at(-1).trim().split(/\s+/u).slice(-5).join(' ');
 if(/\b(?:não|nunca|sem|evite|not|without|never|no)\b/iu.test(prefix))return 'negated_context';
 return 'literal';
}
function receiptFor(entry,reviews,reportHash,sourceManifestHash){
 return list(reviews).find(r=>r&&r.fieldPath===entry.fieldPath&&r.propositionHash===entry.propositionHash&&r.reportHash===reportHash&&r.sourceManifestHash===sourceManifestHash&&r.policyVersion===semanticQualityPolicyVersion&&['human_source_review','independent_source_review'].includes(r.kind)&&present(r.receiptId)&&present(r.method)&&present(r.observedAt)&&Number.isFinite(Date.parse(r.observedAt)));
}
export function evaluateContextualPropositions({report={},reportHash,sourceManifestHash,contextualEvidence=[],trustedReviews=[]}={}){
 const evidence=new Map(list(contextualEvidence).map(e=>[e.id,e])),result={policyVersion:semanticQualityPolicyVersion,attributes:[],units:[],primaryContext:null};
 for(const entry of contextualPropositionEntries(report)){
  const p=entry.proposition,refs=list(p?.evidenceRefs),proofs=refs.map(id=>evidence.get(id)),review=receiptFor(entry,trustedReviews,reportHash,sourceManifestHash);
  let state='present_unverified',reason='A presença de citação não comprova esta proposição, papel, unidade ou finalidade.';
  if(!p||!refs.length||new Set(refs).size!==refs.length||proofs.some(e=>!e||e.state==='invalid')){state='invalid';reason='Referência ausente, duplicada ou inválida na proposição.';}
  else if(entry.kind==='attribute'&&['not_recorded','not_applicable','unknown','inconclusive','invalid'].includes(p.state)){state=p.state;reason=present(p.reason)?p.reason:'Estado candidato sem razão verificável; excluído do suporte automático.';}
  else if(review?.verdict==='invalid'||review?.verdict==='inconclusive'){state=review.verdict;reason=present(review.reason)?review.reason:'Revisão independente rejeitou ou não confirmou a proposição.';}
  else if(review?.verdict==='supported'&&proofs.some(e=>e.state!=='supported')){state='inconclusive';reason='Proposição revisada sem prova de fonte suficiente; janela visual não equivale a pixels verificados.';}
  else if(review?.verdict==='supported'){
   const completeRecipe=entry.kind==='unit'&&p.type==='recipe'&&p.completeness==='complete';
   const ownRanges=proofs.filter(e=>e.temporalAnchorVerified===true).map(e=>e.timeRange);
   const otherRanges=list(report.contextualSignals?.units).filter(unit=>unit!==p&&unit.type==='recipe'&&unit.completeness==='complete').flatMap(unit=>list(unit.evidenceRefs).map(id=>evidence.get(id)).filter(e=>e?.temporalAnchorVerified===true).map(e=>e.timeRange));
   const overlaps=ownRanges.some(a=>otherRanges.some(b=>a&&b&&a.startSeconds<b.endSeconds&&b.startSeconds<a.endSeconds));
   if(completeRecipe&&(!ownRanges.length||overlaps)){state='inconclusive';reason='Unidade completa exige trechos temporais distintos entre preparos, apoiados por palavras/segmentos realmente salvos.';}
   else {state='supported';reason='Recibo independente ligado à proposição integral, relatório e fontes exatos.';}
  }
  const item={fieldPath:entry.fieldPath,propositionHash:entry.propositionHash,policyVersion:semanticQualityPolicyVersion,reportHash,sourceManifestHash,state,reason,reviewReceiptId:state==='supported'?review.receiptId:null,evidenceRefs:refs};
  if(entry.kind==='attribute')result.attributes.push(item);
  else if(entry.kind==='unit')result.units.push(item);
  else result.primaryContext=item;
 }
 return result;
}

// Deliberately small positive rules. Unsupported typed meaning remains a
// candidate; the generic "other" kind attributes the literal text only.
export function typedFieldLiteralRule(field){
 const value=String(field?.value??'').normalize('NFC').trim();
 if(field?.kind==='other')return 'attributed_literal_other';
 if(field?.kind==='preparation_time'&&/\d\s*(?:minutos?|mins?|horas?|hours?|minutes?)\b/iu.test(value)&&list(field.evidence).some(e=>/\b(?:preparo|preparation|preparação|preparacao)\b/iu.test(e?.excerpt??'')))return 'explicit_preparation_duration';
 if(field?.kind==='serving_count'&&/\b(?:rende|serve|porções|porcoes|servings?)\b/iu.test(value)&&/\d/u.test(value))return 'explicit_serving_count';
 if(field?.kind==='price'&&/(?:R\$|US\$|€|\$)\s*\d/u.test(value))return 'explicit_currency_amount';
 if(field?.kind==='procedure'&&/^(?:adicione|misture|bata|corte|asse|cozinhe|leve|mexa|use|add|mix|bake|cook)\b/iu.test(value))return 'explicit_preparation_instruction';
 if(field?.kind==='ingredient'&&/\b(?:frango|chicken|arroz|rice|farinha|flour|ovo|ovos|egg|eggs|leite|milk|açúcar|acucar|sugar|sal|salt|manteiga|butter|azeite|óleo|oleo|oil|tomate|tomato|queijo|cheese)\b/iu.test(value)&&list(field.evidence).some(e=>{
  const text=String(e?.excerpt??'').normalize('NFC'),index=text.indexOf(value),before=index<0?'':text.slice(0,index).split(/[.!?;]/u).at(-1);
  return index>=0&&/\d/u.test(value)&&/\b(?:ingredientes?|ingredients?|use|adicione|add)\b[^.!?;]{0,120}$/iu.test(before)&&literalClaimSupport(value,text)==='literal';
 }))return 'explicit_quantified_ingredient_instruction';
 return null;
}
