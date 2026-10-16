import test from 'node:test';
import assert from 'node:assert/strict';
import {createPipelineScope,createAssistedScope} from '../lib/assisted-scope.mjs';
import {newLedger,FinancialLedger,reservationDecision} from '../lib/financial-ledger.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';

const NOW=Date.parse('2026-10-16T08:00:00Z'),videoId='Fresh_unit_budget',revision='megabrain-video-text-v4';
async function fixture({total=500,kind='assisted_pipeline'}={}){
 let now=NOW,version=0;
 const docs=new Map(),seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async patch(p,c,{updateTime}){assert.equal(docs.get(p)?.updateTime,updateTime);seed(p,{...docs.get(p).data,...c});return this.get(p);}};
 const path='jobs/assisted_upload_unit_budget_request_20261016',quotes={upload:100,transcription:135,analysis:total-235};
 const approval={schema_version:1,kind,status:'consumed',request_id:'unit_budget_request_20261016',authorization_ref:'MEG-109:owner-unit-five-reais',authorized_at:new Date(now-1000).toISOString(),consumed_at:new Date(now).toISOString(),expires_at:new Date(now+1800000).toISOString(),maximum_cents:kind==='assisted_upload'?100:total,task:{videoId,stage:'upload',poll:0},...(kind==='assisted_pipeline'?{stage_maximum_cents:quotes,analysis_revision:revision}:{})};
 seed(path,approval);
 const receipt=await store.get(path);
 const scope=kind==='assisted_pipeline'?await createPipelineScope({store,path,receipt,videoId,stage:'upload',quotes,analysisRevision:revision,now}):await createAssistedScope({store,path,receipt,now});
 const retained={old_upload:{video_id:'Old_upload',stage:'upload',maximum_cents:100,status:'uncertain'},old_analysis:{video_id:'Old_analysis',stage:'analysis',maximum_cents:1850,status:'uncertain'}};
 const state={...newLedger(),spent_cents:108200,reserved_cents:1950,jobs:retained,pilot_envelope_cents:120050,ongoing_commitment_cents:9400,paused:false,enabled_stages:{upload:true,transcription:true,analysis:true,media_access:false}};
 seed('settings/financial',state);
 const set=(p,c)=>seed(p,{...docs.get(p).data,...c});
 const decision=(s=docs.get('settings/financial').data,a=scope)=>reservationDecision(s,{now,maximumCents:100,stage:'upload',videoId,assistedScope:a});
 return {docs,store,set,state,scope,path,approval,quotes,decision,clock:()=>now,advance:ms=>now+=ms};
}
function accountReady(s){return {...s,coverage_verified:true,remaining_credit_cents:150000,balance_observed_at:new Date(NOW).toISOString(),balance_max_age_seconds:3600,credit_expires_at:new Date(NOW+30*86400000).toISOString(),ongoing_costs_observed_at:new Date(NOW).toISOString(),ongoing_costs_valid_until:new Date(NOW+86400000).toISOString()};}

test('private unit500 reserves/starts with original missing credit evidence; provider gate uses pilot envelope and retains old money',async()=>{
 const f=await fixture(),before=structuredClone(f.state),ledger=new FinancialLedger(f.store,{assistedScope:f.scope,clock:f.clock});
 assert.equal(f.decision().ready,true);
 await ledger.reserve({executionId:f.scope.executionId,videoId,stage:'upload',maximumCents:100});
 await ledger.transition(f.scope.executionId,'start');
 const gate=workerReservationGate(f.store,{assistedScope:f.scope,clock:f.clock});
 assert.deepEqual(await gate({executionId:f.scope.executionId,videoId,stage:'upload'}),{maximum_cents:100});
 const after=(await f.store.get('settings/financial')).data;
 assert.equal(after.reserved_cents,2050);assert.equal(after.spent_cents,before.spent_cents);
 for(const [id,j] of Object.entries(before.jobs))assert.deepEqual(after.jobs[id],j);
 for(const key of ['balance_observed_at','remaining_credit_cents','coverage_verified','credit_expires_at','ongoing_costs_observed_at','ongoing_commitment_cents','reserve_cents','allocation_cents'])assert.deepEqual(after[key],before[key]);
 assert.equal(after.jobs[f.scope.executionId].assisted_scope_kind,'pipeline_v1');
 assert.equal(after.jobs[f.scope.executionId].assisted_scope_total_cents,500);
});

test('all three unit stages use their own quotes inside the one approved500 envelope',async()=>{
 const f=await fixture(),receipt=await f.store.get(f.path);
 for(const stage of ['upload','transcription','analysis']){
  const scope=await createPipelineScope({store:f.store,path:f.path,receipt,videoId,stage,quotes:f.quotes,analysisRevision:revision,now:NOW});
  assert.equal(reservationDecision(f.state,{now:NOW,maximumCents:f.quotes[stage],stage,videoId,assistedScope:scope}).ready,true);
 }
});

test('unit may retain old observation and age setting without relabeling it as current balance',async()=>{
 const f=await fixture();
 for(const delta of [{balance_observed_at:'2026-10-01T00:00:00Z'},{balance_max_age_seconds:172800},{coverage_verified:false},{credit_expires_at:'2026-10-01T00:00:00Z'},{remaining_credit_cents:0},{ongoing_costs_observed_at:null,ongoing_costs_valid_until:null}]){
  const state={...f.state,...delta},copy=structuredClone(state);
  assert.equal(f.decision(state).ready,true);assert.deepEqual(state,copy);
 }
});

test('normal, legacy upload-only and pipeline501 retain original credit/account checks',async()=>{
 const unit=await fixture(),legacy=await fixture({kind:'assisted_upload'}),larger=await fixture({total:501});
 for(const [f,scope] of [[unit,null],[legacy,legacy.scope],[larger,larger.scope]]){
  const blocked=f.decision(f.state,scope);assert.equal(blocked.ready,false);assert.ok(blocked.reasons.some(s=>s.includes('Saldo financeiro')));
  assert.equal(f.decision(accountReady(f.state),scope).ready,true);
  assert.equal(f.decision({...accountReady(f.state),balance_max_age_seconds:172800},scope).ready,false);
  assert.equal(f.decision({...accountReady(f.state),remaining_credit_cents:0},scope).ready,false);
 }
});

test('unit requires explicit numeric envelope and counts spent, all held reserves and ongoing commitments',async()=>{
 const f=await fixture();
 for(const value of [undefined,null])assert.equal(f.decision({...f.state,pilot_envelope_cents:value}).ready,false);
 assert.throws(()=>f.decision({...f.state,pilot_envelope_cents:0}),/Orçamento do piloto/);
 assert.equal(f.decision({...f.state,pilot_envelope_cents:119649}).ready,false); // only99 available
 assert.equal(f.decision({...f.state,pilot_envelope_cents:119650}).ready,true);
 assert.equal(f.decision({...f.state,ongoing_commitment_cents:9901}).ready,false);
 assert.throws(()=>f.decision({...f.state,reserved_cents:0}),/reservas inconsistente/);
});

test('unit still refuses global pause, disabled stage, scope quote mismatch and forged authority',async()=>{
 const f=await fixture();
 assert.equal(f.decision({...f.state,paused:true}).ready,false);
 assert.equal(f.decision({...f.state,enabled_stages:{upload:false}}).ready,false);
 assert.throws(()=>reservationDecision(f.state,{now:NOW,maximumCents:99,stage:'upload',videoId,assistedScope:f.scope}),/Escopo assistido/);
 assert.throws(()=>f.decision(f.state,{...f.scope}),/Escopo assistido/);
 assert.throws(()=>f.decision({...f.state,pilot_envelope_cents:150001}),/Orçamento do piloto/);
});

test('expired private approval cannot mint authority for a new paid stage',async()=>{
 const f=await fixture();f.advance(1800000);const receipt=await f.store.get(f.path);
 await assert.rejects(createPipelineScope({store:f.store,path:f.path,receipt,videoId,stage:'analysis',quotes:f.quotes,analysisRevision:revision,now:f.clock()}),/expirada/);
});

test('private approval changed after minting cannot reserve or pass a provider gate',async()=>{
 const f=await fixture(),ledger=new FinancialLedger(f.store,{assistedScope:f.scope,clock:f.clock});
 f.set(f.path,{maximum_cents:499});
 await assert.rejects(ledger.reserve({executionId:f.scope.executionId,videoId,stage:'upload',maximumCents:100}),/Autorização unitária alterada/);
 const other=await fixture(),l=new FinancialLedger(other.store,{assistedScope:other.scope,clock:other.clock});
 await l.reserve({executionId:other.scope.executionId,videoId,stage:'upload',maximumCents:100});await l.transition(other.scope.executionId,'start');other.set(other.path,{status:'revoked'});
 await assert.rejects(workerReservationGate(other.store,{assistedScope:other.scope,clock:other.clock})({executionId:other.scope.executionId,videoId,stage:'upload'}),/Autorização unitária alterada/);
});

test('invalid or longer-than-one-hour private approval cannot mint the exemption',async()=>{
 const f=await fixture();
 for(const delta of [{kind:'assisted_upload'},{expires_at:new Date(NOW+3600001).toISOString()},{maximum_cents:501}]){
  f.set(f.path,{...f.approval,...delta});const receipt=await f.store.get(f.path);
  await assert.rejects(createPipelineScope({store:f.store,path:f.path,receipt,videoId,stage:'upload',quotes:f.quotes,analysisRevision:revision,now:NOW}));
 }
});
