import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSemanticCalibration,semanticDefinitionHash,semanticCalibrationReceiptValid} from '../lib/reels-semantic-calibration.mjs';
import {automaticSemanticPromotion} from '../lib/reels-semantic-contract.mjs';
import {semanticHash,semanticPolicyVersion} from '../lib/reels-semantic-source.mjs';
function fixture(){
 const promptHash='a'.repeat(64),job={id:'b'.repeat(64),status:'completed',phase:'complete',cohortHash:'c'.repeat(64),promptHash,policy:{model:'gemini-author',verifierModel:'gemini-verifier'}},group={id:'d'.repeat(64),key:'contexto-revisado',context:'recipe',kind:'segment',dimension:null,definition:'Um preparo culinário como assunto desenvolvido.',positiveCriteria:['Preparo demonstrado.'],negativeCriteria:['Tecnologia sem preparo.'],jobIds:[job.id],members:[],negativeExamples:[{id:'negative'}],verification:{status:'supported',independentPhase:true,promptHash,members:[]}},sources=[],labels=[];
 for(let i=0;i<24;i++){const id='QaCal_'+String(i).padStart(3,'0'),sourceIdentity={kind:'native',reelId:id,analysisKey:id,analysisGeneration:'1'},semanticProofHash=semanticHash({id,sourceIdentity}),s={id,sourceIdentity,semanticProofHash,fields:[{fieldPath:'caption',text:i%2?'Uma explicação de computador.':'Uma receita completa de arroz.'}]},label=i%2===0; sources.push(s);
 if(label){group.members.push({id,role:'central',semanticProofHash});group.verification.members.push({reelId:id,verdict:'supported',semanticProofHash});}
 labels.push({groupId:group.id,reelId:id,split:i<4?'train':'holdout',label,definitionHash:semanticDefinitionHash(group),sourceIdentity,semanticProofHash,reviewSourceHash:semanticHash({id,sourceIdentity,semanticProofHash}),reason:'Independent synthetic source review.',evidence:[{fieldPath:'caption',excerpt:s.fields[0].text}]});}
 return {job,groups:[group],sources,annotations:{schemaVersion:1,model:job.policy.model,verifierModel:job.policy.verifierModel,promptHash,cohortHash:job.cohortHash,reviewerKind:'independent_source_review',reviewId:'synthetic-independent-review',reviewerIdentity:'reviewer-B',authorIdentity:'author-A',labels},observedAt:'2026-10-18T00:00:00.000Z',minimumPrecision:0.95};
}
test('independent source-bound train/holdout computes a reproducible definition-limited promotion receipt',()=>{
 const x=fixture(),receipt=evaluateSemanticCalibration(x);assert.equal(receipt.verdict,'accepted');assert.equal(receipt.holdout.total,20);assert.equal(receipt.holdout.tp,10);assert.equal(receipt.holdout.tn,10);assert.equal(receipt.providerCalls,0);assert.equal(semanticCalibrationReceiptValid(receipt),true);
 const policy={version:semanticPolicyVersion,...x.job.policy,autoPromotionEnabled:true,minUniqueMembers:2,calibrationReceipt:receipt};
 assert.equal(automaticSemanticPromotion(x.groups[0],policy,{promptHash:x.annotations.promptHash}).allowed,true);
 assert.equal(automaticSemanticPromotion({...x.groups[0],definition:'Outro propósito sem revisão.'},policy,{promptHash:x.annotations.promptHash}).allowed,false);
 assert.equal(automaticSemanticPromotion({...x.groups[0],verification:{status:'pending'}},policy,{promptHash:x.annotations.promptHash}).allowed,false);
});
test('self annotation, stale source, holdout leakage and model drift fail closed without evaluating',()=>{
 for(const mutate of [x=>x.annotations.reviewerIdentity=x.annotations.authorIdentity,x=>x.annotations.labels[0].semanticProofHash='0'.repeat(64),x=>{x.annotations.labels[4].reelId=x.annotations.labels[0].reelId;},x=>x.annotations.model='gemini-different']){const x=fixture();mutate(x);assert.throws(()=>evaluateSemanticCalibration(x));}
});
test('format evidence cannot calibrate unrelated kinds and abstained positives do not inflate precision',()=>{
 const x=fixture();x.groups[0].verification.members=[];const r=evaluateSemanticCalibration(x);assert.equal(r.verdict,'insufficient');assert.equal(r.holdout.fn,10);assert.equal(r.holdout.abstained,10);assert.equal(r.holdout.recall,0);
 const good=evaluateSemanticCalibration(fixture());good.kinds=['format'];assert.equal(semanticCalibrationReceiptValid(good),false);
});
