import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFullCatalogueFixture} from './reels-contextual-catalogue-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime,catalogueManifestPath} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {contextualCataloguePolicy} from '../lib/reels-contextual-catalogue.mjs';
import {contextualHash} from '../lib/reels-contextual-projection.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
const clone=v=>structuredClone(v);
const request=(path,body)=>new Request('https://reels.test/api/reels/'+path,body?{method:'POST',headers:{origin:'https://reels.test','content-type':'application/json'},body:JSON.stringify(body)}:{});
function memory(){
 const docs=new Map(),calls=[];let tick=0,writes=0,replacements=0;
 const version=()=>new Date(Date.parse('2026-10-18T01:00:00.000Z')+(++tick)).toISOString();
 const projected=(data,select)=>{if(!select)return clone(data);const result={};for(const field of select){const keys=field.split('.');let value=data;for(const k of keys)value=value?.[k];if(value===undefined)continue;let at=result;for(const k of keys.slice(0,-1))at=at[k]??={};at[keys.at(-1)]=clone(value);}return result;};
 const store={docs,calls,get writes(){return writes;},get replacements(){return replacements;},
  put(path,data,updateTime=version()){docs.set(path,{data:clone(data),updateTime});},
  async get(path){calls.push({method:'get',path});return clone(docs.get(path)??null);},
  async create(path,data){if(docs.has(path))return {created:false};writes++;store.put(path,data);return {created:true,...clone(docs.get(path))};},
  async patch(path,data,{updateTime}={}){const old=docs.get(path);if(old?.updateTime!==updateTime)throw Object.assign(Error('CAS mismatch'),{status:412});writes++;store.put(path,{...old.data,...clone(data)});return clone(docs.get(path));},
  async query(collection,{select,filters=[],limit=500,cursor}={}){calls.push({method:'query',collection,select:clone(select)});let rows=[...docs].filter(([p])=>p.startsWith(collection+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,r])=>r.data[f.field]===f.value);const offset=Number(cursor??0);return {records:rows.slice(offset,offset+limit).map(([path,r])=>({path,data:projected(r.data,select),updateTime:r.updateTime})),nextCursor:offset+limit<rows.length?String(offset+limit):null};},
  async compareAndReplaceDerived({path,replacement,checks}){calls.push({method:'cas',path,checks:clone(checks)});if(checks.some(c=>(docs.get(c.path)?.updateTime??null)!==c.updateTime))return {applied:false};writes++;replacements++;store.put(path,replacement);return {applied:true,updateTime:docs.get(path).updateTime};}
 };return store;
}
async function setup({active=true,overlap=false}={}){
 const input=makeFullCatalogueFixture(),store=memory();
 for(const row of input.records){const source=JSON.parse(row.sourceJson);store.put('videos/'+source.item.id,source.video,source.sourceUpdateTime.video);if(source.legacy)store.put('reels_legacy_content/'+source.item.id,source.legacy,source.sourceUpdateTime.legacy);}
 if(overlap){const legacy=JSON.parse(input.records[4].sourceJson).legacy;store.put('reels_legacy_content/QaFull_single',{...legacy,reelId:'QaFull_single'},input.dataAsOf);}
 store.put('settings/reels_v2_taxonomy',{revision:13,nodes:input.taxonomy.nodes});
 if(active)store.put(catalogueManifestPath,{status:'active',policyVersion:contextualCataloguePolicy.version,dataAsOf:input.dataAsOf});
 for(const review of input.formatReviews)store.put('reels_index/contextual_review_'+review.reelId,{kind:'contextual_review',reelId:review.reelId,reviewHash:contextualHash(review),review});
 const repository=new ReelsRepository({store,clock:()=>Date.parse(input.observedAt),cacheTtlMs:60000}),runtime=new ReelsCatalogueRuntime({repository,clock:()=>Date.parse(input.observedAt)}),api=reelsAPI({repository,authorize:()=>true,sameOrigin:()=>true,clock:()=>Date.parse(input.observedAt)});
 return {input,store,repository,runtime,api,async seed(){for(const row of input.catalog){const result=await runtime.project(row.id,{type:'baselinePublicationRegistered'});assert.equal(result.pending,true,JSON.stringify(result));assert.equal(result.committed,true,JSON.stringify(result));}}};
}
async function seed(x){for(const row of x.input.catalog){const result=await x.runtime.project(row.id,{type:'baselinePublicationRegistered'});assert.equal(result.committed,true,JSON.stringify(result));}}
async function json(x,path,body){const r=await x.api(request(path,body));assert.equal(r.status,200,await r.clone().text());return r.json();}
test('manifest activation is explicit: GET never prepares sources or exposes a partial bootstrap',async()=>{
 const x=await setup({active:false}),before=clone([...x.store.docs]),view=await json(x,'curation/catalogue');
 assert.equal(view.projectionCoverage.inventoryCount,5);assert.equal(view.projectionCoverage.evaluatedCount,0);assert.equal(view.projectionCoverage.missingCount,5);assert.equal(view.incremental.enabled,false);assert.deepEqual([...x.store.docs],before);
 const pending=await x.runtime.project('QaFull_single');assert.equal(pending.pending,true);assert.equal(pending.reason,'CATALOGUE_BOOTSTRAP_NOT_ACTIVE');assert.equal(x.store.docs.has('reels_index/contextual_QaFull_single'),false);assert.equal(x.store.docs.has(catalogueManifestPath),false);
});
test('actual API consumes durable source-bound contributions, filters before pagination and hydrates only one detail',async()=>{
 const x=await setup();await seed(x);x.store.calls.length=0;const before=x.store.writes;
 const view=await json(x,'curation/catalogue');assert.equal(view.projectionCoverage.evaluatedCount,5);assert.deepEqual(view.formats.map(f=>[f.value,f.count]),[['single_recipe',1],['recipe_collection',1]]);
 const list=await json(x,'items?workspace=library&category=ctx_format_single_recipe&limit=1');assert.equal(list.total,1);assert.deepEqual(list.items.map(i=>i.id),['QaFull_single']);assert.equal(list.items[0].creator,'@fixture');
 const tree=await json(x,'categories');assert.equal(tree.nodes.find(n=>n.id==='ctx_format_single_recipe').count,1);
 assert.equal(x.store.writes,before);assert.ok(!x.store.calls.some(c=>c.method==='get'&&/^(videos|reels_legacy_content)\//.test(c.path)),'overview/list/tree use projected metadata only');
 assert.ok(x.store.calls.filter(c=>c.method==='query'&&['videos','reels_legacy_content'].includes(c.collection)).every(c=>c.select&&!c.select.includes('transcript')&&!c.select.includes('analysis')));
 x.store.calls.length=0;const detail=await json(x,'contextual/QaFull_single');assert.equal(detail.id,'QaFull_single');assert.ok(JSON.stringify(detail).includes('tempere o frango'));
 assert.deepEqual(x.store.calls.filter(c=>c.method==='get'&&c.path.startsWith('videos/')).map(c=>c.path),['videos/QaFull_single']);
});
test('native source authority excludes unused legacy backups from both reader and CAS checks',async()=>{
 const x=await setup({overlap:true});await seed(x);
 const path='reels_index/contextual_QaFull_single',before=clone(x.store.docs.get(path));
 assert.deepEqual(Object.keys(before.data.sourceVersions),['video']);
 const source=await x.runtime.loadSource('QaFull_single');assert.equal(source.legacy,null);assert.ok(!source.checks.some(c=>c.path==='reels_legacy_content/QaFull_single'));
 const old=x.store.docs.get('reels_legacy_content/QaFull_single');x.store.put('reels_legacy_content/QaFull_single',{...old.data,analysis:{...old.data.analysis,summary:'Backup changed independently.'}});
 const view=await json(x,'curation/catalogue');assert.equal(view.projectionCoverage.evaluatedCount,5);assert.equal(view.sourceStale,false);assert.equal(view.formats[0].count,1);assert.deepEqual(x.store.docs.get(path),before);
 const legacy=x.store.docs.get('reels_legacy_content/QaFull_legacy');x.store.put('reels_legacy_content/QaFull_legacy',{...legacy.data,analysis:{...legacy.data.analysis,summary:'Primary historical source changed.'}});
 const stale=await json(x,'curation/catalogue');assert.equal(stale.projectionCoverage.evaluatedCount,4);assert.equal(stale.projectionCoverage.missingCount,1);assert.equal(stale.sourceStale,true);
});
test('fresh source versions revoke a cached format; replacement is bounded, full and idempotent',async()=>{
 const x=await setup();await seed(x);await x.repository.items();
 const target='reels_index/contextual_QaFull_single',other='reels_index/contextual_QaFull_many',untouched=clone(x.store.docs.get(other)),prior=x.store.docs.get(target);
 x.store.docs.set(target,{...prior,data:{...prior.data,obsoleteDerivedMarker:true}});
 const raw=x.store.docs.get('videos/QaFull_single');x.store.put('videos/QaFull_single',{...raw.data,analysis_generation:'8',source_caption:{...raw.data.source_caption,capture_id:'capture-revision-8'}});
 const stale=await json(x,'curation/catalogue');assert.equal(stale.formats[0].count,0);assert.equal(stale.projectionCoverage.missingCount,1);
 const changed=await x.runtime.project('QaFull_single',{type:'sourceCorrected'});assert.equal(changed.committed,true);assert.equal(x.store.docs.get(target).data.obsoleteDerivedMarker,undefined);assert.equal(x.store.docs.get(target).data.entry.format.state,'present_unverified');assert.deepEqual(x.store.docs.get(other),untouched);
 const replacements=x.store.replacements,writes=x.store.writes;assert.equal((await x.runtime.project('QaFull_single',{type:'sourceCorrected'})).action,'noop');assert.equal(x.store.replacements,replacements);assert.equal(x.store.writes,writes);
});
test('review metadata revocation invalidates only its former derived format',async()=>{
 const x=await setup();await seed(x);x.store.docs.delete('reels_index/contextual_review_QaFull_single');
 const view=await json(x,'curation/catalogue');assert.equal(view.projectionCoverage.missingCount,1);assert.equal(view.formats[0].count,0);
 assert.equal((await x.runtime.project('QaFull_single',{type:'editorialChanged'})).committed,true);
 const after=await json(x,'curation/catalogue');assert.equal(after.projectionCoverage.missingCount,0);assert.equal(after.formats[0].count,0);assert.equal(after.ingredients.find(i=>i.valueId==='frango').supportCount,2);
});
test('manual format membership never manufactures ingredient/unit support or overrides a contradictory context',async()=>{
 const x=await setup(),taxonomy=x.store.docs.get('settings/reels_v2_taxonomy').data;
 x.store.put('settings/reels_v2_taxonomy',{...taxonomy,nodes:[...taxonomy.nodes,{id:'ctx_format_single_recipe',name:'Minha receita',parentId:'receitas',manual:true}],assignments:[{reelId:'QaFull_unknown',categoryIds:['ctx_format_single_recipe'],manual:true,revision:14}]});
 await seed(x);
 const base=await json(x,'items?workspace=library&category=ctx_format_single_recipe');assert.deepEqual(base.items.map(i=>i.id).sort(),['QaFull_single','QaFull_unknown']);
 for(const suffix of ['&dimension=ingredient&value=frango','&facets='+encodeURIComponent(JSON.stringify([{dimension:'ingredient',value:'frango',quantifier:'SAME_UNIT'},{dimension:'tool',value:'forno',quantifier:'ANY'}])),'&context=health']){
  const filtered=await json(x,'items?workspace=library&category=ctx_format_single_recipe'+suffix);assert.ok(!filtered.items.some(i=>i.id==='QaFull_unknown'));if(suffix!=='&dimension=ingredient&value=frango')assert.equal(filtered.total,0);
 }
});
test('secondary index reconciliation works with processing disabled and no provider command',async()=>{
 const x=await setup(),raw=x.store.docs.get('videos/QaFull_single');
 x.store.put('videos/QaFull_single',{...raw.data,contextual_catalogue_event:{id:'saved-published-job',type:'publicationAccepted',reelId:'QaFull_single',status:'pending'}});
 const sourceBefore=clone(x.store.docs.get('videos/QaFull_single')),result=await json(x,'curation/catalogue',{action:'reconcile',reelIds:['QaFull_single']});
 assert.equal(result.processingStarted,false);assert.equal(result.providerCalls,0);assert.equal(result.results[0].committed,true);assert.deepEqual(x.store.docs.get('videos/QaFull_single'),sourceBefore);assert.ok(![...x.store.docs.keys()].some(p=>/^reels_(executions|operations)\//.test(p)));
 const invalid=await x.api(request('curation/catalogue',{action:'reconcile',reelIds:['QaFull_single'],formatReview:{state:'supported'}}));assert.equal(invalid.status,400);
});
test('source CAS drift defers the secondary event and never mutates the accepted source',async()=>{
 const x=await setup(),original=x.store.compareAndReplaceDerived;let attempted=0;
 x.store.compareAndReplaceDerived=async args=>{attempted++;const source=x.store.docs.get('videos/QaFull_single');x.store.put('videos/QaFull_single',{...source.data,title:'New source version'});return original(args);};
 const result=await x.runtime.project('QaFull_single');assert.equal(result.pending,true);assert.equal(result.committed,false);assert.equal(attempted,1);assert.equal(x.store.docs.has('reels_index/contextual_QaFull_single'),false);assert.ok([...x.store.docs.values()].some(v=>v.data.kind==='contextual_event'&&v.data.status==='pending'));
});
