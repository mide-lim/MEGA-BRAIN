import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQueueCuration,qualityEvidenceStates,buildSavedQualityDiagnostics} from '../lib/reels-quality-diagnostics.mjs';
const item=(id,extra={})=>({id,title:'Receita preservada',status:'registered',publication:{available:false},media:{available:false},...extra});
const execution=(id,reelId,extra={})=>({id,reelId,stage:'analysis',worker:'analysis-worker',status:'completed',attempt:1,...extra});
test('registered inventory stays ready and historical publications never become new failures',()=>{
 const input=[item('reel_ready'),item('reel_saved',{status:'failed',error:{uncertain:false},publication:{available:true,source:'legacy_preserved',qualityStatus:'accepted'}}),item('reel_failed',{status:'failed'}),item('reel_pending',{status:'uncertain'})];
 const before=structuredClone(input),r=buildQueueCuration({items:input});
 assert.equal(r.counts.registered,1);assert.equal(r.counts.published,1);assert.equal(r.counts.confirmed_failure,1);assert.equal(r.counts.uncertain,1);
 const saved=r.items.find(i=>i.reelId==='reel_saved');
 assert.equal(saved.status,'published');assert.equal(saved.publication.qualityPolicyVersion,'historical_baseline');assert.equal(saved.publication.evidenceStatus,'present_unverified');
 assert.ok(!saved.diagnostics.some(d=>d.code==='CONFIRMED_FAILURE'));
 assert.ok(r.items.every(i=>i.diagnostics.every(d=>qualityEvidenceStates.includes(d.state))));
 assert.deepEqual(input,before);assert.equal(r.processingAllowed,false);
});
test('attempts, unique Reels and explicit cohorts have separate counts with no historical failure rate',()=>{
 const r=buildQueueCuration({items:[item('reel_a')],executions:[execution('attempt_a','reel_a',{status:'failed',cohortId:'cohort_new'}),execution('attempt_b','reel_a',{attempt:2,cohortId:'cohort_new'}),execution('old_saved','reel_a')]});
 assert.deepEqual(r.stages.find(s=>s.id==='analysis'),{id:'analysis',attempts:3,uniqueReels:1,confirmedFailures:1,uncertain:0,completed:2,active:0,queued:0});
 assert.equal(r.cohortMetrics.find(c=>c.known).stages.find(s=>s.id==='analysis').attempts,2);
 assert.equal(r.cohortMetrics.find(c=>!c.known).cohortId,null);assert.equal(r.coverage.currentFailureRate,null);
});
test('empty active queues are valid, unavailable diagnostics are not fabricated zeroes',()=>{
 const zero=buildQueueCuration();assert.equal(zero.availability.state,'available');assert.ok(zero.stages.every(s=>s.active===0));
 const missing=buildQueueCuration({items:[item('reel_a')],executionAvailability:'unavailable'});
 assert.equal(missing.availability.state,'partial');assert.equal(missing.stages,null);assert.equal(missing.cohortMetrics,null);assert.equal(missing.items[0].status,'registered');
});
test('conflicting saved execution identities are excluded instead of inflating attempts',()=>{
 const a=execution('attempt_x','reel_a'),r=buildQueueCuration({items:[item('reel_a')],executions:[a,a,{...a,status:'failed'}]});
 assert.equal(r.availability.state,'partial');assert.equal(r.availability.conflictingExecutionIdentities,1);assert.equal(r.stages.find(s=>s.id==='analysis').attempts,0);
});
test('a 3107 item inventory is paged completely and filters do not alter global stage counts',()=>{
 const items=Array.from({length:3107},(_,i)=>item('reel_'+String(i).padStart(5,'0'),{title:i%2?'Receita com frango':'Outro conteúdo',publication:{available:true,source:i%2?'native':'legacy_preserved'}}));
 let cursor=null,seen=[],r;
 do{r=buildQueueCuration({items,limit:100,cursor});seen.push(...r.items.map(i=>i.reelId));cursor=r.nextCursor;}while(cursor);
 assert.equal(seen.length,3107);assert.equal(new Set(seen).size,3107);
 const filtered=buildQueueCuration({items,filters:{q:'frango',source:'native'},executions:[execution('attempt_a','reel_00001')]});
 assert.equal(filtered.total,3107);assert.equal(filtered.matched,1553);assert.equal(filtered.items.length,50);assert.ok(filtered.nextCursor);assert.equal(filtered.stages.find(s=>s.id==='analysis').attempts,1);
 assert.throws(()=>buildQueueCuration({items,cursor:filtered.nextCursor,filters:{q:'outro'}}));
 assert.throws(()=>buildQueueCuration({items,filters:{status:'not_a_status'}}));
});
test('private provider text never reaches diagnostic rows',()=>{
 const r=buildQueueCuration({items:[item('reel_a',{status:'failed',error:{message:'Bearer PRIVATE',code:'TOKEN SECRET'}})],executions:[execution('attempt_a','reel_a',{status:'failed',error:{message:'PRIVATE',code:'SECRET WITH SPACES'}})]});
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|Bearer|SECRET/);
});

test('offline saved diagnostics keep historical results and unknown evidence separate without precision claims',()=>{
 const saved={record:{id:'reel_saved'},report:{title:'Salvo',summary:'Salvo'},historical:true};
 const before=structuredClone(saved),result=buildSavedQualityDiagnostics({candidates:[saved,saved,{record:{id:'reel_unknown'}}],observedAt:'2026-10-17T22:00:00Z'});
 assert.equal(result.candidates.length,2);assert.equal(result.coverage.historical,1);assert.equal(result.candidates.find(r=>r.reelId==='reel_saved').state,'present_unverified');assert.equal(result.candidates.find(r=>r.reelId==='reel_unknown').state,'inconclusive');
 assert.equal(result.coverage.precision,null);assert.equal(result.coverage.accuracy,null);assert.equal(result.coverage.semanticQualityMeasured,false);assert.equal(result.providerCalls,0);assert.equal(result.publicationChanged,false);assert.deepEqual(saved,before);
 assert.ok(result.candidates.every(r=>r.replayAllowed===false&&r.checks.every(c=>c.policyVersion==='gate_v2'&&c.ruleVersion)));
});
