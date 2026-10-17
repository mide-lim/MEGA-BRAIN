import test from 'node:test';
import assert from 'node:assert/strict';
import {insightCards} from '../lib/reels-insight-display.mjs';

test('published author claims keep their wording, proposed application and quoted source separate',()=>{
 const source=[{claim:'O autor orienta assar o peixe após preparar os tomates.',application:'Usar a sequência como referência; o tempo de forno não foi informado.',classification:'author_claim',evidence:[{source:'transcript',start_seconds:4,end_seconds:12,excerpt:'depois entram os filés de peixe'}]}];
 const before=structuredClone(source),[card]=insightCards(source);
 assert.equal(card.label,'Afirmação do autor');assert.equal(card.claim,source[0].claim);assert.equal(card.application,source[0].application);
 assert.deepEqual(card.evidence,[{source:'Transcrição',excerpt:'depois entram os filés de peixe',time:'4s–12s'}]);assert.deepEqual(source,before);
});
test('visual observation and interpretation are not promoted to an author fact',()=>{
 const cards=insightCards([{claim:'A tigela aparece sobre a mesa.',classification:'visual_observation',evidence:[{source:'video',start_seconds:0,end_seconds:2,excerpt:'Tigela visível.'}]},{claim:'O processo pode servir de referência.',classification:'interpretation',application:'Conferir os requisitos antes de aplicar.',evidence:[]}]);
 assert.deepEqual(cards.map(x=>x.label),['Observação visual','Interpretação da análise']);assert.equal(cards[1].application,'Conferir os requisitos antes de aplicar.');
});
test('legacy prose and partial content remain readable without exposing object keys or inventing evidence',()=>{
 const cards=insightCards(['Texto antigo preservado.',{application:'Ideia sem uma afirmação adicional.',classification:'future_format',evidence:{source:'unknown',excerpt:'Trecho original.'}},{claim:'Legenda original.',evidence:[{source:'caption',start_seconds:10,end_seconds:5,excerpt:'Duas porções.'}]}]);
 assert.equal(cards[0].claim,'Texto antigo preservado.');assert.equal(cards[1].label,'Ideia registrada');assert.equal(cards[1].claim,null);assert.deepEqual(cards[1].evidence,[{source:'Fonte registrada',excerpt:'Trecho original.',time:null}]);assert.equal(cards[2].evidence[0].time,null);
 assert.deepEqual(insightCards([null,42,{},[],{claim:'  '},false]),[]);
});
test('invalid time ranges do not become timestamps and repeated prose is not duplicated',()=>{
 const [card]=insightCards({claim:'Texto preservado.',application:'Texto preservado.',classification:'author_claim',evidence:[{source:'video',start_seconds:-2,end_seconds:1,excerpt:'Trecho.'},{source:'transcript',start_seconds:0,end_seconds:Infinity,excerpt:'Outro trecho.'},{source:'transcript',start_seconds:0,end_seconds:1}]});
 assert.equal(card.application,null);assert.deepEqual(card.evidence.map(x=>x.time),[null,null]);assert.equal(card.evidence.length,2);
});
