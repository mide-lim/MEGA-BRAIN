import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateQualityGateV2,qualitySourceManifest,qualityCandidateHash,qualityDigest,persistQualityCandidateV2,verifyPublicationQualityReceipt} from '../lib/reels-quality-gate.mjs';
import {semanticQualityPolicyVersion,contextualPropositionEntries} from '../lib/reels-quality-semantic-policy.mjs';
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
 const review={receiptId:'review_saved',kind:'human_source_review',fieldPath:'title',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(qualitySourceManifest(r)),verdict:'supported',visualPixelsReviewed:true,videoIdentity:qualitySourceManifest(r).video,sourceManifest:qualitySourceManifest(r),frameArtifact:{key:'frames/exact.jpg',generation:'5'}};
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

test('v2 rejects the whole saved candidate before legacy filtering or narrative replacement',()=>{
 const r=record(),p=report(r);p.knowledge.fields.push({kind:'product',name:'Produto inventado',value:'FAKE123',evidence:[{source:'caption',sourceIdentity:qualitySourceManifest(r).caption,excerpt:r.source_caption.text}]});
 const raw={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(p)}]}}]},before=structuredClone(raw);
 const result=analysisOutcome(raw,r,{qualityGateV2:evidence(r)});
 assert.equal(result.accepted,false);assert.equal(result.report.knowledge.fields.length,2);assert.equal(result.report.knowledge.fields[1].value,'FAKE123');assert.deepEqual(raw,before);
});
test('partial negated text, invented applications and unsupported visual observations are never approved',()=>{
 const r=record(),p=report(r);r.source_caption.text='Não use 200 g de frango.';r.transcript=r.source_caption.text;
 const e={source:'caption',sourceIdentity:qualitySourceManifest(r).caption,excerpt:r.source_caption.text};
 p.title=r.source_caption.text;p.summary=r.source_caption.text;p.qualityEvidenceV2={version:2,title:[e],summary:[e]};p.knowledge.fields[0].evidence=[e];p.source_consolidation.sources=[{source:'caption',text:r.source_caption.text,capture_id:r.source_caption.capture_id},{source:'transcript',text:r.transcript}];
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r)}).accepted,false);
 const a=record(),q=report(a);q.useful_information=[{claim:'Use 200 g de frango.',application:'Cura qualquer doença',classification:'author_claim',evidence:q.qualityEvidenceV2.summary}];
 let gate=evaluateQualityGateV2({record:a,report:q,...evidence(a)});assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.fieldPath==='useful_information.0.application'&&c.state==='inconclusive'));
 q.useful_information=[];q.visual_observations=['Use 200 g de frango.'];q.qualityEvidenceV2.visualObservations=[{index:0,evidence:q.qualityEvidenceV2.summary}];
 gate=evaluateQualityGateV2({record:a,report:q,...evidence(a)});assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.fieldPath==='visual_observations.0'&&c.code==='VISUAL_SUPPORT_UNVERIFIED'));
});
test('transcript evidence intervals must contain the excerpt in saved word data',()=>{
 const r=record(),p=report(r),e=evidence(r);p.qualityEvidenceV2.title=[{source:'transcript',sourceIdentity:qualitySourceManifest(r).transcript,excerpt:p.title,start_seconds:0,end_seconds:2}];
 e.transcriptionReceipt.words=[{start_seconds:0,end_seconds:2,word:'Outro conteúdo'}];
 assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).state,'invalid');
 e.transcriptionReceipt.words=[{start_seconds:0,end_seconds:2,word:p.title}];assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).accepted,true);
 delete e.transcriptionReceipt.words[0].word;assert.equal(evaluateQualityGateV2({record:r,report:p,...e}).accepted,false);
});
test('only an exact independent proposition receipt can certify centrality, purpose or a unit',async()=>{
 const r=record(),p=report(r),manifest=qualitySourceManifest(r);
 p.contextualSignals={version:2,primaryContext:{categoryId:'receitas',purpose:'receita',evidenceRefs:['e1']},units:[],attributes:[{dimension:'ingredient',valueId:'frango',scope:'video',unitIds:[],role:'central',polarity:'positive',state:'supported',evidenceRefs:['e1'],reason:'modelo diz'}],evidence:[{id:'e1',sourceKind:'caption',sourceIdentity:manifest.caption.captureId,excerpt:r.source_caption.text,verificationLevel:'semantic_support_reviewed'}]};
 let gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});assert.equal(gate.contextualPropositions.attributes[0].state,'present_unverified');assert.equal(gate.contextualPropositions.primaryContext.state,'present_unverified');
 const entry=contextualPropositionEntries(p).find(e=>e.kind==='attribute');
 const review={receiptId:'exact_attribute_review',kind:'human_source_review',fieldPath:entry.fieldPath,propositionHash:entry.propositionHash,reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(manifest),policyVersion:semanticQualityPolicyVersion,method:'source_reading',observedAt:'2026-10-17T22:00:00Z',verdict:'supported'};
 gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]});assert.equal(gate.contextualPropositions.attributes[0].state,'supported');assert.equal(gate.contextualPropositions.primaryContext.state,'present_unverified');
 p.contextualSignals.attributes[0].role='mentioned';gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]});assert.equal(gate.contextualPropositions.attributes[0].state,'present_unverified');
});

test('a proposition receipt cannot promote unreviewed pixels or overlapping independent recipe units',()=>{
 const r=record(),p=report(r),manifest=qualitySourceManifest(r),e=evidence(r);
 e.transcriptionReceipt.words=[{start_seconds:0,end_seconds:2,word:r.transcript}];
 p.contextualSignals={version:2,primaryContext:{categoryId:'receitas',purpose:'receita',evidenceRefs:['t']},units:[{unitId:'u1',type:'recipe',completeness:'complete',evidenceRefs:['t']},{unitId:'u2',type:'recipe',completeness:'complete',evidenceRefs:['t']}],attributes:[],evidence:[{id:'t',sourceKind:'transcript',sourceIdentity:manifest.transcript.key+'@'+manifest.transcript.generation,excerpt:r.transcript,timeRange:{startSeconds:0,endSeconds:2},verificationLevel:'literal_anchor_verified'}]};
 const reviews=contextualPropositionEntries(p).filter(v=>v.kind==='unit').map(v=>({receiptId:'review_'+v.fieldPath,kind:'human_source_review',fieldPath:v.fieldPath,propositionHash:v.propositionHash,reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(manifest),policyVersion:semanticQualityPolicyVersion,method:'source_reading',observedAt:'2026-10-17T22:00:00Z',verdict:'supported'}));
 const gate=evaluateQualityGateV2({record:r,report:p,...e,trustedReviews:reviews});assert.ok(gate.contextualPropositions.units.every(u=>u.state==='inconclusive'));
});

test('a positive caption quotation cannot hide the same proposition negated in the saved transcript',()=>{
 const r=record(),p=report(r);r.transcript='Não use 200 g de frango.';p.source_consolidation.sources[1].text=r.transcript;
 const gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.code==='CLAIM_NEGATED_CONTEXT'));assert.ok(gate.gaps.some(c=>c.code==='SOURCE_EQUIVALENCE_UNMEASURED'));
});

test('independent translation and typed review never replace missing or invalid references',()=>{
 const r=record(),p=report(r);p.title='Chicken in the oven';
 const review={receiptId:'real_test_review',kind:'human_source_review',fieldPath:'title',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(qualitySourceManifest(r)),verdict:'supported',reason:'Complete translation reviewed.'};
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]}).accepted,true);
 p.qualityEvidenceV2.title=[];review.reportHash=qualityCandidateHash(p);
 let gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]});assert.equal(gate.accepted,false);assert.equal(gate.checks.find(c=>c.fieldPath==='title').code,'CLAIM_EVIDENCE_MISSING');
 p.qualityEvidenceV2.title=[{source:'caption',sourceIdentity:{captureId:'foreign'},excerpt:r.source_caption.text}];review.reportHash=qualityCandidateHash(p);
 gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]});assert.equal(gate.checks.find(c=>c.fieldPath==='title').state,'invalid');
});
for(const path of ['title','knowledge.fields.0.kind'])test('negative and conflicting independent verdicts override literal support for '+path,()=>{
 const r=record(),p=report(r),binding={receiptId:'test_positive',kind:'independent_source_review',fieldPath:path,reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(qualitySourceManifest(r))};
 for(const verdict of ['inconclusive','invalid'])for(const supported of [false,true]){
  const rows=[{...binding,receiptId:'test_negative',verdict,reason:'Independent reviewer did not confirm this exact proposition.'},...(supported?[{...binding,verdict:'supported'}]:[])];
  for(const trustedReviews of [rows,[...rows].reverse()]){const gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews});assert.equal(gate.accepted,false);assert.equal(gate.checks.find(c=>c.fieldPath===path).state,verdict);}
 }
});
test('compound visual review requires its bounded complete artifact collection and samples inside field refs',()=>{
 const r=record(),p=report(r),m=qualitySourceManifest(r);p.title='A mesa contém dois pratos.';p.qualityEvidenceV2.title=[{source:'video',sourceIdentity:m.video,start_seconds:1,end_seconds:3,excerpt:'Quadros observados.'}];
 const review={receiptId:'visual_review',kind:'independent_source_review',fieldPath:'title',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(m),verdict:'supported',visualPixelsReviewed:true,sourceManifest:m,videoIdentity:m.video,frameArtifacts:[{artifact:{key:'frames/a.png',generation:'1',sha256:'a'.repeat(64)},sampleSeconds:[1]},{artifact:{key:'frames/b.png',generation:'2',sha256:'b'.repeat(64)},sampleSeconds:[3]}]};
 assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]}).accepted,true);
 review.frameArtifacts[1].sampleSeconds=[4];assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]}).accepted,false);
 review.frameArtifacts[1].sampleSeconds=[3];review.frameArtifacts[1].artifact.sha256='invalid';assert.equal(evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:[review]}).accepted,false);
});
test('application and visual evidence indices cannot silently discard a bad or duplicate ref',()=>{
 const r=record(),p=report(r);p.qualityEvidenceV2.applications=[{index:8,evidence:p.qualityEvidenceV2.title}];
 const gate=evaluateQualityGateV2({record:r,report:p,...evidence(r)});assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.code==='INDEXED_EVIDENCE_INVALID'));
 const request=buildAnalysisRequest({record:r,preset:{version:'fixture',system_instruction:'Analyze',user_instruction:'Summarize'},bucket:'fixture-bucket',qualityGateV2Enabled:true});
 assert.ok(request.generationConfig.responseSchema.properties.qualityEvidenceV2.required.includes('applications'));assert.equal(Object.hasOwn(request.generationConfig.responseSchema.properties.qualityEvidenceV2.properties,'visualObservations'),false);assert.ok(request.generationConfig.responseSchema.properties.visual_observations.items.required.includes('evidence'));
});

test('contextual visual evidence and typed-role reviews respect their own source windows',()=>{
 const r=record(),p=report(r),m=qualitySourceManifest(r),video={source:'video',sourceIdentity:m.video,start_seconds:1,end_seconds:3,excerpt:'Quadros revistos.'};
 p.contextualSignals={version:2,primaryContext:{categoryId:'receitas',purpose:'Receitas',evidenceRefs:['visual1']},units:[],attributes:[],evidence:[{id:'visual1',sourceKind:'video',sourceIdentity:m.video.key+'@'+m.video.generation,excerpt:video.excerpt,timeRange:{startSeconds:1,endSeconds:3}}]};
 p.knowledge.fields[0]={kind:'tool',name:'Ferramenta',value:'HTML',evidence:[video]};
 const common={kind:'independent_source_review',reportHash:qualityCandidateHash(p),sourceManifestHash:qualityDigest(m),verdict:'supported',visualPixelsReviewed:true,sourceManifest:m,videoIdentity:m.video,frameArtifacts:[{artifact:{key:'frames/exact.png',generation:'1',sha256:'a'.repeat(64)},sampleSeconds:[4]}]};
 const reviews=[{...common,receiptId:'context_visual',fieldPath:'contextualSignals.evidence.visual1'},{...common,receiptId:'role_visual',fieldPath:'knowledge.fields.0.kind'}];
 let gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:reviews});assert.equal(gate.contextualEvidence[0].state,'present_unverified');assert.equal(gate.checks.find(c=>c.fieldPath==='knowledge.fields.0.kind').state,'inconclusive');
 for(const row of reviews)row.frameArtifacts=[{...row.frameArtifacts[0],sampleSeconds:[2]}];
 gate=evaluateQualityGateV2({record:r,report:p,...evidence(r),trustedReviews:reviews});assert.equal(gate.contextualEvidence[0].state,'supported');assert.equal(gate.checks.find(c=>c.fieldPath==='knowledge.fields.0.kind').state,'supported');
});
