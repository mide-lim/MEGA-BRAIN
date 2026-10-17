// Entirely synthetic fixtures. No private corpus, IDs, usage or costs belong here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMigrationHistory} from '../lib/reels-migration-history.mjs';
import {migrationHash} from '../lib/reels-migration.mjs';
const at='2026-10-11T01:00:00Z';
const document=(path,data,updateTime=at)=>({path,data,updateTime,typedSource:{name:path,fields:{synthetic:{stringValue:'preserved'}}}});
const base=()=>({googleSnapshot:{records:[document('videos/Reel_001',{id:'Reel_001',status:'analyzed'})],controls:[]},legacySnapshot:{videos:[],histories:{}},targetVideos:[{id:'Reel_001',status:'analyzed'}]});
const measured=amount=>({schema_version:1,status:'measured',currency:'USD',billing_confirmed:false,source:'response.usageMetadata',rate_version:'fixture-original-rate',list_price_micro_usd:amount});
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};

test('pure deterministic historical view never admits queued, waiting or applying jobs',()=>{
 const input=base();for(const status of ['queued','reserved','started','waiting','applying','uncertain'])input.googleSnapshot.records.push(document('jobs/Execution_'+status,{video_id:'Reel_001',stage:'transcription',status,created_at:at,operation_name:'https://private.example/operation?token=PRIVATE_TOKEN',error:'PRIVATE_ERROR'}));
 const before=migrationHash(input);freeze(input);const result=projectMigrationHistory(input);
 assert.equal(result.historyView.length,6);assert.ok(result.historyView.every(r=>r.historical===true&&r.executable===false&&r.statusDisplay==='historical'));
 assert.deepEqual(result.historyView.map(r=>r.sourceStatus).sort(),['applying','queued','reserved','started','uncertain','waiting']);
 assert.equal(migrationHash(input),before);assert.deepEqual(projectMigrationHistory(input),result);
 assert.equal(result.proof.sourceUnchanged,true);assert.equal(result.proof.noRunnableDocuments,true);assert.equal(result.proof.newRuntimeAdmissionActivated,false);assert.equal(result.proof.allInputRowsAccounted,true);
 const serialized=JSON.stringify(result);for(const forbidden of ['PRIVATE_TOKEN','PRIVATE_ERROR','https://','operation_name','typedSource','rawResult'])assert.equal(serialized.includes(forbidden),false);
 assert.equal(result.reels_executions,undefined);assert.equal(result.outbox,undefined);
});

test('new registered targets and reset error targets never inherit active operational history; global finance survives',()=>{
 const input=base();input.googleSnapshot.records.push(document('videos/Reel_002',{id:'Reel_002',status:'needs_attention'}));input.targetVideos.push({id:'Reel_002',status:'registered'},{id:'Reel_003',status:'registered'});
 input.googleSnapshot.records.push(document('jobs/ResetJob',{video_id:'Reel_002',stage:'analysis',status:'queued'}));
 input.legacySnapshot.histories.automation_attempts=[{video_id:'Reel_003',started_at:at}];
 input.googleSnapshot.controls.push(document('settings/financial',{jobs:{ResetJob:{video_id:'Reel_002',stage:'analysis',status:'completed',actual_cents:50}}}));
 const result=projectMigrationHistory(input);assert.equal(result.historyView.length,0);
 assert.ok(result.unlinkedHistory.some(r=>r.reason==='RESET_COPY_HISTORY_DETACHED'));assert.ok(result.unlinkedHistory.some(r=>r.reason==='NEW_REGISTERED_COPY_HISTORY_DETACHED'));
 const cost=result.financeView.entries.find(r=>r.kind==='accounting');assert.equal(cost.amount,0.5);assert.equal(cost.operationallyLinked,false);assert.equal(cost.historyLinked,false);
});

test('ledger master, control fragment and matching job cannot duplicate accounting or reserves',()=>{
 const input=base(),job={video_id:'Reel_001',stage:'analysis',status:'uncertain',maximum_cents:200,actual_cents:100,created_at:at};
 input.googleSnapshot.records.push(document('jobs/Execution_001',job));input.googleSnapshot.controls.push(document('settings/financial',{spent_cents:100,reserved_cents:200,jobs:{Execution_001:job}}),document('control_chunks/financial_part',{owner:'settings/financial',entries:{Execution_001:job}}));
 const result=projectMigrationHistory(input),entries=result.financeView.entries;
 assert.equal(entries.filter(r=>r.kind==='accounting').length,1);assert.equal(entries.find(r=>r.kind==='accounting').amount,1);assert.equal(entries.filter(r=>r.kind==='reservation').length,1);assert.equal(entries.find(r=>r.kind==='reservation').amount,2);
 assert.equal(entries.some(r=>r.kind==='provider_usage'),false);assert.ok(entries.every(r=>r.billed===null));assert.equal(result.coverage.duplicateLedgerEntries,1);
});

test('unknown money stays null while explicit zero is retained; unproven ledger dates never become a spending day',()=>{
 const input=base();input.googleSnapshot.controls.push(document('settings/financial',{jobs:{UnknownCost:{video_id:'Reel_001',stage:'analysis',status:'completed',maximum_cents:100,created_at:at,updated_at:at},ExplicitZero:{video_id:'Reel_001',stage:'upload',status:'completed',actual_cents:0,created_at:at}}}));
 const entries=projectMigrationHistory(input).financeView.entries;assert.equal(entries.filter(r=>r.kind==='accounting').length,2);
 const amounts=entries.map(r=>r.amount);assert.ok(amounts.includes(null));assert.ok(amounts.includes(0));assert.ok(entries.every(r=>r.recordedAt===null&&r.day===null&&r.billed===null));
});

test('a legacy job without its ledger preserves explicit accounting without promoting it to measured usage',()=>{
 const input=base();input.googleSnapshot.records.push(document('jobs/Execution_001',{video_id:'Reel_001',stage:'upload',status:'completed',actual_cents:125,completed_at:at}));
 const result=projectMigrationHistory(input);assert.equal(result.financeView.entries.length,1);assert.equal(result.financeView.entries[0].kind,'accounting');assert.equal(result.financeView.entries[0].amount,1.25);assert.equal(result.financeView.entries[0].currency,'BRL');assert.equal(result.financeView.entries[0].billed,null);
});

test('saved provider usage is counted once across execution and verified artifact at its original rate and BRT day',()=>{
 const input=base(),usage=measured(15000),job=document('reels_executions/Execution_001',{reelId:'Reel_001',stage:'analysis',status:'completed',resultSavedAt:at,completedAt:at,rawResult:{finance:{measurement:usage,estimate:{amount:0.25,currency:'BRL'}}}});
 input.googleSnapshot.records.push(job,structuredClone(job));input.artifactProofs=[{executionId:'Execution_001',reelId:'Reel_001',stage:'analysis',key:'saved/synthetic-analysis.json',generation:'2',sha256:'a'.repeat(64),sourceVerified:true,recordedAt:at,usage_cost:usage}];
 const result=projectMigrationHistory(input),entries=result.financeView.entries,measuredRows=entries.filter(r=>r.kind==='provider_usage');
 assert.equal(measuredRows.length,1);assert.equal(measuredRows[0].amount,0.015);assert.equal(measuredRows[0].currency,'USD');assert.equal(measuredRows[0].day,'2026-10-10');assert.equal(measuredRows[0].rateVersion,'fixture-original-rate');assert.equal(measuredRows[0].billingConfirmed,false);
 assert.equal(entries.filter(r=>r.kind==='estimate').length,1);assert.equal(entries.find(r=>r.kind==='estimate').currency,'BRL');assert.equal(result.coverage.duplicateSourceVersions,1);
});

test('missing inline usage can be supplied by the same verified saved execution artifact without a duplicate unknown charge',()=>{
 const input=base();input.googleSnapshot.records.push(document('jobs/Execution_001',{video_id:'Reel_001',stage:'transcription',status:'completed'}));
 input.artifactProofs=[{executionId:'Execution_001',reelId:'Reel_001',stage:'transcription',key:'saved/synthetic-transcript.json',generation:'3',sha256:'b'.repeat(64),sourceVerified:true,recordedAt:at,usage_cost:measured(0)}];
 const result=projectMigrationHistory(input);assert.equal(result.financeView.entries.length,1);assert.equal(result.financeView.entries[0].kind,'provider_usage');assert.equal(result.financeView.entries[0].amount,0);
});

test('conflicting ledger snapshots remain an unknown accounting conflict and do not choose a convenient version',()=>{
 const input=base(),job={video_id:'Reel_001',stage:'analysis',status:'completed',actual_cents:100};
 input.googleSnapshot.controls.push(document('settings/financial',{jobs:{Execution_001:job}}),document('control_chunks/financial_part',{owner:'settings/financial',entries:{Execution_001:{...job,actual_cents:200}}}));
 const result=projectMigrationHistory(input);assert.equal(result.coverage.conflicts,1);assert.equal(result.financeView.entries.length,1);assert.equal(result.financeView.entries[0].amount,null);assert.equal(result.financeView.entries[0].reason,'CONFLICTING_LEDGER_VERSIONS');
});

test('conflicting usage never sums both values, and two distinct execution attempts remain distinct',()=>{
 const input=base();for(const n of [1,2])input.googleSnapshot.records.push(document('jobs/Execution_00'+n,{video_id:'Reel_001',stage:'analysis',status:'completed',resultSavedAt:at,rawResult:{finance:{measurement:measured(n*1000)}}}));
 assert.equal(projectMigrationHistory(input).financeView.entries.filter(r=>r.kind==='provider_usage').length,2);
 input.artifactProofs=[{executionId:'Execution_001',reelId:'Reel_001',stage:'analysis',key:'saved/conflicting.json',generation:'4',sha256:'c'.repeat(64),sourceVerified:true,usage_cost:measured(5000)}];
 const result=projectMigrationHistory(input);assert.equal(result.coverage.conflicts,1);assert.equal(result.financeView.entries.filter(r=>r.kind==='provider_usage').length,1);assert.ok(result.financeView.entries.some(r=>r.reason==='CONFLICTING_PROVIDER_MEASUREMENTS'&&r.amount===null));
});

test('legacy attempts do not invent a stage or completion; batch jobs do not invent membership; STT reservations remain seconds',()=>{
 const input=base();input.legacySnapshot.histories={automation_attempts:[{video_id:'Reel_001',started_at:at}],analysis_jobs:[{id:1,status:'completed',selected_count:100,created_at:at,finished_at:at}],stt_reservations:[{key:'synthetic-reservation',seconds:30,created_at:at}],model_budget:[{used:100,remaining:500}]};
 const result=projectMigrationHistory(input);assert.equal(result.historyView.length,1);assert.equal(result.historyView[0].stage,null);assert.equal(result.historyView[0].completedAt,null);
 const batch=result.unlinkedHistory.find(r=>r.kind==='batch_analysis_job');assert.equal(batch.reelId,null);assert.equal(batch.reason,'EXPLICIT_REEL_ID_UNAVAILABLE');
 const reserve=result.financeView.entries.find(r=>r.kind==='reservation');assert.equal(reserve.reservedSeconds,30);assert.equal(reserve.amount,null);assert.equal(reserve.currency,null);
 assert.equal(result.proof.allInputRowsAccounted,true);assert.equal(result.coverage.inputLegacyHistoryRows,4);
});

test('invalid saved usage and missing artifact proof remain unknown; coverage input and private labels are hashed',()=>{
 const input=base();input.googleSnapshot.records.push(document('analyses/Review_001',{video_id:'Reel_001',stage:'constructor',status:'PRIVATE_STATE',review_status:'PRIVATE_STATUS',error:{message:'PRIVATE_MESSAGE'}}));
 input.legacySnapshot.histories['https://private.example/SECRET_TABLE']=[{error:'PRIVATE_ERROR'}];input.coverage={private:'PRIVATE_COVERAGE'};
 input.artifactProofs=[{executionId:'Execution_001',reelId:'Reel_001',stage:'analysis',key:'https://private.example/SECRET_OBJECT',generation:'4',usage_cost:measured(1000)}];
 const result=projectMigrationHistory(input);assert.equal(result.historyView[0].sourceStatus,'unknown');assert.equal(result.historyView[0].stage,null);assert.equal(result.financeView.entries[0].amount,null);assert.equal(result.coverage.sourceCoverageHash,migrationHash(input.coverage));
 const text=JSON.stringify(result);for(const secret of ['PRIVATE_STATE','PRIVATE_STATUS','PRIVATE_MESSAGE','PRIVATE_ERROR','PRIVATE_COVERAGE','SECRET_TABLE','SECRET_OBJECT','https://'])assert.equal(text.includes(secret),false);
});

test('malformed and repeated target identities are rejected before a view is declared valid',()=>{
 assert.throws(()=>projectMigrationHistory(),/Snapshots/);const input=base();input.targetVideos.push({...input.targetVideos[0]});assert.throws(()=>projectMigrationHistory(input),/Identidade/);
});
