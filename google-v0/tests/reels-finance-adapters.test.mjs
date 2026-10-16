import test from 'node:test';
import assert from 'node:assert/strict';
import {googleOperations} from '../lib/google-operations.mjs';
import {sha256} from '../lib/storage.mjs';
import {measureGeminiUsage,measureSpeechUsage} from '../lib/usage-costs.mjs';
const project='megabrain-v0-1017370021431',id='Reel_001',executionId='a'.repeat(64);
const video={id,video_key:`originals/instagram/${id}/video.mp4`,video_generation:'1',media_verified:true,audio_status:'present',duration_seconds:30,transcript:'Fonte preservada.'};
const audioUri=`gs://${project}-media/results/instagram/${id}/${executionId}/audio.flac`;
function fixture(response,{v2=true,synchronous=true}={}){
 let calls=0;const artifacts=[];
 const storage={bucket:project+'-media',metadata:async()=>null,read:async()=>Buffer.from('source'),reserveResult:async()=>{},writeImmutable:async(key,bytes)=>{if(key.endsWith('.json'))artifacts.push(JSON.parse(bytes));return {generation:'2',size:bytes.length,sha256:sha256(bytes)};}};
 const operations=googleOperations({api:{project,request:async()=>{calls++;return response;}},storage,tools:{extractAudio:async()=>Buffer.from('synthetic audio')},preset:{version:'test',system_instruction:'test',user_instruction:'test'},config:{enabled:true,uploads_enabled:true,quotes:{transcription:123,analysis:456},speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR'],synchronous_short_audio:synchronous,gemini_model:'gemini-3.5-flash-lite'},...(v2?{executionAuthorization:async()=>{},executionIds:()=>executionId}:{gate:async()=>({maximum_cents:456})})});
 return {operations,artifacts,calls:()=>calls};
}
test('v2 synchronous STT returns the exact persisted USD usage, keeping BRL quote separate',async()=>{
 const response={results:[{alternatives:[{transcript:'Receita preservada.'}]}],metadata:{totalBilledDuration:'30s'}},f=fixture(response);
 const result=await f.operations.transcription({video,executionId});
 assert.equal(f.calls(),1);assert.deepEqual(result.finance.measurement,f.artifacts[0].usage_cost);
 assert.deepEqual(result.finance.measurement,measureSpeechUsage(response,{model:'chirp_3',location:'us',mode:'synchronous'}));
 assert.equal(result.finance.measuredUsd,0.008);assert.equal(result.finance.estimatedUsd,null);
 assert.deepEqual(result.finance.estimate,{amount:1.23,currency:'BRL',source:'configured_quote'});
 assert.equal(result.finance.measurement.billing_confirmed,false);assert.equal(Object.hasOwn(result.finance,'billed'),false);
});
test('v2 batch STT measures once on collection; submission is not measured or invoiced',async()=>{
 const pending=fixture({name:`projects/${project}/locations/us/operations/saved`},{synchronous:false});
 const submitted=await pending.operations.transcription({video,executionId});assert.equal(submitted.finance,undefined);assert.equal(pending.calls(),1);
 const response={results:{[audioUri]:{metadata:{totalBilledDuration:'60s'},inlineResult:{transcript:{results:[{alternatives:[{transcript:'Fonte preservada.'}]}]}}}}};
 const f=fixture({done:true,response});
 const result=await f.operations.pollTranscription({operationName:submitted.operation_name,videoId:id,executionId});
 assert.equal(f.calls(),1);assert.equal(result.finance.measuredUsd,0.016);assert.deepEqual(result.finance.measurement,f.artifacts[0].usage_cost);
 assert.equal(result.finance.measurement.source,'response.results[file].metadata.totalBilledDuration');
});
test('v2 Gemini retains measured usage for a rejected candidate without turning it into billing',async()=>{
 const response={usageMetadata:{trafficType:'ON_DEMAND',promptTokenCount:1000,candidatesTokenCount:100,totalTokenCount:1100}},f=fixture(response);
 const result=await f.operations.analysis({video,executionId});
 assert.equal(f.calls(),1);assert.equal(result.changes.analysis_quality_status,'review_required');
 assert.deepEqual(result.finance.measurement,measureGeminiUsage(response,{model:'gemini-3.5-flash-lite'}));
 assert.deepEqual(result.finance.measurement,f.artifacts[0].usage_cost);assert.equal(result.finance.measuredUsd,0.00055);assert.equal(result.finance.estimatedUsd,null);assert.equal(result.finance.estimate.currency,'BRL');
});
test('missing provider usage stays unknown, while the legacy adapter output shape is unchanged',async()=>{
 const current=fixture({}),legacy=fixture({},{v2:false});
 const modern=await current.operations.analysis({video,executionId}),original=await legacy.operations.analysis({video,executionId});
 assert.equal(modern.finance.measuredUsd,null);assert.equal(modern.finance.measurement.status,'unavailable');
 assert.equal(Object.hasOwn(original,'finance'),false);assert.deepEqual(Object.keys(original).sort(),['actual_cents','changes','stage','video_id']);assert.equal(original.actual_cents,456);
 assert.deepEqual(modern.changes,original.changes);assert.deepEqual(current.artifacts[0].usage_cost,legacy.artifacts[0].usage_cost);
});
