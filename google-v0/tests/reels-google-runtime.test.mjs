import test from 'node:test';
import assert from 'node:assert/strict';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {ReelsDispatcher} from '../lib/reels-dispatcher.mjs';
import {executionId} from '../lib/reels-pipeline.mjs';
import {hash} from '../lib/reels-runtime.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {buildAnalysisRequest} from '../lib/analysis.mjs';
const project='megabrain-v0-1017370021431';
const config={project,reels_runtime_version:'v2',worker_origin:'https://worker.run.app'};
const request=(body={},options={})=>new Request('https://worker.run.app/tasks/run',{method:'POST',body:JSON.stringify(body),...options});
function memory(){const docs=new Map();let revision=0;return {docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,data)=>{if(docs.has(p))return {created:false};const v={data:structuredClone(data),updateTime:String(++revision)};docs.set(p,v);return {created:true,...structuredClone(v)};},patch:async(p,changes,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const v={data:{...old.data,...structuredClone(changes)},updateTime:String(++revision)};docs.set(p,v);return structuredClone(v);}};}
test('disabled fixed-stage runtime never initializes database, identity or providers',async()=>{
 let calls=0;const handler=reelsGoogleRuntime(config,{}, {stage:'analysis',authorize:()=>{calls++;throw Error();},dependencies:{get api(){calls++;throw Error();},operationsFactory:()=>{calls++;throw Error();}}});
 for(const body of [{},{executionId:'a'.repeat(64),processingEnabled:true}]){const response=await handler(request(body));assert.equal(response.status,423);assert.equal((await response.json()).code,'PROCESSING_DISABLED');}
 assert.equal(calls,0);
});
test('enabled runtime authenticates and rejects payload before opening dependencies',async()=>{
 let calls=0;const dependencies={get api(){calls++;throw Error('must stay lazy');}};
 const denied=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'analysis',authorize:()=>false,dependencies});assert.equal((await denied(request())).status,401);
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'analysis',authorize:()=>true,dependencies});
 for(const body of [{executionId:'x'},{executionId:'a'.repeat(64),videoId:'injected'},{executionId:'a'.repeat(64),poll:'yes'}])assert.equal((await handler(request(body))).status,400);
 assert.equal(calls,0);
});
test('fixed stage rejects another stage and returns retryable backpressure with no adapter call',async()=>{
 const store=memory();let calls=0;const id=executionId('command','Reel_001','analysis');await store.create('reels_executions/'+id,{id,reelId:'Reel_001',stage:'analysis',status:'queued'});
 const dependencies={store,repository:{store},api:{project},storage:{},tools:{},dispatcher:{},operationsFactory:()=>{calls++;throw Error('provider forbidden');}};
 const wrong=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'acquisition',authorize:()=>true,dependencies});assert.equal((await wrong(request({executionId:id}))).status,409);
 await store.create('reels_controls/analysis',{paused:true,desiredConcurrency:1,active:[]});
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'analysis',authorize:()=>true,dependencies});const result=await handler(request({executionId:id}));assert.equal(result.status,503);assert.equal((await result.json()).reason,'TECHNICAL_BACKPRESSURE');assert.equal(calls,0);
});
const routes={analysis:{queue:'v0-analysis',workerOrigin:'https://analysis.run.app'}};
async function outbox(store){const id=executionId('command','Reel_001','analysis'),outboxId=hash('dispatch');const job={id,stage:'analysis',reelId:'Reel_001',outboxId,poll:false};await store.create('reels_command_items/'+outboxId,{executionId:id,stage:'analysis',poll:false,status:'pending'});return job;}
test('disabled dispatcher leaves durable intent untouched and makes no request',async()=>{const store=memory(),job=await outbox(store);const dispatcher=new ReelsDispatcher({api:{project,request:()=>assert.fail('network')},store,routes});assert.equal((await dispatcher.enqueue(job)).status,'disabled');assert.equal((await store.get('reels_command_items/'+job.outboxId)).data.status,'pending');});
test('dispatch lost acknowledgement reconciles only the same FULL task payload',async()=>{
 const store=memory(),job=await outbox(store),names=[];let saved;
 const api={project,request:async(url,options)=>{
  if(options?.method==='POST'){const {task,responseView}=options.json;assert.equal(responseView,'FULL');names.push(task.name);saved??=structuredClone(task);assert.deepEqual(JSON.parse(Buffer.from(task.httpRequest.body,'base64')),{executionId:job.id,poll:false,outboxId:job.outboxId});throw Object.assign(Error('lost'),{status:names.length===1?503:409});}
  assert.ok(url.endsWith('?responseView=FULL'));return saved;
 }};
 const dispatcher=new ReelsDispatcher({api,store,routes,enabled:true});assert.equal((await dispatcher.enqueue(job)).status,'uncertain');assert.equal((await dispatcher.enqueue(job)).status,'sent');assert.equal(names[0],names[1]);await dispatcher.enqueue(job);assert.equal(names.length,2);
});
test('dispatcher rejects mismatched durable intent and unapproved routing without network',async()=>{
 const store=memory(),job=await outbox(store),api={project,request:()=>assert.fail('network')};
 await assert.rejects(new ReelsDispatcher({api,store,routes:{analysis:{queue:'v0-analysis',workerOrigin:'https://evil.example'}},enabled:true}).enqueue(job));
 await assert.rejects(new ReelsDispatcher({api,store,routes,enabled:true}).enqueue({...job,poll:true}));
});

test('v2 missing or malformed estimate is informational; legacy gate remains strict',async()=>{
 for(const quote of [undefined,0,0.25,'invalid',-1]){
  let calls=0;const api={project,request:async()=>{calls++;return {};}};
  const storage={bucket:project+'-media',writeImmutable:async()=>({generation:'1'})};
  const ops=googleOperations({api,storage,tools:{},preset:{version:'test',system_instruction:'test',user_instruction:'test'},config:{enabled:true,uploads_enabled:true,quotes:{analysis:quote},gemini_model:'gemini-test'},executionAuthorization:async()=>{}});
  const r=await ops.analysis({video:{id:'Reel_001',video_key:'originals/instagram/Reel_001/video.mp4',media_verified:true,duration_seconds:30,transcript:''},executionId:'a'.repeat(64)});
  assert.equal(calls,1);assert.equal(r.actual_cents,typeof quote==='number'&&quote>=0?quote:null);
 }
 const legacy=googleOperations({api:{project,request:()=>assert.fail('legacy provider must stay blocked')},storage:{bucket:project+'-media'},tools:{},preset:{},config:{enabled:true,uploads_enabled:true,quotes:{analysis:0}},gate:async()=>({maximum_cents:0})});
 await assert.rejects(legacy.analysis({video:{id:'Reel_001'},executionId:'saved'}),/Estimativa/);
});
test('terminal STT operation is definitive only in v2; transport and missing file stay uncertain',async()=>{
 for(const terminal of [{done:true,error:{code:3}},{done:true,response:{results:{['gs://'+project+'-media/results/instagram/Reel_001/'+'a'.repeat(64)+'/audio.flac']:{error:{code:3}}}}}]){
  const ops=googleOperations({api:{project,request:async()=>terminal},storage:{bucket:project+'-media'},tools:{},preset:{},config:{enabled:true,uploads_enabled:true,speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR']},executionAuthorization:async()=>{},executionIds:()=> 'a'.repeat(64)});
  await assert.rejects(ops.pollTranscription({operationName:'projects/'+project+'/locations/us/operations/saved',videoId:'Reel_001',executionId:'a'.repeat(64)}),e=>e.definitive===true&&e.code==='STT_TERMINAL_FAILURE');
 }
});
test('taxonomy extraction is opt-in for v2 and leaves legacy response schema unchanged',()=>{
 const input={record:{id:'Reel_001',media_verified:true,duration_seconds:30},bucket:project+'-media',preset:{version:'v2',system_instruction:'test',user_instruction:'test'}};
 const legacy=buildAnalysisRequest(input),v2=buildAnalysisRequest({...input,taxonomySignalsEnabled:true});assert.equal(legacy.generationConfig.responseSchema.properties.taxonomySignals,undefined);assert.ok(v2.generationConfig.responseSchema.properties.taxonomySignals);assert.match(v2.systemInstruction.parts[0].text,/Ingredientes, etapas/);
});
test('confirmed downloader stop proof does not invalidate execution claim before result persistence',async()=>{
 const store=memory(),id=executionId('operation','Reel_001','acquisition');await store.create('videos/Reel_001',{id:'Reel_001',status:'registered'});await store.create('reels_executions/'+id,{id,operationId:'operation',reelId:'Reel_001',stage:'acquisition',status:'queued'});
 const repository={store,raw:async id=>(await store.get('videos/'+id))?.data,refresh:async()=>{}};
 let uploads=0;const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'acquisition',authorize:()=>true,dependencies:{api:{project},store,repository,storage:{metadata:async()=>null},tools:{},dispatcher:{enqueue:async()=>({status:'sent'})},operationsFactory:({executionAuthorization})=>({upload:async input=>{uploads++;await executionAuthorization({executionId:input.executionId,stage:'upload',videoId:input.videoId});await input.recordAcquisitionExtraction()();return {changes:{video_key:'saved',video_generation:'1',media_verified:true}};}})}});
 const response=await handler(request({executionId:id}));assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');assert.equal(uploads,1);assert.equal((await store.get('execution_stops/'+id)).data.id,id);assert.equal((await store.get('reels_executions/'+id)).data.status,'completed');
});
test('orphan media requires reconciliation before contacting the source again',async()=>{
 const store=memory(),id=executionId('operation','Reel_001','acquisition');await store.create('videos/Reel_001',{id:'Reel_001',status:'registered'});await store.create('reels_executions/'+id,{id,operationId:'operation',reelId:'Reel_001',stage:'acquisition',status:'queued'});
 const repository={store,raw:async id=>(await store.get('videos/'+id))?.data,refresh:async()=>{}};
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'acquisition',authorize:()=>true,dependencies:{api:{project},store,repository,storage:{metadata:async()=>({generation:'1'})},tools:{},dispatcher:{},operationsFactory:()=>({upload:async()=>assert.fail('existing source cannot be downloaded again')})}});
 const response=await handler(request({executionId:id}));assert.equal((await response.json()).status,'uncertain');assert.equal((await store.get('videos/Reel_001')).data.reels_v2.error.code,'MEDIA_REFERENCE_REQUIRES_RECONCILIATION');
});

for(const stage of ['acquisition','transcription','analysis'])test(`runtime preserves ${stage} finance in the durable receipt without provider replay`,async()=>{
 const store=memory(),id=executionId('finance-operation','Reel_001',stage),finance={estimatedUsd:null,measuredUsd:0.016,estimate:{amount:1,currency:'BRL',source:'configured_quote'},measurement:{schema_version:1,status:'measured',currency:'USD',list_price_micro_usd:16000,rate_version:'fixture-rate',billing_confirmed:false,source:'fake-provider-usage'}};
 await store.create('videos/Reel_001',{id:'Reel_001',status:'registered'});await store.create('reels_executions/'+id,{id,operationId:'finance-operation',reelId:'Reel_001',stage,status:'queued'});
 const repository={store,raw:async reelId=>(await store.get('videos/'+reelId))?.data,refresh:async()=>{}};let calls=0;
 const fake=async()=>{calls++;return {changes:{},finance,actual_cents:100};};
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage,authorize:()=>true,dependencies:{api:{project},store,repository,storage:{metadata:async()=>null},tools:{},dispatcher:{enqueue:async()=>({status:'sent'})},operationsFactory:()=>({upload:fake,transcription:fake,analysis:fake})}});
 assert.equal((await handler(request({executionId:id}))).status,200);assert.deepEqual((await store.get('reels_executions/'+id)).data.rawResult.finance,finance);
 assert.equal((await handler(request({executionId:id}))).status,200);assert.equal(calls,1);
});

test('runtime keeps batch STT collection usage in the saved result and reads the operation once',async()=>{
 const store=memory(),id=executionId('finance-operation','Reel_001','transcription'),finance={measuredUsd:0.016,estimatedUsd:null,measurement:{currency:'USD',status:'measured'}};let polls=0;
 await store.create('videos/Reel_001',{id:'Reel_001',status:'registered'});await store.create('reels_executions/'+id,{id,operationId:'finance-operation',reelId:'Reel_001',stage:'transcription',status:'waiting',owner:'saved-owner',operationName:'saved-operation',operationEvidence:{schemaVersion:1,executionId:id,reelId:'Reel_001',operationId:'finance-operation',stage:'transcription',owner:'saved-owner',operationName:'saved-operation'}});
 await store.create('reels_controls/transcription',{id:'transcription',paused:false,desiredConcurrency:1,active:[id]});
 const repository={store,raw:async reelId=>(await store.get('videos/'+reelId))?.data,refresh:async()=>{}};
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'transcription',authorize:()=>true,dependencies:{api:{project},store,repository,storage:{},tools:{},dispatcher:{enqueue:async()=>({status:'sent'})},operationsFactory:()=>({pollTranscription:async()=>{polls++;return {changes:{transcript:'Fonte preservada'},finance};}})}});
 assert.equal((await handler(request({executionId:id,poll:true}))).status,200);assert.deepEqual((await store.get('reels_executions/'+id)).data.rawResult.finance,finance);
 assert.equal((await handler(request({executionId:id,poll:true}))).status,200);assert.equal(polls,1);
});


test('pause during preparation fences the paid POST before provider submission',async()=>{
 const store=memory(),id=executionId('pause-window','Reel_001','transcription');let paid=0;
 await store.create('videos/Reel_001',{id:'Reel_001',status:'registered'});
 await store.create('reels_executions/'+id,{id,operationId:'pause-window',reelId:'Reel_001',stage:'transcription',status:'queued'});
 const repository={store,raw:async reelId=>(await store.get('videos/'+reelId))?.data,refresh:async()=>{}};
 const handler=reelsGoogleRuntime({...config,reels_processing_enabled:true},{},{stage:'transcription',authorize:()=>true,dependencies:{api:{project,request:async()=>{paid++;assert.fail('no paid request after pause');}},store,repository,storage:{},tools:{},dispatcher:{},operationsFactory:({api,executionAuthorization})=>({transcription:async input=>{
  await executionAuthorization({executionId:id,videoId:'Reel_001',stage:'transcription'});
  const control=await store.get('reels_controls/transcription');await store.patch('reels_controls/transcription',{paused:true},{updateTime:control.updateTime});
  await api.request('https://us-speech.googleapis.com/v2/projects/fake:batchRecognize',{method:'POST'});
  assert.fail('paused submission cannot finish');
 }})}});
 const response=await handler(request({executionId:id}));assert.equal(response.status,200);assert.equal((await response.json()).status,'failed');assert.equal(paid,0);
 assert.equal((await store.get('reels_executions/'+id)).data.error.code,'STAGE_PAUSED');assert.deepEqual((await store.get('reels_controls/transcription')).data.active,[]);
});
