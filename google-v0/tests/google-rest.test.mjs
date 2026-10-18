import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleREST} from '../lib/google-rest.mjs';
test('production project and unrelated endpoints are rejected before credential use',async()=>{
  assert.throws(()=>new GoogleREST({project:'megabrain-stt',tokenProvider:()=> 'token'}));
  const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=>{throw Error('must not run');}});
  await assert.rejects(()=>client.request('https://example.com/'));
});
test('uncertain inference is registered once and never retried',async()=>{
  let calls=0,started=0,uncertain=0;
  const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=> 'test-token',fetchImpl:async()=>{calls++;throw Error('connection lost');}});
  await assert.rejects(()=>client.generateAnalysis('gemini-3.1-flash-lite',{}, {financialCheck:async()=>({ready:true,paid_calls_enabled:true}),markStarted:async()=>{started++;},markUncertain:async()=>{uncertain++;}}));
  assert.equal(calls,1);assert.equal(started,1);assert.equal(uncertain,1);
});
test('failed financial check makes zero API calls',async()=>{
  let calls=0;
  const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=> 'test-token',fetchImpl:async()=>{calls++;}});
  await assert.rejects(()=>client.generateAnalysis('gemini-3.1-flash-lite',{}, {financialCheck:async()=>({ready:false}),markStarted:async()=>{},markUncertain:async()=>{}}));
  assert.equal(calls,0);
});
test('sufficient funds do not override the paid execution switch',async()=>{
  let calls=0;
  const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=> 'test-token',fetchImpl:async()=>{calls++;}});
  await assert.rejects(()=>client.generateAnalysis('gemini-3.1-flash-lite',{}, {financialCheck:async()=>({ready:true,paid_calls_enabled:false}),markStarted:async()=>{},markUncertain:async()=>{}}));
  assert.equal(calls,0);
});
test('same Google endpoint cannot access a production project or unrelated bucket',async()=>{
  let calls=0;const client=new GoogleREST({project:'megabrain-v0-test',buckets:['megabrain-v0-test-media'],tokenProvider:()=>{calls++;return 'test';}});
  await assert.rejects(()=>client.request('https://firestore.googleapis.com/v1/projects/megabrain-stt/databases/(default)/documents/videos'));
  await assert.rejects(()=>client.request('https://storage.googleapis.com/storage/v1/b/megabrain-production/o/file'));
  await assert.rejects(()=>client.request('https://us-speech.googleapis.com/v2/projects/megabrain-v0-test/locations/global/recognizers/_:batchRecognize'));
  await assert.rejects(()=>client.request('https://eu-speech.googleapis.com/v2/projects/megabrain-v0-test/locations/eu/recognizers/_:batchRecognize'));
  assert.equal(calls,0);
});
test('storage responses exceeding the declared limit are aborted',async()=>{
  const client=new GoogleREST({project:'megabrain-v0-test',buckets:['megabrain-v0-test-media'],tokenProvider:()=> 'test',fetchImpl:async()=>new Response('too large')});
  await assert.rejects(()=>client.request('https://storage.googleapis.com/storage/v1/b/megabrain-v0-test-media/o/object?alt=media',{responseMode:'bytes',maxResponseBytes:3}));
});

test('HTTP429 exposes bounded redacted provider message without retry',async()=>{
 let calls=0;const client=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'private-token',fetchImpl:async()=>{calls++;return Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'quota for https://private/path Bearer private-token user@example.com'}},{status:429});}});
 await assert.rejects(()=>client.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.status===429&&e.provider_diagnostic.status==='RESOURCE_EXHAUSTED'&&!/private|example/.test(e.provider_diagnostic.message));assert.equal(calls,1);
});
test('oversized or malformed Google error body preserves HTTPstatus without diagnostic',async()=>{
 for(const body of ['x'.repeat(9000),'not-json']){
  const client=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'token',fetchImpl:async()=>new Response(body,{status:429})});
  await assert.rejects(()=>client.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.status===429&&e.provider_diagnostic===null);
 }
});

test('request stages prove credential failure before fetch and distinguish HTTP200 body failure',async()=>{
 let calls=0;
 const before=new GoogleREST({project:'megabrain-v0-test',tokenProvider:async()=>{throw Error('private credential failure');},fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>before.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.google_diagnostic.request_stage==='credential'&&e.google_diagnostic.dispatch_attempted===false&&e.google_diagnostic.response_received===false);
 assert.equal(calls,0);
 const body=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'synthetic',fetchImpl:async()=>{calls++;return new Response('{incomplete',{status:200});}});
 await assert.rejects(()=>body.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.status===200&&e.google_diagnostic.request_stage==='response_body_read'&&e.google_diagnostic.dispatch_attempted===true&&e.google_diagnostic.response_received===true&&e.google_diagnostic.response_body_complete===false&&e.google_diagnostic.api_service==='vertex_ai');
 assert.equal(calls,1);
});
