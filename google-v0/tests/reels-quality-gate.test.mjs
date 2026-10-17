import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateQualityGateV2,qualitySourceManifest,qualityCandidateHash,qualityDigest,persistQualityCandidateV2,verifyPublicationQualityReceipt} from '../lib/reels-quality-gate.mjs';
import {buildAnalysisRequest,validateProviderResponseSchema,analysisOutcome} from '../lib/analysis.mjs';
const record=()=>({id:'reel_fixture',duration_seconds:20,media_verified:true,video_key:'originals/instagram/reel_fixture/video.mp4',video_generation:'1',audio_key:'prepared/reel_fixture/audio.flac',audio_generation:'2',audio_bytes:100,audio_sha256:'a'.repeat(64),audio_source_key:'originals/instagram/reel_fixture/video.mp4',audio_source_generation:'1',transcript:'Frango no forno. Use 200 g de frango.',transcript_key:'results/reel_fixture/transcript.json',transcript_generation:'3',source_caption:{text:'Frango no forno. Use 200 g de frango.',capture_id:'capture20261017'}});
const report=(r)=>{const manifest=qualitySourceManifest(r),e={source:'caption',sourceIdentity:manifest.caption,excerpt:r.source_caption.text};return {title:'Frango no forno.',summary:'Use 200 g de frango.',categories:['receitas'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Texto reconhecido, sem revisão independente.',uncertain_segments:[]},knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Ingrediente',value:'200 g de frango',evidence:[e]}],keywords:[],missing_information:['Rendimento não informado.']},qualityEvidenceV2:{version:2,title:[e],summary:[e]},source_consolidation:{sources:[{source:'caption',text:r.source_caption.text,capture_id:r.source_caption.capture_id},{source:'transcript',text:r.transcript}]}};};
const evidence=(r)=>({mediaInspection:{kind:'media-inspector',receiptId:'inspection_saved',sourceIdentity:qualitySourceManifest(r).video,decodePassed:true,probePassed:true,durationSeconds:20,expectedAudio:true,audioTrackPresent:true},transcriptionReceipt:{operationIdentity:'saved_operation',sourceAudioIdentity:qualitySourceManifest(r).audio,resultIdentity:qualitySourceManifest(r).transcript,rawResultIdentity:{key:'raw/stt.json',generation:'4'},words:[{start_seconds:0,end_seconds:2}]}});
test('future gate supports literal identified content while preserving legitimate gaps and unmeasured alignment',()=>{
 const r=record(),p=report(r),before=structuredClone({r,p}),gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});
 assert.equal(gate.accepted,true);assert.equal(gate.state,'supported');assert.equal(gate.replayAllowed,false);
 assert.ok(gate.gaps.some(c=>c.code==='TRANSCRIPT_ALIGNMENT_UNMEASURED'&&c.state==='unknown'));
 assert.ok(gate.gaps.some(c=>c.code==='CONTEXTUAL_ATTRIBUTES_NOT_RECORDED'&&c.state==='not_recorded'));assert.deepEqual({r,p},before);
});
test('unrelated literal anchor cannot certify a paraphrased title or summary',()=>{
 const r=record(),p=report(r);p.title='A melhor receita do mundo';
 const gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});
 assert.equal(gate.accepted,false);assert.equal(gate.checks.find(c=>c.fieldPath==='title').state,'inconclusive');
 p.qualityEvidenceV2.title[0].excerpt='Trecho inexistente';
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r)}).state,'invalid');
});
test('model video verification booleans and time windows never verify pixels',()=>{
 const r=record(),p=report(r);p.title='Há cinco pratos diferentes';
 p.qualityEvidenceV2.title=[{source:'video',sourceIdentity:qualitySourceManifest(r).video,excerpt:p.title,start_seconds:1,end_seconds:3,verified:true,visualPixelsReviewed:true}];
 const gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});
 assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.code==='VISUAL_SUPPORT_UNVERIFIED'));
 const review={receiptId:'review_saved',kind:'human_source_review',fieldPath:'title',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(qualitySourceManifest(r)),verdict:'supported',visualPixelsReviewed:true,frameArtifact:{key:'frames/exact.jpg',generation:'5'}};
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]}).accepted,true);
 assert.equal(evaluateQualityGateV2({record:r,report:{...p,title:'Outra afirmação'},...evidence(r),trustedReviews:[review]}).accepted,false);
});
test('STT empty text is legitimate, temporal corruption and audio generation mismatch are rejected',()=>{
 const r=record(),p=report(r),e=evidence(r);r.transcript='';p.source_consolidation.sources[1].text='';
 assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).accepted,true);
 e.transcriptionReceipt.words=[{start_seconds:3,end_seconds:5},{start_seconds:2,end_seconds:4}];
 assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).state,'invalid');
 e.transcriptionReceipt.words=[];r.audio_source_generation='9';
 assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).state,'invalid');
});
test('missing response, source identity and incomplete recipe preservation never approve or imply replay',()=>{
 const r=record(),p=report(r);
 assert.equal(evaluateQualityGateV2({record:r}).state,'inconclusive');
 p.source_consolidation.sources=[];assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r)}).accepted,false);
 assert.equal(evaluateQualityGateV2({record:r,report:report(r)}).accepted,false);
});
test('response and receipt become durable before CAS, and receipt verifies only the exact accepted report',async()=>{
 const r=record(),p=report(r),calls=[],saved={};
 const ports={
  saveCandidate:async value=>{calls.push('candidate');saved.candidate=value;return {key:'analysis/candidate.json',generation:'6',candidateContentHash:value.candidateContentHash};},
  saveReceipt:async value=>{calls.push('receipt');saved.receipt=value;return {id:value.id,receiptHash:qualityDigest(value)};},
  compareAndSetPublication:async value=>{calls.push('pointer');saved.pointer=value;return {applied:true};}
 };
 const result=await persistQualityCandidateV2({record:r,report:p,rawResponse:{saved:'exact'},ports,expectedPublicationRevision:'previous',...evidence(r)});
 assert.deepEqual(calls,['candidate','receipt','pointer']);assert.equal(result.publicationChanged,true);assert.equal(result.event.eventType,'publicationAccepted');assert.equal(saved.pointer.expectedPublicationRevision,'previous');
 const video={...r,analysis:p,analysis_key:'analysis/candidate.json',analysis_generation:'6',publication:{qualityReceipt:result.receiptIdentity}};
 assert.equal(verifyPublicationQualityReceipt({video,receipt:saved.receipt}).trusted,true);
 assert.equal(verifyPublicationQualityReceipt({video:{...video,analysis:{...p,summary:'Inventado'}},receipt:saved.receipt}).trusted,false);
 assert.equal(verifyPublicationQualityReceipt({video:{...video,analysis_generation:'7'},receipt:saved.receipt}).trusted,false);
 assert.equal(verifyPublicationQualityReceipt({video,receipt:{...saved.receipt,createdBy:'model'}}).trusted,false);
 assert.equal(verifyPublicationQualityReceipt({video:{...video,publication:{}},receipt:saved.receipt}).policyVersion,'historical_baseline');
});
test('invalid candidate, uncertain response and CAS conflict preserve the previous pointer',async()=>{
 const r=record(),p=report(r),calls=[];
 const ports={saveCandidate:async v=>{calls.push('candidate');return {key:'saved/candidate.json',generation:'1',candidateContentHash:v.candidateContentHash};},saveReceipt:async v=>{calls.push('receipt');return {id:v.id,receiptHash:qualityDigest(v)};},compareAndSetPublication:async()=>{calls.push('pointer');return {applied:false};}};
 const invalid=await persistQualityCandidateV2({record:r,report:{...p,title:'Inventado'},rawResponse:{raw:true},ports,...evidence(r)});
 assert.equal(invalid.publicationChanged,false);assert.deepEqual(calls,['candidate','receipt']);calls.length=0;
 const uncertain=await persistQualityCandidateV2({record:r,ports});assert.equal(uncertain.state,'inconclusive');assert.deepEqual(calls,[]);
 const conflict=await persistQualityCandidateV2({record:r,report:p,rawResponse:{raw:true},ports,...evidence(r)});
 assert.equal(conflict.publicationChanged,false);assert.equal(conflict.accepted,false);assert.deepEqual(conflict.reasons,['publication_revision_conflict']);
});
test('failed candidate or receipt persistence can never advance the accepted pointer',async()=>{
 const r=record(),p=report(r);let pointer=0;
 const ports={saveCandidate:async v=>({key:'saved/candidate.json',generation:'1',candidateContentHash:v.candidateContentHash}),saveReceipt:async()=>{throw Error('storage unavailable');},compareAndSetPublication:async()=>{pointer++;return {applied:true};}};
 await assert.rejects(persistQualityCandidateV2({record:r,report:p,rawResponse:{raw:true},ports,...evidence(r)}),/storage unavailable/);assert.equal(pointer,0);
});
test('opt-in quality and contextual attributes enrich the same request; default v1 request is unchanged',()=>{
 const r=record(),preset={version:'fixture',system_instruction:'Analise.',user_instruction:'Descreva.'},args={record:r,preset,bucket:'fixture-bucket'};
 const baseline=buildAnalysisRequest(args),explicit=buildAnalysisRequest({...args,qualityGateV2Enabled:false});
 assert.deepEqual(baseline,explicit);assert.equal(baseline.generationConfig.responseSchema.properties.contextualSignals,undefined);
 const v2=buildAnalysisRequest({...args,qualityGateV2Enabled:true,contextCatalogSnapshot:{revision:'catalog_v1',contexts:[]}});
 assert.equal(v2.contents.length,1);assert.equal(v2.contents[0].parts.length,2);
 const payload=JSON.parse(v2.contents[0].parts[1].text);assert.equal(payload.quality_policy_version,'gate_v2');assert.deepEqual(payload.source_manifest,qualitySourceManifest(r));
 assert.ok(v2.generationConfig.responseSchema.properties.contextualSignals);validateProviderResponseSchema(v2.generationConfig.responseSchema);
 assert.equal(baseline.generationConfig.responseSchema.properties.qualityEvidenceV2,undefined);
});

test('received gate-v2 outcome preserves provenance identities as metadata, not invented product claims',()=>{
 const r=record(),p=report(r),response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(p)}]}}]};
 const outcome=analysisOutcome(response,r,{requireKnowledge:true,qualityGateV2:evidence(r)});
 assert.equal(outcome.accepted,true);
 assert.equal(outcome.report.knowledge.fields.length,1);
 assert.deepEqual(outcome.report.knowledge.fields[0].evidence[0].sourceIdentity,{captureId:r.source_caption.capture_id});
});
test('contextual semantic receipts and literal-only anchors remain distinct and candidate verification is ignored',async()=>{
 const r=record(),p=report(r),manifest=qualitySourceManifest(r);
 p.contextualSignals={version:2,primaryContext:{categoryId:'receitas',purpose:'Receitas',evidenceRefs:['proof1']},units:[],attributes:[],evidence:[{id:'proof1',sourceKind:'caption',sourceIdentity:manifest.caption.captureId,excerpt:'200 g de frango',verificationLevel:'semantic_support_reviewed',verifiedBy:'model'}]};
 const literal=evaluateQualityGateV2({record:r,report:p,...evidence(r)});
 assert.equal(literal.contextualEvidence[0].verificationLevel,'literal_anchor_verified');
 const trustedReviews=[{receiptId:'independent_context_review',kind:'human_source_review',fieldPath:'contextualSignals.evidence.proof1',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(manifest),verdict:'supported'}];
 const semantic=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews});
 assert.equal(semantic.contextualEvidence[0].verificationLevel,'semantic_support_reviewed');
 p.contextualSignals.evidence[0].sourceIdentity='wrong_capture';
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews}).contextualEvidence[0].state,'invalid');
});
