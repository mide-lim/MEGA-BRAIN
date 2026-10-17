import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {googleOperations,createMediaInspectionReceipt} from '../lib/google-operations.mjs';
import {sha256} from '../lib/storage.mjs';
import {qualityDigest,qualitySourceManifest} from '../lib/reels-quality-gate.mjs';
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

for(const signalStop of [false,true])test(`upload closure requires downloader callback (signaled=${signalStop})`,async()=>{
 let starts=0,stops=0;
 const api={project:'megabrain-v0-1017370021431'};
 const operations=googleOperations({api,storage:{bucket:api.project+'-media',async writeImmutable(){return {generation:'1',size:5};}},tools:{async download(received,options){assert.equal(received,video);assert.equal(options.withMetadata,true);assert.equal(typeof options.onExecutionStopped,'function');assert.equal(starts,1);if(signalStop)options.onExecutionStopped();return Buffer.from('media');}},preset:{},config:{enabled:true,uploads_enabled:true,quotes:{upload:100}},gate:async()=>({maximum_cents:100}),inspect:async()=>({audio_status:'present',duration_seconds:1})});
 const result=await operations.upload({video,executionId:'synthetic',recordAcquisitionExtraction(){starts++;return ()=>stops++;}});
 assert.equal(Object.hasOwn(result.changes,'video_sha256'),false);assert.equal(Object.hasOwn(result.changes,'media_inspection_receipt'),false);
 assert.equal(starts,1);assert.equal(stops,signalStop?1:0);
});
test('upload forwards closure on proven download rejection without changing the failure',async()=>{
 let stops=0;const error=Error('synthetic'),api={project:'megabrain-v0-1017370021431'};
 const operations=googleOperations({api,storage:{bucket:api.project+'-media'},tools:{async download(_video,{onExecutionStopped}){onExecutionStopped();throw error;}},preset:{},config:{enabled:true,uploads_enabled:true,quotes:{upload:100}},gate:async()=>({maximum_cents:100})});
 await assert.rejects(operations.upload({video,executionId:'synthetic',recordAcquisitionExtraction:()=>()=>stops++}),e=>e===error&&e.operation_step==='download_media');assert.equal(stops,1);
});

function qualitySource(){
 const bytes=Buffer.from('verified-video'),audio=Buffer.from('verified-audio'),id='Reel_001',job='a'.repeat(64);
 const record={id,video_key:'originals/instagram/'+id+'/video.mp4',video_generation:'1',video_bytes:bytes.length,video_sha256:sha256(bytes),media_verified:true,audio_status:'present',duration_seconds:20,audio_key:'results/instagram/'+id+'/'+job+'/audio.flac',audio_generation:'2',audio_bytes:audio.length,audio_sha256:sha256(audio),audio_source_key:'originals/instagram/'+id+'/video.mp4',audio_source_generation:'1',transcript:'Frango no forno. Use 200 g de frango.',transcript_key:'results/instagram/'+id+'/'+job+'/transcription.json',transcript_generation:'3',source_caption:{text:'Frango no forno. Use 200 g de frango.',capture_id:'capture_fixture'}};
 record.media_inspection_receipt=createMediaInspectionReceipt({video:record,media:{hasVideo:true,hasAudio:true,audio_status:'present',duration_seconds:20},bytes});
 const m=qualitySourceManifest(record);record.transcription_receipt={operationIdentity:'synchronous:'+job,operationKind:'local_synchronous_submission',sourceAudioIdentity:m.audio,resultIdentity:m.transcript,rawResultIdentity:m.transcript,words:[{word:record.transcript,start_seconds:0,end_seconds:2}]};
 const proof={source:'caption',sourceIdentity:m.caption,excerpt:record.source_caption.text},report={title:'Frango no forno.',summary:'Use 200 g de frango.',categories:['receitas'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Fonte reconhecida sem acurácia medida.',uncertain_segments:[]},knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Ingrediente',value:'200 g de frango',evidence:[proof]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[proof],summary:[proof]}};
 return {record,report,bytes,audio,job};
}
function qualityAdapterFixture({receiptFailure=false}={}){
 const source=qualitySource(),objects=new Map(),order=[],receipts=[];let calls=0,fail=receiptFailure;
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(source.report)}]}}]};
 const api={project:'megabrain-v0-1017370021431',request:async(_url,options)=>{calls++;assert.ok(options.json.generationConfig.responseSchema.properties.qualityEvidenceV2);assert.equal(options.json.contents.length,1);return response;}};
 const storage={bucket:api.project+'-media',metadata:async key=>objects.has(key)?{generation:objects.get(key).generation}:null,read:async key=>objects.get(key).bytes,writeImmutable:async(key,bytes)=>{order.push(key.endsWith('analysis.json')?'raw':'candidate');const old=objects.get(key);if(old){assert.deepEqual(old.bytes,bytes);return old;}const object={generation:String(objects.size+10),bytes};objects.set(key,object);return object;}};
 const ops=googleOperations({api,storage,tools:{},preset:{version:'fixture',system_instruction:'Analise',user_instruction:'Resuma'},config:{enabled:true,uploads_enabled:true,reels_quality_policy_version:'gate_v2',gemini_model:'gemini-test',single_reel_pipeline_enabled:true},executionAuthorization:async()=>{},saveQualityReceipt:async receipt=>{order.push('receipt');if(fail){fail=false;throw Error('receipt storage unavailable');}receipts.push(receipt);return {id:receipt.id,receiptHash:qualityDigest(receipt)};}});
 return {...source,ops,objects,order,receipts,calls:()=>calls};
}
test('trusted v2 uses one enriched request and persists raw candidate and receipt before any pointer proposal',async()=>{
 const f=qualityAdapterFixture(),before=structuredClone(f.record),result=await f.ops.analysis({video:f.record,executionId:f.job});
 assert.equal(f.calls(),1);assert.deepEqual(f.order,['raw','candidate','receipt']);assert.equal(result.qualityGate.accepted,true);assert.equal(result.qualityGate.publicationChanged,false);assert.equal(result.qualityPublication.policyVersion,'gate_v2');assert.match(result.changes.analysis_key,/quality-candidate.json$/);assert.deepEqual(f.record,before);
 assert.equal(f.receipts[0].analysisKey,result.changes.analysis_key);assert.equal(f.receipts[0].analysisGeneration,result.changes.analysis_generation);
});
test('saved v2 raw response is reused after receipt failure without another inference',async()=>{
 const f=qualityAdapterFixture({receiptFailure:true});await assert.rejects(f.ops.analysis({video:f.record,executionId:f.job}),/receipt storage unavailable/);assert.equal(f.calls(),1);
 const result=await f.ops.analysis({video:f.record,executionId:f.job});assert.equal(f.calls(),1);assert.equal(result.qualityGate.accepted,true);assert.deepEqual(f.order,['raw','candidate','receipt','candidate','receipt']);
});
test('v2 source without actual inspection blocks before paid provider and does not recertify history',async()=>{
 const f=qualityAdapterFixture();delete f.record.media_inspection_receipt;const result=await f.ops.analysis({video:f.record,executionId:f.job});assert.equal(f.calls(),0);assert.equal(f.objects.size,0);assert.equal(result.qualityGate.state,'inconclusive');assert.equal(result.qualityPublication,null);
});
for(const synchronous of [true,false])test('STT '+(synchronous?'sync':'batch')+' receipt binds actual audio raw generation and original offsets',async()=>{
 const f=qualitySource(),writes=[],operationName='projects/megabrain-v0-1017370021431/locations/us/operations/saved';let requests=0;
 const transcript={results:[{alternatives:[{transcript:'Frango',words:[{word:'Frango',startOffset:'0s',endOffset:'1s'}]}]}]},audioUri='gs://megabrain-v0-1017370021431-media/'+f.record.audio_key;
 const api={project:'megabrain-v0-1017370021431',request:async(_url,options)=>{requests++;if(options?.method==='POST')return synchronous?transcript:{name:operationName};return {done:true,response:{results:{[audioUri]:{inlineResult:{transcript}}}}};}};
 const storage={bucket:api.project+'-media',reserveResult:async()=>{},metadata:async key=>key===f.record.video_key?{generation:'1'}:{generation:'2',size:f.audio.length,metadata:{sha256:sha256(f.audio)}},read:async()=>f.audio,writeImmutable:async(key,bytes)=>{writes.push(JSON.parse(bytes));return {generation:'7'};}};
 const ops=googleOperations({api,storage,tools:{},preset:{},config:{enabled:true,uploads_enabled:true,reels_quality_policy_version:'gate_v2',synchronous_short_audio:synchronous,speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR'],single_reel_pipeline_enabled:true},executionAuthorization:async()=>{},executionIds:()=>f.job,saveQualityReceipt:async()=>assert.fail('STT must not create an analysis receipt')});
 let result=await ops.transcription({video:f.record,executionId:f.job});if(!synchronous)result=await ops.pollTranscription({video:f.record,videoId:f.record.id,executionId:f.job,operationName});
 const receipt=result.changes.transcription_receipt;assert.deepEqual(receipt.sourceAudioIdentity,qualitySourceManifest(f.record).audio);assert.equal(receipt.rawResultIdentity.generation,'7');assert.deepEqual(receipt.words,[{word:'Frango',start_seconds:0,end_seconds:1}]);assert.equal(receipt.operationKind,synchronous?'local_synchronous_submission':'provider_batch_operation');assert.equal(receipt.operationIdentity,synchronous?'synchronous:'+f.job:operationName);assert.equal(receipt.alignmentMeasured,false);assert.equal(requests,synchronous?1:2);assert.equal(writes.length,1);
});
