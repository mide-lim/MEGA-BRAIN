import test from 'node:test';import assert from 'node:assert/strict';
import {categoryIds,categorySelectionSchema,validateCategoryIds,normalizedCategoryIds}from '../lib/category-taxonomy.mjs';
import {reportSchema,reviewSavedCategorySelection,validateProviderResponseSchema,buildAnalysisRequest}from '../lib/analysis.mjs';
const matches=(values,schema)=>schema.anyOf?schema.anyOf.some(s=>matches(values,s)):Array.isArray(values)&&values.length>=schema.minItems&&values.length<=schema.maxItems&&values.every(id=>schema.items.enum.includes(id));
const record={id:'Fixture_1',duration_seconds:60,transcript:'O algoritmo ajuda a identificar interesses.',media_verified:true};
function received(categories){return {candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({title:'Interesses',summary:'Exercício de autoconhecimento usando uma plataforma.',categories,useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Texto reconhecido.',uncertain_segments:[]},knowledge:{context:'general',keywords:[{term:'Interesses',evidence:[{source:'transcript',start_seconds:0,end_seconds:10,excerpt:'identificar interesses'}]}],fields:[{kind:'concept',name:'Interesses',value:'Identificar interesses pessoais.',evidence:[{source:'transcript',start_seconds:0,end_seconds:10,excerpt:record.transcript}]}],missing_information:[]}})}]}}]};}
const reason='A finalidade principal é autoconhecimento; a plataforma é apenas o instrumento.';
test('generation contract admits every valid selection and rejects general/specific mixes across every group',()=>{
 const schema=categorySelectionSchema();assert.deepEqual(reportSchema.properties.categories,schema);
 for(const id of categoryIds)assert.equal(matches([id],schema),true);
 for(const a of categoryIds)for(const b of categoryIds){
  const ids=[a,b];let valid=true;try{validateCategoryIds(ids);}catch{valid=false;}
  if(a!==b)assert.equal(matches(ids,schema),valid,ids.join(','));
 }
 assert.equal(matches(['bem-estar','tecnologia-geral'],schema),false);assert.equal(matches(['sustentabilidade-alimentar','tecnologia-geral'],schema),false);assert.equal(matches(['unknown'],schema),false);
});
test('no cross-group automatic fallback is introduced',()=>{
 for(const ids of [['bem-estar','tecnologia-geral'],['sustentabilidade-alimentar','tecnologia-geral']])assert.equal(normalizedCategoryIds(ids),ids);
});
test('explicit offline selection preserves received response and supported evidence',()=>{
 const source=received(['bem-estar','tecnologia-geral']),before=structuredClone(source);
 const review=reviewSavedCategorySelection(source,record,{categories:['bem-estar'],reason});
 assert.equal(review.accepted,true);assert.deepEqual(review.report.categories,['bem-estar']);assert.equal(review.report.knowledge.fields[0].evidence[0].excerpt,record.transcript);assert.deepEqual(source,before);assert.equal(review.category_review.inference_replayed,false);assert.equal(review.category_review.publication_performed,false);
});
test('operator may select generic original when that is the principal purpose',()=>{
 const result=reviewSavedCategorySelection(received(['sustentabilidade-alimentar','tecnologia-geral']),record,{categories:['tecnologia-geral'],reason:'O vídeo apresenta iniciativas tecnológicas; jardinagem é um exemplo citado.'});assert.equal(result.accepted,true);assert.deepEqual(result.report.categories,['tecnologia-geral']);
});
test('missing justification, new category and still-invalid selection are refused',()=>{
 const source=received(['bem-estar','tecnologia-geral']);for(const options of [{categories:['bem-estar']},{categories:['carreira'],reason},{categories:['bem-estar','tecnologia-geral'],reason}])assert.throws(()=>reviewSavedCategorySelection(source,record,options));
});
test('malformed, unknown, duplicated, already-valid and incomplete responses cannot use this recovery',()=>{
 for(const source of [received(['unknown','tecnologia-geral']),received(['bem-estar','bem-estar']),received(['bem-estar']),{candidates:[{finishReason:'MAX_TOKENS'}]},{}])assert.throws(()=>reviewSavedCategorySelection(source,record,{categories:['bem-estar'],reason}));
});
test('existing validation still rejects unsupported structure after category selection',()=>{
 const source=received(['bem-estar','tecnologia-geral']);const parsed=JSON.parse(source.candidates[0].content.parts[0].text);delete parsed.title;source.candidates[0].content.parts[0].text=JSON.stringify(parsed);
 const review=reviewSavedCategorySelection(source,record,{categories:['bem-estar'],reason});assert.equal(review.accepted,false);assert.deepEqual(review.reasons,['invalid_report']);
});

test('Vertex category schema uses standalone anyOf and retains each array branch constraint',()=>{
 const schema=categorySelectionSchema();assert.deepEqual(Object.keys(schema),['anyOf']);
 assert.doesNotThrow(()=>validateProviderResponseSchema(reportSchema));
 for(const branch of schema.anyOf){assert.equal(branch.type,'ARRAY');assert.equal(branch.minItems,1);assert.ok([1,2].includes(branch.maxItems));assert.equal(branch.items.type,'STRING');assert.ok(branch.items.enum.length);}
 for(const sibling of ['type','minItems','maxItems','items','description']){
  const malformed={...schema,[sibling]:'unexpected'};
  assert.throws(()=>validateProviderResponseSchema({type:'OBJECT',properties:{categories:malformed}}),/anyOf/);
 }
 assert.throws(()=>validateProviderResponseSchema({type:'ARRAY',items:{anyOf:[{type:'STRING'}],type:'STRING'}}),/anyOf/);
 assert.throws(()=>validateProviderResponseSchema({anyOf:[]}),/anyOf/);
 // A property whose name is anyOf is not itself a union schema node.
 assert.doesNotThrow(()=>validateProviderResponseSchema({type:'OBJECT',properties:{anyOf:{type:'STRING'}}}));
});
test('all supported analysis presets produce a schema matching the captured Vertex contract',()=>{
 for(const version of ['megabrain-video-text-v2','megabrain-video-text-v3','megabrain-video-text-v4']){
  const request=buildAnalysisRequest({record:{...record,media_verified:true},bucket:'megabrain-v0-test-media',model:'gemini-3.5-flash-lite',preset:{version,system_instruction:'Extrair fatos.',user_instruction:'Analisar a mídia.'}});
  const schema=request.generationConfig.responseSchema;
  assert.doesNotThrow(()=>validateProviderResponseSchema(schema));
  assert.deepEqual(Object.keys(schema.properties.categories),['anyOf']);
 }
});
