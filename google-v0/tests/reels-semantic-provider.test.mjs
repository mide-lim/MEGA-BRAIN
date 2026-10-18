import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsSemanticProvider,parseSavedSemanticResponse} from '../lib/reels-semantic-provider.mjs';
test('real adapter submits one text-only structured Vertex request and returns paid raw before parsing',async()=>{
 const calls=[],raw={responseId:'known-paid',candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{broken'}]}}],usageMetadata:{candidatesTokenCount:100}},api={project:'megabrain-v0-1017370021431',request:async(url,options)=>{calls.push({url,options});return raw;}};
 const provider=new ReelsSemanticProvider({api}),out=await provider.infer({sources:[{id:'QaSaved_1',fields:[{fieldPath:'caption',text:'Dados salvos.'}]}],catalogue:{groups:[]},requestId:'a'.repeat(64),model:'gemini-3.5-flash'});
 assert.equal(calls.length,1);assert.equal(calls[0].options.timeoutMs,90000);assert.equal(calls[0].options.json.generationConfig.responseMimeType,'application/json');assert.equal(calls[0].options.json.contents[0].parts[0].fileData,undefined);assert.equal(out.rawResponse,raw);assert.equal(out.providerResponseId,'known-paid');assert.throws(()=>parseSavedSemanticResponse(out),{code:'SEMANTIC_RESPONSE_INCOMPLETE'});assert.equal(calls.length,1);
});
test('known preflight invalid input cannot submit a provider request',async()=>{let n=0;const p=new ReelsSemanticProvider({api:{project:'megabrain-v0-1017370021431',request:async()=>{n++;}}});await assert.rejects(()=>p.infer({sources:[],requestId:'a'.repeat(64),model:'gemini-3.5-flash'}));assert.equal(n,0);});
