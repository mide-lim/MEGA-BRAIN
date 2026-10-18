import {projectReel,publicationAvailable,categoryNavigation,reelIdPattern} from './reels-model.mjs';
import {withPreservedSummary} from './reels-preserved-content.mjs';
import {projectContextualPublication,contextualHash} from './reels-contextual-projection.mjs';
import {verifyPublicationQualityReceipt,qualityReceiptIdPattern} from './reels-quality-gate.mjs';
import {contextualCataloguePolicy,catalogueEditorialMetadata,ReelsContextualCatalogueProjector,buildContextualCatalogue,catalogueMatchingIds,normalizeCatalogueQuery} from './reels-contextual-catalogue.mjs';
const list=v=>Array.isArray(v)?v:[];
export const catalogueManifestPath='settings/reels_v2_contextual_catalogue';
export const catalogueManifestActive=manifest=>manifest?.status==='active'&&manifest.policyVersion===contextualCataloguePolicy.version;
export function catalogueEditorialForItem(item,taxonomy={}){
 const assignment=list(taxonomy.assignments).filter(a=>a.reelId===item.id&&a.manual===true).sort((a,b)=>(b.revision??0)-(a.revision??0))[0];
 const override=list(taxonomy.contextualOverrides).find(x=>x.reelId===item.id)??{};
 const common=taxonomy.contextualSuppression??{};
 return catalogueEditorialMetadata(item,{manual:assignment?.manual===true||override.manual===true,revision:assignment?.revision??item.categoryOverride?.revision??null,suppressedDimensions:[...list(common.dimensions),...list(override.suppressedDimensions)],suppressedValues:[...list(common.values),...list(override.suppressedValues),...list(taxonomy.suppressed).filter(x=>x&&typeof x==='object'&&x.dimension&&x.valueId&&(!x.reelId||x.reelId===item.id)).map(x=>({dimension:x.dimension,value:x.valueId}))]});
}
export class ReelsCatalogueRuntime{
 constructor({repository,clock=Date.now,trustedReviewLoader=null}){
  if(!repository)throw Error('Repositório do catálogo ausente.');
  this.repository=repository;this.store=repository.store;this.clock=clock;this.trustedReviewLoader=trustedReviewLoader;
  repository.catalogueEnabled=true;repository.catalogueRuntime=this;
 }
 now(){return new Date(this.clock()).toISOString();}
 async loadSource(id){
  if(!reelIdPattern.test(id??''))throw Error('Reel de catálogo inválido.');
  const videoSnapshot=await this.store.get('videos/'+id);if(!videoSnapshot)return null;
  const primaryNative=publicationAvailable(videoSnapshot.data),legacySnapshot=primaryNative?null:await this.store.get('reels_legacy_content/'+id),taxonomySnapshot=await this.store.get('settings/reels_v2_taxonomy'),reviewPath='reels_index/contextual_review_'+id,reviewSnapshot=await this.store.get(reviewPath);
  if(taxonomySnapshot?.data.pendingOperationId)throw Object.assign(Error('Categorias em edição; evento contextual preservado.'),{code:'CATALOGUE_EDITORIAL_PENDING'});
  const video={...videoSnapshot.data,id},legacy=legacySnapshot?.data??null,taxonomy=taxonomySnapshot?.data??{};
  const item=categoryNavigation([withPreservedSummary(projectReel(video),legacy)],taxonomy).items[0],checks=[{path:'videos/'+id,updateTime:videoSnapshot.updateTime},...(!primaryNative?[{path:'reels_legacy_content/'+id,updateTime:legacySnapshot?.updateTime??null}]:[]),{path:'settings/reels_v2_taxonomy',updateTime:taxonomySnapshot?.updateTime??null},{path:reviewPath,updateTime:reviewSnapshot?.updateTime??null}];
  let qualityVerification=null;
  if(video.analysis?.contextualSignals?.version===2&&qualityReceiptIdPattern.test(video.publication?.qualityReceipt?.receiptId??'')){
   const path='reels_quality_receipts/'+video.publication.qualityReceipt.receiptId,receipt=await this.store.get(path);
   checks.push({path,updateTime:receipt?.updateTime??null});qualityVerification=verifyPublicationQualityReceipt({video,receipt:receipt?.data});
  }
  const entry=projectContextualPublication({video,legacy,item,qualityVerification}),candidate=this.trustedReviewLoader?await this.trustedReviewLoader({id,reviewSnapshot,entry}):reviewSnapshot?.data?.review??reviewSnapshot?.data??null;
  // A review of a previous source version is retained as history, never reused.
  const formatReview=candidate?.sourceProofHash===entry?.sourceProofHash&&(!reviewSnapshot?.data.reviewHash||reviewSnapshot.data.reviewHash===contextualHash(candidate))?candidate:null;
  return {video,legacy,item,qualityVerification,editorial:catalogueEditorialForItem(item,taxonomy),sourceVersions:{video:videoSnapshot.updateTime,...(legacySnapshot?{legacy:legacySnapshot.updateTime}:{})},formatReview,reviewVersion:{path:reviewPath,updateTime:reviewSnapshot?.updateTime??null},checks};
 }
 async project(id,{type='sourceCorrected',eventId=null}={}){
  if(!reelIdPattern.test(id??''))throw Error('Reel de catálogo inválido.');
  const manifest=await this.store.get(catalogueManifestPath);
  let source=eventId?null:await this.loadSource(id);
  const event={id:eventId??contextualHash({id,type,sourceVersions:source?.sourceVersions,editorial:source?.editorial,reviewHash:source?.formatReview?contextualHash(source.formatReview):null}),type,reelId:id},eventPath='reels_index/contextual_event_'+contextualHash({id:event.id,type,reelId:id});
  await this.store.create(eventPath,{kind:'contextual_event',schemaVersion:1,event,status:'pending',createdAt:this.now(),providerCalls:0});
  if(!catalogueManifestActive(manifest?.data))return {committed:false,pending:true,eventId:event.id,eventPath,reason:'CATALOGUE_BOOTSTRAP_NOT_ACTIVE',providerCalls:0};
  try{
   const projector=new ReelsContextualCatalogueProjector({clock:this.clock,loadSource:async()=>source??=await this.loadSource(id),loadContribution:path=>this.store.get(path),commitCAS:plan=>{
    if(typeof this.store.compareAndReplaceDerived!=='function')throw Error('Persistência transacional do catálogo indisponível.');
    return this.store.compareAndReplaceDerived({path:plan.path,replacement:plan.replacement,checks:[...source.checks,{path:catalogueManifestPath,updateTime:manifest.updateTime},{path:plan.path,updateTime:plan.expectedContributionUpdateTime}]});
   }});
   const outcome=await projector.handle(event);
   if(outcome.committed||outcome.action==='noop'){
    const current=await this.store.get(eventPath);
    if(current&&current.data.status!=='completed')await this.store.patch(eventPath,{status:'completed',completedAt:this.now(),idempotencyKey:outcome.idempotencyKey??null},{updateTime:current.updateTime});
    this.repository.cacheEpoch++;if(this.repository.snapshot)this.repository.snapshot.expiresAt=0;
   }
   return {...outcome,eventId:event.id,eventPath};
  }catch{
   // A secondary index failure cannot invalidate A or submit a provider again.
   return {committed:false,pending:true,eventId:event.id,eventPath,reason:'CATALOGUE_EVENT_PENDING',providerCalls:0};
  }
 }
 async reconcileEditorialOperation(operationId){
  if(!/^[a-f0-9]{64}$/.test(operationId??''))throw Error('Operação editorial inválida.');
  const receipt=await this.store.get('reels_command_items/taxonomy_'+operationId);
  if(receipt?.data.kind!=='taxonomy_manual'||receipt.data.status!=='completed')return {pending:true,reason:'EDITORIAL_OPERATION_NOT_COMPLETED',evaluatedCount:0,providerCalls:0};
  const ids=new Set(),seen=new Set();let cursor;
  do{
   const page=await this.store.query('reels_command_items',{filters:[{field:'operationId',op:'eq',value:operationId}],select:['kind','operationId','status','assignment.reelId'],limit:500,cursor});
   for(const row of page.records)if(row.data.kind==='taxonomy_manual_assignment'&&row.data.operationId===operationId&&row.data.status==='completed'&&reelIdPattern.test(row.data.assignment?.reelId??''))ids.add(row.data.assignment.reelId);
   cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Recibos editoriais não avançaram.');if(cursor)seen.add(cursor);
  }while(cursor);
  let pending=false,evaluatedCount=0;
  for(const id of ids){const outcome=await this.project(id,{type:'editorialChanged',eventId:'taxonomy-'+operationId+'-'+id});pending||=outcome.pending===true;evaluatedCount++;}
  return {pending,evaluatedCount,providerCalls:0,operationId};
 }
 async resumePublicationIndex(id){
  const source=await this.loadSource(id),marker=source?.video?.contextual_catalogue_event;
  if(!marker||marker.type!=='publicationAccepted'||marker.reelId!==id||typeof marker.id!=='string')return {pending:false,committed:false,reason:'NO_PUBLISHED_INDEX_INTENT',providerCalls:0};
  return this.project(id,{type:'publicationAccepted',eventId:marker.id});
 }

 async snapshot(items=null){return this.repository.contextualContributions(items??await this.repository.items());}
 async overview({snapshot=null}={}){
  snapshot??=await this.snapshot();
  const taxonomy=(Object.hasOwn(snapshot,'taxonomySnapshot')?snapshot.taxonomySnapshot:await this.store.get('settings/reels_v2_taxonomy'))?.data??{},view=buildContextualCatalogue(snapshot.contributions,{inventoryIds:snapshot.inventoryIds,observedAt:this.now(),dataAsOf:snapshot.dataAsOf??this.now(),sourceStale:snapshot.sourceStale,nodes:taxonomy.nodes??[],incremental:{enabled:snapshot.active===true,eventDriven:true,noProviders:true}});
  // Explicit human membership remains visible without being mislabeled proof.
  for(const f of view.formats){
   const manualIds=list(snapshot.items).filter(i=>i.categoryResolution?.mode==='manual'&&i.categoryIds.includes(f.categoryId)).map(i=>i.id);
   f.automaticCount=f.count;f.manualCount=manualIds.filter(id=>!f.matchingIds.includes(id)).length;f.matchingIds=[...new Set([...f.matchingIds,...manualIds])].sort();f.count=f.matchingIds.length;
   const node=list(taxonomy.nodes).find(n=>n.id===f.categoryId);if(node?.manual){f.label=node.name;f.parentCategoryId=node.parentId;}
  }
  return {...view,active:snapshot.active===true,pendingEvents:snapshot.pendingEvents??null};
 }
 async matchingIds(query={}){
  const snapshot=await this.snapshot(),taxonomy=(await this.store.get('settings/reels_v2_taxonomy'))?.data??{};
  let ids=catalogueMatchingIds(snapshot.contributions,query,taxonomy.nodes??[]);
  if(/^ctx_format_(single_recipe|recipe_collection)$/.test(query.category??'')){
   const {category,...extra}=query,parsed=normalizeCatalogueQuery(extra).query,hasExtra=!!parsed.context||!!parsed.q||parsed.facets.length>0,eligible=hasExtra?new Set(catalogueMatchingIds(snapshot.contributions,extra,taxonomy.nodes??[])):null;
   const manual=list(snapshot.items).filter(i=>i.categoryResolution?.mode==='manual'&&i.categoryIds.includes(query.category)&&(!eligible||eligible.has(i.id))).map(i=>i.id);
   if(!normalizeCatalogueQuery(query).impossible)ids=[...new Set([...ids,...manual])];
  }
  return {ids,observedAt:this.now(),dataAsOf:snapshot.dataAsOf,sourceStale:snapshot.sourceStale,versionHash:snapshot.versionHash};
 }
}
