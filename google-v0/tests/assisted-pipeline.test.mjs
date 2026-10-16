import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pipelineFlow} from '../lib/assisted-pipeline.mjs';
import {assertAssistedScope,assertAssistedObject} from '../lib/assisted-scope.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {StorageCapacity} from '../lib/storage-capacity.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';
import {WorkerQueue,workerHandler,validateTask} from '../lib/worker-queue.mjs';
import {stageBoundFlow} from '../lib/stage-contract.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {sha256} from '../lib/storage.mjs';

const stages=['upload','transcription','analysis'],revision='megabrain-video-text-v4';
function fixture({sync=false,failure=null}={}){
 const project='megabrain-v0-1017370021431',videoId='Fresh_pipeline',requestId='pipeline_request_20261016',docs=new Map(),sent=[],objects=new Map(),scopes=[],calls={upload:0,conversions:0,transcription:0,polls:0,analysis:0};let version=0,now=Date.now();
 const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,c,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('CAS'),{status:412});seed(p,{...docs.get(p).data,...c});return this.get(p);}};
 const batch={schema_version:1,id:'pilot_30_oct12',status:'active',budget_cents:120000,overhead_cents:2400,video_ids:Array.from({length:262},(_,i)=>'Legacy_'+i),parallelism:4,active_video_ids:[]};
 const retained={old_upload:{stage:'upload',video_id:'Retained_upload',maximum_cents:100,status:'uncertain'},old_analysis:{stage:'analysis',video_id:'Retained_analysis',maximum_cents:250,status:'uncertain'},old_media:{stage:'media_access',video_id:'Retained_media',maximum_cents:1100,status:'started'}};
 seed('settings/financial',{...newLedger(),pilot_envelope_cents:150000,paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),ongoing_storage_planned_bytes:100000000,remaining_credit_cents:150000,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true},reserved_cents:1450,jobs:retained,batch});
 seed('settings/automation',{enabled:true,parallelism:1,transcription_enabled:true,analysis_enabled:true});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 seed('settings/capacity',{schema_version:1,enabled:true,limit_bytes:100000000,admitted_bytes:0,claims:{},claim_limit:2400});
 seed('videos/'+videoId,{id:videoId,status:'pending'});
 const quotes={upload:10,transcription:20,analysis:30},approvalPath='jobs/assisted_upload_'+requestId;
 seed(approvalPath,{schema_version:1,kind:'assisted_pipeline',status:'authorized',request_id:requestId,authorization_ref:'MEG-109:synthetic-three-stages',authorized_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),maximum_cents:60,stage_maximum_cents:quotes,analysis_revision:revision,task:{videoId,stage:'upload',poll:0}});
 const original=structuredClone(docs.get('settings/financial').data);
 const stops=new ExecutionStops({store,analysisRevision:revision,clock:()=>now}),acquisition=new AcquisitionControl({store,maximumParallelism:1,clock:()=>now,verifyExecutionStopped:x=>stops.verify(x)});
 const routes=Object.fromEntries(stages.map(stage=>[stage,{queue:stage==='upload'?'v0-acquisition':'v0-'+stage,workerOrigin:'https://'+stage+'-unit.run.app'}]));
 const queueAPI={project,async request(url,o){
  const payload=JSON.parse(Buffer.from(o.json.task.httpRequest.body,'base64'));
  assert.ok(url.includes('/queues/'+routes[payload.stage].queue+'/tasks'));assert.equal(o.json.task.httpRequest.oidcToken.audience,routes[payload.stage].workerOrigin);assert.equal(payload.unitRequestId,requestId);
  const previous=payload.stage==='analysis'?'transcription':payload.poll===0?'upload':null;
  if(previous){assert.equal((await store.get('jobs/'+executionId(videoId,previous,previous==='analysis'?revision:null))).data.status,'completed');assert.equal((await store.get('settings/financial')).data.reserved_cents,1450);}
  if(failure==='queue')throw Error('unknown create');
  sent.push(payload);return {};
 }};
 const makeFlow=scope=>{
  scopes.push(scope);
  const ledger=new FinancialLedger(store,{assistedScope:scope,clock:()=>now}),capacity=new StorageCapacity(store,{assistedScope:scope}),gate=workerReservationGate(store,{assistedScope:scope,clock:()=>now});
  const storage={bucket:project+'-media',
   async metadata(key){const o=objects.get(key);return o?{generation:o.generation,size:String(o.bytes.length),metadata:{sha256:sha256(o.bytes)}}:null;},
   async read(key,{generation}={}){const o=objects.get(key);assert.ok(o);assert.equal(generation,o.generation);return o.bytes;},
   async writeImmutable(key,bytes){await capacity.admit({bucket:this.bucket,key,bytes:bytes.length,digest:sha256(bytes)});assert.ok(!objects.has(key),'never rewrite immutable object');const object={generation:String(objects.size+1),bytes};objects.set(key,object);return {generation:object.generation,size:bytes.length,sha256:sha256(bytes)};},
   async reserveResult(key,maximumBytes=262144){return capacity.reserveResult({bucket:this.bucket,key,maximumBytes});}
  };
  const api={project,async request(url){
   if(url.endsWith(':recognize')){calls.transcription++;return {results:[{alternatives:[{transcript:'One preserved transcript'}]}]};}
   if(url.endsWith(':batchRecognize')){calls.transcription++;if(failure==='transcription')throw Error('unknown submit');return {name:'projects/'+project+'/locations/us/operations/unit_pipeline'};}
   assert.equal(url,'https://us-speech.googleapis.com/v2/projects/'+project+'/locations/us/operations/unit_pipeline');calls.polls++;
   if(calls.polls===1)return {done:false};
   const key='results/instagram/'+videoId+'/'+executionId(videoId,'transcription')+'/audio.flac';
   return {done:true,response:{results:{['gs://'+storage.bucket+'/'+key]:{inlineResult:{transcript:{results:[{alternatives:[{transcript:'One preserved transcript'}]}]}}}}}};
  }};
  const tools={async download(_video,{onExecutionStopped}){calls.upload++;if(failure!=='missing_stop')onExecutionStopped();if(failure==='upload')throw Error('unknown download');return Buffer.from('video');},async extractAudio(){calls.conversions++;return Buffer.from('fLaCaudio');}};
  const config={enabled:true,uploads_enabled:true,single_reel_pipeline_enabled:true,worker_stage:scope.stage,quotes,speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR'],synchronous_short_audio:sync};
  const operations=googleOperations({api,storage,tools,config,preset:{},gate,inspect:async()=>({audio_status:'present',duration_seconds:sync?30:90})});
  operations.analysis=async({executionId:id,video})=>{
   await gate({executionId:id,videoId,stage:'analysis'});const key='results/instagram/'+videoId+'/'+id+'/analysis.json';
   await storage.reserveResult(key,1024);calls.analysis++;if(failure==='analysis')throw Error('unknown inference');
   const object=await storage.writeImmutable(key,Buffer.from('saved result'));return {video_id:video.id,stage:'analysis',actual_cents:30,changes:{analysis:{title:'Classified'},analysis_key:key,analysis_generation:object.generation,analysis_quality_status:'accepted'}};
  };
  return new WorkerFlow({store,ledger,operations,assistedScope:scope,quotes,analysisRevision:revision,eligibleVideos:[videoId],batchId:batch.id,acquisition,recordExecutionStopped:x=>stops.record(x),verifyExecutionStopped:x=>stops.verify(x),clock:()=>now});
 };
 const handlers={};
 for(const stage of stages){
  const queue=new WorkerQueue({api:queueAPI,store,workerOrigin:routes[stage].workerOrigin,stageRoutes:routes,enabled:true,clock:()=>now});
  const unitFlow=async task=>stageBoundFlow(await pipelineFlow({store,task,stage,allowedVideoIds:[videoId],quotes,analysisRevision:revision,makeFlow,verifyExecutionStopped:x=>stops.verify(x),clock:()=>now}),stage);
  handlers[stage]=workerHandler({flow:null,queue,stage,authorize:async()=>true,unitFlow,requireUnitRequest:true});
 }
 const first={videoId,stage:'upload',poll:0,unitRequestId:requestId};
 const deliver=async task=>{const response=await handlers[task.stage](new Request('https://unit.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)}));return {http:response.status,...await response.json()};};
 const set=(path,changes)=>seed(path,{...docs.get(path).data,...changes});
 return {store,docs,seed,set,sent,calls,first,deliver,scopes,objects,approvalPath,original,quotes,videoId,requestId,advance:ms=>now+=ms,makeFlow};
}
for(const sync of [false,true])test('real scoped flow/ledger/capacity/audio adapters cross three queues once; sync='+sync,async()=>{
 const f=fixture({sync});assert.equal((await f.deliver(f.first)).status,'completed');
 for(let i=0;i<f.sent.length;i++)assert.equal((await f.deliver(f.sent[i])).http,200);
 assert.deepEqual(f.calls,{upload:1,conversions:1,transcription:1,polls:sync?0:2,analysis:1});
 const state=(await f.store.get('settings/financial')).data;assert.deepEqual(state.batch,f.original.batch);assert.equal(state.reserved_cents,1450);assert.equal(state.spent_cents,60);
 for(const [id,j] of Object.entries(f.original.jobs))assert.deepEqual(state.jobs[id],j);
 for(const stage of stages){const j=state.jobs[executionId(f.videoId,stage,stage==='analysis'?revision:null)];assert.equal(j.assisted_scope_ref,f.approvalPath);assert.equal(j.batch_id,undefined);assert.equal(j.status,'completed');}
 assert.equal((await f.store.get('videos/'+f.videoId)).data.status,'analyzed');assert.deepEqual((await f.store.get('settings/acquisition')).data.active,{});
 const count=f.sent.length;await f.deliver(f.first);for(const message of [...f.sent])await f.deliver(message);assert.equal(f.sent.length,count);assert.equal(f.calls.analysis,1);assert.equal(f.calls.transcription,1);
});
for(const failure of ['upload','transcription','analysis','missing_stop','queue'])test('failure holds evidence/money and does not repeat providers: '+failure,async()=>{
 const f=fixture({failure});await f.deliver(f.first);for(let i=0;i<f.sent.length;i++)await f.deliver(f.sent[i]);
 const before={...f.calls};await f.deliver(f.first);for(const task of [...f.sent])await f.deliver(task);assert.deepEqual(f.calls,before);
 assert.equal(f.calls.analysis,failure==='analysis'?1:0);
 const state=(await f.store.get('settings/financial')).data;for(const [id,j] of Object.entries(f.original.jobs))assert.deepEqual(state.jobs[id],j);assert.ok(state.reserved_cents>=1450);
});
for(const delta of [{maximum_cents:61},{stage_maximum_cents:{upload:10,transcription:21,analysis:29}},{analysis_revision:'megabrain-video-text-v3'},{expires_at:new Date(0).toISOString()},{kind:'assisted_upload'},{consumed_at:'already'}])test('reject forged approval '+JSON.stringify(delta),async()=>{
 const f=fixture();f.set(f.approvalPath,delta);assert.equal((await f.deliver(f.first)).http,500);assert.equal(f.calls.upload,0);
});
test('unauthorized tasks cannot consume authority or bypass normal handlers',async()=>{
 const f=fixture();assert.equal((await f.deliver({...f.first,unitRequestId:undefined})).http,409);
 assert.equal((await f.deliver({...f.first,videoId:'Other_Reel'})).http,500);
 const h=workerHandler({stage:'upload',flow:{run:()=>assert.fail()},queue:{},authorize:async()=>false});
 assert.equal((await h(new Request('https://x.run.app',{method:'POST',body:JSON.stringify(f.first)}))).status,401);
 for(const key of ['recoverUpload','recoverSettled','recoverFirestoreWrite','recoverAnalysis429'])assert.throws(()=>validateTask({...f.first,[key]:true,recoveryId:'recovery_request_2026'}));
 assert.equal((await f.store.get(f.approvalPath)).data.status,'authorized');
});
test('same approval racing consumes once; lost receipt cannot be replayed',async()=>{
 const f=fixture();await Promise.all([f.deliver(f.first),f.deliver(f.first)]);assert.equal(f.calls.upload,1);
 const other=fixture(),patch=other.store.patch;
 other.store.patch=async(p,c,o)=>{const v=await patch(p,c,o);if(c.consumed_at)throw Error('lost receipt');return v;};
 assert.equal((await other.deliver(other.first)).http,500);await other.deliver(other.first);assert.equal(other.calls.upload,0);
});
test('unit budget and pause still block paid stages, consumed request does not retry',async()=>{
 for(const delta of [{paused:true},{pilot_envelope_cents:null},{pilot_envelope_cents:1},{enabled_stages:{upload:false}}]){
  const f=fixture();f.set('settings/financial',delta);await f.deliver(f.first);assert.equal(f.calls.upload,0);assert.equal(f.sent.length,0);
 }
});
test('successor cannot run early and a prior financial history cannot be hidden',async()=>{
 const f=fixture();assert.equal((await f.deliver({...f.first,stage:'analysis'})).http,500);assert.equal(f.calls.analysis,0);
 f.set('settings/financial',{jobs:{...f.original.jobs,old_reel:{video_id:f.videoId,stage:'upload',maximum_cents:10,status:'completed',actual_cents:10}}});
 await f.deliver(f.first);assert.equal(f.calls.upload,0);
});
test('approval expiry prevents a new stage but permits collection of owned waiting STT',async()=>{
 const f=fixture();await f.deliver(f.first);await f.deliver(f.sent[0]);f.advance(120000);
 assert.equal((await f.deliver(f.sent[1])).status,'waiting');assert.equal((await f.deliver(f.sent[2])).status,'completed');
 assert.equal((await f.deliver(f.sent[3])).http,500);assert.equal(f.calls.transcription,1);assert.equal(f.calls.analysis,0);
});
test('soft submission pause collects known operation; hard pause does not call provider',async()=>{
 const f=fixture();await f.deliver(f.first);await f.deliver(f.sent[0]);f.set('settings/automation',{transcription_enabled:false});
 await f.deliver(f.sent[1]);assert.equal(f.calls.polls,1);f.set('settings/automation',{enabled:false});
 assert.equal((await f.deliver(f.sent[2])).status,'paused');assert.equal(f.calls.polls,1);
});
test('invocation scopes reject copies and cannot cross video/stage/execution/object boundaries',async()=>{
 const f=fixture();await f.deliver(f.first);const scope=f.scopes[0];
 assert.throws(()=>assertAssistedScope({...scope}));assert.throws(()=>assertAssistedScope(scope,{stage:'analysis'}));
 const flow=f.makeFlow(scope);await assert.rejects(flow.run({videoId:'Other_Reel',stage:'upload'}));await assert.rejects(flow.poll({videoId:f.videoId}));
 f.set(f.approvalPath,{maximum_cents:100});await f.deliver(f.sent[0]);assert.equal(f.calls.transcription,0);
});
test('runtime pipeline opt-in is stage-only, single-ID, capped and default off',()=>{
 const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
 const routes=Object.fromEntries(stages.map(s=>[s,{queue:s==='upload'?'v0-acquisition':'v0-'+s,workerOrigin:'https://'+s+'-unit.run.app'}]));
 const base={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',worker_stage:'upload',worker_origin:routes.upload.workerOrigin,stage_routes:routes,enabled:false,dispatch_enabled:false,admission_enabled:false,pilot_video_ids:['Fresh_pipeline'],batch_id:'pilot_30_oct12',analysis_revision:preset.version,quotes:{upload:10,transcription:20,analysis:30},single_reel_pipeline_enabled:true};
 assert.doesNotThrow(()=>workerRuntime(base,preset,{stage:'upload'}));
 for(const delta of [{quotes:{upload:101,transcription:20,analysis:30}},{pilot_video_ids:['One_reel','Other_reel']},{admission_enabled:true},{assisted_upload_enabled:true},{quotes:{upload:10,transcription:1000,analysis:1000}}])assert.throws(()=>workerRuntime({...base,...delta},preset,{stage:'upload'}));
 assert.throws(()=>workerRuntime({...base,worker_stage:undefined,stage_routes:undefined},preset));
});


test('object authority is exact per-stage, including immutable audio prepared by upload',async()=>{
 const f=fixture();await f.deliver(f.first);const upload=f.scopes[0],audio='results/instagram/'+f.videoId+'/'+executionId(f.videoId,'transcription')+'/audio.flac';
 assert.doesNotThrow(()=>assertAssistedObject(upload,audio));
 for(const key of ['originals/instagram/Other_Reel/video.mp4','results/instagram/'+f.videoId+'/wrong/analysis.json'])assert.throws(()=>assertAssistedObject(upload,key));
 await f.deliver(f.sent[0]);const stt=f.scopes.at(-1);assert.throws(()=>assertAssistedObject(stt,'originals/instagram/'+f.videoId+'/video.mp4'));
 while(f.sent.length<4)await f.deliver(f.sent[f.sent.length-1]);
 await f.deliver(f.sent.at(-1));const analysis=f.scopes.at(-1);assert.throws(()=>assertAssistedObject(analysis,audio));
});
test('preexisting legacy slot blocks a new extraction without releasing or replacing it',async()=>{
 const f=fixture();const active={legacy_slot:{video_id:'Legacy_video',execution_id:'job_'+'a'.repeat(64),attempt_id:'12345678-1234-4123-8123-123456789abc',started_at:new Date().toISOString()}};
 f.set('settings/acquisition',{active});await f.deliver(f.first);assert.equal(f.calls.upload,0);assert.deepEqual((await f.store.get('settings/acquisition')).data.active,active);assert.equal((await f.store.get('settings/financial')).data.reserved_cents,1450);
});
test('hard pause before initial consumption preserves the authorized approval',async()=>{
 const f=fixture();f.set('settings/automation',{enabled:false});await f.deliver(f.first);assert.equal((await f.store.get(f.approvalPath)).data.status,'authorized');assert.equal(f.calls.upload,0);
});
test('concurrent poll deliveries acquire one CAS before querying the same STT operation',async()=>{
 const f=fixture();await f.deliver(f.first);await f.deliver(f.sent[0]);await Promise.all([f.deliver(f.sent[1]),f.deliver(f.sent[1])]);assert.equal(f.calls.transcription,1);assert.equal(f.calls.polls,1);
});
test('transcription cannot reuse foreign completed media or authority from a different approval',async()=>{
 const f=fixture();await f.deliver(f.first);const path='jobs/'+executionId(f.videoId,'upload');f.set(path,{assisted_scope_ref:'jobs/assisted_upload_another_request_2026'});await f.deliver(f.sent[0]);assert.equal(f.calls.transcription,0);
});


test('unit admission refuses an ID in the unchanged262 profile even without prior job or artifact',async()=>{
 const f=fixture(),state=(await f.store.get('settings/financial')).data;
 const batch={...state.batch,video_ids:[f.videoId,...state.batch.video_ids.slice(1)]};f.set('settings/financial',{batch});
 const before=await f.store.get('settings/financial');
 assert.equal((await f.deliver(f.first)).http,500);
 assert.equal(f.calls.upload,0);assert.equal(f.sent.length,0);
 assert.deepEqual(await f.store.get('settings/financial'),before);
 assert.equal((await f.store.get(f.approvalPath)).data.status,'authorized');
});


for(const sync of [true,false])test('unit STT reserves durable result capacity before a paid submission; sync='+sync,async()=>{
 const f=fixture({sync});await f.deliver(f.first);
 const capacity=(await f.store.get('settings/capacity')).data;
 f.set('settings/capacity',{limit_bytes:capacity.admitted_bytes});
 assert.equal((await f.deliver(f.sent[0])).status,'uncertain');
 assert.equal(f.calls.transcription,0);assert.equal(f.calls.polls,0);assert.equal(f.sent.length,1);
 assert.equal((await f.store.get('settings/financial')).data.reserved_cents,1470);
});
