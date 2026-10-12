import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedCaptionNumbers,reviewKnowledge} from '../lib/knowledge.mjs';
// All excerpts are fictional and independent of the private evaluation corpus.
const field=(value,excerpt,kind='procedure')=>({kind,name:'Fictional step',value,evidence:[{source:'caption',excerpt}]});

test('container articles in bounded procedure locations are not invented quantities',()=>{
 for(const value of ['Transferir para um recipiente.','Transferir para uma tigela.','Aquecer em uma frigideira.','Montar sobre uma travessa.'])
  assert.equal(supportedCaptionNumbers(field(value,'Transfer to a dish and heat in a pan.')),true,value);
 assert.equal(supportedCaptionNumbers(field('Transferir para um recipiente e esperar um minuto.','Transfer to a dish.')),false);
 assert.equal(supportedCaptionNumbers(field('1 recipiente','Transfer to a dish.')),false);
 assert.equal(supportedCaptionNumbers(field('uma banana','Banana','ingredient')),false);
});

test('list numbers cannot support otherwise absent quantities',()=>{
 assert.equal(supportedCaptionNumbers(field('Esperar um minuto.','1. Wait briefly.')),false);
 assert.equal(supportedCaptionNumbers(field('Transferir para um recipiente.','4. Transfer to a dish.')),true);
 assert.equal(supportedCaptionNumbers(field('Cozinhar dois minutos em uma panela.','2. Cook for two minutes.')),true);
});

test('numeric and written measures remain supported only with matching evidence',()=>{
 assert.equal(supportedCaptionNumbers(field('Cozinhar por um minuto.','Cook for one minute.')),true);
 assert.equal(supportedCaptionNumbers(field('Cozinhar por dois minutos.','Cook for one minute.')),false);
 assert.equal(supportedCaptionNumbers(field('200 g','200 grams of cheese','ingredient')),true);
 assert.equal(supportedCaptionNumbers(field('300 g','200 grams of cheese','ingredient')),false);
 assert.equal(supportedCaptionNumbers(field('2 minutos','2 minutes and 200 grams of cheese')),true);
 assert.equal(supportedCaptionNumbers(field('200 minutos','2 minutes and 200 grams of cheese')),false);
});

test('explicit units cannot be borrowed from unrelated numbers or inferred from spoonful',()=>{
 assert.equal(supportedCaptionNumbers(field('200 ml','200 g of flour','quantity')),false);
 assert.equal(supportedCaptionNumbers(field('uma colher de sopa','Add a spoonful.')),false);
 assert.equal(supportedCaptionNumbers(field('uma colher de sopa','Add one teaspoon.')),false);
 assert.equal(supportedCaptionNumbers(field('uma colher de sopa','Add a tablespoon.')),true);
 assert.equal(supportedCaptionNumbers(field('uma colher de chá','Add one teaspoon.')),true);
 assert.equal(supportedCaptionNumbers(field('10 minutos','10 seconds')),false);
 assert.equal(supportedCaptionNumbers(field('180 °C','180 °F')),false);
});

test('fractions, mixed fractions and decimal commas have equivalent numeric representations',()=>{
 for(const [value,excerpt] of [['meia xícara','1/2 cup'],['0,5 xícara','half a cup'],['0.25 xícara','¼ cup'],['1,5 xícara','1 1/2 cups'],['2,5 xícaras','2½ cups']])
  assert.equal(supportedCaptionNumbers(field(value,excerpt)),true,value);
 assert.equal(supportedCaptionNumbers(field('3/4 xícara','1/2 cup')),false);
 assert.equal(supportedCaptionNumbers(field('1/0 xícara','1 cup')),false);
 assert.equal(supportedCaptionNumbers(field('1 xícara','1/0 cup')),false);
});

test('procedure articles do not relax literal evidence checks or mutate originals',()=>{
 const caption='4. Transfer to a dish.';
 const good=field('Transferir para um recipiente.',caption);
 const invalid=field('Transferir para um recipiente.','Transfer to a different dish.');
 const raw={context:'recipe',keywords:[],fields:[good,invalid],missing_information:[]};
 const snapshot=structuredClone(raw);
 const result=reviewKnowledge(raw,{duration_seconds:20,source_caption:{capture_id:'fictional-capture',text:caption}});
 assert.equal(result.omitted,1);assert.deepEqual(result.knowledge.fields,[good]);assert.deepEqual(raw,snapshot);
});

test('separate excerpts cannot assemble a quantity-unit pair that neither contains',()=>{
 const f=field('200 g','200');f.evidence.push({source:'caption',excerpt:'g'});
 assert.equal(supportedCaptionNumbers(f),false);
});

test('explicit abbreviation spellings preserve multilingual measures without punctuation wildcards',()=>{
 for(const [value,excerpt] of [['3 xícaras','3 xic. de fruta'],['1/4 colher de sopa','1/4 col. de sopa'],['3 colheres de sopa','3ст.л.'],['3 colheres de sopa','3ст.л'],['30 minutos','30 минут.']])
  assert.equal(supportedCaptionNumbers(field(value,excerpt)),true,value);
 assert.equal(supportedCaptionNumbers(field('3 colheres de sopa','3стXл')),false);
 assert.equal(supportedCaptionNumbers(field('3 xícaras','3 xicarao')),false);
});


test('singular container articles cannot contradict explicit source counts',()=>{
 for(const quote of ['Divide the mixture into two bowls.','Divida a mistura em duas tigelas.','Divide into 2 bowls and wait one minute.','Divide into two large bowls.'])
  assert.equal(supportedCaptionNumbers(field('Dividir a mistura em uma tigela.',quote)),false,quote);
 assert.equal(supportedCaptionNumbers(field('Dividir em 1 tigela.','Divide into two bowls and wait one minute.')),false);
 assert.equal(supportedCaptionNumbers(field('Transferir para um recipiente.','Transfer to a dish.')),true);
 assert.equal(supportedCaptionNumbers(field('Transferir para uma tigela.','Transfer into one bowl.')),true);
 // A field can preserve the source count explicitly rather than ignore it.
 assert.equal(supportedCaptionNumbers(field('Dividir em duas tigelas.','Divide into two bowls.')),true);
 assert.equal(supportedCaptionNumbers(field('Dividir em três tigelas.','Divide into two bowls.')),false);
});

test('mixed container counts remain ambiguous for a singular locative article',()=>{
 assert.equal(supportedCaptionNumbers(field('Transferir para um recipiente.','Use one bowl and two pans.')),false);
});

test('reviewKnowledge omits the conflicting count without changing the original field',()=>{
 const quote='Divide the mixture into two bowls.';
 const f=field('Dividir a mistura em uma tigela.',quote);
 const k={context:'recipe',keywords:[],fields:[f],missing_information:[]};const copy=structuredClone(k);
 const result=reviewKnowledge(k,{duration_seconds:15,source_caption:{capture_id:'fictional',text:quote}});
 assert.equal(result.omitted,1);assert.equal(result.knowledge.fields.length,0);assert.deepEqual(k,copy);
});


test('plural containers do not become singular when a count phrase needs review',()=>{
 for(const quote of ['Divide into two ceramic bowls.','Distribute among bowls.','Divida em duas tigelas pequenas.'])
  assert.equal(supportedCaptionNumbers(field('Dividir em uma tigela.',quote)),false,quote);
 assert.equal(supportedCaptionNumbers(field('Colocar dois ovos em uma tigela.','Place two eggs in a bowl.')),true);
});
