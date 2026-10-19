import test from 'node:test';import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null};}};return store;}
const clock=()=>Date.parse('2026-10-16T03:30:00Z');
const reel=(id='Reel_001',extra={})=>({id,status:'registered',created_at:'2026-10-16T03:00:00Z',...extra});
const pub=(id='Reel_001',extra={})=>reel(id,{status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'original',evidence:{categories:[]}},...extra});
import {ReelsFinance} from '../lib/reels-finance.mjs';
import {measureGeminiUsage,measureSpeechUsage} from '../lib/usage-costs.mjs';
test('finance BRT day boundaries and unknown costs never become zero or billed USD conversion',async()=>{const store=memory(),repository=new ReelsRepository({store,clock}),finance=new ReelsFinance({repository,clock});await store.create('reels_executions/one',{id:'one',reelId:'Reel_001',stage:'analysis',status:'completed',createdAt:'2026-10-16T02:59:59Z',completedAt:'2026-10-16T03:00:01Z',rawResult:{valid:true}});const r=await finance.read({from:'2026-10-15',to:'2026-10-16'});assert.equal(r.days[0].admitted,1);assert.equal(r.days[1].completed,1);assert.equal(r.days[1].published,1);assert.equal(r.days[0].estimatedUsd,null);assert.equal(r.days[1].measuredUsd,null);assert.equal(r.days[1].billed,null);assert.equal(r.coverage.billing,null);assert.equal(r.budget.amount,null);});
test('budget informative null/editable idempotent and cost sources stay distinct',async()=>{const store=memory(),repository=new ReelsRepository({store,clock}),finance=new ReelsFinance({repository,clock});const input={idempotencyKey:'budget-key-123',amount:100,currency:'BRL'};await finance.update(input);await finance.update(input);await assert.rejects(()=>finance.update({...input,amount:200}),e=>e.code==='IDEMPOTENCY_CONFLICT');assert.equal((await finance.read()).budget.amount,100);await finance.update({idempotencyKey:'budget-key-456',amount:null,currency:'BRL'});assert.equal((await finance.read()).budget.amount,null);assert.equal(await store.get('settings/financial'),null);});



test('daily production counts terminal analysis per Reel, not intermediate stages or repeated complements',async()=>{
 const store=memory(),finance=new ReelsFinance({repository:new ReelsRepository({store,clock}),clock});
 for(const [id,stage]of [['acq','acquisition'],['stt','transcription'],['analysis','analysis'],['complement','analysis']])await store.create('reels_executions/'+id,{id,reelId:'Reel_001',stage,status:'completed',createdAt:'2026-10-16T03:00:00Z',completedAt:'2026-10-16T04:00:00Z',rawResult:{valid:true}});
 const day=(await finance.read()).days[0];assert.equal(day.admitted,1);assert.equal(day.completed,1);assert.equal(day.published,1);assert.equal(day.estimatedUsd,null);
 await assert.rejects(()=>finance.read({from:'2026-02-30',to:'2026-03-01'}),e=>e.code==='INVALID_RANGE');
});

test('finance scans projected job metadata and never reads complete provider reports',async()=>{
 const store=memory(),query=store.query,calls=[];store.list=()=>assert.fail('full collection scan forbidden');store.query=async(c,q)=>{calls.push(q);return query(c,q);};
 const finance=new ReelsFinance({repository:new ReelsRepository({store,clock}),clock});await finance.read();assert.equal(calls.length,1);assert.ok(calls[0].select.includes('rawResult.finance'));assert.equal(calls[0].select.includes('rawResult'),false);assert.equal(calls[0].select.includes('rawResult.changes'),false);
});

test('usage recorded after the BRT day boundary is distinct from BRL quotes and official billing',async()=>{
 const store=memory(),finance=new ReelsFinance({repository:new ReelsRepository({store,clock}),clock});
 const measurement=measureSpeechUsage({metadata:{totalBilledDuration:'60s'}},{model:'chirp_3',location:'us',mode:'synchronous'});
 await store.create('reels_executions/speech',{id:'speech',reelId:'Reel_001',stage:'transcription',status:'completed',createdAt:'2026-10-16T02:59:59Z',resultSavedAt:'2026-10-16T03:00:01Z',rawResult:{finance:{estimate:{amount:1.23,currency:'BRL',source:'configured_quote'},estimatedUsd:null,measuredUsd:0.016,measurement}}});
 await store.create('settings/reels_v2_finance',{days:[{day:'2026-10-16',billed:{amount:0.02,currency:'USD'}}],coverage:{billing:{source:'official-export',observedAt:'2026-10-16T03:20:00Z'}}});
 const result=await finance.read({from:'2026-10-15',to:'2026-10-16'}),[before,after]=result.days;
 assert.equal(before.estimatedUsd,null);assert.deepEqual(before.estimatedByCurrency,{BRL:1.23});assert.equal(before.measuredUsd,null);assert.equal(after.measuredUsd,0.016);assert.equal(after.estimatedUsd,null);assert.deepEqual(after.billed,{amount:0.02,currency:'USD'});
 assert.equal(result.coverage.measured.records,1);assert.equal(result.coverage.measured.lastMeasurementAt,'2026-10-16T03:00:01Z');assert.equal(result.coverage.measured.rateVersions,measurement.rate_version);assert.equal(result.coverage.measured.billingConfirmed,false);assert.equal(result.coverage.measured.currency,'USD');assert.match(result.coverage.measured.source,/rawResult.finance/);assert.equal(result.coverage.billing.source,'official-export');
});

test('measured partial coverage includes saved rejected candidates and never fabricates zero for gaps',async()=>{
 const store=memory(),finance=new ReelsFinance({repository:new ReelsRepository({store,clock}),clock});
 const measurement=measureGeminiUsage({usageMetadata:{trafficType:'ON_DEMAND',promptTokenCount:1000,candidatesTokenCount:100,totalTokenCount:1100}},{model:'gemini-3.5-flash-lite'});
 await store.create('reels_executions/legacy-gap',{id:'legacy-gap',reelId:'Reel_002',stage:'transcription',status:'completed',createdAt:'2026-10-16T03:00:00Z',completedAt:'2026-10-16T04:00:00Z'});
 for(const [id,value]of [['saved',{measurement,measuredUsd:999}],['unknown',{measurement:{status:'unavailable',reason:'missing_usage'},measuredUsd:999}]])await store.create('reels_executions/'+id,{id,reelId:'Reel_001',stage:'analysis',status:'failed',createdAt:'2026-10-16T03:00:00Z',resultSavedAt:'2026-10-16T04:00:00Z',rawResult:{valid:false,finance:value}});
 const result=await finance.read();assert.equal(result.days[0].measuredUsd,0.00055);assert.equal(result.days[0].billed,null);assert.equal(result.days[0].published,0);assert.equal(result.coverage.measured.records,1);assert.equal(result.coverage.measured.unavailableRecords,2);
 const onlyUnknown=await finance.read({from:'2026-10-15',to:'2026-10-15'});assert.equal(onlyUnknown.days[0].measuredUsd,null);assert.equal(onlyUnknown.coverage.measured,null);
});

test('saved-source validation usage remains separate and adds to the correct BRT day without double counting analysis',async()=>{
 const store=memory(),finance=new ReelsFinance({repository:new ReelsRepository({store,clock}),clock}),measurement=measureGeminiUsage({usageMetadata:{trafficType:'ON_DEMAND',promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150}},{model:'gemini-3.5-flash-lite'});
 await store.create('reels_executions/validated',{id:'validated',reelId:'Reel_001',stage:'analysis',status:'failed',createdAt:'2026-10-16T02:00:00Z',resultSavedAt:'2026-10-16T02:59:59Z',rawResult:{finance:{measurement,qualityValidation:{validationId:'fixture',observedAt:'2026-10-16T03:00:01Z',measurement}}}});
 const result=await finance.read({from:'2026-10-15',to:'2026-10-16'});assert.equal(result.days[0].measuredUsd,measurement.list_price_micro_usd/1e6);assert.equal(result.days[1].measuredUsd,measurement.list_price_micro_usd/1e6);assert.equal(result.coverage.measured.records,2);assert.equal(result.days[1].billed,null);
});
