import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {WorkerQueue,workerHandler} from '../lib/worker-queue.mjs';
import {uploadRuntime} from '../lib/stage-upload.mjs';
const project='megabrain-v0-1017370021431';
const stageRoutes=()=>({upload:{queue:'v0-acquisition',workerOrigin:'https://upload-stage.run.app'},transcription:{queue:'v0-transcription',workerOrigin:'https://transcription-stage.run.app'},analysis:{queue:'v0-analysis',workerOrigin:'https://analysis-stage.run.app'}});
const request=task=>new Request('https://upload-stage.run.app/tasks/run',{method:'POST',body:JSON.stringify({videoId:'Reel_123',stage:'upload',poll:0,...task})});
function fixture({failUpload=false,failPersist=false,failSettle=false}={}){
  const docs=new Map(),sent=[];let version=0,downloads=0,paidCalls=0;const now=Date.now();
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true});
  seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
  seed('videos/Reel_123',{media_verified:false});
  const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);if(failPersist&&path==='videos/Reel_123'&&changes.media_verified)throw Error('persist unavailable');seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
  const ledger=new FinancialLedger(store,{clock:()=>now});
  if(failSettle){const transition=ledger.transition.bind(ledger);ledger.transition=(id,event,options)=>{if(event==='complete')throw Error('settlement unavailable');return transition(id,event,options);};}
  const flow=new WorkerFlow({store,ledger,quotes:{upload:10,transcription:10,analysis:10},clock:()=>now,operations:{async upload(){downloads++;if(failUpload)throw Error('download failed');return {video_id:'Reel_123',stage:'upload',actual_cents:4,changes:{video_key:'originals/instagram/Reel_123/video.mp4',video_generation:'123',video_bytes:3,media_verified:true,audio_status:'present',duration_seconds:2}};},async transcription(){paidCalls++;throw Error('wrong stage');},async analysis(){paidCalls++;throw Error('wrong stage');}}});
  const api={project,async request(url,options){
    // Result, financial settlement and completed job must precede handoff.
    assert.equal((await store.get('videos/Reel_123')).data.video_generation,'123');
    assert.equal((await store.get('jobs/'+executionId('Reel_123','upload'))).data.status,'completed');
    assert.equal((await store.get('settings/financial')).data.jobs[executionId('Reel_123','upload')].status,'completed');
    sent.push({url,task:options.json.task});
  }};
  const queue=new WorkerQueue({api,store,workerOrigin:stageRoutes().upload.workerOrigin,stageRoutes:stageRoutes(),enabled:true});
  const handler=workerHandler({flow,queue,stage:'upload',authorize:async()=>true});
  return {store,handler,sent,downloads:()=>downloads,paidCalls:()=>paidCalls};
}
test('upload persists verified media and completes settlement before deterministic transcription handoff',async()=>{
  const f=fixture();
  let response=await f.handler(request());assert.equal(response.status,200);assert.equal((await response.json()).dispatch,'queued');
  response=await f.handler(request());assert.equal((await response.json()).dispatch,'duplicate');
  assert.equal(f.downloads(),1);assert.equal(f.paidCalls(),0);assert.equal(f.sent.length,1);
  assert.match(f.sent[0].task.name,/queues\/v0-transcription\/tasks\/dispatch_/);
  assert.equal(f.sent[0].task.httpRequest.url,'https://transcription-stage.run.app/tasks/run');
  assert.deepEqual(JSON.parse(Buffer.from(f.sent[0].task.httpRequest.body,'base64')),{videoId:'Reel_123',stage:'transcription',poll:0});
});
for(const variant of ['failUpload','failPersist','failSettle'])test(`upload ${variant} retains uncertain reservation and cannot launch successor or replay`,async()=>{
  const f=fixture({[variant]:true});
  const response=await f.handler(request()),body=await response.json();
  assert.equal(body.status,'uncertain');assert.equal(body.dispatch,null);assert.equal(f.sent.length,0);
  const financial=(await f.store.get('settings/financial')).data;
  assert.equal(financial.reserved_cents,10);assert.equal(financial.spent_cents,0);assert.equal(financial.paused,true);
  await f.handler(request());assert.equal(f.downloads(),1);assert.equal(f.paidCalls(),0);assert.equal(f.sent.length,0);
});
test('upload role rejects foreign stages after authorization and validation before any flow or queue call',async()=>{
  let allowed=true,authCalls=0,flowCalls=0,queueCalls=0;
  const handler=workerHandler({stage:'upload',authorize:async()=>{authCalls++;return allowed;},flow:{async run(){flowCalls++;},async poll(){flowCalls++;}},queue:{async enqueue(){queueCalls++;}}});
  for(const stage of ['transcription','analysis']){
    const response=await handler(request({stage}));assert.equal(response.status,409);assert.deepEqual(await response.json(),{status:'blocked',reason:'wrong_stage'});
  }
  assert.equal((await handler(request({stage:'transcription',poll:1}))).status,409);
  assert.equal((await handler(request({stage:'analysis',poll:1}))).status,400);
  allowed=false;assert.equal((await handler(request({stage:'analysis'}))).status,401);
  assert.equal(authCalls,5);assert.equal(flowCalls,0);assert.equal(queueCalls,0);
});
for(const status of ['waiting','blocked','paused','uncertain','source_held','failed'])test(`upload ${status} cannot hand off without completion`,async()=>{
  let enqueued=0;
  const handler=workerHandler({stage:'upload',authorize:async()=>true,flow:{async run(){return {status};}},queue:{async enqueue(){enqueued++;}}});
  const body=await (await handler(request())).json();assert.equal(body.status,status);assert.equal(body.dispatch,null);assert.equal(enqueued,0);
});
test('upload runtime factory is offline, bound to upload and rejects mismatched config',async()=>{
  const config={project,enabled:false,uploads_enabled:false,downloads_enabled:false,dispatch_enabled:false,admission_enabled:false,assisted_upload_enabled:false,assisted_single_upload_enabled:false,worker_stage:'upload',worker_origin:stageRoutes().upload.workerOrigin,stage_routes:stageRoutes(),quotes:{upload:10,transcription:10,analysis:10},cost_accounting:'conservative_estimate_not_invoice',pilot_video_ids:[]};
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('external calls forbidden');};
  try{
    const handler=uploadRuntime(config,{version:'test'});assert.equal(typeof handler,'function');
    assert.equal((await handler(request())).status,401);
    const flow=uploadRuntime(config,{version:'test'},{withHandler:false});
    await assert.rejects(flow.run({videoId:'Reel_123',stage:'analysis',poll:0}),/etapa fixa/);
    assert.equal((await flow.run({videoId:'Reel_123',stage:'upload',poll:0})).status,'blocked');
    assert.throws(()=>uploadRuntime({...config,worker_stage:'analysis'},{version:'test'}));
    assert.throws(()=>uploadRuntime({...config,assisted_upload_enabled:true},{version:'test'}));
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
