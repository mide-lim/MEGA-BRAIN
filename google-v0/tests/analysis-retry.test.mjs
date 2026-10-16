import test from 'node:test';
import assert from 'node:assert/strict';
import {submitAnalysisWithRetry,recoverableAnalysis429} from '../lib/analysis-retry.mjs';
const rejected429=()=>Object.assign(Error('quota'),{status:429});
test('429 followed by success persists attempts, waits and checks admission each time',async()=>{
 let calls=0,gates=0;const waits=[],records=[];
 const result=await submitAnalysisWithRetry({submit:async()=>{if(++calls<3)throw rejected429();return 'ok';},admit:async()=>{gates++;},record:async h=>records.push(structuredClone(h)),sleep:async ms=>waits.push(ms)});
 assert.equal(result,'ok');assert.equal(calls,3);assert.equal(gates,3);assert.deepEqual(waits,[5000,15000]);
 assert.deepEqual(records.map(h=>h.at(-1).status),['started','http_429','started','http_429','started','response_received']);
});
test('exhaustion stops at three lifetime calls including recovered first429',async()=>{
 let calls=0,latest;
 await assert.rejects(()=>submitAnalysisWithRetry({attempts:[{number:1,status:'http_429'}],submit:async()=>{calls++;throw rejected429();},admit:async()=>{},record:async h=>{latest=structuredClone(h);},sleep:async()=>{}}));
 assert.equal(calls,2);assert.equal(latest.length,3);
 assert.equal(recoverableAnalysis429({stage:'analysis',status:'uncertain',failure_diagnostic:{operation_step:'submit_analysis',http_status:429},analysis_attempts:latest}),false);
});
test('timeouts, authentication and5xx are never retried; uncertain histories block recovery',async()=>{
 for(const status of [undefined,401,403,500,503]){
  let calls=0,latest;
  await assert.rejects(()=>submitAnalysisWithRetry({submit:async()=>{calls++;throw Object.assign(Error('failure'),{status});},admit:async()=>{},record:async h=>{latest=structuredClone(h);},sleep:async()=>{}}));
  assert.equal(calls,1);assert.equal(latest[0].status,'uncertain');
 }
 for(const status of ['started','response_received','uncertain'])await assert.rejects(()=>submitAnalysisWithRetry({attempts:[{number:1,status}],submit:()=>assert.fail('replay'),admit:async()=>{},record:async()=>{}}));
});
test('pause during backoff and failed attempt persistence prevent the next submission',async()=>{
 let calls=0,gates=0;
 await assert.rejects(()=>submitAnalysisWithRetry({submit:async()=>{calls++;throw rejected429();},admit:async()=>{if(++gates===2)throw Error('paused');},record:async()=>{},sleep:async()=>{}}));assert.equal(calls,1);
 await assert.rejects(()=>submitAnalysisWithRetry({submit:()=>assert.fail('unrecorded call'),admit:async()=>{},record:async()=>{throw Error('CAS failed');}}));
});


test('one-attempt unit analysis records HTTP429 without a retry or sleep',async()=>{
 let calls=0,sleeps=0;const history=[];
 await assert.rejects(submitAnalysisWithRetry({maximumAttempts:1,submit:async()=>{calls++;throw Object.assign(Error('rate limit'),{status:429});},admit:async()=>{},record:async h=>history.push(structuredClone(h)),sleep:async()=>{sleeps++;}}));
 assert.equal(calls,1);assert.equal(sleeps,0);assert.equal(history.at(-1)[0].status,'http_429');
});
