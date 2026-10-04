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
