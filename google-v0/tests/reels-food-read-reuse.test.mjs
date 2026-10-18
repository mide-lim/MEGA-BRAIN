import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {ReelsContextualCurator} from '../lib/reels-contextual-curation.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {contextualHash} from '../lib/reels-contextual-projection.mjs';
import {makeSemanticFixture} from './reels-semantic-fixture.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';

async function setup({separateCategoryRead=false}={}){
 const fixture=makeSemanticFixture(),store=memoryReelsStore();
 for(const row of fixture.documents)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 // The real application also lists unpublished operational registrations.
 for(let i=0;i<1042;i++)await store.create('videos/ReadReg_'+String(i).padStart(4,'0'),{id:'ReadReg_'+String(i).padStart(4,'0'),status:'registered',title:'Registro sintético '+i});
 const tax=await store.get('settings/reels_v2_taxonomy');
 await store.patch('settings/reels_v2_taxonomy',{revision:14,nodes:[...tax.data.nodes,{id:'manual-food',name:'Preparos editoriais',parentId:'receitas',manual:true}]},{updateTime:tax.updateTime});
 for(const id of ['QaFull_single','QaFull_many']){const video=await store.get('videos/'+id);await store.patch('videos/'+id,{categoryIds:['manual-food'],taxonomy_override:{manual:true,revision:14}},{updateTime:video.updateTime});}
 let time=Date.parse('2026-10-18T00:30:00.000Z');const clock=()=>time,repository=new ReelsRepository({store,clock,cacheTtlMs:60000}),catalogue=new ReelsCatalogueRuntime({repository,clock}),semantic=new ReelsSemanticCurator({repository,clock});
 await store.create('settings/reels_v2_contextual_catalogue',{schemaVersion:1,status:'active',policyVersion:'saved-publication-catalogue-v1',dataAsOf:fixture.saved.dataAsOf});
 for(const review of fixture.saved.formatReviews)await store.create('reels_index/contextual_review_'+review.reelId,{kind:'contextual_review',reelId:review.reelId,reviewHash:contextualHash(review),review});
 for(const row of fixture.saved.catalog)assert.equal((await catalogue.project(row.id,{type:'baselinePublicationRegistered'})).committed,true);
 const created=await semantic.command({action:'group_create',idempotencyKey:'read-reuse-create',name:'Seleção manual',parentId:'manual-food',definition:'Recorte editorial sintético.',aliases:[]});
 await semantic.command({action:'group_assign',idempotencyKey:'read-reuse-assign',groupId:created.group.id,revision:created.group.revision,reelIds:['QaFull_unknown']});
 const contextual=new ReelsContextualCurator({repository,clock});
 if(separateCategoryRead){const categories=repository.categories.bind(repository);repository.categories=()=>categories();}
 const api=reelsAPI({repository,semantic,contextual,authorize:async()=>true,sameOrigin:async()=>true,clock});
 const get=async path=>{const response=await api(new Request('https://fixture.invalid/api/reels/'+path));return {status:response.status,data:await response.json()};};
 return {store,repository,semantic,contextual,get,advance:()=>{time+=1000;}};
}
const reset=store=>{store.reads.length=0;};
const reads=store=>Object.fromEntries(['videos','reels_legacy_content'].map(collection=>[collection,store.reads.filter(r=>r.collection===collection).length]));
const expectedPass={videos:2,reels_legacy_content:1};
const selected=data=>data.items.map(x=>x.id).sort();

test('contextual HTTP read shares one projected scan pass with its real category projection',async()=>{
 const s=await setup(),reference=await setup({separateCategoryRead:true});
 reset(s.store);const result=await s.get('contextual');assert.equal(result.status,200);assert.deepEqual(reads(s.store),expectedPass);
 const expected=await reference.get('contextual');assert.equal(expected.status,200);assert.deepEqual(result.data,expected.data);
 assert.equal(result.data.acceptedInventory,5);
 const queries=s.store.reads.filter(r=>['videos','reels_legacy_content'].includes(r.collection));
 assert.ok(queries.every(r=>!r.select.includes('analysis')&&!r.select.includes('transcript')&&!r.select.includes('source_caption')));
 // Warm caches do not authorize stale source metadata or add a second scan.
 await s.repository.items();reset(s.store);
 const warm=await s.get('contextual');assert.equal(warm.status,200);assert.deepEqual(reads(s.store),expectedPass);assert.deepEqual(warm.data,result.data);
});

test('ordinary library category pagination shares fresh versions with nonempty semantic memberships',async()=>{
 const s=await setup();await s.repository.items();reset(s.store);
 const first=await s.get('items?workspace=library&category=manual-food&limit=2');assert.equal(first.status,200);assert.equal(first.data.total,3);assert.deepEqual(reads(s.store),expectedPass);
 assert.equal(first.data.items.length,2);assert.ok(first.data.nextCursor);
 reset(s.store);const last=await s.get('items?workspace=library&category=manual-food&limit=2&cursor='+encodeURIComponent(first.data.nextCursor));assert.equal(last.status,200);assert.equal(last.data.total,3);assert.deepEqual(reads(s.store),expectedPass);
 assert.deepEqual([...new Set([...selected(first.data),...selected(last.data)])].sort(),['QaFull_many','QaFull_single','QaFull_unknown']);
 const source=await s.store.get('videos/QaFull_unknown');await s.store.patch('videos/QaFull_unknown',{analysis_generation:'99'},{updateTime:source.updateTime});
 s.advance();reset(s.store);const changed=await s.get('items?workspace=library&category=manual-food&limit=25');assert.equal(changed.status,200);assert.equal(changed.data.total,2);assert.deepEqual(selected(changed.data),['QaFull_many','QaFull_single']);assert.deepEqual(reads(s.store),expectedPass);
 assert.equal(changed.data.observedAt,new Date(s.repository.clock()).toISOString());
});

test('fresh taxonomy epochs invalidate contextual node metadata and failed scans never become fresh cache hits',async()=>{
 const s=await setup();await s.get('contextual');const taxonomy=await s.store.get('settings/reels_v2_taxonomy');
 await s.store.patch('settings/reels_v2_taxonomy',{revision:15,nodes:taxonomy.data.nodes.map(n=>n.id==='manual-food'?{...n,name:'Título manual atualizado'}:n)},{updateTime:taxonomy.updateTime});
 s.advance();reset(s.store);const snapshot=await s.contextual.snapshotData();assert.deepEqual(reads(s.store),expectedPass);assert.equal(snapshot.nodes.find(n=>n.id==='manual-food').name,'Título manual atualizado');
 const query=s.store.query;s.store.query=async(collection,...args)=>{if(collection==='videos')throw Error('Synthetic source metadata unavailable');return query(collection,...args);};
 const failed=await s.get('contextual');assert.equal(failed.status,503);assert.equal(failed.data.code,'SERVICE_UNAVAILABLE');assert.equal(failed.data.items,undefined);
 s.store.query=query;
 const recovered=await s.get('contextual');assert.equal(recovered.status,200);assert.equal((await s.store.get('settings/reels_v2_taxonomy')).data.revision,15);
});

test('non-library partitions and default execution inventories keep their existing boundaries',async()=>{
 const s=await setup();
 const all=await s.get('items?workspace=all&limit=100');assert.equal(all.status,200);assert.equal(all.data.total,1047);
 const ready=await s.get('items?workspace=ready&limit=100');assert.equal(ready.status,200);assert.equal(ready.data.total,1042);
 const first=await s.semantic.inventory(),video=await s.store.get('videos/QaFull_single');await s.store.patch('videos/QaFull_single',{analysis_generation:'100'},{updateTime:video.updateTime});
 const second=await s.semantic.inventory();assert.notEqual(first.sourceVersions.get('QaFull_single').video,second.sourceVersions.get('QaFull_single').video);
});
