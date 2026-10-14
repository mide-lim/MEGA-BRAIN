import test from 'node:test';import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {encodeFields,decodeFields} from '../lib/firestore.mjs';
import {terminalSourceFailure} from '../lib/source-hold.mjs';
const now=Date.parse('2026-10-14T03:00:00Z'),vid='Failed_Reel_1';
const diag={phase:'metadata',cause:'unknown',exit_code:1};
function fixture({enabled=true,download=diag,absent=true,proofFailure=false,otherPause=false,conflict=false,lostReceipt=false}={}){
 const ids=[vid,...Array.from({length:261},(_,i)=>`Reel_${i.toString().padStart(3,'0')}`)];
 const state={...newLedger(),paused:false,allocation_cents:170000,remaining_credit_cents:170000,coverage_verified:true,balance_observed_at:new Date(now).toISOString(),credit_expires_at:'2026-11-23T00:00:00Z',ongoing_commitment_cents:100,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:'2026-11-03T00:00:00Z',enabled_stages:{upload:true,transcription:true,analysis:true},batch:{schema_version:1,id:'pilot_30_oct12',status:'active',video_ids:ids,budget_cents:120000,overhead_cents:2400,parallelism:4,active_video_ids:[]}};
 const docs=new Map([['settings/financial',{data:state,updateTime:1}],['settings/automation',{data:{enabled:true,parallelism:4},updateTime:1}],[`videos/${vid}`,{data:{id:vid,status:'pending',media_verified:false,video_key:null,analysis:null},updateTime:1}]]);
 let rejected=false;
 const store={async get(p){const d=docs.get(p);return d?structuredClone(d):null;},async create(p,data){if(proofFailure&&p.startsWith('analyses/source_hold_'))throw Error('audit failure');if(docs.has(p))return {created:false};docs.set(p,{data:decodeFields(encodeFields(data)),updateTime:1});return {created:true};},async patch(p,data,{updateTime}){const d=docs.get(p);if(d.updateTime!==updateTime)throw Object.assign(Error(),{status:412});if(conflict&&!rejected&&p==='settings/financial'&&data.spent_cents===50){rejected=true;throw Object.assign(Error(),{status:412});}docs.set(p,{data:{...d.data,...decodeFields(encodeFields(data))},updateTime:d.updateTime+1});if(lostReceipt&&p==='settings/financial'&&data.spent_cents===50)throw Error('receipt lost after commit');}};
 let uploads=0,proofs=0;
 const operations={async upload(){uploads++;if(otherPause)docs.get('settings/financial').data.paused=true;throw Object.assign(Error('private credential-bearing output'),{code:1,operation_step:'download_media',download_diagnostic:download});},async sourceFailureMediaAbsent(){proofs++;if(absent instanceof Error)throw absent;return absent;}};
 const flow=new WorkerFlow({store,ledger:new FinancialLedger(store,{clock:()=>now}),operations,quotes:{upload:50},eligibleVideos:ids,analysisRevision:'megabrain-video-text-v4',batchId:'pilot_30_oct12',autoHoldTerminalSources:enabled,clock:()=>now});
 return {flow,docs,store,get uploads(){return uploads;},get proofs(){return proofs;}};
}
test('opt-in terminal source hold records user verdict and full coverage, preserves uncertain claim and prevents replay',async()=>{
 const f=fixture({conflict:true});const r=await f.flow.run({videoId:vid,stage:'upload'});assert.equal(r.status,'source_held');
 const financial=f.docs.get('settings/financial').data;assert.equal(financial.spent_cents,50);assert.equal(financial.reserved_cents,0);assert.equal(financial.paused,false);assert.deepEqual(financial.batch.active_video_ids,[]);
 const claim=f.docs.get(`jobs/${executionId(vid,'upload')}`).data;assert.equal(claim.status,'uncertain');assert.equal(claim.failure_diagnostic.operation_step,'download_media');assert.equal(claim.source_hold_proof.media_absent,true);
 const review=f.docs.get(`analyses/ig_error_${vid}`).data;assert.equal(review.review_status,'awaiting_user_verdict');assert.equal(review.private_or_deleted_not_confirmed,true);assert.equal(review.events.length,1);
 assert.equal(f.docs.get(`videos/${vid}`).data.status,'needs_attention');assert.doesNotMatch(JSON.stringify([...f.docs]),/private credential/);
 assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).duplicate,true);assert.equal(f.uploads,1);
});
test('default disabled retains old global pause and reserved maximum',async()=>{
 const f=fixture({enabled:false});assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'uncertain');
 const s=f.docs.get('settings/financial').data;assert.equal(s.paused,true);assert.equal(s.reserved_cents,50);assert.equal(s.spent_cents,0);assert.equal(f.proofs,0);assert.equal(f.docs.has(`analyses/ig_error_${vid}`),false);
});
test('rate limit, login, network, timeout, transfer and local IO are never source exceptions',async()=>{
 for(const d of [{...diag,cause:'http_403'},{...diag,cause:'http_429'},{...diag,cause:'login_required'},{...diag,cause:'network_error'},{...diag,cause:'timeout'},{...diag,cause:'local_io'},{...diag,phase:'transfer'}]){
  const f=fixture({download:d});assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'uncertain');assert.equal(f.docs.get('settings/financial').data.paused,true);assert.equal(f.docs.get('settings/financial').data.reserved_cents,50);assert.equal(f.proofs,0);
 }
 assert.equal(terminalSourceFailure({operation_step:'submit_analysis',tool_code:1,http_status:null,download:diag}),false);
 assert.equal(terminalSourceFailure({operation_step:'download_media',tool_code:1,http_status:401,download:diag}),false);
 assert.equal(terminalSourceFailure({operation_step:'download_media',tool_code:1,http_status:null,download:{phase:'format_selection',cause:'format_unavailable',exit_code:1}}),true);
});
test('existing media, failed absence read or failed audit keeps full reserve and global pause',async()=>{
 for(const options of [{absent:false},{absent:Error('storage permission denied')},{proofFailure:true}]){
  const f=fixture(options);assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'uncertain');const s=f.docs.get('settings/financial').data;assert.equal(s.paused,true);assert.equal(s.reserved_cents,50);assert.equal(s.spent_cents,0);
 }
});
test('holding one source never resumes a pause raised by a different operation',async()=>{
 const f=fixture({otherPause:true});assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'source_held');assert.equal(f.docs.get('settings/financial').data.paused,true);assert.equal(f.docs.get('settings/financial').data.spent_cents,50);
});
test('ledger rejects terminal settlement without prior source proof and recorded verdict',async()=>{
 const f=fixture();await f.flow.run({videoId:vid,stage:'upload'});
 const id=executionId(vid,'upload');const raw=f.docs.get('settings/financial');raw.data.jobs[id].status='started';raw.data.reserved_cents=50;raw.data.spent_cents=0;raw.data.remaining_credit_cents=170000;raw.data.batch.active_video_ids=[vid];
 f.docs.delete(`analyses/source_hold_${id}`);
 await assert.rejects(new FinancialLedger(f.store,{clock:()=>now}).settleTerminalSourceFailure(id),/Prova/);
 assert.equal(raw.data.reserved_cents,50);
});

test('lost accounting receipt after commit pauses globally without charging twice or replaying',async()=>{
 const f=fixture({lostReceipt:true});assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'uncertain');
 const s=f.docs.get('settings/financial').data;assert.equal(s.paused,true);assert.equal(s.spent_cents,50);assert.equal(s.reserved_cents,0);
 assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).duplicate,true);assert.equal(f.uploads,1);
});

test('source case keeps previous owner verdict and diagnostic history for the new recorded failure',async()=>{
 const f=fixture();const path=`analyses/ig_error_${vid}`;f.docs.set(path,{data:{user_verdict:'owner_requested_review',events:[{event_id:'previous',diagnostic:{cause:'prior'}}],owner_note:'preserve'},updateTime:1});
 assert.equal((await f.flow.run({videoId:vid,stage:'upload'})).status,'source_held');
 const review=f.docs.get(path).data;assert.equal(review.user_verdict,'owner_requested_review');assert.equal(review.owner_note,'preserve');assert.equal(review.events.length,2);
 const audit=f.docs.get(`analyses/source_hold_${executionId(vid,'upload')}`).data;assert.equal(audit.previous_review.user_verdict,'owner_requested_review');assert.equal(audit.provider_inference_submitted,false);
});
