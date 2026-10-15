import test from 'node:test';
import assert from 'node:assert/strict';
import {runAssistedUpload} from '../lib/assisted-upload.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {workerHandler} from '../lib/worker-queue.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {readFileSync} from 'node:fs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const request='assisted_request_20261015';
const path='jobs/assisted_upload_'+request;
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
function fixture(run=async()=>({status:'completed'})){
  let version=0,calls=0,successors=0,polls=0;const now=Date.now(),docs=new Map(),writes=[];
  const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
  const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,changes,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('Conflict'),{status:412});writes.push({p,changes:structuredClone(changes)});seed(p,{...docs.get(p).data,...changes});return structuredClone(docs.get(p));}};
  const approval={schema_version:1,kind:'assisted_upload',status:'authorized',request_id:request,authorization_ref:'MEG-104:test:approved',authorized_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),maximum_cents:10,task:{videoId:'Reel_1',stage:'upload',poll:0}};
  seed(path,approval);
  const flow={quotes:{upload:10},async run(task){calls++;return run(task);},async poll(){polls++;throw Error('No poll');}};
  const queue={async enqueue(){successors++;},async enqueueAdmission(){successors++;}};
  const options={store,flow,requestId:request,allowedVideoIds:['Reel_1'],clock:()=>now};
  return {now,docs,writes,store,flow,queue,seed,approval,options,run:()=>runAssistedUpload(options),stats:()=>({calls,successors,polls})};
}
test('trusted upload approval is consumed before the one run and no successor is composed',async()=>{
  let f;f=fixture(async task=>{assert.equal(f.docs.get(path).data.status,'consumed');assert.deepEqual(task,f.approval.task);return {status:'completed'};});
  assert.equal((await f.run()).status,'completed');
  assert.deepEqual(f.stats(),{calls:1,successors:0,polls:0});assert.equal(f.docs.get(path).data.outcome.status,'completed');
  assert.equal((await f.run()).reason,'assisted_already_requested');assert.equal(f.stats().calls,1);
});
for(const status of ['waiting','uncertain','blocked','paused','started']){
  test(status+' is observed without polling, continuation or retry',async()=>{
    const f=fixture(async()=>({status}));assert.equal((await f.run()).status,status);await f.run();
    assert.deepEqual(f.stats(),{calls:1,successors:0,polls:0});
  });
}
for(const name of ['Error','TimeoutError']){
  test(name+' consumes approval and does not repeat or expose raw diagnostic',async()=>{
    const f=fixture(async()=>{throw Object.assign(Error('secret provider diagnostic'),{name});});
    assert.equal((await f.run()).reason,'assisted_execution_unconfirmed');await f.run();
    assert.equal(f.stats().calls,1);assert.ok(!JSON.stringify([...f.docs]).includes('secret provider'));
  });
}
const invalid={
  missing:a=>null,
  identity:a=>({...a,request_id:'different_request_20261015'}),
  schema:a=>({...a,schema_version:2}),
  kind:a=>({...a,kind:'assisted_analysis'}),
  reference:a=>({...a,authorization_ref:''}),
  expired:(a,n)=>({...a,expires_at:new Date(n).toISOString()}),
  future:(a,n)=>({...a,authorized_at:new Date(n+1000).toISOString()}),
  overlong:(a,n)=>({...a,authorized_at:new Date(n-1).toISOString(),expires_at:new Date(n+3600001).toISOString()}),
  quote:a=>({...a,maximum_cents:11}),
  reset:a=>({...a,consumed_at:'already'}),
  transcription:a=>({...a,task:{...a.task,stage:'transcription'}}),
  analysis:a=>({...a,task:{...a.task,stage:'analysis'}}),
  poll:a=>({...a,task:{...a.task,poll:1}}),
  outside:a=>({...a,task:{...a.task,videoId:'Other_1'}}),
  flag:a=>({...a,task:{...a.task,noSuccessors:true}}),
  mixed:a=>({...a,task:{...a.task,recoverUpload:true,recoverSettled:true,recoveryId:'recovery_request_20261015'}}),
};
for(const [name,change] of Object.entries(invalid)){
  test('rejects '+name+' approval before writes or operations',async()=>{
    const f=fixture(),value=change(f.approval,f.now);if(value)f.seed(path,value);else f.docs.delete(path);
    assert.equal((await f.run()).status,'blocked');assert.equal(f.stats().calls,0);assert.equal(f.writes.length,0);
  });
}
test('caller cannot pass task, stage or an HTTP bypass flag and scope is snapshotted',async()=>{
  const f=fixture();
  for(const extra of [{task:f.approval.task},{stage:'analysis'},{noSuccessors:true}])assert.equal((await runAssistedUpload({...f.options,...extra})).status,'blocked');
  assert.equal((await runAssistedUpload({...f.options,requestId:'../bad'})).status,'blocked');
  assert.equal((await runAssistedUpload({...f.options,allowedVideoIds:[]})).status,'blocked');assert.equal(f.stats().calls,0);
});
test('concurrent use has one CAS winner and one invocation',async()=>{
  const entered=deferred(),finish=deferred(),f=fixture(async()=>{entered.resolve();await finish.promise;return {status:'completed'};});
  const first=f.run();await entered.promise;
  assert.equal((await f.run()).reason,'assisted_already_requested');
  finish.resolve();assert.equal((await first).status,'completed');assert.equal(f.stats().calls,1);
});
test('concurrent reads of authorized approval still have one CAS winner',async()=>{
  const f=fixture();const results=await Promise.all([f.run(),f.run()]);
  assert.equal(f.stats().calls,1);assert.equal(results.filter(r=>r.status==='completed').length,1);
});
for(const committed of [false,true]){
  test('unknown approval write '+committed+' never invokes flow or auto retries',async()=>{
    const f=fixture(),patch=f.store.patch;let attempts=0;
    f.store.patch=async(...args)=>{attempts++;if(committed)await patch(...args);throw Error('lost receipt');};
    assert.equal((await f.run()).reason,'assisted_acquisition_unconfirmed');assert.equal(attempts,1);assert.equal(f.stats().calls,0);
    if(committed){await f.run();assert.equal(attempts,1);}
  });
}
test('unconfirmed outcome preserves consumed request and does not repeat successful flow',async()=>{
  const f=fixture(),patch=f.store.patch;
  f.store.patch=async(p,c,o)=>{if(c.outcome)throw Error('receipt lost');return patch(p,c,o);};
  assert.equal((await f.run()).reason,'assisted_result_unconfirmed');await f.run();assert.equal(f.stats().calls,1);
});
test('unavailable authorization and partial consume receipt cannot invoke flow',async()=>{
  const f=fixture();f.store.get=async()=>{throw Error('unavailable');};
  assert.equal((await f.run()).reason,'assisted_authorization_unavailable');assert.equal(f.stats().calls,0);
  const g=fixture();g.store.patch=async()=>({});assert.equal((await g.run()).reason,'assisted_acquisition_unconfirmed');assert.equal(g.stats().calls,0);
});
function actualFixture(upload){
  const f=fixture(),ids=Array.from({length:262},(_,i)=>'Reel_'+i),batchId='pilot_assisted';
  f.seed('settings/automation',{enabled:true,parallelism:1,transcription_enabled:false,analysis_enabled:false});
  f.seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
  f.seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,remaining_credit_cents:170000,allocation_cents:170000,balance_observed_at:new Date(f.now).toISOString(),credit_expires_at:new Date(f.now+30*86400000).toISOString(),ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(f.now).toISOString(),ongoing_costs_valid_until:new Date(f.now+86400000).toISOString(),enabled_stages:{upload:true,transcription:false,analysis:false},batch:{schema_version:1,id:batchId,status:'active',video_ids:ids,budget_cents:120000,overhead_cents:2400,parallelism:4,active_video_ids:[]}});
  f.seed('videos/Reel_1',{status:'pending'});f.seed('videos/Reel_2',{status:'analyzed',analysis_quality_status:'accepted',analysis:{title:'Published'},candidate_analysis_key:'saved/candidate'});
  const config={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',batch_id:batchId,pilot_video_ids:ids,quotes:{upload:10,transcription:10,analysis:10}};
  const flow=workerRuntime(config,preset);Object.assign(flow.store,f.store);
  flow.ledger=new FinancialLedger(flow.store,{clock:()=>f.now});let uploads=0,models=0;
  flow.operations={upload:async input=>{uploads++;if(upload)return upload(input);const ended=input.recordAcquisitionExtraction();ended();return {video_id:'Reel_1',stage:'upload',actual_cents:4,changes:{media_verified:true,video_key:'originals/instagram/Reel_1/video.mp4',video_generation:'123',audio_status:'present'}};},transcription:async()=>{models++;throw Error('STT forbidden');},analysis:async()=>{models++;throw Error('Gemini forbidden');}};
  f.options.flow=flow;f.options.store=flow.store;
  return {...f,flow,stats:()=>({uploads,models}),run:()=>runAssistedUpload(f.options)};
}
test('actual runtime preserves ledger, acquisition lifecycle and proof without a model or successor',async()=>{
  const f=actualFixture(),published=structuredClone(f.docs.get('videos/Reel_2'));
  assert.equal((await f.run()).status,'completed');await f.run();
  assert.deepEqual(f.stats(),{uploads:1,models:0});assert.deepEqual(f.docs.get('videos/Reel_2'),published);
  const financial=f.docs.get('settings/financial').data;
  assert.equal(financial.spent_cents,4);assert.equal(financial.reserved_cents,0);
  assert.ok(Object.values(financial.jobs).every(x=>x.stage==='upload'));assert.deepEqual(f.docs.get('settings/acquisition').data.active,{});
  assert.equal([...f.docs.keys()].filter(p=>p.startsWith('execution_stops/')).length,1);
  assert.ok(![...f.docs.keys()].some(p=>p.startsWith('jobs/dispatch_')||p.includes('admit_')));
});
test('actual runtime keeps legacy and budget blocks with no operation or reservation',async()=>{
  for(const variant of ['legacy','budget','capacity']){
    const f=actualFixture();
    if(variant==='legacy')f.seed('jobs/'+(await import('../lib/worker-flow.mjs')).executionId('Reel_1','upload'),{video_id:'Reel_1',stage:'upload',status:'uncertain'});
    if(variant==='budget'){const d=f.docs.get('settings/financial').data;f.seed('settings/financial',{...d,balance_observed_at:'2000-01-01T00:00:00Z'});}
    if(variant==='capacity'){const d=f.docs.get('settings/acquisition').data;f.seed('settings/acquisition',{...d,enabled:false});}
    await f.run();await f.run();assert.deepEqual(f.stats(),{uploads:0,models:0});assert.equal(f.docs.get('settings/financial').data.reserved_cents,0);
  }
});
test('actual interrupted extraction retains capacity and emits no fabricated end proof',async()=>{
  const f=actualFixture(async input=>{input.recordAcquisitionExtraction();throw Object.assign(Error('timeout'),{name:'TimeoutError'});});
  assert.equal((await f.run()).status,'uncertain');await f.run();assert.equal(f.stats().uploads,1);assert.equal(f.stats().models,0);
  assert.equal(Object.keys(f.docs.get('settings/acquisition').data.active).length,1);
  assert.equal([...f.docs.keys()].filter(p=>p.startsWith('execution_stops/')).length,0);
  assert.equal(f.docs.get('settings/financial').data.reserved_cents,10);
});
test('normal private handler still chains and rejects any client no-successor flag',async()=>{
  let runs=0,dispatches=0;const handler=workerHandler({authorize:async()=>true,flow:{async run(){runs++;return {status:'completed'};}},queue:{async enqueue(){dispatches++;return {status:'queued'};}}});
  const req=task=>new Request('https://worker.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)});
  assert.equal((await handler(req({videoId:'Reel_1',stage:'upload',poll:0,noSuccessors:true}))).status,400);assert.equal(runs,0);
  assert.equal((await (await handler(req({videoId:'Reel_1',stage:'upload',poll:0}))).json()).dispatch,'queued');assert.equal(dispatches,1);
});
