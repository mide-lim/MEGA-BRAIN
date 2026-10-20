import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport} from '../lib/reels-analysis-contract.mjs';
import {qualitySourceManifest,evaluateQualityGateV2,qualityDigest,qualityCandidateHash} from '../lib/reels-quality-gate.mjs';
import {analysisOutcome} from '../lib/analysis.mjs';
import {automaticReviewTargets,automaticFrameTimes,automaticReviewEntries} from '../lib/reels-quality-auto-review.mjs';
function fixture(){
 const record={id:'Point_fixture',duration_seconds:12,media_verified:true,video_key:'originals/instagram/Point_fixture/video.mp4',video_generation:'11',transcript:null,source_caption:{text:'Um exemplo visual salvo.',capture_id:'synthetic-caption'}};
 const manifest=qualitySourceManifest(record),contract=sourceAnchoredEvidenceContract(record,manifest),caption={source:'caption',sourceIdentity:{key:null,generation:null,captureId:manifest.caption.captureId},excerpt:record.source_caption.text,start_ref:'untimed',end_ref:'untimed'};
 // Exact observed omission SHAPE, wholly synthetic source and content.
 const point={source:'video',sourceIdentity:{key:manifest.video.key},excerpt:'Um objeto no instante amostrado.',start_ref:'t0'};
 const raw={title:record.source_caption.text,summary:record.source_caption.text,categories:['a-organizar'],useful_information:[],visual_observations:['Um objeto no instante amostrado.'],limitations:[],transcript_quality:{assessment:'Sem transcrição salva.',uncertain_segments:[]},knowledge:{context:'general',fields:[{kind:'other',name:'Informação',value:'Um objeto no instante amostrado.',evidence:[point]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[caption],summary:[caption],applications:[],visualObservations:[{index:0,evidence:[point]}]},evidence_contract:contract.version,evidence_anchor_hash:contract.hash};
 const mediaInspection={kind:'media-inspector',receiptId:'inspection_fixture',sourceIdentity:manifest.video,decodePassed:true,probePassed:true,durationSeconds:12,expectedAudio:false};record.media_inspection_receipt=mediaInspection;
 return {record,manifest,contract,raw,mediaInspection,point};
}
test('v1 exact pinned video omission becomes explicit point, not an inferred interval; original raw is unchanged',()=>{
 const f=fixture(),before=structuredClone(f.raw),p=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),e=p.knowledge.fields[0].evidence[0];
 assert.deepEqual(e.sourceIdentity,f.manifest.video);assert.equal(e.temporal_scope,'point');assert.equal(e.start_seconds,0);assert.equal(e.end_seconds,0);assert.deepEqual(f.raw,before);
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(f.raw)}]}}]},serialized=JSON.stringify(response),first=analysisOutcome(response,f.record,{requireKnowledge:true,qualityGateV2:{mediaInspection:f.mediaInspection}}),repeated=analysisOutcome(response,f.record,{requireKnowledge:true,qualityGateV2:{mediaInspection:f.mediaInspection}});
 assert.ok(first.report);assert.equal(first.accepted,false);assert.equal(first.report.knowledge.fields[0].evidence[0].temporal_scope,'point');assert.deepEqual(repeated,first);assert.equal(JSON.stringify(response),serialized);
 assert.ok(first.quality.checks.some(c=>c.code==='VISUAL_SUPPORT_UNVERIFIED'));
 const targets=automaticReviewTargets(f.record,first.report),target=targets.find(t=>t.fieldPath==='knowledge.fields.0.value');assert.equal(target.evidence[0].temporal_scope,'point');assert.deepEqual(automaticFrameTimes(targets,12),[]);
});
test('explicit nullable transport slots normalize without inventing caption time or losing complete video ranges',()=>{
 const f=fixture();f.raw.knowledge.fields[0].evidence[0]={...f.point,sourceIdentity:{...f.manifest.video,captureId:null},end_ref:'t1'};
 let p=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest);assert.deepEqual(p.qualityEvidenceV2.title[0].sourceIdentity,f.manifest.caption);assert.equal(p.qualityEvidenceV2.title[0].start_seconds,undefined);assert.equal(p.knowledge.fields[0].evidence[0].end_seconds,12);assert.equal(p.knowledge.fields[0].evidence[0].temporal_scope,undefined);
 f.raw.knowledge.fields[0].evidence[0].end_ref=null;p=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest);assert.equal(p.knowledge.fields[0].evidence[0].temporal_scope,'point');
});
test('point compatibility rejects changed generations, keys, manifests, unknown anchors and extra identity fields',()=>{
 for(const change of [p=>p.sourceIdentity.generation='99',p=>p.sourceIdentity.key='originals/foreign/video.mp4',p=>p.sourceIdentity.extra=null,p=>p.start_ref='t999',p=>delete p.start_ref,p=>p.start_seconds=0,p=>p.end_ref='t999',p=>p.temporal_scope='interval']){
  const f=fixture();change(f.raw.knowledge.fields[0].evidence[0]);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));
 }
 const f=fixture();f.raw.evidence_anchor_hash='0'.repeat(64);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),/hash/);
});
test('transcript evidence never inherits video point recovery or a missing source generation',()=>{
 const f=fixture();f.record.transcript='Texto salvo';f.record.transcript_key='results/synthetic/transcript.json';f.record.transcript_generation='12';f.record.transcript_words=[{word:'Texto salvo',start_seconds:0,end_seconds:1}];
 const manifest=qualitySourceManifest(f.record),contract=sourceAnchoredEvidenceContract(f.record,manifest);f.raw.evidence_anchor_hash=contract.hash;
 for(const sourceIdentity of [{key:manifest.transcript.key},manifest.transcript]){f.raw.knowledge.fields[0].evidence=[{source:'transcript',sourceIdentity,excerpt:'Texto salvo',start_ref:'t0'}];assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,manifest));}
});
test('a provider claiming supported cannot promote a point without measured frame timing',()=>{
 const f=fixture(),report=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),targets=automaticReviewTargets(f.record,report),frames=[{seconds:0,artifact:{key:'results/synthetic/frame.jpg',generation:'2',sha256:'a'.repeat(64)}}];
 const output=visualStatic=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({entries:targets.map(t=>({fieldPath:t.fieldPath,verdict:'supported',reason:'Synthetic independent verdict.',visualStatic:t.visual&&visualStatic,frameIds:t.visual?[0]:[],quotes:t.visual?[]:[{source:'caption',excerpt:f.record.source_caption.text}]}))})}]}}]});
 const entries=automaticReviewEntries({response:output(false),targets,frames,record:f.record,report});assert.ok(entries.filter(e=>targets.find(t=>t.fieldPath===e.fieldPath).visual).every(e=>e.verdict==='inconclusive'));
 const staticEntries=automaticReviewEntries({response:output(true),targets,frames,record:f.record,report});assert.equal(staticEntries.find(e=>e.fieldPath==='visual_observations.0').verdict,'inconclusive');assert.equal(staticEntries.find(e=>e.fieldPath==='visual_observations.0').visualPixelsReviewed,undefined);
 const trustedReviews=staticEntries.map(e=>({...e,receiptId:'synthetic-independent-'+e.fieldPath,kind:'independent_source_review',reportHash:qualityCandidateHash(report),sourceManifestHash:qualityDigest(f.manifest)}));
 assert.equal(evaluateQualityGateV2({record:f.record,report,mediaInspection:f.mediaInspection,trustedReviews}).accepted,false);
 const gate=evaluateQualityGateV2({record:f.record,report,mediaInspection:f.mediaInspection});assert.equal(gate.accepted,false);assert.ok(gate.checks.some(c=>c.code==='VISUAL_SUPPORT_UNVERIFIED'));
});


test('a sub-millisecond point remains exact in the candidate but never requests or certifies an approximate frame',()=>{
 const f=fixture(),at=1.2345;f.record.transcript_words=[{word:'synthetic',start_seconds:at,end_seconds:2.3456}];
 const contract=sourceAnchoredEvidenceContract(f.record,f.manifest),ref=contract.anchors.find(a=>a.seconds===at).ref;
 f.raw.evidence_anchor_hash=contract.hash;f.raw.knowledge.fields[0].evidence[0].start_ref=ref;
 const report=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),targets=automaticReviewTargets(f.record,report),times=automaticFrameTimes(targets,12);
 assert.deepEqual(times,[]);assert.equal(targets.find(t=>t.fieldPath==='knowledge.fields.0.value').evidence[0].end_seconds,at);
 const frames=[{seconds:at,artifact:{key:'results/synthetic/precise-frame.jpg',generation:'2',sha256:'a'.repeat(64)}}];
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({entries:targets.map(t=>({fieldPath:t.fieldPath,verdict:'supported',reason:'Synthetic exact point review.',visualStatic:t.visual,frameIds:t.visual?[0]:[],quotes:t.visual?[]:[{source:'caption',excerpt:f.record.source_caption.text}]}))})}]}}]};
 const entries=automaticReviewEntries({response,targets,frames,record:f.record,report});
 assert.equal(entries.find(e=>e.fieldPath==='knowledge.fields.0.value').verdict,'inconclusive');assert.equal(entries.find(e=>e.fieldPath==='knowledge.fields.0.value').frameArtifacts,undefined);
});


test('the final media boundary remains an unobserved point instead of inventing a preceding frame',()=>{
 const f=fixture();f.raw.knowledge.fields[0].evidence[0].start_ref=f.contract.anchors.at(-1).ref;
 const report=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),targets=automaticReviewTargets(f.record,report);
 assert.equal(report.knowledge.fields[0].evidence[0].start_seconds,12);assert.equal(report.knowledge.fields[0].evidence[0].end_seconds,12);assert.deepEqual(automaticFrameTimes(targets,12),[]);
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({entries:targets.map(t=>({fieldPath:t.fieldPath,verdict:'supported',reason:'Synthetic missing end-boundary pixels.',visualStatic:t.visual,frameIds:[],quotes:t.visual?[]:[{source:'caption',excerpt:f.record.source_caption.text}]}))})}]}}]};
 const entries=automaticReviewEntries({response,targets,frames:[],record:f.record,report});assert.equal(entries.find(e=>e.fieldPath==='knowledge.fields.0.value').verdict,'inconclusive');assert.equal(entries.find(e=>e.fieldPath==='visual_observations.0').verdict,'inconclusive');
});
