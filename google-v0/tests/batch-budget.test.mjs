import test from 'node:test';
import assert from 'node:assert/strict';
import {newLedger,FinancialLedger,reservationDecision} from '../lib/financial-ledger.mjs';
import {prepareBatch,batchUsage,validateBatch} from '../lib/batch-budget.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {StorageCapacity} from '../lib/storage-capacity.mjs';
import {WorkerFlow} from '../lib/worker-flow.mjs';
const now=Date.parse('2026-10-12T18:00:00Z');
const ids=Array.from({length:30},(_,i)=>`new_video_${i}`);
function base(){return {...newLedger(),coverage_verified:true,remaining_credit_cents:140000,balance_observed_at:new Date(now).toISOString(),credit_expires_at:'2026-11-23T00:00:00Z',ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),ongoing_storage_planned_bytes:10737418240,enabled_stages:{upload:true,transcription:true,analysis:true}};}
function ready(){const state=base();return {...state,paused:false,batch:{...prepareBatch(state,{id:'batch30',videoIds:ids}),status:'active'}};}
function store(initial){let data=structuredClone(initial),version=0;return {async get(){return {data:structuredClone(data),updateTime:String(version)};},async patch(_path,changes,{updateTime}){if(updateTime!==String(version))throw Error('Conflict');data={...data,...structuredClone(changes)};version++;}};}
const request=(executionId='run1',videoId=ids[0],maximumCents=250)=>({executionId,videoId,maximumCents,stage:'analysis'});
test('prepare is paused, excludes old videos, fixes ceiling, and preserves old state',()=>{
 const state=base(),copy=structuredClone(state),b=prepareBatch(state,{id:'batch30',videoIds:ids});
 assert.equal(b.status,'paused');assert.equal(b.budget_cents,15000);assert.equal(b.overhead_cents,2400);assert.deepEqual(state,copy);
 assert.throws(()=>prepareBatch(state,{id:'batch30',videoIds:ids,existingVideoIds:[ids[1]]}));
 assert.throws(()=>prepareBatch({...state,batch:b},{id:'other',videoIds:ids}));
 for(const change of [{budget_cents:15001},{overhead_cents:-1},{video_ids:ids.slice(1)},{video_ids:[...ids.slice(1),ids[1]]}])assert.throws(()=>validateBatch({...b,...change}));
});
test('30 full new videos fit without resetting 97 historical jobs or uncertain reserves',async()=>{
 const state=base();state.jobs=Object.fromEntries(Array.from({length:97},(_,i)=>['old_'+i,{video_id:'old_video_'+i,stage:'analysis',maximum_cents:250,status:i<94?'completed':'uncertain',...(i<94?{actual_cents:250}:{})}]));
 state.spent_cents=23500;state.reserved_cents=750;const old=structuredClone(state.jobs);
 state.batch={...prepareBatch(state,{id:'batch30',videoIds:ids}),status:'active'};state.paused=false;
 const db=store(state),ledger=new FinancialLedger(db,{clock:()=>now});
 for(const [i,videoId] of ids.entries())for(const [stage,maximumCents] of [['upload',50],['transcription',120],['analysis',250]]){
  const executionId=`new_${i}_${stage}`;await ledger.reserve({executionId,videoId,stage,maximumCents});await ledger.transition(executionId,'start');await ledger.transition(executionId,'complete',{actualCents:maximumCents});
 }
 const final=(await db.get()).data;assert.equal(Object.keys(final.jobs).length,187);assert.equal(final.spent_cents,23500+12600);assert.equal(final.reserved_cents,750);
 for(const [key,value] of Object.entries(old))assert.deepEqual(final.jobs[key],value);
 assert.deepEqual(batchUsage(final),{spent_cents:12600,reserved_cents:0,overhead_cents:2400,available_cents:0,uncertain:false});
 await assert.rejects(ledger.reserve({...request('another'),analysisRevision:'megabrain-video-text-v4'}));
});
test('membership, fresh credit, single concurrency, cancellation and no replay are enforced',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});
 await assert.rejects(ledger.reserve(request('outside','outside_video')));
 const results=await Promise.allSettled([ledger.reserve(request()),ledger.reserve(request('run2',ids[1]))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(ledger.reserve(request('run3',ids[2])));
 await ledger.transition('run1','start');assert.equal((await workerReservationGate(db,{clock:()=>now})({executionId:'run1',stage:'analysis',videoId:ids[0]})).maximum_cents,250);
 await ledger.transition('run1','complete',{actualCents:200});await assert.rejects(ledger.transition('run1','complete',{actualCents:200}));
 await ledger.reserve(request('cancelled',ids[2]));await ledger.transition('cancelled','cancel');assert.equal(batchUsage((await db.get()).data).reserved_cents,0);
 const stale=ready();stale.balance_observed_at=null;assert.equal(reservationDecision(stale,{now,stage:'analysis',maximumCents:250,videoId:ids[0]}).ready,false);
});
test('batch ceiling includes in-flight reservations and protects overhead at exact boundary',async()=>{
 const state=ready();state.jobs.done={video_id:ids[0],stage:'analysis',batch_id:'batch30',maximum_cents:12500,status:'completed',actual_cents:12500};state.spent_cents=12500;
 const db=store(state),ledger=new FinancialLedger(db,{clock:()=>now});await assert.rejects(ledger.reserve(request('over',ids[1],101)));await ledger.reserve(request('edge',ids[1],100));
 assert.equal(batchUsage((await db.get()).data).available_cents,0);await ledger.transition('edge','start');await ledger.transition('edge','complete',{actualCents:100});assert.equal(batchUsage((await db.get()).data).available_cents,0);
});
test('uncertain batch blocks a different video even if an operator only unpauses global state',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(request());await ledger.transition('run1','start');await ledger.transition('run1','uncertain');
 const snapshot=await db.get();await db.patch('',{paused:false},{updateTime:snapshot.updateTime});await assert.rejects(ledger.reserve(request('other',ids[1])));await assert.rejects(ledger.transition('run1','cancel'));
 assert.equal(batchUsage((await db.get()).data).reserved_cents,250);
});
test('paused batch stops an already started provider call at the reservation gate',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(request());await ledger.transition('run1','start');
 const snapshot=await db.get();await db.patch('',{batch:{...snapshot.data.batch,status:'paused'}},{updateTime:snapshot.updateTime});
 await assert.rejects(workerReservationGate(db,{clock:()=>now})({executionId:'run1',stage:'analysis',videoId:ids[0]}));
});
test('capacity beyond old limit needs a valid batch and rejects unrelated new objects',async()=>{
 let financial=ready(),version=0;let capacity={schema_version:1,enabled:true,claim_limit:400,limit_bytes:10000000,admitted_bytes:2000,claims:Object.fromEntries(Array.from({length:200},(_,i)=>['old_'+i,{reserved_bytes:10,bytes:1,digest:'a'.repeat(64)}]))};
 const db={async get(path){return {data:structuredClone(path==='settings/financial'?financial:capacity),updateTime:String(version)};},async patch(_p,changes,{updateTime}){assert.equal(updateTime,String(version));capacity={...capacity,...changes};version++;}};
 const gate=new StorageCapacity(db),args={bucket:'megabrain-v0-1017370021431-media',key:`results/instagram/${ids[0]}/job/analysis.json`};
 await gate.reserveResult(args);assert.equal(Object.keys(capacity.claims).length,201);
 await gate.admit({...args,bytes:20,digest:'a'.repeat(64)});assert.equal(Object.keys(capacity.claims).length,201);
 await assert.rejects(gate.reserveResult({...args,key:'results/instagram/other_video/job/analysis.json'}));
 financial={...financial,batch:undefined};await assert.rejects(gate.reserveResult(args));
});
test('worker accepts 30 only with batch identity and blocks a mismatching active batch before operations',async()=>{
 const options={store:store(ready()),ledger:{},operations:{},quotes:{analysis:250},eligibleVideos:ids};
 assert.throws(()=>new WorkerFlow(options));const flow=new WorkerFlow({...options,batchId:'wrong_batch'});
 assert.equal((await flow.run({videoId:ids[0],stage:'analysis'})).reason,'outside_active_batch');
});

test('orphaned batch jobs and excessive document growth cannot silently reset the batch budget',()=>{
 const state=ready();state.jobs.bad={video_id:ids[0],stage:'analysis',batch_id:'another_batch',maximum_cents:250,status:'completed',actual_cents:250};
 assert.throws(()=>reservationDecision(state,{now,stage:'analysis',maximumCents:1,videoId:ids[0]}));
 const oversized={...ready(),unrelated_padding:'x'.repeat(600000)};assert.throws(()=>reservationDecision(oversized,{now,stage:'analysis',maximumCents:1,videoId:ids[0]}));
});

test('offline preparation preserves inputs, emits paused plan and refuses overwrite',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'megabrain-batch-test-'));
 try{
  const input={batch_id:'batch30',financial:base(),capacity:{schema_version:1,claims:{},admitted_bytes:0},existing_video_ids:Array.from({length:20},(_,i)=>'old_video_'+i),candidates:ids.map(id=>({id,url:`https://www.instagram.com/reel/${id}/`}))};
  const text=JSON.stringify(input),source=join(dir,'input.json'),destination=join(dir,'plan.json');await writeFile(source,text);
  const script=new URL('../scripts/prepare-batch.mjs',import.meta.url);
  execFileSync(process.execPath,[script.pathname,source,destination]);
  const plan=JSON.parse(await readFile(destination,'utf8'));assert.equal(plan.ready_for_execution,false);assert.equal(plan.batch.status,'paused');assert.equal(plan.planned_new_operations,90);assert.equal(plan.batch.budget_cents,15000);assert.equal(await readFile(source,'utf8'),text);
  assert.throws(()=>execFileSync(process.execPath,[script.pathname,source,destination],{stdio:'pipe'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
