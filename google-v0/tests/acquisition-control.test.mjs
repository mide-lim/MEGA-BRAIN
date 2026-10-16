import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaTools} from '../lib/media-tools.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {workerHandler} from '../lib/worker-queue.mjs';
import {WorkerAdmission} from '../lib/worker-admission.mjs';
import {executionId} from '../lib/worker-flow.mjs';
import {newLedger,FinancialLedger} from '../lib/financial-ledger.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {encodeFields,decodeFields} from '../lib/firestore.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url)));
function fixture({parallelism=1,download,caption=true}={}){
 const now=Date.now(),batchId='pilot_acquisition',quotes={upload:10,transcription:10,analysis:10},ids=Array.from({length:262},(_,i)=>`Reel_${i}`),docs=new Map();let version=0,downloads=0,peak=0,active=0,legacyCaptures=0,models=0;
 const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism,active:{}});
 seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true,parallelism:4});
 seed('settings/financial',{...newLedger(),paused:false,allocation_cents:170000,coverage_verified:true,ongoing_commitment_cents:100,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:170000,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true},batch:{schema_version:1,id:batchId,status:'active',video_ids:ids,budget_cents:120000,overhead_cents:2400,parallelism:4,active_video_ids:[]}});
 for(const id of ids)seed(`videos/${id}`,{status:'pending'});
 const memory={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,decodeFields(encodeFields(data)));return {created:true};},async patch(p,changes,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('Conflict'),{status:412});seed(p,{...docs.get(p).data,...decodeFields(encodeFields(changes))});return this.get(p);}};
 const config={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',batch_id:batchId,pilot_video_ids:ids,quotes,enabled:true,uploads_enabled:true,gemini_model:'gemini-3.1-flash-lite',speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR'],synchronous_short_audio:true};
 const flow=workerRuntime(config,preset);Object.assign(flow.store,memory);const store=flow.store;flow.ledger=new FinancialLedger(store);
 const text='Legenda original',source_caption={text,capture_id:createHash('sha256').update(text).digest('hex')};
 // Synthetic success explicitly attests its awaited work; a throw never attests.
 const tools={async download(video,options){downloads++;active++;peak=Math.max(peak,active);try{assert.equal(options.withMetadata,true);if(download)await download(video);await options.onExecutionStopped?.();return {bytes:Buffer.from('media'),...(caption?{source_caption}:{})};}finally{active--;}},async captureCaption(){legacyCaptures++;throw Error('Analysis may not extract');},async extractAudio(){return Buffer.from('audio');}};
 const objects=new Map(),reads=[],storage={bucket:config.project+'-media',async metadata(k){return objects.get(k)?.meta??null;},async writeImmutable(k,b){if(objects.has(k))throw Error('Immutable duplicate');const meta={generation:String(objects.size+1),size:b.length};objects.set(k,{bytes:b,meta});return meta;},async read(k,options){reads.push({k,options});return objects.get(k).bytes;}};
 const api={project:config.project,async request(url){if(url.includes('speech'))return {results:[{alternatives:[{transcript:'Transcrição original'}]}]};models++;return {};}};
 flow.operations=googleOperations({api,storage,tools,preset,config,gate:workerReservationGate(store),inspect:async()=>({audio_status:'present',duration_seconds:10})});
 const run=(n,stage='upload')=>flow.run({videoId:ids[n],stage});
 const slots=()=>Object.values(docs.get('settings/acquisition').data.active);
 const proof=n=>[...docs].find(([p,d])=>p.startsWith('execution_stops/')&&d.data.video_id===ids[n])?.[1].data;
 const stats=()=>({downloads,peak,active,legacyCaptures,models});
 const patch=async(p,c)=>{const d=await store.get(p);return store.patch(p,c,{updateTime:d.updateTime});};
 const task={batchId,runId:'admission_run_20261015',tick:0},dispatched=[];
 const queue={async enqueueAdmission(){},async enqueue(t){dispatched.push(t);return {status:'queued'};}};
 const admission=()=>new WorkerAdmission({store,queue,batchId,quotes,enabled:true,acquisition:flow.acquisition});
 seed('settings/admission',{schema_version:1,batch_id:batchId,run_id:task.runId,enabled:true,intents:{}});
 return {flow,store,docs,seed,patch,ids,run,slots,proof,stats,task,dispatched,admission,objects,reads,config};
}

test('actual downloader calls across concurrent workers and duplicate deliveries respect aggregate capacity one',async()=>{
 const entered=deferred(),finish=deferred(),f=fixture({download:async()=>{entered.resolve();await finish.promise;}});
 const first=f.run(0);await entered.promise;
 const results=await Promise.all([f.run(0),f.run(1),f.run(2)]);
 assert.equal(f.stats().downloads,1);assert.equal(f.stats().peak,1);assert.equal(f.slots().length,1);
 assert.equal(results.filter(x=>x.reason==='acquisition_capacity').length,2);
 assert.equal(Object.values(f.docs.get('settings/financial').data.jobs).length,1);
 finish.resolve();assert.equal((await first).status,'completed');assert.equal(f.slots().length,0);
 assert.equal((await f.run(3)).status,'completed');assert.equal(f.stats().downloads,2);
});

test('configured capacity two counts two real extractors and a reduced limit does not evict live work',async()=>{
 const entered=deferred(),finish=deferred();let n=0;const f=fixture({parallelism:2,download:async()=>{if(++n===2)entered.resolve();await finish.promise;}});
 const runs=[f.run(0),f.run(1)];await entered.promise;
 assert.equal(f.stats().peak,2);await f.patch('settings/acquisition',{parallelism:1});
 assert.equal((await f.run(2)).reason,'acquisition_capacity');assert.equal(f.slots().length,2);
 finish.resolve();await Promise.all(runs);assert.equal(f.slots().length,0);
 assert.equal(f.docs.get('settings/automation').data.parallelism,4);assert.equal(f.docs.get('settings/financial').data.batch.parallelism,4);
});

test('transcription and analysis proceed during acquisition without consuming or releasing its slot',async()=>{
 const entered=deferred(),finish=deferred(),f=fixture({download:async()=>{entered.resolve();await finish.promise;}});
 for(const n of [1,2])f.seed(`videos/${f.ids[n]}`,{media_verified:true,audio_status:'present',transcript:'Texto',video_key:`originals/instagram/${f.ids[n]}/video.mp4`});
 const stages=[];f.flow.operations.transcription=async({video})=>{stages.push('transcription');return {video_id:video.id,stage:'transcription',actual_cents:10,changes:{transcript:'Texto'}};};
 f.flow.operations.analysis=async({video})=>{stages.push('analysis');return {video_id:video.id,stage:'analysis',actual_cents:10,changes:{analysis:{title:'Tema'}}};};
 const running=f.run(0);await entered.promise;
 assert.equal((await f.run(1,'transcription')).status,'completed');assert.equal((await f.run(2,'analysis')).status,'completed');
 assert.deepEqual(stages,['transcription','analysis']);assert.equal(f.slots().length,1);assert.equal(f.proof(0),undefined);
 finish.resolve();await running;assert.equal(f.slots().length,0);
});

for(const [name,change]of [['automation pause',f=>f.patch('settings/automation',{enabled:false})],['financial pause',f=>f.patch('settings/financial',{paused:true})],['exhausted budget',f=>f.patch('settings/financial',{remaining_credit_cents:0})]])test(`${name} cannot be bypassed by acquisition capacity`,async()=>{
 const f=fixture({parallelism:4});await change(f);assert.notEqual((await f.run(0)).status,'completed');assert.equal(f.stats().downloads,0);assert.equal(f.slots().length,0);
});

test('authentication still blocks before claims, slots, ledger or download',async()=>{
 const f=fixture(),before=structuredClone(f.docs),handler=workerHandler({flow:f.flow,queue:{enqueue(){assert.fail();}},authorize:async()=>false});
 assert.equal((await handler(new Request('https://worker.invalid/tasks/run',{method:'POST',body:JSON.stringify({videoId:f.ids[0],stage:'upload',poll:0})}))).status,401);
 assert.deepEqual(f.docs,before);assert.equal(f.stats().downloads,0);
});

for(const malformed of [null,{schema_version:1,enabled:true,parallelism:0,active:{}},{schema_version:1,enabled:true,parallelism:1,active:{forged:{}}},{schema_version:1,enabled:false,parallelism:1,active:{}}])test(`missing/invalid/disabled acquisition control fails closed: ${JSON.stringify(malformed)}`,async()=>{
 const f=fixture();if(malformed)f.seed('settings/acquisition',malformed);else f.docs.delete('settings/acquisition');
 assert.equal((await f.run(0)).status,'blocked');assert.equal(f.stats().downloads,0);assert.equal(f.docs.get('settings/financial').data.reserved_cents,0);
});

test('success records bounded duration and actual extraction counts without sensitive output',async()=>{
 const f=fixture();await f.run(0);const proof=f.proof(0);assert.equal(proof.stage,'upload');assert.equal(proof.acquisition.adapter_calls,1);assert.equal(proof.acquisition.extractions,1);assert.equal(proof.acquisition.outcome,'completed');assert.ok(proof.acquisition.duration_ms>=0);assert.equal(proof.acquisition.diagnostic_ref,`jobs/${executionId(f.ids[0],'upload')}`);
 assert.doesNotMatch(JSON.stringify(proof),/https:|token|raw|signed/);assert.equal(f.slots().length,0);
});

test('download failure waits for cleanup then retains capacity without end proof or sensitive diagnostics',async()=>{
 const f=fixture({download:async()=>{throw Object.assign(Error('https://private?token=secret'),{name:'TimeoutError',operation_step:'download_media'});}}),entered=deferred(),exit=deferred(),patch=f.store.patch.bind(f.store);
 f.store.patch=async(p,c,o)=>{const r=await patch(p,c,o);if(p===`jobs/${executionId(f.ids[0],'upload')}`&&c.status==='uncertain'){entered.resolve();await exit.promise;}return r;};
 const run=f.run(0);await entered.promise;assert.equal(f.slots().length,1);assert.equal(f.proof(0),undefined);
 await f.patch('settings/acquisition',{enabled:false});assert.equal(f.slots().length,1);
 exit.resolve();assert.equal((await run).status,'uncertain');assert.equal(f.slots().length,1);assert.equal(f.proof(0),undefined);const claim=f.docs.get(`jobs/${executionId(f.ids[0],'upload')}`).data;assert.equal(claim.acquisition_end_status,'unconfirmed');assert.equal(claim.acquisition_metrics.extractions,1);
 assert.doesNotMatch(JSON.stringify(f.docs.get(`jobs/${executionId(f.ids[0],'upload')}`).data),/private|secret/);
 assert.equal(f.docs.get('settings/financial').data.paused,true);await f.run(0);assert.equal(f.stats().downloads,1);
});

for(const failAfterWrite of [false,true])test(`end-proof ${failAfterWrite?'lost receipt':'failed write'} never implies completion without durable evidence`,async()=>{
 const f=fixture(),create=f.store.create.bind(f.store);
 f.store.create=async(p,d)=>{if(p.startsWith('execution_stops/')){if(failAfterWrite)await create(p,d);throw Error('Unknown proof receipt');}return create(p,d);};
 assert.equal((await f.run(0)).status,'completed');assert.equal(f.slots().length,failAfterWrite?0:1);
 if(!failAfterWrite){assert.equal((await f.run(1)).reason,'acquisition_capacity');await f.run(0);assert.equal(f.stats().downloads,1);}
});

test('unknown acquisition receipt holds capacity and never calls the downloader',async()=>{
 const f=fixture(),patch=f.store.patch.bind(f.store);let once=true;
 f.store.patch=async(p,c,o)=>{const r=await patch(p,c,o);if(p==='settings/acquisition'&&once){once=false;throw Error('Receipt lost');}return r;};
 assert.equal((await f.run(0)).status,'blocked');assert.equal(f.slots().length,1);assert.equal(f.stats().downloads,0);assert.equal(f.proof(0),undefined);
 assert.equal((await f.run(1)).reason,'acquisition_capacity');assert.equal(f.slots().length,1);
});

test('unknown release receipt can be reconciled idempotently without download',async()=>{
 const f=fixture(),patch=f.store.patch.bind(f.store);let release=true;
 f.store.patch=async(p,c,o)=>{if(p==='settings/acquisition'&&Object.keys(c.active).length===0&&release){release=false;throw Error('Unknown release');}return patch(p,c,o);};
 await f.run(0);assert.equal(f.slots().length,1);const x=f.slots()[0],input={executionId:x.execution_id,videoId:x.video_id,attemptId:x.attempt_id};
 assert.equal(await f.flow.acquisition.release(input),true);assert.equal(await f.flow.acquisition.release(input),true);assert.equal(f.slots().length,0);assert.equal(f.stats().downloads,1);
});

test('a hard-loss snapshot remains held despite time, pause, settlement and foreign/malformed proofs',async()=>{
 const entered=deferred(),exit=deferred(),f=fixture({download:async()=>{entered.resolve();await exit.promise;}}),run=f.run(0);await entered.promise;
 const activeSnapshot=structuredClone(f.docs),x=f.slots()[0],input={executionId:x.execution_id,videoId:x.video_id,attemptId:x.attempt_id};
 exit.resolve();await run;const goodProof=structuredClone(f.proof(0));f.docs.clear();for(const entry of activeSnapshot)f.docs.set(...entry);
 await f.patch('settings/automation',{enabled:false});await f.patch('settings/financial',{paused:true});
 f.flow.acquisition.clock=()=>Date.now()+86400000*365;
 assert.equal(await f.flow.acquisition.release(input),false);assert.equal(f.slots().length,1);
 const proofPath=`execution_stops/${input.executionId}_${input.attemptId}`;
 for(const change of [{attempt_id:randomUUID()},{video_id:f.ids[1]},{stage:'analysis'},{ended:false},{claim_update_time:'foreign-version'}]){
  f.seed(proofPath,{...goodProof,...change});assert.equal(await f.flow.acquisition.release(input),false);assert.equal(f.slots().length,1);
 }
 assert.equal(await f.flow.acquisition.release({...input,attemptId:randomUUID()}),false);
});

test('valid media/caption/metadata and completed deliveries are reused through transcription and analysis',async()=>{
 const f=fixture();assert.equal((await f.run(0)).status,'completed');assert.equal((await f.run(0)).duplicate,true);
 const media=structuredClone(f.docs.get(`videos/${f.ids[0]}`).data);assert.equal(media.source_caption.text,'Legenda original');assert.equal(media.duration_seconds,10);
 assert.equal((await f.run(0,'transcription')).status,'completed');assert.equal((await f.run(0,'transcription')).duplicate,true);
 assert.equal((await f.run(0,'analysis')).status,'completed');assert.equal((await f.run(0,'analysis')).duplicate,true);
 assert.equal(f.stats().downloads,1);assert.equal(f.stats().legacyCaptures,0);assert.equal(f.stats().models,1);assert.equal(f.reads.length,1);assert.equal(f.reads[0].options.generation,media.video_generation);
 assert.equal(f.docs.get(`videos/${f.ids[0]}`).data.source_caption.capture_id,media.source_caption.capture_id);
});

test('legacy or unavailable captions never start an Instagram extraction in analysis',async()=>{
 for(const status of [undefined,'unavailable']){
  const f=fixture();f.seed(`videos/${f.ids[0]}`,{media_verified:true,video_key:`originals/instagram/${f.ids[0]}/video.mp4`,transcript:'Preservada',...(status?{caption_status:status}:{})});
  await f.run(0,'analysis');assert.equal(f.stats().legacyCaptures,0);assert.equal(f.stats().downloads,0);
 }
});

test('existing verified media with missing upload claim requires reconciliation, never another extraction',async()=>{
 const f=fixture();f.seed(`videos/${f.ids[0]}`,{media_verified:true,video_key:`originals/instagram/${f.ids[0]}/video.mp4`,video_generation:'1'});
 assert.equal((await f.run(0)).reason,'media_requires_reconciliation');assert.equal(f.stats().downloads,0);assert.equal(f.slots().length,0);
});

test('admission reserves only acquisition capacity across concurrent ticks and releases it while STT continues',async()=>{
 const f=fixture();await Promise.all([f.admission().run(f.task),f.admission().run(f.task)]);
 // Mock queue may see duplicate pending intents, but selection itself is durable.
 assert.equal(Object.keys(f.docs.get('settings/admission').data.intents).length,1);
 assert.ok(f.dispatched.every(t=>t.videoId===f.ids[0]));
 await f.run(0);await f.admission().run({...f.task,tick:1});
 assert.equal(Object.keys(f.docs.get('settings/admission').data.intents).length,2);
 assert.deepEqual(f.docs.get('settings/financial').data.batch.active_video_ids,[f.ids[0]]);
});

test('settled money without end proof or a held active slot cannot free acquisition admission',async()=>{
 const f=fixture();await f.admission().run(f.task);const id=f.ids[0],j=executionId(id,'upload');
 f.seed(`jobs/${j}`,{video_id:id,stage:'upload',status:'completed',execution_attempt_id:randomUUID(),analysis_revision:null});
 const financial=f.docs.get('settings/financial').data;financial.jobs[j]={video_id:id,stage:'upload',status:'completed',maximum_cents:10,actual_cents:10};
 await f.admission().run({...f.task,tick:1});assert.equal(Object.keys(f.docs.get('settings/admission').data.intents).length,1);
});

test('admission with independent limit four still respects global parallelism one',async()=>{
 const f=fixture({parallelism:4});await f.patch('settings/automation',{parallelism:1});await f.admission().run(f.task);
 assert.equal(Object.keys(f.docs.get('settings/admission').data.intents).length,1);
});

for(const stage of ['transcription','analysis'])test(`${stage} pause is preserved while acquisition has available slots`,async()=>{
 const f=fixture({parallelism:4});f.seed(`videos/${f.ids[1]}`,{media_verified:true,audio_status:'present',transcript:'Texto',video_key:`originals/instagram/${f.ids[1]}/video.mp4`});
 await f.patch('settings/automation',{[stage+'_enabled']:false});const before=structuredClone(f.docs.get('settings/financial'));
 assert.equal((await f.run(1,stage)).status,'paused');assert.deepEqual(f.docs.get('settings/financial'),before);assert.equal(f.slots().length,0);
 assert.equal((await f.run(0)).status,'completed');assert.equal(f.stats().downloads,1);
});

test('global four-video capacity still blocks a fifth acquisition despite independent free slots',async()=>{
 const entered=deferred(),exit=deferred();let n=0;const f=fixture({parallelism:4,download:async()=>{if(++n===4)entered.resolve();await exit.promise;}});
 const runs=[0,1,2,3].map(i=>f.run(i));await entered.promise;assert.equal(f.stats().peak,4);
 exit.resolve();await Promise.all(runs);assert.equal(f.slots().length,0);
 assert.equal(f.docs.get('settings/financial').data.batch.active_video_ids.length,4);
 assert.equal((await f.run(4)).status,'blocked');assert.equal(f.stats().downloads,4);assert.equal(f.slots().length,0);
});

test('definite blocked-before-payment intent frees admission; unknown slot receipt still holds it',async()=>{
 for(const unknown of [false,true]){
  const f=fixture();await f.admission().run(f.task);const id=f.ids[0],execution=executionId(id,'upload');
  if(unknown)await f.flow.acquisition.acquire({executionId:execution,videoId:id,attemptId:randomUUID()});
  f.seed(`jobs/${execution}`,{video_id:id,stage:'upload',status:'blocked'});
  await f.admission().run({...f.task,tick:1});assert.equal(Object.keys(f.docs.get('settings/admission').data.intents).length,unknown?1:2);
 }
});

test('an already stored original with missing metadata is held before download or financial reservation',async()=>{
 const f=fixture(),key=`originals/instagram/${f.ids[0]}/video.mp4`;
 const original={bytes:Buffer.from('preserved'),meta:{generation:'99',size:9}};f.objects.set(key,original);
 assert.equal((await f.run(0)).status,'blocked');assert.equal(f.stats().downloads,0);assert.equal(f.slots().length,0);
 assert.equal(f.docs.get('settings/financial').data.reserved_cents,0);assert.deepEqual(f.objects.get(key),original);
 assert.equal(f.proof(0).acquisition.extractions,0);assert.equal(f.proof(0).acquisition.adapter_calls,0);
});

for(const code of ['ETIMEDOUT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','EIO'])test(`unconfirmed downloader rejection ${code} retains the slot despite resumed finance and elapsed time`,async()=>{
 const f=fixture({download:async()=>{throw Object.assign(Error('https://private?token=secret'),{code});}});
 assert.equal((await f.run(0)).status,'uncertain');assert.equal(f.proof(0),undefined);assert.equal(f.slots().length,1);
 const x=f.slots()[0],input={executionId:x.execution_id,videoId:x.video_id,attemptId:x.attempt_id};
 await f.patch('settings/financial',{paused:false});f.flow.acquisition.clock=()=>Date.now()+86400000;
 assert.equal(await f.flow.acquisition.release(input),false);assert.equal((await f.run(1)).reason,'acquisition_capacity');assert.equal(f.stats().downloads,1);
 const stops=new ExecutionStops({store:f.store});assert.equal(await stops.record({...input,stage:'upload'}),false);
 const claim=f.docs.get(`jobs/${input.executionId}`).data;assert.equal(claim.acquisition_end_status,'unconfirmed');assert.doesNotMatch(JSON.stringify(claim),/private|secret/);
});

test('uncertain-end diagnostic write failure cannot create a proof or release capacity',async()=>{
 const f=fixture({download:async()=>{throw Error('unconfirmed end');}}),patch=f.store.patch.bind(f.store);
 f.store.patch=(p,c,o)=>c.acquisition_end_status?Promise.reject(Error('Diagnostic unavailable')):patch(p,c,o);
 await f.run(0);assert.equal(f.proof(0),undefined);assert.equal(f.slots().length,1);
});

test('a failure after positive download completion still records end and releases acquisition',async()=>{
 const f=fixture();
 // The real download adapter has completed, but its artifact cannot be committed.
 const original=f.flow.finish.bind(f.flow);f.flow.finish=async input=>{if(input.stage==='upload')throw Error('Persistence failed after download');return original(input);};
 assert.equal((await f.run(0)).status,'uncertain');assert.equal(f.slots().length,0);assert.equal(f.proof(0).ended,true);assert.equal(f.proof(0).acquisition.extractions,1);
});

test('real execFile timeout with a surviving descendant cannot attest end or admit a second acquisition',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'megabrain-r1-test-')),pidfile=join(folder,'descendant.pid'),marker=join(folder,'finished.json');
 const exec=promisify(execFile);let childPid,childDone;
 try{
  const child=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({finished_at:Date.now()})),4000);`;
  const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','pipe']});setInterval(()=>{},1000);`;
  const tools=mediaTools({downloadEnabled:true,run:async(tool,args,options)=>{
   if(args.includes('--version'))return {stdout:'2026.10.01\n'};
   if(args.includes('-version'))return {stdout:'ffmpeg version 8.0\n'};
   return exec(process.execPath,['-e',parent],{...options,timeout:1000});
  }});
  const f=fixture({download:()=>tools.download({id:'DGXmHhAIOXN',source_url:'https://www.instagram.com/reel/DGXmHhAIOXN/'},{withMetadata:true})});
  assert.equal((await f.run(0)).status,'uncertain');childPid=Number(await readFile(pidfile,'utf8'));assert.doesNotThrow(()=>process.kill(childPid,0));
  assert.equal(f.proof(0),undefined);assert.equal(f.slots().length,1);assert.equal(f.docs.get(`jobs/${executionId(f.ids[0],'upload')}`).data.acquisition_end_status,'unconfirmed');
  await f.patch('settings/financial',{paused:false});assert.equal((await f.run(1)).reason,'acquisition_capacity');assert.equal(f.stats().downloads,1);
  const x=f.slots()[0];assert.equal(await f.flow.acquisition.release({executionId:x.execution_id,videoId:x.video_id,attemptId:x.attempt_id}),false);
  const until=Date.now()+5000;while(Date.now()<until){try{childDone=JSON.parse(await readFile(marker,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
  assert.ok(childDone);assert.equal(f.slots().length,1);assert.equal(f.proof(0),undefined); // Observing time pass never synthesizes end evidence.
 }finally{if(!childPid)try{childPid=Number(await readFile(pidfile,'utf8'));}catch{}if(childPid&&!childDone)try{process.kill(childPid,'SIGKILL');}catch{}await rm(folder,{recursive:true,force:true});}
});
