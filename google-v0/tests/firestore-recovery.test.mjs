import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataRecoveryAllowed,failureDigest,recoveryAuthorizationPath,uploadRecoveryId} from '../lib/firestore-recovery.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {WorkerQueue,workerHandler,validateTask} from '../lib/worker-queue.mjs';

function fixture(stage){
 const now=Date.now(),videoId='Reel_1',originalId=executionId(videoId,stage),recoveryId='metadata_recovery_20261014';
 const financial={video_id:videoId,stage,status:stage==='upload'?'completed':'reserved',maximum_cents:stage==='upload'?50:120,batch_id:'pilot_recovery',created_at:'original',...(stage==='upload'?{actual_cents:50,manual_reconciliation:'confirmed_firestore_metadata_rejection_full_estimate_accounted_upload_pending'}:{})};
 const claim={video_id:videoId,stage,status:stage==='upload'?'uncertain':'blocked',failure_diagnostic:{operation_step:stage==='upload'?'persist_download':'adapter_or_reservation',http_status:429,tool_code:null,provider:{status:'RESOURCE_EXHAUSTED',message:'Confirmed metadata write rejection'}},created_at:'original'};
 const video={status:'needs_attention',...(stage==='transcription'?{media_verified:true,audio_status:'present',video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'123'}:{media_verified:false})};
 const authorization={schema_version:1,status:'authorized',kind:'confirmed_firestore_metadata_rejection',verified_service:'firestore.googleapis.com',original_execution_id:originalId,video_id:videoId,stage,maximum_cents:financial.maximum_cents,recovery_id:recoveryId,failure_digest:failureDigest(claim.failure_diagnostic),authorization_ref:'MEG-89:owner:test',authorized_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),evidence:stage==='upload'?'media_absence_verified':'provider_not_submitted'};
 let version=0;const docs=new Map(),seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
 seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true,parallelism:4});
 seed('settings/financial',{...newLedger(),paused:false,allocation_cents:150000,coverage_verified:true,ongoing_commitment_cents:9400,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:170140,balance_observed_at:new Date(now).toISOString(),balance_max_age_seconds:86400,credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true},spent_cents:stage==='upload'?50:0,reserved_cents:stage==='upload'?0:120,jobs:{[originalId]:financial},batch:{schema_version:1,id:'pilot_recovery',status:'active',budget_cents:120000,overhead_cents:2400,parallelism:4,video_ids:[videoId,...Array.from({length:261},(_,i)=>`Reel_${i+2}`)],active_video_ids:stage==='transcription'?[videoId]:[]}});
 seed(`jobs/${originalId}`,claim);seed(`videos/${videoId}`,video);seed(recoveryAuthorizationPath(originalId),authorization);
 const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){if(docs.get(path)?.updateTime!==updateTime)throw Object.assign(Error('CAS conflict'),{status:409});seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
 const ledger=new FinancialLedger(store,{clock:()=>now});let calls=0,checks=0;
 const gate=workerReservationGate(store,{clock:()=>now});
 const operations={async prepareUploadRecovery(){checks++;},async [stage]({executionId:id}){await gate({executionId:id,stage,videoId});calls++;return {video_id:videoId,stage,actual_cents:stage==='upload'?50:120,changes:stage==='upload'?{media_verified:true,audio_status:'present',video_key:`originals/instagram/${videoId}/video.mp4`,video_generation:'456'}:{transcript:'Transcrição preservada',transcript_key:`results/instagram/${videoId}/${id}/transcription.json`,transcript_generation:'456',transcript_status:'recognized'}};}};
 const flow=new WorkerFlow({store,ledger,operations,quotes:{upload:50,transcription:120,analysis:250},batchId:'pilot_recovery',clock:()=>now});
 return {now,videoId,originalId,recoveryId,financial,claim,video,authorization,store,ledger,flow,operations,seed,task:{videoId,stage,recoveryId,recoverFirestoreWrite:true,poll:0},guard:()=>({authorization,claim,financial,video,originalId,videoId,stage,maximumCents:financial.maximum_cents,recoveryId,now}),calls:()=>calls,checks:()=>checks};
}
for(const stage of ['upload','transcription'])test(`${stage}: explicit recovery completes once, preserving original coverage and provider admission`,async()=>{
 const x=fixture(stage),before=await x.store.get(`jobs/${x.originalId}`);
 const results=await Promise.allSettled([x.flow.run(x.task),x.flow.run(x.task)]);
 assert.ok(results.some(r=>r.value?.status==='completed'));assert.equal(x.calls(),1);
 assert.equal((await x.flow.run(x.task)).duplicate,true);assert.equal(x.calls(),1);
 const state=(await x.store.get('settings/financial')).data;
 assert.equal(state.reserved_cents,0);assert.equal(state.spent_cents,stage==='upload'?100:120);
 if(stage==='upload'){
  assert.deepEqual(state.jobs[x.originalId],x.financial);assert.deepEqual(await x.store.get(`jobs/${x.originalId}`),before);
  assert.equal(state.jobs[uploadRecoveryId(x.originalId)].recovery_of,x.originalId);assert.equal(Object.keys(state.jobs).length,2);assert.equal(x.checks(),1);
 }else{assert.equal(Object.keys(state.jobs).length,1);assert.equal(state.jobs[x.originalId].created_at,'original');assert.deepEqual((await x.store.get(`jobs/${x.originalId}`)).data.original_failure_diagnostic,x.claim.failure_diagnostic);}
});
for(const stage of ['upload','transcription'])test(`${stage}: absent or mismatched operator authorization blocks before operations`,async()=>{
 for(const mutate of [a=>a.status='pending',a=>a.verified_service='speech.googleapis.com',a=>a.failure_digest='a'.repeat(64),a=>a.recovery_id='different_recovery_2026',a=>a.video_id='Other_1',a=>a.authorization_ref='',a=>a.expires_at=new Date(0).toISOString(),a=>a.evidence='unknown']){
  const x=fixture(stage);mutate(x.authorization);x.seed(recoveryAuthorizationPath(x.originalId),x.authorization);
  assert.equal((await x.flow.run(x.task)).reason,'firestore_recovery_not_authorized');assert.equal(x.calls(),0);assert.equal(x.checks(),0);
 }
});
for(const stage of ['upload','transcription'])test(`${stage}: unknown inference, artifacts and provider429 are not metadata recovery`,()=>{
 const mutations=[x=>x.claim.failure_diagnostic.operation_step='submit_stt',x=>x.claim.failure_diagnostic.http_status=null,x=>x.claim.failure_diagnostic.provider.status='UNAVAILABLE',x=>x.claim.operation_name='projects/example/operations/1',x=>x.claim.analysis_attempts=[{status:'uncertain'}],x=>x.claim.firestore_recovery_count=1,x=>x.video.analysis={title:'Result'},x=>x.video.transcript_key='existing.json',x=>x.financial.status='started',x=>x.financial.status='uncertain'];
 for(const mutate of mutations){const x=fixture(stage);mutate(x);x.authorization.failure_digest=failureDigest(x.claim.failure_diagnostic);assert.equal(metadataRecoveryAllowed(x.guard()),false);}
});
test('download recovery checks fresh object absence; failure retains one-time claim and never downloads',async()=>{
 const x=fixture('upload');x.operations.prepareUploadRecovery=async()=>{throw Error('Object already exists');};
 assert.equal((await x.flow.run(x.task)).status,'blocked');assert.equal(x.calls(),0);
 assert.equal((await x.flow.run(x.task)).duplicate,true);assert.equal(x.calls(),0);
 const s=(await x.store.get('settings/financial')).data;assert.deepEqual(s.jobs[x.originalId],x.financial);assert.equal(Object.keys(s.jobs).length,1);assert.equal(s.spent_cents,50);
});
test('linked upload cannot bypass ledger duplicate protection or mutate original accounting',async()=>{
 const x=fixture('upload');const id=uploadRecoveryId(x.originalId);
 await assert.rejects(x.ledger.reserve({executionId:id,videoId:x.videoId,stage:'upload',maximumCents:50}));
 await assert.rejects(x.ledger.reserve({executionId:id,videoId:x.videoId,stage:'upload',maximumCents:50,recoveryOf:x.originalId,recoveryId:x.recoveryId}));
 assert.equal(Object.keys((await x.store.get('settings/financial')).data.jobs).length,1);
});
for(const stage of ['upload','transcription'])test(`${stage}: paid timeout preserves coverage and prevents replay`,async()=>{
 const x=fixture(stage);let submitted=0;x.operations[stage]=async()=>{submitted++;throw Error('Unknown provider result');};
 assert.equal((await x.flow.run(x.task)).status,'uncertain');assert.equal(submitted,1);
 assert.equal((await x.flow.run(x.task)).duplicate,true);assert.equal(submitted,1);
 const s=(await x.store.get('settings/financial')).data;assert.equal(s.paused,true);assert.equal(s.reserved_cents,stage==='upload'?50:120);
});
test('asynchronous STT recovery persists operation then polls without another submission',async()=>{
 const x=fixture('transcription');let submits=0;
 x.operations.transcription=async()=>{submits++;return {video_id:x.videoId,stage:'transcription',operation_name:'projects/megabrain-v0-1017370021431/locations/global/operations/123'};};
 x.operations.pollTranscription=async()=>({video_id:x.videoId,stage:'transcription',actual_cents:120,changes:{transcript:'Resultado assíncrono'}});
 assert.equal((await x.flow.run(x.task)).status,'waiting');await x.flow.run(x.task);assert.equal(submits,1);
 assert.equal((await x.flow.poll({videoId:x.videoId})).status,'completed');assert.equal(submits,1);
});
test('metadata recovery respects pause, active batch, freshness and budget controls',async()=>{
 for(const mutate of [s=>s.paused=true,s=>s.batch.status='paused',s=>s.balance_observed_at=new Date(0).toISOString(),s=>s.remaining_credit_cents=1]){
  const x=fixture('transcription');const s=(await x.store.get('settings/financial')).data;mutate(s);x.seed('settings/financial',s);
  assert.equal((await x.flow.run(x.task)).status,'blocked');assert.equal(x.calls(),0);assert.equal((await x.store.get('settings/financial')).data.reserved_cents,120);
 }
});
test('queue recovery identity is distinct, private, one-time and flags never propagate to later stages',async()=>{
 const x=fixture('upload'),sent=[];const api={project:'megabrain-v0-1017370021431',async request(url,options){sent.push(options.json.task);}};
 const q=new WorkerQueue({api,store:x.store,workerOrigin:'https://test-worker.run.app',enabled:true});
 assert.notEqual(q.dispatchPath(x.task),q.dispatchPath({...x.task,recoverFirestoreWrite:undefined}));
 for(const edit of [{stage:'analysis'},{poll:1},{recoveryId:undefined},{recoverUpload:true},{recoverAnalysis429:true}])assert.throws(()=>validateTask({...x.task,...edit}));
 const handler=workerHandler({flow:x.flow,queue:q,authorize:async()=>true});
 const req=()=>new Request('https://test-worker.run.app/tasks/run',{method:'POST',body:JSON.stringify(x.task)});
 assert.equal((await (await handler(req())).json()).dispatch,'queued');await handler(req());assert.equal(x.calls(),1);assert.equal(sent.length,1);
 const next=JSON.parse(Buffer.from(sent[0].httpRequest.body,'base64'));assert.equal(next.stage,'transcription');assert.equal(next.recoveryId,x.recoveryId);assert.equal(next.recoverFirestoreWrite,undefined);
 assert.equal(sent[0].httpRequest.oidcToken.audience,'https://test-worker.run.app');
});


test('recovered upload chains through STT and accepted analysis with linked coverage and released lane',async()=>{
 const x=fixture('upload');const sent=[];
 x.operations.transcription=async({executionId:id})=>({video_id:x.videoId,stage:'transcription',actual_cents:120,changes:{transcript:'Conteúdo do vídeo',transcript_key:`results/instagram/${x.videoId}/${id}/transcription.json`,transcript_generation:'789'}});
 x.operations.analysis=async({executionId:id})=>({video_id:x.videoId,stage:'analysis',actual_cents:250,changes:{analysis:{title:'Resultado curado',keywords:['Tema']},analysis_key:`results/instagram/${x.videoId}/${id}/analysis.json`,analysis_generation:'790',analysis_quality_status:'accepted'}});
 const queue={async enqueue(task){sent.push(task);return {status:'queued'};}};
 const handler=workerHandler({flow:x.flow,queue,authorize:async()=>true});
 const run=async task=>(await (await handler(new Request('https://test-worker.run.app/tasks/run',{method:'POST',body:JSON.stringify(task)}))).json());
 await run(x.task);assert.equal(sent[0].stage,'transcription');await run(sent[0]);assert.equal(sent[1].stage,'analysis');assert.equal((await run(sent[1])).status,'completed');
 const state=(await x.store.get('settings/financial')).data;
 assert.equal(Object.keys(state.jobs).length,4);assert.equal(state.spent_cents,470);assert.equal(state.reserved_cents,0);assert.deepEqual(state.batch.active_video_ids,[]);
 assert.deepEqual(state.jobs[x.originalId],x.financial);assert.equal((await x.store.get('videos/'+x.videoId)).data.status,'analyzed');assert.equal(x.calls(),1);
});
