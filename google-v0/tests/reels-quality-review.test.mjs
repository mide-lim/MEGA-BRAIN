import test from 'node:test';
import assert from 'node:assert/strict';
import {sealQualitySourceReview,verifyQualitySourceReview,loadQualitySourceReview,qualityReviewBinding} from '../lib/reels-quality-review.mjs';
import {qualityCandidateHash,qualityDigest,qualitySourceManifest} from '../lib/reels-quality-gate.mjs';
import {analysisOutcome,analysisReportOutcome} from '../lib/analysis.mjs';
import {createMediaInspectionReceipt} from '../lib/google-operations.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {executionId} from '../lib/reels-pipeline.mjs';
import {hash} from '../lib/reels-runtime.mjs';
import {sha256} from '../lib/storage.mjs';
import {encodeFields} from '../lib/firestore.mjs';

// Entirely synthetic source and editorial review. These values never leave the
// isolated Actions test process and cannot establish a real source review.
const project='megabrain-v0-1017370021431';
const clone=v=>structuredClone(v);
function memory(){
 const docs=new Map();let version=0;
 const put=(path,data)=>{const value={data:clone(data),updateTime:String(++version)};docs.set(path,value);return clone(value);};
 const store={docs,put,get:async path=>clone(docs.get(path)??null),create:async(path,data)=>docs.has(path)?{created:false}:{created:true,...put(path,data)},patch:async(path,changes,{updateTime}={})=>{const old=docs.get(path);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});return put(path,{...old.data,...clone(changes)});}};
 store.beginQualityRecovery=async args=>{
  await store.beforeRecovery?.(args);
  const expected=[['reels_executions/'+args.executionId,args.executionVersion],['videos/'+args.reelId,args.videoVersion],['reels_controls/analysis',args.controlVersion],...args.reviewVersions.map(v=>[v.path,v.updateTime])];
  if(expected.some(([path,version])=>docs.get(path)?.updateTime!==version)||docs.has('reels_reconciliations/'+args.receipt.id))return {applied:false};
  // No await between the two writes: atomic in-memory seam. Firestore wire
  // tests separately assert readWrite, all versions and the two-write commit.
  put('reels_reconciliations/'+args.receipt.id,args.receipt);
  const path='reels_executions/'+args.executionId;
  put(path,{...docs.get(path).data,status:'applying',qualityReviewRecovery:{id:args.receipt.id,receiptHash:args.receipt.receiptHash,reviewId:args.receipt.result.qualityReview.reviewId}});
  await store.afterRecovery?.(args);return {applied:true};
 };return store;
}
async function fixture({ordinal=1,entriesTransform,reportTransform}={}){
 const reelId='Reel_'+String(ordinal).padStart(3,'0'),operationId='same-original-cohort-100',id=executionId(operationId,reelId,'analysis'),prefix=`results/instagram/${reelId}/${id}/`,media=Buffer.from('synthetic-video'),audio=Buffer.from('synthetic-audio');
 const record={id:reelId,duration_seconds:20,media_verified:true,video_key:`originals/instagram/${reelId}/video.mp4`,video_generation:'1',video_bytes:media.length,video_sha256:sha256(media),audio_key:prefix+'audio.flac',audio_generation:'2',audio_bytes:audio.length,audio_sha256:sha256(audio),audio_source_key:`originals/instagram/${reelId}/video.mp4`,audio_source_generation:'1',audio_status:'present',transcript:'',transcript_key:prefix+'transcription.json',transcript_generation:'3',source_caption:{text:'Build a portfolio with HTML.',capture_id:'synthetic_capture_'+ordinal}};
 record.media_inspection_receipt=createMediaInspectionReceipt({video:record,media:{hasVideo:true,hasAudio:true,audio_status:'present',duration_seconds:20},bytes:media});
 const manifest=qualitySourceManifest(record);record.transcription_receipt={operationIdentity:'synchronous:'+id,sourceAudioIdentity:manifest.audio,resultIdentity:manifest.transcript,rawResultIdentity:manifest.transcript,words:[]};
 const ref={source:'caption',sourceIdentity:manifest.caption,excerpt:record.source_caption.text};
 const inputReport={title:'Um portfólio com HTML',summary:'Build a portfolio with HTML.',categories:['desenvolvimento-software'],useful_information:[{claim:'Build a portfolio with HTML.',application:'Referência editorial para organizar um portfólio.',classification:'author_claim',evidence:[ref]}],visual_observations:['A página mostra um portfólio.'],limitations:['Fonte sintética de teste.'],transcript_quality:{assessment:'Texto salvo sem medição de fidelidade.',uncertain_segments:[]},knowledge:{context:'technology',fields:[{kind:'tool',name:'HTML',value:'HTML',evidence:[ref]}],keywords:[{term:'HTML',evidence:[ref]}],missing_information:['Procedimentos técnicos não estão descritos nesta fonte sintética.']},qualityEvidenceV2:{version:2,title:[ref],summary:[ref]}};
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(inputReport)}]}}]},raw={preset_version:'fixture',model:'gemini-fixture',response};
 const qualityContext={mediaInspection:record.media_inspection_receipt,transcriptionReceipt:record.transcription_receipt};
 const initial=analysisOutcome(response,record,{requireKnowledge:true,qualityGateV2:qualityContext});
 assert.ok(initial.report,'fixture must produce a received, normalized original');assert.equal(initial.accepted,false);
 const originalReport=initial.report,rawResponseIdentity={key:prefix+'analysis.json',generation:'10'},originalCandidateIdentity={key:prefix+'quality-candidate.json',generation:'11'};
 const candidate={report:originalReport,candidateContentHash:qualityCandidateHash(originalReport),rawResponseIdentity,parseReasons:initial.reasons??[]};
 const report=clone(originalReport),videoRef={source:'video',sourceIdentity:manifest.video,start_seconds:0,end_seconds:10,excerpt:'Synthetic pixels observed by test reviewer.'};
 report.qualityEvidenceV2.applications=[{index:0,evidence:[ref,videoRef]}];report.qualityEvidenceV2.visualObservations=[{index:0,evidence:[videoRef]}];reportTransform?.(report);
 const objects=new Map(),reads=[],writes=[];
 const save=(key,generation,data)=>{const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data));const object={key,generation,bytes,sha256:sha256(bytes)};objects.set(key,object);return {key,generation,sha256:object.sha256};};
 save(rawResponseIdentity.key,'10',raw);save(originalCandidateIdentity.key,'11',candidate);
 const reviewEvidence=save(prefix+'quality-review/editorial-review.json','12',{synthetic:true,independentReviewer:'test-reviewer'});
 const frame0=save(prefix+'quality-review/frame-0.png','13',Buffer.from('synthetic-frame-zero')),frame10=save(prefix+'quality-review/frame-10.png','14',Buffer.from('synthetic-frame-ten'));
 const visual={visualPixelsReviewed:true,videoIdentity:manifest.video,sourceManifest:manifest,frameArtifacts:[{artifact:frame0,sampleSeconds:[0]},{artifact:frame10,sampleSeconds:[10]}]};
 const entries=[{fieldPath:'title',verdict:'supported',reason:'Tradução sintética integral da legenda identificada.'},{fieldPath:'useful_information.0.application',verdict:'supported',reason:'Aplicação editorial limitada ao exemplo sintético.',...visual},{fieldPath:'visual_observations.0',verdict:'supported',reason:'Dois quadros sintéticos conferidos no teste.',...visual},{fieldPath:'knowledge.fields.0.kind',verdict:'supported',reason:'Papel tecnológico restrito à afirmação sintética.'}];entriesTransform?.(entries);
 const sealInput={record,originalReport,executionId:id,rawResponseIdentity,originalCandidateIdentity,report,entries,authorIdentity:'test-author',reviewerIdentity:'test-reviewer',reviewerExecutor:'codex-native',method:'Synthetic independent-review fixture; no real editorial approval.',observedAt:'2026-10-19T00:00:00Z',reviewEvidence};
 const sealed=sealQualitySourceReview(sealInput),store=memory();
 await store.create('reels_quality_receipts/'+sealed.review.id,sealed.review);await store.create('reels_quality_receipts/'+sealed.selection.id,sealed.selection);
 const originalResult={changes:{analysis:null,analysis_key:null,analysis_generation:null,analysis_quality_status:'review_required',analysis_candidate:originalReport,candidate_analysis_key:originalCandidateIdentity.key,candidate_analysis_generation:originalCandidateIdentity.generation},valid:false,quality:{accepted:false,state:'inconclusive'},qualityPublication:null,estimatedCents:0.125,finance:{state:'estimated',providerCalls:1}};
 const error={code:'QUALITY_VALIDATION_FAILED',retryable:false,destination:'review'},owner='synthetic-original-owner';
 const job={id,operationId,reelId,stage:'analysis',status:'failed',owner,attempt:1,error,failedAt:'2026-10-18T00:00:00Z',rawResult:originalResult,resultEvidence:{schemaVersion:1,executionId:id,operationId,reelId,stage:'analysis',owner,resultHash:hash(originalResult)},resultSavedAt:'2026-10-18T00:00:00Z'};
 Object.assign(record,originalResult.changes,{reels_v2:{status:'failed',stage:'analysis',operationId,executionId:id,error,candidate:{available:true}}});
 await store.create('videos/'+reelId,record);await store.create('reels_executions/'+id,job);await store.create('reels_controls/analysis',{paused:true,desiredConcurrency:1,active:[],queuePolicy:'preserved'});await store.create('reels_finance/preserved',{estimatedCents:0.125,state:'estimated'});await store.create('reels_executions/'+executionId(operationId,'Other_001','analysis'),{status:'queued',stage:'analysis',attempt:1});
 const storage={bucket:project+'-media',metadata:async key=>{const o=objects.get(key);return o?{generation:o.generation,size:o.bytes.length,metadata:{sha256:o.sha256}}:null;},read:async(key,{generation}={})=>{reads.push({key,generation});const o=objects.get(key);assert.equal(generation,o?.generation);return Buffer.from(o.bytes);},writeImmutable:async(key,bytes)=>{writes.push(key);const old=objects.get(key);if(old){assert.deepEqual(old.bytes,bytes);return {generation:old.generation};}const o=save(key,String(100+objects.size),bytes);return {generation:o.generation};}};
 const binding={record,originalReport,executionId:id,rawResponseIdentity,originalCandidateIdentity};
 const repository={store,raw:async reelId=>(await store.get('videos/'+reelId))?.data,refresh:async()=>{}};
 const runtime=reelsGoogleRuntime({project,reels_runtime_version:'v2',reels_processing_enabled:true,worker_origin:'https://worker.run.app',gemini_model:'gemini-fixture'}, {version:'fixture'}, {stage:'analysis',authorize:()=>true,dependencies:{store,repository,storage,tools:{download:()=>assert.fail('provider download forbidden')},api:{project,request:()=>assert.fail('all provider calls forbidden')},dispatcher:{enqueue:()=>assert.fail('queue dispatch forbidden')}}});
 const deliver=async(overrides={})=>runtime(new Request('https://worker.run.app/tasks/quality-review',{method:'POST',body:JSON.stringify({executionId:id,reviewId:sealed.review.id,evidenceVersion:(await store.get('reels_executions/'+id)).updateTime,...overrides})}));
 const importDelivery=async(packageIdentity,overrides={})=>runtime(new Request('https://worker.run.app/tasks/quality-review/import',{method:'POST',body:JSON.stringify({executionId:id,evidenceVersion:(await store.get('reels_executions/'+id)).updateTime,packageIdentity,...overrides})}));
 return {id,reelId,store,storage,objects,save,reads,writes,binding,sealInput,sealed,job,record,repository,deliver,importDelivery};
}

test('server loader accepts only sealed exact source reviews and reads every distinct frame',async()=>{
 const f=await fixture(),loaded=await loadQualitySourceReview({store:f.store,storage:f.storage,...f.binding});
 assert.equal(loaded.trustedReviews.length,4);assert.equal(loaded.report.qualityEvidenceV2.visualObservations[0].evidence[0].source,'video');
 assert.equal(f.reads.length,3);assert.equal(new Set(f.reads.map(r=>r.key)).size,3);assert.equal(loaded.sourceVersions.length,2);
 assert.equal(loaded.trustedReviews.find(e=>e.fieldPath==='visual_observations.0').frameArtifacts.length,2);
 const original=clone(f.sealed);loaded.report.title='tampered local value';assert.deepEqual(f.sealed,original);
});
test('review sealing rejects self-review, unbound fields, ambiguous pixels and foreign paths',async()=>{
 const f=await fixture();
 const rejected=[{reviewerIdentity:'test-author'},{entries:[{fieldPath:'invented.path',verdict:'supported',reason:'No field.'}]},{reviewEvidence:{...f.sealInput.reviewEvidence,key:'private/arbitrary.json'}},{entries:[...f.sealInput.entries,f.sealInput.entries[0]]},{entries:[{...f.sealInput.entries[2],frameArtifact:f.sealInput.entries[2].frameArtifacts[0].artifact}]},{entries:[{...f.sealInput.entries[2],frameArtifacts:[{artifact:f.sealInput.entries[2].frameArtifacts[0].artifact,sampleSeconds:[21]}]}]}];
 for(const changes of rejected)assert.throws(()=>sealQualitySourceReview({...f.sealInput,...changes}),e=>e.code==='QUALITY_REVIEW_INVALID');
 const review=clone(f.sealed.review);review.report.title='different';assert.throws(()=>verifyQualitySourceReview({...f.binding,...f.sealed,review}),e=>e.code==='QUALITY_REVIEW_INVALID');
 assert.throws(()=>verifyQualitySourceReview({...f.binding,...f.sealed,record:{...f.record,video_generation:'999'}}),e=>e.code==='QUALITY_REVIEW_INVALID');
});
test('loader fails closed on changed bytes, size limits, selection and absent requested review',async()=>{
 for(const mutation of ['bytes','size','selection','missing']){
  const f=await fixture();
  if(mutation==='bytes')f.objects.get(f.sealInput.entries[2].frameArtifacts[1].artifact.key).bytes=Buffer.from('changed bytes');
  if(mutation==='size')f.storage.metadata=async()=>({generation:'12',size:8000001,metadata:{sha256:f.sealInput.reviewEvidence.sha256}});
  if(mutation==='selection')f.store.docs.get('reels_quality_receipts/'+f.sealed.selection.id).data.reviewHash='0'.repeat(64);
  if(mutation==='missing')f.store.docs.delete('reels_quality_receipts/'+f.sealed.selection.id);
  await assert.rejects(loadQualitySourceReview({store:f.store,storage:f.storage,...f.binding,requestedReviewId:f.sealed.review.id}),e=>e.code==='QUALITY_REVIEW_INVALID');assert.equal(f.writes.length,0);
 }
});
test('real analysis runtime recovers saved candidate with no providers, no original rewrite and preserved financial proof',async()=>{
 // structuredClone turns Buffer into Uint8Array; preserve the type and independent bytes.
 const snapshot=object=>({...clone(object),bytes:Buffer.from(object.bytes)});
 const f=await fixture(),originalRaw=snapshot(f.objects.get(f.binding.rawResponseIdentity.key)),originalCandidate=snapshot(f.objects.get(f.binding.originalCandidateIdentity.key)),control=await f.store.get('reels_controls/analysis'),finance=await f.store.get('reels_finance/preserved');
 const response=await f.deliver();assert.equal(response.status,200);const outcome=await response.json();assert.equal(outcome.status,'completed');
 const job=(await f.store.get('reels_executions/'+f.id)).data,video=(await f.store.get('videos/'+f.reelId)).data,recovery=(await f.store.get('reels_reconciliations/'+job.qualityReviewRecovery.id)).data;
 assert.deepEqual(job.rawResult,f.job.rawResult);assert.deepEqual(job.resultEvidence,f.job.resultEvidence);assert.equal(job.attempt,1);assert.equal(job.error,null);assert.equal(video.reels_v2.error,null);assert.equal(video.reels_v2.candidate,null);assert.equal(video.analysis_candidate,null);assert.equal(video.candidate_analysis_key,null);
 assert.equal(recovery.originalFailure.error.code,'QUALITY_VALIDATION_FAILED');assert.equal(recovery.result.estimatedCents,0.125);assert.deepEqual(recovery.result.finance,f.job.rawResult.finance);assert.equal(recovery.result.quality.readinessBasis,'received_candidate');
 assert.deepEqual(f.objects.get(f.binding.rawResponseIdentity.key),originalRaw);assert.deepEqual(f.objects.get(f.binding.originalCandidateIdentity.key),originalCandidate);assert.ok(f.writes.every(k=>/quality-reviewed-review_/.test(k)===false&&/quality-reviewed-[a-f0-9]{64}\.json$/.test(k)));assert.notEqual(video.analysis_key,f.binding.originalCandidateIdentity.key);
 assert.deepEqual(await f.store.get('reels_controls/analysis'),control);assert.deepEqual(await f.store.get('reels_finance/preserved'),finance);assert.equal((await f.store.get('reels_executions/'+executionId(f.job.operationId,'Other_001','analysis'))).data.status,'queued');
 assert.doesNotThrow(()=>encodeFields(recovery));const writes=f.writes.length;const duplicate=await f.deliver({evidenceVersion:'stale-but-same-committed-review'});assert.equal((await duplicate.json()).duplicate,true);assert.equal(f.writes.length,writes);
});
test('same integration handles distinct saved executions in the same cohort without a special Reel branch',async()=>{
 for(const ordinal of [2,50,100]){const f=await fixture({ordinal});const response=await f.deliver();assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');assert.equal((await f.store.get('videos/'+f.reelId)).data.reels_v2.executionId,f.id);}
});
test('recovery preserves rejection with no review, invalid verdict, source text mutation or live ownership',async()=>{
 for(const problem of ['no-review','negative','source-text','live','foreign-owner','raw-integrity']){
  const f=await fixture({entriesTransform:entries=>{if(problem==='negative')entries[0].verdict='inconclusive';}}),before=await f.store.get('reels_executions/'+f.id);
  if(problem==='no-review')f.store.docs.delete('reels_quality_receipts/'+f.sealed.selection.id);
  if(problem==='source-text')f.store.docs.get('videos/'+f.reelId).data.source_caption.text+=' changed under same capture';
  if(problem==='live')f.store.docs.get('reels_controls/analysis').data.active=[f.id];
  if(problem==='foreign-owner')f.store.docs.get('videos/'+f.reelId).data.reels_v2.executionId='f'.repeat(64);
  if(problem==='raw-integrity')f.objects.get(f.binding.rawResponseIdentity.key).bytes=Buffer.from('{}');
  const response=await f.deliver(),result=await response.json();assert.equal(result.status==='completed',false);assert.ok([200,409].includes(response.status));assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);assert.equal([...f.store.docs.keys()].filter(k=>k.startsWith('reels_reconciliations/')).length,0);
 }
});
test('activation CAS observes every dependency and never mutates controls or review records',async()=>{
 for(const pathKind of ['video','control','review','selection']){
  const f=await fixture();f.store.beforeRecovery=async()=>{const path=pathKind==='video'?'videos/'+f.reelId:pathKind==='control'?'reels_controls/analysis':'reels_quality_receipts/'+(pathKind==='review'?f.sealed.review.id:f.sealed.selection.id);const old=f.store.docs.get(path);f.store.put(path,{...old.data,concurrentChange:true});};
  const response=await f.deliver();assert.equal(response.status,409);assert.equal((await f.store.get('reels_executions/'+f.id)).data.status,'failed');assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);assert.equal([...f.store.docs.keys()].filter(k=>k.startsWith('reels_reconciliations/')).length,0);
 }
});
test('lost activation acknowledgement and interruption after publication resume the exact receipt',async()=>{
 for(const point of ['commit-ack','after-publication']){
  const f=await fixture();let hit=false;
  if(point==='commit-ack')f.store.afterRecovery=async()=>{if(!hit){hit=true;throw Error('lost acknowledgement');}};
  else f.repository.refresh=async()=>{if(!hit){hit=true;throw Error('interrupted after video CAS');}};
  const first=await f.deliver();assert.equal(first.status,point==='commit-ack'?200:503);assert.equal(hit,true);
  const job=(await f.store.get('reels_executions/'+f.id)).data,pointer=clone(job.qualityReviewRecovery),beforeRaw=clone(job.rawResult);
  const next=await f.deliver({evidenceVersion:'old'});assert.equal(next.status,200);assert.equal((await next.json()).status,'completed');
  const completed=(await f.store.get('reels_executions/'+f.id)).data;assert.deepEqual(completed.qualityReviewRecovery,pointer);assert.deepEqual(completed.rawResult,beforeRaw);assert.equal([...f.store.docs.keys()].filter(k=>k.startsWith('reels_reconciliations/')).length,1);
 }
});
test('changed immutable review after activation is detected before publication and on resume',async()=>{
 const f=await fixture();f.store.afterRecovery=async()=>{const path='reels_quality_receipts/'+f.sealed.selection.id,old=await f.store.get(path);f.store.put(path,{...old.data,reviewHash:'f'.repeat(64)});};
 const response=await f.deliver();assert.equal(response.status,409);assert.equal((await response.json()).code,'QUALITY_REVIEW_CHANGED');assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);
 assert.equal((await f.deliver()).status,409);assert.equal((await f.store.get('reels_executions/'+f.id)).data.status,'applying');
});
test('quality route authenticates, fixes analysis stage and rejects caller reports before dependencies',async()=>{
 let calls=0;const dependencies={get api(){calls++;assert.fail('dependencies must remain lazy');}},config={project,reels_runtime_version:'v2',reels_processing_enabled:true,worker_origin:'https://worker.run.app'};
 const req=body=>new Request('https://worker.run.app/tasks/quality-review',{method:'POST',body:JSON.stringify(body)}),body={executionId:'a'.repeat(64),reviewId:'review_'+'b'.repeat(64),evidenceVersion:'v1'};
 assert.equal((await reelsGoogleRuntime(config,{}, {stage:'analysis',authorize:()=>false,dependencies})(req(body))).status,401);
 assert.equal((await reelsGoogleRuntime(config,{}, {stage:'transcription',authorize:()=>true,dependencies})(req(body))).status,409);
 const handler=reelsGoogleRuntime(config,{}, {stage:'analysis',authorize:()=>true,dependencies});
 for(const extra of [{report:{}},{trustedReviews:[]},{reviewId:'unsealed'},{evidenceVersion:''}])assert.equal((await handler(req({...body,...extra}))).status,400);assert.equal(calls,0);
});

function importMaterial(f,{draftTransform,approvalTransform,packageTransform}={}){
 f.store.docs.delete('reels_quality_receipts/'+f.sealed.review.id);f.store.docs.delete('reels_quality_receipts/'+f.sealed.selection.id);
 const prefix=`results/instagram/${f.reelId}/${f.id}/quality-review/`,binding=qualityReviewBinding(f.binding),manifest=qualitySourceManifest(f.record);
 const frameProof=f.sealInput.entries.find(e=>e.frameArtifacts).frameArtifacts,frames=frameProof.map(frame=>({name:frame.artifact.key.split('/').at(-1),artifact:frame.artifact}));
 const proposed=f.sealInput.entries.map(e=>({fieldPath:e.fieldPath,verdict:e.verdict,reason:'Proposed wording independently reviewed.',...(e.frameArtifacts?{reviewedFrameNames:e.frameArtifacts.map(x=>x.artifact.key.split('/').at(-1)),frameSampleSeconds:e.frameArtifacts.flatMap(x=>x.sampleSeconds)}:{})}));
 const draft={...binding,editorIdentity:'fixture-editor',editorThreadId:'fixture-editor-thread',reviewerIdentity:'fixture-reviewer',reviewerThreadId:'fixture-independent-thread',normativeEditorialFields:['report','entriesForIndependentApproval'],report:f.sealInput.report,entriesForIndependentApproval:proposed};draftTransform?.(draft);
 const draftArtifact=f.save(prefix+'approved-draft.json','21',draft);
 const valueAt=path=>path.split('.').reduce((v,k)=>v?.[k],draft.report);
 const approval={kind:'independent_editorial_approval_not_production_receipt',decision:'approved_for_exact_report_and_entries',executor:'codex-native',run_id:'fixture-reviewer',native_thread_id:'fixture-independent-thread',recorded_at:'2026-10-19T00:00:00Z',draft:{sha256:draftArtifact.sha256},entryReviews:proposed.map(e=>({fieldPath:e.fieldPath,decision:'approve',verdict:e.verdict,exactReviewedValue:valueAt(e.fieldPath),method:'synthetic independent caption and pixel inspection',independentReason:'Actual synthetic independent verdict; no real-source claim.',pixelsReviewed:!!e.reviewedFrameNames,reviewedFrames:(e.reviewedFrameNames??[]).map((name,index)=>({name,timestampSeconds:e.frameSampleSeconds[index],sha256:frames.find(f=>f.name===name).artifact.sha256,sourceVideo:manifest.video}))}))};approvalTransform?.(approval);
 const approvalArtifact=f.save(prefix+'independent-approval.json','22',approval),pkg={version:1,kind:'independent_source_review_import',...binding,draftArtifact,approvalArtifact,frames};packageTransform?.(pkg);
 return {packageIdentity:f.save(prefix+'import-package.json','23',pkg),pkg,draft,approval};
}
test('real authenticated import reads private package, approval and every pixel before create-only selection',async()=>{
 const f=await fixture(),m=importMaterial(f),before=await f.store.get('reels_executions/'+f.id),control=await f.store.get('reels_controls/analysis');
 const response=await f.importDelivery(m.packageIdentity);assert.equal(response.status,200);const imported=await response.json();assert.equal(imported.status,'review_imported');assert.equal(imported.publicationPerformed,false);assert.notEqual(imported.reviewId,f.sealed.review.id);
 assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);assert.deepEqual(await f.store.get('reels_controls/analysis'),control);assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);
 const selected=(await f.store.get('reels_quality_receipts/'+f.sealed.selection.id)).data,review=(await f.store.get('reels_quality_receipts/'+imported.reviewId)).data;assert.equal(selected.reviewId,imported.reviewId);assert.equal(review.entries[0].reason,m.approval.entryReviews[0].independentReason);assert.equal(review.entries[0].method,m.approval.entryReviews[0].method);assert.deepEqual(review.importEvidence,{packageIdentity:m.packageIdentity,draftArtifact:m.pkg.draftArtifact});
 for(const frame of m.pkg.frames)assert.ok(f.reads.some(r=>r.key===frame.artifact.key&&r.generation===frame.artifact.generation));
 assert.equal((await (await f.importDelivery(m.packageIdentity)).json()).reviewId,imported.reviewId);assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);
 const applied=await f.deliver({reviewId:imported.reviewId});assert.equal(applied.status,200);assert.equal((await applied.json()).status,'completed');assert.deepEqual((await f.store.get('reels_executions/'+f.id)).data.rawResult,f.job.rawResult);
});
test('editorial import rejects missing identities, unsupported verdicts, mismatched values and incomplete frame coverage',async()=>{
 const changes=[
  {draftTransform:d=>{delete d.editorIdentity;}},
  {draftTransform:d=>{delete d.editorThreadId;}},
  {draftTransform:d=>{delete d.reviewerIdentity;},approvalTransform:a=>{delete a.run_id;}},
  {draftTransform:d=>{delete d.reviewerThreadId;},approvalTransform:a=>{delete a.native_thread_id;}},
  {approvalTransform:a=>{a.native_thread_id='fixture-editor-thread';}},
  {approvalTransform:a=>{a.draft.sha256='0'.repeat(64);}},
  {approvalTransform:a=>{a.entryReviews[0].exactReviewedValue='unreviewed proposition';}},
  {approvalTransform:a=>{a.entryReviews[0].verdict='invalid';}},
  {approvalTransform:a=>{delete a.entryReviews[0].method;}},
  {packageTransform:p=>{p.frames.pop();}},
  {approvalTransform:a=>{a.entryReviews.find(e=>e.pixelsReviewed).reviewedFrames[1].timestampSeconds=11;}},
  {packageTransform:p=>{p.originalReportHash='a'.repeat(64);}},
  {packageTransform:p=>{p.approvalArtifact={...p.approvalArtifact,key:'private/unrelated.json'};}},
  {draftTransform:d=>{d.report.qualityEvidenceV2.applications[0].evidence=[];}},
  {draftTransform:d=>{d.entriesForIndependentApproval[0].verdict='inconclusive';}}
 ];
 for(const change of changes){const f=await fixture(),m=importMaterial(f,change),before=await f.store.get('reels_executions/'+f.id);const response=await f.importDelivery(m.packageIdentity);assert.equal(response.status,409);assert.equal(await f.store.get('reels_quality_receipts/'+f.sealed.selection.id),null);assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);}
});
test('import detects artifact byte tampering and conflicts with a different immutable selection',async()=>{
 for(const kind of ['bytes','selection']){
  const f=await fixture(),m=importMaterial(f);let originalSelection=null;
  if(kind==='bytes')f.objects.get(m.pkg.frames[1].artifact.key).bytes=Buffer.from('corrupted pixels');
  else{await f.store.create('reels_quality_receipts/'+f.sealed.selection.id,{...f.sealed.selection,reviewId:'review_'+'f'.repeat(64)});originalSelection=await f.store.get('reels_quality_receipts/'+f.sealed.selection.id);}
  const response=await f.importDelivery(m.packageIdentity);assert.equal(response.status,409);assert.deepEqual(await f.store.get('reels_quality_receipts/'+f.sealed.selection.id),originalSelection);assert.equal((await f.store.get('reels_executions/'+f.id)).data.status,'failed');
 }
});
test('import request cannot supply a report, reviews or an arbitrary object key',async()=>{
 const f=await fixture(),m=importMaterial(f);
 for(const extra of [{report:{}},{trustedReviews:[]},{packageIdentity:{...m.packageIdentity,extra:'forbidden'}}])assert.equal((await f.importDelivery(m.packageIdentity,extra)).status,400);
 f.reads.length=0;assert.equal((await f.importDelivery({...m.packageIdentity,key:'private/arbitrary.json'})).status,409);assert.equal(f.reads.filter(r=>r.key==='private/arbitrary.json').length,0);
});

test('publication CAS fences exact caption, transcript and duration after activation under the same identities',async()=>{
 for(const field of ['caption','transcript','duration']){
  const f=await fixture(),get=f.store.get;let activated=false,videoReads=0,changed=false;
  f.store.afterRecovery=async()=>{activated=true;};
  f.store.get=async path=>{if(activated&&path==='videos/'+f.reelId&&++videoReads===2){const current=f.store.docs.get(path).data,copy=clone(current);if(field==='caption')copy.source_caption.text+=' same capture, different text';else if(field==='transcript')copy.transcript='new text under same transcript generation';else copy.duration_seconds+=1;f.store.put(path,copy);changed=true;}return get(path);};
  const response=await f.deliver();assert.equal(response.status,200);assert.equal((await response.json()).status,'failed');assert.equal(changed,true);assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);const job=(await f.store.get('reels_executions/'+f.id)).data;assert.equal(job.error.code,'QUALITY_PUBLICATION_REVISION_CONFLICT');assert.deepEqual(job.rawResult,f.job.rawResult);assert.equal(job.attempt,1);
 }
});
test('resume checks reviewed source content again after interruption before publication',async()=>{
 const f=await fixture(),patch=f.store.patch;let stopped=false;
 f.store.patch=async(path,changes,options)=>{if(path==='videos/'+f.reelId&&!stopped){stopped=true;throw Error('interrupted before publication');}return patch(path,changes,options);};
 assert.equal((await f.deliver()).status,503);assert.equal((await f.store.get('reels_executions/'+f.id)).data.status,'applying');
 const path='videos/'+f.reelId,current=clone(f.store.docs.get(path).data);current.source_caption.text+=' changed text';f.store.put(path,current);
 const response=await f.deliver({evidenceVersion:'original'});assert.equal(response.status,200);assert.equal((await response.json()).status,'failed');assert.equal((await f.store.get('videos/'+f.reelId)).data.analysis_key,null);assert.deepEqual((await f.store.get('reels_executions/'+f.id)).data.rawResult,f.job.rawResult);
});

test('accepted evidence gate with unexplained technical readiness never creates review or selection',async()=>{
 const f=await fixture({reportTransform:report=>{report.knowledge.missing_information=[];}}),m=importMaterial(f);
 const verified=verifyQualitySourceReview({...f.binding,...f.sealed}),outcome=analysisReportOutcome(verified.report,f.record,{requireKnowledge:true,qualityGateV2:{mediaInspection:f.record.media_inspection_receipt,transcriptionReceipt:f.record.transcription_receipt,trustedReviews:verified.trustedReviews}});
 assert.equal(outcome.accepted,true,'regression specifically requires evidence gate accepted');
 const before=await f.store.get('reels_executions/'+f.id),response=await f.importDelivery(m.packageIdentity);assert.equal(response.status,409);assert.equal((await response.json()).code,'UNEXPLAINED_CONTEXT_GAPS');
 assert.equal(await f.store.get('reels_quality_receipts/'+f.sealed.selection.id),null);assert.equal([...f.store.docs.keys()].filter(p=>p.startsWith('reels_quality_receipts/')).length,0);assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);assert.equal(f.writes.length,0);
});

async function reviewedFailureFixture(){
 const f=await fixture(),entries=clone(f.sealInput.entries);entries[0].verdict='inconclusive';
 const prior=sealQualitySourceReview({...f.sealInput,entries});
 await f.store.create('reels_quality_receipts/'+prior.review.id,prior.review);
 const independentReview={reviewId:prior.review.id,reviewHash:prior.selection.reviewHash,selectionId:prior.selection.id};
 const key=f.binding.originalCandidateIdentity.key.replace('quality-candidate.json','quality-reviewed-'+prior.review.id.slice(7)+'.json');
 const artifact={report:prior.review.report,candidateContentHash:prior.review.reportHash,rawResponseIdentity:f.binding.rawResponseIdentity,originalCandidateIdentity:f.binding.originalCandidateIdentity,independentReview,parseReasons:[]};
 f.save(key,'15',artifact);
 const job=clone(f.job);Object.assign(job.rawResult.changes,{analysis_candidate:prior.review.report,candidate_analysis_key:key,candidate_analysis_generation:'15'});
 job.rawResult.qualityReview={...independentReview,originalCandidateIdentity:f.binding.originalCandidateIdentity,rawResponseIdentity:f.binding.rawResponseIdentity};job.resultEvidence.resultHash=hash(job.rawResult);
 f.store.put('reels_executions/'+f.id,job);f.store.put('videos/'+f.reelId,{...f.record,...job.rawResult.changes});
 return {...f,prior,artifact,key,failedJob:job};
}
test('negative reviewed projection recovers via authenticated original without repeating production',async()=>{
 const f=await reviewedFailureFixture(),bytes=Buffer.from(f.objects.get(f.key).bytes);
 const response=await f.deliver();assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');
 assert.deepEqual((await f.store.get('reels_executions/'+f.id)).data.rawResult,f.failedJob.rawResult);
 assert.deepEqual(f.objects.get(f.key).bytes,bytes);assert.ok(f.reads.some(x=>x.key===f.key&&x.generation==='15'));
 const writes=f.writes.length;assert.equal((await (await f.deliver()).json()).duplicate,true);assert.equal(f.writes.length,writes);
});
test('reviewed recovery rejects modified generation, links, bytes, report and immutable prior review',async()=>{
 for(const problem of ['generation','original-link','raw-link','bytes','report','review-record','projected-report']){
  const f=await reviewedFailureFixture();
  if(problem==='generation')f.objects.get(f.key).generation='16';
  if(problem==='original-link'){f.artifact.originalCandidateIdentity={...f.binding.originalCandidateIdentity,generation:'999'};f.save(f.key,'15',f.artifact);}
  if(problem==='raw-link'){f.artifact.rawResponseIdentity={...f.binding.rawResponseIdentity,generation:'999'};f.save(f.key,'15',f.artifact);}
  if(problem==='bytes')f.objects.get(f.key).bytes=Buffer.from('{}');
  if(problem==='report'){f.artifact.report={...f.artifact.report,title:'Different report'};f.save(f.key,'15',f.artifact);}
  if(problem==='review-record')f.store.docs.get('reels_quality_receipts/'+f.prior.review.id).data.reportHash='a'.repeat(64);
  if(problem==='projected-report')f.store.docs.get('videos/'+f.reelId).data.analysis_candidate.title='Different projection';
  const before=await f.store.get('reels_executions/'+f.id),response=await f.deliver();assert.equal(response.status,409,problem);
  assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);assert.equal(f.writes.length,0);
 }
});
test('editorial import follows prior negative reviewed candidate before exact review recovery',async()=>{
 const f=await reviewedFailureFixture(),m=importMaterial(f),before=await f.store.get('reels_executions/'+f.id);
 const imported=await f.importDelivery(m.packageIdentity);assert.equal(imported.status,200);const result=await imported.json();assert.equal(result.publicationPerformed,false);
 assert.deepEqual(await f.store.get('reels_executions/'+f.id),before);
 const applied=await f.deliver({reviewId:result.reviewId});assert.equal(applied.status,200);assert.equal((await applied.json()).status,'completed');
});
