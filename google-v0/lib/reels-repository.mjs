import {createHash} from 'node:crypto';
import {validateContextualContribution,contextualCataloguePolicy} from './reels-contextual-catalogue.mjs';
import {contextualHash} from './reels-contextual-projection.mjs';
import {catalogueManifestActive,catalogueManifestPath,catalogueEditorialForItem} from './reels-contextual-catalogue-runtime.mjs';
import {withFiniteContextualProofs} from './reels-contextual-calibration.mjs';
import {verifyPublicationQualityReceipt,qualityReceiptIdPattern} from './reels-quality-gate.mjs';
import {parseReelLinks} from './links.mjs';
import {buildQueueCuration} from './reels-quality-diagnostics.mjs';
import {projectReel,reelDetail,projectExecution,matchesReel,eligibility,reelIdPattern,publicationAvailable,REEL_LIST_FIELDS,REEL_EXECUTION_FIELDS,categoryNavigation} from './reels-model.mjs';
import {LEGACY_LIST_FIELDS,withPreservedSummary,preservedDetail,preservedRecordAvailable,HISTORICAL_FIELDS,historicalActivity,HISTORICAL_FINANCE_FIELDS,historicalFinance} from './reels-preserved-content.mjs';
const invalid=message=>Object.assign(Error(message),{status:400,code:'INVALID_QUERY'});
const hasContextualFilters=query=>{let facets=[];if(query.facets!==undefined&&query.facets!==''){try{facets=JSON.parse(query.facets);}catch{throw invalid('Facetas inválidas.');}if(!Array.isArray(facets)||facets.length>8)throw invalid('Facetas inválidas.');}return facets.length>0||['context','dimension','value'].some(field=>query[field]!==undefined&&query[field]!==null&&query[field]!=='');};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const executionOrder=(a,b)=>{const left=a.queuedAt??a.createdAt,right=b.queuedAt??b.createdAt;if(left!==right)return left===null?1:right===null?-1:left<right?-1:1;const rank={acquisition:0,transcription:1,analysis:2};return (a.attempt??0)-(b.attempt??0)||(rank[a.stage]??3)-(rank[b.stage]??3)||String(a.id??'').localeCompare(String(b.id??''));};
export class ReelsRepository{
 constructor({store,clock=Date.now,cacheTtlMs=15000}){if(!Number.isFinite(cacheTtlMs)||cacheTtlMs<0||cacheTtlMs>60000)throw Error('TTL inválido.');this.store=store;this.clock=clock;this.cacheTtlMs=cacheTtlMs;this.snapshot=null;this.pending=null;this.cacheEpoch=0;this.qualitySnapshot=null;this.qualityPending=null;}
 now(){return new Date(this.clock()).toISOString();}
 async raw(id){if(!reelIdPattern.test(id??''))throw invalid('Reel inválido.');return (await this.store.get(`videos/${id}`))?.data??null;}
 async navigation(items,saved){
  if(this.catalogueEnabled){
   const protectedIds=new Set((saved?.assignments??[]).filter(a=>a.manual===true).flatMap(a=>a.categoryIds??[]));
   const historicalIds=new Set((saved?.rules??[]).filter(r=>r.kind==='calibrated_ingredient_any').map(r=>r.categoryId));
   const view=saved?{...saved,nodes:(saved.nodes??[]).filter(n=>!historicalIds.has(n.id)||n.manual===true||protectedIds.has(n.id))}:saved;
   return categoryNavigation(items,view);
  }
  const proved=await withFiniteContextualProofs(items,saved,{loadSource:async id=>{
   const video=await this.raw(id);if(!video)return null;
   const legacy=publicationAvailable(video)?null:(await this.store.get('reels_legacy_content/'+id))?.data??null;
   let qualityVerification=null;
   if(video.analysis?.contextualSignals?.version===2&&qualityReceiptIdPattern.test(video.publication?.qualityReceipt?.receiptId??'')){
    const receipt=(await this.store.get('reels_quality_receipts/'+video.publication.qualityReceipt.receiptId))?.data;
    qualityVerification=verifyPublicationQualityReceipt({video,receipt});
   }
   return {video,legacy,qualityVerification};
  }});
  return categoryNavigation(proved,saved);
 }
 async refresh(id){this.cacheEpoch++;if(this.snapshot)this.snapshot.expiresAt=0;const v=await this.raw(id);const legacy=v?(await this.store.get('reels_legacy_content/'+id))?.data:null;return v?(await this.navigation([withPreservedSummary(projectReel(v),legacy)],(await this.store.get('settings/reels_v2_taxonomy'))?.data)).items[0]:null;}
 observation(){return {observedAt:this.snapshot?.observedAt??null,cache:{ttlMs:this.cacheTtlMs,stale:this.snapshot?.stale??false}};}
 async executionHistory(id){
  if(!reelIdPattern.test(id??''))throw invalid('Reel inválido.');
  const items=[],seen=new Set();let cursor,lastCursor=null;
  do{const page=await this.store.query('reels_executions',{select:REEL_EXECUTION_FIELDS,filters:[{field:'reelId',op:'eq',value:id}],orderBy:[{field:'__name__',direction:'ASCENDING'}],limit:100,cursor});
   for(const record of page.records){if(record.data.reelId!==id)throw Error('Execução fora do Reel solicitado.');items.push(projectExecution({...record.data,id:record.data.id??record.path.split('/').at(-1)}));}
   lastCursor=page.lastCursor??page.nextCursor??lastCursor;cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Trajetória não avançou.');if(cursor)seen.add(cursor);
  }while(cursor);
  return {items:items.sort(executionOrder),cursor:lastCursor,observedAt:this.now()};
 }
 async detail(id){const v=await this.raw(id);if(!v)return null;const legacy=(await this.store.get('reels_legacy_content/'+id))?.data,saved=preservedDetail(legacy,id),base=withPreservedSummary(reelDetail(v),legacy);if(saved){if(base.publication.source==='legacy_preserved'){base.analysis=saved;}else base.preservedAnalysis=saved;}if(preservedRecordAvailable(legacy,id)&&base.transcript.state==='missing'&&typeof legacy.transcript==='string')base.transcript={state:legacy.transcript.trim()?'present':'empty',text:legacy.transcript,segments:null,source:'legacy_preserved'};const detail=(await this.navigation([base],(await this.store.get('settings/reels_v2_taxonomy'))?.data)).items[0],history=await this.executionHistory(id),hasNew=history.items.length>0,inlineLegacy=detail.executions?.length>0;return {...detail,executions:hasNew?history.items:inlineLegacy?detail.executions.sort(executionOrder):null,executionsHistory:{source:hasNew?'reels-v2':inlineLegacy?'legacy':'none',cursor:hasNew?history.cursor:null,observedAt:history.observedAt,complete:inlineLegacy&&!hasNew?null:true}};}
 async scan(collection,select){
  if(typeof this.store.query!=='function')throw Error('Store requer consulta projetada; leitura integral não permitida.');
  const records=[];let cursor;const seen=new Set();
  do{const page=await this.store.query(collection,{select,limit:500,cursor});records.push(...page.records);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Consulta não avançou.');if(cursor)seen.add(cursor);}while(cursor);
  return records;
 }
 async items(){
  if(this.snapshot&&this.snapshot.expiresAt>this.clock())return this.snapshot.items;
  if(this.pending)return this.pending;
  const epoch=this.cacheEpoch;
  this.pending=(async()=>{try{const [records,legacyRecords]=await Promise.all([this.scan('videos',REEL_LIST_FIELDS),this.scan('reels_legacy_content',LEGACY_LIST_FIELDS)]),legacy=new Map(legacyRecords.map(({data,path})=>[path.split('/')[1],data])),items=(await this.navigation(records.map(({data,path})=>{const id=data.id??path.split('/')[1];return withPreservedSummary(projectReel({...data,id}),legacy.get(id));}),(await this.store.get('settings/reels_v2_taxonomy'))?.data)).items;const now=this.clock();this.snapshot={items,observedAt:new Date(now).toISOString(),expiresAt:epoch===this.cacheEpoch?now+this.cacheTtlMs:0,stale:false};return items;}catch(error){if(!this.snapshot)throw error;this.snapshot.stale=true;return this.snapshot.items;}finally{this.pending=null;}})();
  return this.pending;
 }
 async contextualContributions(cachedItems=null){
  const [records,legacyRecords,manifestSnapshot,taxonomySnapshot]=await Promise.all([this.scan('videos',REEL_LIST_FIELDS),this.scan('reels_legacy_content',LEGACY_LIST_FIELDS),this.store.get(catalogueManifestPath),this.store.get('settings/reels_v2_taxonomy')]);
  const legacy=new Map(legacyRecords.map(r=>[r.path.split('/')[1],r])),versions=new Map(),rawItems=[];
  for(const r of records){const id=r.data.id??r.path.split('/')[1],old=legacy.get(id);versions.set(id,{video:r.updateTime,...(!publicationAvailable({...r.data,id})&&old?{legacy:old.updateTime}:{})});rawItems.push(withPreservedSummary(projectReel({...r.data,id}),old?.data));}
  const taxonomy=taxonomySnapshot?.data??{},items=categoryNavigation(rawItems,taxonomy).items.filter(i=>i.publication.available),inventoryIds=items.map(i=>i.id).sort(),byId=new Map(items.map(i=>[i.id,i]));
  const active=catalogueManifestActive(manifestSnapshot?.data),contributions=[];let sourceStale=false;
  if(active){
   const [rows,reviewRows]=await Promise.all([this.scanContextualIndex(),this.scanContextualReviews()]);
   const reviews=new Map(reviewRows.map(r=>[r.data.reelId,r.data.reviewHash]));
   for(const {data:c} of rows){
    if(c.status!=='active'||!byId.has(c.reelId))continue;
    validateContextualContribution(c);
    const current=versions.get(c.reelId),item=byId.get(c.reelId),ed=catalogueEditorialForItem(item,taxonomy);
    if(c.entry.formatReview&&reviews.get(c.reelId)!==c.entry.formatReview.reviewHash){sourceStale=true;continue;}
    if(!current?.video||c.sourceVersions.video!==current.video||(c.sourceVersions.legacy??null)!==(current.legacy??null)||c.editorialHash!==contextualHash(ed)){sourceStale=true;continue;}
    contributions.push(c);
   }
  }
  if(taxonomy.pendingOperationId)sourceStale=true;
  const dataAsOf=contributions.length?contributions.map(c=>c.observedAt).filter(Boolean).sort()[0]:manifestSnapshot?.data?.dataAsOf??this.now();
  return {active,contributions,inventoryIds,items,sourceStale,dataAsOf,versionHash:contextualHash({active,contributions:contributions.map(c=>[c.reelId,c.idempotencyKey]),inventoryIds,sourceStale}),sourceVersions:versions,taxonomySnapshot,observedAt:this.now()};
 }
 async scanContextualReviews(){
  const records=[];let cursor;const seen=new Set();
  do{const page=await this.store.query('reels_index',{select:['kind','reelId','reviewHash'],filters:[{field:'kind',op:'eq',value:'contextual_review'}],limit:500,cursor});records.push(...page.records);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Revisões contextuais não avançaram.');if(cursor)seen.add(cursor);}while(cursor);
  return records;
 }

 async scanContextualIndex(){
  const records=[];let cursor;const seen=new Set();
  do{const page=await this.store.query('reels_index',{select:['schemaVersion','kind','policyVersion','status','reelId','sourceIdentity','sourceProofHash','ruleHash','editorialHash','sourceVersions','editorial','entry','observedAt','processingStarted','providerCalls','contentHash','idempotencyKey'],filters:[{field:'kind',op:'eq',value:'contextual_contribution'}],limit:500,cursor});records.push(...page.records);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Índice contextual não avançou.');if(cursor)seen.add(cursor);}while(cursor);
  return records;
 }

 validateQuery(q){
  for(const [field,allowed]of Object.entries({workspace:['all','library','ready','attention'],attentionKind:['confirmed','uncertain'],sort:['newest','oldest','title'],status:['registered','queued','running','waiting','completed','failed','uncertain'],stage:['acquisition','transcription','analysis']}))if(q[field]&&(field==='status'?!String(q[field]).split(',').every(v=>allowed.includes(v)):!allowed.includes(q[field])))throw invalid('Filtro inválido.');
  for(const field of ['q','category','language','tag','worker','destination','context','dimension','value','semanticFacet','curationDomainId'])if(q[field]!==undefined&&(typeof q[field]!=='string'||q[field].length>500))throw invalid('Filtro inválido.');
  if(q.facets!==undefined&&(typeof q.facets!=='string'||q.facets.length>4096))throw invalid('Facetas inválidas.');
  if(hasContextualFilters(q)&&q.workspace!=='library')throw invalid('Facetas contextuais pertencem ao acervo publicado.');
 }
 async matching(query={}){
  this.validateQuery(query);
  if(query.curationDomainId!==undefined){if(query.workspace!=='library'||!this.semanticDomains)throw invalid('Área de curadoria indisponível.');const selected=new Set(await this.semanticDomains.matchingIds(query.curationDomainId)),{curationDomainId,...rest}=query;return (await this.matching(rest)).filter(i=>selected.has(i.id));}
  const semanticId=query.semanticFacet??(/^semantic_[a-f0-9]{64}$/.test(query.category??'')?query.category.slice(9):null);
  if(semanticId){if(query.workspace!=='library'||!this.semanticCurator||!/^[a-f0-9]{64}$/.test(semanticId))throw invalid('Filtro semântico inválido.');const ids=new Set(await this.semanticCurator.matchingIds(semanticId,{facet:!!query.semanticFacet})),{semanticFacet,category,...rest}=query;return (await this.matching({...rest,...(category&&!category.startsWith('semantic_')?{category}:{})})).filter(i=>ids.has(i.id));}
  if(this.catalogueRuntime&&/^ctx_format_(single_recipe|recipe_collection)$/.test(query.category??'')){
   const matched=await this.catalogueRuntime.matchingIds(query),{category,...rest}=query,extra=this.semanticCurator?await this.semanticCurator.formatIds(category.slice(11)):[],eligible=hasContextualFilters(rest)?new Set((await this.catalogueRuntime.matchingIds(rest)).ids):null,selected=new Set([...matched.ids,...extra.filter(id=>!eligible||eligible.has(id))]);
   return (await this.items()).filter(item=>item.publication.available&&selected.has(item.id)&&matchesReel(item,rest));
  }
  const refine=async rows=>{if(!hasContextualFilters(query))return rows;if(typeof this.contextualMatchingIds!=='function')throw Object.assign(Error('Índice contextual indisponível.'),{status:503,code:'CONTEXT_UNAVAILABLE'});const matched=await this.contextualMatchingIds(query),ids=Array.isArray(matched)?matched:matched?.ids;if(!Array.isArray(ids))throw Error('Resposta contextual inválida.');const selected=new Set(ids);return rows.filter(item=>item.publication.available&&selected.has(item.id));};
  const navigation=await this.navigation(await this.items(),(await this.store.get('settings/reels_v2_taxonomy'))?.data),items=navigation.items;
  if(!query.category)return refine(items.filter(x=>matchesReel(x,query)));
  const {taxonomy}=navigation,ids=new Set([query.category]);let added=true;
  while(added){added=false;for(const node of taxonomy.nodes??[])if(ids.has(node.parentId)&&!ids.has(node.id)){ids.add(node.id);added=true;}}
  const {category,...rest}=query,semanticMembers=this.semanticCurator?new Set(await this.semanticCurator.categoryIds(category)):new Set();return refine(items.filter(x=>matchesReel(x,rest)&&(x.categoryIds.some(id=>ids.has(id))||semanticMembers.has(x.id))));
 }
 async list(query={}){
  this.validateQuery(query);const limit=Number(query.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw invalid('Limite inválido.');
  const {cursor,limit:unused,...filters}=query,hash=digest(filters),sort=query.sort??'newest';
  const key=i=>[sort==='title'?(i.title??'').toLocaleLowerCase('pt-BR'):(i.createdAt??''),i.id];
  const compare=(a,b)=>{const x=key(a),y=key(b),d=x[0]<y[0]?-1:x[0]>y[0]?1:0;return (sort==='newest'?-d:d)||(x[1]<y[1]?-1:x[1]>y[1]?1:0);};
  const rows=(await this.matching(query)).sort(compare);let start=0;
  if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw invalid('Cursor inválido.');}if(c.hash!==hash||!Array.isArray(c.key)||c.key.length!==2)throw invalid('Cursor não corresponde à consulta.');start=rows.findIndex(x=>{const k=key(x),d=k[0]<c.key[0]?-1:k[0]>c.key[0]?1:0;return ((sort==='newest'?-d:d)||(k[1]<c.key[1]?-1:k[1]>c.key[1]?1:0))>0;});if(start<0)start=rows.length;}
  const page=rows.slice(start,start+limit);return {items:page,total:rows.length,nextCursor:start+limit<rows.length?Buffer.from(JSON.stringify({hash,key:key(page.at(-1))})).toString('base64url'):null,...this.observation()};
 }
 async summary(){const counts={registered:0,queued:0,running:0,waiting:0,completed:0,published:0,attention:0,ready:0,confirmedFailures:0,inconclusive:0,total:0,totalInventory:0};for(const i of await this.items()){counts.total++;if(Object.hasOwn(counts,i.status))counts[i.status]++;if(i.publication.available)counts.published++;if(eligibility(i)===null)counts.ready++;if(!i.publication.available){if(i.status==='failed')counts.confirmedFailures++;if(i.status==='uncertain')counts.inconclusive++;if(['uncertain','failed'].includes(i.status))counts.attention++;}counts.totalInventory=counts.total;}return {counts,...this.observation(),processingAllowed:false,processingReason:'Processamento real desabilitado nesta entrega.'};}
 async queues(){const items=await this.items(),config=Object.fromEntries(await Promise.all(['acquisition','transcription','analysis'].map(async id=>[id,(await this.store.get('reels_controls/'+id))?.data??{}])));return {stages:['acquisition','transcription','analysis'].map(id=>{const rows=items.filter(i=>i.stage===id),c=config[id]??{};return {id,name:{acquisition:'Aquisição',transcription:'Transcrição',analysis:'Análise'}[id],...Object.fromEntries(['queued','running','waiting','failed','uncertain'].map(s=>[s,rows.filter(i=>i.status===s).length])),paused:c.paused??true,desiredConcurrency:c.desiredConcurrency??null,effectiveConcurrency:c.effectiveConcurrency??null,...this.observation()};}),processingAllowed:false,processingReason:'Processamento real desabilitado nesta entrega.'};}
 async quality(query={}){
  const items=await this.items(),epoch=this.cacheEpoch,now=this.clock();
  if(!this.qualitySnapshot||this.qualitySnapshot.expiresAt<=now||this.qualitySnapshot.epoch!==epoch){
   if(!this.qualityPending)this.qualityPending=(async()=>{let executions=[],executionAvailability='available';try{executions=(await this.scan('reels_executions',[...REEL_EXECUTION_FIELDS,'cohortId'])).map(({data,path})=>({...projectExecution({...data,id:data.id??path.split('/').at(-1)}),cohortId:data.cohortId}));}catch{executionAvailability='unavailable';}const at=this.clock();this.qualitySnapshot={executions,executionAvailability,observedAt:new Date(at).toISOString(),expiresAt:at+this.cacheTtlMs,epoch};})().finally(()=>{this.qualityPending=null;});
   await this.qualityPending;
  }
  const snapshot=this.qualitySnapshot,{limit=50,cursor=null,...filters}=query;
  return {...buildQueueCuration({items,executions:snapshot.executions,observedAt:snapshot.observedAt,executionAvailability:snapshot.executionAvailability,filters,limit:Number(limit),cursor}),catalogueObservation:this.observation()};
 }
 async select(selection){
  let rows,total,excluded=[];
  if(selection?.all===true&&!selection.ids){this.validateQuery(selection.filters??{});rows=await this.matching(selection.filters??{});total=rows.length;}
  else if(Array.isArray(selection?.ids)&&selection.ids.length&&selection.ids.length<=20000&&selection.ids.every(x=>reelIdPattern.test(x))){const ids=[...new Set(selection.ids)],map=new Map((await this.items()).map(x=>[x.id,x]));rows=ids.map(id=>map.get(id)).filter(Boolean);excluded=ids.filter(id=>!map.has(id)).map(id=>({id,reason:'not_found'}));total=ids.length;}
  else throw invalid('Seleção inválida.');
  if(this.snapshot?.stale)throw Object.assign(Error('Atualize o acervo antes de selecionar processamento.'),{status:503,code:'STALE_SELECTION'});
  const ids=[];for(const i of rows){const reason=eligibility(i);if(reason)excluded.push({id:i.id,reason});else ids.push(i.id);}ids.sort();return {ids,eligible:ids.length,total,excluded};
 }
 async registerLinks(text){const links=parseReelLinks(text);let created=0;const now=this.now();for(const {id,url}of links){if((await this.store.create(`videos/${id}`,{id,source_url:url,status:'registered',stage:null,created_at:now,updated_at:now,media_verified:false,video_key:null,video_generation:null,source_caption:null,caption_status:'missing',transcript:null,analysis:null,error:null})).created)created++;}if(created){this.cacheEpoch++;if(this.snapshot)this.snapshot.expiresAt=0;}return {created,alreadyPresent:links.length-created,automaticProcessingStarted:false};}
 async events(filters={}){
  const limit=Number(filters.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw invalid('Limite inválido.');
  const where=Object.entries({stage:filters.stage,worker:filters.worker,reelId:filters.reelId,level:filters.level}).filter(([,v])=>v).map(([field,value])=>({field,op:'eq',value}));
  const p=await this.store.query('reels_events',{filters:where,orderBy:[{field:'__name__',direction:'ASCENDING'}],limit,cursor:filters.cursor});return {items:p.records.map(({data,path})=>({...data,id:data.id??path.split('/')[1]})),nextCursor:p.lastCursor??p.nextCursor??filters.cursor??null,hasMore:!!p.nextCursor,observedAt:this.now()};
 }
 async historicalActivity(filters={}){
  const limit=Number(filters.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw invalid('Limite inválido.');
  for(const name of ['stage','worker','reelId','sourceStatus'])if(filters[name]!==undefined&&(typeof filters[name]!=='string'||!/^[A-Za-z0-9_.:-]{1,80}$/.test(filters[name])))throw invalid('Filtro histórico inválido.');
  const where=Object.entries({stage:filters.stage,worker:filters.worker,reelId:filters.reelId,sourceStatus:filters.sourceStatus}).filter(([,v])=>v).map(([field,value])=>({field,op:'eq',value}));
  const page=await this.store.query('reels_historical_activity',{select:HISTORICAL_FIELDS,filters:where,orderBy:[{field:'__name__',direction:'ASCENDING'}],limit,cursor:filters.cursor});
  // Detached historical rows stay in the global archive. A reset/new registration
  // must never regain its previous operational history via a detail page.
  const items=page.records.map(({data})=>historicalActivity(data)).filter(row=>!filters.reelId||!row.detached);
  return {items,nextCursor:page.nextCursor??null,hasMore:!!page.nextCursor,historical:true,executable:false,observedAt:this.now(),note:'Arquivo preservado, somente leitura. Estados antigos não representam filas ou execuções atuais.'};
 }
 async historicalFinance(){
  const records=await this.scan('reels_historical_finance',HISTORICAL_FINANCE_FIELDS),entries=records.map(({data})=>historicalFinance(data)),groups=new Map();
  for(const e of entries){const key=[e.day??'',e.kind,e.currency??''].join(':');let g=groups.get(key);if(!g){g={day:e.day,kind:e.kind,currency:e.currency,amount:null,knownRecords:0,unknownRecords:0,billed:null};groups.set(key,g);}if(e.amount===null)g.unknownRecords++;else{g.amount=(g.amount??0)+e.amount;g.knownRecords++;}}
  return {groups:[...groups.values()].sort((a,b)=>(b.day??'').localeCompare(a.day??'')||a.kind.localeCompare(b.kind)),coverage:{records:entries.length,unknownAmounts:entries.filter(e=>e.amount===null).length,withoutDate:entries.filter(e=>e.day===null).length,billingConfirmed:false,costsComplete:false},historical:true,executable:false,observedAt:this.now(),note:'Contabilidade antiga e reservas não são fatura nem produção atual. Valores sem data permanecem sem alocação diária; ausência não significa zero.'};
 }
 async categories(){
  // Share only this request's fresh metadata. Paid execution never uses it.
  const snapshot=this.catalogueRuntime?await this.contextualContributions():null;
  const sourceItems=snapshot?snapshot.items:await this.items();
  const taxonomySnapshot=snapshot?snapshot.taxonomySnapshot:await this.store.get('settings/reels_v2_taxonomy');
  const navigation=await this.navigation(sourceItems,taxonomySnapshot?.data),items=navigation.items.filter(x=>x.publication.available&&x.categoryIds.length),t=navigation.taxonomy,nodes=t.nodes,byId=new Map(nodes.map(n=>[n.id,n]));
  const memberships=new Map(nodes.map(n=>[n.id,new Set()])),direct=new Map(nodes.map(n=>[n.id,new Set()]));
  for(const item of items)for(const cid of item.categoryIds){direct.get(cid)?.add(item.id);let id=cid;const seen=new Set();while(byId.has(id)&&!seen.has(id)){seen.add(id);memberships.get(id).add(item.id);id=byId.get(id).parentId;}}
  const [catalogue,semanticState]=await Promise.all([
   this.catalogueRuntime?this.catalogueRuntime.overview({snapshot}):null,
   this.semanticCurator?this.semanticCurator.freshGroups(snapshot?{inventorySnapshot:snapshot,taxonomySnapshot}:{}):null
  ]);
  const ordinary=nodes.filter(n=>!/^ctx_format_(single_recipe|recipe_collection)$/.test(n.id));
  const mapped=ordinary.map(n=>({...n,editorialOwner:n.id.startsWith('ctx_')?'catalogue':'taxonomy',actionCapabilities:{createChild:!n.id.startsWith('ctx_'),rename:!n.id.startsWith('ctx_'),move:!n.id.startsWith('ctx_'),merge:!n.id.startsWith('ctx_'),assign:!n.id.startsWith('ctx_'),segment:false},patterns:(t.rules??[]).filter(r=>r.kind==='structured_recurrence'&&r.enabled!==false&&r.categoryId===n.id).map(r=>({label:n.name??n.id,support:r.support?.length??0,meetsMinimum:r.meetsMinimum??null,observedAt:r.observedAt??null})),count:memberships.get(n.id).size,directCount:direct.get(n.id).size,evidenceCount:n.evidenceCount??null,manual:n.manual??false}));
  for(const f of catalogue?.formats??[]){const saved=nodes.find(n=>n.id===f.categoryId);mapped.push({...saved,id:f.categoryId,name:saved?.manual?saved.name:f.label,parentId:saved?.manual?saved.parentId:'receitas',manual:saved?.manual??false,count:new Set([...f.matchingIds,...(this.semanticCurator?await this.semanticCurator.formatIds(f.value,semanticState):[])]).size,directCount:new Set([...f.matchingIds,...(this.semanticCurator?await this.semanticCurator.formatIds(f.value,semanticState):[])]).size,patterns:[],editorialOwner:'catalogue',actionCapabilities:{createChild:false,rename:false,move:false,merge:false,assign:false,segment:false},format:f.value,filter:f.filter});}
  if(this.semanticCurator){for(const n of await this.semanticCurator.nodes(semanticState)){const old=mapped.find(x=>x.id===n.id);if(!old)mapped.push(n);}for(const n of mapped.filter(n=>!n.semantic&&!n.format)){const ids=await this.semanticCurator.categoryIds(n.id,semanticState);n.count=new Set([...(memberships.get(n.id)??[]),...ids]).size;}}
  const label=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
  const visible=mapped.filter(n=>!(n.format&&!n.manual&&/^ctx_format_(single_recipe|recipe_collection)$/.test(n.id)&&n.count===0&&mapped.some(s=>s.id!==n.id&&s.manual===true&&s.parentId===n.parentId&&s.count>0&&label(s.name)===label(n.name))));
  return {nodes:visible,total:new Set(items.filter(i=>i.categoryIds.some(id=>byId.has(id))).map(i=>i.id)).size,revision:t.revision??0,compatibility:t.compatibility,...(snapshot?{observedAt:snapshot.observedAt,cache:{ttlMs:0,stale:snapshot.sourceStale}}:this.observation())};
 }
 async finance({from,to}={}){for(const d of [from,to])if(d!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(d))throw invalid('Data inválida.');const f=(await this.store.get('settings/reels_v2_finance'))?.data??{};const days=(Array.isArray(f.days)?f.days:[]).filter(d=>(!from||d.day>=from)&&(!to||d.day<=to)).map(d=>Object.fromEntries(['day','admitted','completed','published','failed','estimatedUsd','measuredUsd','billed','uncertain'].map(k=>[k,d[k]??null])));return {days,budget:f.budget??{amount:null,currency:null},coverage:f.coverage??null,observedAt:this.now(),note:'Estimativas e medições não equivalem a faturamento confirmado. Fuso America/Sao_Paulo; orçamento informativo.'};}
}
export default ReelsRepository;
