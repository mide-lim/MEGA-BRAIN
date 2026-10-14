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

test('restoring saved analysis only reads its recorded generation and never calls provider or writes another artifact',async()=>{
 let provider=0,writes=0;const reads=[],api={project:'megabrain-v0-1017370021431',async request(){provider++;throw Error('No model request permitted');}};
 const key=`results/instagram/${video.id}/job_saved/analysis.json`,storage={bucket:api.project+'-media',async metadata(k){return k===key?{generation:'19'}:null;},async read(k,options){reads.push({k,options});return Buffer.from(JSON.stringify({preset_version:preset.version,model:'gemini-3.1-flash-lite',response:{candidates:[{finishReason:'MAX_TOKENS'}]}}));},async writeImmutable(){writes++;throw Error('No writes');}};
 const ops=googleOperations({api,storage,tools:{},preset,config:{enabled:true,uploads_enabled:true,quotes:{analysis:1},gemini_model:'gemini-3.1-flash-lite'},gate:async()=>assert.fail('Reconciliation must not start a paid reservation')});
 const restored=await ops.restoreAnalysisResult({video,executionId:'job_saved'});assert.equal(provider,0);assert.equal(writes,0);assert.equal(reads.length,1);assert.equal(reads[0].options.generation,'19');assert.equal(restored.changes.analysis_quality_status,'review_required');assert.equal(restored.changes.candidate_analysis_key,key);assert.equal(restored.changes.candidate_analysis_generation,'19');
});
test('schema retry refuses an existing original response and verifies media and transcript generations',async()=>{
 const api={project:'megabrain-v0-1017370021431'},make=metadata=>googleOperations({api,storage:{bucket:api.project+'-media',metadata},tools:{},preset,config:{},gate:async()=>assert.fail('Read-only preparation')});
 const source={...video,video_generation:'1',transcript_key:'results/instagram/'+video.id+'/transcription.json',transcript_generation:'2'};
 await assert.rejects(make(async()=>({generation:'9'})).prepareSettledAnalysisRetry({video:source,originalExecutionId:'original'}));
 await assert.rejects(make(async key=>key.endsWith('analysis.json')?null:{generation:'wrong',size:10}).prepareSettledAnalysisRetry({video:source,originalExecutionId:'original'}));
 await make(async key=>key.endsWith('analysis.json')?null:{generation:key===source.video_key?'1':'2',size:10}).prepareSettledAnalysisRetry({video:source,originalExecutionId:'original'});
});
