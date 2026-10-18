import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {ReelsSemanticDomains} from '../lib/reels-semantic-domain-service.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {semanticHash,semanticPolicy} from '../lib/reels-semantic-source.mjs';
import {semanticDomainProfiles,routeExistingSemanticDomain,validateSemanticDomainDestinations} from '../lib/reels-semantic-domain-contract.mjs';
import {prepareSemanticDomainManifest,semanticDomainManifestValid,measureSemanticDomainManifestStorage,semanticDomainBatchPins,domainSourcePin,measureSemanticDomainRequest,semanticDomainRecordFromSaved} from '../lib/reels-semantic-domain-planner.mjs';
import {prepareOwnerDomainQuarantine,domainQuarantineReviewScope,domainBudgetPath,domainQuarantinePath,uniqueDomainAuthorityChecks} from '../lib/reels-semantic-domain-authority.mjs';
import {prepareSemanticProviderRequest,semanticExecutionPromptHash,semanticPromptHash,ReelsSemanticProvider} from '../lib/reels-semantic-provider.mjs';
import {makeSemanticDomainFixture,seedSemanticDomainManifest,seedSyntheticDomainOwner} from './reels-semantic-domain-fixture.mjs';
import {Firestore} from '../lib/firestore.mjs';
import {semanticEnvelope} from './reels-semantic-fixture.mjs';
const clone=v=>structuredClone(v),equal=(a,b)=>assert.equal(semanticHash(a),semanticHash(b));
function setup({count=20}={}){const fixture=makeSemanticDomainFixture({count}),store=memoryReelsStore();for(const r of fixture.documents)store.docs.set(r.path,{data:clone(r.data),updateTime:r.updateTime});const now=new Date(Date.parse(fixture.at)+120000).toISOString(),repository=new ReelsRepository({store,cacheTtlMs:0}),deliveries=[],curator=new ReelsSemanticCurator({repository,provider:fixture.provider,clock:()=>Date.parse(now),enqueue:async j=>{deliveries.push(clone(j));return {status:'sent'};}}),domains=new ReelsSemanticDomains({repository,semantic:curator,clock:()=>Date.parse(now)});return {fixture,store,repository,curator,domains,now,deliveries};}
async function records(s){const i=await s.curator.inventory(),rows=[];for(const item of i.items)rows.push(semanticDomainRecordFromSaved(await s.curator.catalogue.loadSource(item.id)));return rows;}
test('domain routing is operational, exact-ID based and can abstain across unrelated ancestors',()=>{
 assert.equal(routeExistingSemanticDomain(['receitas']).domainId,'food');assert.equal(routeExistingSemanticDomain(['nutricao']).domainId,'food');
 assert.equal(routeExistingSemanticDomain(['Receita com frango']).domainId,'unassigned');assert.equal(routeExistingSemanticDomain(['a-organizar']).domainId,'unassigned');
 const r=routeExistingSemanticDomain(['receitas','desenvolvimento-software']);assert.equal(r.domainId,'unassigned');assert.equal(r.reason,'CROSS_DOMAIN_DESTINATION_PENDING');assert.equal(r.semanticCertified,false);
 assert.equal(routeExistingSemanticDomain(['manual-child'],[{id:'manual-child',parentId:'nutricao'}]).domainId,'food');
 assert.equal(routeExistingSemanticDomain(['cycle'],[{id:'cycle',parentId:'cycle'}]).domainId,'unassigned');
 assert.equal(semanticExecutionPromptHash(),semanticPromptHash);assert.notEqual(semanticExecutionPromptHash('food'),semanticExecutionPromptHash('technology'));
});
test('direct editorial children route through official root IDs or exact top-level names',()=>{
 const roots=[['group-alimentacao','Alimentação','food'],['group-tecnologia','Tecnologia','technology'],['group-saude','Saúde e bem-estar','health'],['group-trabalho','Trabalho e negócios','business'],['group-casa','Casa e estilo','home'],['group-viagens','Viagens e lugares','travel']];
 for(const [id,name,domain] of roots){
  assert.equal(routeExistingSemanticDomain([id]).domainId,domain);
  const nodes=[{id,name,parentId:null},{id:'manual_branch',name:'Ramo editorial',parentId:id},{id:'manual_child',name:'Filho',parentId:'manual_branch'}];
  const routed=routeExistingSemanticDomain(['manual_child'],nodes);
  assert.equal(routed.domainId,domain);assert.equal(routed.semanticCertified,false);assert.equal(routed.routedByExistingCategory,true);
  assert.equal(routeExistingSemanticDomain(['custom_root'],[{id:'custom_root',name,parentId:null}]).domainId,domain);
 }
 const cultureNodes=[{id:'manual_culture_root',name:'Cultura e conhecimento',parentId:null},{id:'manual_culture_child',name:'Artes',parentId:'manual_culture_root'}];
 assert.equal(routeExistingSemanticDomain(['manual_culture_child'],cultureNodes).domainId,'culture');
 assert.deepEqual(semanticDomainProfiles.find(p=>p.id==='culture').contexts,['general']);
 assert.equal(routeExistingSemanticDomain(['not_root'],[{id:'not_root',name:'Casa e estilo',parentId:'missing'}]).domainId,'unassigned');
 assert.equal(routeExistingSemanticDomain(['unknown'],[{id:'unknown',name:'Casa e estilo pessoal',parentId:null}]).domainId,'unassigned');
 const cross=routeExistingSemanticDomain(['group-casa','group-trabalho']);assert.equal(cross.domainId,'unassigned');assert.deepEqual(cross.candidateDomainIds,['business','home']);
 const cyclic=[{id:'a',name:'Cultura e conhecimento',parentId:'b'},{id:'b',name:'Outros',parentId:'a'}];assert.equal(routeExistingSemanticDomain(['a'],cyclic).domainId,'unassigned');
});
test('operational domain totals agree with direct-root category memberships across all eight destinations',()=>{
 const cases=[['group-alimentacao','Alimentação','food',204],['group-tecnologia','Tecnologia','technology',97],['group-saude','Saúde e bem-estar','health',32],['group-trabalho','Trabalho e negócios','business',25],['group-casa','Casa e estilo','home',58],['group-viagens','Viagens e lugares','travel',19],['manual_culture_root','Cultura e conhecimento','culture',12],['group-outros','Outros temas','unassigned',52]],nodes=cases.flatMap(([id,name])=>[{id,name,parentId:null},{id:'child_'+id,name:'Ramo editorial',parentId:id}]),totals={};
 // Synthetic membership fixture: routing checks, not a new observation of production.
 for(const [id,,domain,count] of cases)for(let i=0;i<count;i++){const route=routeExistingSemanticDomain(['child_'+id],nodes);assert.equal(route.domainId,domain);totals[route.domainId]=(totals[route.domainId]??0)+1;}
 assert.deepEqual(totals,{food:204,technology:97,health:32,business:25,home:58,travel:19,culture:12,unassigned:52});assert.equal(Object.values(totals).reduce((n,v)=>n+v,0),499);
});
test('a previous seven-profile manifest cannot activate paid work after culture is added',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),created=await startOwnerDomain(s),path='settings/reels_v2_semantic_domain_plan',current=await s.store.get(path),older=clone(current.data),beforeBudget=await s.store.get(seed.plan.budgetPath),beforeOrigin=await s.store.get(seed.originJob.path);
 older.domains=older.domains.filter(d=>d.id!=='culture');delete older.manifestHash;older.manifestHash=semanticHash(older);
 assert.equal(semanticDomainManifestValid(older),false);
 await s.store.patch(path,older,{updateTime:current.updateTime});
 const stopped=await finishDomain(s,created);assert.equal(stopped.status,'paused');assert.equal(stopped.callsUsed,0);assert.equal(s.fixture.calls.length,0);
 equal(await s.store.get(seed.plan.budgetPath),beforeBudget);equal(await s.store.get(seed.originJob.path),beforeOrigin);
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
 const domain=s.manifest.domains.find(d=>d.id==='food'),policy=semanticPolicy({...s.originJob.data.policy,authorizationId:'synthetic-new-food-authorization',authorizedCohortHash:semanticHash(domain.batches.flatMap(b=>semanticDomainBatchPins(s.manifest,b)).map(p=>({id:p.id,sourceVersions:p.sourceVersions}))),expiresAt:s.input.ownerApproval.expiresAt,domainCuration:{version:'semantic-domain-job-v1',domainId:'food',planHash:s.manifest.manifestHash,authorizationGroupId:s.input.ownerApproval.authorizationGroupId}});
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
 const old=(await s.store.get('settings/reels_v2_semantic_policy')),manifest=(await s.store.get('settings/reels_v2_semantic_domain_plan')).data,domain=manifest.domains.find(d=>d.id===domainId);
 const p=semanticPolicy({...old.data,authorizationId,authorizedCohortHash:semanticHash(domain.batches.flatMap(b=>semanticDomainBatchPins(manifest,b)).map(p=>({id:p.id,sourceVersions:p.sourceVersions}))),domainCuration:{...old.data.domainCuration,domainId}});
 await s.store.patch('settings/reels_v2_semantic_policy',p,{updateTime:old.updateTime});
 const preview=await s.curator.preview({domainId});return s.domains.command({action:'create',domainId,previewHash:preview.previewHash,idempotencyKey:'synthetic-'+authorizationId});
}
async function finishDomain(s,created){let job=created.job;for(let n=0;n<8&&!['completed','paused','uncertain'].includes(job.status);n++)job=(await s.curator.runDelivery({jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId,maxBatches:3})).job;return job;}
function realDomainProvider(captured,{destinations=false}={}){
 return new ReelsSemanticProvider({api:{project:'megabrain-v0-1017370021431',async request(_url,{json}){
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
 const api=reelsAPI({repository:s.repository,semantic:s.curator,authorize:async()=>true,sameOrigin:async()=>true,clock:()=>Date.parse(s.now)}),response=await api(new Request('https://qa.example/api/reels/'+suggestion.detailPath));assert.equal(response.status,200);const detail=await response.json();assert.equal(detail.sourceStale,false);assert.equal(detail.accepted,false);assert.equal(detail.semanticCertified,false);assert.equal(typeof detail.sourceCoverage.truncated,'boolean');assert.equal(detail.sourceCoverage.scope,'saved_text_projection_not_complete_video');assert.equal(detail.evidence.length,1);assert.equal(detail.inferenceOnGet,false);assert.deepEqual(reads,[suggestion.reelId]);assert.equal(captured.length,before);
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

test('one unchanged root owner policy starts two different allowed specialists serially without configuration writes',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),root=await s.store.get('settings/reels_v2_semantic_policy'),original=semanticHash([await s.store.get(seed.originJob.path),await s.store.get(seed.originLedger.path)]);
 const preview=await s.domains.command({action:'preview',domainId:'food'}),created=await s.domains.command({action:'create',domainId:'food',previewHash:preview.previewHash,idempotencyKey:'synthetic-root-food-once'});assert.equal((await finishDomain(s,created)).status,'completed');
 const view=await s.domains.overview();assert.equal(view.domains.find(d=>d.id==='food').canStart,false);assert.equal(view.domains.find(d=>d.id==='technology').canStart,true);
 const nextPreview=await s.domains.command({action:'preview',domainId:'technology'}),tech=await s.domains.command({action:'create',domainId:'technology',previewHash:nextPreview.previewHash,idempotencyKey:'synthetic-root-tech-once'});assert.equal((await finishDomain(s,tech)).status,'completed');
 const first=(await s.store.get('reels_index/semantic_job_'+created.job.id)).data,second=(await s.store.get('reels_index/semantic_job_'+tech.job.id)).data;assert.notEqual(first.policy.authorizationId,second.policy.authorizationId);assert.equal(first.rootPolicyHash,semanticHash(root.data));assert.equal(second.rootPolicyHash,first.rootPolicyHash);
 equal(await s.store.get('settings/reels_v2_semantic_policy'),root);assert.equal((await s.store.get(seed.plan.budgetPath)).data.callsUsed,6);assert.equal(semanticHash([await s.store.get(seed.originJob.path),await s.store.get(seed.originLedger.path)]),original);
});
test('a root policy edit between domain creation and delivery fails closed before any submission',async()=>{
 const s=setup();await seedSyntheticDomainOwner({curator:s.curator});const p=await s.domains.command({action:'preview',domainId:'food'}),created=await s.domains.command({action:'create',domainId:'food',previewHash:p.previewHash,idempotencyKey:'synthetic-root-race-once'}),root=await s.store.get('settings/reels_v2_semantic_policy');
 await s.store.patch('settings/reels_v2_semantic_policy',{...root.data,authorizationId:'synthetic-other-root'},{updateTime:root.updateTime});const job=await finishDomain(s,created);assert.equal(job.status,'paused');assert.equal(job.reason,'SEMANTIC_AUTHORIZATION_CHANGED');assert.equal(job.callsUsed,0);assert.equal(s.fixture.calls.length,0);
});

test('a requested specialist outside the sealed allowedDomains cannot start or submit',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),a=await s.store.get(seed.plan.authorityPath),body=clone(a.data);delete body.authorityHash;body.approval.allowedDomains=['food'];const authority={...body,authorityHash:semanticHash(body)};
 s.store.docs.set(seed.plan.authorityPath,{data:authority,updateTime:a.updateTime});
 for(const path of [seed.plan.budgetPath,seed.plan.quarantinePath]){const d=s.store.docs.get(path);d.data.authorityHash=authority.authorityHash;}
 const p=await s.curator.preview({domainId:'technology'});assert.equal(p.preview.providerEnabled,false);assert.ok(p.preview.blockingReasons.includes('DOMAIN_GLOBAL_AUTHORITY_INVALID'));
 await assert.rejects(()=>s.domains.command({action:'create',domainId:'technology',previewHash:p.previewHash,idempotencyKey:'synthetic-denied-tech'}),{code:'DOMAIN_START_NOT_AUTHORIZED'});assert.equal(s.fixture.calls.length,0);
});

test('the root policy cannot be replaced by its exact child or rewritten at a new epoch to bypass its seal',async()=>{
 for(const replacement of ['exact_child','same_root_new_epoch']){
  const s=setup();await seedSyntheticDomainOwner({curator:s.curator});const p=await s.domains.command({action:'preview',domainId:'food'}),created=await s.domains.command({action:'create',domainId:'food',previewHash:p.previewHash,idempotencyKey:'synthetic-root-seal-'+replacement}),path='reels_index/semantic_job_'+created.job.id,job=(await s.store.get(path)).data,root=await s.store.get('settings/reels_v2_semantic_policy');
  await s.store.patch('settings/reels_v2_semantic_policy',replacement==='exact_child'?clone(job.policy):clone(root.data),{updateTime:root.updateTime});
  assert.notEqual((await s.store.get('settings/reels_v2_semantic_policy')).updateTime,job.policyVersion);await assert.rejects(()=>s.curator.executionPolicy(job),{code:'SEMANTIC_AUTHORIZATION_CHANGED'});
  const outcome=await s.curator.runDelivery({jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId,maxBatches:3});assert.equal(outcome.job.status,'paused');assert.equal(outcome.job.reason,'SEMANTIC_AUTHORIZATION_CHANGED');assert.equal(outcome.job.callsUsed,0);assert.equal(s.fixture.calls.length,0);assert.equal((await s.store.get(path)).data.batch,null);
 }
});

test('invalid configured call limits cannot normalize to the enabled authorized 127-call policy',()=>{
 const value={enabled:true,maxCalls:127,model:'gemini-domain-synthetic',verifierModel:'gemini-domain-verifier',authorizationId:'synthetic-existing-policy',expiresAt:'2099-01-01T00:00:00.000Z'},valid=semanticPolicy(value);
 assert.equal(valid.enabled,true);assert.equal(valid.maxCalls,127);equal(semanticPolicy(valid),valid);
 for(const maxCalls of [128,160,0,-1,1.5,'127',null]){const invalid=semanticPolicy({...value,maxCalls});assert.equal(invalid.enabled,false);assert.notEqual(semanticHash(invalid),semanticHash(valid));}
 assert.equal(semanticPolicy({...value,maxCalls:undefined}).maxCalls,127);
});

test('submitted identity and epoch protect eight uncertain sources despite changed projection proofs without asserting equivalence',async()=>{
 const s=setup({count:499}),seed=await seedSyntheticDomainOwner({curator:s.curator,activate:false}),origin=clone(seed.originJob),b=origin.data.batch;
 for(const pin of b.binding.pins){pin.semanticProofHash=semanticHash('synthetic historical v1 '+pin.id);pin.editorialHash=semanticHash('synthetic historical editorial '+pin.id);pin.sourceProjectionVersion='synthetic-historical-v1';}b.bindingHash=semanticHash(b.binding);
 const r=await records(s),taxonomy=(await s.store.get('settings/reels_v2_taxonomy')).data,first=(await s.curator.scan('semantic_result')).find(row=>row.data.binding.jobId===origin.data.id),histories=[{job:origin,results:[first],recoveries:[]}];
 const prepare=histories=>prepareSemanticDomainManifest({records:r,taxonomy,histories,historyCoverageConfirmed:true,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now}),manifest=prepare(histories);
 assert.equal(manifest.sources.filter(r=>r.state==='retained_applied').length,8);assert.equal(manifest.sources.filter(r=>r.state==='protected_uncertain').length,8);assert.equal(manifest.sources.filter(r=>r.state==='eligible').length,483);
 for(const row of manifest.sources.filter(r=>r.state==='protected_uncertain')){const ref=row.historicalRefs.find(r=>r.state==='protected_attempt');assert.equal(ref.basis,'submitted_identity_and_source_epoch');assert.equal(ref.equivalenceUnproven,true);assert.notEqual(ref.submittedSemanticProofHash,ref.currentSemanticProofHash);}
 assert.ok(manifest.domains.every(d=>d.measurementBatches.every(b=>b.pins===undefined&&typeof b.pinsHash==='string')));assert.equal(semanticDomainManifestValid(manifest),true);
 const size=measureSemanticDomainManifestStorage(manifest);assert.equal(size.withinLimit,true);assert.ok(size.nativeDocumentBytes<900000);assert.equal(size.compactJsonUtf8Bytes,Buffer.byteLength(JSON.stringify(manifest),'utf8'));
 for(const mutation of ['broken_hash','other_job','other_cursor','source_epoch','binding_epoch_only']){
  const changed=clone(histories);if(mutation==='broken_hash')changed[0].job.data.batch.bindingHash=semanticHash('broken');else if(mutation==='source_epoch')changed[0].job.data.batch.binding.pins[0].sourceVersions.video='2026-10-18T00:00:01.000Z';else if(mutation==='binding_epoch_only')changed[0].job.data.batch.binding.pins[0].sourceVersions={...changed[0].job.data.batch.binding.pins[0].sourceVersions,video:'2026-10-18T00:00:01.000Z'};else if(mutation==='other_job')changed[0].job.data.batch.binding.jobId=semanticHash('other-job');else changed[0].job.data.batch.binding.cursor=0;
  if(mutation!=='broken_hash')changed[0].job.data.batch.bindingHash=semanticHash(changed[0].job.data.batch.binding);
  const blocked=prepare(changed);assert.equal(blocked.sources.filter(r=>r.state==='protected_uncertain').length,0);assert.equal(blocked.sources.filter(r=>r.state==='historical_coverage_unconfirmed').length,8);assert.equal(blocked.sources.filter(r=>r.state==='eligible').length,483);
 }

 const changedRecords=clone(r),changedId=b.binding.pins[0].id,record=changedRecords.find(row=>row.source.id===changedId);record.source.sourceVersions={...record.source.sourceVersions,video:'2026-10-18T00:00:02.000Z'};
 const drifted=prepareSemanticDomainManifest({records:changedRecords,taxonomy,histories,historyCoverageConfirmed:true,prepareRequest:prepareSemanticProviderRequest,observedAt:s.now});
 assert.equal(drifted.sources.filter(row=>row.state==='protected_uncertain').length,7);assert.equal(drifted.sources.filter(row=>row.state==='historical_coverage_unconfirmed').length,1);assert.equal(drifted.sources.filter(row=>row.state==='eligible').length,483);assert.equal(drifted.sources.find(row=>row.id===changedId).state,'historical_coverage_unconfirmed');assert.equal(drifted.domains.some(d=>d.eligibleIds.includes(changedId)),false);
 const beforeFactory=semanticHash([...s.store.docs]),coordinator=await s.store.get('reels_index/semantic_coordinator'),factoryInput={manifest:drifted,originJob:origin,originLedger:seed.originLedger,coordinator:{path:'reels_index/semantic_coordinator',...coordinator,readTime:s.now},queue:{name:'projects/synthetic-ci/locations/us-central1/queues/v0-curation',state:'PAUSED',taskCount:0,complete:true,readTime:s.now},ownerApproval:seed.plan.authority.approval,now:s.now};
 assert.throws(()=>prepareOwnerDomainQuarantine(factoryInput),{code:'DOMAIN_QUARANTINE_SOURCE_OR_INTENT_INVALID'});assert.equal(semanticHash([...s.store.docs]),beforeFactory);assert.equal(s.fixture.calls.length,0);
 const corrupted=clone(histories);corrupted[0].job.data.batch.binding.pins[0].sourceVersions.video='2026-10-18T00:00:03.000Z';corrupted[0].job.data.batch.bindingHash=semanticHash(corrupted[0].job.data.batch.binding);const corruptManifest=prepare(corrupted);
 assert.notEqual(corrupted[0].job.data.cohortHash,semanticHash(corrupted[0].job.data.pins));assert.equal(corruptManifest.sources.filter(row=>row.state==='protected_uncertain').length,0);assert.equal(corruptManifest.sources.filter(row=>row.state==='historical_coverage_unconfirmed').length,8);assert.throws(()=>prepareOwnerDomainQuarantine({...factoryInput,manifest:corruptManifest,originJob:corrupted[0].job}),{code:'DOMAIN_QUARANTINE_SOURCE_OR_INTENT_INVALID'});assert.equal(semanticHash([...s.store.docs]),beforeFactory);
 const oversized=clone(manifest);oversized.limits.push('x'.repeat(950000));delete oversized.manifestHash;oversized.manifestHash=semanticHash(oversized);assert.equal(measureSemanticDomainManifestStorage(oversized).withinLimit,false);assert.equal(semanticDomainManifestValid(oversized),false);assert.equal(s.fixture.calls.length,0);
});
test('the complete owner quarantine plan uses unique epoch checks through the real Firestore transaction adapter',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator,activate:false}),plan=seed.plan,project='megabrain-v0-1017370021431',prefix='projects/'+project+'/databases/(default)/documents/',root='https://firestore.googleapis.com/v1/'+prefix.slice(0,-1),calls=[];
 assert.equal(new Set(plan.checks.map(c=>c.path)).size,plan.checks.length);assert.ok(plan.checks.some(c=>c.path==='settings/reels_v2_semantic_domain_plan')===false);
 // The actual create/intent adds the manifest epoch to the same adapter checks.
 const checks=[...plan.checks,{path:'settings/reels_v2_semantic_domain_plan',updateTime:s.fixture.at}],expected=new Map(checks.map(c=>[prefix+c.path,c.updateTime]));
 const api={project,async request(url,o={}){calls.push({url,input:clone(o)});if(url===root+':beginTransaction')return {transaction:'synthetic-domain-owner-tx'};if(url===root+':batchGet'){assert.equal(o.json.transaction,'synthetic-domain-owner-tx');return o.json.documents.map(name=>expected.get(name)===null?{missing:name}:{found:{name,updateTime:expected.get(name)}});}if(url===root+':commit'){assert.equal(o.json.transaction,'synthetic-domain-owner-tx');assert.deepEqual(o.json.writes.map(w=>w.update.name),plan.writes.map(w=>prefix+w.path));return {writeResults:plan.writes.map(()=>({updateTime:'synthetic-new-version'}))};}if(url===root+':rollback')return {};throw Error('Unexpected fake endpoint');}},store=new Firestore(api);store.metadataWrite=(url,o)=>api.request(url,o);
 assert.equal((await store.commitSemantic({checks,writes:plan.writes})).applied,true);assert.equal(calls.filter(c=>c.url.endsWith(':commit')).length,1);assert.equal(s.fixture.calls.length,0);
 assert.deepEqual(uniqueDomainAuthorityChecks([{path:'videos/QaEpoch',updateTime:'same'},{path:'videos/QaEpoch',updateTime:'same'}]),[{path:'videos/QaEpoch',updateTime:'same'}]);
 assert.throws(()=>uniqueDomainAuthorityChecks([{path:'videos/QaEpoch',updateTime:'old'},{path:'videos/QaEpoch',updateTime:'new'}]),{code:'DOMAIN_QUARANTINE_CONFLICTING_EPOCHS'});
 const blocked={checks:[...checks,{path:'settings/not_a_domain_plan',updateTime:null}],writes:plan.writes},before=calls.length;await assert.rejects(()=>store.commitSemantic(blocked));assert.equal(calls.length,before);
});

test('compact executable batches rehydrate only the unique sealed source pins and reject tampered IDs, epochs or proof hashes',async()=>{
 const s=setup(),seed=await seedSyntheticDomainOwner({curator:s.curator}),manifest=seed.manifest;
 for(const domain of manifest.domains)for(const b of domain.batches){assert.equal(b.pins,undefined);const pins=semanticDomainBatchPins(manifest,b);assert.equal(semanticHash(pins),b.pinsHash);assert.deepEqual(pins.map(p=>p.id),b.sourceIds);}
 const preview=await s.curator.preview({domainId:'food'}),created=await s.curator.create({selection:{domainId:'food'},previewHash:preview.previewHash,idempotencyKey:'synthetic-compact-runtime'}),job=(await s.store.get('reels_index/semantic_job_'+created.job.id)).data;
 for(const b of job.domainCuration.batches){assert.equal(semanticHash(b.pins),b.pinsHash);assert.deepEqual(b.pins,semanticDomainBatchPins(manifest,manifest.domains.find(d=>d.id==='food').batches.find(x=>x.id===b.id)));}
 for(const mutation of ['pins_hash','source_epoch','source_proof','duplicate_id']){
  const altered=clone(manifest),b=altered.domains.find(d=>d.id==='food').batches[0],source=altered.sources.find(s=>s.id===b.sourceIds[0]);
  if(mutation==='pins_hash')b.pinsHash=semanticHash('wrong');else if(mutation==='source_epoch')source.sourceVersions.video='2026-10-18T00:00:01.000Z';else if(mutation==='source_proof')source.semanticProofHash=semanticHash('changed');else b.sourceIds.push(b.sourceIds[0]);
  delete altered.manifestHash;altered.manifestHash=semanticHash(altered);assert.equal(semanticDomainManifestValid(altered),false);assert.throws(()=>semanticDomainBatchPins(altered,b),{code:'DOMAIN_BATCH_PIN_HASH_INVALID'});
 }
 assert.equal(s.fixture.calls.length,0);
});

