import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {WorkerQueue,workerHandler,validateTask} from '../lib/worker-queue.mjs';
import {stageBoundFlow} from '../lib/stage-contract.mjs';
import {transcriptionRuntime} from '../lib/stage-transcription.mjs';

const videoId='Reel_1',project='megabrain-v0-1017370021431';
const operationName='projects/'+project+'/locations/global/operations/offline_123';
const routes={
  upload:{queue:'v0-acquisition',workerOrigin:'https://v0-acquisition-test.run.app'},
  transcription:{queue:'v0-transcription',workerOrigin:'https://v0-transcription-test.run.app'},
  analysis:{queue:'v0-analysis',workerOrigin:'https://v0-analysis-test.run.app'}
};
const transcriptionTask={videoId,stage:'transcription',poll:0};
const result=(changes={transcript:'Transcrição persistida'})=>({video_id:videoId,stage:'transcription',actual_cents:5,changes});
const request=task=>new Request(routes.transcription.workerOrigin+'/tasks/run',{method:'POST',body:JSON.stringify(task)});
async function delivery(f,task=transcriptionTask){
  const response=await f.handler(request(task));return {code:response.status,body:await response.json()};
}
function fixture(operations={}){
  let version=0;const now=Date.now(),docs=new Map(),events=[],sent=[];
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true});
  seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,
    ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),
    remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),
    credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
  seed('videos/'+videoId,{media_verified:true,audio_status:'present'});
  const store={
    async get(path){events.push(['get',path]);return structuredClone(docs.get(path)??null);},
    async create(path,data){events.push(['create',path]);if(docs.has(path))return {created:false};seed(path,data);return {created:true};},
    async patch(path,changes,{updateTime}){
      events.push(['patch',path,structuredClone(changes)]);
      if(docs.get(path)?.updateTime!==updateTime)throw Error('CAS conflict');
      seed(path,{...docs.get(path).data,...changes});return this.get(path);
    }
  };
  const api={project,async request(url,options){
    events.push(['dispatch',url]);sent.push(structuredClone(options.json.task));
  }};
  const ledger=new FinancialLedger(store,{clock:()=>now});
  const flow=new WorkerFlow({store,ledger,operations,quotes:{upload:10,transcription:10,analysis:10},clock:()=>now});
  const bound=stageBoundFlow(flow,'transcription');
  const queue=new WorkerQueue({api,store,stageRoutes:routes,workerOrigin:routes.transcription.workerOrigin,enabled:true,clock:()=>now});
  const handler=workerHandler({flow:bound,queue,stage:'transcription',authorize:async()=>true});
  return {store,docs,events,sent,flow,bound,queue,handler,seed};
}
const payload=task=>JSON.parse(Buffer.from(task.httpRequest.body,'base64').toString());
const jobPath='jobs/'+executionId(videoId,'transcription');

test('dedicated factory requires the server transcription role and stays closed when disabled',async()=>{
  const config={project,cost_accounting:'conservative_estimate_not_invoice',assisted_upload_enabled:false,
    worker_stage:'transcription',stage_routes:routes,worker_origin:routes.transcription.workerOrigin,
    enabled:false,admission_enabled:false,dispatch_enabled:false,quotes:{upload:10,transcription:10,analysis:10}};
  const preset={version:'megabrain-video-text-v3'};
  const flow=transcriptionRuntime(config,preset,{withHandler:false});
  await assert.rejects(flow.run({videoId,stage:'upload'}));
  assert.equal((await flow.run(transcriptionTask)).status,'blocked');
  assert.throws(()=>transcriptionRuntime({...config,worker_stage:'analysis'},preset));
  assert.throws(()=>transcriptionRuntime({...config,assisted_upload_enabled:true},preset));
});

test('STT submission persists its operation before dispatching a poll to the transcription queue',async()=>{
  let submits=0;
  const f=fixture({transcription:async()=>{submits++;return {video_id:videoId,stage:'transcription',operation_name:operationName};}});
  assert.deepEqual((await delivery(f)).body,{status:'waiting',dispatch:'queued',poll_limit:false});
  assert.equal(submits,1);
  assert.equal((await f.store.get(jobPath)).data.operation_name,operationName);
  assert.equal((await f.store.get('settings/financial')).data.reserved_cents,10);
  const queued=f.sent[0];
  assert.match(queued.name,/\/queues\/v0-transcription\/tasks\/dispatch_/);
  assert.equal(queued.httpRequest.url,routes.transcription.workerOrigin+'/tasks/run');
  assert.equal(queued.httpRequest.oidcToken.audience,routes.transcription.workerOrigin);
  assert.deepEqual(payload(queued),{videoId,stage:'transcription',poll:1});
  const persisted=f.events.findIndex(e=>e[0]==='patch'&&e[1]===jobPath&&e[2].operation_name===operationName);
  assert.ok(persisted>=0&&persisted<f.events.findIndex(e=>e[0]==='dispatch'));
});

test('pending polls use the persisted operation and never resubmit STT or reserve again',async()=>{
  let submits=0,polls=0;
  const f=fixture({
    transcription:async()=>{submits++;return {video_id:videoId,stage:'transcription',operation_name:operationName};},
    pollTranscription:async input=>{polls++;assert.equal(input.operationName,operationName);return {video_id:videoId,stage:'transcription',pending:true};}
  });
  await delivery(f);await delivery(f);
  await delivery(f,{videoId,stage:'transcription',poll:1});
  assert.equal(submits,1);assert.equal(polls,1);assert.equal(f.sent.length,2);
  assert.deepEqual(f.sent.map(payload).map(t=>t.poll),[1,2]);
  assert.ok(f.sent.every(t=>t.name.includes('/queues/v0-transcription/')));
  const financial=(await f.store.get('settings/financial')).data;
  assert.equal(financial.reserved_cents,10);assert.equal(financial.spent_cents,0);
  assert.equal(Object.keys(financial.jobs).length,1);
});

test('completed poll saves transcript and settlement before its analysis handoff',async()=>{
  let submits=0,polls=0;
  const f=fixture({
    transcription:async()=>{submits++;return {video_id:videoId,stage:'transcription',operation_name:operationName};},
    pollTranscription:async()=>{polls++;return result();}
  });
  await delivery(f);
  const response=await delivery(f,{videoId,stage:'transcription',poll:1});
  assert.equal(response.body.status,'completed');assert.equal(submits,1);
  assert.equal((await f.store.get('videos/'+videoId)).data.transcript,'Transcrição persistida');
  assert.equal((await f.store.get(jobPath)).data.status,'completed');
  const financial=(await f.store.get('settings/financial')).data;
  assert.equal(financial.reserved_cents,0);assert.equal(financial.spent_cents,5);
  assert.deepEqual(payload(f.sent[1]),{videoId,stage:'analysis',poll:0});
  assert.match(f.sent[1].name,/\/queues\/v0-analysis\/tasks\/dispatch_/);
  assert.equal(f.sent[1].httpRequest.oidcToken.audience,routes.analysis.workerOrigin);
  const lastDispatch=f.events.findLastIndex(e=>e[0]==='dispatch');
  for(const predicate of [
    e=>e[0]==='patch'&&e[1]==='videos/'+videoId&&e[2].transcript==='Transcrição persistida',
    e=>e[0]==='patch'&&e[1]===jobPath&&e[2].status==='completed'
  ]){const persisted=f.events.findIndex(predicate);assert.ok(persisted>=0&&persisted<lastDispatch);}
  assert.equal((await delivery(f,{videoId,stage:'transcription',poll:1})).body.dispatch,'duplicate');
  assert.equal(submits,1);assert.equal(polls,1);assert.equal(f.sent.length,2);
  assert.deepEqual((await f.store.get('settings/financial')).data,financial);
});

test('completed duplicate delivery reuses the result, payment and deterministic analysis task',async()=>{
  let submits=0;const f=fixture({transcription:async()=>{submits++;return result();}});
  await delivery(f);const financial=await f.store.get('settings/financial');
  const duplicate=await delivery(f);
  assert.equal(duplicate.body.status,'completed');assert.equal(duplicate.body.dispatch,'duplicate');
  assert.equal(submits,1);assert.equal(f.sent.length,1);
  assert.deepEqual(await f.store.get('settings/financial'),financial);
  assert.equal((await f.store.get('videos/'+videoId)).data.transcript,'Transcrição persistida');
});

test('concurrent duplicate submissions claim one paid operation',async()=>{
  let submits=0;const f=fixture({transcription:async()=>{submits++;return result();}});
  const responses=await Promise.all([delivery(f),delivery(f)]);
  assert.equal(submits,1);assert.ok(responses.some(r=>r.body.status==='completed'));
  assert.equal(f.sent.length,1);assert.equal((await f.store.get('settings/financial')).data.spent_cents,5);
});

for(const phase of ['submit','poll','persist'])test(phase+' uncertainty never forwards to analysis or resubmits',async()=>{
  let submits=0,polls=0;
  const f=fixture({
    transcription:async()=>{submits++;if(phase==='submit')throw Error('offline timeout');return {video_id:videoId,stage:'transcription',operation_name:operationName};},
    pollTranscription:async()=>{polls++;if(phase==='poll')throw Error('offline poll failure');return result();}
  });
  if(phase==='persist'){
    const patch=f.store.patch.bind(f.store);
    f.store.patch=async(path,changes,options)=>{
      if(path==='videos/'+videoId&&changes.transcript!==undefined)throw Error('offline persist failure');
      return patch(path,changes,options);
    };
  }
  let response=await delivery(f);
  if(phase!=='submit')response=await delivery(f,{videoId,stage:'transcription',poll:1});
  assert.equal(response.body.status,'uncertain');assert.equal(response.body.dispatch,null);
  await delivery(f);await delivery(f,{videoId,stage:'transcription',poll:2});
  assert.equal(submits,1);assert.equal(polls,phase==='submit'?0:1);
  assert.ok(f.sent.every(t=>payload(t).stage==='transcription'));
  const financial=(await f.store.get('settings/financial')).data;
  assert.equal(financial.paused,true);assert.equal(financial.reserved_cents,10);assert.equal(financial.spent_cents,0);
});

test('persisted completed empty speech artifact is reused and handed off without invented text',async()=>{
  const artifact='results/instagram/'+videoId+'/'+executionId(videoId,'transcription')+'/transcription.json';
  const f=fixture({transcription:async()=>result({transcript:'',transcript_status:'no_speech_recognized',transcript_key:artifact,transcript_generation:'123'})});
  assert.equal((await delivery(f)).body.status,'completed');
  const video=(await f.store.get('videos/'+videoId)).data;
  assert.equal(video.transcript,'');assert.equal(video.transcript_key,artifact);
  assert.equal(video.transcript_status,'no_speech_recognized');
  assert.deepEqual(payload(f.sent[0]),{videoId,stage:'analysis',poll:0});
});

test('empty speech without its own persisted artifact remains uncertain',async()=>{
  const f=fixture({transcription:async()=>result({transcript:'',transcript_status:'no_speech_recognized'})});
  assert.equal((await delivery(f)).body.status,'uncertain');assert.equal(f.sent.length,0);
  assert.equal((await f.store.get('videos/'+videoId)).data.transcript,undefined);
});

test('wrong-stage tasks and foreign polls fail before storage, providers or queue',async()=>{
  let calls=0;const f=fixture({upload:async()=>{calls++;},analysis:async()=>{calls++;},transcription:async()=>{calls++;}});
  for(const task of [{videoId,stage:'upload',poll:0},{videoId,stage:'analysis',poll:0},
    {videoId,stage:'upload',poll:1},{videoId,stage:'analysis',poll:1}]){
    const response=await delivery(f,task);assert.ok(response.code>=400);
  }
  assert.equal(calls,0);assert.equal(f.events.length,0);assert.equal(f.sent.length,0);
  await assert.rejects(f.bound.run({videoId,stage:'analysis'}));assert.equal(f.events.length,0);
});

test('missing audio and paused controls preserve current pre-STT blocks',async()=>{
  for(const scenario of ['audio','paused']){
    let calls=0;const f=fixture({transcription:async()=>{calls++;return result();}});
    if(scenario==='audio')f.seed('videos/'+videoId,{media_verified:true,audio_status:'missing'});
    else f.seed('settings/automation',{enabled:false,transcription_enabled:true});
    const response=await delivery(f);
    assert.equal(response.body.status,scenario==='audio'?'blocked':'paused');
    assert.equal(calls,0);assert.equal(f.sent.length,0);
    assert.equal((await f.store.get('settings/financial')).data.reserved_cents,0);
  }
});

test('poll limit stays held in transcription and cannot schedule another stage',async()=>{
  const f=fixture({
    transcription:async()=>({video_id:videoId,stage:'transcription',operation_name:operationName}),
    pollTranscription:async()=>({video_id:videoId,stage:'transcription',pending:true})
  });
  await delivery(f);const response=await delivery(f,{videoId,stage:'transcription',poll:120});
  assert.equal(response.body.status,'waiting');assert.equal(response.body.poll_limit,true);
  assert.equal(response.body.dispatch,null);assert.equal(f.sent.length,1);
});

test('legacy parser and unbound handler still accept the original stage tasks',async()=>{
  const seen=[],sent=[];
  const handler=workerHandler({authorize:async()=>true,flow:{
    async run(task){seen.push(task.stage);return {status:'completed'};},async poll(){seen.push('poll');return {status:'waiting'};}
  },queue:{async enqueue(task){sent.push(task);return {status:'queued'};}}});
  for(const stage of ['upload','transcription','analysis']){
    const task={videoId,stage,poll:0};assert.deepEqual(validateTask(task),task);
    assert.equal((await handler(request(task))).status,200);
  }
  assert.deepEqual(seen,['upload','transcription','analysis']);
  assert.deepEqual(sent.map(t=>t.stage),['transcription','analysis']);
  for(const malformed of [{...transcriptionTask,poll:121},{...transcriptionTask,stage:'analysis',poll:1},
    {...transcriptionTask,worker_stage:'transcription'},{...transcriptionTask,operation_name:operationName}])
    assert.throws(()=>validateTask(malformed));
});
