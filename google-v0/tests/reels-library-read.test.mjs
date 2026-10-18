import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {Firestore,encodeFields} from '../lib/firestore.mjs';
import {REEL_LIST_FIELDS} from '../lib/reels-model.mjs';

const native=(id,extra={})=>({id,status:'analyzed',analysis_key:'analysis/'+id,analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:id,categories:['food']},created_at:'2026-10-18T00:00:00Z',...extra});
const legacy=id=>({schemaVersion:1,reelId:id,status:'legacy_preserved',originalStatus:'analyzed',historical:true,executable:false,provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{summary:id,primary_category:'food'}});
const field=(v,k)=>k.split('.').reduce((a,p)=>a?.[p],v);
function fixture(){
 let time=0,version=1,fail=false,wait=null;
 const docs=new Map(),reads=[];
 const put=(path,data)=>docs.set(path,{path,data:structuredClone(data),updateTime:String(version++)});
 // Exactly499 published identities:496 native,3 legacy.2457pending stay untouched.
 for(let i=0;i<496;i++){const id='Native_'+String(i).padStart(4,'0');put('videos/'+id,native(id));}
 put('videos/Native_0001',native('Native_0001',{analysis_quality_status:null,publication:{available:true}}));
 put('videos/Native_0002',native('Native_0002',{analysis_quality_status:'review_required',candidate_analysis_key:'different'}));
 put('videos/Rejected_01',native('Rejected_01',{analysis_quality_status:'review_required',candidate_analysis_key:'analysis/Rejected_01'}));
 put('videos/EmptyPub_01',native('EmptyPub_01',{analysis_key:'',publication:{available:true}}));
 for(let i=0;i<2457;i++)put('videos/Pending_'+i,{id:'Pending_'+i,status:'registered'});
 for(let i=0;i<3;i++){const id='Legacy_'+i;put('videos/'+id,{id,status:'registered',taxonomy_override:{manual:true,revision:1},categoryIds:['child']});put('reels_legacy_content/'+id,legacy(id));}
 put('reels_legacy_content/Native_0000',legacy('Native_0000')); // overlap deduplicates
 put('reels_legacy_content/Orphan_01',legacy('Orphan_01')); // no video: excluded
 put('settings/reels_v2_taxonomy',{revision:1,nodes:[{id:'food',name:'Alimentação',parentId:null,manual:true},{id:'child',name:'Receitas',parentId:'food',manual:true}],assignments:[],rules:[],appliedCommands:[]});
 const store={
  get:async path=>docs.get(path)??null,
  query:async(collection,{filters=[],limit=1000,cursor,select})=>{
   reads.push({collection,filters,select});
   if(wait)await wait;
   if(fail&&collection==='videos')throw Error('unavailable');
   let rows=[...docs.values()].filter(r=>r.path.startsWith(collection+'/')&&filters.every(f=>field(r.data,f.field)===f.value)).sort((a,b)=>a.path.localeCompare(b.path));
   const start=Number(cursor??0),page=rows.slice(start,start+limit);
   return {records:page,nextCursor:start+limit<rows.length?String(start+limit):null};
  },
  getMany:async(paths,{select})=>{reads.push({batch:paths,select});return paths.map(p=>docs.get(p)).filter(Boolean);}
 };
 const repository=new ReelsRepository({store,clock:()=>time});repository.catalogueEnabled=true;repository.catalogueRuntime={overview:async()=>({formats:[]})};
 return {repository,store,docs,reads,put,advance:ms=>{time+=ms;},fail:v=>{fail=v;},wait:p=>{wait=p;}};
}

test('cold Library queries only published candidates and preserves all499 native/legacy identities',async()=>{
 const f=fixture(),seen=[];let cursor;
 do{const page=await f.repository.list({workspace:'library',limit:100,cursor,sort:'title'});assert.equal(page.total,499);seen.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(seen).size,499);assert.ok(!seen.includes('Rejected_01'));assert.ok(!seen.includes('EmptyPub_01'));assert.ok(!seen.includes('Orphan_01'));
 const queries=f.reads.filter(r=>r.collection);assert.equal(queries.length,4);
 assert.ok(queries.every(r=>r.filters.length===1));
 assert.equal(queries.filter(r=>r.collection==='videos').length,3);
 assert.ok(f.reads.find(r=>r.batch).batch.every(p=>p.startsWith('videos/Legacy_')||p==='videos/Orphan_01'));
 assert.ok(f.reads.every(r=>r.select&&!r.select.includes('analysis')&&!r.select.includes('transcript')));
 const branch=await f.repository.list({workspace:'library',category:'food',limit:100});assert.equal(branch.total,499);
 assert.equal((await f.repository.list({workspace:'library',category:'child'})).total,3);
 assert.equal(f.reads.filter(r=>r.collection).length,4);
});

test('parallel browse consumers coalesce; metadata edits, epoch and expiry invalidate; failed refresh retries',async()=>{
 const f=fixture();let release;f.wait(new Promise(resolve=>{release=resolve;}));
 const a=f.repository.list({workspace:'library'}),b=f.repository.categories();release();f.wait(null);
 await Promise.all([a,b]);assert.equal(f.reads.filter(r=>r.collection).length,4);
 const before=f.reads.length,tax=f.docs.get('settings/reels_v2_taxonomy');
 f.put(tax.path,{...tax.data,revision:2,nodes:tax.data.nodes.map(n=>n.id==='child'?{...n,name:'Novo nome'}:n)});
 assert.equal((await f.repository.categories()).nodes.find(n=>n.id==='child').name,'Novo nome');
 assert.ok(f.reads.length>before);
 f.repository.cacheEpoch++;await f.repository.list({workspace:'library'});const readCount=f.reads.length;
 f.advance(60001);f.fail(true);
 await assert.rejects(()=>f.repository.list({workspace:'library'}),/unavailable/);
 f.fail(false);assert.equal((await f.repository.list({workspace:'library'})).total,499);assert.ok(f.reads.length>readCount);
});

test('Library cursor rejects another filter and handles deleted boundary without duplicate IDs',async()=>{
 const f=fixture(),first=await f.repository.list({workspace:'library',limit:2,sort:'title'});
 await assert.rejects(()=>f.repository.list({workspace:'library',category:'child',sort:'title',cursor:first.nextCursor}),/Cursor/);
 f.docs.delete('videos/'+first.items.at(-1).id);f.repository.cacheEpoch++;
 const next=await f.repository.list({workspace:'library',limit:100,sort:'title',cursor:first.nextCursor});
 assert.ok(next.items.every(i=>!first.items.some(p=>p.id===i.id)));assert.equal(next.total,498);
});

test('semantic, domain, recipe-format and contextual Library filters retain the browse snapshot',async()=>{
 const f=fixture(),id='Native_0000',group='c'.repeat(64);let shared;
 const check=s=>{assert.ok(s?.inventoryIds.includes(id));shared??=s;assert.equal(s,shared);};
 f.repository.semanticCurator={
  freshGroups:async({inventorySnapshot,taxonomySnapshot})=>{check(inventorySnapshot);assert.equal(taxonomySnapshot,inventorySnapshot.taxonomySnapshot);return {browse:true};},
  matchingIds:async(g,{state})=>{assert.equal(g,group);assert.ok(state.browse);return [id];},
  categoryIds:async()=>[],
  formatIds:async(value,state)=>{assert.ok(state.browse);return [id];}
 };
 f.repository.semanticDomains={matchingIds:async(d,{snapshot})=>{check(snapshot);return [id];}};
 f.repository.catalogueRuntime.matchingIds=async(q,{snapshot})=>{check(snapshot);return {ids:[id]};};
 f.repository.contextualMatchingIds=async()=>{check(await f.repository.browseContributions());return {ids:[id]};};
 for(const filter of [{category:'semantic_'+group},{semanticFacet:group},{curationDomainId:'food'},{category:'ctx_format_single_recipe'},{context:'food'}]){
  const result=await f.repository.list({workspace:'library',...filter});
  assert.deepEqual(result.items.map(i=>i.id),[id]);assert.equal(result.total,1);
 }
 assert.equal(f.reads.filter(r=>r.collection).length,4);
 assert.ok(f.reads.filter(r=>r.collection).every(r=>r.filters.length));
});

test('operational items and semantic execution inventory keep default fresh source boundaries',async()=>{
 const f=fixture();await f.repository.list({workspace:'library'});const prior=f.reads.length;
 await f.repository.contextualContributions();const reads=f.reads.slice(prior);
 assert.ok(reads.some(r=>r.collection==='videos'&&r.filters.length===0));
 assert.ok(reads.some(r=>r.collection==='reels_legacy_content'&&r.filters.length===0));
});

test('projected batchGet validates project, duplicates, missing documents and complete response',async()=>{
 const project='megabrain-v0-test',prefix='projects/'+project+'/databases/(default)/documents/',paths=Array.from({length:201},(_,i)=>'videos/Batch_'+i),calls=[];
 const api={project,request:async(url,options)=>{calls.push({url,options});return options.json.documents.slice().reverse().map((name,i)=>i===0?{missing:name}:{found:{name,fields:encodeFields({id:name.split('/').at(-1)}),updateTime:'v1'}});}};
 const db=new Firestore(api),rows=await db.getMany(paths,{select:REEL_LIST_FIELDS});assert.equal(calls.length,3);assert.equal(rows.length,198);
 assert.ok(calls.every(c=>c.options.json.documents.length<=100&&c.options.json.mask.fieldPaths.includes('analysis.summary')));
 await assert.rejects(()=>db.getMany([paths[0],paths[0]],{select:['id']}),/inválida/);
 await assert.rejects(()=>db.getMany(['videos/../private'],{select:['id']}));
 for(const response of [
  [{found:{name:'projects/elsewhere/databases/(default)/documents/'+paths[0],fields:{},updateTime:'v1'}}],
  [{missing:prefix+paths[0]},{missing:prefix+paths[0]}],
  []
 ]){api.request=async()=>response;await assert.rejects(()=>db.getMany([paths[0]],{select:['id']}));}
});

