import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerQueue,workerHandler} from '../lib/worker-queue.mjs';
const project='megabrain-v0-1017370021431';
const routes=()=>({upload:{queue:'v0-acquisition',workerOrigin:'https://upload-stage.run.app'},transcription:{queue:'v0-transcription',workerOrigin:'https://transcription-stage.run.app'},analysis:{queue:'v0-analysis',workerOrigin:'https://analysis-stage.run.app'}});
function fixture({stageRoutes=routes(),error=null}={}){
  const docs=new Map(),sent=[];let version=0;
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  const store={async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async get(path){return structuredClone(docs.get(path)??null);},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);seed(path,{...docs.get(path).data,...changes});}};
  const api={project,async request(url,options){sent.push({url,task:options.json.task});if(error)throw error;}};
  const queue=new WorkerQueue({api,store,stageRoutes,workerOrigin:'https://legacy-worker.run.app',enabled:true,clock:()=>0});
  return {queue,store,sent,seed,docs};
}
test('each stage has its fixed queue, private destination and audience with stable dispatch identity',async()=>{
  const f=fixture(),r=routes();
  for(const stage of Object.keys(r)){
    const task={videoId:'Reel_123',stage,poll:0};
    assert.equal((await f.queue.enqueue(task)).status,'queued');
    assert.equal((await f.queue.enqueue(task)).status,'duplicate');
    const sent=f.sent.at(-1),expected=`projects/${project}/locations/us-central1/queues/${r[stage].queue}`;
    assert.equal(sent.url,`https://cloudtasks.googleapis.com/v2/${expected}/tasks`);
    assert.equal(sent.task.name,`${expected}/tasks/${f.queue.dispatchPath(task).slice(5)}`);
    assert.equal(sent.task.httpRequest.url,`${r[stage].workerOrigin}/tasks/run`);
    assert.deepEqual(sent.task.httpRequest.oidcToken,{serviceAccountEmail:`v0-queue@${project}.iam.gserviceaccount.com`,audience:r[stage].workerOrigin});
    assert.deepEqual(JSON.parse(Buffer.from(sent.task.httpRequest.body,'base64')),task);
    assert.equal(sent.task.scheduleTime,'1970-01-01T00:00:00.000Z');
    assert.equal((await f.store.get(f.queue.dispatchPath(task))).data.status,'queued');
  }
  assert.equal(f.sent.length,3);
});
test('route validation rejects missing, extra, swapped, duplicate and non-private destinations',()=>{
  const invalid=[null,[],{}, {...routes(),media:routes().upload}];
  for(const change of [r=>delete r.upload,r=>r.upload.queue='v0-transcription',r=>r.upload.workerOrigin=r.analysis.workerOrigin,r=>r.analysis.extra=true,r=>r.upload.workerOrigin='http://upload-stage.run.app',r=>r.upload.workerOrigin='https://example.com',r=>r.upload.workerOrigin='https://upload-stage.run.app/path',r=>r.upload.workerOrigin='https://upload-stage.run.app/',r=>r.upload.workerOrigin='https://user@upload-stage.run.app',r=>r.upload.queue=`projects/other/locations/europe-west1/queues/v0-acquisition`]){const r=routes();change(r);invalid.push(r);}
  for(const stageRoutes of invalid.filter(value=>value!==null))assert.throws(()=>fixture({stageRoutes}));
  assert.throws(()=>new WorkerQueue({api:{project:'other'},store:{},stageRoutes:routes(),workerOrigin:'https://legacy-worker.run.app'}));
});
test('stage routes are copied and immutable after construction',async()=>{
  const input=routes(),f=fixture({stageRoutes:input});input.upload.workerOrigin='https://changed.run.app';
  assert.throws(()=>{f.queue.stageRoutes.upload.workerOrigin='https://changed.run.app';});
  assert.throws(()=>{f.queue.stageRoutes=null;});
  await f.queue.enqueue({videoId:'Reel_123',stage:'upload',poll:0});
  assert.equal(f.sent[0].task.httpRequest.url,'https://upload-stage.run.app/tasks/run');
});
test('transcription polls stay in transcription queue with a one-minute delay',async()=>{
  const f=fixture();let polls=0;
  const handler=workerHandler({stage:'transcription',authorize:async()=>true,queue:f.queue,flow:{async poll(){polls++;return {status:'waiting'};},async run(){throw Error('poll must not submit');}}});
  const response=await handler(new Request('https://transcription-stage.run.app/tasks/run',{method:'POST',body:JSON.stringify({videoId:'Reel_123',stage:'transcription',poll:1})}));
  assert.equal((await response.json()).dispatch,'queued');assert.equal(polls,1);
  assert.match(f.sent[0].task.name,/queues\/v0-transcription\/tasks\//);
  assert.equal(f.sent[0].task.scheduleTime,'1970-01-01T00:01:00.000Z');
  assert.equal(f.sent[0].task.httpRequest.oidcToken.audience,routes().transcription.workerOrigin);
  assert.equal(JSON.parse(Buffer.from(f.sent[0].task.httpRequest.body,'base64')).poll,2);
});
test('uncertain task creation preserves outbox and never replays; definite409 is recorded queued',async()=>{
  for(const error of [Error('unknown receipt'),Object.assign(Error('already exists'),{status:409})]){
    const f=fixture({error}),task={videoId:'Reel_123',stage:'upload',poll:0};
    const expected=error.status===409?'queued':'uncertain';
    assert.equal((await f.queue.enqueue(task)).status,expected);
    assert.equal((await f.store.get(f.queue.dispatchPath(task))).data.status,expected);
    assert.equal((await f.queue.enqueue(task)).status,'duplicate');assert.equal(f.sent.length,1);
  }
});
test('old or conflicting queue outboxes require explicit migration without mutation or replay',async()=>{
  for(const queueName of ['v0-processing','v0-analysis'])for(const status of ['creating','queued','uncertain']){
    const f=fixture(),task={videoId:'Reel_123',stage:'upload',poll:0},path=f.queue.dispatchPath(task);
    f.seed(path,{kind:'dispatch',status,task_name:`projects/${project}/locations/us-central1/queues/${queueName}/tasks/${path.slice(5)}`,payload:task});
    const before=await f.store.get(path);
    assert.deepEqual(await f.queue.enqueue(task),{status:'blocked',reason:'requires_queue_migration'});
    assert.deepEqual(await f.store.get(path),before);assert.equal(f.sent.length,0);
  }
});
test('legacy queue and stage routing retain identical dispatch ids, including recovery identities',async()=>{
  const legacy=fixture({stageRoutes:null}),staged=fixture();
  for(const extras of [{},{recoveryId:'recovery_upload_20261013',recoverUpload:true},{recoveryId:'recovery_metadata_20261013',recoverFirestoreWrite:true},{recoveryId:'recovery_settled_20261013',recoverSettled:true}]){
    const task={videoId:'Reel_123',stage:'upload',poll:0,...extras};
    assert.equal(legacy.queue.dispatchPath(task),staged.queue.dispatchPath(task));
    await legacy.queue.enqueue(task);await staged.queue.enqueue(task);
    assert.equal(legacy.sent.at(-1).task.name.split('/').at(-1),staged.sent.at(-1).task.name.split('/').at(-1));
    assert.match(legacy.sent.at(-1).task.name,/queues\/v0-processing\/tasks\//);
    assert.equal(legacy.sent.at(-1).task.httpRequest.oidcToken.audience,'https://legacy-worker.run.app');
  }
});
test('admission ticks only target acquisition with that destination audience',async()=>{
  const f=fixture(),task={batchId:'pilot_30_oct12',runId:'admission_run_20261013',tick:1};
  await f.queue.enqueueAdmission(task);await f.queue.enqueueAdmission(task);
  assert.equal(f.sent[0].task.name,f.sent[1].task.name);
  assert.match(f.sent[0].task.name,/queues\/v0-acquisition\/tasks\/admit_/);
  assert.equal(f.sent[0].task.httpRequest.url,'https://upload-stage.run.app/tasks/admit');
  assert.equal(f.sent[0].task.httpRequest.oidcToken.audience,'https://upload-stage.run.app');
});
test('queue migration block is visible to the delivering worker',async()=>{
  const f=fixture(),next={videoId:'Reel_123',stage:'transcription',poll:0},path=f.queue.dispatchPath(next);
  f.seed(path,{task_name:`projects/${project}/locations/us-central1/queues/v0-processing/tasks/${path.slice(5)}`,status:'uncertain'});
  const handler=workerHandler({stage:'upload',authorize:async()=>true,queue:f.queue,flow:{async run(){return {status:'completed'};}}});
  const response=await handler(new Request('https://upload-stage.run.app/tasks/run',{method:'POST',body:JSON.stringify({videoId:'Reel_123',stage:'upload',poll:0})}));
  const body=await response.json();assert.equal(body.dispatch,'blocked');assert.equal(body.dispatch_reason,'requires_queue_migration');assert.equal(f.sent.length,0);
});
