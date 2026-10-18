import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {ReelsRepository} from '../google-v0/lib/reels-repository.mjs';
import {ReelsSemanticCurator,loadLiveContextCatalogue} from '../google-v0/lib/reels-semantic-curator.mjs';
import {semanticHash,semanticPolicyPath,semanticPolicyVersion,semanticSourceFromSaved} from '../google-v0/lib/reels-semantic-source.mjs';
import {semanticPromptHash} from '../google-v0/lib/reels-semantic-provider.mjs';
import {semanticUnknownProvider} from '../google-v0/tests/reels-semantic-fixture.mjs';
import {memoryReelsStore} from '../google-v0/qa/reels-fixture.mjs';

export async function rehearseSavedSemanticCatalogue(input,{sourceCommit='unknown'}={}){
 assert.equal(input.schemaVersion,1);
 const observation=input.observation;
 assert.equal(observation.readOnly,true);assert.equal(observation.providerCalls,0);assert.equal(observation.writes,0);
 assert.equal(input.sourceObservationSHA256,'41c61b96dc59ac85929adad158d29712235083ec64a83c337a9394a2118398cd');
 assert.equal(observation.records.length,738);
 const documents=Object.fromEntries(observation.records.map(r=>[r.path,r.data]));
 documents['settings/reels_v2_taxonomy']=observation.taxonomy?.data??observation.taxonomy;
 assert.ok(documents['settings/reels_v2_taxonomy']?.nodes);
 const store=memoryReelsStore(documents);
 // The rehearsal consumes exact saved source versions; synthetic store version
 // clocks are used only for newly derived metadata, never to rejuvenate sources.
 for(const r of observation.records)store.docs.set(r.path,{data:structuredClone(r.data),updateTime:r.updateTime});
 const sourceBefore=new Map(observation.records.map(r=>[r.path,semanticHash(store.docs.get(r.path))]));
 const repository=new ReelsRepository({store,cacheTtlMs:0});
 const deliveries=[],provider=semanticUnknownProvider();
 const curator=new ReelsSemanticCurator({repository,provider,enqueue:async job=>{deliveries.push({jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId,maxBatches:3});return {status:'sent'};}});
 const inventory=await curator.inventory();
 assert.equal(inventory.inventory.length,499);
 const pins=inventory.inventory.map(({id,sourceVersions})=>({id,sourceVersions})).sort((a,b)=>a.id.localeCompare(b.id)),cohortHash=semanticHash(pins);
 const policy={version:semanticPolicyVersion,enabled:true,model:'gemini-author-synthetic',verifierModel:'gemini-verifier-synthetic',batchSize:8,maxSources:499,maxCalls:127,authorizationId:'github-synthetic-saved499-only',authorizedCohortHash:cohortHash,expiresAt:'2099-01-01T00:00:00.000Z',autoPromotionEnabled:false,minUniqueMembers:10};
 await store.create(semanticPolicyPath,policy);
 const preview=await curator.preview({all:true});
 assert.equal(preview.preview.selectedCount,499);assert.equal(preview.preview.maximumCalls,127);
 assert.equal(provider.calls.length,0);
 const command={selection:{all:true},idempotencyKey:'github-saved499-semantic-rehearsal',previewHash:preview.previewHash};
 const created=await curator.create(command);
 assert.equal(provider.calls.length,0);
 let iterations=0;
 while(deliveries.length){
  assert.ok(++iterations<180,'Continuation must terminate');
  const delivery=deliveries.shift();await curator.runDelivery(delivery);
 }
 const job=(await curator.job(created.job.id)).job;
 assert.equal(job.status,'completed');assert.equal(job.processed,499);assert.equal(job.verificationProcessed,499);
 assert.equal(provider.calls.length,64);assert.equal(job.callsUsed,64);assert.ok(job.callsUsed<=job.maxCalls);
 const emptyRanges=[...store.docs.values()].map(row=>row.data).filter(row=>row.kind==='semantic_no_targets');
 assert.equal(emptyRanges.length,63);assert.ok(emptyRanges.every(row=>row.reason==='NO_ELIGIBLE_VERIFICATION_TARGETS'&&row.providerCalls===0&&row.semanticVerified===false));
 assert.deepEqual(emptyRanges.flatMap(row=>row.sourceIds).sort((a,b)=>a.localeCompare(b)),pins.map(pin=>pin.id));
 assert.equal(job.verificationSkippedSources,499);assert.equal(job.verificationTargetDecisions,0);assert.equal(provider.calls.filter(call=>call.phase==='verify').length,0);
 const exactExtracted=provider.calls.filter(c=>c.phase==='extract').flatMap(c=>c.ids).sort((a,b)=>a.localeCompare(b));
 assert.deepEqual(exactExtracted,pins.map(p=>p.id));
 const beforeRead=provider.calls.length;
 const overview=await curator.overview(),catalogue=await loadLiveContextCatalogue(repository);
 assert.equal(overview.coverage.published,499);assert.equal(overview.coverage.evaluated,499);
 assert.equal(overview.coverage.unknown,499);assert.equal(overview.groups.length,0);
 assert.equal(catalogue.state,'available');
 await curator.create(command);await curator.runDelivery({jobId:created.job.id,sequence:0,outboxId:semanticHash({jobId:created.job.id,sequence:0}),maxBatches:3});
 assert.equal(provider.calls.length,beforeRead,'GET/duplicate command/delivery cannot repeat inference');
 for(const [path,hash] of sourceBefore)assert.equal(semanticHash(store.docs.get(path)),hash,'Source mutated: '+path);
 const sources=await curator.loadSources(pins);
 const sourcesByKind={native:0,legacy_preserved:0};let truncated=0;
 for(const s of sources.sources){sourcesByKind[s.sourceIdentity.kind]++;if(s.truncated)truncated++;}
 assert.deepEqual(sourcesByKind,{native:301,legacy_preserved:198});
 return {
  schemaVersion:1,sourceCommit,sourceObservationSHA256:input.sourceObservationSHA256,cohortHash,
  semanticPromptHash,sourceDocuments:738,published:499,sourceKinds:sourcesByKind,
  truncatedSources:truncated,syntheticContractCalls:provider.calls.length,noTargetVerificationRanges:emptyRanges.length,verificationSkippedSources:job.verificationSkippedSources,verificationTargetDecisions:0,semanticRelationsVerified:0,actualProviderCalls:0,googleWrites:0,newReels:0,
  originalSourcesUnchanged:true,browserIndependentContinuation:true,
  unknownByDesign:499,semanticAccuracyMeasured:false,actualSemanticCurationExecuted:false,
  note:'This executes the real durable engine with an abstaining synthetic adapter. It is preservation/coverage/idempotency evidence, never semantic calibration or a paid-provider result.',
  job:{id:job.id,status:job.status,processed:job.processed,verificationProcessed:job.verificationProcessed},
  preparation:{policyVersion:semanticPolicyVersion,pins,cohortHash,sourceObservationSHA256:input.sourceObservationSHA256,maximumCalls:127,batchSize:8,maxSources:499,promptHash:semanticPromptHash,providerAuthorization:false,automaticPromotionAuthorization:false}
 };
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='mide-lim/MEGA-BRAIN')throw Error('Central GitHub Actions required.');
 const [flag,path,outFlag,out]=process.argv.slice(2);
 if(flag!=='--input'||!path||outFlag!=='--output'||!out)throw Error('Explicit input and output required.');
 const input=JSON.parse(await readFile(path,'utf8')),result=await rehearseSavedSemanticCatalogue(input,{sourceCommit:process.env.GITHUB_SHA});
 await mkdir(out,{recursive:true});
 await writeFile(join(out,'saved499-semantic-rehearsal.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 const policy={version:semanticPolicyVersion,enabled:true,model:'gemini-3.5-flash',verifierModel:'gemini-3.5-flash',batchSize:8,maxSources:499,maxCalls:127,authorizationId:'semantic-saved499-'+process.env.GITHUB_SHA.slice(0,16)+'-'+result.cohortHash.slice(0,12),authorizedCohortHash:result.cohortHash,expiresAt:new Date(Date.now()+24*60*60*1000).toISOString(),autoPromotionEnabled:false,minUniqueMembers:10};
 const operation={schemaVersion:1,kind:'finite_saved_text_curation_preparation',sourceCommit:process.env.GITHUB_SHA,createdAt:new Date().toISOString(),sourceObservationSHA256:result.sourceObservationSHA256,cohortHash:result.cohortHash,promptHash:semanticPromptHash,pins:result.preparation.pins,targetDocument:'settings/reels_v2_semantic_policy',expectedTargetExists:false,policy,policyHash:semanticHash(policy),queue:'v0-curation',workerRoute:'/tasks/curation',limits:{maxProviderCalls:127,maxSources:499,maxOutputTokensPerCall:16384,maxInputCharactersPerCall:320000,timeoutMsPerCall:90000,automaticProviderRetries:0},safety:{newReels:0,repeatedVideoOrSTTAnalyses:0,deletions:0,originalSourceWrites:0,uncertainPaidRecordsChanged:0,originalReelQueuesResumed:0,automaticCategoryPromotion:false},authorizationGranted:false,applied:false,actualProviderCalls:0,readiness:'Requires exact review, fresh source/fence checks and action-time resource authorization before application.'};
 operation.packageHash=semanticHash(operation);
 await writeFile(join(out,'semantic-activation-prepared.json'),JSON.stringify(operation,null,2)+'\n',{flag:'wx'});

 console.log(JSON.stringify({published:499,sourceDocuments:738,actualProviderCalls:0,googleWrites:0,semanticAccuracyMeasured:false,contractCompleted:result.job.status==='completed'}));
}
if(process.argv[1]?.endsWith('/prepare-semantic-curator.mjs'))await main();
