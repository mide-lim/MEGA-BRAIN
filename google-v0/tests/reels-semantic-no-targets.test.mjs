import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {makeSemanticFixture,semanticUnknownProvider} from './reels-semantic-fixture.mjs';
import {semanticHash,semanticPolicyPath} from '../lib/reels-semantic-source.mjs';
async function setup({count=5}={}){
 const fixture=makeSemanticFixture(),store=memoryReelsStore();for(const r of fixture.documents)store.docs.set(r.path,{data:structuredClone(r.data),updateTime:r.updateTime});
 if(count!==5){for(const p of [...store.docs.keys()])if(p.startsWith('videos/')||p.startsWith('reels_legacy_content/'))store.docs.delete(p);const row=fixture.documents.find(r=>r.path==='videos/QaFull_single');for(let i=0;i<count;i++){const id='QaEmpty_'+String(i).padStart(3,'0'),video={...structuredClone(row.data),id,analysis_key:'saved/'+id+'.json'};store.docs.set('videos/'+id,{data:video,updateTime:row.updateTime});}}
 const repository=new ReelsRepository({store,cacheTtlMs:0}),provider=semanticUnknownProvider(),curator=new ReelsSemanticCurator({repository,provider});
 const inventory=await curator.inventory(),pins=inventory.inventory.map(r=>({id:r.id,sourceVersions:r.sourceVersions})).sort((a,b)=>a.id.localeCompare(b.id)),p=await store.get(semanticPolicyPath);
 await store.patch(semanticPolicyPath,{batchSize:count===5?2:8,maxCalls:127,maxSources:499,authorizedCohortHash:semanticHash(pins)},{updateTime:p.updateTime});
 const preview=await curator.preview({all:true}),created=await curator.create({selection:{all:true},previewHash:preview.previewHash,idempotencyKey:'empty-targets-'+count});
 return {fixture,store,repository,provider,curator,id:created.job.id};
}
const read=s=>s.store.get('reels_index/semantic_job_'+s.id);
async function step(s,maxBatches=1){const j=(await read(s)).data;return s.curator.runDelivery({jobId:s.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches});}
async function toVerify(s){for(let n=0;n<70;n++){const j=(await read(s)).data;if(j.phase==='verify')return;assert.notEqual(j.status,'uncertain');assert.notEqual(j.status,'paused');await step(s);}throw Error('Fixture did not reach verify.');}
function receipts(s){return [...s.store.docs.values()].filter(r=>r.data.kind==='semantic_no_targets').map(r=>r.data);}
test('empty verification records exact fresh ranges without provider verdicts, source changes or extra calls',async()=>{
 const s=await setup(),before=new Map([...s.store.docs].filter(([p])=>p.startsWith('videos/')||p.startsWith('reels_legacy_content/')).map(([p,r])=>[p,semanticHash(r)]));await toVerify(s);const j=(await read(s)).data,used=j.callsUsed,requests=s.provider.calls.length;
 await step(s,3);const final=(await read(s)).data,r=receipts(s);assert.equal(final.status,'completed');assert.equal(final.verifyCursor,5);assert.equal(final.callsUsed,used);assert.equal(s.provider.calls.length,requests);assert.equal(s.provider.calls.filter(c=>c.phase==='verify').length,0);
 assert.deepEqual(r.map(x=>[x.fromCursor,x.toCursor]),[[0,2],[2,4],[4,5]]);assert.deepEqual(r.flatMap(x=>x.sourceIds).sort(),final.pins.map(p=>p.id).sort());
 for(const row of r){assert.equal(row.reason,'NO_ELIGIBLE_VERIFICATION_TARGETS');assert.equal(row.providerCalls,0);assert.equal(row.targetCount,0);assert.equal(row.memberTargetCount,0);assert.equal(row.negativeTargetCount,0);assert.equal(row.semanticVerified,false);assert.equal(row.pinsHash,semanticHash(row.pins));assert.equal(row.groupVersionsHash,semanticHash(row.groupVersions));assert.equal(Object.hasOwn(row,'verdict'),false);}
 const view=(await s.curator.job(s.id)).job;assert.equal(view.verificationProcessed,5);assert.equal(view.verificationSkippedSources,5);assert.equal(view.verificationTargetDecisions,0);
 for(const [p,h]of before)assert.equal(semanticHash(await s.store.get(p)),h);
 const size=s.store.docs.size;await s.curator.runDelivery({jobId:s.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches:3});await step(s,3);assert.equal(s.store.docs.size,size);assert.equal(s.provider.calls.length,requests);assert.equal(receipts(s).length,3);
});
test('a member, negative, source or editorial change during the empty-range CAS cannot be skipped',async()=>{
 for(const change of ['member','negative','source','editorial']){
  const s=await setup();await toVerify(s);const job=(await read(s)).data,groupId='a'.repeat(64),path='reels_index/semantic_group_'+groupId;
  storeGroup(s,path,groupId);const original=s.store.commitSemantic;let raced=false;
  s.store.commitSemantic=async plan=>{if(!raced&&plan.writes.some(w=>w.data.kind==='semantic_no_targets')){raced=true;if(change==='source'){const p='videos/'+job.pins[0].id,r=await s.store.get(p);await s.store.patch(p,{source_epoch_revision:1},{updateTime:r.updateTime});}else if(change==='editorial'){const p='settings/reels_v2_taxonomy',r=await s.store.get(p);await s.store.patch(p,{contextualSuppression:{dimensions:['ingredient']}},{updateTime:r.updateTime});}else{const r=await s.store.get(path);await s.store.patch(path,change==='member'?{members:[{id:job.pins[0].id,role:'central'}]}:{negativeExamples:[{id:job.pins[0].id,reason:'New source-bound target.'}]},{updateTime:r.updateTime});}}return original(plan);};
  const calls=s.provider.calls.length;await step(s);assert.equal(raced,true);assert.equal((await read(s)).data.verifyCursor,0);assert.equal(receipts(s).length,0);assert.equal(s.provider.calls.length,calls);assert.equal((await read(s)).data.callsUsed,job.callsUsed);
 }
});
function storeGroup(s,path,id){s.store.docs.set(path,{data:{kind:'semantic_group',groupKind:'segment',id,key:'empty-group',name:'Grupo de teste',context:'general',definition:'A deterministic race fixture.',aliases:[],positiveCriteria:['A positive proposition.'],negativeCriteria:['A negative proposition.'],members:[],negativeExamples:[],status:'candidate',revision:1,manual:false,protected:false},updateTime:'2026-10-18T00:00:00.000Z'});}
test('499-source tail and exhausted127-attempt cap can finish genuinely empty verification with zero new inference',async()=>{
 const s=await setup({count:499});await toVerify(s);const before=(await read(s)),count=s.provider.calls.length;assert.equal(count,64);assert.equal(before.data.maxCalls,127);await s.store.patch('reels_index/semantic_job_'+s.id,{callsUsed:127},{updateTime:before.updateTime});
 for(let n=0;n<22;n++){const j=(await read(s)).data;if(j.status==='completed')break;await step(s,3);}
 const final=(await read(s)).data,r=receipts(s);assert.equal(final.status,'completed');assert.equal(final.verifyCursor,499);assert.equal(final.callsUsed,127);assert.equal(s.provider.calls.length,count);assert.equal(s.provider.calls.filter(c=>c.phase==='verify').length,0);assert.equal(r.length,63);assert.deepEqual([r.at(-1).fromCursor,r.at(-1).toCursor,r.at(-1).sourceIds.length],[496,499,3]);assert.equal(new Set(r.flatMap(x=>x.sourceIds)).size,499);assert.equal(final.noTargetVerification.sourceCount,499);assert.equal((await s.curator.job(s.id)).job.verificationTargetDecisions,0);
});
