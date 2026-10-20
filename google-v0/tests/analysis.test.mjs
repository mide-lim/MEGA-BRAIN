import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAnalysisRequest,validateAnalysis,reviewAnalysis,analysisPublication} from '../lib/analysis.mjs';
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
const record={id:'DXVj0SkDesv',duration_seconds:60,media_verified:true,transcript:'Guardar a fonte facilita conferir a informação.'};
const report=()=>({title:'Organização',summary:'Guardar referências',categories:['Conhecimento'],useful_information:[{claim:'Guardar a fonte ajuda na conferência.',application:'Preservar a referência original.',classification:'author_claim',evidence:[{source:'transcript',start_seconds:0,end_seconds:10,excerpt:record.transcript}]}],visual_observations:[],limitations:['Não verificado externamente.'],transcript_quality:{assessment:'Revisão necessária.',uncertain_segments:[]}});
test('video and immutable transcript enter the same preset with a scoped GCS URI',()=>{
  const r=buildAnalysisRequest({record,bucket:'megabrain-v0-media',preset});
  assert.equal(r.contents[0].parts[0].fileData.fileUri,'gs://megabrain-v0-media/originals/instagram/DXVj0SkDesv/video.mp4');
  assert.equal(JSON.parse(r.contents[0].parts[1].text).transcript_raw,record.transcript);
  assert.equal(r.generationConfig.responseMimeType,'application/json');
});

test('gate-v2 provider evidence uses flat objects and finite time references with server-bound identities',async()=>{
 const {qualitySourceManifest}=await import('../lib/reels-quality-gate.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',transcript_key:'results/test/transcript.json',transcript_generation:'12',transcript_words:[{start_seconds:0.125,end_seconds:2.75,word:'Guardar'}],source_caption:{text:'Guardar a fonte.',capture_id:'capture-test'}};
 const args={record:r,bucket:'megabrain-v0-media',preset,qualityGateV2Enabled:true,taxonomySignalsEnabled:true};
 const request=buildAnalysisRequest(args),schema=request.generationConfig.responseSchema,payload=JSON.parse(request.contents[0].parts[1].text),manifest=qualitySourceManifest(r);
 assert.equal(request.generationConfig.maxOutputTokens,8192);
 assert.equal(payload.evidence_contract,'source-anchors-v1');assert.equal(payload.evidence_anchor_hash.length,64);
 assert.deepEqual(payload.source_manifest,manifest);
 assert.deepEqual(payload.source_time_anchors.map(a=>a.seconds),[0,0.125,2.75,60]);
 const keys=[];const walk=value=>{if(!value||typeof value!=='object')return;keys.push(...Object.keys(value.properties??{}));for(const child of Object.values(value))if(typeof child==='object'){if(Array.isArray(child))child.forEach(walk);else walk(child);}};
 walk(schema);for(const key of ['start_seconds','end_seconds','startSeconds','endSeconds','timeRange'])assert.ok(!keys.includes(key),key);
 const paths=[schema.properties.useful_information.items.properties.evidence,schema.properties.knowledge.properties.fields.items.properties.evidence,schema.properties.knowledge.properties.keywords.items.properties.evidence,schema.properties.qualityEvidenceV2.properties.title,schema.properties.qualityEvidenceV2.properties.summary,schema.properties.qualityEvidenceV2.properties.applications.items.properties.evidence];
 for(const evidence of paths){
  const item=evidence.items;assert.equal(item.type,'OBJECT');assert.equal(item.anyOf,undefined);
  assert.deepEqual(item.properties.source.enum,['caption','transcript','video']);assert.ok(item.required.includes('sourceIdentity'));
  assert.equal(item.properties.sourceIdentity.type,'OBJECT');assert.deepEqual(item.properties.sourceIdentity.required,['key','generation','captureId']);assert.ok(item.required.includes('start_ref'));assert.ok(item.required.includes('end_ref'));
  for(const property of Object.values(item.properties.sourceIdentity.properties)){assert.equal(property.type,'STRING');assert.equal(property.enum,undefined);}
  assert.equal(item.properties.start_ref.type,'STRING');assert.deepEqual(item.properties.start_ref.enum,[...payload.source_time_anchors.map(a=>a.ref),'untimed']);assert.equal(item.properties.start_ref.nullable,undefined);
  assert.deepEqual(item.properties.end_ref.enum,item.properties.start_ref.enum);
 }
 const contextual=schema.properties.contextualSignals.properties.evidence.items;assert.equal(contextual.type,'OBJECT');assert.equal(contextual.anyOf,undefined);assert.deepEqual(contextual.properties.sourceKind.enum,['caption','transcript','video']);assert.equal(contextual.properties.sourceIdentity.type,'STRING');assert.equal(contextual.properties.sourceIdentity.enum,undefined);
 assert.deepEqual(buildAnalysisRequest(args),request);
 assert.equal(buildAnalysisRequest({record,bucket:'megabrain-v0-media',preset}).generationConfig.responseSchema.properties.evidence_contract,undefined);
});

test('anchor catalogue is bounded to existing timestamps and binds restore to exact source versions',async()=>{
 const {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport}=await import('../lib/reels-analysis-contract.mjs');
 const {qualitySourceManifest}=await import('../lib/reels-quality-gate.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',transcript_key:'results/test/transcript.json',transcript_generation:'12',transcript_words:Array.from({length:500},(_,i)=>({start_seconds:i/10,end_seconds:(i+1)/10,word:'x'}))};
 const manifest=qualitySourceManifest(r),contract=sourceAnchoredEvidenceContract(r,manifest),allowed=new Set([0,r.duration_seconds,...r.transcript_words.flatMap(w=>[w.start_seconds,w.end_seconds])]);
 assert.equal(contract.anchors.length,64);assert.equal(contract.anchors[0].seconds,0);assert.equal(contract.anchors.at(-1).seconds,60);
 assert.ok(contract.anchors.every(a=>allowed.has(a.seconds)));
 const e={source:'transcript',sourceIdentity:manifest.transcript,excerpt:'Guardar',start_ref:contract.anchors[0].ref,end_ref:contract.anchors.at(-1).ref};
 const raw={evidence_contract:contract.version,evidence_anchor_hash:contract.hash,useful_information:[{evidence:[e]}],qualityEvidenceV2:{version:2,title:[e],summary:[e],applications:[{index:0,evidence:[e]}],visualObservations:[{index:0,evidence:[{...e,source:'video',sourceIdentity:manifest.video}]}]},knowledge:{fields:[{evidence:[e]}],keywords:[{evidence:[e]}]},taxonomySignals:{units:[{evidence:[e]}]},contextualSignals:{evidence:[{id:'proof',sourceKind:'transcript',sourceIdentity:manifest.transcript.key+'@'+manifest.transcript.generation,excerpt:'Guardar',start_ref:e.start_ref,end_ref:e.end_ref,verificationLevel:'source_present'}]}};
 const before=structuredClone(raw),normalized=normalizeSourceAnchoredReport(raw,r,manifest);
 for(const item of [normalized.useful_information[0],normalized.knowledge.fields[0],normalized.knowledge.keywords[0],normalized.taxonomySignals.units[0],normalized.qualityEvidenceV2.applications[0],normalized.qualityEvidenceV2.visualObservations[0]]){assert.equal(item.evidence[0].start_seconds,0);assert.equal(item.evidence[0].end_seconds,60);assert.equal(item.evidence[0].start_ref,undefined);}
 assert.deepEqual(normalized.contextualSignals.evidence[0].timeRange,{startSeconds:0,endSeconds:60});assert.deepEqual(raw,before);
 assert.throws(()=>normalizeSourceAnchoredReport(raw,{...r,video_generation:'99'},qualitySourceManifest({...r,video_generation:'99'})),/hash/);
 assert.throws(()=>normalizeSourceAnchoredReport(raw,{...r,transcript_words:[]},manifest),/hash/);
 const legacy={qualityEvidenceV2:{version:2,title:[{source:'video',start_seconds:0.125,end_seconds:2.75}]}};
 assert.equal(normalizeSourceAnchoredReport(legacy,r,manifest),legacy);
});

test('malformed numeric transport, mixed caption times and invented identities are rejected without repairing evidence',async()=>{
 const {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport}=await import('../lib/reels-analysis-contract.mjs');
 const {qualitySourceManifest}=await import('../lib/reels-quality-gate.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',source_caption:{text:'Guardar a fonte.',capture_id:'capture-test'}},manifest=qualitySourceManifest(r),c=sourceAnchoredEvidenceContract(r,manifest);
 const wrap=e=>({evidence_contract:c.version,evidence_anchor_hash:c.hash,qualityEvidenceV2:{version:2,title:[e],summary:[]}});
 const valid={source:'video',sourceIdentity:manifest.video,excerpt:'Guardar',start_ref:'t0',end_ref:'t1'};
 for(const e of [
  {...valid,start_seconds:0},
  {...valid,start_ref:'0.000E'+'0'.repeat(1000)},
  {...valid,start_ref:'0.000000123456789'+'0'.repeat(1000)},
  {...valid,sourceIdentity:{generation:manifest.video.generation}},
  {...valid,sourceIdentity:{...manifest.video,generation:'99'}},
  {source:'video',sourceIdentity:manifest.video,excerpt:'Guardar'},
  {...valid,start_ref:'t1',end_ref:'t0'},
  {source:'caption',sourceIdentity:manifest.caption,excerpt:'Guardar',start_ref:'t0',end_ref:'t1'},
  {...valid,timeRange:{startSeconds:0,endSeconds:60}}
 ]){const raw=wrap(e),before=structuredClone(raw);assert.throws(()=>normalizeSourceAnchoredReport(raw,r,manifest));assert.deepEqual(raw,before);}
 const caption=normalizeSourceAnchoredReport(wrap({source:'caption',sourceIdentity:manifest.caption,excerpt:'Guardar'}),r,manifest);
 assert.equal(caption.qualityEvidenceV2.title[0].start_seconds,undefined);
});

test('new anchored response is evaluated and restored by the unchanged quality gate without rewriting raw bytes',async()=>{
 const {sourceAnchoredEvidenceContract}=await import('../lib/reels-analysis-contract.mjs');
 const {qualitySourceManifest,qualityCandidateHash}=await import('../lib/reels-quality-gate.mjs');
 const {analysisOutcome}=await import('../lib/analysis.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',transcript:null,source_caption:{text:'Guardar a fonte.',capture_id:'capture-test'}},manifest=qualitySourceManifest(r),c=sourceAnchoredEvidenceContract(r,manifest);
 const e={source:'caption',sourceIdentity:manifest.caption,excerpt:r.source_caption.text};
 const p={title:r.source_caption.text,summary:r.source_caption.text,categories:['a-organizar'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Sem transcrição salva.',uncertain_segments:[]},knowledge:{context:'general',fields:[{kind:'other',name:'Informação',value:r.source_caption.text,evidence:[e]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[e],summary:[e]},evidence_contract:c.version,evidence_anchor_hash:c.hash};
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(p)}]}}]},before=JSON.stringify(response);
 const opts={qualityGateV2:{mediaInspection:{kind:'media-inspector',receiptId:'inspection_fixture',sourceIdentity:manifest.video,decodePassed:true,probePassed:true,durationSeconds:60,expectedAudio:false}}};
 const first=analysisOutcome(response,r,opts),restored=analysisOutcome(response,r,opts);
 assert.equal(first.accepted,true);assert.deepEqual(restored,first);assert.equal(qualityCandidateHash(restored.report),qualityCandidateHash(first.report));assert.equal(JSON.stringify(response),before);
 const unsupported=structuredClone(response),bad={...p,title:'Uma conclusão inventada'};
 unsupported.candidates[0].content.parts[0].text=JSON.stringify(bad);
 assert.equal(analysisOutcome(unsupported,r,opts).accepted,false);
 const numeric=structuredClone(p);numeric.qualityEvidenceV2.title=[{source:'video',sourceIdentity:manifest.video,excerpt:'Guardar',start_seconds:0,end_seconds:60}];
 const invalid={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(numeric)}]}}]};
 assert.deepEqual(analysisOutcome(invalid,r,opts).reasons,['invalid_evidence_transport']);
});

test('factual transcript evidence requires saved timing while narrative gaps remain untimed',async()=>{
 const {qualitySourceManifest}=await import('../lib/reels-quality-gate.mjs');
 const {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport}=await import('../lib/reels-analysis-contract.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',transcript_key:'results/test/transcript.json',transcript_generation:'12',source_caption:{text:'Guardar a fonte.',capture_id:'capture-test'}};
 const requestFor=r=>buildAnalysisRequest({record:r,bucket:'megabrain-v0-media',preset,qualityGateV2Enabled:true,taxonomySignalsEnabled:true});
 const schema=requestFor(r).generationConfig.responseSchema;
 for(const family of [schema.properties.useful_information,schema.properties.knowledge.properties.fields,schema.properties.knowledge.properties.keywords]){
  const item=family.items.properties.evidence.items;assert.equal(item.type,'OBJECT');assert.ok(!item.properties.source.enum.includes('transcript'));
 }
 assert.equal(schema.properties.taxonomySignals,undefined);
 assert.match(requestFor(r).systemInstruction.parts[0].text,/omita taxonomySignals/);
 assert.doesNotMatch(requestFor(r).systemInstruction.parts[0].text,/forneça taxonomySignals/);
 const narrative=schema.properties.qualityEvidenceV2.properties.title.items;
 assert.ok(narrative.properties.source.enum.includes('transcript'));assert.ok(narrative.required.includes('start_ref'));assert.equal(narrative.properties.start_ref.nullable,undefined);assert.equal(narrative.properties.end_ref.nullable,undefined);assert.ok(narrative.properties.start_ref.enum.includes('untimed'));
 const manifest=qualitySourceManifest(r),c=sourceAnchoredEvidenceContract(r,manifest),e={source:'transcript',sourceIdentity:manifest.transcript,excerpt:record.transcript};
 const raw={evidence_contract:c.version,evidence_anchor_hash:c.hash,qualityEvidenceV2:{version:2,title:[e],summary:[e]},useful_information:[]};
 assert.equal(normalizeSourceAnchoredReport(raw,r,manifest).qualityEvidenceV2.title[0].start_seconds,undefined);
 for(const extra of [{useful_information:[{evidence:[e]}]},{knowledge:{fields:[{evidence:[e]}]}},{knowledge:{keywords:[{evidence:[e]}]}},{taxonomySignals:{units:[{evidence:[e]}]}}])assert.throws(()=>normalizeSourceAnchoredReport({...raw,...extra},r,manifest),/factual/);
 const timed={...r,transcript_words:[{word:record.transcript,start_seconds:0.125,end_seconds:2.75}]},timedSchema=requestFor(timed).generationConfig.responseSchema,tc=sourceAnchoredEvidenceContract(timed,manifest);
 for(const family of [timedSchema.properties.useful_information,timedSchema.properties.knowledge.properties.fields,timedSchema.properties.knowledge.properties.keywords,timedSchema.properties.taxonomySignals.properties.units]){
  const item=family.items.properties.evidence.items;assert.equal(item.type,'OBJECT');assert.ok(item.properties.source.enum.includes('transcript'));assert.ok(item.properties.start_ref.enum.length<=65);assert.ok(item.properties.end_ref.enum.length<=65);
 }
 const unitEvidence=timedSchema.properties.taxonomySignals.properties.units.items.properties.evidence.items;assert.deepEqual(unitEvidence.properties.source.enum,['transcript']);assert.ok(unitEvidence.required.includes('start_ref'));assert.ok(unitEvidence.required.includes('end_ref'));
 const timedRaw={...raw,evidence_anchor_hash:tc.hash,useful_information:[{evidence:[{...e,start_ref:'t1',end_ref:'t2'}]}]};
 assert.equal(normalizeSourceAnchoredReport(timedRaw,timed,manifest).useful_information[0].evidence[0].start_seconds,0.125);
 assert.throws(()=>normalizeSourceAnchoredReport({...timedRaw,useful_information:[{evidence:[e]}]},timed,manifest),/factual/);
});
test('review omits unsupported claims without rewriting quotes or discarding valid evidence',()=>{
 const original=report(),invalid=structuredClone(original.useful_information[0]);
 invalid.evidence[0].excerpt='Guardar a fonte... a informação.';
 original.useful_information.push(invalid);const copy=structuredClone(original);
 const reviewed=reviewAnalysis(original,record);
 assert.equal(reviewed.useful_information.length,1);
 assert.equal(reviewed.useful_information[0].evidence[0].excerpt,record.transcript);
 assert.match(reviewed.limitations.at(-1),/1 informação/);
 assert.deepEqual(original,copy);
 assert.throws(()=>reviewAnalysis({...original,categories:[]},record));
});
test('unverified media cannot start inference',()=>{
  assert.throws(()=>buildAnalysisRequest({record:{...record,media_verified:false},bucket:'megabrain-v0-media',preset}));
});

test('empty STT overrides invented quality without changing the original response',()=>{
 const original=report();original.transcript_quality.assessment='Transcrição clara em inglês.';
 const copy=structuredClone(original),empty={...record,transcript:'',transcript_status:'no_speech_recognized'};
 const reviewed=reviewAnalysis(original,empty);
 assert.equal(reviewed.useful_information.length,0);
 assert.match(reviewed.transcript_quality.assessment,/não há transcrição para avaliar/);
 assert.match(reviewed.transcript_quality.assessment,/não comprova ausência de fala/);
 assert.ok(reviewed.limitations.some(v=>v.startsWith('Transcrição vazia:')));
 assert.deepEqual(original,copy);
 assert.deepEqual(reviewAnalysis(reviewed,empty),reviewed);
});
test('invented transcript citations and out-of-range timestamps are rejected',()=>{
  const r=report();assert.equal(validateAnalysis(r,record),r);
  r.useful_information[0].evidence[0].excerpt='Uma afirmação inventada';assert.throws(()=>validateAnalysis(r,record));
  r.useful_information[0].evidence[0].excerpt=record.transcript;r.useful_information[0].evidence[0].end_seconds=61;assert.throws(()=>validateAnalysis(r,record));
});

test('curation includes captured captions and rejects unsupported caption quotations',()=>{
 const withCaption={...record,source_caption:{text:'Ingredientes: 200 g de queijo. Forno por 10 minutos.',capture_id:'captured-test'}};
 const request=buildAnalysisRequest({record:withCaption,bucket:'megabrain-v0-media',preset});
 assert.equal(JSON.parse(request.contents[0].parts[1].text).caption_raw,withCaption.source_caption.text);
 const original=report();original.useful_information[0].evidence=[{source:'caption',start_seconds:0,end_seconds:0,excerpt:'200 g de queijo'}];
 assert.equal(reviewAnalysis(original,withCaption).useful_information.length,1);
 assert.equal(reviewAnalysis(original,record).useful_information.length,0);
 original.useful_information[0].evidence[0].excerpt='300 g de queijo';
 assert.equal(reviewAnalysis(original,withCaption).useful_information.length,0);
});

test('a new empty extraction cannot erase previously supported knowledge',()=>{
 const previous={knowledge:{fields:[{name:'Supported'}]}};const r={knowledge:{fields:[]}};
 assert.equal(analysisPublication(r,{analysis:previous}).accepted,false);
 assert.equal(analysisPublication({knowledge:{fields:[{name:'New supported'}]}},{analysis:previous}).accepted,true);
 assert.deepEqual(previous.knowledge.fields,[{name:'Supported'}]);
});

test('saved response review rejects category shapes without inventing a destination',async()=>{
 const {analysisOutcome}=await import('../lib/analysis.mjs');
 for(const categories of [['tecnologia-geral','a-organizar'],['receitas','receitas'],['unknown'],[],['receitas','nutricao','carreira']]){
  const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({categories})}]}}]};
  const before=JSON.stringify(response);const outcome=analysisOutcome(response,{});
  assert.equal(outcome.accepted,false);assert.deepEqual(outcome.reasons,['invalid_categories']);assert.equal(outcome.report,undefined);assert.equal(JSON.stringify(response),before);
 }
});
test('malformed or incomplete received responses are review outcomes, never published',async()=>{
 const {analysisOutcome}=await import('../lib/analysis.mjs');
 for(const [response,reason] of [[{},'incomplete_response'],[{candidates:[{finishReason:'MAX_TOKENS'}]},'incomplete_response'],[{candidates:[{finishReason:'STOP',content:{parts:[{text:'not JSON'}]}}]},'invalid_json'],[{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({categories:['receitas']})}]}}]},'invalid_report']]){
  const result=analysisOutcome(response,{});assert.equal(result.accepted,false);assert.deepEqual(result.reasons,[reason]);
 }
});


test('saved optional taxonomy string evidence stays rejected without changing legacy candidate reasons',async()=>{
 const {sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport}=await import('../lib/reels-analysis-contract.mjs');
 const {qualitySourceManifest}=await import('../lib/reels-quality-gate.mjs');
 const {analysisOutcome}=await import('../lib/analysis.mjs');
 const r={...record,video_key:'originals/test/video.mp4',video_generation:'11',transcript_key:'results/test/transcript.json',transcript_generation:'12',source_caption:{text:'Guardar a fonte.',capture_id:'capture-test'}},manifest=qualitySourceManifest(r),c=sourceAnchoredEvidenceContract(r,manifest);
 const raw={evidence_contract:c.version,evidence_anchor_hash:c.hash,useful_information:[{evidence:[{source:'video',sourceIdentity:{...manifest.video,captureId:null},excerpt:'Synthetic claim',start_ref:'t0',end_ref:'t1'}]}],contextualSignals:{evidence:[{sourceKind:'transcript',sourceIdentity:manifest.transcript.key,excerpt:r.transcript,start_ref:'untimed',end_ref:'untimed'}]},taxonomySignals:{version:1,complete:true,units:[{id:'synthetic',kind:'recipe',title:'Synthetic',evidence:[r.transcript]}]}};
 const before=structuredClone(raw),response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(raw)}]}}]};
 assert.throws(()=>normalizeSourceAnchoredReport(raw,r,manifest),e=>e.code==='EVIDENCE_ENTRY_INVALID'&&e.transportSection==='taxonomySignals.units');
 const outcome=analysisOutcome(response,r,{qualityGateV2:{}});
 assert.equal(outcome.accepted,false);assert.equal(outcome.report,undefined);assert.deepEqual(outcome.reasons,['invalid_evidence_transport']);
 assert.deepEqual(outcome.transportDiagnostic,{code:'EVIDENCE_ENTRY_INVALID',section:'taxonomySignals.units'});assert.deepEqual(raw,before);
 for(const value of [null,42,'unbound']){raw.taxonomySignals.units[0].evidence=[value];assert.throws(()=>normalizeSourceAnchoredReport(raw,r,manifest),e=>e.code==='EVIDENCE_ENTRY_INVALID');}
 raw.evidence_anchor_hash='0'.repeat(64);assert.throws(()=>normalizeSourceAnchoredReport(raw,r,manifest),/hash/);
});
