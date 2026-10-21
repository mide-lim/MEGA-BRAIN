import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleREST} from '../lib/google-rest.mjs';
test('production project and unrelated endpoints are rejected before credential use',async()=>{
  assert.throws(()=>new GoogleREST({project:'megabrain-stt',tokenProvider:()=> 'token'}));
  const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=>{throw Error('must not run');}});
  await assert.rejects(()=>client.request('https://example.com/'));
});

test('analysis failure persistence selects bounded sanitized transport fields without forwarding raw errors',async()=>{
 const {safeAnalysisFailureDiagnostic}=await import('../lib/google-rest.mjs');
 const error={message:'RAW_PRIVATE_MESSAGE',stack:'RAW_PRIVATE_STACK',headers:{Authorization:'RAW_PRIVATE_HEADER'},request:{contents:'RAW_PRIVATE_VIDEO'},google_diagnostic:{api_service:'vertex_ai',operation_step:'submit_analysis',request_stage:'http_response_received',dispatch_attempted:true,response_received:true,response_body_complete:false,elapsed_ms:12,error_name:'Error',error_code:null,http_status:400,request_id:'12345678-1234-1234-1234-123456789012',model:'gemini-3.5-flash-lite',attempt:1,timeout_ms:120000,raw:'RAW_PRIVATE_DIAGNOSTIC'},provider_diagnostic:{status:'INVALID_ARGUMENT',message:'Invalid schema https://private.example/path Bearer private-token user@example.com',details:'RAW_PRIVATE_BODY'}};
 const before=structuredClone(error),saved=safeAnalysisFailureDiagnostic(error);
 assert.equal(saved.google_diagnostic.http_status,400);assert.equal(saved.google_diagnostic.request_stage,'http_response_received');assert.equal(saved.provider_diagnostic.status,'INVALID_ARGUMENT');assert.match(saved.provider_diagnostic.message,/Invalid schema/);
 assert.ok(!JSON.stringify(saved).includes('RAW_PRIVATE'));assert.ok(!/private.example|private-token|user@example.com/.test(JSON.stringify(saved)));
 assert.deepEqual(Object.keys(saved).sort(),['google_diagnostic','provider_diagnostic']);assert.deepEqual(Object.keys(saved.provider_diagnostic).sort(),['message','status']);assert.deepEqual(error,before);
 const malformed={...error,google_diagnostic:{...error.google_diagnostic,elapsed_ms:-1,http_status:'400',request_id:'private-token',model:'PRIVATE_MODEL',attempt:100,timeout_ms:Infinity,request_stage:'PRIVATE_STAGE',error_name:'PRIVATE_NAME',error_code:'private-code'},provider_diagnostic:{status:'private-status',message:'x'.repeat(5000)}};
 const bounded=safeAnalysisFailureDiagnostic(malformed);for(const key of ['elapsed_ms','http_status','request_id','model','attempt','timeout_ms','request_stage','error_name','error_code'])assert.equal(bounded.google_diagnostic[key],null);
 assert.equal(bounded.provider_diagnostic.status,null);assert.equal(bounded.provider_diagnostic.message.length,1000);
 assert.deepEqual(safeAnalysisFailureDiagnostic({provider_diagnostic:error.provider_diagnostic}),{});
 assert.deepEqual(safeAnalysisFailureDiagnostic({...error,google_diagnostic:{...error.google_diagnostic,api_service:'speech'}}),{});
});

test('analysis timeout diagnostic preserves unknown response state without inventing a provider rejection',async()=>{
 const {safeAnalysisFailureDiagnostic}=await import('../lib/google-rest.mjs');
 const client=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'test-token',fetchImpl:async()=>{throw Object.assign(Error('PRIVATE_TIMEOUT'),{name:'TimeoutError'});}});
 await assert.rejects(()=>client.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test',{method:'POST',json:{},operationStep:'submit_analysis',model:'gemini-3.5-flash-lite',attempt:1}),error=>{
  const saved=safeAnalysisFailureDiagnostic(error);assert.equal(saved.google_diagnostic.http_status,null);assert.equal(saved.google_diagnostic.response_received,false);assert.equal(saved.google_diagnostic.error_name,'TimeoutError');assert.equal(saved.provider_diagnostic,null);assert.ok(!JSON.stringify(saved).includes('PRIVATE_TIMEOUT'));return true;
 });
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

test('complete HTTP400 preserves bounded technical details without changing uncertainty or retry',async()=>{
 const {safeAnalysisFailureDiagnostic}=await import('../lib/google-rest.mjs');let calls=0,uncertain=0;
 const body={error:{code:400,status:'INVALID_ARGUMENT',message:'Request contains an invalid argument.',details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',fieldViolations:[{field:'generationConfig.responseSchema.properties.title.enum',description:'Invalid enum length.'},{field:'contents[0].parts[0].text',description:'Invalid value "PRIVATE_VALUE" gs://private/object Bearer PRIVATE_TOKEN user@example.com originals/instagram/private/video.mp4 token=PRIVATE_SECRET '+ 'a'.repeat(64)}]},{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'INVALID_ARGUMENT',domain:'aiplatform.googleapis.com',metadata:{secret:'PRIVATE_METADATA'}},{'@type':'type.googleapis.com/google.rpc.DebugInfo',stackEntries:['PRIVATE_STACK']} ]}};
 const client=new GoogleREST({project:'megabrain-v0-isolated',tokenProvider:()=> 'test-token',fetchImpl:async()=>{calls++;return new Response(JSON.stringify(body),{status:400});}});
 await assert.rejects(()=>client.generateAnalysis('gemini-3.5-flash-lite',{}, {financialCheck:async()=>({ready:true,paid_calls_enabled:true}),markStarted:async()=>{},markUncertain:async()=>{uncertain++;}}),error=>{
  const saved=safeAnalysisFailureDiagnostic(error);assert.equal(error.status,400);assert.equal(saved.google_diagnostic.response_body_complete,true);assert.equal(saved.google_diagnostic.response_error_json_parsed,true);assert.equal(saved.google_diagnostic.response_body_bytes,Buffer.byteLength(JSON.stringify(body)));assert.equal(saved.google_diagnostic.request_stage,'http_response_received');assert.equal(saved.provider_diagnostic.details.length,2);assert.equal(saved.provider_diagnostic.details[0].fieldViolations[0].field,'generationConfig.responseSchema.properties.title.enum');assert.ok(!/PRIVATE_|private|user@example/.test(JSON.stringify(saved)));assert.deepEqual(safeAnalysisFailureDiagnostic({...error,provider_diagnostic:saved.provider_diagnostic}),saved);return true;
 });assert.equal(calls,1);assert.equal(uncertain,1);
});
test('error-body completion measures read completion separately from JSON parsing in raw mode',async()=>{
 for(const [payload,complete,parsed] of [['not-json',true,false],['',true,false],['x'.repeat(8193),false,false]]){
  const client=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'token',fetchImpl:async()=>new Response(payload,{status:400})});
  await assert.rejects(()=>client.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test',{responseMode:'raw'}),e=>e.google_diagnostic.response_body_complete===complete&&e.google_diagnostic.response_error_json_parsed===parsed&&e.google_diagnostic.response_body_bytes===Buffer.byteLength(payload)&&e.provider_diagnostic===null);
 }
 const absent=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'token',fetchImpl:async()=>new Response(null,{status:400})});await assert.rejects(()=>absent.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.google_diagnostic.response_body_complete===true&&e.google_diagnostic.response_body_bytes===0);
 let read=0;const truncated=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'token',fetchImpl:async()=>({ok:false,status:400,headers:new Headers(),body:{getReader:()=>({read:async()=>{if(read++)throw Error('PRIVATE_TRUNCATED');return {done:false,value:Buffer.from('{"error":')};},releaseLock(){}})}})});await assert.rejects(()=>truncated.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/test'),e=>e.google_diagnostic.response_body_complete===false&&e.google_diagnostic.response_body_bytes===9&&e.provider_diagnostic===null);
});
test('every allowlisted provider detail field is sanitized and cardinality is bounded',async()=>{
 const {safeAnalysisFailureDiagnostic}=await import('../lib/google-rest.mjs');
 const detail={'@type':'type.googleapis.com/google.rpc.BadRequest',fieldViolations:[{field:'contents["PRIVATE_KEY"]',description:'"PRIVATE_VALUE"'},{field:'generationConfig.PRIVATE_DYNAMIC',description:'https://private.example/secret'},{field:'Bearer PRIVATE_TOKEN',description:'password=PRIVATE_PASSWORD'},{field:'generationConfig.responseSchema',description:'x '.repeat(900)},{field:'PRIVATE_OVERFLOW',description:'PRIVATE_OVERFLOW'}]};
 const details=[detail,{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'Bearer PRIVATE_TOKEN',domain:'user@private.example',metadata:{private:'PRIVATE_METADATA'}},detail,detail,{'@type':'type.googleapis.com/google.rpc.BadRequest',fieldViolations:[{field:'PRIVATE_FIFTH'}]}];
 const saved=safeAnalysisFailureDiagnostic({google_diagnostic:{api_service:'vertex_ai',operation_step:'submit_analysis'},provider_diagnostic:{status:'INVALID_ARGUMENT',message:'generic',details}});assert.equal(saved.provider_diagnostic.details.length,4);assert.equal(saved.provider_diagnostic.details[0].fieldViolations.length,4);assert.ok(saved.provider_diagnostic.details[0].fieldViolations.every(v=>v.description.length<=512&&v.field.length<=256));assert.ok(!/PRIVATE_|private.example/.test(JSON.stringify(saved)));
});

test('quoted provider secrets remain redacted when closing quote is beyond bounded message',async()=>{
 const {safeAnalysisFailureDiagnostic}=await import('../lib/google-rest.mjs');
 const error={google_diagnostic:{api_service:'vertex_ai',operation_step:'submit_analysis'},provider_diagnostic:{status:'INVALID_ARGUMENT',message:'generic',details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',fieldViolations:[{field:'generationConfig.responseSchema',description:'x '.repeat(240)+'"PRIVATE_SECRET '+ 's '.repeat(600)+'"'}]}]}};
 const saved=safeAnalysisFailureDiagnostic(error);assert.ok(!JSON.stringify(saved).includes('PRIVATE_SECRET'));assert.ok(saved.provider_diagnostic.details[0].fieldViolations[0].description.length<=512);assert.deepEqual(safeAnalysisFailureDiagnostic({...error,provider_diagnostic:saved.provider_diagnostic}),saved);
});
