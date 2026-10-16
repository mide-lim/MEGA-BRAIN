import {createHash} from 'node:crypto';
import {parseReelLinks} from './links.mjs';
import {projectReel,reelDetail,matchesReel,eligibility,reelIdPattern,REEL_LIST_FIELDS,initialReelsTaxonomy} from './reels-model.mjs';
const invalid=message=>Object.assign(Error(message),{status:400,code:'INVALID_QUERY'});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class ReelsRepository{
 constructor({store,clock=Date.now,cacheTtlMs=15000}){if(!Number.isFinite(cacheTtlMs)||cacheTtlMs<0||cacheTtlMs>60000)throw Error('TTL inválido.');this.store=store;this.clock=clock;this.cacheTtlMs=cacheTtlMs;this.snapshot=null;this.pending=null;this.cacheEpoch=0;}
 now(){return new Date(this.clock()).toISOString();}
 async raw(id){if(!reelIdPattern.test(id??''))throw invalid('Reel inválido.');return (await this.store.get(`videos/${id}`))?.data??null;}
 async refresh(id){this.cacheEpoch++;if(this.snapshot)this.snapshot.expiresAt=0;const v=await this.raw(id);return v?projectReel(v):null;}
 observation(){return {observedAt:this.snapshot?.observedAt??null,cache:{ttlMs:this.cacheTtlMs,stale:this.snapshot?.stale??false}};}
 async detail(id){const v=await this.raw(id);return v?reelDetail(v):null;}
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
  this.pending=(async()=>{try{const records=await this.scan('videos',REEL_LIST_FIELDS),items=records.map(({data,path})=>projectReel({...data,id:data.id??path.split('/')[1]}));const now=this.clock();this.snapshot={items,observedAt:new Date(now).toISOString(),expiresAt:epoch===this.cacheEpoch?now+this.cacheTtlMs:0,stale:false};return items;}catch(error){if(!this.snapshot)throw error;this.snapshot.stale=true;return this.snapshot.items;}finally{this.pending=null;}})();
  return this.pending;
 }
 validateQuery(q){
  for(const [field,allowed]of Object.entries({workspace:['all','library'],sort:['newest','oldest','title'],status:['registered','queued','running','waiting','completed','failed','uncertain'],stage:['acquisition','transcription','analysis']}))if(q[field]&&(field==='status'?!String(q[field]).split(',').every(v=>allowed.includes(v)):!allowed.includes(q[field])))throw invalid('Filtro inválido.');
  for(const field of ['q','category','language','tag','worker','destination'])if(q[field]!==undefined&&(typeof q[field]!=='string'||q[field].length>500))throw invalid('Filtro inválido.');
 }
 async matching(query={}){
  const items=await this.items();if(!query.category)return items.filter(x=>matchesReel(x,query));
  const taxonomy=(await this.store.get('settings/reels_v2_taxonomy'))?.data??initialReelsTaxonomy(items),ids=new Set([query.category]);let added=true;
  while(added){added=false;for(const node of taxonomy.nodes??[])if(ids.has(node.parentId)&&!ids.has(node.id)){ids.add(node.id);added=true;}}
  const {category,...rest}=query;return items.filter(x=>matchesReel(x,rest)&&x.categoryIds.some(id=>ids.has(id)));
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
 async summary(){const counts={registered:0,queued:0,running:0,waiting:0,completed:0,published:0,attention:0,total:0};for(const i of await this.items()){counts.total++;if(Object.hasOwn(counts,i.status))counts[i.status]++;if(i.publication.available)counts.published++;if(['uncertain','failed'].includes(i.status))counts.attention++;}return {counts,...this.observation(),processingAllowed:false,processingReason:'Processamento real desabilitado nesta entrega.'};}
 async queues(){const items=await this.items(),config=Object.fromEntries(await Promise.all(['acquisition','transcription','analysis'].map(async id=>[id,(await this.store.get('reels_controls/'+id))?.data??{}])));return {stages:['acquisition','transcription','analysis'].map(id=>{const rows=items.filter(i=>i.stage===id),c=config[id]??{};return {id,name:{acquisition:'Aquisição',transcription:'Transcrição',analysis:'Análise'}[id],...Object.fromEntries(['queued','running','waiting','failed','uncertain'].map(s=>[s,rows.filter(i=>i.status===s).length])),paused:c.paused??true,desiredConcurrency:c.desiredConcurrency??null,effectiveConcurrency:c.effectiveConcurrency??null,...this.observation()};}),processingAllowed:false,processingReason:'Processamento real desabilitado nesta entrega.'};}
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
 async categories(){
  const items=(await this.items()).filter(x=>x.publication.available&&x.categoryIds.length),t=(await this.store.get('settings/reels_v2_taxonomy'))?.data??initialReelsTaxonomy(items),nodes=Array.isArray(t.nodes)?t.nodes:[],byId=new Map(nodes.map(n=>[n.id,n]));
  const memberships=new Map(nodes.map(n=>[n.id,new Set()])),direct=new Map(nodes.map(n=>[n.id,new Set()]));
  for(const item of items)for(const cid of item.categoryIds){direct.get(cid)?.add(item.id);let id=cid;const seen=new Set();while(byId.has(id)&&!seen.has(id)){seen.add(id);memberships.get(id).add(item.id);id=byId.get(id).parentId;}}
  return {nodes:nodes.map(n=>({...n,patterns:(t.rules??[]).filter(r=>r.kind==='structured_recurrence'&&r.enabled!==false&&r.categoryId===n.id).map(r=>({label:n.name??n.id,support:r.support?.length??0,meetsMinimum:r.meetsMinimum??null,observedAt:r.observedAt??null})),count:memberships.get(n.id).size,directCount:direct.get(n.id).size,evidenceCount:n.evidenceCount??null,manual:n.manual??false})),total:new Set(items.filter(i=>i.categoryIds.some(id=>byId.has(id))).map(i=>i.id)).size,revision:t.revision??0,...this.observation()};
 }
 async finance({from,to}={}){for(const d of [from,to])if(d!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(d))throw invalid('Data inválida.');const f=(await this.store.get('settings/reels_v2_finance'))?.data??{};const days=(Array.isArray(f.days)?f.days:[]).filter(d=>(!from||d.day>=from)&&(!to||d.day<=to)).map(d=>Object.fromEntries(['day','admitted','completed','published','failed','estimatedUsd','measuredUsd','billed','uncertain'].map(k=>[k,d[k]??null])));return {days,budget:f.budget??{amount:null,currency:null},coverage:f.coverage??null,observedAt:this.now(),note:'Estimativas e medições não equivalem a faturamento confirmado. Fuso America/Sao_Paulo; orçamento informativo.'};}
}
export default ReelsRepository;
