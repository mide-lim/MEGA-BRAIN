import {coverageStates,dimensionDefinitions,contextualHash,contextualVersion,contextualRuleHash} from './reels-contextual-projection.mjs';
const contexts=new Set(['recipe','technology','health','travel','business','home','general']);
const contextLabels={recipe:'Receitas e preparos',technology:'Tecnologia',health:'Saúde e bem-estar',travel:'Viagens e lugares',business:'Trabalho e negócios',home:'Casa e estilo',general:'Outros temas'};
const invalid=()=>Object.assign(Error('Filtro contextual inválido.'),{status:400,code:'INVALID_CONTEXTUAL_QUERY'});
const bounded=(v,n=300)=>typeof v==='string'&&v.length<=n;
const normalize=v=>String(v??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const dimensions=new Set(dimensionDefinitions.map(x=>x.id));
export function parseContextualQuery(input={}){
 const result={};
 for(const name of ['category','context','q'])if(input[name]!==undefined&&input[name]!==''){
  if(!bounded(input[name],name==='q'?500:128))throw invalid();result[name]=input[name];
 }
 if(result.context&&!contexts.has(result.context)&&result.context!=='unknown')throw invalid();
 const facetMode=input.facetMode??'supported';if(!['supported','mentioned'].includes(facetMode))throw invalid();result.facetMode=facetMode;
 const globalQuantifier=input.quantifier??'ANY';if(!['ANY','ALL','SAME_UNIT'].includes(globalQuantifier))throw invalid();
 let facets=input.facets??[];
 if(typeof facets==='string'){if(facets.length>4096)throw invalid();try{facets=JSON.parse(facets);}catch{throw invalid();}}
 if(!Array.isArray(facets)||facets.length>8)throw invalid();
 if(input.dimension!==undefined||input.value!==undefined){if(facets.length)throw invalid();facets=[{dimension:input.dimension,value:input.value,quantifier:globalQuantifier}];}
 result.facets=facets.map(f=>{
  if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!['dimension','value','quantifier'].includes(k))||!dimensions.has(f.dimension)||!bounded(f.value,128)||!f.value||!['ANY','ALL','SAME_UNIT'].includes(f.quantifier??globalQuantifier))throw invalid();
  return {dimension:f.dimension,value:f.value,quantifier:f.quantifier??globalQuantifier};
 });
 // Different quantifiers for OR values of one dimension are ambiguous.
 for(const dimension of new Set(result.facets.map(f=>f.dimension)))if(new Set(result.facets.filter(f=>f.dimension===dimension).map(f=>f.quantifier)).size>1)throw invalid();
 return result;
}
export function contextualAttributeMatches(attribute,facetMode='supported'){
 if(attribute.polarity!=='affirmed'||attribute.role==='excluded')return false;
 return facetMode==='supported'?attribute.state==='supported'&&['central','supporting'].includes(attribute.role):['supported','present_unverified'].includes(attribute.state)&&['central','supporting','mentioned'].includes(attribute.role);
}
function descendants(nodes,category){
 const ids=new Set([category]);let changed=true;
 while(changed){changed=false;for(const n of nodes)if(ids.has(n.parentId)&&!ids.has(n.id)){ids.add(n.id);changed=true;}}
 return ids;
}
export function filterContextualEntries(entries,input={},nodes=[]){
 const query=parseContextualQuery(input),categoryIds=query.category?descendants(nodes,query.category):null;
 const groups=[...new Set(query.facets.map(f=>f.dimension))].map(dimension=>query.facets.filter(f=>f.dimension===dimension));
 return entries.filter(entry=>{
  if(categoryIds&&!entry.categoryIds.some(id=>categoryIds.has(id)))return false;
  if(query.context&&(entry.context.value??'unknown')!==query.context)return false;
  const terms=normalize(query.q).trim().split(/\s+/).filter(Boolean),hay=normalize([entry.title,...entry.attributes.map(a=>a.label)].join(' '));
  if(!terms.every(t=>hay.includes(t)))return false;
  const groupMatches=groups.map(group=>{
   const attrs=entry.attributes.filter(a=>group.some(f=>f.value===a.valueId&&f.dimension===a.dimensionId)&&contextualAttributeMatches(a,query.facetMode));
   if(!attrs.length)return null;
   const unitIds=new Set(attrs.flatMap(a=>a.unitIds));
   if(group[0].quantifier==='ALL'){
    if(!Number.isSafeInteger(entry.independentUnitCount)||entry.independentUnitCount<1||entry.units.length!==entry.independentUnitCount||!entry.units.every(u=>u.complete&&u.state==='supported'&&unitIds.has(u.id)))return null;
   }
   return unitIds;
  });
  if(groupMatches.some(x=>x===null))return false;
  if(groups.some(g=>g[0].quantifier==='SAME_UNIT')){
   if(!Number.isSafeInteger(entry.independentUnitCount)||entry.independentUnitCount<1)return false;
   let shared=new Set(entry.units.filter(u=>u.state==='supported'&&u.complete).map(u=>u.id));
   for(const units of groupMatches)shared=new Set([...shared].filter(id=>units.has(id)));
   if(!shared.size)return false;
  }
  return true;
 });
}
const states=()=>Object.fromEntries(coverageStates.map(s=>[s,0]));
export function buildContextualIndex(entries,{nodes=[],query={}}={}){
 const unique=[...new Map(entries.filter(Boolean).map(e=>[e.id,e])).values()];
 const filtered=filterContextualEntries(unique,query,nodes),coverage={denominator:filtered.length,basis:'context_state',states:states(),byDimension:dimensionDefinitions.map(d=>({dimensionId:d.id,label:d.label,denominator:filtered.length,...states()}))};
 const facets=new Map(),contextNodes=new Map(),patterns=new Map();
 for(const entry of filtered){
  coverage.states[coverageStates.includes(entry.context.state)?entry.context.state:'unknown']++;
  for(const dimension of coverage.byDimension){const state=entry.coverage.find(c=>c.dimensionId===dimension.dimensionId)?.state??'unknown';dimension[coverageStates.includes(state)?state:'unknown']++;}
  const contextId=entry.context.value??'unknown';
  if(!contextNodes.has(contextId))contextNodes.set(contextId,{id:contextId,name:contextLabels[contextId]??'Contexto ainda não estruturado',parentId:null,ids:new Set(),supported:new Set()});
  const cn=contextNodes.get(contextId);cn.ids.add(entry.id);if(entry.context.state==='supported')cn.supported.add(entry.id);
  for(const a of entry.attributes){
   const key=a.dimensionId+':'+a.valueId;
   if(!facets.has(key))facets.set(key,{dimensionId:a.dimensionId,valueId:a.valueId,label:a.label,ids:new Set(),support:new Set(),mentioned:new Set(),negative:new Set(),proofs:new Set(),contexts:new Set()});
   const f=facets.get(key);f.ids.add(entry.id);f.contexts.add(contextId);
   if(contextualAttributeMatches(a,'supported'))f.support.add(entry.id);
   if(contextualAttributeMatches(a,'mentioned')&&!contextualAttributeMatches(a,'supported'))f.mentioned.add(entry.id);
   if(a.polarity==='negated'||a.role==='excluded')f.negative.add(entry.id);
   for(const p of a.evidence)if(p.state==='supported')f.proofs.add(p.id);
   if(contextualAttributeMatches(a,'supported')){
    const pk=contextId+':'+key;
    if(!patterns.has(pk))patterns.set(pk,{context:contextId,dimensionId:a.dimensionId,valueId:a.valueId,label:a.label,ids:new Set(),proofs:new Set()});
    const pattern=patterns.get(pk);pattern.ids.add(entry.id);for(const p of a.evidence)if(p.state==='supported')pattern.proofs.add(p.id);
   }
  }
 }
 const facetRows=[...facets.values()].map(f=>({dimensionId:f.dimensionId,valueId:f.valueId,label:f.label,supportCount:f.support.size,mentionedCount:f.mentioned.size,negativeCount:f.negative.size,volumeCount:f.ids.size,evidenceCount:f.proofs.size,contexts:[...f.contexts].sort(),coverage:coverage.byDimension.find(x=>x.dimensionId===f.dimensionId),filter:{dimension:f.dimensionId,value:f.valueId,quantifier:'ANY'}})).sort((a,b)=>b.supportCount-a.supportCount||a.label.localeCompare(b.label,'pt-BR'));
 const candidates=[...patterns.values()].filter(p=>p.ids.size>1).map(p=>({id:contextualHash({context:p.context,dimension:p.dimensionId,value:p.valueId,rule:contextualRuleHash}),context:p.context,dimensionId:p.dimensionId,valueId:p.valueId,label:p.label,status:'candidate',supportCount:p.ids.size,evidenceCount:p.proofs.size,reelIds:[...p.ids].sort(),automaticCreationEnabled:false,promotionThreshold:null,reason:'RECURRENCE_OBSERVED_NOT_CALIBRATED',filter:{context:p.context,facets:[{dimension:p.dimensionId,value:p.valueId,quantifier:'ANY'}]}})).sort((a,b)=>b.supportCount-a.supportCount||a.label.localeCompare(b.label,'pt-BR'));
 return {version:contextualVersion,ruleHash:contextualRuleHash,total:filtered.length,inventoryTotal:unique.length,nodes:[...contextNodes.values()].map(n=>({id:n.id,name:n.name,parentId:n.parentId,count:n.ids.size,supportCount:n.supported.size,filter:{context:n.id}})),facets:facetRows,patterns:candidates,candidates,coverage,entries:filtered};
}
export function contextualListItem(entry){
 return {id:entry.id,title:entry.title,categoryIds:entry.categoryIds,sourceIdentity:entry.sourceIdentity,context:entry.context,format:entry.format,independentUnitCount:entry.independentUnitCount,coverage:entry.coverage,attributes:entry.attributes.map(({evidence,...a})=>({...a,evidenceCount:evidence.length})),legacyEvidence:entry.legacyEvidence,fingerprint:entry.fingerprint};
}
