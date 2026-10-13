import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {googleOperations} from '../lib/google-operations.mjs';
import {GoogleREST} from '../lib/google-rest.mjs';
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
const video={id:'DXVj0SkDesv',video_key:'originals/instagram/DXVj0SkDesv/video.mp4',duration_seconds:60,media_verified:true,transcript:'Guardar a fonte facilita conferir a informação.'};
function fixture({timeoutMs=1000,fetchImpl,writeFail=false}={}){
  let calls=0,gates=0;const artifacts=[];
  const api=new GoogleREST({project:'megabrain-v0-1017370021431',tokenProvider:()=> 'test-token',fetchImpl:async(...args)=>{calls++;return fetchImpl?fetchImpl(...args):Response.json({});}});
  const storage={bucket:`${api.project}-media`,metadata:async()=>null,writeImmutable:async(key,bytes)=>{if(writeFail)throw Error('write failed');artifacts.push(JSON.parse(bytes));return {generation:'1'};}};
  const operations=googleOperations({api,storage,tools:{},preset,config:{enabled:true,uploads_enabled:true,quotes:{analysis:1},gemini_model:'gemini-3.1-flash-lite',analysis_timeout_ms:timeoutMs},gate:async()=>{gates++;return {maximum_cents:1};}});
  return {operations,artifacts,calls:()=>calls,gates:()=>gates};
}
test('invalid analysis timeout blocks all adapter side effects',async()=>{
  const f=fixture({timeoutMs:900000});
  await assert.rejects(()=>f.operations.analysis({video,executionId:'job_test'}));
  assert.equal(f.calls(),0);assert.equal(f.gates(),0);assert.equal(f.artifacts.length,0);
});
test('successful analysis artifact retains bounded submission diagnostic',async()=>{
  const f=fixture();
  await f.operations.analysis({video,executionId:'job_test'});
  assert.equal(f.calls(),1);assert.equal(f.artifacts.length,1);
  const d=f.artifacts[0].call_diagnostics[0];
  assert.equal(d.operation_step,'submit_analysis');assert.equal(d.http_status,200);assert.equal(d.model,'gemini-3.1-flash-lite');assert.equal(d.attempt,1);assert.ok(d.timeout_ms<=1000&&d.timeout_ms>0);
});
test('failed persistence after success never repeats inference',async()=>{
  const f=fixture({writeFail:true});
  await assert.rejects(()=>f.operations.analysis({video,executionId:'job_test'}),e=>e.operation_step==='persist_analysis'&&Number.isInteger(e.elapsed_ms));
  assert.equal(f.calls(),1);
});
test('cancellation has attempt number and records uncertain once without retry',async()=>{
  const f=fixture({fetchImpl:async()=>{throw new DOMException('cancelled','AbortError');}}),histories=[];
  await assert.rejects(()=>f.operations.analysis({video,executionId:'job_test',recordAnalysisAttempts:async h=>histories.push(structuredClone(h))}),e=>e.operation_step==='submit_analysis'&&e.google_diagnostic.attempt===1&&e.google_diagnostic.error_name==='AbortError');
  assert.equal(f.calls(),1);assert.equal(histories.length,2);assert.equal(histories[1][0].status,'uncertain');
});
test('confirmed429 backoff consumes the same deadline and cannot start a late replay',async()=>{
  const f=fixture({fetchImpl:async()=>Response.json({error:{status:'RESOURCE_EXHAUSTED'}},{status:429})}),histories=[];
  await assert.rejects(()=>f.operations.analysis({video,executionId:'job_test',recordAnalysisAttempts:async h=>histories.push(structuredClone(h))}),e=>e.operation_step==='submit_analysis'&&e.name==='TimeoutError'&&e.google_diagnostic.http_status===null);
  assert.equal(f.calls(),1);assert.equal(histories.at(-1)[0].status,'http_429');assert.equal(histories.at(-1)[1].status,'uncertain');
});
