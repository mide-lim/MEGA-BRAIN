import test from 'node:test';
import assert from 'node:assert/strict';
import {reelsWebRuntime,validateReelsStageRoutes} from '../lib/reels-web-runtime.mjs';
import {reelsProcessingEnabled} from '../lib/reels-runtime-policy.mjs';
import {fixedStageRuntime} from '../lib/fixed-stage-runtime.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {encodeFields} from '../lib/firestore.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null,lastCursor:String(Math.min(n+limit,rows.length))};}};return store;}


const project='megabrain-v0-1017370021431';
const routes=Object.fromEntries([['upload','acquisition'],['transcription','transcription'],['analysis','analysis']].map(([key,stage])=>[key,{queue:'v0-'+stage,workerOrigin:`https://megabrain-v0-${stage}-711042421394.us-central1.run.app`}]));
const enabled={project,reels_runtime_version:'v2',reels_processing_enabled:true,stage_routes:routes};
const reel=id=>({id,status:'registered',created_at:'2026-10-17T03:00:00Z'});
function setup(videos=[]){
 const store=memory(videos),repository=new ReelsRepository({store,cacheTtlMs:0}),tasks=new Map(),requests=[];
 const api={project,request:async(url,options)=>{
  requests.push({url,method:options?.method??'GET'});
  assert.ok(url.startsWith('https://cloudtasks.googleapis.com/v2/'),'only fake Cloud Tasks adapter is available');
  if(options?.method==='POST'){
   const task=options.json.task;if(tasks.has(task.name))throw Object.assign(Error('exists'),{status:409});
   tasks.set(task.name,structuredClone(task));return structuredClone(task);
  }
  const name=url.replace('https://cloudtasks.googleapis.com/v2/','').replace('?responseView=FULL','');
  if(!tasks.has(name))throw Object.assign(Error('missing'),{status:404});return structuredClone(tasks.get(name));
 }};
 return {store,repository,api,tasks,requests};
}
const post=(path,input)=>new Request('https://web.example/api/reels/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
const get=path=>new Request('https://web.example/api/reels/'+path);
function apiFor(repository,runtime){return reelsAPI({repository,authorize:()=>true,sameOrigin:()=>true,...runtime});}

test('protected web flag defaults closed and a browser cannot enable providers or dispatch',async()=>{
 const x=setup([reel('Reel_001')]),runtime=reelsWebRuntime({...x,config:{project}}),handle=apiFor(x.repository,runtime);
 assert.equal(runtime.processingEnabled,false);assert.deepEqual(runtime.pipeline.operations,{});
 const response=await handle(post('commands',{type:'start',selection:{all:true},idempotencyKey:'client-flag-injection',processingEnabled:true,reels_processing_enabled:true,reels_runtime_version:'v2'}));
 assert.equal(response.status,423);assert.equal(x.requests.length,0);assert.equal(x.store.docs.size,1);
 for(const config of [{project,reels_processing_enabled:true},{project,reels_runtime_version:'v2',reels_processing_enabled:'true'},{project,reels_runtime_version:'legacy'}])assert.throws(()=>reelsWebRuntime({...x,config}));
 assert.equal(reelsProcessingEnabled({reels_runtime_version:'v2',reels_processing_enabled:false}),false);
});
test('enabled web composition accepts only existing per-stage routes and never installs provider methods',()=>{
 const x=setup(),runtime=reelsWebRuntime({...x,config:enabled});assert.equal(runtime.processingEnabled,true);assert.deepEqual(runtime.pipeline.operations,{});assert.equal(x.requests.length,0);
 assert.equal(validateReelsStageRoutes(routes),routes);
 for(const change of [{workerOrigin:'https://unrelated.run.app'},{queue:'v0-analysis'}])assert.throws(()=>reelsWebRuntime({...x,config:{...enabled,stage_routes:{...routes,upload:{...routes.upload,...change}}}}));
 assert.throws(()=>reelsWebRuntime({...x,config:{...enabled,project:'another-project'}}));
});
test('existing worker arguments preserve legacy only when protected v2 selection is absent',()=>{
 const called=[],preset={version:'synthetic'},legacyFactories=Object.fromEntries(['upload','transcription','analysis'].map(stage=>[stage,(config,p)=>{called.push({kind:'legacy',stage,config,p});return stage+'-legacy';}]));
 const reelsFactory=(config,p,options)=>{called.push({kind:'v2',stage:options.stage,config,p});return options.stage+'-v2';};
 for(const stage of ['upload','transcription','analysis'])assert.equal(fixedStageRuntime(stage,{project},preset,{legacyFactories,reelsFactory}),stage+'-legacy');
 assert.deepEqual(called.map(c=>c.kind),['legacy','legacy','legacy']);called.length=0;
 assert.equal(fixedStageRuntime('upload',{...enabled,reels_processing_enabled:false},preset,{legacyFactories,reelsFactory}),'acquisition-v2');
 assert.equal(called[0].kind,'v2');assert.equal(called[0].config.reels_processing_enabled,false);assert.equal(called[0].p,preset);
 assert.throws(()=>fixedStageRuntime('upload',{project,reels_processing_enabled:true},preset,{legacyFactories,reelsFactory}));
 assert.throws(()=>fixedStageRuntime('acquisition',enabled,preset,{legacyFactories,reelsFactory}));
});
test('web command flows through durable Tasks and three workers to LRO collection and publication without external providers',async()=>{
 const x=setup([reel('Reel_001'),reel('Reel_002')]),runtime=reelsWebRuntime({...x,config:enabled}),handle=apiFor(x.repository,runtime);
 const calls={upload:0,transcription:0,analysis:0,polls:0},pollsByReel=new Map();
 const operationsFactory=()=>({
  upload:async input=>{calls.upload++;return {changes:{video_key:`originals/instagram/${input.videoId}/video.mp4`,video_generation:'1',video_bytes:10,media_verified:true,audio_status:'present',duration_seconds:20}};},
  transcription:async input=>{calls.transcription++;return {operation_name:`projects/${project}/locations/us/operations/synthetic_${input.videoId}`};},
  pollTranscription:async input=>{
   calls.polls++;assert.equal(input.operationName,`projects/${project}/locations/us/operations/synthetic_${input.videoId}`);
   const count=(pollsByReel.get(input.videoId)??0)+1;pollsByReel.set(input.videoId,count);return count===1?{pending:true}:{changes:{transcript:'Conhecimento sintético preservado',transcript_status:'recognized',transcript_key:`results/instagram/${input.videoId}/${input.executionId}/transcription.json`,transcript_generation:'2'}};
  },
  analysis:async input=>{calls.analysis++;return {changes:{analysis:{summary:'Resultado sintético publicado',categories:[],knowledge:{context:'technology',fields:[{kind:'concept',value:'Conhecimento sintético preservado',evidence:[{source:'transcript',excerpt:'Conhecimento sintético preservado'}]}],missing_information:[]}},analysis_key:`results/instagram/${input.videoId}/${input.executionId}/analysis.json`,analysis_generation:'3',analysis_quality_status:'accepted'}};}
 });
 const workers=Object.fromEntries(['acquisition','transcription','analysis'].map(stage=>[stage,reelsGoogleRuntime({...enabled,worker_origin:routes[stage==='acquisition'?'upload':stage].workerOrigin},{version:'synthetic'},{stage,authorize:()=>true,dependencies:{api:x.api,store:x.store,repository:x.repository,storage:{metadata:async()=>null},tools:{},operationsFactory}})]));
 const input={type:'start',selection:{ids:['Reel_001','Reel_002']},idempotencyKey:'end-to-end-web-command'};
 const accepted=await handle(post('commands',input));assert.equal(accepted.status,200);const {operation}=await accepted.json();
 assert.equal(operation.status,'pending');assert.equal(operation.accepted.length,0);assert.equal(x.tasks.size,1);assert.deepEqual(calls,{upload:0,transcription:0,analysis:0,polls:0});
 const doubleClick=await handle(post('commands',input));assert.equal((await doubleClick.json()).operation.id,operation.id);assert.equal(x.tasks.size,1);
 const beforeRead=x.requests.length;await handle(get('commands/'+operation.id));assert.equal(x.requests.length,beforeRead);
 const delivered=new Set(),attempts=new Map();let rounds=0,backpressure=0;
 while(true){
  const pending=[...x.tasks.values()].filter(t=>!delivered.has(t.name));if(!pending.length)break;
  assert.ok(++rounds<25,'finite task graph with retryable delivery retention');
  for(const task of pending){
   attempts.set(task.name,(attempts.get(task.name)??0)+1);assert.ok(attempts.get(task.name)<20,'finite attempts per synthetic task');
   const stage=task.name.includes('/queues/v0-acquisition/')?'acquisition':task.name.includes('/queues/v0-transcription/')?'transcription':'analysis';
   assert.equal(task.httpRequest.oidcToken.serviceAccountEmail,`v0-queue@${project}.iam.gserviceaccount.com`);assert.equal(task.httpRequest.oidcToken.audience,new URL(task.httpRequest.url).origin);
   const body=Buffer.from(task.httpRequest.body,'base64').toString(),request=()=>new Request(task.httpRequest.url,{method:'POST',body});
   const before=structuredClone(calls),result=await workers[stage](request()),reply=await result.json();
   if(result.status===503){assert.equal(reply.reason,'TECHNICAL_BACKPRESSURE');assert.deepEqual(calls,before);backpressure++;continue;}
   assert.equal(result.status,200,JSON.stringify(reply));delivered.add(task.name);
   const payload=JSON.parse(body);
   if(!payload.poll&&payload.executionId){const duplicate=await workers[stage](request());assert.equal(duplicate.status,200);}
   assert.ok(delivered.size<25,'finite task graph');
  }
 }
 assert.ok(backpressure>0,'capacity one must retain a queued second STT delivery until the first poll completes');
 assert.ok([...attempts.values()].some(count=>count>1));
 assert.deepEqual(calls,{upload:2,transcription:2,analysis:2,polls:4});
 const receipt=await (await handle(get('commands/'+operation.id))).json();assert.equal(receipt.operation.status,'completed');assert.equal(receipt.operation.progress.processed,2);
 for(const id of ['Reel_001','Reel_002']){
  const detail=await (await handle(get('items/'+id))).json();assert.equal(detail.item.status,'completed');assert.equal(detail.item.publication.available,true);assert.equal(detail.item.analysis.summary,'Resultado sintético publicado');assert.equal(detail.item.transcript.text,'Conhecimento sintético preservado');
  assert.deepEqual(detail.item.executions.map(e=>e.stage),['acquisition','transcription','analysis']);
 }
 for(const stage of ['acquisition','transcription','analysis'])assert.deepEqual((await x.store.get('reels_controls/'+stage)).data.active,[]);
 assert.ok(x.requests.every(r=>r.url.startsWith('https://cloudtasks.googleapis.com/v2/')));
});
test('frozen and completed 3005-item operation fits the real Firestore REST encoding under 1MiB',async()=>{
 const x=setup(Array.from({length:3005},(_,n)=>reel('Reel_'+String(n).padStart(5,'0')))),runtime=reelsWebRuntime({...x,config:enabled});
 const {operation}=await runtime.service.command({type:'start',idempotencyKey:'firestore-3005-size',selection:{all:true}});
 assert.equal(Object.keys(operation.stagePlan).length,3005);
 const name=`projects/${project}/databases/(default)/documents/reels_commands/${operation.id}`;
 for(const data of [operation,{...operation,status:'completed',cursor:3005,accepted:operation.selected,progress:{total:3005,processed:3005,accepted:3005,excluded:0}}]){
  const bytes=Buffer.byteLength(JSON.stringify({name,fields:encodeFields(data)}));
  assert.ok(bytes<1048576,`Firestore encoding measured ${bytes} bytes`);
 }
 assert.deepEqual(operation.accepted,[]);assert.equal([...x.store.docs].filter(([p])=>p.startsWith('reels_executions/')).length,0);
});
