import test from 'node:test';import assert from 'node:assert/strict';
import {FinancialLedger,newLedger,reservationDecision}from '../lib/financial-ledger.mjs';
const now=Date.parse('2026-10-03T18:00:00Z');
function ready(){return {...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:'2026-11-23T00:00:00Z',enabled_stages:{upload:true,analysis:true,transcription:true}};}
function store(data){let version=1;return {get:async()=>({data:structuredClone(data),updateTime:String(version)}),patch:async(_p,changes,{updateTime})=>{if(updateTime!==String(version)){const e=new Error('Conflict');e.status=412;throw e;}data={...data,...structuredClone(changes)};version++;return {data:structuredClone(data),updateTime:String(version)};}};}
const reservation={executionId:'run1',videoId:'video1',stage:'analysis',maximumCents:100};
test('concurrent reservations cannot spend the same remaining balance',async()=>{
 const db=store({...ready(),allocation_cents:25100});const ledger=new FinancialLedger(db,{clock:()=>now});
 const results=await Promise.allSettled([ledger.reserve(reservation),ledger.reserve({...reservation,executionId:'run2',videoId:'video2'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await db.get()).data.reserved_cents,100);
});
test('missing or stale account-wide balance and unknown coverage fail closed',()=>{
 for(const change of [{balance_observed_at:null},{balance_observed_at:new Date(now-3601000).toISOString()},{coverage_verified:false},{credit_expires_at:new Date(now+3600000).toISOString()}])assert.equal(reservationDecision({...ready(),...change},{now,maximumCents:100,stage:'analysis'}).ready,false);
});
test('uncertain paid outcome preserves reservation, pauses and prevents replay',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(reservation);await ledger.transition('run1','start');await ledger.transition('run1','uncertain');
 assert.equal((await db.get()).data.reserved_cents,100);assert.equal((await db.get()).data.paused,true);
 await assert.rejects(ledger.transition('run1','cancel'));await assert.rejects(ledger.transition('run1','start'));await assert.rejects(ledger.reserve({...reservation,executionId:'run2'}));
});
test('a pause after reservation prevents starting and permits releasing unstarted work',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(reservation);const snapshot=await db.get();await db.patch('',{paused:true},{updateTime:snapshot.updateTime});
 await assert.rejects(ledger.transition('run1','start'));await ledger.transition('run1','cancel');assert.equal((await db.get()).data.reserved_cents,0);
});
test('settlement accounts once and pauses if estimate was exceeded',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(reservation);await ledger.transition('run1','start');await ledger.transition('run1','complete',{actualCents:120});
 const {data}=await db.get();assert.equal(data.spent_cents,120);assert.equal(data.remaining_credit_cents,172291);assert.equal(data.reserved_cents,0);assert.equal(data.paused,true);await assert.rejects(ledger.transition('run1','complete',{actualCents:120}));
});
test('tampered reservations and fractional currency cannot authorize a call',()=>{
 assert.throws(()=>reservationDecision({...ready(),reserved_cents:99},{now,maximumCents:1,stage:'upload'}));
 assert.equal(reservationDecision(ready(),{now,maximumCents:.1,stage:'upload'}).ready,false);
});

test('a smaller pilot envelope includes spent, open reserves and persistent costs without consuming the account safety reserve',()=>{
 const state={...ready(),pilot_envelope_cents:15000,spent_cents:8000,ongoing_commitment_cents:6600};
 assert.equal(reservationDecision(state,{now,maximumCents:400,stage:'analysis'}).ready,true);
 assert.equal(reservationDecision(state,{now,maximumCents:401,stage:'analysis'}).ready,false);
 assert.throws(()=>reservationDecision({...state,pilot_envelope_cents:150001},{now,maximumCents:1,stage:'analysis'}));
});

test('persistent commitments are recorded conditionally and block new reserves when absent or unaffordable',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});
 const estimates={storageBytes:10*1073741824,storageCentsPerGiBMonth:15,daysUntilCleanup:30,serviceOperationsCents:100,transferCents:200,cleanupCents:50};
 await ledger.recordOngoingCosts(estimates);assert.equal((await db.get()).data.ongoing_commitment_cents,500);
 assert.equal(reservationDecision({...ready(),ongoing_costs_observed_at:null},{now,stage:'analysis',maximumCents:1}).ready,false);
 assert.equal(reservationDecision({...ready(),allocation_cents:25100,ongoing_commitment_cents:101},{now,stage:'analysis',maximumCents:1}).ready,false);
 await assert.rejects(ledger.recordOngoingCosts({...estimates,daysUntilCleanup:100}));
});

test('new analysis revision permits one deliberate reanalysis while blocking replay and uncertain previous work',async()=>{
 const db=store(ready()),ledger=new FinancialLedger(db,{clock:()=>now});await ledger.reserve(reservation);await ledger.transition('run1','start');await ledger.transition('run1','complete',{actualCents:100});
 const revised={...reservation,executionId:'knowledge_v3_run1',analysisRevision:'megabrain-video-text-v3'};
 await ledger.reserve(revised);await ledger.transition(revised.executionId,'start');await ledger.transition(revised.executionId,'complete',{actualCents:100});
 await assert.rejects(ledger.reserve({...revised,executionId:'knowledge_v3_run2'}));
 await assert.rejects(ledger.reserve({...revised,executionId:'invalid',stage:'transcription'}));
 const blocked=store({...ready(),jobs:{run1:{video_id:'video1',stage:'analysis',maximum_cents:100,status:'uncertain'}},reserved_cents:100});
 await assert.rejects(new FinancialLedger(blocked,{clock:()=>now}).reserve(revised));
});
