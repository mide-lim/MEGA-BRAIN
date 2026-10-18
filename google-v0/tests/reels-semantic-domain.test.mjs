import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {ReelsSemanticDomains} from '../lib/reels-semantic-domain-service.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {semanticHash,semanticPolicy} from '../lib/reels-semantic-source.mjs';
import {semanticDomainProfiles,routeExistingSemanticDomain,validateSemanticDomainDestinations} from '../lib/reels-semantic-domain-contract.mjs';
import {prepareSemanticDomainManifest,semanticDomainManifestValid,domainSourcePin,measureSemanticDomainRequest,semanticDomainRecordFromSaved} from '../lib/reels-semantic-domain-planner.mjs';
import {prepareOwnerDomainQuarantine,domainQuarantineReviewScope,domainBudgetPath,domainQuarantinePath} from '../lib/reels-semantic-domain-authority.mjs';
import {prepareSemanticProviderRequest,semanticExecutionPromptHash,semanticPromptHash} from '../lib/reels-semantic-provider.mjs';
import {makeSemanticDomainFixture,seedSemanticDomainManifest} from './reels-semantic-domain-fixture.mjs';
const clone=v=>structuredClone(v),equal=(a,b)=>assert.equal(semanticHash(a),semanticHash(b));
function setup(){const fixture=makeSemanticDomainFixture(),store=memoryReelsStore();for(const r of fixture.documents)store.docs.set(r.path,{data:clone(r.data),updateTime:r.updateTime});const now=new Date(Date.parse(fixture.at)+120000).toISOString(),repository=new ReelsRepository({store,cacheTtlMs:0}),deliveries=[],curator=new ReelsSemanticCurator({repository,provider:fixture.provider,clock:()=>Date.parse(now),enqueue:async j=>{deliveries.push(clone(j));return {status:'sent'};}}),domains=new ReelsSemanticDomains({repository,semantic:curator,clock:()=>Date.parse(now)});return {fixture,store,repository,curator,domains,now,deliveries};}
async function records(s){const i=await s.curator.inventory(),rows=[];for(const item of i.items)rows.push(semanticDomainRecordFromSaved(await s.curator.catalogue.loadSource(item.id)));return rows;}
test('domain routing is operational, exact-ID based and can abstain across unrelated ancestors',()=>{
 assert.equal(routeExistingSemanticDomain(['receitas']).domainId,'food');assert.equal(routeExistingSemanticDomain(['nutricao']).domainId,'food');
 assert.equal(routeExistingSemanticDomain(['Receita com frango']).domainId,'unassigned');assert.equal(routeExistingSemanticDomain(['a-organizar']).domainId,'unassigned');
 const r=routeExistingSemanticDomain(['receitas','desenvolvimento-software']);assert.equal(r.domainId,'unassigned');assert.equal(r.reason,'CROSS_DOMAIN_DESTINATION_PENDING');assert.equal(r.semanticCertified,false);
 assert.equal(routeExistingSemanticDomain(['manual-child'],[{id:'manual-child',parentId:'nutricao'}]).domainId,'food');
 assert.equal(routeExistingSemanticDomain(['cycle'],[{id:'cycle',parentId:'cycle'}]).domainId,'unassigned');
 assert.equal(semanticExecutionPromptHash(),semanticPromptHash);assert.notEqual(semanticExecutionPromptHash('food'),semanticExecutionPromptHash('technology'));
});
test('full request sizing includes Unicode, instruction, schema, catalogue and JSON; batches vary by content without truncation',async()=>{
 const s=setup(),r=await records(s),before=semanticHash(r),taxonomy=(await s.store.get('settings/reels_v2_taxonomy')).data,budget={maxEstimatedInputTokens:45000,maxRequestUtf8Bytes:45000};
 const manifest=prepareSemanticDomainManifest({records:r,taxonomy,histories:[],historyCoverageConfirmed:true,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now,budget});
 assert.equal(semanticDomainManifestValid(manifest),true);assert.equal(semanticHash(r),before);
 const b=manifest.domains.flatMap(d=>d.batches);assert.ok(b.length>0);assert.ok(b.every(b=>b.measurement.withinBudget&&b.sourceIds.length<=12));assert.ok(new Set(b.map(b=>b.sourceIds.length)).size>1);
 const source=r[0].source,request=prepareSemanticProviderRequest({phase:'extract',payload:{sources:[source],catalogue:{groups:[]}},requestId:'a'.repeat(64),domainId:'food'}),m=measureSemanticDomainRequest(request,budget);
 assert.equal(m.requestUtf8Bytes,Buffer.byteLength(JSON.stringify(request),'utf8'));assert.ok(m.requestUtf8Bytes>m.requestCharacters);assert.equal(m.estimatedInputTokens,m.requestUtf8Bytes+1024);assert.equal(m.providerTokenCount,null);assert.equal(m.estimated,true);assert.equal(m.includes.length,6);
 const over=prepareSemanticDomainManifest({records:r,taxonomy,histories:[],historyCoverageConfirmed:true,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now,budget:{maxRequestUtf8Bytes:4096}});
 assert.equal(over.domains.flatMap(d=>d.eligibleIds).length,0);assert.ok(over.sources.every(r=>r.state==='input_over_budget'));assert.equal(semanticHash(r),before);
 const unknown=prepareSemanticDomainManifest({records:r,taxonomy,histories:[],historyCoverageConfirmed:false,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now});
 assert.ok(unknown.sources.every(r=>r.state==='historical_coverage_unconfirmed'));assert.equal(unknown.domains.flatMap(d=>d.eligibleIds).length,0);assert.ok(unknown.domains.flatMap(d=>d.measurementBatches).length>0);assert.equal(unknown.baselineConsumedCalls,null);assert.equal(unknown.remainingGlobalCalls,null);
 const metadata=JSON.stringify(manifest);for(const forbidden of ['"fields":','"rawResponse":','"systemInstruction":','"contents":'])assert.equal(metadata.includes(forbidden),false);
});
test('Other destination proposals require literal source evidence, preserve manual choices and never approve automatically',async()=>{
 const s=setup(),r=(await records(s)).at(-1).source,field=r.fields[0],row={reelId:r.id,state:'suggested',domainId:'technology',reason:'Synthetic grounded destination proposal.',evidence:[{fieldPath:field.fieldPath,excerpt:field.text.slice(0,80)}]},output={destinations:[row],groups:[]};
 const [d]=validateSemanticDomainDestinations(output,[r],'unassigned');assert.equal(d.accepted,false);assert.equal(d.semanticCertified,false);assert.equal(d.originalCategoryUnchanged,true);
 assert.throws(()=>validateSemanticDomainDestinations({...output,destinations:[{...row,evidence:[{fieldPath:field.fieldPath,excerpt:'not a saved quote'}]}]},[r],'unassigned'),{code:'DOMAIN_DESTINATION_EVIDENCE_INVALID'});
 const manual={...r,editorial:{...r.editorial,manual:true}};assert.equal(validateSemanticDomainDestinations(output,[manual],'unassigned')[0].state,'manual_preserved');
 assert.equal(validateSemanticDomainDestinations({groups:[],destinations:[{reelId:r.id,state:'inconclusive',domainId:null,reason:'Insufficient saved text.',evidence:[]}]},[r],'unassigned')[0].state,'inconclusive');
 const missing=semanticDomainRecordFromSaved({video:{id:'QaMissing',status:'completed'},item:{id:'QaMissing',categoryIds:['a-organizar']},sourceVersions:{video:s.fixture.at}});assert.equal(missing.source,null);assert.equal(missing.analysisPresent,false);
});
test('real authenticated API exposes read-only domains and filters the same published IDs before pagination and text search',async()=>{
 const s=setup();await seedSemanticDomainManifest({curator:s.curator});const before=semanticHash([...s.store.docs]),api=reelsAPI({repository:s.repository,semantic:s.curator,authorize:async req=>req.headers.get('x-qa')==='yes',sameOrigin:async()=>true,clock:()=>Date.parse(s.now)});
 const get=async path=>{const r=await api(new Request('https://qa.example/api/reels/'+path,{headers:{'x-qa':'yes'}}));assert.equal(r.status,200);return r.json();};
 assert.equal((await api(new Request('https://qa.example/api/reels/curation/semantic/domains'))).status,401);
 const view=await get('curation/semantic/domains'),food=view.domains.find(d=>d.id==='food');assert.equal(food.inventoryCount,18);assert.equal(view.destinationPending.count,1);assert.equal(food.canStart,false);assert.equal(view.execution.canStart,false);
 const page=await get('items?workspace=library&curationDomainId=food&limit=7');assert.equal(page.total,food.inventoryCount);assert.equal(page.items.length,7);assert.ok(page.nextCursor);
 const next=await get('items?workspace=library&curationDomainId=food&limit=7&cursor='+encodeURIComponent(page.nextCursor));assert.equal(next.total,18);assert.equal(new Set([...page.items,...next.items].map(i=>i.id)).size,14);
 const search=await get('items?workspace=library&curationDomainId=food&q=Ada');assert.equal(search.total,9);assert.ok(search.items.every(i=>i.creator==='Ada'));
 assert.equal(s.fixture.calls.length,0);assert.equal(semanticHash([...s.store.docs]),before);
});
async function quarantineFixture(){
 const s=setup(),r=await records(s),pins=r.map(row=>({id:row.source.id,sourceVersions:row.source.sourceVersions})),id=semanticHash('synthetic historical domain job'),oldPolicy=semanticPolicy({enabled:true,model:'gemini-author-synthetic',verifierModel:'gemini-verifier-synthetic',maxCalls:127,maxSources:20,batchSize:8,authorizationId:'synthetic-old-ledger',authorizedCohortHash:semanticHash(pins),expiresAt:'2099-01-01T00:00:00.000Z'}),promptHash=semanticHash('synthetic old immutable prompt'),firstId=semanticHash({jobId:id,phase:'extract',cursor:0}),firstBinding={jobId:id,phase:'extract',cursor:0,pins:r.slice(0,8).map(row=>domainSourcePin(row.source)),promptHash},first={path:'reels_index/semantic_result_'+firstId,data:{kind:'semantic_result',id:firstId,binding:firstBinding,bindingHash:semanticHash(firstBinding),rawHash:semanticHash('synthetic saved raw'),processed:true},updateTime:s.fixture.at},binding={jobId:id,phase:'extract',cursor:8,pins:r.slice(8,16).map(row=>domainSourcePin(row.source)),promptHash};
 const j={kind:'semantic_job',id,status:'uncertain',reason:'PAID_SUBMISSION_OR_PERSISTENCE_UNCERTAIN',cursor:8,callsUsed:2,maxCalls:127,total:20,pins,cohortHash:semanticHash(pins),policy:oldPolicy,policyHash:semanticHash(oldPolicy),promptHash,dispatch:{sequence:1,outboxId:semanticHash({jobId:id,sequence:1}),status:'pending'},batch:{id:semanticHash('synthetic uncertain intent'),status:'submitting',offset:8,binding,bindingHash:semanticHash(binding),leaseUntil:s.fixture.at}},originJob={path:'reels_index/semantic_job_'+id,data:j,updateTime:s.fixture.at,readTime:s.now},originLedger={path:'reels_index/semantic_authorization_'+semanticHash(oldPolicy.authorizationId),data:{kind:'semantic_authorization',jobId:id,authorizationId:oldPolicy.authorizationId,cohortHash:j.cohortHash,promptHash,maximumCalls:127},updateTime:s.fixture.at,readTime:s.now},coordinator={path:'reels_index/semantic_coordinator',data:{kind:'semantic_coordinator',jobId:id,authorizationId:oldPolicy.authorizationId,cohortHash:j.cohortHash},updateTime:s.fixture.at,readTime:s.now};
 for(const row of [originJob,originLedger,coordinator,first])s.store.docs.set(row.path,{data:clone(row.data),updateTime:row.updateTime});
 const taxonomy=(await s.store.get('settings/reels_v2_taxonomy')).data,manifest=prepareSemanticDomainManifest({records:r,taxonomy,histories:[{job:originJob,results:[first],recoveries:[]}],historyCoverageConfirmed:true,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now});
 s.store.docs.set('settings/reels_v2_semantic_domain_plan',{data:clone(manifest),updateTime:s.fixture.at});
 const ownerApproval={kind:'explicit_owner_domain_authorization',executionAuthorized:true,authorizationGroupId:'synthetic-domain-global-budget',actorId:'synthetic-owner',packageHash:semanticHash('synthetic reviewed finite package'),humanAuthorizationRef:'synthetic explicit approval; no actual operation',maximumCalls:127,approvedAt:s.now,expiresAt:'2098-01-01T00:00:00.000Z',allowedDomains:semanticDomainProfiles.map(p=>p.id),models:{model:oldPolicy.model,verifierModel:oldPolicy.verifierModel},promptHashes:Object.fromEntries(semanticDomainProfiles.map(p=>[p.id,semanticExecutionPromptHash(p.id)]))};
 const input={manifest,originJob,originLedger,coordinator,queue:{name:'projects/synthetic-ci/locations/us-central1/queues/v0-curation',state:'PAUSED',taskCount:0,complete:true,readTime:s.now},ownerApproval,now:s.now},scopeHash=domainQuarantineReviewScope(input);
 input.review={path:'native-review/synthetic-domain-quarantine',sha256:semanticHash('synthetic review'),data:{kind:'native_independent_review',executor:'codex-native',role:'Revisor',actorId:'/root/synthetic-review',accepted:true,scopeHash,reviewedAt:s.now}};
 const trustedReview={scopeHash,dataHash:semanticHash(input.review.data),sha256:input.review.sha256,actorId:input.review.data.actorId},plan=prepareOwnerDomainQuarantine(input,{trustedReview,ownerApproval});
 return {...s,r,input,plan,manifest,originJob,originLedger};
}
test('owner quarantine preparation protects submitted sources and preserves old job/ledger while serial specialists consume one shared cap',async()=>{
 const s=await quarantineFixture();assert.equal(s.manifest.sources.filter(r=>r.state==='retained_applied').length,8);assert.equal(s.manifest.sources.filter(r=>r.state==='protected_uncertain').length,8);assert.equal(s.manifest.sources.filter(r=>r.state==='eligible').length,4);assert.equal(s.plan.executable,false);assert.equal(s.plan.remainingCalls,125);assert.equal(s.plan.writes.some(w=>w.path===s.originJob.path||w.path===s.originLedger.path),false);
 const oldHash=semanticHash([await s.store.get(s.originJob.path),await s.store.get(s.originLedger.path)]);
 assert.equal((await s.store.commitSemantic({checks:s.plan.checks,writes:s.plan.writes})).applied,true);
 assert.equal((await s.curator.runDelivery({jobId:s.originJob.data.id,sequence:1,outboxId:s.originJob.data.dispatch.outboxId})).quarantined,true);assert.equal(s.fixture.calls.length,0);
 const domain=s.manifest.domains.find(d=>d.id==='food'),policy=semanticPolicy({...s.originJob.data.policy,authorizationId:'synthetic-new-food-authorization',authorizedCohortHash:semanticHash(domain.batches.flatMap(b=>b.pins).map(p=>({id:p.id,sourceVersions:p.sourceVersions}))),expiresAt:s.input.ownerApproval.expiresAt,domainCuration:{version:'semantic-domain-job-v1',domainId:'food',planHash:s.manifest.manifestHash,authorizationGroupId:s.input.ownerApproval.authorizationGroupId}});
 await s.store.patch('settings/reels_v2_semantic_policy',policy,{updateTime:(await s.store.get('settings/reels_v2_semantic_policy'))?.updateTime}).catch(async()=>s.store.create('settings/reels_v2_semantic_policy',policy));
 const preview=await s.curator.preview({domainId:'food'});assert.equal(preview.preview.providerEnabled,true);const created=await s.curator.create({selection:{domainId:'food'},previewHash:preview.previewHash,idempotencyKey:'synthetic-domain-food-create'});s.deliveries.length=0;
 await s.curator.runDelivery({jobId:created.job.id,sequence:created.job.dispatch.sequence,outboxId:created.job.dispatch.outboxId,maxBatches:3});
 const job=(await s.store.get('reels_index/semantic_job_'+created.job.id)).data;assert.equal(job.status,'completed');assert.equal(job.callsUsed,2);assert.equal((await s.store.get(s.plan.budgetPath)).data.callsUsed,4);assert.ok(s.fixture.calls.filter(c=>c.phase==='extract').every(c=>c.ids.every(id=>!s.plan.authority.protectedSourceIds.includes(id)&&!s.plan.authority.retainedSourceIds.includes(id))));assert.equal(semanticHash([await s.store.get(s.originJob.path),await s.store.get(s.originLedger.path)]),oldHash);
 await assert.rejects(()=>s.curator.create({selection:{domainId:'food'},previewHash:(await s.curator.preview({domainId:'food'})).previewHash,idempotencyKey:'another-key-same-domain-authorization'}),{code:'SEMANTIC_AUTHORIZATION_CONSUMED'});
});
test('quarantine and global budget fail closed on source/race/missing owner authority and never reset a consumed call',async()=>{
 const s=await quarantineFixture();assert.throws(()=>prepareOwnerDomainQuarantine(s.input),{code:'DOMAIN_QUARANTINE_REVIEW_REQUIRED'});
 const changed=clone(s.input);changed.queue.taskCount=1;assert.throws(()=>prepareOwnerDomainQuarantine(changed,{trustedReview:{},ownerApproval:changed.ownerApproval}),{code:'DOMAIN_QUARANTINE_CLOSED_OBSERVATION_REQUIRED'});
 s.store.docs.get(s.originJob.path).updateTime='2026-10-18T00:01:00.000Z';assert.equal((await s.store.commitSemantic({checks:s.plan.checks,writes:s.plan.writes})).applied,false);assert.equal(s.fixture.calls.length,0);assert.equal(await s.store.get(s.plan.budgetPath),null);
});
