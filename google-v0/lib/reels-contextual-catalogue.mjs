import {projectContextualPublication,contextualHash,contextualRuleHash,coverageStates} from './reels-contextual-projection.mjs';
import {buildContextualIndex,filterContextualEntries,parseContextualQuery} from './reels-contextual-index.mjs';
import {preservedContentAvailable} from './reels-preserved-content.mjs';
import {publicationAvailable,reelIdPattern} from './reels-model.mjs';
import {createHash} from 'node:crypto';
const list=v=>Array.isArray(v)?v:[];
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const failure=code=>{throw Object.assign(Error('Catálogo contextual requer fonte e versão válidas.'),{code,status:409});};
export const contextualCataloguePolicy=Object.freeze({version:'saved-publication-catalogue-v1',ruleHash:contextualRuleHash,source:'accepted_saved_publications_only',providerCalls:false,semanticGeneralizationCertified:false,formatValues:['single_recipe','recipe_collection'],ingredientCategories:false});
const formatDefinitions=[{value:'single_recipe',label:'Receita única'},{value:'recipe_collection',label:'Várias receitas'}];
const metadataProof=p=>({id:p.id,state:p.state,source:p.source??p.sourceKind??null});
const states=()=>Object.fromEntries(coverageStates.map(s=>[s,0]));
const sameIdentity=(a,b)=>a?.kind===b?.kind&&(a?.kind==='native'?a.analysisKey===b.analysisKey&&String(a.analysisGeneration)===String(b.analysisGeneration):a?.kind==='legacy_preserved'&&a.recordHash===b.recordHash&&a.sourceSnapshotHash===b.sourceSnapshotHash);
const sourceVersionsValid=v=>obj(v)&&time(v.video)&&(v.legacy===undefined||v.legacy===null||time(v.legacy));
export const contextualContributionPath=id=>{if(!reelIdPattern.test(id??''))failure('CATALOGUE_REEL_ID_INVALID');return 'reels_index/contextual_'+id;};
function editorialMetadata(item,editorial={}){
 const manual=item?.categoryOverride?.manual===true||item?.categoryResolution?.mode==='manual'||editorial.manual===true;
 return {manual,revision:editorial.revision??item?.categoryOverride?.revision??null,suppressedDimensions:[...new Set(list(editorial.suppressedDimensions).filter(x=>typeof x==='string'))].sort(),suppressedValues:list(editorial.suppressedValues).filter(x=>obj(x)&&typeof x.dimension==='string'&&typeof x.value==='string').map(x=>({dimension:x.dimension,value:x.value})).sort((a,b)=>(a.dimension+':'+a.value).localeCompare(b.dimension+':'+b.value)),categoryIds:[...new Set(list(item?.categoryIds))].sort()};
}
function compactEntry(entry,editorial){
 const suppressed=a=>editorial.suppressedDimensions.includes(a.dimensionId)||editorial.suppressedValues.some(v=>v.dimension===a.dimensionId&&v.value===a.valueId);
 const attributes=entry.attributes.filter(a=>!suppressed(a)).map(({evidence,...a})=>({...a,evidence:list(evidence).map(metadataProof)}));
 const format={...entry.format,label:formatDefinitions.find(f=>f.value===entry.format.value)?.label??entry.format.label};
 if(editorial.suppressedDimensions.includes('format'))Object.assign(format,{value:null,label:null,state:'unknown',reason:'EDITORIAL_FORMAT_SUPPRESSED'});
 return {id:entry.id,title:entry.title,searchText:entry.searchText,categoryIds:entry.categoryIds,sourceIdentity:entry.sourceIdentity,sourceManifestHash:entry.sourceManifestHash,sourceProofHash:entry.sourceProofHash,context:entry.context,format,units:entry.units.map(({evidence,...u})=>({...u,evidence:list(evidence).map(metadataProof)})),independentUnitCount:entry.independentUnitCount,attributes,coverage:entry.coverage.map(c=>editorial.suppressedDimensions.includes(c.dimensionId)?{dimensionId:c.dimensionId,state:'unknown',reason:'EDITORIAL_DIMENSION_SUPPRESSED'}:c),curation:{manual:editorial.manual,revision:editorial.revision},indexVersion:entry.indexVersion,ruleHash:entry.ruleHash};
}
export function projectContextualContribution({item,video={},legacy=null,qualityVerification=null,editorial={},sourceVersions,observedAt}={}){
 if(!item||!reelIdPattern.test(item.id??'')||!time(observedAt)||!sourceVersionsValid(sourceVersions))failure('CATALOGUE_SOURCE_VERSION_INVALID');
 if(video.id&&video.id!==item.id||legacy?.reelId&&legacy.reelId!==item.id)failure('CATALOGUE_SOURCE_ID_MISMATCH');
 const accepted=publicationAvailable(video)||preservedContentAvailable(legacy,item.id);
 if(accepted&&item.publication?.available===false)failure('CATALOGUE_ITEM_PUBLICATION_MISMATCH');
 const projected=projectContextualPublication({item,video,legacy,qualityVerification});if(!projected)return null;
 const ed=editorialMetadata({...item,categoryOverride:{...item.categoryOverride,manual:item.categoryOverride?.manual===true||video.taxonomy_override?.manual===true}},editorial),editorialHash=contextualHash(ed),entry=compactEntry(projected,ed);
 const identity={reelId:item.id,sourceIdentity:entry.sourceIdentity,sourceProofHash:entry.sourceProofHash,ruleHash:contextualRuleHash,editorialHash,sourceVersions};
 const contribution={schemaVersion:1,kind:'contextual_contribution',policyVersion:contextualCataloguePolicy.version,status:'active',reelId:item.id,...identity,editorial:ed,entry,observedAt,processingStarted:false,providerCalls:0};
 contribution.contentHash=contextualHash({identity,entry});
 contribution.idempotencyKey=contextualHash({kind:contribution.kind,policyVersion:contribution.policyVersion,contentHash:contribution.contentHash});
 return contribution;
}
export function catalogueEntries(contributions,{inventoryIds=null}={}){
 const inventory=inventoryIds?new Set(inventoryIds):null,seen=new Set(),entries=[];
 for(const c of list(contributions)){
  if(!c||c.kind!=='contextual_contribution'||c.status!=='active'||c.schemaVersion!==1||c.policyVersion!==contextualCataloguePolicy.version||c.ruleHash!==contextualRuleHash||!c.entry||c.entry.id!==c.reelId||inventory&&!inventory.has(c.reelId))continue;
  const identity={reelId:c.reelId,sourceIdentity:c.sourceIdentity,sourceProofHash:c.sourceProofHash,ruleHash:c.ruleHash,editorialHash:c.editorialHash,sourceVersions:c.sourceVersions};
  if(!sourceVersionsValid(c.sourceVersions)||c.sourceProofHash!==c.entry.sourceProofHash||!sameIdentity(c.sourceIdentity,c.entry.sourceIdentity)||c.contentHash!==contextualHash({identity,entry:c.entry})||c.idempotencyKey!==contextualHash({kind:c.kind,policyVersion:c.policyVersion,contentHash:c.contentHash}))failure('CATALOGUE_CONTRIBUTION_CORRUPT');
  if(seen.has(c.reelId))failure('CATALOGUE_DUPLICATE_CONTRIBUTION');seen.add(c.reelId);entries.push(c.entry);
 }
 return entries;
}
export function catalogueMatchingIds(contributions,query={},nodes=[]){
 const parsed=parseContextualQuery(query),virtual=formatDefinitions.find(f=>parsed.category==='ctx_format_'+f.value);
 const existingFormats=parsed.facets.filter(f=>f.dimension==='format');
 if(virtual&&existingFormats.length&&!existingFormats.some(f=>f.value===virtual.value))return [];
 const refined=virtual?{...parsed,category:'receitas',context:'recipe',facets:[...parsed.facets.filter(f=>f.dimension!=='format'),{dimension:'format',value:virtual.value,quantifier:'ANY'}]}:parsed;
 const entries=catalogueEntries(contributions).filter(e=>!virtual||!e.curation?.manual);
 return filterContextualEntries(entries,refined,nodes).map(e=>e.id).sort();
}
export function buildContextualCatalogue(contributions,{inventoryIds,observedAt,dataAsOf=observedAt,sourceStale=false,nodes=[],incremental=null}={}){
 if(!Array.isArray(inventoryIds)||new Set(inventoryIds).size!==inventoryIds.length||inventoryIds.some(id=>!reelIdPattern.test(id))||!time(observedAt)||!time(dataAsOf))failure('CATALOGUE_INVENTORY_INVALID');
 const entries=catalogueEntries(contributions,{inventoryIds}),index=buildContextualIndex(entries,{nodes}),coverage={};
 for(const dimension of ['context','format','ingredient']){
  const row={denominator:entries.length,states:states()};
  for(const e of entries){const state=dimension==='context'?e.context.state:dimension==='format'?e.format.state:e.coverage.find(c=>c.dimensionId==='ingredient')?.state??'unknown';row.states[coverageStates.includes(state)?state:'unknown']++;}
  coverage[dimension]=row;
 }
 const projectionCoverage={inventoryCount:inventoryIds.length,evaluatedCount:entries.length,missingCount:inventoryIds.length-entries.length,unknownContextCount:entries.filter(e=>e.context.state!=='supported').length,formatUnknownCount:entries.filter(e=>e.context.value==='recipe'&&e.format.state!=='supported').length,nonRecipeCount:entries.filter(e=>e.context.state==='supported'&&e.context.value!=='recipe').length,manualProtectedCount:entries.filter(e=>e.curation?.manual).length,states:coverage};
 const formats=formatDefinitions.map(f=>{
  const matchingIds=catalogueMatchingIds(contributions,{category:'ctx_format_'+f.value},nodes).filter(id=>inventoryIds.includes(id));
  return {...f,id:f.value,categoryId:'ctx_format_'+f.value,parentCategoryId:'receitas',count:matchingIds.length,matchingIds,filter:{category:'receitas',context:'recipe',facets:[{dimension:'format',value:f.value,quantifier:'ANY'}]}};
 });
 const ingredients=index.facets.filter(f=>f.dimensionId==='ingredient').map(f=>({valueId:f.valueId,label:f.label,supportCount:f.supportCount,mentionedCount:f.mentionedCount,volumeCount:f.volumeCount,filter:{dimension:'ingredient',value:f.valueId,quantifier:'ANY'}}));
 const contexts=index.nodes.map(n=>({id:n.id,label:n.name,count:n.count,supportCount:n.supportCount,filter:n.filter}));
 const opportunities=index.patterns.map(p=>({...p,state:'candidate',reason:'RECURRENCE_REQUIRES_CONTEXTUAL_REVIEW',categoryCreationEnabled:false}));
 const sourceHash=contextualHash(list(contributions).filter(c=>inventoryIds.includes(c?.reelId)).map(c=>({id:c.reelId,status:c.status,idempotencyKey:c.idempotencyKey,sourceVersions:c.sourceVersions})).sort((a,b)=>a.id.localeCompare(b.id)));
 return {schemaVersion:1,policyVersion:contextualCataloguePolicy.version,ruleHash:contextualRuleHash,projectionCoverage,formats,ingredients,contexts,opportunities,patterns:opportunities,sourceHash,observedAt,dataAsOf,sourceStale,incremental:incremental??{enabled:false,eventDriven:false,noProviders:true},limits:['Avaliação determinística de fontes publicadas salvas; não é medição de precisão semântica dos vídeos.','Formato depende de preparações independentes comprovadas; ingredientes e etapas não contam como receitas.','Ingredientes são filtros e não criam categorias nem comprovam ingrediente principal.','Fontes sem atributo/prova suficiente permanecem desconhecidas; não são falhas de processamento.'],processingStarted:false};
}
const eventTypes=new Set(['publicationAccepted','baselinePublicationRegistered','sourceCorrected','editorialChanged','publicationWithdrawn']);
export function reconcileContextualContribution({event,currentSource,previousContribution=null,observedAt}={}){
 if(!eventTypes.has(event?.type)||!reelIdPattern.test(event?.reelId??'')||typeof event.id!=='string'||!event.id||event.id.length>128||!time(observedAt))failure('CATALOGUE_EVENT_INVALID');
 const id=event.reelId,path=contextualContributionPath(id),previous=previousContribution?.data??previousContribution;
 if(previous&&previous.reelId!==id)failure('CATALOGUE_PREVIOUS_ID_MISMATCH');
 if(!currentSource||currentSource.item?.id!==id||!sourceVersionsValid(currentSource.sourceVersions))failure('CATALOGUE_FRESH_SOURCE_REQUIRED');
 const next=projectContextualContribution({...currentSource,observedAt});
 if(event.sourceIdentity&&next&&!sameIdentity(event.sourceIdentity,next.sourceIdentity)||event.sourceProofHash&&next&&event.sourceProofHash!==next.sourceProofHash)return {action:'noop',reason:'STALE_PUBLICATION_EVENT',path};
 if(event.type==='publicationWithdrawn'&&next)return {action:'noop',reason:'PUBLICATION_STILL_ACCEPTED',path};
 if(!next&&!['publicationWithdrawn','sourceCorrected','editorialChanged'].includes(event.type))return {action:'deferred',reason:'CURRENT_PUBLICATION_NOT_ACCEPTED',path};
 const replacement=next??{schemaVersion:1,kind:'contextual_contribution',policyVersion:contextualCataloguePolicy.version,status:'removed',reelId:id,sourceVersions:currentSource.sourceVersions,ruleHash:contextualRuleHash,observedAt,reason:'PUBLICATION_NO_LONGER_ACCEPTED',processingStarted:false,providerCalls:0};
 if(!next){replacement.contentHash=contextualHash({status:replacement.status,reelId:id,sourceVersions:replacement.sourceVersions,ruleHash:replacement.ruleHash});replacement.idempotencyKey=contextualHash({kind:replacement.kind,contentHash:replacement.contentHash});}
 if(previous?.idempotencyKey===replacement.idempotencyKey)return {action:'noop',reason:'EXACT_CONTRIBUTION_ALREADY_CURRENT',path,idempotencyKey:replacement.idempotencyKey};
 return {action:next?'upsert':'remove',path,replacement,expectedPreviousHash:previous?.contentHash??null,expectedSourceVersions:currentSource.sourceVersions,expectedEditorialHash:next?.editorialHash??null,eventId:event.id,idempotencyKey:replacement.idempotencyKey};
}
/** Root-owned port must atomically verify source/editorial/previous versions. */
export class ReelsContextualCatalogueProjector{
 constructor({loadSource,loadContribution,commitCAS,clock=Date.now}){
  if([loadSource,loadContribution,commitCAS].some(fn=>typeof fn!=='function'))throw Error('Portas do catálogo incremental ausentes.');
  Object.assign(this,{loadSource,loadContribution,commitCAS,clock});
 }
 async handle(event){
  const path=contextualContributionPath(event?.reelId),currentSource=await this.loadSource(event.reelId),previousContribution=await this.loadContribution(path);
  const plan=reconcileContextualContribution({event,currentSource,previousContribution,observedAt:new Date(this.clock()).toISOString()});
  if(!['upsert','remove'].includes(plan.action))return {...plan,committed:false,providerCalls:0};
  const result=await this.commitCAS({...plan,event,expectedContributionUpdateTime:previousContribution?.updateTime??null});
  if(result?.applied!==true)return {...plan,replacement:undefined,committed:false,pending:true,reason:'CONTRIBUTION_CAS_NOT_CONFIRMED',providerCalls:0};
  return {action:plan.action,path,committed:true,pending:false,idempotencyKey:plan.idempotencyKey,updateTime:result.updateTime??null,providerCalls:0};
 }
}
export function prepareContextualCatalogue(input={}){
 if(input.schemaVersion!==1||!Array.isArray(input.catalog)||!Array.isArray(input.records)||input.catalog.length>20000||input.records.length>20000||!time(input.observedAt))failure('CATALOGUE_PREPARATION_INPUT_INVALID');
 const catalog=new Map();for(const row of input.catalog){if(!reelIdPattern.test(row?.id??'')||row.publicationAvailable!==true||catalog.has(row.id))failure('CATALOGUE_ACCEPTED_INVENTORY_INVALID');catalog.set(row.id,row);}
 const contributions=[],bindings=[],seen=new Set();
 for(const record of input.records){
  if(typeof record.sourceJson!=='string'||record.sourceJson.length>500000||createHash('sha256').update(record.sourceJson).digest('hex')!==record.sourceSnapshotHash)failure('CATALOGUE_CAPTURE_HASH_MISMATCH');
  let source;try{source=JSON.parse(record.sourceJson);}catch{failure('CATALOGUE_CAPTURE_JSON_INVALID');}
  const id=source.item?.id,row=catalog.get(id);if(!row||seen.has(id))failure('CATALOGUE_CAPTURE_INVENTORY_MISMATCH');seen.add(id);
  const item={...source.item,categoryIds:row.categoryIds??source.item.categoryIds,publication:{...source.item.publication,available:true},categoryOverride:{...source.item.categoryOverride,manual:row.manual===true}};
  const sourceVersions=source.sourceUpdateTime,contribution=projectContextualContribution({...source,item,sourceVersions,editorial:row.editorial??{},observedAt:input.observedAt});
  if(!contribution||row.sourceIdentity&&!sameIdentity(row.sourceIdentity,contribution.sourceIdentity))failure('CATALOGUE_CAPTURE_PUBLICATION_MISMATCH');
  contributions.push({path:contextualContributionPath(id),data:contribution});bindings.push({reelId:id,sourceSnapshotHash:record.sourceSnapshotHash,sourceIdentity:contribution.sourceIdentity,sourceProofHash:contribution.sourceProofHash,sourceVersions});
 }
 const inventoryIds=[...catalog.keys()].sort(),catalogue=buildContextualCatalogue(contributions.map(c=>c.data),{inventoryIds,observedAt:input.observedAt,dataAsOf:input.dataAsOf??input.observedAt,nodes:input.taxonomy?.nodes??input.taxonomy?.data?.nodes??[]});
 return {schemaVersion:1,kind:'saved_contextual_catalogue_bootstrap',policyVersion:contextualCataloguePolicy.version,inventoryIds,sourceBindings:bindings,contributions,catalogue,sourceHash:catalogue.sourceHash,approvedForApply:false,providerCalls:0,processingStarted:false};
}
