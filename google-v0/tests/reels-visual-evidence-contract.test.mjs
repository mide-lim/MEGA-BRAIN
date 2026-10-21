import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAnalysisRequest,analysisOutcome} from '../lib/analysis.mjs';
import {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport,visualObservationsContract,applicationsContract} from '../lib/reels-analysis-contract.mjs';
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

function applicationFixture(){
 const f=fixture(),e=structuredClone(f.raw.qualityEvidenceV2.title[0]);
 f.raw.application_evidence_contract=applicationsContract;delete f.raw.qualityEvidenceV2.applications;
 f.raw.useful_information=[{claim:'Um prato.',application:'  Um prato com molho.  ',classification:'author_claim',evidence:[e],application_evidence:[structuredClone(e)]},{claim:'Molho.',application:'Molho no prato.',classification:'author_claim',evidence:[structuredClone(e)],application_evidence:[{...structuredClone(e),excerpt:'molho'}]}];
 return f;
}
test('new application evidence is coupled and all identity slots enumerate only existing source values',()=>{
 const f=applicationFixture();Object.assign(f.record,{transcript:'Um prato.',transcript_key:'results/synthetic/transcript.json',transcript_generation:'22',transcript_words:[{word:'Um prato.',start_seconds:0,end_seconds:1}]});
 const m=qualitySourceManifest(f.record),req=buildAnalysisRequest({record:f.record,preset,bucket:'fixture',qualityGateV2Enabled:true,taxonomySignalsEnabled:true}),p=req.generationConfig.responseSchema.properties;
 assert.deepEqual(p.application_evidence_contract.enum,[applicationsContract]);assert.equal(p.qualityEvidenceV2.properties.applications,undefined);assert.ok(p.useful_information.items.required.includes('application_evidence'));assert.equal(p.useful_information.items.properties.application_evidence.minItems,1);
 const all=[p.qualityEvidenceV2.properties.title,p.qualityEvidenceV2.properties.summary,p.useful_information.items.properties.application_evidence,p.useful_information.items.properties.evidence,p.knowledge.properties.fields.items.properties.evidence,p.knowledge.properties.keywords.items.properties.evidence];
 for(const a of all){const id=a.items.properties.sourceIdentity.properties;assert.deepEqual(id.key.enum,[m.transcript.key,m.video.key]);assert.deepEqual(id.generation.enum,['22','11']);assert.deepEqual(id.captureId.enum,[m.caption.captureId]);assert.equal(id.key.nullable,true);}
 for(const [a,identity] of [[p.visual_observations.items.properties.evidence,m.video],[p.taxonomySignals.properties.units.items.properties.evidence,m.transcript]]){const id=a.items.properties.sourceIdentity.properties;assert.deepEqual(id.key.enum,[identity.key]);assert.deepEqual(id.generation.enum,[identity.generation]);assert.equal(id.key.nullable,undefined);}
 assert.deepEqual(p.contextualSignals.properties.evidence.items.properties.sourceIdentity.enum,[m.caption.captureId,m.transcript.key+'@22',m.video.key+'@11']);
 assert.match(req.systemInstruction.parts[0].text,/application_evidence não vazia/);
 const only=sourceAnchoredEvidenceContract({id:'only',duration_seconds:1},{video:{key:'only.mp4',generation:'1'}});assert.deepEqual(only.evidence.items.properties.sourceIdentity.required,['key','generation']);assert.equal(only.evidence.items.properties.sourceIdentity.properties.captureId,undefined);
});
test('application normalization preserves exact texts, indexes, own references and legacy hash',()=>{
 const f=applicationFixture(),before=structuredClone(f.raw),normalized=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest);
 assert.deepEqual(f.raw,before);assert.equal(normalized.application_evidence_contract,undefined);assert.equal(normalized.useful_information[0].application,'  Um prato com molho.  ');assert.equal(normalized.useful_information[0].application_evidence,undefined);assert.deepEqual(normalized.qualityEvidenceV2.applications.map(x=>x.index),[0,1]);assert.equal(normalized.qualityEvidenceV2.applications[1].evidence[0].excerpt,'molho');assert.equal(evaluateQualityGateV2({record:f.record,report:normalized}).accepted,false);
 const legacy=structuredClone(before);delete legacy.application_evidence_contract;legacy.qualityEvidenceV2.applications=legacy.useful_information.map((i,index)=>({index,evidence:i.application_evidence}));for(const i of legacy.useful_information)delete i.application_evidence;
 assert.deepEqual(normalizeSourceAnchoredReport(legacy,f.record,f.manifest),normalized);assert.equal(qualityCandidateHash(normalizeSourceAnchoredReport(legacy,f.record,f.manifest)),qualityCandidateHash(normalized));
 delete legacy.qualityEvidenceV2.applications[1];legacy.qualityEvidenceV2.applications.length=1;const gap=normalizeSourceAnchoredReport(legacy,f.record,f.manifest);assert.equal(gap.useful_information.length,2);assert.ok(evaluateQualityGateV2({record:f.record,report:gap}).checks.some(c=>c.fieldPath==='useful_information.1.application'&&c.code==='CLAIM_EVIDENCE_MISSING'));
 const independent=applicationFixture();delete independent.raw.visual_observations_contract;independent.raw.visual_observations=[];independent.raw.qualityEvidenceV2.visualObservations=[];assert.equal(normalizeSourceAnchoredReport(independent.raw,independent.record,independent.manifest).qualityEvidenceV2.applications.length,2);
 f.raw.useful_information=[];assert.deepEqual(normalizeSourceAnchoredReport(f.raw,f.record,f.manifest).qualityEvidenceV2.applications,[]);
});
test('application marker and conflicting or unbound application evidence fail closed',()=>{
 for(const edit of [r=>delete r.application_evidence_contract,r=>r.application_evidence_contract='unknown',r=>r.application_evidence_contract=null,r=>delete r.evidence_contract,r=>delete r.evidence_anchor_hash,r=>r.qualityEvidenceV2.applications=[],r=>r.qualityEvidenceV2=null,r=>r.useful_information=null,r=>r.useful_information[1]=null,r=>delete r.useful_information[1].application_evidence,r=>r.useful_information[1].application_evidence=[],r=>r.useful_information[1].application_evidence=['quote'],r=>r.useful_information[1].application=' ',r=>r.useful_information[1].applicationEvidence=[],r=>r.visual_observations_contract='unknown']){
  const f=applicationFixture();edit(f.raw);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));
 }
});
test('saved foreign visual key and key-only contextual video remain rejected; no identity repair',()=>{
 const f=applicationFixture(),before=structuredClone(f.raw);f.raw.visual_observations[0].evidence[0].sourceIdentity={key:'originals/instagram/ForeignNodes/video.mp4',generation:'11'};const invalid=structuredClone(f.raw);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));assert.deepEqual(f.raw,invalid);
 f.raw=before;f.raw.contextualSignals={evidence:[{id:'video',sourceKind:'video',sourceIdentity:f.manifest.video.key,excerpt:'Um prato.',start_ref:'t0',end_ref:'t1'}]};assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),/Identidade/);
});
test('flat source enum never authorizes mixed source identities or key/generation pairs',()=>{
 for(const change of [e=>e.sourceIdentity={key:'foreign',generation:'11'},e=>e.sourceIdentity={key:'originals/instagram/Visual_fixture/video.mp4',generation:'22'},e=>e.sourceIdentity={captureId:'foreign'},e=>e.source='video']){
  const f=applicationFixture();change(f.raw.useful_information[0].application_evidence[0]);assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest));
 }
});

test('individually allowed flat identity values cannot cross source pairs; narrative untimed stays bounded',()=>{
 const f=applicationFixture();Object.assign(f.record,{transcript:'Um prato.',transcript_key:'results/fixture/transcript.json',transcript_generation:'22'});f.manifest=qualitySourceManifest(f.record);const c=sourceAnchoredEvidenceContract(f.record,f.manifest);f.raw.evidence_anchor_hash=c.hash;
 const e=f.raw.useful_information[0].application_evidence[0];Object.assign(e,{source:'transcript',sourceIdentity:f.manifest.transcript,excerpt:'Um prato.'});
 const valid=normalizeSourceAnchoredReport(f.raw,f.record,f.manifest);assert.equal(valid.qualityEvidenceV2.applications[0].evidence[0].start_seconds,undefined);
 e.sourceIdentity={key:f.manifest.transcript.key,generation:f.manifest.video.generation};assert.ok(c.evidence.items.properties.sourceIdentity.properties.key.enum.includes(e.sourceIdentity.key));assert.ok(c.evidence.items.properties.sourceIdentity.properties.generation.enum.includes(e.sourceIdentity.generation));assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),/Identidade/);
 e.sourceIdentity=f.manifest.video;e.source='transcript';assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,f.manifest),/Identidade/);
});

test('missing video identity permits no visual item and never emits undefined or empty identity enums',()=>{
 const f=fixture();delete f.record.video_generation;const p=buildAnalysisRequest({record:f.record,preset,bucket:'fixture',qualityGateV2Enabled:true}).generationConfig.responseSchema.properties;
 assert.equal(p.visual_observations.maxItems,0);assert.deepEqual(p.qualityEvidenceV2.properties.title.items.properties.source.enum,['caption']);assert.deepEqual(p.qualityEvidenceV2.properties.title.items.properties.sourceIdentity.required,['captureId']);
 const m=qualitySourceManifest(f.record),c=sourceAnchoredEvidenceContract(f.record,m);f.raw.evidence_anchor_hash=c.hash;assert.throws(()=>normalizeSourceAnchoredReport(f.raw,f.record,m));f.raw.visual_observations=[];assert.deepEqual(normalizeSourceAnchoredReport(f.raw,f.record,m).visual_observations,[]);
 const walk=x=>{if(!x||typeof x!=='object')return;if(x.enum)assert.ok(x.enum.length&&x.enum.every(v=>typeof v==='string'));for(const v of Object.values(x))if(Array.isArray(v))v.forEach(walk);else walk(v);};walk(p);
});
