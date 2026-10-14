import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {measureGeminiUsage,measureSpeechUsage,summarizeUsageMeasurements} from '../lib/usage-costs.mjs';
const config={model:'gemini-3.5-flash-lite',location:'global'};
const response={usageMetadata:{promptTokenCount:10000,cachedContentTokenCount:2000,candidatesTokenCount:1000,thoughtsTokenCount:500,totalTokenCount:11500,trafficType:'ON_DEMAND'}};
const speech={model:'chirp_3',location:'us',mode:'synchronous'};
test('Gemini records cache discount and reasoning exactly, independently of financial reservations',()=>{
 const before=structuredClone(response),r=measureGeminiUsage(response,config);
 assert.equal(r.status,'measured');assert.equal(r.list_price_micro_usd,6210);assert.equal(r.usage.thought_tokens,500);assert.equal(r.billing_confirmed,false);assert.equal(r.currency,'USD');assert.equal(r.allocation_cents,undefined);assert.deepEqual(response,before);
 assert.equal(measureGeminiUsage({usageMetadata:{promptTokenCount:10,cachedContentTokenCount:1,candidatesTokenCount:1,trafficType:'ON_DEMAND'}},config).list_price_micro_usd,6);
});
test('missing, inconsistent, unsafe or unsupported Gemini usage stays unknown rather than zero',()=>{
 for(const r of [{},{usageMetadata:{totalTokenCount:123}},{usageMetadata:{...response.usageMetadata,totalTokenCount:100}},{usageMetadata:{...response.usageMetadata,cachedContentTokenCount:11000}},{usageMetadata:{...response.usageMetadata,thoughtsTokenCount:-1}},{usageMetadata:{...response.usageMetadata,trafficType:'BATCH'}},{usageMetadata:{...response.usageMetadata,promptTokenCount:Number.MAX_SAFE_INTEGER,totalTokenCount:undefined}}]){
  const x=measureGeminiUsage(r,config);assert.equal(x.status,'unavailable');assert.equal(x.list_price_micro_usd,undefined);
 }
 assert.equal(measureGeminiUsage(response,{model:'another-model'}).status,'unavailable');
 assert.equal(measureGeminiUsage(response,{...config,location:'us-central1'}).status,'unavailable');
});
test('STT uses recorded billed duration including no-speech, never the video duration',()=>{
 assert.equal(measureSpeechUsage({metadata:{totalBilledDuration:'60s'},results:[]},speech).list_price_micro_usd,16000);
 assert.equal(measureSpeechUsage({metadata:{totalBilledDuration:'20.5s'}},speech).list_price_micro_usd,5467);
 assert.equal(measureSpeechUsage({metadata:{totalBilledDuration:'0s'}},speech).list_price_micro_usd,0);
 const missing=measureSpeechUsage({duration_seconds:60,results:[]},speech);assert.equal(missing.status,'unavailable');assert.equal(missing.list_price_micro_usd,undefined);
});
test('single-file batch duration is counted once and contradictory/multiple files are unavailable',()=>{
 const uri='gs://bucket/audio.flac',c={...speech,mode:'batch',audioUri:uri};
 const r={totalBilledDuration:'60s',results:{[uri]:{metadata:{totalBilledDuration:'60s'}}}};
 assert.equal(measureSpeechUsage(r,c).list_price_micro_usd,16000);
 assert.equal(measureSpeechUsage({...r,totalBilledDuration:'61s'},c).status,'unavailable');
 assert.equal(measureSpeechUsage({...r,results:{...r.results,other:{}}},c).status,'unavailable');
 assert.equal(measureSpeechUsage(r,{...c,audioUri:'different'}).status,'unavailable');
 for(const d of ['abc','-1s','1.0000000001s',null])assert.equal(measureSpeechUsage({metadata:{totalBilledDuration:d}},speech).status,'unavailable');
 assert.equal(measureSpeechUsage(r,{...c,mode:'dynamic_batch'}).status,'unavailable');
});
test('aggregate separates unavailable measurements and refuses incompatible rates',()=>{
 const r=measureGeminiUsage(response,config),s=measureSpeechUsage({metadata:{totalBilledDuration:'60s'}},speech);
 const result=summarizeUsageMeasurements([r,s,{status:'unavailable',reason:'missing_usage'},{...r,rate_version:'other'}]);
 assert.equal(result.measured_records,2);assert.equal(result.unavailable_records,2);assert.equal(result.list_price_micro_usd,22210);assert.equal(result.billing_confirmed,false);
});
test('offline CLI calculates legacy artifacts without overwriting input, reports missing metadata and refuses output overwrite',()=>{
 const dir=mkdtempSync(join(tmpdir(),'megabrain-usage-'));
 try{
  const input=join(dir,'input.json'),output=join(dir,'output.json');const body=JSON.stringify([{stage:'analysis',artifact:{model:config.model,response}},{stage:'transcription',artifact:{mode:'synchronous',model:speech.model,raw:{metadata:{totalBilledDuration:'60s'}}}},{stage:'analysis',artifact:{model:config.model,response:{}}}]);writeFileSync(input,body);
  const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/summarize-usage.mjs',import.meta.url)),input,output],{encoding:'utf8'});
  assert.equal(run().status,0);const r=JSON.parse(readFileSync(output));assert.equal(r.list_price_micro_usd,22210);assert.equal(r.unavailable_records,1);assert.equal(readFileSync(input,'utf8'),body);
  assert.notEqual(run().status,0);assert.equal(JSON.parse(readFileSync(output)).list_price_micro_usd,22210);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
