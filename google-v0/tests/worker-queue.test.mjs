import test from 'node:test';import assert from 'node:assert/strict';
import {WorkerQueue,workerHandler} from '../lib/worker-queue.mjs';
test('private dispatch records intent once, uses own OIDC and chains stages without exposing anonymous execution',async()=>{
  const docs=new Map();let creates=0,runs=0;const sent=[];
  const store={async create(p,data){if(docs.has(p))return {created:false};docs.set(p,{data,updateTime:'1'});return {created:true};},async get(p){return docs.get(p);},async patch(p,c){docs.set(p,{data:{...docs.get(p).data,...c},updateTime:'2'});}};
  const api={project:'megabrain-v0-1017370021431',async request(url,options){creates++;sent.push(options.json.task);}};
  const queue=new WorkerQueue({api,store,workerOrigin:'https://v0-worker-test.run.app',enabled:true,clock:()=>0});
  const flow={async run(){runs++;return {status:'completed'};},async poll(){return {status:'waiting'};}};
  let allowed=false;const handler=workerHandler({flow,queue,authorize:async()=>allowed});
  const request=task=>new Request('https://v0-worker-test.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)});
  const task={videoId:'Reel_123',stage:'upload',poll:0};
  assert.equal((await handler(request(task))).status,401);assert.equal(runs,0);allowed=true;
  assert.equal((await (await handler(request(task))).json()).dispatch,'queued');
  await handler(request(task));assert.equal(creates,1);
  assert.equal(sent[0].httpRequest.oidcToken.serviceAccountEmail,'v0-queue@megabrain-v0-1017370021431.iam.gserviceaccount.com');
  assert.equal(JSON.parse(Buffer.from(sent[0].httpRequest.body,'base64')).stage,'transcription');
  await handler(request({videoId:'Reel_123',stage:'transcription',poll:1}));
  assert.equal(sent[1].scheduleTime,'1970-01-01T00:01:00.000Z');
  assert.equal((await (await handler(request({videoId:'Reel_123',stage:'transcription',poll:120}))).json()).poll_limit,true);
  assert.equal(creates,2);
  api.request=async()=>{creates++;throw new Error('timeout');};
  assert.equal((await queue.enqueue({videoId:'Reel_456',stage:'upload',poll:0})).status,'uncertain');
  assert.equal((await queue.enqueue({videoId:'Reel_456',stage:'upload',poll:0})).status,'duplicate');assert.equal(creates,3);
});

test('429 recovery dispatch is explicit, analysis-only and uses its own recovery identity',async()=>{
 const {validateTask}=await import('../lib/worker-queue.mjs');
 assert.doesNotThrow(()=>validateTask({videoId:'Reel_1',stage:'analysis',poll:0,recoveryId:'recovery429_20261013',recoverAnalysis429:true}));
 for(const task of [{stage:'upload',poll:0,recoveryId:'recovery429_20261013'},{stage:'analysis',poll:0},{stage:'transcription',poll:1,recoveryId:'recovery429_20261013'}])assert.throws(()=>validateTask({videoId:'Reel_1',...task,recoverAnalysis429:true}));
});

test('upload recovery task is upload-only, explicitly identified and never accepts mixed recovery flags',async()=>{
 const {validateTask}=await import('../lib/worker-queue.mjs');
 assert.doesNotThrow(()=>validateTask({videoId:'Reel_1',stage:'upload',poll:0,recoveryId:'recovery_upload_20261013',recoverUpload:true}));
 for(const task of [{stage:'analysis',poll:0,recoveryId:'recovery_upload_20261013'},{stage:'upload',poll:0},{stage:'upload',poll:0,recoveryId:'recovery_upload_20261013',recoverAnalysis429:true}])assert.throws(()=>validateTask({videoId:'Reel_1',...task,recoverUpload:true}));
});
