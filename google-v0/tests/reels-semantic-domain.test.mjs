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
import {prepareSemanticProviderRequest,semanticExecutionPromptHash,semanticPromptHash,ReelsSemanticProvider} from '../lib/reels-semantic-provider.mjs';
import {makeSemanticDomainFixture,seedSemanticDomainManifest,seedSyntheticDomainOwner} from './reels-semantic-domain-fixture.mjs';
import {semanticEnvelope} from './reels-semantic-fixture.mjs';
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
 await assert.rejects(async()=>s.curator.create({selection:{domainId:'food'},previewHash:(await s.curator.preview({domainId:'food'})).previewHash,idempotencyKey:'another-key-same-domain-authorization'}),{code:'SEMANTIC_NOT_AUTHORIZED'});
});
test('quarantine and global budget fail closed on source/race/missing owner authority and never reset a consumed call',async()=>{
 const s=await quarantineFixture();assert.throws(()=>prepareOwnerDomainQuarantine(s.input),{code:'DOMAIN_QUARANTINE_REVIEW_REQUIRED'});
 const changed=clone(s.input);changed.queue.taskCount=1;assert.throws(()=>prepareOwnerDomainQuarantine(changed,{trustedReview:{},ownerApproval:changed.ownerApproval}),{code:'DOMAIN_QUARANTINE_CLOSED_OBSERVATION_REQUIRED'});
 s.store.docs.get(s.originJob.path).updateTime='2026-10-18T00:01:00.000Z';assert.equal((await s.store.commitSemantic({checks:s.plan.checks,writes:s.plan.writes})).applied,false);assert.equal(s.fixture.calls.length,0);assert.equal(await s.store.get(s.plan.budgetPath),null);
});

async function startOwnerDomain(s,domainId='food',authorizationId='synthetic-domain-'+domainId){
 const old=(await s.store.get('settings/reels_v2_semantic_policy')),domain=(await s.store.get('settings/reels_v2_semantic_domain_plan')).data.domains.find(d=>d.id===domainId);
 const p=semanticPolicy({...old.data,authorizationId,authorizedCohortHash:semanticHash(domain.batches.flatMap(b=>b.pins).map(p=>({id:p.id,sourceVersions:p.sourceVersions}))),domainCuration:{...old.data.domainCuration,domainId}});
 await s.store.patch('settings/reels_v2_semantic_policy',p,{updateTime:old.updateTime});
 const preview=await s.curator.preview({domainId});return s.domains.command({action:'create',domainId,previewHash:preview.previewHash,idempotencyKey:'synthetic-'+authorizationId});
}
async function finishDomain(s,created){let job=created.job;for(let n=0;n<8&&!['completed','paused','uncertain'].includes(job.status);n++)job=(await s.curator.runDelivery({jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId,maxBatches:3})).job;return job;}
function realDomainProvider(captured,{destinations=false}={}){
 return new ReelsSemanticProvider({api:{project:'synthetic-domain-ci',async request(_url,{json}){
  const input=JSON.parse(json.contents[0].parts[0].text);captured.push({input,request:clone(json)});
  const proof=s=>({fieldPath:s.fields[0].fieldPath,excerpt:s.fields[0].text.slice(0,80)});let output;
  if(input.phase==='extract')output={version:1,profiles:input.sources.map(s=>({reelId:s.id,context:'recipe',state:'proposed',reason:'Synthetic saved purpose evidence.',units:[]})),groups:[{key:'domain-food-example',name:'Preparos sintéticos',kind:'segment',context:'recipe',definition:'Synthetic recurring purpose, not a semantic accuracy claim.',aliases:[],positiveCriteria:['Saved preparation purpose.'],negativeCriteria:['Different saved purpose.'],members:[{reelId:input.sources[0].id,role:'central',unitIds:[],evidence:[proof(input.sources[0])]}],negativeExamples:input.sources.slice(1).map(s=>({reelId:s.id,reason:'Synthetic different purpose.',evidence:[proof(s)]}))}],destinations:input.sources.map(s=>destinations?{reelId:s.id,state:'suggested',domainId:'technology',reason:'Synthetic source-bound destination hypothesis.',evidence:[proof(s)]}:{reelId:s.id,state:'inconclusive',domainId:null,reason:'Insufficient destination evidence.',evidence:[]})};
  else if(input.phase==='consolidate')output={version:1,resolutions:input.groups.map(g=>({groupId:g.id,decision:'keep',mergeInto:'',reason:'Synthetic unchanged definition.'}))};
  else output={version:1,members:input.members.map(m=>({groupId:m.groupId,reelId:m.reelId,verdict:'supported',reason:'Synthetic independent verification fixture.',evidence:m.evidence.map(e=>({fieldPath:e.fieldPath,excerpt:e.excerpt}))})),negativeExamples:input.negativeExamples.map(m=>({groupId:m.groupId,reelId:m.reelId,verdict:'supported',reason:'Synthetic negative evidence fixture.',evidence:m.evidence.map(e=>({fieldPath:e.fieldPath,excerpt:e.excerpt}))}))};
  return semanticEnvelope(output,'gemini-domain-synthetic').rawResponse;
 }}});
}
test('domain engine sends the same scoped real-adapter wire through extraction, consolidation and nonempty verification',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),captured=[];s.curator.provider=realDomainProvider(captured);
 const old=semanticHash([await s.store.get(seed.originJob.path),await s.store.get(seed.originLedger.path)]),created=await startOwnerDomain(s),job=await finishDomain(s,created);
 assert.equal(job.status,'completed');assert.equal(job.callsUsed,3);assert.deepEqual(captured.map(r=>r.input.phase),['extract','consolidate','verify']);
 assert.equal(captured[2].input.members.length,1);assert.equal(captured[2].input.negativeExamples.length,1);
 for(const r of captured){assert.match(r.request.systemInstruction.parts[0].text,/Especialista operacional: Alimentação/);assert.match(r.request.systemInstruction.parts[0].text,/recipe, health, home/);}
 assert.match(captured[0].request.systemInstruction.parts[0].text,/Para cada fonte devolva exatamente uma destination/);
 for(const r of captured.slice(1))assert.doesNotMatch(r.request.systemInstruction.parts[0].text,/Para cada fonte devolva exatamente uma destination/);
 const verify=(await s.curator.scan('semantic_result')).find(r=>r.data.binding.jobId===job.id&&r.data.phase==='verify').data;
 assert.equal(verify.binding.preparedRequestHash,verify.requestHash);assert.equal(verify.binding.domainScope.domainId,'food');
 assert.equal((await s.store.get(seed.plan.budgetPath)).data.callsUsed,5);assert.equal(semanticHash([await s.store.get(seed.originJob.path),await s.store.get(seed.originLedger.path)]),old);
});
test('domain claims survive a new policy authorization and same-key API replay is idempotent',async()=>{
 const s=setup();await seedSyntheticDomainOwner({curator:s.curator});const created=await startOwnerDomain(s),saved=(await s.store.get('reels_index/semantic_job_'+created.job.id)).data;
 const repeated=await s.domains.command({action:'create',domainId:'food',previewHash:saved.previewHash,idempotencyKey:'synthetic-synthetic-domain-food'});assert.equal(repeated.created,false);assert.equal(repeated.job.id,created.job.id);assert.equal(s.fixture.calls.length,0);
 assert.equal((await finishDomain(s,created)).status,'completed');const before=s.fixture.calls.length;
 const policy=await s.store.get('settings/reels_v2_semantic_policy');await s.store.patch('settings/reels_v2_semantic_policy',{...policy.data,authorizationId:'synthetic-different-authorization-same-domain'},{updateTime:policy.updateTime});
 const preview=await s.curator.preview({domainId:'food'});assert.equal(preview.preview.providerEnabled,false);assert.ok(preview.preview.blockingReasons.includes('DOMAIN_COHORT_ALREADY_CLAIMED'));assert.equal((await s.domains.overview()).domains.find(d=>d.id==='food').canStart,false);
 await assert.rejects(()=>s.curator.create({selection:{domainId:'food'},previewHash:preview.previewHash,idempotencyKey:'synthetic-second-domain-job'}),{code:'SEMANTIC_NOT_AUTHORIZED'});assert.equal(s.fixture.calls.length,before);
});
test('all owner approval authority fields are bound to the independent quarantine review',async()=>{
 const s=await quarantineFixture(),trustedReview={scopeHash:s.input.review.data.scopeHash,dataHash:semanticHash(s.input.review.data),sha256:s.input.review.sha256,actorId:s.input.review.data.actorId};
 const mutations=[a=>a.allowedDomains=['food'],a=>a.models.model='other-model',a=>a.promptHashes.food=semanticHash('other-prompt'),a=>a.expiresAt='2097-01-01T00:00:00.000Z',a=>a.actorId='other-owner',a=>a.humanAuthorizationRef='other-approval',a=>a.packageHash=semanticHash('other-package')];
 for(const mutate of mutations){const input=clone(s.input);mutate(input.ownerApproval);assert.throws(()=>prepareOwnerDomainQuarantine(input,{trustedReview,ownerApproval:input.ownerApproval}),{code:'DOMAIN_QUARANTINE_REVIEW_REQUIRED'});}
});
test('serial specialists share the same cap; the 127th intent is allowed once and budget CAS races submit nothing',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),food=await startOwnerDomain(s);assert.equal((await finishDomain(s,food)).status,'completed');
 const tech=await startOwnerDomain(s,'technology','synthetic-technology-authorization');assert.equal((await finishDomain(s,tech)).status,'completed');assert.equal((await s.store.get(seed.plan.budgetPath)).data.callsUsed,6);
 const z=setup(),zs=await seedSyntheticDomainOwner({curator:z.curator}),created=await startOwnerDomain(z),budget=await z.store.get(zs.plan.budgetPath);
 await z.store.patch(zs.plan.budgetPath,{...budget.data,callsUsed:126,domainCallsUsed:124},{updateTime:budget.updateTime});
 const stopped=await finishDomain(z,created);assert.equal(stopped.status,'paused');assert.equal(stopped.callsUsed,1);assert.equal(z.fixture.calls.length,1);assert.equal((await z.store.get(zs.plan.budgetPath)).data.callsUsed,127);
 const race=setup(),rs=await seedSyntheticDomainOwner({curator:race.curator}),rj=await startOwnerDomain(race),commit=race.store.commitSemantic.bind(race.store);let raced=false;
 race.store.commitSemantic=async input=>{if(!raced&&input.writes.some(w=>w.path===rs.plan.budgetPath)){raced=true;const b=await race.store.get(rs.plan.budgetPath);await race.store.patch(rs.plan.budgetPath,{...b.data,callsUsed:3,domainCallsUsed:1},{updateTime:b.updateTime});}return commit(input);};
 await race.curator.runDelivery({jobId:rj.job.id,sequence:rj.job.dispatch.sequence,outboxId:rj.job.dispatch.outboxId,maxBatches:3});assert.equal(raced,true);assert.equal(race.fixture.calls.length,0);assert.equal((await race.store.get('reels_index/semantic_job_'+rj.job.id)).data.callsUsed,0);
});
test('destination proof detail hydrates only its current saved source and GET never calls a provider',async()=>{
 const s=setup();await seedSyntheticDomainOwner({curator:s.curator});const captured=[];s.curator.provider=realDomainProvider(captured,{destinations:true});const created=await startOwnerDomain(s);assert.equal((await finishDomain(s,created)).status,'completed');
 const view=await s.domains.overview(),suggestion=view.destinationPending.suggestions.find(d=>d.state==='suggested');assert.ok(suggestion.title);assert.equal(suggestion.suggestedDomainLabel,'Tecnologia');assert.ok(suggestion.reason);
 const before=captured.length,reads=[],load=s.curator.catalogue.loadSource.bind(s.curator.catalogue);s.curator.catalogue.loadSource=async id=>{reads.push(id);return load(id);};
 const api=reelsAPI({repository:s.repository,semantic:s.curator,authorize:async()=>true,sameOrigin:async()=>true,clock:()=>Date.parse(s.now)}),response=await api(new Request('https://qa.example/api/reels/'+suggestion.detailPath));assert.equal(response.status,200);const detail=await response.json();assert.equal(detail.sourceStale,false);assert.equal(detail.evidence.length,1);assert.equal(detail.inferenceOnGet,false);assert.deepEqual(reads,[suggestion.reelId]);assert.equal(captured.length,before);
 const raw=s.store.docs.get('videos/'+suggestion.reelId);raw.updateTime='2026-10-18T00:03:00.000Z';const stale=await s.domains.destination(suggestion.reelId);assert.equal(stale.sourceStale,true);assert.deepEqual(stale.evidence,[]);assert.equal(captured.length,before);
});

test('simultaneous distinct create keys cannot consume a domain cohort twice',async()=>{
 const s=setup();await seedSyntheticDomainOwner({curator:s.curator});const preview=await s.curator.preview({domainId:'food'});
 const results=await Promise.allSettled(['first-racing-domain','second-racing-domain'].map(idempotencyKey=>s.curator.create({selection:{domainId:'food'},previewHash:preview.previewHash,idempotencyKey})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await s.curator.scan('semantic_domain_claim')).length,1);assert.equal(s.fixture.calls.length,0);
});
test('a source nominally routed to food can suggest technology but cannot create an out-of-profile group',async()=>{
 const s=setup(),source=(await records(s))[0].source,field=source.fields[0],d={reelId:source.id,state:'suggested',domainId:'technology',reason:'Different saved purpose.',evidence:[{fieldPath:field.fieldPath,excerpt:field.text.slice(0,40)}]};
 assert.equal(validateSemanticDomainDestinations({groups:[],destinations:[d]},[source],'food')[0].suggestedDomainId,'technology');
 assert.throws(()=>validateSemanticDomainDestinations({groups:[{context:'technology'}],destinations:[d]},[source],'food'),{code:'DOMAIN_GROUP_CONTEXT_OUTSIDE_PROFILE'});
 const request=prepareSemanticProviderRequest({phase:'extract',payload:{sources:[source],catalogue:{groups:[]}},requestId:'a'.repeat(64),domainId:'food'});
 assert.deepEqual(request.generationConfig.responseSchema.properties.groups.items.properties.context.enum,['recipe','health','home']);
});
