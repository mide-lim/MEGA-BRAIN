import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticHash,semanticSourceFromSaved,semanticSourceProjectionVersion} from '../lib/reels-semantic-source.mjs';
import {frozenSemanticSourceFromSaved} from '../lib/reels-semantic-source-v1.mjs';
import {validateSemanticOutput} from '../lib/reels-semantic-contract.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {makeSemanticFixture} from './reels-semantic-fixture.mjs';
import {semanticPromptHash} from '../lib/reels-semantic-provider.mjs';
import {prepareSemanticSourceRecovery,validateSemanticSourceRecovery,reconstructLegacySemanticFieldOrder,projectRecoveredSemanticOutput,finiteSavedProjectionRule} from '../lib/reels-semantic-source-recovery.mjs';
const reverseMaps=value=>Array.isArray(value)?value.map(reverseMaps):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reverseMaps(value[k])])):value;
function fixture(){
 const video={id:'QaRecover_1',title:'Fonte salva',status:'completed',analysis_key:'analysis/saved.json',analysis_generation:'7',analysis_quality_status:'accepted',analysis:{title:'Fonte salva',summary:'Dois pontos documentados.',knowledge:{beta:'Segundo ponto.',alpha:'Primeiro ponto.'}},source_caption:{capture_id:'caption-v1',text:'Legenda documental.'},transcript:'Transcrição preservada.'},sourceVersions={video:'2026-10-17T00:00:00.000Z'},source=semanticSourceFromSaved({video,sourceVersions});
 const order=['analysis.title','analysis.summary','analysis.knowledge.beta','analysis.knowledge.alpha','caption','transcript'],fields=order.map(path=>source.fields.find(f=>f.fieldPath===path)),oldHash=semanticHash({identity:source.sourceIdentity,fields}),pin={id:source.id,sourceVersions,semanticProofHash:oldHash,editorialHash:source.editorialHash},policy={enabled:true,expiresAt:'2099-01-01T00:00:00.000Z'},binding={jobId:'a'.repeat(64),phase:'extract',cursor:0,pins:[pin],policyHash:semanticHash(policy),promptHash:semanticPromptHash},bindingHash=semanticHash(binding),batchId='b'.repeat(64);
 const job={id:binding.jobId,status:'paused',callsUsed:1,cursor:0,phase:'extract',promptHash:semanticPromptHash,policy,policyHash:binding.policyHash,pins:[{id:pin.id,sourceVersions}],batch:{id:batchId,status:'submitting',phase:'extract',binding,bindingHash}};
 const rawResponse={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({version:1,profiles:[{reelId:source.id,context:'general',state:'unknown',reason:'Synthetic abstention.',units:[]}],groups:[]})}]}}]},saved={id:batchId,phase:'extract',binding,bindingHash,rawHash:semanticHash(rawResponse),requestHash:'c'.repeat(64)};
 return {video,sourceVersions,source,legacySources:[frozenSemanticSourceFromSaved({video,sourceVersions})],pin,job,saved,envelope:{...saved,rawResponse},sources:[source],sourceObservationSHA256:'d'.repeat(64),sourceCommit:'e'.repeat(40),observedAt:'2026-10-18T00:00:00.000Z',order};
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
test('content change, source version drift, editorial drift, wrong batch and expired authorization fail closed',()=>{
 for(const mutate of [x=>{x.source.fields[0].text+=' changed';},x=>{x.source.sourceVersions={video:'new-version'};},x=>{x.source.editorialHash='0'.repeat(64);},x=>{x.saved.id='0'.repeat(64);},x=>{x.job.policy.expiresAt='2020-01-01T00:00:00.000Z';}]){const x=fixture();mutate(x);assert.equal(prepareSemanticSourceRecovery(x).receipt,null);}
});
test('old projection search never reorders array entries or exceeds its explicit bound',()=>{
 const x=fixture();x.video.analysis={claims:['First entry','Second entry']};const s=semanticSourceFromSaved({video:x.video,sourceVersions:x.sourceVersions}),old=semanticHash({identity:s.sourceIdentity,fields:[s.fields.find(f=>f.fieldPath==='analysis.claims.1'),s.fields.find(f=>f.fieldPath==='analysis.claims.0'),...s.fields.filter(f=>!f.fieldPath.startsWith('analysis.claims.'))]});assert.equal(reconstructLegacySemanticFieldOrder(s,old,{maxAttempts:10}).matched,false);
});

test('complete epoch equivalence explicitly distinguishes an unreconstructed old hash from an exact cryptographic order proof',()=>{
 const x=fixture(),r=prepareSemanticSourceRecovery({...x,maxAttempts:1,allowCompleteEpochEquivalence:true});
 assert.equal(r.report.ready,true);assert.equal(r.receipt.rows[0].proof,'complete_source_epoch_equivalence');assert.equal(r.receipt.rows[0].oldHashVerified,false);assert.equal(r.receipt.rows[0].originalFieldOrder,null);assert.equal(r.report.exactOldHashCount,0);assert.equal(r.report.completeEpochEquivalenceCount,1);
 assert.equal(validateSemanticSourceRecovery(r.receipt,{job:x.job,saved:x.saved,source:x.source,pin:x.pin,legacySource:x.legacySources[0]}),true);
 const changed=structuredClone(x.legacySources[0]);changed.fields[0].text+=' different';
 assert.equal(validateSemanticSourceRecovery(r.receipt,{job:x.job,saved:x.saved,source:x.source,pin:x.pin,legacySource:changed}),false);
 assert.equal(validateSemanticSourceRecovery(r.receipt,{job:{...x.job,batch:{...x.job.batch,id:'f'.repeat(64)}},saved:x.saved,source:x.source,pin:x.pin,legacySource:x.legacySources[0]}),false);
 for(const mutate of [a=>{a.source.truncated=true;},a=>{a.legacySources[0].truncated=true;},a=>{a.legacySources[0].fields.pop();},a=>{a.legacySources[0].sourceVersions.video='changed';},a=>{a.legacySources[0].editorialHash='0'.repeat(64);}]){
  const a=fixture();mutate(a);assert.equal(prepareSemanticSourceRecovery({...a,maxAttempts:1,allowCompleteEpochEquivalence:true}).receipt,null);
 }
});
test('partial capture is recoverable only with the exact original projection hash and cannot establish exactly one recipe',()=>{
 const x=fixture();x.source.truncated=true;x.source.truncationReasons=['synthetic_capture_limit'];x.legacySources[0].truncated=true;
 const r=prepareSemanticSourceRecovery(x);assert.equal(r.report.ready,true);assert.equal(r.receipt.rows[0].sourceTruncated,true);assert.equal(r.receipt.rows[0].proof,'exact_original_projection_hash');assert.deepEqual(r.receipt.rows[0].truncationReasons,['synthetic_capture_limit']);
 const bad=fixture();bad.source.truncated=true;bad.legacySources[0].truncated=true;bad.source.fields.pop();assert.equal(prepareSemanticSourceRecovery({...bad,allowCompleteEpochEquivalence:true}).receipt,null);
 const proof={fieldPath:x.source.fields[0].fieldPath,excerpt:x.source.fields[0].text},output={version:1,profiles:[{reelId:x.source.id,context:'recipe',state:'proposed',reason:'Synthetic',units:[{unitId:'one',type:'recipe',completeness:'complete',evidence:[proof]}]}],groups:[{key:'single_recipe',name:'Receita única',kind:'format',context:'recipe',definition:'One preparation.',aliases:[],positiveCriteria:['One'],negativeCriteria:['Several'],members:[{reelId:x.source.id,role:'central',unitIds:['one'],evidence:[proof]}],negativeExamples:[]}]};
 assert.throws(()=>validateSemanticOutput(output,[x.source]),{code:'SEMANTIC_SINGLE_RECIPE_REQUIRES_COMPLETE_SOURCE'});
});
test('raw contract diagnostics still run when ordering proof fails, with no excerpt in the report',()=>{
 const x=fixture();x.envelope.rawResponse.candidates[0].content.parts[0].text=JSON.stringify({version:1,profiles:[],groups:[]});x.saved.rawHash=semanticHash(x.envelope.rawResponse);
 const r=prepareSemanticSourceRecovery({...x,maxAttempts:1});assert.equal(r.receipt,null);assert.equal(r.report.gates.find(g=>g.code==='SAVED_OUTPUT_CONTRACT_AND_LITERAL_QUOTES_VALID').passed,false);assert.ok(r.report.contractError);assert.equal(JSON.stringify(r.report).includes('Segundo ponto.'),false);
});
test('saved first batch reconciliation never dispatches or infers, preserves original raw/binding, and proceeds through verifier with receipt-bound provenance',async()=>{
 const fixture=makeSemanticFixture(),store=memoryReelsStore();for(const r of fixture.documents)store.docs.set(r.path,{data:structuredClone(r.data),updateTime:r.updateTime});
 const repository=new ReelsRepository({store,cacheTtlMs:0}),deliveries=[],curator=new ReelsSemanticCurator({repository,provider:fixture.provider,enqueue:async j=>{deliveries.push(j);return {status:'sent'};}});
 const p=await curator.preview({all:true}),created=await curator.create({selection:{all:true},previewHash:p.previewHash,idempotencyKey:'source-order-recovery-unit'});deliveries.length=0;
 const path='reels_index/semantic_job_'+created.job.id,snapshot=await store.get(path),job=snapshot.data,pins=job.pins.slice(0,job.policy.batchSize),sources=[],legacySources=[];
 for(const pin of pins){const raw=await curator.catalogue.loadSource(pin.id);sources.push(semanticSourceFromSaved(raw));legacySources.push(frozenSemanticSourceFromSaved(raw));}
 const binding={jobId:job.id,phase:'extract',cursor:0,pins:legacySources.map(s=>({id:s.id,semanticProofHash:s.semanticProofHash,sourceVersions:s.sourceVersions,editorialHash:s.editorialHash})),catalogueHash:semanticHash({groups:[]}),policyHash:job.policyHash,promptHash:semanticPromptHash},batchId=semanticHash({jobId:job.id,phase:'extract',cursor:0}),batch={id:batchId,status:'submitting',phase:'extract',binding,bindingHash:semanticHash(binding),groupVersions:[],leaseUntil:'2099-01-01T00:00:00.000Z'};
 const envelope=await fixture.provider.infer({sources:legacySources,catalogue:{groups:[]},model:job.policy.model,requestId:batchId}),saved=await curator.envelopeSave(batchId,{...envelope,phase:'extract'},binding),paused={...job,status:'paused',reason:'SEMANTIC_SOURCE_CHANGED',callsUsed:1,batch};
 store.docs.set(path,{data:paused,updateTime:'2026-10-18T00:00:00.000Z'});const full=await curator.envelopeRead(saved),r=prepareSemanticSourceRecovery({job:paused,saved:saved.data,envelope:full,sources,legacySources,allowCompleteEpochEquivalence:true,sourceObservationSHA256:'d'.repeat(64),sourceCommit:'e'.repeat(40),observedAt:'2026-10-18T00:00:00.000Z'});
 assert.equal(r.report.ready,true);const beforeRaw=semanticHash(full.rawResponse),beforeBinding=semanticHash(saved.data.binding),calls=fixture.calls.length;
 assert.equal((await curator.job(job.id)).job.canReconcileSaved,false);
 await store.create('reels_index/semantic_source_recovery_'+batchId,r.receipt);
 assert.equal((await curator.job(job.id)).job.canReconcileSaved,true);assert.equal((await curator.overview()).jobs.find(j=>j.id===job.id).canReconcileSaved,true);
 for(const status of ['uncertain','running']){const bad={...paused,status};store.docs.set(path,{data:bad,updateTime:'2026-10-18T00:00:01.000Z'});assert.equal((await curator.job(job.id)).job.canReconcileSaved,false);await assert.rejects(()=>curator.command({action:'reconcile_saved',jobId:job.id}),{code:'SEMANTIC_SAVED_RECOVERY_NOT_READY'});}
 store.docs.set(path,{data:paused,updateTime:'2026-10-18T00:00:02.000Z'});
 const response=await curator.command({action:'reconcile_saved',jobId:job.id,idempotencyKey:'same-recovery-command'});assert.equal(response.job.status,'prepared');assert.equal(response.job.reason,'SAVED_RESPONSE_APPLIED_AWAITING_DELIVERY');assert.equal(response.job.processed,pins.length);assert.equal(response.job.callsUsed,1);assert.equal(response.job.canReconcileSaved,false);assert.equal(fixture.calls.length,calls);assert.equal(deliveries.length,0);const duplicate=await curator.command({action:'reconcile_saved',jobId:job.id,idempotencyKey:'same-recovery-command'});assert.equal(duplicate.duplicate,true);assert.equal(fixture.calls.length,calls);assert.equal(deliveries.length,0);
 for(const s of sources){const profile=(await store.get('reels_index/semantic_profile_'+s.id)).data;assert.equal(profile.sourceReconciliation.receiptHash,r.receipt.receiptHash);assert.equal(profile.semanticProofHash,s.semanticProofHash);}
 const next=(await store.get(path)).data;await curator.runDelivery({jobId:job.id,sequence:next.dispatch.sequence,outboxId:next.dispatch.outboxId});
 let pages=0;while(deliveries.length){assert.ok(++pages<50);const j=deliveries.shift();await curator.runDelivery({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches:3});}
 const final=(await curator.job(job.id)).job;assert.equal(final.status,'completed');assert.equal(final.processed,5);assert.equal(final.verificationProcessed,5);assert.equal(final.callsUsed,7);assert.equal(fixture.calls.length,7);
 assert.equal(semanticHash((await curator.envelopeRead(await store.get('reels_index/semantic_result_'+batchId))).rawResponse),beforeRaw);assert.equal(semanticHash((await store.get('reels_index/semantic_result_'+batchId)).data.binding),beforeBinding);
});

test('invalid saved quotes are fully diagnosed with metadata only, without accepting whitespace or another field as a correction',()=>{
 const x=fixture(),output={version:1,profiles:[{reelId:x.source.id,context:'general',state:'proposed',reason:'Synthetic',units:[{unitId:'unit',type:'concept',completeness:'partial',evidence:[{fieldPath:'analysis.knowledge.beta',excerpt:'Primeiro ponto.'},{fieldPath:'analysis.summary',excerpt:'Dois   pontos documentados.'},{fieldPath:'analysis.missing',excerpt:'Invented quotation.'}]}]}],groups:[]};
 x.envelope.rawResponse.candidates[0].content.parts[0].text=JSON.stringify(output);x.saved.rawHash=semanticHash(x.envelope.rawResponse);
 const r=prepareSemanticSourceRecovery(x);assert.equal(r.receipt,null);assert.equal(r.report.contractError,'SEMANTIC_EVIDENCE_NOT_IN_SAVED_SOURCE');assert.equal(r.report.evidenceDiagnostics.invalidProofCount,3);assert.equal(r.report.evidenceDiagnostics.correctionsApplied,0);
 assert.deepEqual(r.report.evidenceDiagnostics.invalidProofs[0].exactElsewherePaths,['analysis.knowledge.alpha']);assert.equal(r.report.evidenceDiagnostics.invalidProofs[0].exactElsewhereUnique,true);assert.deepEqual(r.report.evidenceDiagnostics.invalidProofs[1].normalizedWhitespacePaths,['analysis.summary']);assert.equal(r.report.evidenceDiagnostics.invalidProofs[2].fieldPathExists,false);assert.equal(JSON.stringify(r.report).includes('Primeiro ponto.'),false);assert.equal(JSON.stringify(r.report).includes('Invented quotation.'),false);
});

test('finite paid-output abstention cannot be enabled by an unbound sidecar or generalized to another response',()=>{
 const x=fixture(),r=prepareSemanticSourceRecovery(x),output=JSON.parse(x.envelope.rawResponse.candidates[0].content.parts[0].text);
 assert.equal(projectRecoveredSemanticOutput(output,r.receipt),output);
 const forged=structuredClone(r.receipt);forged.validatedProjection={version:finiteSavedProjectionRule.version,ruleHash:semanticHash(finiteSavedProjectionRule),originalOutputHash:semanticHash(output),projectedOutputHash:'0'.repeat(64),exclusions:[{reelId:finiteSavedProjectionRule.reelId,excerptSHA256:finiteSavedProjectionRule.excerptSHA256}]};forged.validatedProjection.projectionHash=semanticHash(forged.validatedProjection);delete forged.receiptHash;forged.receiptHash=semanticHash(forged);
 assert.throws(()=>projectRecoveredSemanticOutput(output,forged),/FINITE_SAVED_PROJECTION_RECEIPT_INVALID/);
 assert.equal(prepareSemanticSourceRecovery({...x,allowCompleteEpochEquivalence:true}).receipt.validatedProjection,undefined);
});
