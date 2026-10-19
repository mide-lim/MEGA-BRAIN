import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticQualityReviewer,automaticReviewScope,automaticReviewTargets,automaticFrameTimes,automaticReviewEntries,automaticValidationId} from '../lib/reels-quality-auto-review.mjs';
import {qualitySourceManifest,evaluateQualityGateV2} from '../lib/reels-quality-gate.mjs';
import {sha256} from '../lib/storage.mjs';
import {createMediaInspectionReceipt} from '../lib/google-operations.mjs';
import {verifyQualitySourceReview} from '../lib/reels-quality-review.mjs';
import {encodeFields} from '../lib/firestore.mjs';
const project='megabrain-v0-1017370021431',executionId='a'.repeat(64),reelId='Reel_001';
function fixture({visual=false,timeout=false,verdict='supported',mutateResponse}={}){
 const prefix=`results/instagram/${reelId}/${executionId}/`,video=Buffer.from('synthetic pixels'),audio=Buffer.from('synthetic audio');
 const record={id:reelId,duration_seconds:20,media_verified:true,video_key:`originals/instagram/${reelId}/video.mp4`,video_generation:'1',video_bytes:video.length,video_sha256:sha256(video),audio_key:prefix+'audio.flac',audio_generation:'2',audio_bytes:audio.length,audio_sha256:sha256(audio),audio_source_key:`originals/instagram/${reelId}/video.mp4`,audio_source_generation:'1',transcript:'',transcript_key:prefix+'transcription.json',transcript_generation:'3',source_caption:{text:'Build a portfolio with HTML.',capture_id:'caption_fixture'}};
 record.media_inspection_receipt=createMediaInspectionReceipt({video:record,media:{hasVideo:true,hasAudio:true,audio_status:'present',duration_seconds:20},bytes:video});
 const manifest=qualitySourceManifest(record);record.transcription_receipt={operationIdentity:'saved_stt',sourceAudioIdentity:manifest.audio,resultIdentity:manifest.transcript,rawResultIdentity:manifest.transcript,words:[]};
 const e={source:'caption',sourceIdentity:manifest.caption,excerpt:record.source_caption.text},v={source:'video',sourceIdentity:manifest.video,start_seconds:1,end_seconds:3};
 const originalReport={title:'Um portfólio com HTML',summary:'Build a portfolio with HTML.',categories:['desenvolvimento-software'],useful_information:[],visual_observations:visual?['Uma página aparece no quadro.']:[],limitations:[],transcript_quality:{assessment:'Unmeasured',uncertain_segments:[]},knowledge:{context:'technology',fields:[{kind:'other',name:'Outro',value:'HTML',evidence:[e]}],keywords:[],missing_information:['Procedimentos técnicos não informados.']},qualityEvidenceV2:{version:2,title:[e],summary:[e],...(visual?{visualObservations:[{index:0,evidence:[v]}]}:{})}};
 const input={record,originalReport,executionId,rawResponseIdentity:{key:prefix+'analysis.json',generation:'10'},originalCandidateIdentity:{key:prefix+'quality-candidate.json',generation:'11'}};
 const docs=new Map(),objects=new Map();let version=0,calls=0,extractions=0,checks=0,lastRequest;
 const store={get:async key=>structuredClone(docs.get(key)??null),create:async(key,data)=>{encodeFields(data);if(docs.has(key))return {created:false};const saved={data:structuredClone(data),updateTime:String(++version)};docs.set(key,saved);return {created:true,...structuredClone(saved)};}};
 function save(key,bytes,generation=String(100+objects.size)){const value={bytes:Buffer.from(bytes),generation,sha256:sha256(bytes)};objects.set(key,value);return {key,generation,sha256:value.sha256,size:bytes.length};}
 save(record.video_key,video,'1');
 const storage={metadata:async key=>{const o=objects.get(key);return o?{generation:o.generation,size:o.bytes.length,metadata:{sha256:o.sha256}}:null;},read:async(key,{generation})=>{const o=objects.get(key);assert.equal(generation,o.generation);return Buffer.from(o.bytes);},writeImmutable:async(key,bytes)=>{const old=objects.get(key);if(old){assert.deepEqual(bytes,old.bytes);return {generation:old.generation,sha256:old.sha256};}return save(key,bytes);}};
 const responseFor=targets=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({entries:targets.map(t=>({fieldPath:t.fieldPath,verdict,reason:'Synthetic independent test verdict.',visualStatic:t.visual,frameIds:t.visual?[0]:[],quotes:t.visual?[]:[{source:'caption',excerpt:record.source_caption.text}]}))})}]}}],usageMetadata:{trafficType:'ON_DEMAND',promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150}});
 const api={project,request:async(url,options)=>{calls++;lastRequest=options.json;assert.match(url,/:generateContent$/);assert.equal(options.attempt,1);assert.ok([...docs.keys()].some(k=>k.includes('/validation_')),'durable intent precedes call');if(timeout)throw Error('synthetic timeout');const response=responseFor(automaticReviewTargets(record,originalReport));mutateResponse?.(response);return response;}};
 const tools={extractFrames:async(bytes,times)=>{extractions++;assert.deepEqual(bytes,video);return times.map(()=>Buffer.from('synthetic jpeg'));}};
 const reviewer=automaticQualityReviewer({store,storage,api,tools,model:'gemini-3.5-flash-lite',authorize:async()=>{checks++;},clock:()=>Date.parse('2026-10-19T10:00:00Z')});
 return {input,record,originalReport,docs,objects,store,storage,reviewer,responseFor,calls:()=>calls,extractions:()=>extractions,checks:()=>checks,request:()=>lastRequest};
}
test('server operation allowlist is closed by default and rejects malformed/general scopes',()=>{
 const id='a'.repeat(64);assert.equal(automaticReviewScope({},id),false);assert.equal(automaticReviewScope({reels_quality_validation_operation_ids:[id]},id),true);
 for(const ids of [['*'],[id,id],['invalid',id],Array(11).fill(id)])assert.equal(automaticReviewScope({reels_quality_validation_operation_ids:ids},id),false);
 assert.equal(automaticReviewScope({reels_quality_validation_operation_ids:[id]},'b'.repeat(64)),false);
});
test('independent saved text validation seals actual server provenance and reuses without another call',async()=>{
 const f=fixture(),before=structuredClone(f.input),review=await f.reviewer.generate(f.input);
 assert.equal(f.calls(),1);assert.ok(f.checks()>=3);assert.equal(f.extractions(),0);assert.deepEqual(f.input,before);
 assert.ok(review.trustedReviews.some(e=>e.fieldPath==='title'));assert.equal(review.sourceVersions.length,2);
 const sealed=f.docs.get('reels_quality_receipts/'+review.reviewIdentity.reviewId).data;
 assert.equal(sealed.createdBy,'server:saved-source-validation-v1');assert.equal(sealed.reviewerExecutor,'external');assert.notEqual(sealed.authorIdentity,sealed.reviewerIdentity);
 assert.equal(evaluateQualityGateV2({record:f.record,report:f.originalReport,mediaInspection:f.record.media_inspection_receipt,transcriptionReceipt:f.record.transcription_receipt,trustedReviews:review.trustedReviews}).accepted,true);
 await f.reviewer.generate(f.input);await f.reviewer.load(f.input);assert.equal(f.calls(),1);
 const usage=await f.reviewer.usage(f.input);assert.equal(usage.measurement.status,'measured');assert.equal(usage.validationId,automaticValidationId(f.input));
 const changed={...f.input,record:{...f.record,transcript:'changed'}};await assert.rejects(()=>f.reviewer.load(changed));assert.equal(f.calls(),1);
});
test('visual proof uses pinned sampled bytes and cannot certify an unobserved interval',async()=>{
 const f=fixture({visual:true}),review=await f.reviewer.generate(f.input),entry=review.trustedReviews.find(e=>e.fieldPath==='visual_observations.0');
 assert.equal(f.extractions(),1);assert.equal(f.calls(),1);assert.equal(entry.visualPixelsReviewed,true);assert.deepEqual(entry.frameArtifacts[0].sampleSeconds,[2]);
 assert.equal(f.request().contents[0].parts.filter(p=>p.inlineData).length,1);
 const targets=[{fieldPath:'visual_observations.0',visual:true,evidence:[{source:'video',start_seconds:9,end_seconds:10}]}],response=f.responseFor(targets);
 const rows=automaticReviewEntries({response,targets,frames:[{seconds:2,artifact:entry.frameArtifacts[0].artifact}],record:f.record,report:f.originalReport});assert.equal(rows[0].verdict,'inconclusive');assert.equal(rows[0].visualPixelsReviewed,undefined);
});
test('timeout, concurrent delivery and recovery never repeat a dispatched validation',async()=>{
 const f=fixture({timeout:true});await Promise.all([f.reviewer.generate(f.input),f.reviewer.generate(f.input)]);assert.equal(f.calls(),1);
 assert.equal(await f.reviewer.generate(f.input),null);assert.equal(await f.reviewer.load(f.input),null);assert.equal(f.calls(),1);
 assert.equal((await f.reviewer.usage(f.input)).measurement.status,'unavailable');assert.ok([...f.objects.keys()].some(k=>k.endsWith('uncertain.json')));
});
test('received malformed response stays saved with its measured usage and no retry',async()=>{
 const f=fixture({mutateResponse:r=>{r.candidates[0].content.parts[0].text='invalid JSON';}});assert.equal(await f.reviewer.generate(f.input),null);assert.equal(f.calls(),1);
 await assert.rejects(()=>f.reviewer.generate(f.input));assert.equal(f.calls(),1);assert.equal((await f.reviewer.usage(f.input)).measurement.status,'measured');
});
test('negative review cannot publish or permanently occupy editorial selection',async()=>{
 const f=fixture({verdict:'invalid'}),review=await f.reviewer.generate(f.input);assert.ok(review.trustedReviews.every(e=>e.verdict==='invalid'));assert.equal(review.sourceVersions.length,1);
 assert.equal(f.docs.has('reels_quality_receipts/'+review.reviewIdentity.selectionId),false);
 assert.equal(evaluateQualityGateV2({record:f.record,report:f.originalReport,mediaInspection:f.record.media_inspection_receipt,transcriptionReceipt:f.record.transcription_receipt,trustedReviews:review.trustedReviews}).accepted,false);
 await f.reviewer.load(f.input);assert.equal(f.calls(),1);
});
test('server rejects extra fields, fabricated quotes, duplicate targets and unsupported visual claims',()=>{
 const f=fixture(),targets=automaticReviewTargets(f.record,f.originalReport);
 for(const edit of [rows=>rows[0].quotes[0].excerpt='invented',rows=>rows[0].extra=true,rows=>rows[1].fieldPath=rows[0].fieldPath]){const response=f.responseFor(targets),body=JSON.parse(response.candidates[0].content.parts[0].text);edit(body.entries);response.candidates[0].content.parts[0].text=JSON.stringify(body);assert.throws(()=>automaticReviewEntries({response,targets,frames:[],record:f.record,report:f.originalReport}));}
 const refs=Array.from({length:20},(_,i)=>({evidence:[{source:'video',start_seconds:i,end_seconds:i+1}]}));assert.equal(automaticFrameTimes(refs,20).length,16);
});
test('a saved response can seal after interrupted persistence with no provider or tools',async()=>{
 const f=fixture();await f.reviewer.generate(f.input);for(const key of [...f.docs.keys()])if(!key.includes('/validation_'))f.docs.delete(key);
 const readonly=automaticQualityReviewer({store:f.store,storage:f.storage,tools:{},api:{request:()=>assert.fail('provider in recovery')},model:'gemini-3.5-flash-lite',authorize:()=>assert.fail('submission in recovery')});
 const loaded=await readonly.load(f.input);assert.ok(loaded.reviewIdentity);assert.equal(f.calls(),1);
});

import {googleOperations} from '../lib/google-operations.mjs';
import {readFileSync} from 'node:fs';
test('first analysis saves candidate before validation; saved-result restoration never invokes generation',async()=>{
 const f=fixture(),preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url))),storage={...f.storage,bucket:project+'-media'};let originals=0,validations=0;
 const operations=googleOperations({api:{project,request:async()=>{originals++;return {candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(f.originalReport)}]}}]};}},storage,tools:{},preset,config:{enabled:true,uploads_enabled:true,gemini_model:'gemini-3.5-flash-lite',reels_quality_policy_version:'gate_v2'},executionAuthorization:async()=>{},loadQualityReview:async()=>null,generateQualityReview:async input=>{validations++;assert.ok(await storage.metadata(input.originalCandidateIdentity.key));assert.ok(await storage.metadata(input.rawResponseIdentity.key));return null;},saveQualityReceipt:async receipt=>({id:receipt.id,receiptHash:'fixture'})});
 await operations.analysis({video:f.record,executionId});assert.equal(originals,1);assert.equal(validations,1);
 await operations.restoreAnalysisResult({video:f.record,executionId});assert.equal(originals,1);assert.equal(validations,1);
 await operations.analysis({video:f.record,executionId});assert.equal(originals,1);assert.equal(validations,1);
});
