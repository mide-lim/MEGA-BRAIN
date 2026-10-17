import test from 'node:test';import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {encodeFields} from '../lib/firestore.mjs';
import {executionId} from '../lib/reels-pipeline.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null,lastCursor:String(Math.min(n+limit,rows.length))};}};return store;}
async function provedFailure(store,reelId,stage='acquisition'){
 const operationId='prior-failure',id=executionId(operationId,reelId,stage),video=await store.get('videos/'+reelId);
 await store.create('reels_executions/'+id,{id,operationId,reelId,stage,status:'failed',owner:'fixture-worker-owner',error:{stage,retryable:true,uncertain:false}});
 await store.patch('videos/'+reelId,{reels_v2:{status:'failed',operationId,executionId:id,stage,error:{stage,retryable:true,uncertain:false}}},{updateTime:video.updateTime});
}
async function execute(service,input){let result=await service.command(input);while(['start','retry','complement'].includes(input.type)&&result.operation.status!=='completed')result=await service.drain({operationId:result.operation.id,pageSize:100});return result;}
const clock=()=>Date.parse('2026-10-16T03:30:00Z');

test('real persistence codec accepts numeric and underscore Reel stage plans and normalizes legacy upload retry',async()=>{
 const store=memory([{id:'0reel01',status:'registered'},{id:'_reel01',status:'registered'},{id:'__proto__',status:'registered'},{id:'Reel_OLD',status:'failed',stage:'upload',failure_confirmed:true}]);
 const create=store.create;store.create=async(path,data)=>{encodeFields(data);return create(path,data);};
 const service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository:new ReelsRepository({store,clock}),processingEnabled:true,clock});
 const start=await execute(service,{type:'start',idempotencyKey:'codec-real-ids',selection:{ids:['0reel01','_reel01','__proto__']}});assert.equal(start.operation.accepted.length,3);
 await provedFailure(store,'Reel_OLD');
 const retry=await execute(service,{type:'retry',idempotencyKey:'retry-legacy-stage',selection:{ids:['Reel_OLD']}});assert.equal(retry.operation.stagePlan.Reel_OLD,'acquisition');assert.deepEqual(retry.operation.accepted,['Reel_OLD']);
});
const reel=(id='Reel_001',extra={})=>({id,status:'registered',created_at:'2026-10-16T03:00:00Z',...extra});
const pub=(id='Reel_001',extra={})=>reel(id,{status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'original',evidence:{categories:[]}},...extra});
import {ReelsService} from '../lib/reels-service.mjs';
test('default server gate denies paid commands before selection/dispatch even client enabling flags',async()=>{let calls=0;const repository={store:memory(),select:()=>{calls++;throw Error();}};const service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,onQueued:()=>calls++});for(const type of ['start','retry','complement'])await assert.rejects(()=>execute(service,{idempotencyKey:'test-key-000',type,processingEnabled:true,selection:{all:true}}),e=>e.status===423&&e.code==='PROCESSING_DISABLED');assert.equal(calls,0);});
test('all 3107 eligible fixed once, duplicate command and lost creation response cannot readmit',async()=>{const store=memory(Array.from({length:3107},(_,i)=>reel('Reel_'+String(i).padStart(5,'0')))),repository=new ReelsRepository({store,clock}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true});let lost=true;const create=store.create;store.create=async(p,d)=>{const r=await create(p,d);if(p.startsWith('reels_commands/')&&lost){lost=false;throw Error('response lost');}return r;};const input={idempotencyKey:'all-items-123',type:'start',selection:{all:true}},first=await execute(service,input);assert.equal(first.operation.accepted.length,3107);await store.create('videos/Reel_NEW',reel('Reel_NEW'));const again=await execute(service,input);assert.equal(again.operation.accepted.length,3107);assert.equal([...store.docs.keys()].filter(p=>p.startsWith('reels_executions/')).length,3107);await assert.rejects(()=>execute(service,{...input,type:'pause'}),e=>e.code==='IDEMPOTENCY_CONFLICT');});
test('preview snapshot excludes late arrivals and revalidates changed items',async()=>{const store=memory([reel()]),repository=new ReelsRepository({store,clock}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true}),preview=await service.preview({all:true});await store.create('videos/Reel_NEW',reel('Reel_NEW'));const result=await execute(service,{idempotencyKey:'preview-fixed-01',type:'start',selectionToken:preview.selectionToken});assert.deepEqual(result.operation.accepted,['Reel_001']);});
test('retry/complement preserve uncertain and published results',async()=>{const store=memory([reel('Reel_BAD',{status:'failed',stage:'acquisition',failure_confirmed:true}),reel('Reel_UNK',{status:'uncertain'}),pub()]),repository=new ReelsRepository({store,clock}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true});await provedFailure(store,'Reel_BAD');assert.deepEqual((await service.preview({all:true},'retry')).ids,['Reel_BAD']);assert.deepEqual((await service.preview({all:true},'complement')).ids,['Reel_001']);});
test('pause and capacity are durable, desired differs from effective',async()=>{const store=memory(),repository=new ReelsRepository({store}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock});const c=await execute(service,{idempotencyKey:'capacity-123',type:'capacity',stage:'analysis',concurrency:17});assert.equal((await service.operation(c.operation.id)).operation.status,'completed');const control=await store.get('reels_controls/analysis');assert.equal(control.data.desiredConcurrency,17);assert.equal(control.data.effectiveConcurrency,0);await execute(service,{idempotencyKey:'pause-123456',type:'pause',stage:'analysis'});assert.equal((await store.get('reels_controls/analysis')).data.paused,true);});


import {event,hash} from '../lib/reels-runtime.mjs';
test('different simultaneous commands admit each Reel globally only once',async()=>{
 const store=memory([reel()]),repository=new ReelsRepository({store,clock}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true});
 const results=await Promise.all(['concurrent-key-A','concurrent-key-B'].map(idempotencyKey=>execute(service,{idempotencyKey,type:'start',selection:{ids:['Reel_001']}})));
 assert.equal(results.reduce((n,r)=>n+r.operation.accepted.length,0),1);
 assert.equal([...store.docs.keys()].filter(p=>p.startsWith('reels_executions/')).length,1);
});
test('retry command replay preserves fixed stage and never regresses an advanced execution',async()=>{
 const store=memory([reel('Reel_001',{status:'failed',failure_confirmed:true,reels_v2:{status:'failed',stage:'acquisition'}})]),repository=new ReelsRepository({store,clock});
 await provedFailure(store,'Reel_001');
 const patch=store.patch;let lost=true,queued=0;
 store.patch=async(p,d,o)=>{if(p.startsWith('reels_commands/')&&d.accepted&&lost){lost=false;throw Error('command acknowledgement unavailable');}return patch(p,d,o);};
 const service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true,onQueued:async job=>{
  queued++;const execution=await store.get('reels_executions/'+job.id);await store.patch('reels_executions/'+job.id,{status:'completed'},{updateTime:execution.updateTime});
  const video=await store.get('videos/'+job.reelId);await store.patch('videos/'+job.reelId,{reels_v2:{...video.data.reels_v2,status:'running',stage:'transcription',executionId:'next_stage'}},{updateTime:video.updateTime});
 }});
 const input={idempotencyKey:'retry-replay-fixed',type:'retry',selection:{ids:['Reel_001']}};
 await assert.rejects(()=>execute(service,input),/acknowledgement/);
 const recovered=await execute(service,input);assert.deepEqual(recovered.operation.accepted,['Reel_001']);
 assert.equal(queued,1);assert.equal((await store.get('videos/Reel_001')).data.reels_v2.stage,'transcription');
 assert.equal([...store.docs.keys()].filter(p=>p.startsWith('reels_executions/')).length,2);
});
test('preview retains original exclusions and fixes membership through an empty selection',async()=>{
 const store=memory([reel(),reel('Reel_UNK',{status:'uncertain'})]),repository=new ReelsRepository({store,clock}),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository,clock,processingEnabled:true});
 const preview=await service.preview({all:true});const video=await store.get('videos/Reel_001');
 await store.patch('videos/Reel_001',{status:'uncertain'},{updateTime:video.updateTime});await store.create('videos/Reel_NEW',reel('Reel_NEW'));
 const result=await execute(service,{idempotencyKey:'preview-exclusions-fixed',type:'start',selectionToken:preview.selectionToken});
 assert.deepEqual(result.operation.accepted,[]);assert.deepEqual(result.operation.excluded.map(x=>x.id).sort(),['Reel_001','Reel_UNK']);
});
test('control history does not evict idempotency after more than 256 commands',async()=>{
 const store=memory(),service=new ReelsService({onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>({status:'sent'}),repository:new ReelsRepository({store}),clock});
 for(let n=0;n<260;n++)await execute(service,{idempotencyKey:'control-long-'+n,type:n===259?'resume':'pause',stage:'analysis'});
 const command=[...store.docs].find(([p,v])=>p.startsWith('reels_commands/')&&v.data.fingerprint&&v.data.type==='pause');
 const saved=await store.get(command[0]);await store.patch(command[0],{status:'pending'},{updateTime:saved.updateTime});
 await execute(service,{idempotencyKey:'control-long-0',type:'pause',stage:'analysis'});
 assert.equal((await store.get('reels_controls/analysis')).data.paused,false);
 assert.equal((await store.get('reels_controls/analysis')).data.appliedCommands.length,260);
});
test('event clock survives concurrent writers, lost acknowledgement and backdated wall clock',async()=>{
 const store=memory(),repository=new ReelsRepository({store,clock});
 await Promise.all(Array.from({length:12},(_,n)=>event(store,{id:hash('concurrent-'+n),type:'test',message:'safe'},clock)));
 const first=await repository.events({limit:100});assert.equal(first.items.length,12);
 const patch=store.patch;let lost=true;store.patch=async(p,d,o)=>{const r=await patch(p,d,o);if(p==='settings/reels_v2_event_clock'&&d.pending===null&&lost){lost=false;throw Error('lost event acknowledgement');}return r;};
 const data={id:hash('after-response-loss'),type:'test',message:'safe'};
 await assert.rejects(()=>event(store,data,()=>clock()-86400000),/acknowledgement/);
 await event(store,data,clock);const next=await repository.events({limit:100,cursor:first.nextCursor});
 assert.equal(next.items.length,1);assert.ok(next.items[0].id>first.items.at(-1).id);
 assert.equal([...store.docs.keys()].filter(p=>p.startsWith('reels_events/')).length,13);
});


test('retry rejects paid quality candidate and stage overrides while admission rechecks the failure proof',async()=>{
 const bad=reel('Reel_BAD',{status:'failed',stage:'analysis',failure_confirmed:true,error:{retryable:false,uncertain:false,code:'QUALITY_VALIDATION_FAILED'}});
 const allowed=reel('Reel_GOOD',{status:'failed',stage:'analysis',failure_confirmed:true,error:{retryable:true,uncertain:false}});
 const store=memory([bad,allowed]),service=new ReelsService({repository:new ReelsRepository({store,clock}),processingEnabled:true,clock,onQueued:async()=>({status:'sent'}),onCommandQueued:async()=>({status:'sent'})});
 await provedFailure(store,'Reel_GOOD','analysis');
 assert.deepEqual((await service.preview({all:true},'retry')).ids,['Reel_GOOD']);
 await assert.rejects(()=>service.command({type:'retry',stage:'acquisition',idempotencyKey:'invalid-retry-stage',selection:{ids:['Reel_GOOD']}}),e=>e.code==='INVALID_STAGE');
 const {operation}=await service.command({type:'retry',idempotencyKey:'retry-recheck-proof',selection:{all:true}});
 const video=await store.get('videos/Reel_GOOD');await store.patch('videos/Reel_GOOD',{reels_v2:{...video.data.reels_v2,error:{retryable:false}}},{updateTime:video.updateTime});
 const completed=await service.drain({operationId:operation.id});assert.equal(completed.operation.accepted.length,0);assert.equal(completed.operation.excluded.length,2);
 assert.equal(completed.operation.progress.processed,completed.operation.progress.total);
 assert.equal([...store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,1);
});


test('legacy failure_confirmed without an execution receipt never admits a paid retry',async()=>{
 const store=memory([reel('Reel_OLD',{status:'failed',stage:'analysis',failure_confirmed:true,error:{retryable:true}})]);
 const service=new ReelsService({repository:new ReelsRepository({store}),processingEnabled:true,onCommandQueued:async()=>({status:'sent'}),onQueued:()=>assert.fail('legacy cannot dispatch')});
 const preview=await service.preview({all:true},'retry');assert.equal(preview.eligible,0);
 const accepted=await execute(service,{type:'retry',idempotencyKey:'legacy-without-receipt',selection:{all:true}});assert.deepEqual(accepted.operation.accepted,[]);
 assert.equal([...store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,0);
});

import {reelsAPI} from '../lib/reels-api.mjs';
test('retry API excludes native and preserved publications after a proved later failure',async()=>{
 const store=memory([pub('Reel_PUB'),reel('Reel_OLD',{status:'failed',failure_confirmed:true}),reel('Reel_BAD',{status:'failed',failure_confirmed:true}),pub('Reel_OK')]);
 for(const id of ['Reel_PUB','Reel_OLD','Reel_BAD'])await provedFailure(store,id);
 const savedLegacy={schemaVersion:1,reelId:'Reel_OLD',status:'legacy_preserved',originalStatus:'analyzed',historical:true,executable:false,provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{summary:'Publicação antiga preservada'}};await store.create('reels_legacy_content/Reel_OLD',savedLegacy);
 const repository=new ReelsRepository({store,clock}),service=new ReelsService({repository,clock,processingEnabled:true,onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>assert.fail('no protected publication may reach stage dispatch')});
 const api=reelsAPI({repository,service,processingEnabled:true,authorize:async()=>true,sameOrigin:async()=>true,clock});
 const response=await api(new Request('https://reels.test/api/reels/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'retry',selection:{all:true}})}));assert.equal(response.status,200);const preview=await response.json();assert.deepEqual(preview.ids,['Reel_BAD']);assert.equal(preview.total,4);assert.deepEqual(preview.excluded.filter(row=>row.reason==='already_completed').map(row=>row.id).sort(),['Reel_OK','Reel_OLD','Reel_PUB']);
 assert.deepEqual((await service.preview({ids:['Reel_PUB','Reel_OLD']},'retry')).ids,[]);assert.deepEqual((await service.preview({ids:['Reel_OK']},'complement')).ids,['Reel_OK']);
 const retry=await service.command({type:'retry',idempotencyKey:'exclude-old-success',selection:{ids:['Reel_PUB','Reel_OLD']}}),result=await service.drain({operationId:retry.operation.id});assert.deepEqual(result.operation.accepted,[]);assert.equal([...store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,3);assert.deepEqual((await store.get('reels_legacy_content/Reel_OLD')).data,savedLegacy);assert.equal((await store.get('videos/Reel_PUB')).data.analysis_generation,'1');
});
test('drain rechecks a publication added after retry selection and preserves failed-stage proof',async()=>{
 for(const source of ['native','legacy']){
  const store=memory([reel('Reel_LATE',{status:'failed',failure_confirmed:true})]);await provedFailure(store,'Reel_LATE');let dispatches=0;const service=new ReelsService({repository:new ReelsRepository({store,clock}),clock,processingEnabled:true,onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>{dispatches++;return {status:'sent'};}}),{operation}=await service.command({type:'retry',idempotencyKey:'late-publication-'+source,selection:{ids:['Reel_LATE']}});assert.deepEqual(operation.selected,['Reel_LATE']);
  if(source==='native'){const video=await store.get('videos/Reel_LATE');await store.patch('videos/Reel_LATE',{analysis_key:'preserved',analysis_generation:'7',analysis_quality_status:'accepted',analysis:{summary:'Preservar conhecimento'}},{updateTime:video.updateTime});}else await store.create('reels_legacy_content/Reel_LATE',{schemaVersion:1,reelId:'Reel_LATE',status:'legacy_preserved',originalStatus:'analyzed',historical:true,executable:false,provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{summary:'Preservar legado'}});
  const result=await service.drain({operationId:operation.id});assert.deepEqual(result.operation.accepted,[]);assert.equal(result.operation.excluded[0].reason,'already_completed');assert.equal(dispatches,0);assert.equal([...store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,1);assert.equal((await store.get('videos/Reel_LATE')).data.reels_v2.status,'failed');
 }
});

test('a later publication blocks replay of queued jobs and the crash window before job creation',async()=>{
 for(const savedJob of [false,true]){
  const store=memory([reel('Reel_CRASH',{status:'failed',failure_confirmed:true})]);await provedFailure(store,'Reel_CRASH');let dispatches=0;const service=new ReelsService({repository:new ReelsRepository({store,clock}),clock,processingEnabled:true,onCommandQueued:async()=>({status:'sent'}),onQueued:async()=>{dispatches++;return {status:'sent'};}}),{operation}=await service.command({type:'retry',idempotencyKey:'published-crash-'+savedJob,selection:{ids:['Reel_CRASH']}}),id=executionId(operation.id,'Reel_CRASH','acquisition'),current=await store.get('videos/Reel_CRASH');
  await store.patch('videos/Reel_CRASH',{reels_v2:{status:'queued',operationId:operation.id,executionId:id,stage:'acquisition'},analysis_key:'published-after-admission',analysis_generation:'9',analysis_quality_status:'accepted',analysis:{summary:'Conhecimento preservado'}},{updateTime:current.updateTime});
  if(savedJob)await store.create('reels_executions/'+id,{id,operationId:operation.id,reelId:'Reel_CRASH',stage:'acquisition',status:'queued',attempt:1});
  const before=structuredClone(store.docs),result=await service.drain({operationId:operation.id});assert.deepEqual(result.operation.accepted,[]);assert.equal(result.operation.excluded[0].reason,'already_completed');assert.equal(dispatches,0);assert.equal([...store.docs.keys()].filter(p=>p.startsWith('reels_executions/')).length,savedJob?2:1);
  assert.deepEqual((await store.get('videos/Reel_CRASH')).data,before.get('videos/Reel_CRASH').data);if(savedJob)assert.deepEqual(await store.get('reels_executions/'+id),before.get('reels_executions/'+id));
 }
});
