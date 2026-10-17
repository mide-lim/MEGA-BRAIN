import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareConfirmedFailureReset,applyConfirmedFailureReset,resetMetadataRecord,resetWrites,resetDeletedFields,validateResetPlan} from '../lib/reels-confirmed-failure-reset.mjs';
import {createResetOwnerStore} from '../scripts/reset-confirmed-failures.mjs';
import {projectMigrationHistory} from '../lib/reels-migration-history.mjs';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/confirmed-failure-reset-evidence.json',import.meta.url)));
const clone=structuredClone,project='megabrain-v0-1017370021431',at='2026-10-17T01:00:00Z';
function memory(input,{ambiguous=false,beforeCommit}={}){
 const docs=new Map(input.records.map(r=>[r.path,clone(r)]));let commits=0;
 return {docs,beginResetTransaction:async()=>'synthetic-tx',rollbackResetTransaction:async()=>{},get commits(){return commits;},inspectResetMetadata:async()=>clone([...docs.values()]),atomicResetCommit:async(writes,{transaction})=>{assert.equal(transaction,'synthetic-tx');
  beforeCommit?.(docs);const prefix=`projects/${project}/databases/(default)/documents/`;
  for(const w of writes){const path=(w.verify??w.delete??w.update.name).slice(prefix.length),r=docs.get(path);if(w.currentDocument.exists===false){assert.equal(r,undefined);}else assert.equal(r?.updateTime,w.currentDocument.updateTime);}
  commits++;const copy=new Map(docs);
  for(const w of writes){if(w.verify)continue;const path=(w.delete??w.update.name).slice(prefix.length);if(w.delete)copy.delete(path);else{const v=copy.get(path),data={...v.data,status:'registered',importHeld:false,uncertain:false,paidUncertain:false,errorUncertain:false,operationalStatus:null,resetRule:'confirmed-legacy-failure-reset-v1',resetPlan:w.update.fields.operational_reset.mapValue.fields.planSHA256.stringValue};copy.set(path,{...v,data,updateTime:at});}}
  docs.clear();for(const [k,v]of copy)docs.set(k,v);if(ambiguous)throw Error('response lost');return {};
 }};
}
const run=(store,plan,extra={})=>applyConfirmedFailureReset({plan,approvedPlanSHA256:plan.planSHA256,store,project,assertClosed:async()=>{},clock:()=>Date.parse(at),...extra});
test('metadata boundary exports neither diagnostic text nor analysis/transcript or error backup',()=>{
 const record=resetMetadataRecord({path:'videos/Reel_001',updateTime:at,data:{id:'Reel_001',status:'uncertain',error:{message:'PRIVATE_ERROR',uncertain:true},transcript:'PRIVATE_TRANSCRIPT',analysis:{summary:'PRIVATE_CONTENT'},source_caption:'PRIVATE_CAPTION'}});
 const text=JSON.stringify(record);for(const secret of ['PRIVATE_ERROR','PRIVATE_TRANSCRIPT','PRIVATE_CONTENT','PRIVATE_CAPTION'])assert.ok(!text.includes(secret));assert.equal(record.data.publicationProtected,true);
 const input=fixture(),before=JSON.stringify(input),plan=prepareConfirmedFailureReset(input);assert.equal(plan.rows.length,1);assert.equal(plan.createsErrorBackup,false);assert.equal(JSON.stringify(input),before);assert.equal(plan.approved,false);assert.ok(!JSON.stringify(plan).includes('protectedReelIds'));const injected=fixture();injected.source.rawError='PRIVATE_ERROR';assert.ok(!JSON.stringify(prepareConfirmedFailureReset(injected)).includes('PRIVATE_ERROR'));
});
test('all positive terminal categories accepted; generic attention, incomplete and forged plans fail closed',()=>{
 const classifications=[['no_audio_no_stt_call','needs_attention'],['stt_terminal_no_speech','no_speech'],['download_terminal_failure','needs_attention'],['instagram_access_denied','needs_attention'],['non_video_terminal','skipped']];
 for(const [classification,sourceStatus]of classifications){const f=fixture();Object.assign(f.attestations[0],{classification,sourceStatus});assert.equal(prepareConfirmedFailureReset(f).rows.length,1);}
 const generic=fixture();generic.attestations[0].classification='needs_conference';assert.throws(()=>prepareConfirmedFailureReset(generic),/Positive/);
 const incomplete=fixture();incomplete.observationComplete=false;assert.throws(()=>prepareConfirmedFailureReset(incomplete),/Complete/);
 const plan=prepareConfirmedFailureReset(fixture());plan.rows[0].id='Other_001';assert.throws(()=>validateResetPlan(plan),/hash/);
});
test('publication, saved candidate, any linked paid claim or execution are protected including mixed controls',()=>{
 for(const collection of ['jobs','reels_executions','execution_stops','analyses','reels_reconciliations']){const f=fixture();f.records.push({path:collection+'/protected',updateTime:at,data:{reelId:'Reel_001',status:'uncertain'}});assert.equal(prepareConfirmedFailureReset(f).rows.length,0);}
 for(const patch of [{publicationProtected:true},{paidUncertain:true},{status:'running'},{uncertain:true,legacyImportPlaceholder:false},{errorUncertain:true,legacyImportPlaceholder:false}]){const f=fixture();Object.assign(f.records[0].data,patch);assert.equal(prepareConfirmedFailureReset(f).rows.length,0);}
 const legacy=fixture();legacy.records.push({path:'reels_legacy_content/Reel_001',updateTime:at,data:{reelId:'Reel_001',publicationProtected:true,originalStatus:'analyzed'}});assert.equal(prepareConfirmedFailureReset(legacy).rows.length,0);
 const claims=fixture();claims.records[2].data.protectedReelIds=['Reel_001','Published_001'];assert.equal(prepareConfirmedFailureReset(claims).rows.length,0);
 const candidate=resetMetadataRecord({path:'videos/Reel_001',updateTime:at,data:{reels_v2:{candidate:{state:'review_required'}}}});assert.equal(candidate.data.publicationProtected,true);
});
test('atomic writes delete actual linked failure history and operational leaves without deleting objects/finance',async()=>{
 const f=fixture(),plan=prepareConfirmedFailureReset(f),store=memory(f),writes=resetWrites(plan.rows[0],plan.planSHA256,{project,at,guardRecords:plan.guardRecords});
 assert.ok(writes.some(w=>w.delete?.endsWith('/reels_historical_activity/old_failure')));assert.ok(writes.every(w=>w.update||w.delete));assert.ok(writes.every(w=>!w.verify));assert.equal(plan.guardRecords.length,2);
 const update=writes.find(w=>w.update);for(const field of resetDeletedFields){assert.ok(update.updateMask.fieldPaths.includes(field));assert.equal(update.update.fields[field],undefined);}
 for(const field of ['media_verified','video_key','video_generation','audio_key','audio_generation','transcript_key','transcript_generation','transcript','transcript_segments'])assert.ok(!update.updateMask.fieldPaths.includes(field));
 assert.equal(writes.filter(w=>w.delete).length,1);assert.equal(writes.some(w=>w.delete?.includes('financial')),false);
 const result=await run(store,plan);assert.equal(result.resetCount,1);assert.equal(result.startedReels,0);assert.equal(store.docs.has('reels_historical_activity/old_failure'),false);assert.equal(store.docs.get('videos/Reel_001').data.status,'registered');assert.equal(store.docs.has('settings/financial'),true);
 assert.equal((await run(store,plan)).alreadyReset,1);assert.equal(store.commits,1);
});
test('version conflict, new history/claim or stale approval abort without partial cleanup',async()=>{
 for(const change of [f=>{f.records[0].updateTime=at;},f=>{f.records[2].data.protectedReelIds=['Reel_001'];},f=>{f.records.push({path:'reels_historical_activity/new_error',updateTime:at,data:{reelId:'Reel_001',historical:true,executable:false}});}]){
  const input=fixture(),plan=prepareConfirmedFailureReset(input);change(input);const store=memory(input);await assert.rejects(()=>run(store,plan));assert.equal(store.commits,0);assert.ok(store.docs.has('reels_historical_activity/old_failure'));
 }
 const input=fixture(),plan=prepareConfirmedFailureReset(input),store=memory(input);await assert.rejects(()=>run(store,plan,{approvedPlanSHA256:'0'.repeat(64)}));assert.equal(store.commits,0);
});
test('ambiguous commit response is reconciled by readback once; no second paid/metadata write',async()=>{
 const input=fixture(),plan=prepareConfirmedFailureReset(input),store=memory(input,{ambiguous:true});const result=await run(store,plan);assert.equal(store.commits,1);assert.equal(result.receipts[0].ambiguousResponseReconciled,true);
 const stopped=memory(input);await assert.rejects(()=>run(stopped,plan,{assertClosed:async()=>{throw Error('worker active');}}));assert.equal(stopped.commits,0);
});
test('re-import does not resurrect erased operational history; accounting remains separate',()=>{
 const result=projectMigrationHistory({googleSnapshot:{records:[{path:'videos/Reel_001',data:{id:'Reel_001',status:'failed'},updateTime:at},{path:'jobs/old_job',data:{video_id:'Reel_001',stage:'upload',status:'failed'},updateTime:at}]},legacySnapshot:{histories:{automation_attempts:[{video_id:'Reel_001',started_at:at}]}},targetVideos:[{id:'Reel_001',status:'registered',operational_reset:{rule:'confirmed-legacy-failure-reset-v1'}}]});
 assert.equal(result.historyView.length,0);assert.equal(result.unlinkedHistory.length,0);assert.equal(result.coverage.selection.filter(x=>x.disposition==='erased_confirmed_failure_history').length,2);
});

test('a claim arriving immediately before atomic commit prevents all writes and stops the cohort',async()=>{
 const input=fixture(),second=clone(input.attestations[0]);second.id='Reel_002';input.attestations.push(second);input.records.push({...clone(input.records[0]),path:'videos/Reel_002',data:{...input.records[0].data,id:'Reel_002'}});const plan=prepareConfirmedFailureReset(input);
 const store=memory(input,{beforeCommit:docs=>{const guard=docs.get('settings/capacity');guard.updateTime=at;guard.data.protectedReelIds=['Reel_001'];throw Error('ABORTED: transactional guard read changed');}});
 await assert.rejects(()=>run(store,plan));assert.equal(store.commits,0);assert.equal(store.docs.get('videos/Reel_001').data.status,'uncertain');assert.equal(store.docs.get('videos/Reel_002').data.status,'uncertain');assert.ok(store.docs.has('reels_historical_activity/old_failure'));
});

test('wire adapter uses official Firestore transaction fields for GET, query, commit and rollback',async()=>{
 const calls=[],api={project,request:async(url,options={})=>{calls.push({url,options});if(url.endsWith(':beginTransaction'))return {transaction:'opaque-read-write-tx'};if(url.includes(':runQuery'))return [];if(url.endsWith(':batchGet'))return options.json.documents.map(missing=>({missing,readTime:at}));if(url.includes(':commit')||url.includes(':rollback'))return {};throw Object.assign(Error('not found'),{status:404});}};
 assert.throws(()=>createResetOwnerStore(api),/runtime guard/);const store=createResetOwnerStore(api,{assertRuntimeClosed:async()=>{}}),transaction=await store.beginResetTransaction();
 await store.inspectResetMetadata('Reel_001',{transaction});const fixturePlan=prepareConfirmedFailureReset(fixture()),writes=resetWrites(fixturePlan.rows[0],fixturePlan.planSHA256,{project,at});await store.atomicResetCommit(writes,{transaction});await store.rollbackResetTransaction(transaction);
 assert.deepEqual(calls[0].options.json,{options:{readWrite:{}}});assert.ok(calls.filter(c=>c.url.includes(':runQuery')).every(c=>c.options.json.transaction===transaction));const batchGets=calls.filter(c=>c.url.endsWith(':batchGet'));assert.equal(batchGets.length,4);assert.ok(batchGets.every(c=>c.options.json.transaction===transaction&&c.options.json.documents.length===1&&c.options.json.documents[0].startsWith(`projects/${project}/databases/(default)/documents/`)));assert.equal(calls.filter(c=>!c.options.method).length,0);
 const commit=calls.find(c=>c.url.endsWith(':commit')).options.json;assert.equal(commit.transaction,transaction);assert.ok(commit.writes.every(w=>!w.verify&&Object.keys(w).every(k=>['update','delete','updateMask','currentDocument'].includes(k))));assert.deepEqual(calls.at(-1).options.json,{transaction});
 await assert.rejects(()=>store.atomicResetCommit([{verify:'forbidden'}],{transaction}),/contract/);
});
test('an existing legacy record must bind normalized evidence to its exact status and source provenance',()=>{
 const input=fixture();input.source.legacySnapshotCanonicalSHA256='e'.repeat(64);input.records.push({path:'reels_legacy_content/Reel_001',updateTime:at,data:{reelId:'Reel_001',publicationProtected:false,originalStatus:'needs_attention',provenanceRecordSHA256:'c'.repeat(64),provenanceSnapshotSHA256:'e'.repeat(64)}});
 assert.equal(prepareConfirmedFailureReset(input).rows.length,1);
 for(const field of ['originalStatus','provenanceRecordSHA256','provenanceSnapshotSHA256']){const changed=clone(input);changed.records.at(-1).data[field]='different';assert.throws(()=>prepareConfirmedFailureReset(changed),/provenance/);}
});

test('post-commit new uncertainty or linked history stops before a second Reel is reset',async()=>{
 for(const contaminate of [docs=>{docs.get('videos/Reel_001').data.uncertain=true;},docs=>{docs.set('reels_events/new_event',{path:'reels_events/new_event',updateTime:at,data:{reelId:'Reel_001',status:'uncertain'}});},docs=>{docs.get('settings/capacity').data.protectedReelIds=['Reel_001'];}]){
  const input=fixture(),second=clone(input.attestations[0]);second.id='Reel_002';input.attestations.push(second);input.records.push({...clone(input.records[0]),path:'videos/Reel_002',data:{...input.records[0].data,id:'Reel_002'}});const plan=prepareConfirmedFailureReset(input),store=memory(input),original=store.atomicResetCommit;store.atomicResetCommit=async(...args)=>{await original(...args);contaminate(store.docs);};
  await assert.rejects(()=>run(store,plan),/unconfirmed/);assert.equal(store.commits,1);assert.equal(store.docs.get('videos/Reel_002').data.status,'uncertain');
 }
});

test('durable metadata intent precedes commit and acknowledgement follows verified readback',async()=>{
 const input=fixture(),plan=prepareConfirmedFailureReset(input),store=memory(input),events=[];
 await run(store,plan,{onReceipt:async receipt=>{events.push({...receipt,commitsAtReceipt:store.commits});}});assert.deepEqual(events.map(e=>[e.status,e.commitsAtReceipt]),[['intent',0],['reset',1]]);assert.equal(events[0].expectedUpdateTime,input.records[0].updateTime);assert.equal(events[1].observedUpdateTime,at);
 const rejected=memory(input);await assert.rejects(()=>run(rejected,plan,{onReceipt:async()=>{throw Error('journal unavailable');}}));assert.equal(rejected.commits,0);
});

test('owner metadata reads are bounded to eight concurrent requests and retain transaction identity',async()=>{
 let active=0,maxActive=0,count=0;const api={project,request:async(url,options={})=>{active++;maxActive=Math.max(maxActive,active);count++;await new Promise(resolve=>setImmediate(resolve));active--;if(url.endsWith(':runQuery')){assert.equal(options.json.transaction,'one-tx');return [];}assert.ok(url.endsWith(':batchGet'));assert.equal(options.json.transaction,'one-tx');return options.json.documents.map(missing=>({missing,readTime:at}));}};
 const store=createResetOwnerStore(api,{assertRuntimeClosed:async()=>{}});await store.inspectResetMetadata('Reel_001',{transaction:'one-tx'});assert.ok(maxActive>1);assert.ok(maxActive<=8);assert.ok(count>=18);
});

test('transactional batchGet rejects empty, duplicate, mixed and outside-identity responses',async()=>{
 for(const response of [()=>[],name=>[{missing:name},{missing:name}],name=>[{found:{name,fields:{},updateTime:at},missing:name}],name=>[{found:{name:name+'_other',fields:{},updateTime:at}}],name=>[{missing:name+'_other'}]]){
  const api={project,request:async(url,options={})=>{if(url.endsWith(':runQuery'))return [];assert.ok(url.endsWith(':batchGet'));return response(options.json.documents[0]);}},store=createResetOwnerStore(api,{assertRuntimeClosed:async()=>{}});await assert.rejects(()=>store.inspectResetMetadata('Reel_001',{transaction:'exact-tx'}),/membership|identity/);
 }
});

function closedControlREST(active={arrayValue:{}}){return {fields:{paused:{booleanValue:true},active,desiredConcurrency:{integerValue:'1'},effectiveConcurrency:{integerValue:'1'}}};}
function closedOwnerRESTStore(control,{runtimeGuard=async()=>{}}={}){
 const calls=[],api={project,request:async(url,options={})=>{calls.push({url,options});if(url.includes('/reels_controls/'))return structuredClone(control);if(url.includes('cloudtasks.googleapis.com/')&&new URL(url).pathname.endsWith('/tasks'))return {};if(url.includes('cloudtasks.googleapis.com/'))return {state:'PAUSED'};throw Error('unexpected endpoint');}};return {store:createResetOwnerStore(api,{assertRuntimeClosed:runtimeGuard}),calls};
}
test('owner guard accepts persisted raw REST empty arrays with configured desired/effective capacity one',async()=>{
 for(const active of [{arrayValue:{}},{arrayValue:{values:[]}}]){let runtimeChecks=0;const {store,calls}=closedOwnerRESTStore(closedControlREST(active),{runtimeGuard:async()=>{runtimeChecks++;}});await store.assertClosed();assert.equal(runtimeChecks,1);assert.equal(calls.filter(c=>c.url.includes('/reels_controls/')).length,3);assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/tasks')).length,4);assert.ok(calls.every(c=>!c.options.method||c.options.method==='GET'));assert.ok(calls.every(c=>!c.options.json));}
});
test('owner guard refuses missing/nonempty/malformed occupancy and configured capacity drift',async()=>{
 const cases=[];for(const active of [undefined,null,{nullValue:null},{mapValue:{}},{arrayValue:{values:[{stringValue:'busy'}]}},{arrayValue:{values:{}}},{arrayValue:{values:false}},{arrayValue:[]},{booleanValue:false},{arrayValue:{},mapValue:{}}]){const control=closedControlREST();if(active===undefined)delete control.fields.active;else control.fields.active=active;cases.push(control);}
 for(const name of ['desiredConcurrency','effectiveConcurrency'])for(const value of [undefined,{integerValue:'0'},{integerValue:'2'},{integerValue:1},{booleanValue:true}]){const control=closedControlREST();if(value===undefined)delete control.fields[name];else control.fields[name]=value;cases.push(control);}
 for(const value of [undefined,{booleanValue:false},{booleanValue:1},{integerValue:'1'}]){const control=closedControlREST();if(value===undefined)delete control.fields.paused;else control.fields.paused=value;cases.push(control);}
 for(const control of cases){const {store,calls}=closedOwnerRESTStore(control);await assert.rejects(()=>store.assertClosed(),/Stage is not closed/);assert.ok(calls.every(c=>!c.options.method||c.options.method==='GET'));}
 const {store,calls}=closedOwnerRESTStore(closedControlREST(),{runtimeGuard:async()=>{throw Error('closed release drift');}});await assert.rejects(()=>store.assertClosed(),/release drift/);assert.equal(calls.length,0);
});
