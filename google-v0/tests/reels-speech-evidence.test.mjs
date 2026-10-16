import test from 'node:test';import assert from 'node:assert/strict';
import {speechWordEvidence,evidenceWindow} from '../lib/reels-speech-evidence.mjs';
const word=(word,start,end)=>({word,startOffset:start+'s',endOffset:end+'s'});
test('provider offsets survive as evidence without inventing missing timing',()=>{
 const input={results:[{alternatives:[{words:[word('Prepare',1,2),word('o',2,2.5),word('frango.',2.5,3)]}]}]};
 assert.deepEqual(speechWordEvidence(input)[0],{word:'Prepare',start_seconds:1,end_seconds:2});assert.deepEqual(speechWordEvidence({results:[{alternatives:[{transcript:'No timing'}]}]}),[]);
 input.results[0].alternatives[0].words[1].endOffset='invalid';assert.deepEqual(speechWordEvidence(input),[]);
});
test('literal quotation must occupy its claimed window in provider word evidence',()=>{
 const raw={transcript:'Prepare o frango. Sirva a salada.',duration_seconds:40,transcript_words:speechWordEvidence({results:[{alternatives:[{words:[word('Prepare',1,2),word('o',2,2.5),word('frango.',2.5,3),word('Sirva',20,21),word('a',21,21.5),word('salada.',21.5,22)]}]}]})};
 assert.equal(evidenceWindow(raw,{excerpt:'Prepare o frango.',start_seconds:1,end_seconds:3}),true);
 assert.equal(evidenceWindow(raw,{excerpt:'Prepare o frango.',start_seconds:20,end_seconds:23}),false);
 assert.equal(evidenceWindow({...raw,transcript_words:[]},{excerpt:'Prepare o frango.',start_seconds:1,end_seconds:3}),false);
 assert.equal(evidenceWindow(raw,{excerpt:'Prepare frango.',start_seconds:1,end_seconds:3}),false);
});
