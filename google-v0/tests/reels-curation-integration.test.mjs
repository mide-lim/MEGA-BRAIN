import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';

const clock=()=>Date.parse('2026-10-17T20:00:00Z');
const published=(id,title)=>({id,title,status:'analyzed',created_at:'2026-10-16T00:00:00Z',analysis_key:'results/'+id+'/analysis.json',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{title,summary:'Conhecimento preservado',categories:['receitas']}});
function fixture(){
 const docs=new Map([1,2,3,4,5].map(n=>['videos/Reel_00'+n,{data:published('Reel_00'+n,String.fromCharCode(64+n)),updateTime:'1'}]));
 docs.set('videos/Reel_READY',{data:{id:'Reel_READY',status:'registered'},updateTime:'1'});
 docs.set('videos/Reel_CANDIDATE',{data:{id:'Reel_CANDIDATE',status:'uncertain',analysis:{title:'Private candidate'},candidate_analysis_key:'candidate'},updateTime:'1'});
 const calls=[];let writes=0;
 const store={docs,calls,get:async path=>structuredClone(docs.get(path)??null),
  create:async()=>{writes++;throw Error('GET must never create');},patch:async()=>{writes++;throw Error('GET must never patch');},
  query:async(collection,{select,limit=100,cursor,filters=[]}={})=>{
   calls.push({collection,select,filters});let rows=[...docs].filter(([path])=>path.startsWith(collection+'/')).sort(([a],[b])=>a.localeCompare(b));
   for(const filter of filters)rows=rows.filter(([,record])=>record.data[filter.field]===filter.value);
   const offset=Number(cursor??0);return {records:rows.slice(offset,offset+limit).map(([path,record])=>({path,...structuredClone(record)})),nextCursor:offset+limit<rows.length?String(offset+limit):null};
  }};
 const repository=new ReelsRepository({store,clock});return {store,repository,writes:()=>writes};
}
const request=(path)=>new Request('https://reels.test/api/reels/'+path);
const facets=JSON.stringify([{dimension:'ingredient',value:'frango',quantifier:'ANY'}]);
const urlFor=(params)=>'items?'+new URLSearchParams(params);

test('contextual refinement precedes pagination, preserves public item shape and binds cursors to filters',async()=>{
 const f=fixture();let matchingCalls=0;
 const contextual={matchingIds:async query=>{matchingCalls++;assert.equal(query.workspace,'library');return {ids:['Reel_002','Reel_004'],versionHash:'snapshot'};}};
 const api=reelsAPI({repository:f.repository,authorize:()=>true,sameOrigin:()=>true,clock,contextual});
 const params={workspace:'library',facets,sort:'title',limit:'1'};
 const first=await api(request(urlFor(params)));assert.equal(first.status,200);const p=await first.json();
 assert.equal(p.total,2);assert.equal(p.items[0].id,'Reel_002');assert.equal(p.items[0].title,'B');assert.equal(p.items[0].publication.available,true);assert.ok(p.nextCursor);
 const second=await api(request(urlFor({...params,cursor:p.nextCursor})));assert.equal(second.status,200);const q=await second.json();assert.equal(q.total,2);assert.equal(q.items[0].id,'Reel_004');assert.equal(q.nextCursor,null);assert.equal(matchingCalls,2);
 const mismatch=await api(request(urlFor({...params,facets:JSON.stringify([{dimension:'method',value:'forno'}]),cursor:p.nextCursor})));assert.equal(mismatch.status,400);
 assert.equal(f.writes(),0);
});

test('empty contextual filters preserve entire published inventory and cannot affect processing selection',async()=>{
 const f=fixture();let matched=0;
 const api=reelsAPI({repository:f.repository,authorize:()=>true,sameOrigin:()=>true,clock,contextual:{matchingIds:async()=>{matched++;return {ids:[]};}}});
 const result=await api(request(urlFor({workspace:'library',facets:'[]',facetMode:'supported'})));assert.equal(result.status,200);const data=await result.json();assert.equal(data.total,5);assert.equal(matched,0);
 const wrongWorkspace=await api(request(urlFor({workspace:'ready',facets})));assert.equal(wrongWorkspace.status,400);assert.equal(matched,0);
 for(const invalid of ['not-json','{}',JSON.stringify(Array.from({length:9},()=>({dimension:'ingredient',value:'frango'})))]){
  assert.equal((await api(request(urlFor({workspace:'library',facets:invalid})))).status,400);
 }
 assert.equal(f.writes(),0);
});

test('curation endpoints authorize first, expose saved diagnostics only and keep GETs read-only',async()=>{
 const f=fixture(),before=structuredClone([...f.store.docs]);let contextReads=0,qualityReads=0;
 const contextual={overview:async()=>{contextReads++;return {total:5,items:[]};},detail:async id=>{contextReads++;return id==='Reel_001'?{id,publication:{available:true}}:null;}};
 const quality=f.repository.quality.bind(f.repository);f.repository.quality=async q=>{qualityReads++;return quality(q);};
 const denied=reelsAPI({repository:f.repository,authorize:()=>false,sameOrigin:()=>true,contextual,clock});
 for(const path of ['quality','contextual','contextual/Reel_001'])assert.equal((await denied(request(path))).status,401);
 assert.equal(contextReads,0);assert.equal(qualityReads,0);assert.equal(f.store.calls.length,0);
 const api=reelsAPI({repository:f.repository,authorize:()=>true,sameOrigin:()=>true,contextual,clock});
 assert.equal((await api(request('contextual'))).status,200);
 const detail=await api(request('contextual/Reel_001'));assert.equal((await detail.json()).id,'Reel_001');
 assert.equal((await api(request('contextual/Reel_ABSENT'))).status,404);
 const diagnostics=await api(request('quality?limit=10'));assert.equal(diagnostics.status,200);assert.equal(diagnostics.headers.get('cache-control'),'no-store');const result=await diagnostics.json();assert.equal(result.processingAllowed,false);
 const calls=f.store.calls.filter(call=>call.collection==='reels_executions');assert.equal(calls.length,1);
 assert.ok(calls[0].select.every(field=>!field.includes('rawResult')&&!field.includes('transcript')&&!field.includes('message')));
 assert.deepEqual([...f.store.docs],before);assert.equal(f.writes(),0);
});

test('unavailable contextual index fails closed instead of returning an unfiltered published list',async()=>{
 const f=fixture(),api=reelsAPI({repository:f.repository,authorize:()=>true,sameOrigin:()=>true,clock,contextual:{matchingIds:async()=>{throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');}}});
 const response=await api(request(urlFor({workspace:'library',facets})));assert.equal(response.status,503);assert.ok(!JSON.stringify(await response.json()).includes('PRIVATE_PROVIDER_DIAGNOSTIC'));assert.equal(f.writes(),0);
});
