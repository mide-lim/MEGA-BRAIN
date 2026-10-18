import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticHash,semanticSourceFromSaved,semanticSourceProjectionVersion} from '../lib/reels-semantic-source.mjs';
import {semanticPromptHash} from '../lib/reels-semantic-provider.mjs';
import {prepareSemanticSourceRecovery,validateSemanticSourceRecovery,reconstructLegacySemanticFieldOrder} from '../lib/reels-semantic-source-recovery.mjs';
const reverseMaps=value=>Array.isArray(value)?value.map(reverseMaps):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reverseMaps(value[k])])):value;
function fixture(){
 const video={id:'QaRecover_1',title:'Fonte salva',status:'completed',analysis_key:'analysis/saved.json',analysis_generation:'7',analysis_quality_status:'accepted',analysis:{title:'Fonte salva',summary:'Dois pontos documentados.',knowledge:{beta:'Segundo ponto.',alpha:'Primeiro ponto.'}},source_caption:{capture_id:'caption-v1',text:'Legenda documental.'},transcript:'Transcrição preservada.'},sourceVersions={video:'2026-10-17T00:00:00.000Z'},source=semanticSourceFromSaved({video,sourceVersions});
 const order=['analysis.title','analysis.summary','analysis.knowledge.beta','analysis.knowledge.alpha','caption','transcript'],fields=order.map(path=>source.fields.find(f=>f.fieldPath===path)),oldHash=semanticHash({identity:source.sourceIdentity,fields}),pin={id:source.id,sourceVersions,semanticProofHash:oldHash,editorialHash:source.editorialHash},policy={enabled:true,expiresAt:'2099-01-01T00:00:00.000Z'},binding={jobId:'a'.repeat(64),phase:'extract',cursor:0,pins:[pin],policyHash:semanticHash(policy),promptHash:semanticPromptHash},bindingHash=semanticHash(binding),batchId='b'.repeat(64);
 const job={id:binding.jobId,status:'paused',callsUsed:1,cursor:0,phase:'extract',promptHash:semanticPromptHash,policy,policyHash:binding.policyHash,pins:[{id:pin.id,sourceVersions}],batch:{id:batchId,status:'submitting',phase:'extract',binding,bindingHash}};
 const rawResponse={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({version:1,profiles:[{reelId:source.id,context:'general',state:'unknown',reason:'Synthetic abstention.',units:[]}],groups:[]})}]}}]},saved={id:batchId,phase:'extract',binding,bindingHash,rawHash:semanticHash(rawResponse),requestHash:'c'.repeat(64)};
 return {video,sourceVersions,source,pin,job,saved,envelope:{...saved,rawResponse},sources:[source],sourceObservationSHA256:'d'.repeat(64),sourceCommit:'e'.repeat(40),observedAt:'2026-10-18T00:00:00.000Z',order};
}
test('projection is deterministic across reordered Firestore maps, including selection before bounds and preserved arrays',()=>{
 const x=fixture(),a=semanticSourceFromSaved({video:x.video,sourceVersions:x.sourceVersions}),b=semanticSourceFromSaved({video:reverseMaps(x.video),sourceVersions:x.sourceVersions});assert.equal(a.semanticProofHash,b.semanticProofHash);assert.deepEqual(a.fields,b.fields);assert.equal(a.sourceProjectionVersion,semanticSourceProjectionVersion);
 x.video.analysis.knowledge=Object.fromEntries(Array.from({length:40},(_,i)=>['field_'+String(i).padStart(2,'0'),'Value '+i]));x.video.analysis.claims=['First array entry','Second array entry'];
 const c=semanticSourceFromSaved({video:x.video,sourceVersions:x.sourceVersions}),d=semanticSourceFromSaved({video:reverseMaps(x.video),sourceVersions:x.sourceVersions});assert.equal(c.semanticProofHash,d.semanticProofHash);assert.equal(c.truncated,true);assert.deepEqual(c.fields.filter(f=>f.fieldPath.startsWith('analysis.claims.')).map(f=>f.text),['First array entry','Second array entry']);
});
test('finite exact old field order is cryptographically reconstructed without raw or binding modification',()=>{
 const x=fixture(),before=semanticHash({job:x.job,saved:x.saved,envelope:x.envelope}),result=prepareSemanticSourceRecovery(x);assert.equal(result.report.ready,true);assert.ok(result.receipt);assert.deepEqual(result.receipt.rows[0].originalFieldOrder,x.order);assert.equal(result.report.providerCalls,0);assert.equal(JSON.stringify(result.report).includes('Segundo ponto.'),false);assert.equal(JSON.stringify(result.receipt).includes('Segundo ponto.'),false);
 assert.equal(validateSemanticSourceRecovery(result.receipt,{job:x.job,saved:x.saved,source:x.source,pin:x.pin}),true);assert.equal(semanticHash({job:x.job,saved:x.saved,envelope:x.envelope}),before);
 const forged=structuredClone(result.receipt);forged.rows[0].originalFieldOrder.reverse();const {receiptHash,...body}=forged;forged.receiptHash=semanticHash(body);assert.equal(validateSemanticSourceRecovery(forged,{job:x.job,saved:x.saved,source:x.source,pin:x.pin}),false);
});
test('truncation, content change, source version drift, editorial drift, wrong batch and expired authorization fail closed',()=>{
 for(const mutate of [x=>{x.source.truncated=true;},x=>{x.source.fields[0].text+=' changed';},x=>{x.source.sourceVersions={video:'new-version'};},x=>{x.source.editorialHash='0'.repeat(64);},x=>{x.saved.id='0'.repeat(64);},x=>{x.job.policy.expiresAt='2020-01-01T00:00:00.000Z';}]){const x=fixture();mutate(x);assert.equal(prepareSemanticSourceRecovery(x).receipt,null);}
});
test('old projection search never reorders array entries or exceeds its explicit bound',()=>{
 const x=fixture();x.video.analysis={claims:['First entry','Second entry']};const s=semanticSourceFromSaved({video:x.video,sourceVersions:x.sourceVersions}),old=semanticHash({identity:s.sourceIdentity,fields:[s.fields.find(f=>f.fieldPath==='analysis.claims.1'),s.fields.find(f=>f.fieldPath==='analysis.claims.0'),...s.fields.filter(f=>!f.fieldPath.startsWith('analysis.claims.'))]});assert.equal(reconstructLegacySemanticFieldOrder(s,old,{maxAttempts:10}).matched,false);
});
