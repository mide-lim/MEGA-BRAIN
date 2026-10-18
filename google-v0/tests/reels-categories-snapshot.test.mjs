import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {contextualHash} from '../lib/reels-contextual-projection.mjs';
import {makeSemanticFixture} from './reels-semantic-fixture.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';

async function setup({separateDerivedReads=false}={}){
 const fixture=makeSemanticFixture(),store=memoryReelsStore();
 for(const row of fixture.documents)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 let time=Date.parse('2026-10-18T00:30:00.000Z');
 const clock=()=>time,repository=new ReelsRepository({store,clock,cacheTtlMs:60000}),catalogue=new ReelsCatalogueRuntime({repository,clock}),semantic=new ReelsSemanticCurator({repository,clock});
 await store.create('settings/reels_v2_contextual_catalogue',{schemaVersion:1,status:'active',policyVersion:'saved-publication-catalogue-v1',dataAsOf:fixture.saved.dataAsOf});
 for(const review of fixture.saved.formatReviews)await store.create('reels_index/contextual_review_'+review.reelId,{kind:'contextual_review',reelId:review.reelId,reviewHash:contextualHash(review),review});
 for(const row of fixture.saved.catalog)assert.equal((await catalogue.project(row.id,{type:'baselinePublicationRegistered'})).committed,true);
 const created=await semantic.command({action:'group_create',idempotencyKey:'snapshot-test-create',name:'Grupo editorial de teste',parentId:'receitas',definition:'Recorte manual de uma publicação sintética.',aliases:[]});
 await semantic.command({action:'group_assign',idempotencyKey:'snapshot-test-assign',groupId:created.group.id,revision:created.group.revision,reelIds:['QaFull_single']});
 if(separateDerivedReads){
  // Reference composition: the same real calculators perform their own reads,
  // as before request-local sharing. No alternate projection is mocked.
  const overview=catalogue.overview.bind(catalogue),fresh=semantic.freshGroups.bind(semantic);
  catalogue.overview=()=>overview();semantic.freshGroups=()=>fresh();
 }
 const api=reelsAPI({repository,semantic,authorize:async()=>true,sameOrigin:async()=>true,clock});
 const get=async()=>{const response=await api(new Request('https://fixture.invalid/api/reels/categories'));return {status:response.status,data:await response.json()};};
 return {store,repository,catalogue,semantic,get,groupId:created.group.id,advance:()=>{time+=1000;}};
}
const sourceReads=store=>Object.fromEntries(['videos','reels_legacy_content'].map(collection=>[collection,store.reads.filter(r=>r.collection===collection).length]));
const reset=store=>{store.reads.length=0;};
const node=(data,id)=>data.nodes.find(n=>n.id===id);

test('categories share one fresh metadata scan pair cold and warm while preserving real derived output',async()=>{
 const shared=await setup(),reference=await setup({separateDerivedReads:true});
 reset(shared.store);const cold=await shared.get();assert.equal(cold.status,200);assert.deepEqual(sourceReads(shared.store),{videos:1,reels_legacy_content:1});
 // The comparison uses independent reads with the same source epochs.
 const expected=await reference.repository.categories();assert.deepEqual(cold.data,expected);
 assert.equal(node(cold.data,'ctx_format_single_recipe').count,1);
 assert.equal(node(cold.data,'ctx_format_recipe_collection').count,1);
 assert.equal(node(cold.data,'semantic_'+shared.groupId).count,1);
 assert.equal(cold.data.revision,13);assert.equal(cold.data.cache.stale,false);
 assert.ok(!JSON.stringify(cold.data).includes('taxonomySnapshot'));
 await shared.repository.items();reset(shared.store);
 const warm=await shared.get();assert.equal(warm.status,200);assert.deepEqual(sourceReads(shared.store),{videos:1,reels_legacy_content:1});
 assert.deepEqual(warm.data,cold.data);
 assert.equal(shared.repository.snapshot.expiresAt>shared.repository.clock(),true);
});

test('a new GET observes current manual revision and invalidates old source/semantic proofs despite a warm item cache',async()=>{
 const s=await setup();await s.repository.items();assert.equal((await s.get()).status,200);
 const taxonomy=await s.store.get('settings/reels_v2_taxonomy'),video=await s.store.get('videos/QaFull_single');
 await s.store.patch('settings/reels_v2_taxonomy',{revision:14,nodes:[...taxonomy.data.nodes,{id:'manual-food',name:'Meu preparo',parentId:'receitas',manual:true}]},{updateTime:taxonomy.updateTime});
 await s.store.patch('videos/QaFull_single',{analysis_generation:'9',categoryIds:['manual-food'],taxonomy_override:{manual:true,revision:14}},{updateTime:video.updateTime});
 s.advance();reset(s.store);const fresh=await s.get();assert.equal(fresh.status,200);assert.deepEqual(sourceReads(s.store),{videos:1,reels_legacy_content:1});
 assert.equal(fresh.data.revision,14);assert.equal(node(fresh.data,'manual-food').count,1);assert.equal(node(fresh.data,'manual-food').manual,true);
 assert.equal(node(fresh.data,'ctx_format_single_recipe').count,0);
 assert.equal(node(fresh.data,'semantic_'+s.groupId).count,0);
 assert.equal(fresh.data.cache.stale,true);
 assert.equal(fresh.data.observedAt,new Date(s.repository.clock()).toISOString());
 assert.deepEqual(s.store.docs.get('videos/QaFull_single').data.taxonomy_override,{manual:true,revision:14});
});

test('failed fresh category metadata cannot be replaced by a warm item cache labeled fresh',async()=>{
 const s=await setup();await s.repository.items();assert.equal((await s.get()).status,200);
 const query=s.store.query;s.store.query=async(collection,...args)=>{if(collection==='videos')throw Error('Synthetic metadata unavailable');return query(collection,...args);};
 const failed=await s.get();assert.ok(failed.status>=500);assert.equal(failed.data.nodes,undefined);assert.equal(failed.data.cache?.stale===false,false);
 s.store.query=query;s.advance();reset(s.store);
 const recovered=await s.get();assert.equal(recovered.status,200);assert.equal(recovered.data.cache.stale,false);assert.deepEqual(sourceReads(s.store),{videos:1,reels_legacy_content:1});
});

test('sharing keeps review-hash and contribution-content validation fail closed',async()=>{
 const s=await setup(),reviewPath='reels_index/contextual_review_QaFull_single',review=await s.store.get(reviewPath);
 await s.store.patch(reviewPath,{reviewHash:'0'.repeat(64)},{updateTime:review.updateTime});
 const revoked=await s.get();assert.equal(revoked.status,200);assert.equal(node(revoked.data,'ctx_format_single_recipe').count,0);assert.equal(revoked.data.cache.stale,true);
 const contributionPath='reels_index/contextual_QaFull_many',contribution=await s.store.get(contributionPath);
 await s.store.patch(contributionPath,{contentHash:'0'.repeat(64)},{updateTime:contribution.updateTime});
 const invalid=await s.get();assert.ok(invalid.status>=500);assert.equal(invalid.data.nodes,undefined);
});

test('default semantic inventory still reads new epochs and does not reuse the category snapshot',async()=>{
 const s=await setup();await s.get();reset(s.store);
 const before=await s.semantic.inventory(),video=await s.store.get('videos/QaFull_single');
 await s.store.patch('videos/QaFull_single',{analysis_generation:'11'},{updateTime:video.updateTime});
 const after=await s.semantic.inventory();assert.notEqual(before.sourceVersions.get('QaFull_single').video,after.sourceVersions.get('QaFull_single').video);
 assert.deepEqual(sourceReads(s.store),{videos:2,reels_legacy_content:2});
});
