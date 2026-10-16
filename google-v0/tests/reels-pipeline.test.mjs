import test from 'node:test';import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null};}};return store;}
const clock=()=>Date.parse('2026-10-16T03:30:00Z');
const reel=(id='Reel_001',extra={})=>({id,status:'registered',created_at:'2026-10-16T03:00:00Z',...extra});
const pub=(id='Reel_001',extra={})=>reel(id,{status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'original',evidence:{categories:[]}},...extra});
import {ReelsPipeline,executionId} from '../lib/reels-pipeline.mjs';
async function setup(stage='acquisition',operations={},extra={}){const store=memory([reel()]),repository=new ReelsRepository({store,clock}),id=executionId('operation','Reel_001',stage);await store.create('reels_executions/'+id,{id,operationId:'operation',reelId:'Reel_001',stage,status:'queued',createdAt:new Date(clock()).toISOString()});return {store,repository,id,pipeline:new ReelsPipeline({repository,operations,processingEnabled:true,clock,...extra})};}
test('concurrent delivery calls acquisition once and creates next outbox with no finance document',async()=>{let calls=0;const x=await setup('acquisition',{acquire:async()=>{calls++;return {changes:{video_key:'v',video_generation:'1',media_verified:true}};}});const results=await Promise.all([x.pipeline.run({executionId:x.id}),x.pipeline.run({executionId:x.id})]);assert.equal(calls,1);assert.equal((await x.store.get('reels_executions/'+x.id)).data.status,'completed');assert.equal((await x.store.get('videos/Reel_001')).data.reels_v2.stage,'transcription');assert.ok([...x.store.docs.values()].some(x=>x.data.type!== 'event_receipt'&&x.data.stage==='transcription'&&x.data.status==='pending'));assert.equal(await x.store.get('settings/financial'),null);});
test('STT polling continues while paused without resubmitting paid call',async()=>{let submitted=0,collected=0;const x=await setup('transcription',{transcribe:async()=>{submitted++;return {pending:true,operationName:'projects/p/operations/speech-1'};},pollTranscription:async({operationName})=>{assert.equal(operationName,'projects/p/operations/speech-1');collected++;return {changes:{transcript:'saved'}};}});await x.pipeline.run({executionId:x.id});const control=await x.store.get('reels_controls/transcription');await x.store.patch('reels_controls/transcription',{paused:true},{updateTime:control.updateTime});await x.pipeline.collect({executionId:x.id});await x.pipeline.run({executionId:x.id});assert.equal(submitted,1);assert.equal(collected,1);assert.equal((await x.store.get('videos/Reel_001')).data.transcript,'saved');});
test('paid timeout remains uncertain and occupied; delivery retry never repeats',async()=>{let calls=0;const x=await setup('analysis',{analyze:async()=>{calls++;throw Object.assign(Error('timeout'),{name:'TimeoutError'});}});assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal((await x.pipeline.run({executionId:x.id})).status,'uncertain');assert.equal(calls,1);assert.ok((await x.store.get('reels_controls/analysis')).data.active.includes(x.id));});
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
 assert.equal((await x.pipeline.run({executionId:x.id})).status,'applying');assert.equal((await x.pipeline.run({executionId:x.id})).status,'completed');assert.equal(calls,1);assert.equal(checks,2);
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
