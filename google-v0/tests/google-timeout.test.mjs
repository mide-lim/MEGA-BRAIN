import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {GoogleREST,analysisTimeoutMs} from '../lib/google-rest.mjs';
const url='https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test';
const options={operationStep:'submit_analysis',model:'gemini-3.1-flash-lite',attempt:1};
const client=fetchImpl=>new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'secret-token',fetchImpl});
test('timeout bounds reject invalid configuration before identity or submission',async()=>{
  let calls=0;const api=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=>{calls++;return 'token';},fetchImpl:()=>{calls++;}});
  for(const value of [null,0,-1,999,840001,Infinity,NaN,1000.5,'120000'])assert.throws(()=>analysisTimeoutMs(value));
  assert.equal(analysisTimeoutMs(),120000);assert.equal(analysisTimeoutMs(840000),840000);
  for(const timeoutMs of [0,-1,840001,NaN,'120000'])await assert.rejects(()=>api.request(url,{timeoutMs}));
  await assert.rejects(()=>api.generateAnalysis('gemini-3.1-flash-lite',{}, {timeoutMs:840001,financialCheck:()=>{calls++;},markStarted:()=>{calls++;},markUncertain:()=>{calls++;}}));
  assert.equal(calls,0);
});
test('delayed success records complete duration and safe metadata once',async()=>{
  const diagnostics=[];let calls=0;
  const api=client(async()=>{calls++;await delay(40);return Response.json({ok:true},{headers:{'x-request-id':'12345678-1234-1234-1234-123456789abc'}});});
  assert.deepEqual(await api.request(url,{...options,timeoutMs:1000,json:{private:'payload'},onDiagnostic:d=>diagnostics.push(d)}),{ok:true});
  assert.equal(calls,1);assert.equal(diagnostics.length,1);const d=diagnostics[0];
  assert.ok(d.elapsed_ms>=30);assert.equal(d.http_status,200);assert.equal(d.error_name,null);assert.equal(d.model,options.model);assert.equal(d.attempt,1);assert.equal(d.operation_step,'submit_analysis');assert.equal(d.request_id,'12345678-1234-1234-1234-123456789abc');
  assert.doesNotMatch(JSON.stringify(d),/secret|payload|https/);
});
test('timeout cancels one fetch and preserves TimeoutError code23 without replay',async()=>{
  let calls=0;const diagnostics=[];
  const api=client(async(_url,{signal})=>{calls++;await delay(100,null,{signal}).catch(()=>{throw signal.reason;});return Response.json({});});
  await assert.rejects(()=>api.request(url,{...options,timeoutMs:15,onDiagnostic:d=>diagnostics.push(d)}),e=>e.google_diagnostic.error_name==='TimeoutError'&&e.google_diagnostic.error_code===23&&e.google_diagnostic.http_status===null);
  assert.equal(calls,1);assert.equal(diagnostics.length,1);assert.ok(diagnostics[0].elapsed_ms>=10);
});
test('explicit cancellation and unsafe error fields never copy arbitrary text',async()=>{
  for(const error of [new DOMException('secret payload','AbortError'),Object.assign(new Error('Bearer secret-token'),{name:'secret-token',code:'secret-token'})]){
    await assert.rejects(()=>client(async()=>{throw error;}).request(url,options),e=>{assert.doesNotMatch(JSON.stringify(e.google_diagnostic),/secret|payload|Bearer/);return true;});
  }
});
test('body failure after HTTP200 retains received status and duration',async()=>{
  const api=client(async(_url,{signal})=>({ok:true,status:200,headers:new Headers({'x-request-id':'Bearer secret-token'}),json:async()=>{await delay(100,null,{signal}).catch(()=>{throw signal.reason;});}}));
  await assert.rejects(()=>api.request(url,{...options,timeoutMs:15}),e=>e.status===200&&e.google_diagnostic.http_status===200&&e.google_diagnostic.request_id===null&&e.google_diagnostic.error_name==='TimeoutError');
});
test('HTTP error preserves sanitized provider fields and call diagnostic',async()=>{
  await assert.rejects(()=>client(async()=>Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'Bearer secret-token'}},{status:429})).request(url,options),e=>e.status===429&&e.google_diagnostic.http_status===429&&e.provider_diagnostic.message==='[credential]');
});
