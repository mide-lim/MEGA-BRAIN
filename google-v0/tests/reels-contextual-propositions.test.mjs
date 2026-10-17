import test from 'node:test';
import assert from 'node:assert/strict';
import {projectContextualPublication} from '../lib/reels-contextual-projection.mjs';
import {persistQualityCandidateV2,verifyPublicationQualityReceipt,qualityCandidateHash,qualitySourceManifest,qualityDigest} from '../lib/reels-quality-gate.mjs';
import {contextualPropositionEntries,semanticQualityPolicyVersion} from '../lib/reels-quality-semantic-policy.mjs';
async function publication({propositions=true,evidenceOnly=false}={}){
 const text='Use 200 g de frango.',record={id:'QaV2_prop',duration_seconds:20,media_verified:true,video_key:'originals/instagram/QaV2_prop/video.mp4',video_generation:'1',audio_key:'prepared/audio.flac',audio_generation:'2',audio_bytes:100,audio_sha256:'a'.repeat(64),audio_source_key:'originals/instagram/QaV2_prop/video.mp4',audio_source_generation:'1',transcript:text,transcript_key:'results/transcript.json',transcript_generation:'3',source_caption:{text,capture_id:'capture-v2'}};
 const sourceIdentity=qualitySourceManifest(record).caption,e={source:'caption',sourceIdentity,excerpt:text};
 const report={title:text,summary:text,categories:['receitas'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Texto salvo.',uncertain_segments:[]},knowledge:{context:'recipe',fields:[],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[e],summary:[e]},source_consolidation:{sources:[{source:'caption',text,capture_id:'capture-v2'},{source:'transcript',text}]},contextualSignals:{version:2,primaryContext:{categoryId:'receitas',purpose:'Uma receita.',evidenceRefs:['p1']},units:[],attributes:[{dimension:'ingredient',valueId:'frango',scope:'video',unitIds:[],role:'central',polarity:'positive',state:'supported',evidenceRefs:['p1']}],evidence:[{id:'p1',sourceKind:'caption',sourceIdentity:'capture-v2',excerpt:text,verificationLevel:'semantic_support_reviewed'}]}};
 const sourceManifestHash=qualityDigest(qualitySourceManifest(record)),reportHash=qualityCandidateHash(report),trustedReviews=propositions?contextualPropositionEntries(report).map(e=>({receiptId:'review-'+e.kind,kind:'independent_source_review',fieldPath:e.fieldPath,propositionHash:e.propositionHash,reportHash,sourceManifestHash,policyVersion:semanticQualityPolicyVersion,method:'exact-source-reading',observedAt:'2026-10-17T22:00:00Z',verdict:'supported'})):[];
 if(evidenceOnly)trustedReviews.push({receiptId:'review-evidence',kind:'human_source_review',fieldPath:'contextualSignals.evidence.p1',reportHash,sourceManifestHash,verdict:'supported'});
 let receipt;
 const result=await persistQualityCandidateV2({record,report,rawResponse:{synthetic:true},trustedReviews,mediaInspection:{kind:'media-inspector',receiptId:'inspect',sourceIdentity:qualitySourceManifest(record).video,decodePassed:true,probePassed:true,durationSeconds:20,expectedAudio:true,audioTrackPresent:true},transcriptionReceipt:{operationIdentity:'saved-operation',sourceAudioIdentity:qualitySourceManifest(record).audio,resultIdentity:qualitySourceManifest(record).transcript,rawResultIdentity:{key:'raw/stt.json',generation:'4'},words:[{start_seconds:0,end_seconds:2}]},ports:{saveCandidate:async v=>({key:'analysis/saved.json',generation:'5',candidateContentHash:v.candidateContentHash}),saveReceipt:async v=>{receipt=v;return {id:v.id,receiptHash:qualityDigest(v)};},compareAndSetPublication:async()=>({applied:true})}});
 assert.equal(result.publicationChanged,true);
 const video={...record,analysis:report,analysis_key:'analysis/saved.json',analysis_generation:'5',analysis_quality_status:'accepted',publication:{qualityReceipt:result.receiptIdentity}},verification=verifyPublicationQualityReceipt({video,receipt}),item={id:record.id,title:text,categoryIds:['receitas'],publication:{available:true}};
 return {video,verification,item,receipt,entry:projectContextualPublication({video,item,qualityVerification:verification})};
}
test('an exact server receipt independently binds the entire attribute role and primary purpose',async()=>{
 const {entry,verification}=await publication();assert.equal(verification.trusted,true);assert.equal(verification.verifiedAttributes.length,1);
 const a=entry.attributes.find(a=>a.dimensionId==='ingredient');assert.equal(a.state,'supported');assert.equal(a.role,'central');assert.equal(a.reason,'EXACT_ATTRIBUTE_PROPOSITION_REVIEWED');assert.equal(entry.context.state,'supported');assert.equal(entry.independentUnitCount,null);assert.deepEqual(a.unitIds,[]);
});
test('an evidence-only review never promotes an attribute, role or primary context proposition',async()=>{
 const {entry,verification}=await publication({propositions:false,evidenceOnly:true});assert.deepEqual(verification.verifiedAttributes,[]);
 const a=entry.attributes.find(a=>a.dimensionId==='ingredient');assert.equal(a.state,'present_unverified');assert.equal(a.role,'unknown');assert.equal(a.claimedRole,'central');assert.equal(entry.independentUnitCount,null);
});
test('modifying role or source content invalidates an otherwise trusted receipt',async()=>{
 const {video,item,receipt}=await publication();video.analysis.contextualSignals.attributes[0].role='supporting';
 const verification=verifyPublicationQualityReceipt({video,receipt});assert.equal(verification.trusted,false);
 const a=projectContextualPublication({video,item,qualityVerification:verification}).attributes.find(a=>a.dimensionId==='ingredient');assert.equal(a.state,'present_unverified');assert.equal(a.role,'unknown');
});
test('a reviewed video-wide inclusion cannot invent complete units or a SAME_UNIT association',async()=>{
 const {entry}=await publication();const a=entry.attributes.find(a=>a.dimensionId==='ingredient');assert.equal(a.state,'supported');assert.deepEqual(entry.units,[]);assert.deepEqual(a.unitIds,[]);assert.equal(entry.independentUnitCount,null);
});
