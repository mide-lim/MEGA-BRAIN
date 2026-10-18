import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeFields} from '../lib/firestore.mjs';
import {semanticHash,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {frozenSemanticSourceFromSaved} from '../lib/reels-semantic-source-v1.mjs';
import {semanticPromptHash,parseSavedSemanticResponse} from '../lib/reels-semantic-provider.mjs';
import {semanticSourceRecoveryReceiptValid,validateSemanticSourceRecovery,validateSemanticPromptTransition,projectRecoveredSemanticOutput} from '../lib/reels-semantic-source-recovery.mjs';
import {validateSemanticOutput} from '../lib/reels-semantic-contract.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
const envs=['SEMANTIC_HISTORICAL_RECOVERY_RECEIPT','SEMANTIC_HISTORICAL_RECOVERY_SOURCE','SEMANTIC_REJECTED_RECOVERY_INPUT'];
test('previously sealed historical receipt validates complete original source bindings after wire upgrade and cannot alone authorize a new prompt',{skip:!envs.every(k=>process.env[k])},async()=>{
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 // Inputs are existing private GitHub artifacts supplied by the CI owner.
 // No live identifiers, receipt, corpus or response are committed in this test.
 const [receipt,input,paid]=await Promise.all(envs.map(async k=>JSON.parse(await readFile(process.env[k],'utf8')))),observation=input.observation;
 assert.equal(observation.readOnly,true);assert.equal(observation.providerCalls,0);assert.equal(observation.writes,0);assert.equal(paid.readOnly,true);assert.equal(paid.providerCalls,0);assert.equal(paid.writes,0);assert.equal(receipt.sourceObservationSHA256,input.sourceObservationSHA256);assert.equal(input.sourceObservationSHA256,paid.sourceObservationSHA256);assert.equal(semanticSourceRecoveryReceiptValid(receipt),true);assert.notEqual(receipt.approvedNextPromptHash,semanticPromptHash);
 const store=memoryReelsStore();for(const row of observation.records)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});const taxonomy=observation.taxonomy;store.docs.set('settings/reels_v2_taxonomy',{data:structuredClone(taxonomy.data??taxonomy),updateTime:taxonomy.updateTime??'historical-ci-taxonomy'});
 const records=new Map(paid.records.map(row=>[row.path,{data:decodeFields(row.document.fields),updateTime:row.document.updateTime}])),jobs=[...records.values()].filter(r=>r.data.kind==='semantic_job'),results=[...records.values()].filter(r=>r.data.kind==='semantic_result');
 assert.equal(jobs.length,1);assert.equal(results.length,1);const job=jobs[0].data,saved=results[0].data,raw=JSON.parse(saved.rawChunks.map(path=>{const part=records.get(path).data;assert.equal(part.kind,'semantic_raw');assert.equal(part.sha256,semanticHash(part.text));return part.text;}).join(''));
 assert.equal(saved.rawHash,semanticHash(raw));assert.equal(saved.bindingHash,semanticHash(saved.binding));assert.equal(receipt.savedRawHash,saved.rawHash);assert.equal(receipt.originalBindingHash,saved.bindingHash);
 const before=semanticHash({receipt,job,saved,raw,source:observation.records}),repository=new ReelsRepository({store,cacheTtlMs:0}),runtime=new ReelsCatalogueRuntime({repository}),sources=[];
 for(const pin of job.batch.binding.pins){const rawSource=await runtime.loadSource(pin.id),source=semanticSourceFromSaved(rawSource),legacySource=frozenSemanticSourceFromSaved(rawSource);assert.equal(validateSemanticSourceRecovery(receipt,{job,saved,source,pin,legacySource}),true);sources.push(source);}
 assert.equal(sources.length,receipt.rows.length);const projected=projectRecoveredSemanticOutput(parseSavedSemanticResponse({rawResponse:raw}),receipt),validated=validateSemanticOutput(projected,sources);
 assert.equal(validated.profiles.length,sources.length);assert.equal(validated.groups.length,receipt.validatedProjection?.usableProposalCount??projected.groups.length);
 for(const exclusion of receipt.validatedProjection?.exclusions??[]){const p=validated.profiles.find(p=>p.reelId===exclusion.reelId);assert.equal(p.state,'inconclusive');assert.deepEqual(p.units,[]);assert.equal(validated.groups.some(g=>[...g.members,...g.negativeExamples].some(m=>m.id===exclusion.reelId)),false);}
 const ledgerPath='reels_index/semantic_authorization_'+semanticHash(job.policy.authorizationId),ledger=records.get(ledgerPath);assert.ok(ledger);
 assert.equal(validateSemanticPromptTransition(receipt,job,{...saved,processed:true},{path:ledgerPath,...ledger}),false);assert.equal(semanticHash({receipt,job,saved,raw,source:observation.records}),before);
 console.log(JSON.stringify({kind:'historical_source_proof_revalidated',sourceCount:sources.length,retainedProfiles:validated.profiles.length-(receipt.validatedProjection?.exclusions?.length??0),historicalReceiptUnchanged:true,originalRawAndBindingUnchanged:true,newPromptAuthorized:false,providerCalls:0,googleWrites:0}));
});
