import test from 'node:test';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {assistedUploadHandler,runAssistedUpload} from '../lib/assisted-upload.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {workerHandler} from '../lib/worker-queue.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {readFileSync} from 'node:fs';
import {Firestore,encodeFields,decodeFields} from '../lib/firestore.mjs';

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
const incompleteFinalReceipts={
  empty:()=>({}),
  missing_version:r=>{delete r.updateTime;return r;},
  invalid_version:r=>({...r,updateTime:42}),
  empty_version:r=>({...r,updateTime:''}),
  stale_version:(r,version)=>({...r,updateTime:version}),
  missing_fields:r=>{delete r.fields;return r;},
  missing_outcome:r=>{delete r.fields.outcome;return r;},
  wrong_status:r=>{r.fields.outcome.mapValue.fields.status={stringValue:'waiting'};return r;},
  wrong_reason:r=>{r.fields.outcome.mapValue.fields.reason={stringValue:'other_reason'};return r;},
  wrong_execution:r=>{r.fields.outcome.mapValue.fields.execution_id={stringValue:'job_'+'b'.repeat(64)};return r;},
  wrong_duplicate:r=>{r.fields.outcome.mapValue.fields.duplicate={booleanValue:true};return r;},
  extra_outcome:r=>{r.fields.outcome.mapValue.fields.extra={stringValue:'unexpected'};return r;},
  missing_observation:r=>{delete r.fields.observed_at;return r;},
  wrong_observation:r=>{r.fields.observed_at={stringValue:'2000-01-01T00:00:00.000Z'};return r;},
  wrong_consumed_status:r=>{r.fields.status={stringValue:'authorized'};return r;},
  wrong_consumed_at:r=>{r.fields.consumed_at={stringValue:'2000-01-01T00:00:00.000Z'};return r;},
};
for(const committed of [false,true])for(const [name,alter] of Object.entries(incompleteFinalReceipts)){
  test('actual Firestore '+name+' final receipt, committed='+committed+', stays uncertain without replay',async()=>{
    const expected={status:'completed',reason:'upload_complete',execution_id:'job_'+'a'.repeat(64),duplicate:false};
    const f=fixture(async()=>expected),patch=f.store.patch;let finalWrites=0,reads=0;const get=f.store.get;
    f.store.get=async p=>{reads++;return get(p);};
    const firestore=new Firestore({project:'offline-test',async request(url,options){
      assert.equal(options.method,'PATCH');assert.equal(new URL(url).searchParams.get('currentDocument.updateTime'),f.docs.get(path).updateTime);
      finalWrites++;const consumedVersion=f.docs.get(path).updateTime,changes=decodeFields(options.json.fields);
      const data={...f.docs.get(path).data,...changes};
      if(committed)await patch(path,changes,{updateTime:consumedVersion});
      return alter({fields:encodeFields(data),updateTime:committed?f.docs.get(path).updateTime:'unconfirmed_new_version'},consumedVersion);
    }});
    f.store.patch=(p,c,o)=>c.outcome?firestore.patch(p,c,o):patch(p,c,o);
    assert.deepEqual(await f.run(),{status:'uncertain',reason:'assisted_result_unconfirmed'});
    assert.equal(f.docs.get(path).data.status,'consumed');
    assert.deepEqual(f.docs.get(path).data.outcome,committed?expected:undefined);
    assert.equal((await f.run()).reason,'assisted_already_requested');
    assert.deepEqual(f.stats(),{calls:1,successors:0,polls:0});assert.equal(finalWrites,1);assert.equal(reads,2);
  });
}
test('actual Firestore confirms rich outcome without depending on field order',async()=>{
  const expected={status:'completed',reason:'upload_complete',execution_id:'job_'+'a'.repeat(64),duplicate:false};
  const f=fixture(async()=>expected),patch=f.store.patch;let finalWrites=0;
  const firestore=new Firestore({project:'offline-test',async request(url,options){
    finalWrites++;const changes=decodeFields(options.json.fields),receipt=await patch(path,changes,{updateTime:new URL(url).searchParams.get('currentDocument.updateTime')});
    receipt.data.outcome=Object.fromEntries(Object.entries(receipt.data.outcome).reverse());
    return {fields:encodeFields(receipt.data),updateTime:receipt.updateTime};
  }});
  f.store.patch=(p,c,o)=>c.outcome?firestore.patch(p,c,o):patch(p,c,o);
  assert.deepEqual(await f.run(),expected);assert.equal((await f.run()).reason,'assisted_already_requested');
  assert.equal(finalWrites,1);assert.deepEqual(f.stats(),{calls:1,successors:0,polls:0});
});
test('unavailable authorization and partial consume receipt cannot invoke flow',async()=>{
  const f=fixture();f.store.get=async()=>{throw Error('unavailable');};
  assert.equal((await f.run()).reason,'assisted_authorization_unavailable');assert.equal(f.stats().calls,0);
  const g=fixture();g.store.patch=async()=>({});assert.equal((await g.run()).reason,'assisted_acquisition_unconfirmed');assert.equal(g.stats().calls,0);
});
function actualFixture(upload,assisted=false){
  const f=fixture(),ids=Array.from({length:262},(_,i)=>'Reel_'+i),batchId='pilot_assisted';
  f.seed('settings/automation',{enabled:true,parallelism:1,transcription_enabled:false,analysis_enabled:false});
  f.seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
  f.seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,remaining_credit_cents:170000,allocation_cents:170000,balance_observed_at:new Date(f.now).toISOString(),credit_expires_at:new Date(f.now+30*86400000).toISOString(),ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(f.now).toISOString(),ongoing_costs_valid_until:new Date(f.now+86400000).toISOString(),enabled_stages:{upload:true,transcription:false,analysis:false},batch:{schema_version:1,id:batchId,status:'active',video_ids:ids,budget_cents:120000,overhead_cents:2400,parallelism:4,active_video_ids:[]}});
  f.seed('videos/Reel_1',{status:'pending'});f.seed('videos/Reel_2',{status:'analyzed',analysis_quality_status:'accepted',analysis:{title:'Published'},candidate_analysis_key:'saved/candidate'});
  const config={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',batch_id:batchId,pilot_video_ids:assisted?['Reel_1','Reel_2']:ids,quotes:{upload:10,transcription:10,analysis:10},...(assisted?{assisted_upload_enabled:true,dispatch_enabled:false,admission_enabled:false}:{} )};
  const flow=workerRuntime(config,preset);Object.assign(flow.store,f.store);
  flow.ledger=new FinancialLedger(flow.store,{clock:()=>f.now});let uploads=0,models=0;
  flow.operations={upload:async input=>{uploads++;if(upload)return upload(input);const ended=input.recordAcquisitionExtraction();ended();return {video_id:'Reel_1',stage:'upload',actual_cents:4,changes:{media_verified:true,video_key:'originals/instagram/Reel_1/video.mp4',video_generation:'123',audio_status:'present'}};},transcription:async()=>{models++;throw Error('STT forbidden');},analysis:async()=>{models++;throw Error('Gemini forbidden');}};
  f.options.flow=flow;f.options.store=flow.store;
  return {...f,flow,config,stats:()=>({uploads,models}),run:()=>runAssistedUpload(f.options)};
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

const httpRequest=(body={requestId:request},method='POST')=>new Request('https://offline.run.app/tasks/assisted-upload',{method,...(method==='POST'?{body:JSON.stringify(body)}:{})});
function entry(f,{enabled=true,authorize=async()=>true,allowedVideoIds=['Reel_1']}={}){
  return assistedUploadHandler({store:f.options.store,flow:f.flow,enabled,authorize,allowedVideoIds});
}
test('private entry authenticates before store access; disabled by default and rejects client scope',async()=>{
  const f=fixture();let reads=0;f.options.store={async get(){reads++;throw Error('forbidden');}};
  assert.equal((await entry(f,{authorize:async()=>false})(httpRequest())).status,401);
  const off=assistedUploadHandler({store:f.options.store,flow:f.flow,authorize:async()=>true});
  assert.equal((await off(httpRequest())).status,409);assert.equal(reads,0);
  for(const body of [{requestId:request,task:f.approval.task},{requestId:request,allowedVideoIds:['Reel_2']},{requestId:request,maximum_cents:1},{requestId:request,noSuccessors:true},{requestId:'../bad'},null,[],{requestId:request,stage:'analysis'}])assert.equal((await entry(f)(httpRequest(body))).status,400);
  assert.equal((await entry(f)(httpRequest({},'GET'))).status,405);assert.equal(reads,0);assert.equal(f.stats().calls,0);
});
test('private entry requires one-slot controls with inference paused before consuming approval',async()=>{
  for(const changes of [{parallelism:4},{analysis_enabled:true},{transcription_enabled:true},{enabled:false}]){
    const f=actualFixture(undefined,true),d=f.docs.get('settings/automation').data;f.seed('settings/automation',{...d,...changes});
    assert.equal((await (await entry(f)(httpRequest())).json()).reason,'assisted_controls_invalid');
    assert.equal(f.docs.get(path).data.status,'authorized');assert.equal(f.stats().uploads,0);
  }
  const f=actualFixture(undefined,true);f.seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:2,active:{}});
  assert.equal((await (await entry(f)(httpRequest())).json()).reason,'assisted_controls_invalid');assert.equal(f.docs.get(path).data.status,'authorized');
});
test('real assisted flow through private entry is consumed once, preserves proof and never chains',async()=>{
  const f=actualFixture(undefined,true),handler=entry(f),responses=await Promise.all([handler(httpRequest()),handler(httpRequest())]);
  assert.ok((await Promise.all(responses.map(r=>r.json()))).some(x=>x.status==='completed'));
  assert.deepEqual(f.stats(),{uploads:1,models:0});assert.equal(f.docs.get(path).data.status,'consumed');
  assert.equal([...f.docs.keys()].filter(p=>p.startsWith('execution_stops/')).length,1);
  assert.ok(![...f.docs.keys()].some(p=>p.startsWith('jobs/dispatch_')||p.includes('admit_')));
  assert.equal(f.docs.get('settings/financial').data.batch.parallelism,4);
});
test('different approved requests compete for the single shared slot without a successor',async()=>{
  const hold=deferred(),started=deferred();
  const f=actualFixture(async input=>{const end=input.recordAcquisitionExtraction();started.resolve();await hold.promise;end();return {video_id:input.video.id,stage:'upload',actual_cents:4,changes:{media_verified:true}};},true);
  f.seed('videos/Reel_2',{status:'pending'});const id='assisted_second_request';
  f.seed('jobs/assisted_upload_'+id,{...f.approval,request_id:id,task:{videoId:'Reel_2',stage:'upload',poll:0}});
  const handler=entry(f,{allowedVideoIds:['Reel_1','Reel_2']}),first=handler(httpRequest());await started.promise;
  const second=await (await handler(httpRequest({requestId:id}))).json();assert.equal(second.status,'blocked');assert.equal(f.stats().uploads,1);
  hold.resolve();await first;assert.equal(f.stats().models,0);
});
test('assisted runtime keeps its CAS ceiling one even if acquisition configuration drifts to two',async()=>{
  const f=actualFixture(undefined,true);f.seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:2,active:{}});
  const a={executionId:'job_'+'a'.repeat(64),attemptId:randomUUID(),videoId:'Reel_1'},b={executionId:'job_'+'b'.repeat(64),attemptId:randomUUID(),videoId:'Reel_2'};
  const result=await Promise.all([f.flow.acquisition.acquire(a),f.flow.acquisition.acquire(b)]);
  assert.equal(result.filter(Boolean).length,1);assert.equal(Object.keys(f.docs.get('settings/acquisition').data.active).length,1);
});
test('private entry retains unknown extraction/receipt state and snapshots server allowlist',async()=>{
  const f=actualFixture(async input=>{input.recordAcquisitionExtraction();throw Error('private timeout');},true),ids=['Reel_1'],handler=entry(f,{allowedVideoIds:ids});ids[0]='Reel_2';
  assert.equal((await (await handler(httpRequest())).json()).status,'uncertain');await handler(httpRequest());
  assert.equal(f.stats().uploads,1);assert.equal(Object.keys(f.docs.get('settings/acquisition').data.active).length,1);
  assert.equal([...f.docs.keys()].filter(p=>p.startsWith('execution_stops/')).length,0);
  const g=actualFixture(undefined,true);g.options.store.patch=async()=>{throw Error('receipt lost');};
  assert.equal((await (await entry(g)(httpRequest())).json()).reason,'assisted_acquisition_unconfirmed');assert.equal(g.stats().uploads,0);
});
test('assisted runtime refuses unbounded scope or enabled dispatch/admission',()=>{
  const f=actualFixture(undefined,true);
  for(const change of [{dispatch_enabled:true},{admission_enabled:true},{dispatch_enabled:undefined},{pilot_video_ids:Array.from({length:7},(_,i)=>'Reel_'+i)},{assisted_upload_enabled:'true'}])assert.throws(()=>workerRuntime({...f.config,...change},preset));
});
test('packaged runtime route uses real OIDC/helper while blocking normal producers in assisted mode',async()=>{
  const f=actualFixture(undefined,true);await f.flow.run({videoId:'Reel_1',stage:'upload'});
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const origin='https://offline.run.app',now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',kid:'offline'})).toString('base64url');
  const claims=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:origin,email:'v0-queue@megabrain-v0-1017370021431.iam.gserviceaccount.com',email_verified:true,sub:'offline',iat:now,exp:now+300})).toString('base64url');
  const token=header+'.'+claims+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+claims),privateKey).toString('base64url');
  const originalFetch=globalThis.fetch;let fetches=0;
  try{
    globalThis.fetch=async(url,options={})=>{
      fetches++;const u=new URL(url);
      if(u.hostname==='www.googleapis.com')return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'offline',alg:'RS256',use:'sig'}]},{headers:{'Cache-Control':'max-age=300'}});
      if(u.hostname==='metadata.google.internal'){
        const headers={'Metadata-Flavor':'Google'};
        if(u.pathname.endsWith('/project-id'))return new Response(f.config.project,{headers});
        if(u.pathname.endsWith('/email'))return new Response('v0-worker@'+f.config.project+'.iam.gserviceaccount.com',{headers});
        if(u.pathname.endsWith('/token'))return Response.json({access_token:'offline',expires_in:300},{headers});
      }
      assert.equal(u.hostname,'firestore.googleapis.com');const path=decodeURIComponent(u.pathname.split('/documents/')[1]);
      let doc;
      if(options.method==='PATCH')doc=await f.store.patch(path,decodeFields(JSON.parse(options.body).fields),{updateTime:u.searchParams.get('currentDocument.updateTime')});
      else{assert.equal(options.method,'GET');doc=await f.store.get(path);}
      return doc?Response.json({fields:encodeFields(doc.data),updateTime:doc.updateTime}):new Response('',{status:404});
    };
    const handler=workerRuntime({...f.config,worker_origin:origin},preset,{withHandler:true});
    const req=path=>new Request(origin+path,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({requestId:request})});
    for(const path of ['/tasks/run','/tasks/admit','/tasks/diagnose'])assert.equal((await handler(req(path))).status,409);
    const response=await handler(req('/tasks/assisted-upload'));assert.equal(response.headers.get('cache-control'),'no-store');
    const outcome=await response.json();assert.equal(outcome.status,'completed');assert.equal(outcome.duplicate,true);
    assert.equal((await (await handler(req('/tasks/assisted-upload'))).json()).reason,'assisted_already_requested');
    assert.deepEqual(f.stats(),{uploads:1,models:0});assert.ok(fetches>1);
  }finally{globalThis.fetch=originalFetch;}
});

test('native worker HTTP transport exposes the private assisted path and bounds request bodies',async()=>{
  const f=actualFixture(undefined,true),server=workerHTTP(entry(f));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin='http://127.0.0.1:'+server.address().port;
    const large=await fetch(origin+'/tasks/assisted-upload',{method:'POST',body:'x'.repeat(2049)});assert.equal(large.status,413);assert.equal(f.stats().uploads,0);
    const response=await fetch(origin+'/tasks/assisted-upload',{method:'POST',body:JSON.stringify({requestId:request})});assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');
    assert.deepEqual(f.stats(),{uploads:1,models:0});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
