import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAnalysisRequest,validateAnalysis,reviewAnalysis} from '../lib/analysis.mjs';
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
const record={id:'DXVj0SkDesv',duration_seconds:60,media_verified:true,transcript:'Guardar a fonte facilita conferir a informação.'};
const report=()=>({title:'Organização',summary:'Guardar referências',categories:['Conhecimento'],useful_information:[{claim:'Guardar a fonte ajuda na conferência.',application:'Preservar a referência original.',classification:'author_claim',evidence:[{source:'transcript',start_seconds:0,end_seconds:10,excerpt:record.transcript}]}],visual_observations:[],limitations:['Não verificado externamente.'],transcript_quality:{assessment:'Revisão necessária.',uncertain_segments:[]}});
test('video and immutable transcript enter the same preset with a scoped GCS URI',()=>{
  const r=buildAnalysisRequest({record,bucket:'megabrain-v0-media',preset});
  assert.equal(r.contents[0].parts[0].fileData.fileUri,'gs://megabrain-v0-media/originals/instagram/DXVj0SkDesv/video.mp4');
  assert.equal(JSON.parse(r.contents[0].parts[1].text).transcript_raw,record.transcript);
  assert.equal(r.generationConfig.responseMimeType,'application/json');
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
test('invented transcript citations and out-of-range timestamps are rejected',()=>{
  const r=report();assert.equal(validateAnalysis(r,record),r);
  r.useful_information[0].evidence[0].excerpt='Uma afirmação inventada';assert.throws(()=>validateAnalysis(r,record));
  r.useful_information[0].evidence[0].excerpt=record.transcript;r.useful_information[0].evidence[0].end_seconds=61;assert.throws(()=>validateAnalysis(r,record));
});
