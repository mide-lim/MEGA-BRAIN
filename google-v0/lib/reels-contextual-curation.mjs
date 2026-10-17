import {projectContextualPublication,contextualHash,contextualRuleHash} from './reels-contextual-projection.mjs';
import {buildContextualIndex,filterContextualEntries,parseContextualQuery,contextualListItem} from './reels-contextual-index.mjs';
import {publicationAvailable,reelIdPattern} from './reels-model.mjs';
const bad=()=>Object.assign(Error('Consulta contextual inválida.'),{status:400,code:'INVALID_CONTEXTUAL_QUERY'});
async function mapLimited(items,limit,fn){
 let cursor=0;const results=new Array(items.length);
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;results[i]=await fn(items[i]);}}));
 return results;
}
// Read-only materialization over already accepted publications. There is no
// provider, GCS-body, queue, taxonomy mutation or persistent index write here.
export class ReelsContextualCurator{
 constructor({repository,clock=Date.now,cacheTtlMs=60000,readConcurrency=8}){
  if(!repository||!Number.isFinite(cacheTtlMs)||cacheTtlMs<0||cacheTtlMs>60000||!Number.isInteger(readConcurrency)||readConcurrency<1||readConcurrency>8)throw Error('Configuração contextual inválida.');
  this.repository=repository;this.clock=clock;this.cacheTtlMs=cacheTtlMs;this.readConcurrency=readConcurrency;this.snapshot=null;this.pending=null;
 }
 invalidate(){this.snapshot=null;}
 async snapshotData(){
  const all=await this.repository.items(),items=all.filter(i=>i.publication?.available);
  const metadataHash=contextualHash({rule:contextualRuleHash,items:items.map(i=>({id:i.id,publication:i.publication,updatedAt:i.updatedAt,categories:i.categoryIds,manual:i.categoryOverride,title:i.title})).sort((a,b)=>a.id.localeCompare(b.id))});
  if(this.snapshot&&this.snapshot.metadataHash===metadataHash&&this.snapshot.expiresAt>this.clock())return this.snapshot;
  if(this.pending){await this.pending;return this.snapshotData();}
  this.pending=(async()=>{
   const started=this.clock(),entries=await mapLimited(items,this.readConcurrency,async item=>{
    let raw={},legacy=null;
    if(item.publication.source==='legacy_preserved')legacy=(await this.repository.store.get('reels_legacy_content/'+item.id))?.data;
    else{
     raw=await this.repository.raw(item.id)??{};
     if(!publicationAvailable(raw))legacy=(await this.repository.store.get('reels_legacy_content/'+item.id))?.data;
    }
    return projectContextualPublication({video:raw,legacy,item});
   });
   const categories=typeof this.repository.categories==='function'?await this.repository.categories():{nodes:[]};
   const observations=this.repository.observation?.()??{};
   this.snapshot={metadataHash,entries:entries.filter(Boolean),nodes:categories.nodes??[],observedAt:new Date(this.clock()).toISOString(),dataAsOf:observations.observedAt??new Date(started).toISOString(),expiresAt:this.clock()+this.cacheTtlMs,versionHash:contextualHash(entries.filter(Boolean).map(e=>[e.id,e.fingerprint])),missingAcceptedSource:items.length-entries.filter(Boolean).length,acceptedInventory:items.length,sourceStale:observations.cache?.stale===true};
   return this.snapshot;
  })();
  try{return await this.pending;}finally{this.pending=null;}
 }
 async matchingIds(query={}){
  const snapshot=await this.snapshotData();
  return {ids:filterContextualEntries(snapshot.entries,query,snapshot.nodes).map(e=>e.id),observedAt:snapshot.observedAt,dataAsOf:snapshot.dataAsOf,versionHash:snapshot.versionHash,stale:snapshot.sourceStale};
 }
 async overview(input={}){
  const query=parseContextualQuery(input),limit=Number(input.limit??40);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw bad();
  const snapshot=await this.snapshotData(),index=buildContextualIndex(snapshot.entries,{nodes:snapshot.nodes,query}),entries=index.entries.slice().sort((a,b)=>a.id.localeCompare(b.id)),queryHash=contextualHash(query);
  let offset=0;
  if(input.cursor){
   let c;try{c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw bad();}
   if(c.queryHash!==queryHash||c.versionHash!==snapshot.versionHash||!Number.isInteger(c.offset)||c.offset<0||c.offset>entries.length)throw bad();offset=c.offset;
  }
  const page=entries.slice(offset,offset+limit),nextCursor=offset+limit<entries.length?Buffer.from(JSON.stringify({queryHash,versionHash:snapshot.versionHash,offset:offset+limit})).toString('base64url'):null;
  const {entries:unused,...summary}=index;
  return {...summary,observedAt:snapshot.observedAt,dataAsOf:snapshot.dataAsOf,versionHash:snapshot.versionHash,sourceStale:snapshot.sourceStale,cache:{ttlMs:this.cacheTtlMs,readOnly:true},acceptedInventory:snapshot.acceptedInventory,missingAcceptedSource:snapshot.missingAcceptedSource,items:page.map(contextualListItem),nextCursor,automaticCreationEnabled:false,processingStarted:false,coverageNote:'Suporte identifica atributo sustentado na fonte publicada; não é verificação externa do fato. Ausência de campo não significa ausência no vídeo.'};
 }
 async detail(id){
  if(!reelIdPattern.test(id??''))throw bad();
  const snapshot=await this.snapshotData(),entry=snapshot.entries.find(e=>e.id===id);if(!entry)return null;
  return {...entry,observedAt:snapshot.observedAt,dataAsOf:snapshot.dataAsOf,versionHash:snapshot.versionHash,sourceStale:snapshot.sourceStale,processingStarted:false};
 }
}
export default ReelsContextualCurator;
