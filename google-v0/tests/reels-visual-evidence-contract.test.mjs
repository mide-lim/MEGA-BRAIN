import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAnalysisRequest,analysisOutcome} from '../lib/analysis.mjs';
import {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport,visualObservationsContract} from '../lib/reels-analysis-contract.mjs';
import {qualitySourceManifest,qualityCandidateHash,evaluateQualityGateV2} from '../lib/reels-quality-gate.mjs';
import {automaticReviewTargets} from '../lib/reels-quality-auto-review.mjs';
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
function fixture(){
 const record={id:'Visual_fixture',duration_seconds:12,media_verified:true,video_key:'originals/instagram/Visual_fixture/video.mp4',video_generation:'11',transcript:null,source_caption:{text:'Um prato com molho.',capture_id:'synthetic-caption'}};
 const manifest=qualitySourceManifest(record),anchors=sourceAnchoredEvidenceContract(record,manifest);
 const caption={source:'caption',sourceIdentity:manifest.caption,excerpt:record.source_caption.text,start_ref:'untimed',end_ref:'untimed'};
 const evidence={source:'video',sourceIdentity:manifest.video,excerpt:'Um prato com molho.',start_ref:'t0',end_ref:'t1'};
 const raw={title:record.source_caption.text,summary:record.source_caption.text,categories:['a-organizar'],useful_information:[],visual_observations:[{observation:'  Um prato com molho.  ',evidence:[evidence]}],limitations:[],transcript_quality:{assessment:'Sem fala.',uncertain_segments:[]},knowledge:{context:'general',fields:[{kind:'other',name:'Informação',value:record.source_caption.text,evidence:[caption]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[caption],summary:[caption],applications:[]},evidence_contract:anchors.version,evidence_anchor_hash:anchors.hash,visual_observations_contract:visualObservationsContract};
 return {record,manifest,anchors,raw,evidence};
}
test('new gate-v2 wire schema couples each visual observation with its own nonempty video references',()=>{
 const f=fixture(),request=buildAnalysisRequest({record:f.record,bucket:'megabrain-v0-media',preset,qualityGateV2Enabled:true}),schema=request.generationConfig.responseSchema,item=schema.properties.visual_observations.items;
 assert.deepEqual(schema.properties.visual_observations_contract.enum,[visualObservationsContract]);assert.ok(schema.required.includes('visual_observations_contract'));
 assert.deepEqual(item.required,['observation','evidence']);assert.equal(item.properties.evidence.minItems,1);assert.equal(schema.properties.visual_observations.minItems,undefined);
 assert.deepEqual(item.properties.evidence.items.properties.source.enum,['video']);assert.deepEqual(item.properties.evidence.items.properties.sourceIdentity.required,['key','generation']);
 for(const key of ['start_ref','end_ref'])assert.deepEqual(item.properties.evidence.items.properties[key].enum,f.anchors.anchors.map(a=>a.ref));
 assert.equal(schema.properties.qualityEvidenceV2.properties.visualObservations,undefined);assert.ok(!schema.properties.qualityEvidenceV2.required.includes('visualObservations'));
 assert.match(request.systemInstruction.parts[0].text,/aparência estática/);assert.match(request.systemInstruction.parts[0].text,/Não descreva ações, sequência/);
 const legacy=buildAnalysisRequest({record:f.record,bucket:'megabrain-v0-media',preset}).generationConfig.responseSchema;assert.equal(legacy.properties.visual_observations.items.type,'STRING');assert.equal(legacy.properties.visual_observations_contract,undefined);
});
test('coupled normalization preserves every text and order without inventing references or visual approval',()=>{
 const f=fixture();f.raw.visual_observations.push({observation:'Outro aspecto estático.',evidence:[{...f.evidence,excerpt:'Outro aspecto.'}]});const before=structuredClone(f.raw);
 const result=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest);
 assert.deepEqual(result.visual_observations,['  Um prato com molho.  ','Outro aspecto estático.']);assert.equal(result.visual_observations_contract,undefined);
 assert.deepEqual(result.qualityEvidenceV2.visualObservations.map(x=>x.index),[0,1]);assert.equal(result.qualityEvidenceV2.visualObservations[1].evidence[0].excerpt,'Outro aspecto.');assert.equal(result.qualityEvidenceV2.visualObservations[0].evidence[0].start_seconds,0);assert.equal(result.qualityEvidenceV2.visualObservations[0].evidence[0].end_seconds,12);
 assert.deepEqual(f.raw,before);assert.ok(evaluateQualityGateV2({record:f.record,report:result}).checks.some(c=>c.code==='VISUAL_SUPPORT_UNVERIFIED'));assert.equal(evaluateQualityGateV2({record:f.record,report:result}).accepted,false);
 const targets=automaticReviewTargets(f.record,result).filter(t=>t.fieldPath.startsWith('visual_observations.'));assert.equal(targets.length,2);assert.ok(targets.every(t=>t.evidence.length===1&&t.visual));
 f.raw.visual_observations=[];assert.deepEqual(normalizeSourceAnchoredReport(f.raw,f.record,f.manifest).qualityEvidenceV2.visualObservations,[]);
});
test('missing, mixed and parallel visual evidence are rejected rather than silently dropped or copied',()=>{
 for(const edit of [r=>r.visual_observations.push('unbound'),r=>r.visual_observations.push({observation:'unbound'}),r=>r.visual_observations[0].evidence=[],r=>r.visual_observations[0]=null,r=>r.visual_observations[0].index=0,r=>r.visual_observations[0].observation=' ',r=>r.qualityEvidenceV2.visualObservations=[],r=>r.qualityEvidenceV2.visualObservations=[{index:0,evidence:[]},{index:0,evidence:[]}],r=>r.qualityEvidenceV2=null,r=>r.visual_observations=null]){
  const f=fixture();edit(f.raw);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));
 }
});
test('new visual references reject foreign identities, unknown anchors, inferred points and numeric time',()=>{
 for(const edit of [e=>e.source='caption',e=>e.sourceIdentity={key:'foreign',generation:'11'},e=>e.sourceIdentity.generation='99',e=>delete e.sourceIdentity.generation,e=>e.sourceIdentity.extra=null,e=>e.start_ref='t999',e=>e.end_ref='t0',e=>e.end_ref='untimed',e=>delete e.end_ref,e=>e.start_seconds=0,e=>e.temporal_scope='point',e=>e.excerpt='']){
  const f=fixture();edit(f.raw.visual_observations[0].evidence[0]);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));
 }
 for(const edit of [r=>r.evidence_anchor_hash='0'.repeat(64),r=>delete r.evidence_anchor_hash,r=>delete r.evidence_contract,r=>r.visual_observations_contract='unknown',r=>r.visual_observations_contract=null]){const f=fixture();edit(f.raw);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));}
 const f=fixture();assert.throws(()=>normalizeSourceAnchoredReport({visual_observations_contract:visualObservationsContract,visual_observations:[]},f.record,f.manifest));
});
test('saved legacy five-observation one-reference shape keeps exact report hash and four coverage gaps',()=>{
 const f=fixture(),legacy=structuredClone(f.raw);delete legacy.visual_observations_contract;
 legacy.visual_observations=Array.from({length:5},(_,i)=>'Synthetic observation '+i);legacy.qualityEvidenceV2.visualObservations=[{index:0,evidence:[f.evidence]}];
 const before=JSON.stringify(legacy),normalized=normalizeSourceAnchoredReport(legacy,f.record,f.manifest),expected=structuredClone(legacy);
 const norm=e=>{const {start_ref,end_ref,...rest}=e;return e.source==='video'?{...rest,start_seconds:0,end_seconds:12}:rest;};
 expected.qualityEvidenceV2.title=expected.qualityEvidenceV2.title.map(norm);expected.qualityEvidenceV2.summary=expected.qualityEvidenceV2.summary.map(norm);expected.qualityEvidenceV2.visualObservations[0].evidence=expected.qualityEvidenceV2.visualObservations[0].evidence.map(norm);expected.knowledge.fields[0].evidence=expected.knowledge.fields[0].evidence.map(norm);
 assert.deepEqual(normalized,expected);assert.equal(qualityCandidateHash(normalized),qualityCandidateHash(expected));assert.equal(JSON.stringify(legacy),before);
 const gaps=evaluateQualityGateV2({record:f.record,report:normalized}).checks.filter(c=>c.code==='CLAIM_EVIDENCE_MISSING');assert.deepEqual(gaps.map(c=>c.fieldPath),[1,2,3,4].map(i=>'visual_observations.'+i));
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(legacy)}]}}]},a=analysisOutcome(response,f.record,{qualityGateV2:{}}),b=analysisOutcome(response,f.record,{qualityGateV2:{}});assert.deepEqual(a,b);assert.equal(a.accepted,false);assert.equal(a.report.visual_observations.length,5);
});
