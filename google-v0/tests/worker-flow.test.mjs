import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';

function fixture(operations){
  let version=0;const now=Date.now();
  const docs=new Map();
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true});
  seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
  seed('videos/Reel_1',{media_verified:true,audio_status:'present',transcript:'Texto original'});
  const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){if(docs.get(path)?.updateTime!==updateTime)throw new Error('Conflict');seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
  return {store,docs,flow:new WorkerFlow({store,ledger:new FinancialLedger(store,{clock:()=>now}),operations,quotes:{upload:10,transcription:10,analysis:10},clock:()=>now})};
}
test('concurrent queue deliveries execute once and preserve result before settling',async()=>{
  let calls=0;const {flow,store}=fixture({analysis:async()=>{calls++;return {video_id:'Reel_1',stage:'analysis',actual_cents:4,changes:{analysis:{title:'Tema'}}};}});
  const results=await Promise.all([flow.run({videoId:'Reel_1',stage:'analysis'}),flow.run({videoId:'Reel_1',stage:'analysis'})]);
  assert.equal(calls,1);assert.ok(results.some(r=>r.status==='completed'));assert.equal((await store.get('videos/Reel_1')).data.analysis.title,'Tema');
  assert.equal((await store.get('settings/financial')).data.spent_cents,4);
});
test('timeout preserves reservation and duplicate delivery never resubmits',async()=>{
  let calls=0;const {flow,store}=fixture({analysis:async()=>{calls++;throw new Error('timeout');}});
  assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'uncertain');
  await flow.run({videoId:'Reel_1',stage:'analysis'});assert.equal(calls,1);
  const ledger=(await store.get('settings/financial')).data;assert.equal(ledger.paused,true);assert.equal(ledger.reserved_cents,10);
});
test('asynchronous transcription persists operation and polls without another submission',async()=>{
  let submits=0,polls=0;const {flow,store}=fixture({transcription:async()=>{submits++;return {video_id:'Reel_1',stage:'transcription',operation_name:'projects/megabrain-v0-1017370021431/locations/global/operations/123'};},pollTranscription:async()=>{polls++;return polls===1?{video_id:'Reel_1',stage:'transcription',pending:true}:{video_id:'Reel_1',stage:'transcription',actual_cents:5,changes:{transcript:'Transcrição persistida'}};}});
  assert.equal((await flow.run({videoId:'Reel_1',stage:'transcription'})).status,'waiting');
  await flow.run({videoId:'Reel_1',stage:'transcription'});
  assert.equal((await flow.poll({videoId:'Reel_1'})).status,'waiting');
  assert.equal((await flow.poll({videoId:'Reel_1'})).status,'completed');assert.equal(submits,1);
  assert.equal((await store.get('videos/Reel_1')).data.transcript,'Transcrição persistida');
});
test('paused controls and missing audio block before operations or reservations',async()=>{
  let calls=0;const {flow,store}=fixture({transcription:async()=>{calls++;}});
  let row=await store.get('settings/automation');await store.patch('settings/automation',{enabled:false},{updateTime:row.updateTime});
  assert.equal((await flow.run({videoId:'Reel_1',stage:'transcription'})).status,'paused');
  row=await store.get('settings/automation');await store.patch('settings/automation',{enabled:true},{updateTime:row.updateTime});
  row=await store.get('videos/Reel_1');await store.patch('videos/Reel_1',{audio_status:'missing'},{updateTime:row.updateTime});
  assert.equal((await flow.run({videoId:'Reel_1',stage:'transcription'})).reason,'audio_not_verified');assert.equal(calls,0);
  assert.equal((await store.get('settings/financial')).data.reserved_cents,0);
});

test('empty recognition requires a persisted own transcription artifact before video analysis',async()=>{
 let calls=0;const {flow,store}=fixture({analysis:async()=>{calls++;return {video_id:'Reel_1',stage:'analysis',actual_cents:4,changes:{analysis:{title:'Tema visual'}}};}});
 let row=await store.get('videos/Reel_1');await store.patch('videos/Reel_1',{transcript:'',transcript_status:'no_speech_recognized'},{updateTime:row.updateTime});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).reason,'transcript_missing');assert.equal(calls,0);
 row=await store.get('videos/Reel_1');await store.patch('videos/Reel_1',{transcript_key:`results/instagram/Reel_1/${executionId('Reel_1','transcription')}/transcription.json`,transcript_generation:'123'},{updateTime:row.updateTime});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'completed');assert.equal(calls,1);
});

test('versioned reanalysis archives the previous report and executes only once',async()=>{
 let calls=0;const operations={analysis:async()=>{calls++;return {video_id:'Reel_1',stage:'analysis',actual_cents:4,changes:{analysis:{title:'Nova análise'}}};}};
 const {store}=fixture(operations);const row=await store.get('videos/Reel_1');await store.patch('videos/Reel_1',{analysis:{title:'Original'},analysis_key:'results/original.json',analysis_generation:'12'},{updateTime:row.updateTime});
 const flow=new WorkerFlow({store,ledger:new FinancialLedger(store),operations,quotes:{analysis:10},analysisRevision:'megabrain-video-text-v3'});
 const result=await flow.run({videoId:'Reel_1',stage:'analysis'});assert.equal(result.status,'completed');
 assert.equal((await store.get('analyses/'+result.execution_id+'_previous')).data.analysis.title,'Original');
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).duplicate,true);assert.equal(calls,1);
 assert.notEqual(result.execution_id,executionId('Reel_1','analysis'));
});

test('capacity failure blocks before a financial reservation or paid inference',async()=>{
 let calls=0;const {flow,store}=fixture({prepareAnalysis:async()=>{throw Error('Capacity unavailable');},analysis:async()=>{calls++;}});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'blocked');
 assert.equal(calls,0);assert.equal((await store.get('settings/financial')).data.reserved_cents,0);
});

test('explicit recovery of a pre-inference block cannot replay a financial attempt',async()=>{
 let blocked=true,calls=0;const {flow,store}=fixture({prepareAnalysis:async()=>{if(blocked)throw Error('No capacity');},analysis:async()=>{calls++;return {video_id:'Reel_1',stage:'analysis',actual_cents:4,changes:{analysis:{title:'Recovered'}}};}});
 const first=await flow.run({videoId:'Reel_1',stage:'analysis'});assert.equal(first.status,'blocked');blocked=false;
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).duplicate,true);assert.equal(calls,0);
 let j=await store.get('jobs/'+first.execution_id);await store.patch('jobs/'+first.execution_id,{status:'retry_ready'},{updateTime:j.updateTime});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'completed');assert.equal(calls,1);
 j=await store.get('jobs/'+first.execution_id);await store.patch('jobs/'+first.execution_id,{status:'retry_ready'},{updateTime:j.updateTime});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).reason,'previous_financial_attempt');assert.equal(calls,1);
});

test('review outcome preserves publication, settles once and permits the next video',async()=>{
 let calls=0;
 const {flow,store}=fixture({analysis:async({video,executionId:id})=>{calls++;return {video_id:video.id,stage:'analysis',actual_cents:10,changes:{analysis:video.analysis??null,analysis_key:video.analysis_key??null,analysis_generation:video.analysis_generation??null,analysis_quality_status:'review_required',analysis_review_reasons:['invalid_categories'],analysis_candidate:null,candidate_analysis_key:`results/instagram/${video.id}/${id}/analysis.json`,candidate_analysis_generation:'123'}};}});
 const row=await store.get('videos/Reel_1');const previous={title:'Existing',categories:['receitas']};
 await store.patch('videos/Reel_1',{analysis:previous,analysis_key:'old.json',analysis_generation:'10'},{updateTime:row.updateTime});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'completed');
 const saved=(await store.get('videos/Reel_1')).data;
 assert.deepEqual(saved.analysis,previous);assert.equal(saved.status,'needs_attention');
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).duplicate,true);
 await store.create('videos/Reel_2',{media_verified:true,audio_status:'present',transcript:'Texto'});
 assert.equal((await flow.run({videoId:'Reel_2',stage:'analysis'})).status,'completed');
 assert.equal(calls,2);const ledger=(await store.get('settings/financial')).data;
 assert.equal(ledger.paused,false);assert.equal(ledger.reserved_cents,0);assert.equal(ledger.spent_cents,20);
});
for(const fault of ['missing-artifact','wrong-owner','overwrite','persist-failure'])test(`invalid review settlement remains uncertain: ${fault}`,async()=>{
 const {flow,store}=fixture({analysis:async({video,executionId:id})=>({video_id:video.id,stage:'analysis',actual_cents:10,changes:{analysis:fault==='overwrite'?{title:'Unvalidated'}:null,analysis_quality_status:'review_required',candidate_analysis_key:fault==='wrong-owner'?`results/instagram/Other/${id}/analysis.json`:`results/instagram/${video.id}/${id}/analysis.json`,candidate_analysis_generation:fault==='missing-artifact'?null:'123'}})});
 if(fault==='persist-failure'){const patch=store.patch.bind(store);store.patch=async(path,changes,options)=>{if(path==='videos/Reel_1'&&changes.analysis_quality_status)throw Error('write unavailable');return patch(path,changes,options);};}
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'uncertain');
 const financial=(await store.get('settings/financial')).data;assert.equal(financial.paused,true);assert.equal(financial.reserved_cents,10);assert.equal(financial.spent_cents,0);
 assert.equal((await store.get('videos/Reel_1')).data.analysis,undefined);
});

test('download diagnostic is sanitized and failure cannot trigger paid stages or retry',async()=>{
 let downloads=0,paid=0;
 const {flow,store}=fixture({upload:async()=>{downloads++;throw Object.assign(Error('private raw message'),{code:1,operation_step:'download_media',download_diagnostic:{phase:'transfer',phase_source:'tool_output',cause:'http_403',message:'Bearer SECRET',stderr:'SECRET',elapsed_ms:4000,exit_code:1,yt_dlp_version:'2026.03.17',ffmpeg_version:'5.1.9'}});},transcription:async()=>{paid++;},analysis:async()=>{paid++;}});
 const failed=await flow.run({videoId:'Reel_1',stage:'upload'});assert.equal(failed.status,'uncertain');
 const j=(await store.get('jobs/'+failed.execution_id)).data;assert.equal(j.failure_diagnostic.operation_step,'download_media');assert.equal(j.failure_diagnostic.download.cause,'http_403');assert.doesNotMatch(JSON.stringify(j),/SECRET|private raw/);
 const f=(await store.get('settings/financial')).data;assert.equal(f.paused,true);assert.equal(f.reserved_cents,10);
 await flow.run({videoId:'Reel_1',stage:'upload'});assert.equal(downloads,1);assert.equal(paid,0);
});

test('explicit429 recovery keeps reservation and saved stages, concurrent delivery runs once',async()=>{
 let calls=0;const operations={analysis:async({video,analysisAttempts,recordAnalysisAttempts})=>{
  calls++;if(calls===1)throw Object.assign(Error('quota'),{status:429,operation_step:'submit_analysis'});
  assert.deepEqual(analysisAttempts.map(a=>a.status),['http_429']);
  await recordAnalysisAttempts([...analysisAttempts,{number:2,status:'response_received'}]);
  return {video_id:video.id,stage:'analysis',actual_cents:4,changes:{analysis:{title:'Recuperado'}}};
 }};
 const {flow,store}=fixture(operations);
 await store.create('jobs/saved_upload',{status:'completed'});await store.create('jobs/saved_stt',{status:'completed'});
 const first=await flow.run({videoId:'Reel_1',stage:'analysis'});assert.equal(first.status,'uncertain');
 let financial=await store.get('settings/financial');await store.patch('settings/financial',{paused:false},{updateTime:financial.updateTime});
 const results=await Promise.allSettled([flow.run({videoId:'Reel_1',stage:'analysis',recoverAnalysis429:true}),flow.run({videoId:'Reel_1',stage:'analysis',recoverAnalysis429:true})]);
 assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.status==='completed'));assert.equal(calls,2);
 financial=(await store.get('settings/financial')).data;assert.equal(financial.reserved_cents,0);assert.equal(financial.spent_cents,4);assert.equal(Object.keys(financial.jobs).length,1);assert.equal(financial.jobs[first.execution_id].recovery_429_count,1);
 assert.deepEqual((await store.get('jobs/saved_upload')).data,{status:'completed'});assert.deepEqual((await store.get('jobs/saved_stt')).data,{status:'completed'});
 assert.equal((await store.get('videos/Reel_1')).data.transcript,'Texto original');
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis',recoverAnalysis429:true})).reason,'analysis_not_recoverable_429');
});
test('explicit recovery rejects timeout, three429s and mismatched financial reservation',async()=>{
 for(const variant of ['timeout','exhausted','wrong_video']){
  let calls=0;const {flow,store}=fixture({analysis:async()=>{calls++;throw Object.assign(Error('failure'),{status:variant==='timeout'?503:429,operation_step:'submit_analysis'});}});
  const first=await flow.run({videoId:'Reel_1',stage:'analysis'});
  let f=await store.get('settings/financial');await store.patch('settings/financial',{paused:false,...(variant==='wrong_video'?{jobs:{...f.data.jobs,[first.execution_id]:{...f.data.jobs[first.execution_id],video_id:'Other'}}}:{})},{updateTime:f.updateTime});
  if(variant==='exhausted'){const j=await store.get('jobs/'+first.execution_id);await store.patch('jobs/'+first.execution_id,{analysis_attempts:[1,2,3].map(number=>({number,status:'http_429'}))},{updateTime:j.updateTime});}
  assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis',recoverAnalysis429:true})).status,'blocked');assert.equal(calls,1);
 }
});

test('automation pause during analysis retry blocks a further submission',async()=>{
 let calls=0;const {flow,store}=fixture({analysis:async({recordAnalysisAttempts})=>{
  await recordAnalysisAttempts([{number:1,status:'started'}]);calls++;
  await recordAnalysisAttempts([{number:1,status:'http_429'}]);
  const control=await store.get('settings/automation');await store.patch('settings/automation',{analysis_enabled:false},{updateTime:control.updateTime});
  await recordAnalysisAttempts([{number:1,status:'http_429'},{number:2,status:'started'}]);calls++;
 }});
 assert.equal((await flow.run({videoId:'Reel_1',stage:'analysis'})).status,'uncertain');assert.equal(calls,1);
});

const metadataFailure=()=>Object.assign(Error('terminal metadata failure'),{code:1,operation_step:'download_media',download_diagnostic:{phase:'metadata',phase_source:'tool_output',cause:'unknown',exit_code:1}});
async function uploadRecoveryFixture({prepare=async()=>{},failAgain=false}={}){
 let calls=0;const f=fixture({prepareUploadRecovery:prepare,upload:async()=>{if(++calls===1||failAgain)throw metadataFailure();return {video_id:'Reel_1',stage:'upload',actual_cents:4,changes:{video_key:'originals/instagram/Reel_1/video.mp4',video_generation:'123',video_bytes:3,media_verified:true,audio_status:'present',duration_seconds:2}};}});
 let v=await f.store.get('videos/Reel_1');await f.store.patch('videos/Reel_1',{media_verified:false,video_key:null},{updateTime:v.updateTime});
 const first=await f.flow.run({videoId:'Reel_1',stage:'upload'});
 await f.store.create('jobs/probe_'+first.execution_id,{status:'metadata_available',video_id:'Reel_1',original_job_id:first.execution_id});
 const financial=await f.store.get('settings/financial');await f.store.patch('settings/financial',{paused:false},{updateTime:financial.updateTime});
 return {...f,id:first.execution_id,calls:()=>calls};
}
test('explicit upload recovery executes once concurrently and retains original failure/reservation identity',async()=>{
 const f=await uploadRecoveryFixture();const before=(await f.store.get('jobs/'+f.id)).data.failure_diagnostic;
 const results=await Promise.allSettled([f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true}),f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})]);
 assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.status==='completed'));assert.equal(f.calls(),2);
 const financial=(await f.store.get('settings/financial')).data;assert.equal(Object.keys(financial.jobs).length,1);assert.equal(financial.jobs[f.id].upload_recovery_count,1);assert.equal(financial.spent_cents,4);assert.equal(financial.reserved_cents,0);
 assert.deepEqual((await f.store.get('jobs/'+f.id)).data.original_failure_diagnostic,before);assert.equal((await f.store.get('videos/Reel_1')).data.transcript,'Texto original');
 assert.equal((await f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})).reason,'upload_not_recoverable');
});
test('second upload failure consumes only recovery allowance and retains open reserve without automatic replay',async()=>{
 const f=await uploadRecoveryFixture({failAgain:true});assert.equal((await f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})).status,'uncertain');
 let financial=await f.store.get('settings/financial');assert.equal(financial.data.reserved_cents,10);await f.store.patch('settings/financial',{paused:false},{updateTime:financial.updateTime});
 assert.equal((await f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})).reason,'upload_not_recoverable');assert.equal(f.calls(),2);
});
test('probe mismatch, upload artifact, quota and non-metadata failure block recovery',async()=>{
 for(const scenario of ['probe','stored','quota','timeout','persist','transfer']){
  const f=await uploadRecoveryFixture();
  if(scenario==='probe'){const p=await f.store.get('jobs/probe_'+f.id);await f.store.patch('jobs/probe_'+f.id,{original_job_id:'Other'},{updateTime:p.updateTime});}
  else if(scenario==='stored'){const v=await f.store.get('videos/Reel_1');await f.store.patch('videos/Reel_1',{video_key:'already.mp4'},{updateTime:v.updateTime});}
  else{const j=await f.store.get('jobs/'+f.id),diagnostic=structuredClone(j.data.failure_diagnostic);if(scenario==='quota')diagnostic.download.cause='http_429';if(scenario==='timeout')diagnostic.tool_code='ETIMEDOUT';if(scenario==='persist')diagnostic.operation_step='persist_download';if(scenario==='transfer')diagnostic.download.phase='transfer';await f.store.patch('jobs/'+f.id,{failure_diagnostic:diagnostic},{updateTime:j.updateTime});}
  assert.equal((await f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})).reason,'upload_not_recoverable');assert.equal(f.calls(),1);
 }
});
test('storage absence check failure prevents resumed reservation and network download',async()=>{
 const f=await uploadRecoveryFixture({prepare:async()=>{throw Error('Existing immutable object');}});assert.equal((await f.flow.run({videoId:'Reel_1',stage:'upload',recoverUpload:true})).status,'blocked');assert.equal(f.calls(),1);assert.equal((await f.store.get('settings/financial')).data.jobs[f.id].status,'uncertain');
});
