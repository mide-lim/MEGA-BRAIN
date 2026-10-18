import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFields} from '../lib/firestore.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {semanticHash,semanticPolicyVersion,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {semanticPromptHash} from '../lib/reels-semantic-provider.mjs';
import {makeSemanticCheckpointFixture,seedSemanticAlignmentRecovery} from './reels-semantic-checkpoint-fixture.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {diagnoseSemanticNextInput,measureSemanticSchema,payloadAuditScope} from '../scripts/diagnose-semantic-next-input.mjs';

async function inputs(){
 const fixture=makeSemanticCheckpointFixture(),store=memoryReelsStore();
 for(const row of fixture.documents)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 const repository=new ReelsRepository({store,cacheTtlMs:0}),curator=new ReelsSemanticCurator({repository,provider:fixture.provider});
 const seed=await seedSemanticAlignmentRecovery({curator,selection:{ids:fixture.ids}}),job=(await store.get('reels_index/semantic_job_'+seed.jobId)).data,saved=(await store.get('reels_index/semantic_result_'+seed.batchId)).data;
 const sourceObservationSHA256='c'.repeat(64),paths=['reels_index/semantic_job_'+seed.jobId,'reels_index/semantic_result_'+seed.batchId,...saved.rawChunks,seed.ledgerPath],records=[];
 for(const path of paths){const row=await store.get(path);records.push({path,document:{name:'projects/megabrain-v0-1017370021431/databases/(default)/documents/'+path,fields:encodeFields(row.data),updateTime:row.updateTime}});}
 const observation={readOnly:true,providerCalls:0,writes:0,records:fixture.documents.filter(row=>row.path.startsWith('videos/')),taxonomy:fixture.documents.find(row=>row.path==='settings/reels_v2_taxonomy')};
 const input={schemaVersion:1,sourceObservationSHA256,observation},paid={schemaVersion:2,kind:'saved_semantic_first_response_reconciliation_input',sourceObservationSHA256,readOnly:true,providerCalls:0,writes:0,records},sources=[];
 for(const pin of job.pins.slice(8,16))sources.push(semanticSourceFromSaved(await curator.catalogue.loadSource(pin.id)));
 const catalogue={version:semanticPolicyVersion,promptHash:semanticPromptHash,groups:[]},promptTransitionHash='d'.repeat(64),binding={jobId:job.id,phase:'extract',cursor:8,pins:sources.map(source=>({id:source.id,sourceProjectionVersion:source.sourceProjectionVersion,semanticProofHash:source.semanticProofHash,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash})),catalogueHash:semanticHash(catalogue),policyHash:job.policyHash,promptHash:semanticPromptHash,promptTransitionHash};
 const expected={...payloadAuditScope,sourceObservationSHA256,jobId:job.id,sourceDocuments:25,published:25,maxCalls:9,model:job.policy.model,promptHash:semanticPromptHash,requestId:semanticHash({jobId:job.id,phase:'extract',cursor:8}),bindingHash:semanticHash(binding),catalogueHash:semanticHash(catalogue),promptTransitionHash,sourceIds:sources.map(s=>s.id)};
 return {input,paid,expected,fixture,store,sourceText:sources.map(s=>s.fields.map(f=>f.text)).flat()};
}
test('next-eight diagnostic captures the actual adapter offline, matches exact binding and exports metadata only',async t=>{
 const data=await inputs(),before=semanticHash({input:data.input,paid:data.paid,store:[...data.store.docs]});
 t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 const report=await diagnoseSemanticNextInput(data.input,data.paid,{expected:data.expected}),serialized=JSON.stringify(report);
 assert.deepEqual(report.sourceIds,data.expected.sourceIds);assert.equal(report.sourceIds.length,8);assert.equal(report.bindingHash,data.expected.bindingHash);assert.equal(report.catalogueHash,data.expected.catalogueHash);assert.equal(report.promptHash,semanticPromptHash);
 assert.equal(report.adapterRequestsCaptured,1);assert.equal(report.actualProviderCalls,0);assert.equal(report.googleWrites,0);assert.equal(report.networkRequests,0);assert.equal(report.inferenceExecuted,false);assert.equal(report.paidResponseReplayed,false);assert.equal(report.remoteAcceptanceProven,false);assert.equal(report.incidentCauseEstablished,false);assert.equal(report.retryAuthorized,false);
 assert.equal(data.fixture.calls.length,0,'A fake transport capture must not execute even the synthetic semantic engine');
 assert.equal(report.schema.anyOfNodes,1);assert.equal(report.schema.anyOfBranches,3);assert.ok(report.schema.nodes>50);assert.ok(report.schema.optionalProperties>0);assert.ok(report.schema.maxArrayNesting>=3);assert.equal(report.schema.missingType.length,1);assert.equal(report.schema.missingType[0].anyOf,true);assert.deepEqual(report.schema.unsupportedKeywords,[]);
 assert.ok(report.bytes.request>report.bytes.schema+report.bytes.systemInstruction);assert.ok(report.bytes.schema>10000);assert.match(report.requestHash,/^[a-f0-9]{64}$/);assert.match(report.wireBodySHA256,/^[a-f0-9]{64}$/);
 for(const text of data.sourceText)assert.equal(serialized.includes(text),false,'Saved source text must never be exported');
 for(const forbidden of ['rawResponse','excerpt','Authorization','Bearer ','https://','sourceIdentity','requestBody'])assert.equal(serialized.includes(forbidden),false,forbidden+' must not appear in the metadata artifact');
 assert.equal(semanticHash({input:data.input,paid:data.paid,store:[...data.store.docs]}),before,'Diagnostic must not change sources, original paid response or authority');
});
test('next-eight diagnostic fails closed on provenance, versions, cohort, model and exact observed bindings',async()=>{
 const base=await inputs();
 const cases=[
  [d=>d.input.observation.providerCalls=1,'SOURCE_HEADER_INVALID'],
  [d=>d.input.sourceObservationSHA256='0'.repeat(64),'SOURCE_OBSERVATION_CHANGED'],
  [d=>d.paid.writes=1,'PAID_HEADER_INVALID'],
  [d=>d.input.observation.records.pop(),'SOURCE_COUNT_CHANGED'],
  [d=>d.expected.promptHash='0'.repeat(64),'CURRENT_PROMPT_CHANGED'],
  [d=>d.paid.records.pop(),'EXACT_FOUR_PAID_RECORDS_REQUIRED'],
  [d=>d.paid.records[0].document.name='unexpected','PAID_RECORD_INVALID'],
  [d=>d.expected.model='gemini-wrong-model','ORIGINAL_JOB_SCOPE_CHANGED'],
  [d=>d.expected.requestId='0'.repeat(64),'NEXT_REQUEST_ID_CHANGED'],
  [d=>d.expected.sourceIds.reverse(),'NEXT_BATCH_INCOMPLETE'],
  [d=>d.input.observation.records.find(r=>r.path.endsWith(d.expected.sourceIds[0])).updateTime='2099-01-01T00:00:00.000Z','PUBLISHED_INVENTORY_CHANGED'],
  [d=>d.expected.catalogueHash='0'.repeat(64),'OBSERVED_CATALOGUE_HASH_CHANGED'],
  [d=>d.expected.promptTransitionHash='0'.repeat(64),'OBSERVED_NEXT_BINDING_CHANGED'],
  [d=>d.expected.bindingHash='0'.repeat(64),'OBSERVED_NEXT_BINDING_CHANGED'],
  [d=>d.input.observation.records.find(r=>r.path.endsWith(d.expected.sourceIds[0])).data.analysis.summary='Altered source with the same version token.','OBSERVED_NEXT_BINDING_CHANGED']
 ];
 for(const [mutate,code] of cases){const data=structuredClone({input:base.input,paid:base.paid,expected:base.expected});mutate(data);await assert.rejects(()=>diagnoseSemanticNextInput(data.input,data.paid,{expected:data.expected}),{code});}
});
test('schema metrics count serialized repeated branches, optional fields and untyped unions without inferring remote rejection',()=>{
 const shared={type:'STRING',enum:['a','b']},schema={type:'OBJECT',required:['first'],properties:{first:shared,second:shared}},result=measureSemanticSchema(schema);
 assert.equal(result.nodes,3);assert.equal(result.enumFields,2);assert.equal(result.enumValues,4);assert.equal(result.properties,2);assert.equal(result.optionalProperties,1);
 const union=measureSemanticSchema({anyOf:[{type:'OBJECT',properties:{},required:[]},{type:'STRING'}]});assert.equal(union.missingType.length,1);assert.deepEqual(union.missingType[0].branchTypes,['OBJECT','STRING']);
 assert.deepEqual(measureSemanticSchema({type:'STRING',pattern:'.*'}).unsupportedKeywords,['responseSchema.pattern']);
 const cycle={type:'ARRAY'};cycle.items=cycle;assert.throws(()=>measureSemanticSchema(cycle),{code:'SCHEMA_CYCLE_INVALID'});
});
