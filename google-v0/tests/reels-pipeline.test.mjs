import test from 'node:test';import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {encodeFields} from '../lib/firestore.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null};}};return store;}
const clock=()=>Date.parse('2026-10-16T03:30:00Z');
// Atomic four-version store seam; the real Firestore wire contract is covered
// by reels-firestore.test.mjs. No provider is involved in these regressions.
function stoppedCapacityStore(store){
 store.releaseStoppedPhysicalCapacity=async({executionId:id,reelId,stage,executionVersion,stopVersion,videoVersion,control,observedAt})=>{
  const checks=[['reels_executions/'+id,executionVersion],['execution_stops/'+id,stopVersion],['videos/'+reelId,videoVersion],['reels_controls/'+stage,control.updateTime]];
  if(checks.some(([path,version])=>store.docs.get(path)?.updateTime!==version))return {released:false};
  await store.patch('reels_controls/'+stage,{active:control.data.active.filter(active=>active!==id),observedAt},{updateTime:control.updateTime});return {released:true};
 };return store;
}
const reel=(id='Reel_001',extra={})=>({id,status:'registered',created_at:'2026-10-16T03:00:00Z',...extra});
const pub=(id='Reel_001',extra={})=>reel(id,{status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'original',evidence:{categories:[]}},...extra});
test('three-stage journey persists worker identity and filters events by the same worker',async()=>{
 const x=await setup('acquisition',{acquire:async()=>({changes:{video_key:'saved'}}),transcribe:async()=>({changes:{transcript:'saved'}}),analyze:async()=>({valid:true,changes:{analysis:{summary:'saved'},analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted'}})});
 for(const stage of ['acquisition','transcription','analysis'])await x.pipeline.run({executionId:executionId('operation','Reel_001',stage)});
 const detail=await x.repository.detail('Reel_001');assert.deepEqual(detail.executions.map(e=>e.stage),['acquisition','transcription','analysis']);
 for(const execution of detail.executions){assert.equal(execution.worker,'reels-'+execution.stage);assert.equal(execution.attempt,1);assert.equal(execution.status,'completed');assert.ok(execution.queuedAt&&execution.startedAt&&execution.completedAt);assert.doesNotThrow(()=>encodeFields(execution));}
 const events=await x.repository.events({worker:'reels-transcription'});assert.equal(events.items.length,1);assert.equal(events.items[0].worker,'reels-transcription');assert.equal(events.items[0].stage,'transcription');
});

test('synthetic Google400 survives analysis failure persistence and replay without exposing credentials or changing publication',async()=>{
 const {GoogleREST}=await import('../lib/google-rest.mjs');let calls=0;
 const client=new GoogleREST({project:'megabrain-v0-test',tokenProvider:()=> 'PRIVATE_TEST_TOKEN',fetchImpl:async()=>{
  calls++;return Response.json({error:{status:'INVALID_ARGUMENT',message:'Invalid responseSchema: nested enum limit. https://private.example/path Bearer PRIVATE_TEST_TOKEN owner@example.com'}},{status:400});
 }});
 const x=await setup('analysis',{analyze:()=>client.request('https://aiplatform.googleapis.com/v1/projects/megabrain-v0-test/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent',{method:'POST',json:{contents:[]},operationStep:'submit_analysis',model:'gemini-3.5-flash-lite',attempt:1})});
 const initial=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',pub(),{updateTime:initial.updateTime});
 await x.store.create('reels_finance/preserved',{status:'uncertain',amount:5});const financial=await x.store.get('reels_finance/preserved');
 const result=await x.pipeline.run({executionId:x.id}),saved=(await x.store.get('reels_executions/'+x.id)).data,video=(await x.store.get('videos/Reel_001')).data;
 assert.equal(result.status,'uncertain');assert.equal(result.error.destination,'reconcile');assert.equal(result.error.retryable,false);
 assert.equal(saved.error.google_diagnostic.http_status,400);assert.equal(saved.error.google_diagnostic.operation_step,'submit_analysis');assert.equal(saved.error.google_diagnostic.response_received,true);
 assert.equal(saved.error.provider_diagnostic.status,'INVALID_ARGUMENT');assert.match(saved.error.provider_diagnostic.message,/Invalid responseSchema: nested enum limit/);
 assert.deepEqual(video.reels_v2.error,saved.error);assert.equal(video.analysis_key,'saved');assert.equal(video.analysis.summary,'original');assert.deepEqual(await x.store.get('reels_finance/preserved'),financial);assert.doesNotThrow(()=>encodeFields(saved.error));
 const detail=await x.repository.detail('Reel_001');assert.equal(detail.executions[0].error.google_diagnostic.http_status,400);
 assert.ok(!/PRIVATE_TEST_TOKEN|private.example|owner@example.com/.test(JSON.stringify({result,saved,video,detail})));
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal(calls,1);assert.equal((await x.store.get('reels_executions/'+x.id)).data.error.provider_diagnostic.status,'INVALID_ARGUMENT');
});
test('failure metadata has a safe destination, stage and worker while provider diagnostics stay private',async()=>{
 for(const definitive of [false,true]){
  const x=await setup('analysis',{analyze:async()=>{throw Object.assign(Error('Bearer PRIVATE_API_KEY cookie=SECRET'),{code:'PROVIDER_UNAVAILABLE',definitive});}}),result=await x.pipeline.run({executionId:x.id});
  assert.equal(result.error.stage,'analysis');assert.equal(result.error.worker,'reels-analysis');assert.equal(result.error.destination,definitive?'retry':'reconcile');assert.doesNotThrow(()=>encodeFields(result.error));
  const detail=await x.repository.detail('Reel_001'),error=detail.executions[0].error;assert.equal(error.destination,definitive?'retry':'reconcile');assert.equal(error.uncertain,!definitive);assert.ok(!JSON.stringify({result,detail}).includes('PRIVATE_API_KEY'));assert.ok(!JSON.stringify({result,detail}).includes('SECRET'));
 }
});
test('each valid publication replaces derived keyword tags while preserving original tags and same-execution replay',async()=>{
 let keywords=['sopa',{term:'forno',evidence:[{excerpt:'quote not a tag'}]}];const x=await setup('analysis',{analyze:async()=>({valid:true,changes:{analysis:{summary:'saved',categories:['receitas'],knowledge:{keywords}},analysis_key:'saved',analysis_generation:keywords[0]==='sopa'?'1':'2',analysis_quality_status:'accepted'}})});
 const initial=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{tags:['manual']},{updateTime:initial.updateTime});await x.pipeline.run({executionId:x.id});
 assert.deepEqual((await x.store.get('videos/Reel_001')).data.published_tags,['sopa','forno']);
 const completed=(await x.store.get('reels_executions/'+x.id)).data;await x.pipeline.apply(completed);assert.deepEqual((await x.store.get('videos/Reel_001')).data.published_tags,['sopa','forno']);
 keywords=['arroz'];const id=executionId('complement','Reel_001','analysis'),video=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{reels_v2:{...video.data.reels_v2,status:'queued',stage:'analysis',operationId:'complement',executionId:id}},{updateTime:video.updateTime});await x.store.create('reels_executions/'+id,{id,reelId:'Reel_001',operationId:'complement',stage:'analysis',status:'queued',createdAt:new Date(clock()).toISOString()});await x.pipeline.run({executionId:id});
 const result=await x.store.get('videos/Reel_001');assert.deepEqual(result.data.tags,['manual']);assert.deepEqual(result.data.published_tags,['arroz']);assert.deepEqual((await x.repository.list()).items[0].tags,['manual','arroz']);
});
import {prepareQualityCandidateV2,qualitySourceManifest,qualityPublicationRevision,qualitySourceStateHash,qualityDigest,verifyPublicationQualityReceipt} from '../lib/reels-quality-gate.mjs';
import {ReelsPipeline,executionId} from '../lib/reels-pipeline.mjs';
async function setup(stage='acquisition',operations={},extra={}){const store=memory([reel()]),repository=new ReelsRepository({store,clock}),id=executionId('operation','Reel_001',stage);await store.create('reels_executions/'+id,{id,operationId:'operation',reelId:'Reel_001',stage,status:'queued',createdAt:new Date(clock()).toISOString()});return {store,repository,id,pipeline:new ReelsPipeline({repository,operations,processingEnabled:true,clock,...extra})};}
test('concurrent delivery calls acquisition once and creates next outbox with no finance document',async()=>{let calls=0;const x=await setup('acquisition',{acquire:async()=>{calls++;return {changes:{video_key:'v',video_generation:'1',media_verified:true}};}});const results=await Promise.all([x.pipeline.run({executionId:x.id}),x.pipeline.run({executionId:x.id})]);assert.equal(calls,1);assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'completed');assert.equal((await x.store.get('videos/Reel_001')).data.reels_v2.stage,'transcription');assert.ok([...x.store.docs.values()].some(x=>x.data.type!== 'event_receipt'&&x.data.stage==='transcription'&&x.data.status==='pending'));assert.equal(await x.store.get('settings/financial'),null);});
test('STT polling continues while paused without resubmitting paid call',async()=>{let submitted=0,collected=0;const x=await setup('transcription',{transcribe:async()=>{submitted++;return {pending:true,operationName:'projects/p/operations/speech-1'};},pollTranscription:async({operationName})=>{assert.equal(operationName,'projects/p/operations/speech-1');collected++;return {changes:{transcript:'saved'}};}});await x.pipeline.run({executionId:x.id});const control=await x.store.get('reels_controls/transcription');await x.store.patch('reels_controls/transcription',{paused:true},{updateTime:control.updateTime});await x.pipeline.collect({executionId:x.id});await x.pipeline.run({executionId:x.id});assert.equal(submitted,1);assert.equal(collected,1);assert.equal((await x.store.get('videos/Reel_001')).data.transcript,'saved');});
test('paid timeout remains uncertain and occupied; delivery retry never repeats',async()=>{let calls=0;const x=await setup('analysis',{analyze:async()=>{calls++;throw Object.assign(Error('timeout'),{name:'TimeoutError'});}});assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal(calls,1);assert.ok((await x.store.get('reels_controls/analysis')).data.active.includes(x.id));});
test('proven-stopped failed download frees physical capacity without retrying or clearing its uncertainty',async()=>{
 let calls=0,x;x=await setup('acquisition',{acquire:async({claim})=>{calls++;await x.store.create('execution_stops/'+x.id,{id:x.id,reelId:'Reel_001',stage:'acquisition',owner:claim.owner,executorStoppedAt:new Date(clock()).toISOString()});throw Error('download exited');}});stoppedCapacityStore(x.store);
 await x.store.create('reservations/preserved',{status:'uncertain',amount:5});await x.store.create('reels_finance/preserved',{status:'uncertain',amount:5});
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[]);
 const job=await x.store.get('reels_executions/'+x.id),video=await x.store.get('videos/Reel_001'),proof=await x.store.get('execution_stops/'+x.id),finance=await x.store.get('reels_finance/preserved'),reservation=await x.store.get('reservations/preserved');
 assert.equal(job.data.status,'uncertain');assert.equal(video.data.reels_v2.status,'uncertain');assert.equal(job.data.error.retryable,false);
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal(calls,1);
 for(const [path,snapshot]of [['reels_executions/'+x.id,job],['videos/Reel_001',video],['execution_stops/'+x.id,proof],['reels_finance/preserved',finance],['reservations/preserved',reservation]])assert.deepEqual(await x.store.get(path),snapshot);
});
test('download failure persists only the existing sanitized diagnostic allowlist',async()=>{
 const diagnostic={phase:'metadata',phase_source:'tool_output',cause:'unknown',detail_code:'metadata_extraction_failed',elapsed_ms:123,exit_code:1,yt_dlp_version:'2026.10.16',ffmpeg_version:'7.1',message:'PRIVATE_MESSAGE',stderr:'PRIVATE_STDERR',stdout:'PRIVATE_STDOUT',command:'PRIVATE_COMMAND',url:'https://private.invalid',cookie:'PRIVATE_COOKIE'};
 const x=await setup('acquisition',{acquire:async()=>{throw Object.assign(Error('PRIVATE_MESSAGE'),{code:1,download_diagnostic:diagnostic});}});
 const result=await x.pipeline.run({executionId:x.id}),job=(await x.store.get('reels_executions/'+x.id)).data,video=(await x.store.get('videos/Reel_001')).data;
 assert.equal(result.error.code,1);assert.equal(job.error.download_diagnostic.detail_code,'metadata_extraction_failed');assert.equal(job.error.download_diagnostic.elapsed_ms,123);assert.equal(job.error.download_diagnostic.yt_dlp_version,'2026.10.16');assert.deepEqual(video.reels_v2.error.download_diagnostic,job.error.download_diagnostic);assert.doesNotThrow(()=>encodeFields(job.error));
 assert.ok(!JSON.stringify({result,job,video}).includes('PRIVATE_'));assert.ok(!JSON.stringify({result,job,video}).includes('private.invalid'));assert.deepEqual(Object.keys(job.error.download_diagnostic).sort(),['cause','detail_code','elapsed_ms','exit_code','ffmpeg_version','message','phase','phase_source','tool','yt_dlp_version'].sort());
});
test('next queued Reel recovers a stopped slot after crash between saving uncertainty and updating video',async()=>{
 let calls=0,x;x=await setup('acquisition',{acquire:async({videoId,claim})=>{calls++;if(videoId!=='Reel_001')return {changes:{video_key:'saved'}};await x.store.create('execution_stops/'+x.id,{id:x.id,reelId:videoId,stage:'acquisition',owner:claim.owner,executorStoppedAt:new Date(clock()).toISOString()});throw Error('download exited');}});stoppedCapacityStore(x.store);
 const mark=x.pipeline.markVideo.bind(x.pipeline);x.pipeline.markVideo=async(job,status,...args)=>{if(status==='uncertain')throw Error('process interrupted before video acknowledgement');return mark(job,status,...args);};
 await assert.rejects(()=>x.pipeline.run({executionId:x.id}),/process interrupted/);assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[x.id]);
 const id=executionId('operation','Reel_002','acquisition');await x.store.create('videos/Reel_002',reel('Reel_002'));await x.store.create('reels_executions/'+id,{id,operationId:'operation',reelId:'Reel_002',stage:'acquisition',status:'queued',createdAt:new Date(clock()).toISOString()});
 const stopped=await x.store.get('reels_executions/'+x.id),proof=await x.store.get('execution_stops/'+x.id);
 assert.equal((await x.pipeline.run({executionId:id})).status,'completed');assert.equal(calls,2);assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[]);assert.deepEqual(await x.store.get('reels_executions/'+x.id),stopped);assert.deepEqual(await x.store.get('execution_stops/'+x.id),proof);
});
async function stoppedUncertainFixture(stage='acquisition'){
 const x=await setup(stage,{});stoppedCapacityStore(x.store);const at=new Date(clock()).toISOString(),job=await x.store.get('reels_executions/'+x.id),video=await x.store.get('videos/Reel_001');
 await x.store.patch('reels_executions/'+x.id,{status:'uncertain',owner:'stopped-owner',startedAt:at,submittedAt:at,failedAt:at},{updateTime:job.updateTime});
 await x.store.patch('videos/Reel_001',{reels_v2:{operationId:'operation',executionId:x.id,stage,status:'uncertain'}},{updateTime:video.updateTime});
 await x.store.create('execution_stops/'+x.id,{id:x.id,reelId:'Reel_001',stage,owner:'stopped-owner',executorStoppedAt:at});await x.store.create('reels_controls/'+stage,{active:[x.id],desiredConcurrency:1,paused:false});return x;
}
for(const invalid of ['absent','wrongId','wrongOwner','wrongReel','wrongStage','invalidTime','beforeSubmission','afterFailure','noOwner','resultSaved','externalOperation','supersededVideo','noncanonicalId'])test('stopped download proof fails closed: '+invalid,async()=>{
 const x=await stoppedUncertainFixture();const stop=await x.store.get('execution_stops/'+x.id),job=await x.store.get('reels_executions/'+x.id),video=await x.store.get('videos/Reel_001');
 const proofChanges={wrongId:{id:'a'.repeat(64)},wrongOwner:{owner:'other-owner'},wrongReel:{reelId:'Reel_002'},wrongStage:{stage:'analysis'},invalidTime:{executorStoppedAt:'invalid'},beforeSubmission:{executorStoppedAt:new Date(clock()-1).toISOString()},afterFailure:{executorStoppedAt:new Date(clock()+1).toISOString()}};
 if(invalid==='absent')x.store.docs.delete('execution_stops/'+x.id);
 else if(proofChanges[invalid])await x.store.patch('execution_stops/'+x.id,proofChanges[invalid],{updateTime:stop.updateTime});
 else if(invalid==='supersededVideo')await x.store.patch('videos/Reel_001',{reels_v2:{...video.data.reels_v2,operationId:'new-operation'}},{updateTime:video.updateTime});
 else await x.store.patch('reels_executions/'+x.id,invalid==='noOwner'?{owner:null}:invalid==='resultSaved'?{rawResult:{changes:{saved:true}}}:invalid==='externalOperation'?{operationName:'external-operation'}:{id:'b'.repeat(64)},{updateTime:job.updateTime});
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[x.id]);
});
for(const stage of ['transcription','analysis'])test('a stop-shaped receipt never frees uncertain paid '+stage+' capacity',async()=>{
 const x=await stoppedUncertainFixture(stage);assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/'+stage)).data.active,[x.id]);
});
test('settled local analysis adapter frees only physical occupancy, preserving paid uncertainty and preventing replay',async()=>{
 let calls=0,x;x=await setup('analysis',{analyze:async({claim})=>{calls++;await x.store.create('execution_stops/'+x.id,{id:x.id,reelId:'Reel_001',stage:'analysis',owner:claim.owner,kind:'analysis_adapter_settled',scope:'local_adapter',remoteOutcome:'unknown',executorStoppedAt:new Date(clock()).toISOString()});throw Object.assign(Error('timeout'),{name:'TimeoutError'});}});stoppedCapacityStore(x.store);
 await x.store.create('reservations/preserved',{status:'uncertain',amount:5});const reserved=await x.store.get('reservations/preserved');
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/analysis')).data.active,[]);
 const job=await x.store.get('reels_executions/'+x.id),proof=await x.store.get('execution_stops/'+x.id);assert.equal(job.data.error.retryable,false);assert.equal(proof.data.remoteOutcome,'unknown');
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal(calls,1);assert.deepEqual(await x.store.get('reels_executions/'+x.id),job);assert.deepEqual(await x.store.get('reservations/preserved'),reserved);
});
for(const mismatch of ['kind','scope','remoteOutcome','owner','operationName'])test('analysis local-slot release fails closed on '+mismatch+' mismatch',async()=>{
 const x=await stoppedUncertainFixture('analysis'),path='execution_stops/'+x.id,stop=await x.store.get(path);await x.store.patch(path,{kind:'analysis_adapter_settled',scope:'local_adapter',remoteOutcome:'unknown',...(mismatch==='operationName'?{}:{[mismatch]:'wrong'})},{updateTime:stop.updateTime});
 if(mismatch==='operationName'){const job=await x.store.get('reels_executions/'+x.id);await x.store.patch('reels_executions/'+x.id,{operationName:'external-operation'},{updateTime:job.updateTime});}
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/analysis')).data.active,[x.id]);
});
test('duplicate delivery repairs a proven stopped slot and does not remove concurrent active identities',async()=>{
 const x=await stoppedUncertainFixture(),control=await x.store.get('reels_controls/acquisition'),other='a'.repeat(64);await x.store.patch('reels_controls/acquisition',{active:[x.id,other]},{updateTime:control.updateTime});
 await Promise.all([x.pipeline.run({executionId:x.id}),x.pipeline.run({executionId:x.id})]);assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[other]);
});
for(const changed of ['execution','stop','video','control'])test('changed '+changed+' version atomically prevents stopped-slot release',async()=>{
 const x=await stoppedUncertainFixture(),release=x.store.releaseStoppedPhysicalCapacity;
 x.store.releaseStoppedPhysicalCapacity=async input=>{const path=changed==='execution'?'reels_executions/'+x.id:changed==='stop'?'execution_stops/'+x.id:changed==='video'?'videos/Reel_001':'reels_controls/acquisition';const current=await x.store.get(path);await x.store.patch(path,{testVersionChanged:true},{updateTime:current.updateTime});return release(input);};
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.deepEqual((await x.store.get('reels_controls/acquisition')).data.active,[x.id]);
});
test('saved raw result survives publication response loss and is reconciled without provider replay',async()=>{let calls=0;const x=await setup('analysis',{analyze:async()=>{calls++;return {valid:true,changes:{analysis:{summary:'new'},analysis_key:'new',analysis_generation:'2',analysis_quality_status:'accepted'}};}});const patch=x.store.patch;let lost=true;x.store.patch=async(p,d,o)=>{const r=await patch(p,d,o);if(p==='videos/Reel_001'&&d.analysis&&lost){lost=false;throw Error('response lost');}return r;};assert.equal((await x.pipeline.run({executionId:x.id})).status,'applying');assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.equal(calls,1);assert.equal((await x.store.get('reels_executions/'+x.id)).data.rawResult.changes.analysis.summary,'new');});
test('invalid candidate preserves original published analysis',async()=>{const x=await setup('analysis',{analyze:async()=>({valid:false,changes:{analysis:{summary:'bad'}}})});const v=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',pub(),{updateTime:v.updateTime});assert.equal((await x.pipeline.run({executionId:x.id})).status,'failed');assert.equal((await x.store.get('videos/Reel_001')).data.analysis.summary,'original');});
test('pausing isolated stage blocks new submissions without blocking acquisition',async()=>{const x=await setup('analysis',{analyze:async()=>{throw Error('must not call');}});await x.store.create('reels_controls/analysis',{paused:true,desiredConcurrency:2,effectiveConcurrency:0,active:[]});assert.equal((await x.pipeline.run({executionId:x.id})).reason,'TECHNICAL_BACKPRESSURE');});

test('dispatch failure keeps saved result applying until exact outbox is confirmed without provider replay',async()=>{
 let calls=0,unavailable=true;const identities=[];
 const x=await setup('acquisition',{acquire:async()=>{calls++;return {changes:{video_key:'v',video_generation:'1',media_verified:true}};}},{onQueued:async job=>{identities.push(job.outboxId);if(unavailable)throw Error('queue create rejected');}});
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'applying');assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'applying');
 unavailable=false;assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.equal(calls,1);assert.equal(identities[0],identities[1]);
});
test('terminal STT failure releases slot while transient collection remains waiting',async()=>{
 const x=await setup('transcription',{transcribe:async()=>({pending:true,operationName:'saved-operation'}),pollTranscription:async()=>{throw Object.assign(Error('terminal'),{definitive:true,code:'STT_TERMINAL_FAILURE'});}});
 await x.pipeline.run({executionId:x.id});assert.equal((await x.pipeline.collect({executionId:x.id})).status,'failed');assert.deepEqual((await x.store.get('reels_controls/transcription')).data.active,[]);
});

test('live claim asks delivery retry; interrupted executor becomes visible uncertain without paid replay',async()=>{
 let calls=0;const x=await setup('analysis',{analyze:async()=>{calls++;assert.fail('no resubmission');}});
 const p='reels_executions/'+x.id,s=await x.store.get(p);await x.store.patch(p,{status:'submitting',startedAt:new Date(clock()).toISOString()},{updateTime:s.updateTime});
 assert.equal((await x.pipeline.run({executionId:x.id})).reason,'EXECUTION_IN_PROGRESS');
 x.pipeline.clock=()=>clock()+900001;assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal((await x.repository.detail('Reel_001')).status,'uncertain');assert.equal(calls,0);
});
test('long-running adapter is visible as running before external result arrives',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);const x=await setup('analysis',{analyze:async()=>{assert.equal((await x.repository.detail('Reel_001')).status,'running');await pending;return {valid:true,changes:{analysis:{summary:'done'},analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted'}};}});
 const running=x.pipeline.run({executionId:x.id});finish();assert.equal((await running).status,'completed');
});

test('post-publication recurrence callback resumes saved result without another analysis',async()=>{
 let calls=0,checks=0;const x=await setup('analysis',{analyze:async()=>{calls++;return {valid:true,changes:{analysis:{summary:'published'},analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted'}};}},{onPublished:async job=>{assert.equal(job.id,x.id);checks++;if(checks===1)throw Error('index unavailable');}});
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.equal((await x.store.get('reels_executions/'+x.id)).data.catalogueIndex.status,'pending');const published=await x.store.get('videos/Reel_001');assert.equal(published.data.contextual_catalogue_event.id,x.id);assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.equal((await x.store.get('reels_executions/'+x.id)).data.catalogueIndex.status,'completed');assert.equal((await x.store.get('videos/Reel_001')).updateTime,published.updateTime);assert.equal(calls,1);assert.equal(checks,2);
});

test('valid complement replaces automatic category baseline while preserving explicit manual choices',async()=>{
 for(const manual of [false,true]){
  const x=await setup('analysis',{analyze:async()=>({valid:true,changes:{analysis:{summary:'New subject',categories:['technology']},analysis_key:'new',analysis_generation:'2',analysis_quality_status:'accepted'}})});
  const v=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{...pub(),categoryIds:['food','auto_recipe_list'],taxonomy_override:{manual,revision:1}},{updateTime:v.updateTime});
  await x.pipeline.run({executionId:x.id});assert.deepEqual((await x.store.get('videos/Reel_001')).data.categoryIds,manual?['food','auto_recipe_list']:['technology']);
 }
});

test('replay after post-publication category assignment does not erase the already derived child',async()=>{
 let derived=false;const x=await setup('analysis',{analyze:async()=>({valid:true,changes:{analysis:{categories:['food']},analysis_key:'new',analysis_generation:'2',analysis_quality_status:'accepted'}})},{onPublished:async()=>{if(derived)return;derived=true;const v=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{categoryIds:['food','auto_recipe_single']},{updateTime:v.updateTime});}});
 const emit=x.pipeline.emit.bind(x.pipeline);let lost=true;x.pipeline.emit=async(...args)=>{if(args[1]==='stage_completed'&&lost){lost=false;throw Error('event unavailable after discovery');}return emit(...args);};
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'applying');assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.deepEqual((await x.store.get('videos/Reel_001')).data.categoryIds,['food','auto_recipe_single']);
});


test('transient collection creates a fresh poll outbox while retaining the paid operation',async()=>{
 let submits=0,polls=0;const x=await setup('transcription',{transcribe:async()=>{submits++;return {pending:true,operationName:'speech/preserved'};},pollTranscription:async()=>{polls++;if(polls===1)throw Error('network');return {changes:{transcript:'recovered'}};}});
 await x.pipeline.run({executionId:x.id});const first=[...x.store.docs.values()].filter(x=>x.data.poll===true).map(x=>x.data.id);
 assert.equal((await x.pipeline.collect({executionId:x.id})).reason,'COLLECTION_UNAVAILABLE');
 const pending=[...x.store.docs.values()].filter(x=>x.data.poll===true).map(x=>x.data.id);assert.equal(pending.length,2);assert.ok(pending.some(id=>!first.includes(id)));
 assert.equal((await x.pipeline.collect({executionId:x.id})).status,'completed');assert.equal(submits,1);assert.equal(polls,2);
});
test('waiting submission replay reconstructs missing polling outbox without paid resubmission',async()=>{
 let calls=0;const x=await setup('transcription',{transcribe:async()=>{calls++;return {pending:true,operationName:'speech/preserved'};}});
 const create=x.store.create;let failOnce=true;x.store.create=async(p,d)=>{if(d.poll&&failOnce){failOnce=false;throw Error('outbox unavailable');}return create(p,d);};
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'waiting');
 await x.pipeline.run({executionId:x.id});assert.equal(calls,1);assert.equal([...x.store.docs.values()].filter(x=>x.data.poll===true).length,1);
});
test('paused stage blocks a queued job even when capacity already lists its identity',async()=>{
 let calls=0;const x=await setup('analysis',{analyze:async()=>{calls++;return {valid:true,changes:{}};}});
 await x.store.create('reels_controls/analysis',{paused:true,desiredConcurrency:2,effectiveConcurrency:2,active:[x.id]});
 assert.equal((await x.pipeline.run({executionId:x.id})).reason,'TECHNICAL_BACKPRESSURE');assert.equal(calls,0);
});
test('invalid result retains candidate artifacts and reasons without altering valid publication',async()=>{
 const x=await setup('analysis',{analyze:async()=>({valid:false,changes:{analysis:{summary:'invalid'},analysis_key:'invalid',candidate_analysis_key:'candidate',candidate_analysis_generation:'9',analysis_candidate:{summary:'review'},analysis_review_reasons:['missing_evidence']}})});
 const v=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',pub(),{updateTime:v.updateTime});
 await x.pipeline.run({executionId:x.id});const video=(await x.store.get('videos/Reel_001')).data;
 assert.equal(video.analysis_key,'saved');assert.equal(video.analysis.summary,'original');assert.equal(video.candidate_analysis_key,'candidate');assert.equal(video.analysis_candidate.summary,'review');assert.deepEqual(video.analysis_review_reasons,['missing_evidence']);
});
test('replay of saved application cannot regress an already running next stage',async()=>{
 const x=await setup('acquisition',{acquire:async()=>({changes:{video_key:'saved'}})});
 await x.pipeline.run({executionId:x.id});const job=(await x.store.get('reels_executions/'+x.id)).data;
 const nextId=executionId('operation','Reel_001','transcription'),video=await x.store.get('videos/Reel_001');
 await x.store.patch('videos/Reel_001',{reels_v2:{...video.data.reels_v2,status:'running',executionId:nextId}},{updateTime:video.updateTime});
 await x.pipeline.apply(job);assert.equal((await x.store.get('videos/Reel_001')).data.reels_v2.status,'running');
 assert.equal((await x.store.get('videos/Reel_001')).data.reels_v2.executionId,nextId);
});
test('STT collection resumes an interrupted collecting claim without another submission',async()=>{
 let submits=0,polls=0;const x=await setup('transcription',{transcribe:async()=>{submits++;return {pending:true,operationName:'speech/one-operation'};},pollTranscription:async()=>{polls++;return {changes:{transcript:'recovered'}};}});
 await x.pipeline.run({executionId:x.id});const saved=await x.store.get('reels_executions/'+x.id);
 await x.store.patch('reels_executions/'+x.id,{status:'collecting',pollOwner:'interrupted-owner'},{updateTime:saved.updateTime});
 assert.equal((await x.pipeline.collect({executionId:x.id})).status,'completed');assert.equal(submits,1);assert.equal(polls,1);
});
test('lost pending-poll acknowledgement reconstructs its exact next outbox',async()=>{
 const x=await setup('transcription',{transcribe:async()=>({pending:true,operationName:'speech/one-operation'}),pollTranscription:async()=>({pending:true})});
 await x.pipeline.run({executionId:x.id});const patch=x.store.patch;let lost=true;
 x.store.patch=async(p,d,o)=>{const r=await patch(p,d,o);if(p==='reels_executions/'+x.id&&d.status==='waiting'&&d.pollSequence===1&&lost){lost=false;throw Error('pending acknowledgement lost');}return r;};
 assert.equal((await x.pipeline.collect({executionId:x.id})).status,'waiting');
 assert.equal((await x.store.get('reels_executions/'+x.id)).data.pollSequence,1);
 assert.equal([...x.store.docs.values()].filter(x=>x.data.poll===true).length,2);
});
test('lost collected-result save acknowledgement applies saved result without repolling',async()=>{
 let polls=0;const x=await setup('transcription',{transcribe:async()=>({pending:true,operationName:'speech/one-operation'}),pollTranscription:async()=>{polls++;return {changes:{transcript:'saved'}};}});
 await x.pipeline.run({executionId:x.id});const patch=x.store.patch;let lost=true;
 x.store.patch=async(p,d,o)=>{const r=await patch(p,d,o);if(p==='reels_executions/'+x.id&&d.status==='applying'&&lost){lost=false;throw Error('result acknowledgement lost');}return r;};
 assert.equal((await x.pipeline.collect({executionId:x.id})).status,'completed');assert.equal(polls,1);
 assert.equal((await x.store.get('videos/Reel_001')).data.transcript,'saved');
});
test('event write failure preserves published result for reconciliation instead of making it uncertain',async()=>{
 const x=await setup('analysis',{analyze:async()=>({valid:true,changes:{analysis:{summary:'published'},analysis_key:'valid',analysis_generation:'2',analysis_quality_status:'accepted'}})});
 const create=x.store.create;x.store.create=async(p,d)=>{if(p==='settings/reels_v2_event_clock')throw Error('event store unavailable');return create(p,d);};
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'applying');
 assert.equal((await x.store.get('videos/Reel_001')).data.reels_v2.status,'completed');
 assert.equal((await x.store.get('videos/Reel_001')).data.analysis.summary,'published');
 x.store.create=create;assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');
});

function sourceBoundFixture(){
 const record={id:'Reel_001',media_verified:true,duration_seconds:20,video_key:'originals/instagram/Reel_001/video.mp4',video_generation:'1',audio_key:'results/instagram/Reel_001/audio.flac',audio_generation:'2',audio_bytes:1,audio_sha256:'a'.repeat(64),audio_source_key:'originals/instagram/Reel_001/video.mp4',audio_source_generation:'1',transcript:'Fonte literal salva.',transcript_key:'results/instagram/Reel_001/transcript.json',transcript_generation:'3',source_caption:{text:'Fonte literal salva.',capture_id:'capture_fixture'},analysis:{summary:'Anterior preservado'},analysis_key:'previous.json',analysis_generation:'9',analysis_quality_status:'accepted'};
 const m=qualitySourceManifest(record),proof={source:'caption',sourceIdentity:m.caption,excerpt:record.source_caption.text};
 const report={title:record.source_caption.text,summary:record.source_caption.text,categories:['a-organizar'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Sem acurácia independente medida.',uncertain_segments:[]},knowledge:{context:'general',fields:[{kind:'other',name:'Informação',value:record.source_caption.text,evidence:[proof]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[proof],summary:[proof]}};
 return {record,report,mediaInspection:{kind:'media-inspector',receiptId:'saved_inspection',sourceIdentity:m.video,decodePassed:true,probePassed:true,durationSeconds:20,expectedAudio:true,audioTrackPresent:true},transcriptionReceipt:{operationIdentity:'saved_operation',sourceAudioIdentity:m.audio,resultIdentity:m.transcript,rawResultIdentity:m.transcript,words:[]}};
}
async function preparedPipelineResult(store,video,fixture){
 const q=await prepareQualityCandidateV2({record:video,report:fixture.report,rawResponse:{saved:true},mediaInspection:fixture.mediaInspection,transcriptionReceipt:fixture.transcriptionReceipt,expectedPublicationRevision:qualityPublicationRevision(video),ports:{saveCandidate:async value=>({key:'results/instagram/Reel_001/quality-candidate.json',generation:'10',candidateContentHash:value.candidateContentHash}),saveReceipt:async receipt=>{await store.create('reels_quality_receipts/'+receipt.id,receipt);return {id:receipt.id,receiptHash:qualityDigest(receipt)};}}});
 assert.equal(q.accepted,true);
 return {valid:true,quality:q,changes:{analysis:fixture.report,analysis_key:q.candidateIdentity.key,analysis_generation:q.candidateIdentity.generation,analysis_quality_status:'accepted'},qualityPublication:{policyVersion:'gate_v2',expectedSourceStateHash:qualitySourceStateHash(video),expectedPublicationRevision:q.expectedPublicationRevision,publicationIdentity:q.publicationIdentity,qualityReceipt:q.receiptIdentity}};
}
for(const conflict of [false,true])test('strict quality publication requires durable receipt and one source/current-pointer CAS (conflict='+conflict+')',async()=>{
 const f=sourceBoundFixture();let x,pointerWrites=0;
 x=await setup('analysis',{analyze:async({video})=>{const result=await preparedPipelineResult(x.store,video,f);if(conflict){const current=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{analysis_key:'concurrent.json',analysis_generation:'11',analysis:{summary:'Concurrent winner'}},{updateTime:current.updateTime});}return result;}},{requiredQualityPolicyVersion:'gate_v2'});
 const initial=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',f.record,{updateTime:initial.updateTime});
 const patch=x.store.patch;x.store.patch=async(path,changes,options)=>{if(path==='videos/Reel_001'&&changes.analysis_key?.endsWith('quality-candidate.json')){pointerWrites++;assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'applying');assert.ok((await x.store.get('reels_executions/'+x.id)).data.rawResult);assert.ok(await x.store.get('reels_quality_receipts/'+changes.publication.qualityReceipt.receiptId));}return patch(path,changes,options);};
 const result=await x.pipeline.run({executionId:x.id}),video=(await x.store.get('videos/Reel_001')).data;
 if(conflict){assert.equal(result.reason,'QUALITY_PUBLICATION_REVISION_CONFLICT');assert.equal(result.qualityState,'inconclusive');assert.equal(video.analysis_key,'concurrent.json');assert.equal(video.analysis.summary,'Concurrent winner');assert.ok(video.candidate_analysis_key.endsWith('quality-candidate.json'));assert.equal(pointerWrites,0);}
 else {assert.equal(result.status,'completed');assert.equal(pointerWrites,1);const receipt=(await x.store.get('reels_quality_receipts/'+video.publication.qualityReceipt.receiptId)).data;assert.equal(verifyPublicationQualityReceipt({video,receipt}).trusted,true);await x.pipeline.run({executionId:x.id});assert.equal(pointerWrites,1);}
});
test('strict pipeline rejects forged valid boolean without an exact stored receipt and preserves last success',async()=>{
 const x=await setup('analysis',{analyze:async()=>({valid:true,changes:{analysis:{summary:'Forged'},analysis_key:'forged',analysis_generation:'2'}})},{requiredQualityPolicyVersion:'gate_v2'}),s=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{analysis:{summary:'Last success'},analysis_key:'previous',analysis_generation:'1'},{updateTime:s.updateTime});
 const result=await x.pipeline.run({executionId:x.id});assert.equal(result.qualityState,'inconclusive');assert.equal((await x.store.get('videos/Reel_001')).data.analysis.summary,'Last success');assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'failed');
});

test('source evidence changed after candidate preparation cannot be overwritten by its stale publication proposal',async()=>{
 const f=sourceBoundFixture();let x;x=await setup('analysis',{analyze:async({video})=>{const result=await preparedPipelineResult(x.store,video,f),current=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',{source_caption:{text:'Fonte posterior',capture_id:'new_capture'}},{updateTime:current.updateTime});return result;}},{requiredQualityPolicyVersion:'gate_v2'});
 const current=await x.store.get('videos/Reel_001');await x.store.patch('videos/Reel_001',f.record,{updateTime:current.updateTime});const result=await x.pipeline.run({executionId:x.id}),saved=(await x.store.get('videos/Reel_001')).data;
 assert.equal(result.reason,'QUALITY_RECEIPT_UNVERIFIED');assert.equal(saved.source_caption.capture_id,'new_capture');assert.equal(saved.analysis_key,'previous.json');assert.equal(saved.analysis.summary,'Anterior preservado');
});

test('publication and pending catalogue intent survive a crash before the secondary event is created',async()=>{
 let paidCalls=0,indexCalls=0;
 const x=await setup('analysis',{analyze:async()=>{paidCalls++;return {valid:true,changes:{analysis:{summary:'Saved publication'},analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted'}};}},{onPublished:async job=>{indexCalls++;assert.equal(job.id,x.id);return {committed:true};}});
 const refresh=x.repository.refresh.bind(x.repository);let crash=true;
 x.repository.refresh=async id=>{const current=await x.store.get('videos/'+id);if(crash&&current?.data.analysis_key==='saved'&&current.data.contextual_catalogue_event?.id===x.id){crash=false;throw Error('Synthetic process interruption after publication CAS');}return refresh(id);};
 const interrupted=await x.pipeline.run({executionId:x.id});
 assert.equal(interrupted.status,'applying');assert.equal(indexCalls,0);assert.equal(paidCalls,1);
 const durable=await x.store.get('videos/Reel_001');assert.equal(durable.data.analysis_key,'saved');assert.deepEqual(durable.data.contextual_catalogue_event,{id:x.id,type:'publicationAccepted',reelId:'Reel_001',status:'pending',analysisKey:'saved',analysisGeneration:'1'});
 assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'applying');
 const resumed=await x.pipeline.run({executionId:x.id});assert.equal(resumed.status,'completed');assert.equal(paidCalls,1);assert.equal(indexCalls,1);assert.equal((await x.store.get('reels_executions/'+x.id)).data.catalogueIndex.status,'completed');
 assert.equal((await x.store.get('videos/Reel_001')).data.contextual_catalogue_event.id,x.id);
});
