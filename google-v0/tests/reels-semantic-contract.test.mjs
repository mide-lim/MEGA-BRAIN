import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSemanticOutput} from '../lib/reels-semantic-contract.mjs';
function input(){
 const source={id:'QaRecipe_1',title:'Dois preparos',sourceIdentity:{kind:'native',reelId:'QaRecipe_1',analysisKey:'a',analysisGeneration:'1'},semanticProofHash:'a'.repeat(64),sourceVersions:{video:'v1'},editorialHash:'b'.repeat(64),editorial:{manual:false},fields:[{fieldPath:'analysis.claims.0',source:'saved_analysis',sourceIdentity:'analysis:a@1',text:'Preparo completo de frango na frigideira.'},{fieldPath:'analysis.claims.1',source:'saved_analysis',sourceIdentity:'analysis:a@1',text:'Preparo completo de peixe no forno.'}],truncated:false};
 const e=source.fields.map(f=>({fieldPath:f.fieldPath,excerpt:f.text})),output={version:1,profiles:[{reelId:source.id,context:'recipe',state:'proposed',reason:'Synthetic source-bound fixture.',units:[{unitId:'u1',type:'recipe',completeness:'complete',evidence:[e[0]]},{unitId:'u2',type:'recipe',completeness:'complete',evidence:[e[1]]}]}],groups:[{key:'recipe_collection',name:'Várias receitas',context:'recipe',kind:'format',definition:'Preparações completas independentes.',aliases:[],positiveCriteria:['Dois preparos completos distintos.'],negativeCriteria:['Ingredientes, passos ou variações incompletas.'],members:[{reelId:source.id,role:'central',unitIds:['u1','u2'],evidence:e}],negativeExamples:[]}]};return {source,output};
}
test('collection requires all distinct complete preparations and their same-unit anchors',()=>{
 const x=input();assert.equal(validateSemanticOutput(x.output,[x.source]).groups[0].members[0].unitIds.length,2);
 for(const mutate of [x=>x.output.groups[0].members[0].unitIds=['u1'],x=>x.output.profiles[0].units[1].completeness='partial',x=>x.output.profiles[0].units[1].evidence=x.output.profiles[0].units[0].evidence,x=>x.output.groups[0].members[0].evidence=[x.output.groups[0].members[0].evidence[0]]]){const y=input();mutate(y);assert.throws(()=>validateSemanticOutput(y.output,[y.source]));}
});
test('unsupported quote and an existing key without explicit semantic reuse cannot mutate a group',()=>{
 const x=input();x.output.groups[0].members[0].evidence[0].excerpt='Invented quote';assert.throws(()=>validateSemanticOutput(x.output,[x.source]),{code:'SEMANTIC_EVIDENCE_NOT_IN_SAVED_SOURCE'});
 const y=input(),g=validateSemanticOutput(y.output,[y.source]).groups[0];assert.throws(()=>validateSemanticOutput(y.output,[y.source],{groups:[g]}),{code:'SEMANTIC_EXISTING_GROUP_EXPLICIT_REUSE_REQUIRED'});
 y.output.groups[0].existingGroupId=g.id;assert.equal(validateSemanticOutput(y.output,[y.source],{groups:[g]}).groups[0].id,g.id);
});
