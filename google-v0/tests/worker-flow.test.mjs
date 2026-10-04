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
