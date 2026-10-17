import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsService} from '../lib/reels-service.mjs';
import {ReelsCommandRunner} from '../lib/reels-command-runner.mjs';
import {ReelsDispatcher} from '../lib/reels-dispatcher.mjs';
import {hash} from '../lib/reels-runtime.mjs';
import {executionId} from '../lib/reels-pipeline.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null,lastCursor:String(Math.min(n+limit,rows.length))};}};return store;}

const project='megabrain-v0-1017370021431';
const routes={upload:{queue:'v0-acquisition',workerOrigin:'https://acquisition.run.app'},transcription:{queue:'v0-transcription',workerOrigin:'https://transcription.run.app'},analysis:{queue:'v0-analysis',workerOrigin:'https://analysis.run.app'}};
const reel=id=>({id,status:'registered'});
function setup(videos=[]){
 const store=memory(videos),repository=new ReelsRepository({store,cacheTtlMs:0}),tasks=new Map();
 const api={project,request:async(url,options)=>{
  if(options?.method==='POST'){
   const task=options.json.task;if(tasks.has(task.name))throw Object.assign(Error('conflict'),{status:409});
   tasks.set(task.name,structuredClone(task));return structuredClone(task);
  }
  const task=tasks.get(url.replace('https://cloudtasks.googleapis.com/v2/','').replace('?responseView=FULL',''));
  if(!task)throw Object.assign(Error('missing'),{status:404});return structuredClone(task);
 }};
 const dispatcher=new ReelsDispatcher({api,store,routes,enabled:true});
 const service=new ReelsService({repository,processingEnabled:true,onCommandQueued:op=>dispatcher.enqueueControl(op),onQueued:async job=>{const receipt=await dispatcher.enqueue(job);if(receipt.status!=='sent')throw Error('queue unavailable');return receipt;}});
 return {store,repository,tasks,api,dispatcher,service};
}
test('all 3005 membership freezes before admission and restart drains finite durable pages',async()=>{
 const x=setup(Array.from({length:3005},(_,i)=>reel('Reel_'+String(i).padStart(5,'0'))));
 const input={type:'start',idempotencyKey:'all-3005-frozen',selection:{all:true}};
 let {operation}=await x.service.command(input);
 assert.equal(operation.status,'pending');assert.equal(operation.selected.length,3005);assert.equal(operation.cursor,0);
 assert.equal([...x.store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,0);
 assert.equal(x.tasks.size,1);
 await x.store.create('videos/Reel_LATE',reel('Reel_LATE'));
 let previous=0,deliveries=0;
 while(operation.status!=='completed'){
  // Construct a fresh controller each delivery: no memory is the resume source.
  const runner=new ReelsCommandRunner({service:x.service,dispatcher:x.dispatcher,enabled:true,pageSize:25});
  const result=await runner.run({operationId:operation.id,sequence:previous});deliveries++;
  operation=(await x.service.operation(operation.id)).operation;
  assert.ok(operation.cursor-previous<=25);previous=operation.cursor;
  assert.equal(result.cursor,operation.cursor);
 }
 assert.equal(deliveries,121);assert.equal(operation.accepted.length,3005);assert.equal(operation.progress.processed,3005);
 assert.ok(!operation.accepted.includes('Reel_LATE'));
 assert.equal((await x.service.command(input)).operation.cursor,3005);
 assert.equal([...x.store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,3005);
 assert.equal([...x.tasks.values()].filter(t=>t.httpRequest.url.endsWith('/tasks/run')).length,3005);
});
test('interrupted admission before outbox can resume the same job without cursor skip',async()=>{
 const x=setup([reel('Reel_ONE'),reel('Reel_TWO')]),input={type:'start',idempotencyKey:'admission-interrupted',selection:{all:true}};
 const {operation}=await x.service.command(input),create=x.store.create;let interrupted=true;
 x.store.create=async(p,d)=>{if(p.startsWith('reels_executions/')&&interrupted){interrupted=false;throw Error('interrupted');}return create(p,d);};
 const runner=new ReelsCommandRunner({service:x.service,dispatcher:x.dispatcher,enabled:true,pageSize:1});
 await assert.rejects(()=>runner.run({operationId:operation.id}),/interrupted/);
 assert.equal((await x.service.operation(operation.id)).operation.cursor,0);
 assert.equal((await x.store.get('videos/Reel_ONE')).data.reels_v2.operationId,operation.id);
 await Promise.all([runner.run({operationId:operation.id}),runner.run({operationId:operation.id})]);
 let saved=(await x.service.operation(operation.id)).operation;
 while(saved.status!=='completed'){await runner.run({operationId:operation.id,sequence:saved.cursor});saved=(await x.service.operation(operation.id)).operation;}
 assert.deepEqual(saved.accepted.sort(),['Reel_ONE','Reel_TWO']);assert.equal(saved.cursor,2);
 assert.equal([...x.store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,2);
});
test('lost control task response preserves operationId and frozen selection on command retry',async()=>{
 const x=setup([reel('Reel_ONE')]),enqueue=x.dispatcher.enqueueControl.bind(x.dispatcher);let fail=true;
 x.dispatcher.enqueueControl=async op=>{if(fail){fail=false;return {status:'uncertain'};}return enqueue(op);};
 const input={type:'start',idempotencyKey:'lost-control-response',selection:{all:true}};
 let operationId;await assert.rejects(()=>x.service.command(input),error=>{operationId=error.operationId;return error.status===503&&/^[a-f0-9]{64}$/.test(operationId);});
 await x.store.create('videos/Reel_LATE',reel('Reel_LATE'));
 const retry=await x.service.command(input);assert.equal(retry.operation.id,operationId);assert.deepEqual(retry.operation.selected,['Reel_ONE']);
 assert.equal(retry.operation.cursor,0);assert.equal(x.tasks.size,1);
});
test('lost continuation leaves cursor durable and old control delivery resumes it',async()=>{
 const x=setup([reel('Reel_ONE'),reel('Reel_TWO')]),{operation}=await x.service.command({type:'start',idempotencyKey:'lost-continuation',selection:{all:true}});
 const enqueue=x.dispatcher.enqueueControl.bind(x.dispatcher);let fail=true;x.dispatcher.enqueueControl=async op=>{if(fail){fail=false;return {status:'uncertain'};}return enqueue(op);};
 const runner=new ReelsCommandRunner({service:x.service,dispatcher:x.dispatcher,enabled:true,pageSize:1});
 await assert.rejects(()=>runner.run({operationId:operation.id}),e=>e.status===503);
 assert.equal((await x.service.operation(operation.id)).operation.cursor,1);
 const result=await runner.run({operationId:operation.id,sequence:0});assert.equal(result.status,'completed');
 assert.equal((await x.service.operation(operation.id)).operation.accepted.length,2);
});
test('task409 with missing, BASIC or different payload remains uncertain; authenticated receipt resolves ACK race',async()=>{
 for(const mode of ['missing','basic','different','race']){
  const x=setup(),id=hash('job'),outboxId=hash('outbox'),job={id,outboxId,reelId:'Reel_ONE',stage:'analysis',poll:false};
  await x.store.create('reels_command_items/'+outboxId,{id:outboxId,executionId:id,stage:'analysis',poll:false,status:'pending'});
  x.api.request=async(url,options)=>{
   if(options?.method==='POST'){
    if(mode==='race')await x.dispatcher.acknowledge({outboxId,executionId:id,stage:'analysis'});
    throw Object.assign(Error('exists'),{status:409});
   }
   if(mode==='missing'||mode==='race')throw Object.assign(Error('tombstone'),{status:404});
   const {task}=x.dispatcher.task({...job,kind:'stage'});if(mode==='basic')delete task.httpRequest.body;else task.httpRequest.url='https://wrong.run.app/tasks/run';return task;
  };
  const result=await x.dispatcher.enqueue(job);assert.equal(result.status,mode==='race'?'sent':'uncertain');
 }
});
test('HTTP control reaches acquisition only and admits without opening provider adapters',async()=>{
 const x=setup([reel('Reel_ONE')]),{operation}=await x.service.command({type:'start',idempotencyKey:'http-control-allowed',selection:{all:true}});
 const task=[...x.tasks.values()][0],body=JSON.parse(Buffer.from(task.httpRequest.body,'base64'));
 let providers=0;const dependencies={...x,storage:{},tools:{},operationsFactory:()=>{providers++;assert.fail('control cannot call providers');}};
 const config={project,reels_runtime_version:'v2',reels_processing_enabled:true,stage_routes:routes};
 const runtime=reelsGoogleRuntime(config,{}, {stage:'acquisition',authorize:()=>true,dependencies}),server=workerHTTP(runtime);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/tasks/control',{method:'POST',body:JSON.stringify(body)});
  assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');assert.equal(providers,0);
  assert.equal((await x.service.operation(operation.id)).operation.accepted.length,1);
  const wrong=reelsGoogleRuntime(config,{}, {stage:'transcription',authorize:()=>true,dependencies});
  assert.equal((await wrong(new Request('https://transcription.run.app/tasks/control',{method:'POST',body:JSON.stringify(body)}))).status,409);
 }finally{await new Promise(resolve=>server.close(resolve));}
});


test('explicit resume redrives an exhausted sent task with the same queued execution and no paid replay',async()=>{
 const x=setup([reel('Reel_ONE')]),started=await x.service.command({type:'start',idempotencyKey:'initial-paused-task',selection:{ids:['Reel_ONE']}});
 const runner=new ReelsCommandRunner({service:x.service,dispatcher:x.dispatcher,enabled:true,pageSize:1});
 await runner.run({operationId:started.operation.id});
 const id=executionId(started.operation.id,'Reel_ONE','acquisition'),prior=await x.store.get('reels_executions/'+id);
 const oldTask=[...x.tasks.values()].find(t=>t.httpRequest.url.endsWith('/tasks/run')),oldBody=JSON.parse(Buffer.from(oldTask.httpRequest.body,'base64'));
 assert.equal((await x.store.get('reels_command_items/'+oldBody.outboxId)).data.status,'sent');
 x.tasks.delete(oldTask.name); // Synthetic Cloud Tasks retry exhaustion/tombstone.
 await x.store.create('reels_controls/acquisition',{id:'acquisition',paused:true,desiredConcurrency:1,active:[],appliedCommands:[]});
 const preserved=[];
 for(const [n,status]of ['submitting','waiting','uncertain','queued'].entries()){
  const reelId='Blocked_'+n,operationId=hash('blocked-operation-'+n),jobId=executionId(operationId,reelId,'acquisition');
  await x.store.create('videos/'+reelId,{id:reelId,status:'registered',...(status==='queued'?{import_hold:{active:true}}:{}),reels_v2:{status,stage:'acquisition',executionId:jobId,operationId}});
  const job={id:jobId,operationId,reelId,stage:'acquisition',status};await x.store.create('reels_executions/'+jobId,job);preserved.push(job);
 }
 for(const [field,value]of [['rawResult',{changes:{transcript:'already saved'}}],['operationName','projects/fake/locations/us/operations/existing'],['owner','claimed-owner'],['submittedAt','2026-10-17T03:00:00Z']]){
  const reelId='Saved_'+field,operationId=hash('saved-'+field),jobId=executionId(operationId,reelId,'acquisition');
  await x.store.create('videos/'+reelId,{id:reelId,reels_v2:{status:'queued',stage:'acquisition',executionId:jobId,operationId}});
  const job={id:jobId,operationId,reelId,stage:'acquisition',status:'queued',[field]:value};
  await x.store.create('reels_executions/'+jobId,job);preserved.push(job);
 }
 await x.store.create('reels_executions/legacy_queued',{id:'legacy_queued',operationId:'legacy',reelId:'Reel_ONE',stage:'acquisition',status:'queued'});
 const input={type:'resume',stage:'acquisition',idempotencyKey:'explicit-queue-redrive'},resumed=await x.service.command(input);
 assert.equal(resumed.operation.status,'pending');assert.deepEqual(resumed.operation.selected,[id]);assert.equal(resumed.operation.admissionMode,'queued_redrive');
 assert.equal((await x.store.get('reels_controls/acquisition')).data.paused,false);
 await runner.run({operationId:resumed.operation.id});
 assert.equal((await x.store.get('reels_executions/'+id)).updateTime,prior.updateTime,'redrive cannot reset or rewrite the execution');
 const freshTask=[...x.tasks.values()].find(t=>t.httpRequest.url.endsWith('/tasks/run'));
 const freshBody=JSON.parse(Buffer.from(freshTask.httpRequest.body,'base64'));
 assert.equal(freshBody.executionId,id);assert.notEqual(freshTask.name,oldTask.name);assert.notEqual(freshBody.outboxId,oldBody.outboxId);
 assert.equal((await x.store.get('reels_command_items/'+freshBody.outboxId)).data.redriveId,resumed.operation.id);
 const tasksBeforeReplay=x.tasks.size;await x.service.command(input);assert.equal(x.tasks.size,tasksBeforeReplay);
 for(const job of preserved)assert.deepEqual((await x.store.get('reels_executions/'+job.id)).data,job);
 let paid=0;const runtime=reelsGoogleRuntime({project,reels_runtime_version:'v2',reels_processing_enabled:true,stage_routes:routes},{},{stage:'acquisition',authorize:()=>true,dependencies:{...x,storage:{metadata:async()=>null},tools:{},operationsFactory:()=>({upload:async()=>{paid++;return {changes:{video_key:'synthetic-preserved'}};}})}});
 for(const body of [freshBody,freshBody,oldBody]){
  const response=await runtime(new Request('https://acquisition.run.app/tasks/run',{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,200);
 }
 assert.equal(paid,1);assert.equal((await x.store.get('reels_executions/'+id)).data.status,'completed');
});
