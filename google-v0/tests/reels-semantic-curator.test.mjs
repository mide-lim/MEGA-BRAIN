import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator,loadLiveContextCatalogue} from '../lib/reels-semantic-curator.mjs';
import {ReelsSemanticDispatcher} from '../lib/reels-semantic-dispatcher.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {semanticHash} from '../lib/reels-semantic-source.mjs';
import {makeSemanticFixture} from './reels-semantic-fixture.mjs';
function setup(){const fixture=makeSemanticFixture(),store=memoryReelsStore();for(const r of fixture.documents)store.docs.set(r.path,{data:structuredClone(r.data),updateTime:r.updateTime});const repository=new ReelsRepository({store,cacheTtlMs:0}),deliveries=[],curator=new ReelsSemanticCurator({repository,provider:fixture.provider,enqueue:async j=>{deliveries.push(j);return {status:'sent'};}});return {fixture,store,repository,deliveries,curator};}
async function start(s){const p=await s.curator.preview({all:true});return s.curator.create({selection:{all:true},previewHash:p.previewHash,idempotencyKey:'unit-job-unique-001'});}
async function pump(s){let n=0;while(s.deliveries.length){assert.ok(++n<100);const j=s.deliveries.shift();await s.curator.runDelivery({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId});}}
test('autonomous durable phases preserve sources and publish exactly approved unique members',async()=>{
 const s=setup(),before=[...s.store.docs].filter(([p])=>p.startsWith('videos/')||p.startsWith('reels_legacy_content/'));
 const created=await start(s);await pump(s);const view=await s.curator.overview();assert.equal(view.jobs[0].status,'completed');assert.equal(s.fixture.calls.length,7);assert.equal(view.coverage.evaluated,5);assert.equal(view.groups.length,1);assert.equal(view.groups[0].status,'candidate');
 const g=view.groups[0];await s.curator.command({action:'group_approve',groupId:g.id,revision:g.revision,idempotencyKey:'unit-approve-unique'});
 assert.deepEqual((await s.repository.list({workspace:'library',category:'semantic_'+g.id})).items.map(i=>i.id).sort(),s.fixture.expected.memberIds);
 const count=s.fixture.calls.length;await s.curator.overview();await s.curator.detail(g.id);await s.curator.create({selection:{all:true},previewHash:(await s.curator.preview({all:true})).previewHash,idempotencyKey:'unit-job-unique-001'});await pump(s);assert.equal(s.fixture.calls.length,count);
 assert.deepEqual([...s.store.docs].filter(([p])=>p.startsWith('videos/')||p.startsWith('reels_legacy_content/')),before);
 const newPreview=await s.curator.preview({all:true});await assert.rejects(()=>s.curator.create({selection:{all:true},previewHash:newPreview.previewHash,idempotencyKey:'new-key-same-authorization'}),{code:'SEMANTIC_JOB_ALREADY_EXISTS'});
 assert.equal(created.created,true);
});
test('paid ambiguous outcome becomes uncertain and never resubmits even after lease expiry',async()=>{
 const s=setup();s.curator.provider={infer:async()=>{s.fixture.calls.push('paid');throw Error('network acknowledgement lost');}};
 await start(s);await pump(s);const v=await s.curator.overview();assert.equal(v.jobs[0].status,'uncertain');assert.equal(s.fixture.calls.length,1);
 const j=(await s.store.get('reels_index/semantic_job_'+v.jobs[0].id)).data;await s.curator.runDelivery({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId});assert.equal(s.fixture.calls.length,1);
 await assert.rejects(()=>s.curator.command({action:'reconcile_saved',jobId:j.id}),{code:'SEMANTIC_RESULT_NOT_RECEIVED'});
});
test('incomplete paid envelope is persisted before validation and not regenerated',async()=>{
 const s=setup();s.curator.provider={infer:async()=>{s.fixture.calls.push('paid');return {rawResponse:{candidates:[{finishReason:'MAX_TOKENS'}]},model:s.fixture.policy.model,phase:'extract'};}};
 await start(s);await pump(s);assert.equal((await s.curator.overview()).jobs[0].status,'failed');assert.equal(s.fixture.calls.length,1);assert.equal([...s.store.docs.values()].filter(r=>r.data.kind==='semantic_result').length,1);assert.ok([...s.store.docs.values()].some(r=>r.data.kind==='semantic_raw'));
});
test('manual child inherits context and parent membership is unique; suppression invalidates derivative immediately',async()=>{
 const s=setup();await start(s);await pump(s);let g=(await s.curator.overview()).groups[0];await s.curator.command({action:'group_approve',groupId:g.id,revision:g.revision,idempotencyKey:'unit-approve-parent'});
 let child=(await s.curator.command({action:'group_create',name:'Filho manual',parentId:g.id,definition:'Decisão editorial explícita.',idempotencyKey:'unit-create-child'})).group;
 assert.equal(child.context,'recipe');child=(await s.curator.command({action:'group_assign',groupId:child.id,revision:child.revision,reelIds:['QaFull_unknown'],idempotencyKey:'unit-assign-child'})).group;
 assert.equal((await s.repository.list({workspace:'library',category:'semantic_'+g.id})).total,3);
 const taxonomy=await s.store.get('settings/reels_v2_taxonomy');await s.store.patch('settings/reels_v2_taxonomy',{contextualSuppression:{dimensions:['ingredient']}},{updateTime:taxonomy.updateTime});
 assert.equal((await s.repository.list({workspace:'library',category:'semantic_'+g.id})).total,0);assert.equal((await loadLiveContextCatalogue(s.repository)).state,'stale');
});
test('dedicated dispatcher verifies exact OIDC task on ambiguous metadata create without touching stage queues',async()=>{
 let task,reads=0;const api={project:'megabrain-v0-1017370021431',request:async(url,o={})=>{assert.ok(url.includes('/queues/v0-curation/'));if(o.method==='POST'){task=o.json.task;throw Error('ack lost');}reads++;return task;}},d=new ReelsSemanticDispatcher({api,workerOrigin:'https://megabrain-v0-analysis-711042421394.us-central1.run.app'}),id='a'.repeat(64),job={id,dispatch:{sequence:0,outboxId:semanticHash({jobId:id,sequence:0})}};
 assert.equal((await d.enqueue(job)).status,'sent');assert.equal(reads,1);assert.equal(task.dispatchDeadline,'600s');assert.ok(task.httpRequest.url.endsWith('/tasks/curation'));assert.deepEqual(Object.keys(JSON.parse(Buffer.from(task.httpRequest.body,'base64'))).sort(),['jobId','outboxId','sequence']);
});
test('closed Reel processing permits only separately authorized semantic delivery on analysis worker',async()=>{
 const id='b'.repeat(64),outboxId=semanticHash({jobId:id,sequence:0}),calls=[],runtime=reelsGoogleRuntime({project:'megabrain-v0-1017370021431',reels_processing_enabled:false},null,{stage:'analysis',authorize:async r=>r.headers.get('authorization')==='Bearer synthetic',dependencies:{semantic:{runDelivery:async x=>{calls.push(x);return {job:{status:'completed'}};}}}});
 assert.equal((await runtime(new Request('https://worker/tasks/run',{method:'POST'}))).status,423);
 assert.equal((await runtime(new Request('https://worker/tasks/curation',{method:'POST',body:JSON.stringify({jobId:id,sequence:0,outboxId})}))).status,401);
 const request=body=>new Request('https://worker/tasks/curation',{method:'POST',headers:{authorization:'Bearer synthetic'},body:JSON.stringify(body)});
 assert.equal((await runtime(request({jobId:id,sequence:0,outboxId,videoId:'bad'}))).status,400);assert.equal(calls.length,0);
 assert.equal((await runtime(request({jobId:id,sequence:0,outboxId}))).status,200);assert.equal(calls.length,1);assert.equal(calls[0].maxBatches,3);
});
