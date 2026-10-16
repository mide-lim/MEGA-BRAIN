import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAssistedScope,assertAssistedScope} from '../lib/assisted-scope.mjs';
import {runAssistedUpload} from '../lib/assisted-upload.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger,reservationDecision} from '../lib/financial-ledger.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {StorageCapacity} from '../lib/storage-capacity.mjs';
import {Storage} from '../lib/storage.mjs';
import {AcquisitionControl} from '../lib/acquisition-control.mjs';
import {ExecutionStops} from '../lib/execution-stops.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({download=async(_video,{onExecutionStopped})=>onExecutionStopped(),clock=()=>Date.now()}={}){
 const now=clock(),docs=new Map(),scoped=[],objects=[];let version=0,calls=0;
 const seed=(p,data)=>docs.set(p,{data:structuredClone(data),updateTime:String(++version)});
 const store={async get(p){return structuredClone(docs.get(p)??null);},async create(p,data){if(docs.has(p))return {created:false};seed(p,data);return {created:true};},async patch(p,c,{updateTime}){if(docs.get(p)?.updateTime!==updateTime)throw Object.assign(Error('CAS'),{status:412});seed(p,{...docs.get(p).data,...c});return this.get(p);}};
 const batch={schema_version:1,id:'pilot_30_oct12',status:'active',budget_cents:120000,overhead_cents:2400,video_ids:Array.from({length:262},(_,i)=>`Legacy_${i}`),parallelism:4,active_video_ids:[]};
 const jobs={legacy_media:{video_id:'pilot_delivery',stage:'media_access',maximum_cents:1100,status:'started'},...Object.fromEntries([0,1,2].map(i=>['legacy_analysis_'+i,{video_id:'Retained_'+i,stage:'analysis',maximum_cents:250,status:'uncertain'}]))};
 seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,remaining_credit_cents:150000,balance_observed_at:new Date(now).toISOString(),ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),ongoing_storage_planned_bytes:10000000,credit_expires_at:new Date(now+30*86400000).toISOString(),reserved_cents:1850,jobs,batch,enabled_stages:{upload:true,analysis:false,transcription:false,media_access:false}});
 seed('settings/automation',{enabled:true,parallelism:1,analysis_enabled:false,transcription_enabled:false});
 seed('settings/acquisition',{schema_version:1,enabled:true,parallelism:1,active:{}});
 seed('settings/capacity',{schema_version:1,enabled:true,limit_bytes:10000000,admitted_bytes:0,claims:{},claim_limit:2400});
 const stops=new ExecutionStops({store,clock}),acquisition=new AcquisitionControl({store,maximumParallelism:1,clock,verifyExecutionStopped:x=>stops.verify(x)});
 const original=structuredClone(docs.get('settings/financial').data);
 const createScopedFlow=scope=>{
  const capacity=new StorageCapacity(store,{assistedScope:scope}),ledger=new FinancialLedger(store,{assistedScope:scope,clock}),gate=workerReservationGate(store,{assistedScope:scope,clock});
  const bytes=Buffer.from('synthetic media'),bucket='megabrain-v0-1017370021431-media';
  const api={buckets:new Set([bucket]),async request(url){assert.ok(url.includes('ifGenerationMatch=0'));objects.push(scope.videoId);return {generation:'1'};}};
  const storage=new Storage(api,bucket,{admitObject:x=>capacity.admit(x)});storage.metadata=async()=>null;storage.read=async()=>bytes;
  const operations={async prepareUploadRecovery(){},async upload({video,executionId,recordAcquisitionExtraction}){await gate({videoId:video.id,executionId,stage:'upload'});calls++;const ended=recordAcquisitionExtraction();await download(video,{onExecutionStopped:ended});const key=`originals/instagram/${video.id}/video.mp4`;const object=await storage.writeImmutable(key,bytes,{uploadsEnabled:true});return {video_id:video.id,stage:'upload',actual_cents:10,changes:{media_verified:true,audio_status:'present',video_key:key,video_generation:object.generation,video_bytes:bytes.length}};}};
  const flow=new WorkerFlow({store,ledger,operations,acquisition,assistedScope:scope,quotes:{upload:10},eligibleVideos:[scope.videoId],batchId:batch.id,clock,recordExecutionStopped:x=>stops.record(x),verifyExecutionStopped:x=>stops.verify(x)});scoped.push({scope,flow,capacity,ledger,gate});return flow;
 };
 const approve=(id='Fresh_Reel',request='unit_request_20261015')=>{seed(`videos/${id}`,{status:'pending'});const path='jobs/assisted_upload_'+request;seed(path,{schema_version:1,kind:'assisted_upload',status:'authorized',request_id:request,authorization_ref:'MEG-109:synthetic-authorization',authorized_at:new Date(clock()-1000).toISOString(),expires_at:new Date(clock()+60000).toISOString(),maximum_cents:10,task:{videoId:id,stage:'upload',poll:0}});return {store,requestId:request,flow:{quotes:{upload:10}},allowedVideoIds:[id],createScopedFlow,clock};};
 const options=approve();
 return {store,seed,docs,original,options,approve,scoped,objects,now,stats:()=>({calls}),run:()=>runAssistedUpload(options)};
}
test('one fresh upload outside262 uses real flow/ledger/capacity/immutable Storage and closure; old batch/reserves unchanged',async()=>{
 const f=fixture();assert.equal((await f.run()).status,'completed');const state=(await f.store.get('settings/financial')).data;
 assert.deepEqual(state.batch,f.original.batch);assert.equal(state.reserved_cents,1850);assert.equal(state.spent_cents,10);
 for(const [id,j] of Object.entries(f.original.jobs))assert.deepEqual(state.jobs[id],j);
 const id=executionId('Fresh_Reel','upload'),entry=state.jobs[id];assert.equal(entry.batch_id,undefined);assert.equal(entry.assisted_scope_ref,'jobs/assisted_upload_unit_request_20261015');assert.equal(entry.status,'completed');
 assert.equal(f.objects.length,1);assert.equal((await f.store.get('videos/Fresh_Reel')).data.media_verified,true);
 assert.equal([...f.docs.keys()].filter(p=>p.startsWith('execution_stops/')).length,1);assert.deepEqual((await f.store.get('settings/acquisition')).data.active,{});
 assert.equal((await f.run()).reason,'assisted_already_requested');assert.equal(f.stats().calls,1);
});
test('normal batch admission still rejects fresh outside ID; a cloned/forged capability cannot bypass it',async()=>{
 const f=fixture();assert.equal(reservationDecision(f.original,{maximumCents:10,stage:'upload',videoId:'Fresh_Reel'}).ready,false);
 await f.run();const {scope}=f.scoped[0];assert.throws(()=>assertAssistedScope({...scope}));
 assert.throws(()=>reservationDecision(f.original,{maximumCents:10,stage:'upload',videoId:'Fresh_Reel',assistedScope:{...scope}}));
});
for(const change of [a=>({...a,maximum_cents:101}),a=>({...a,maximum_cents:11}),a=>({...a,expires_at:new Date(0).toISOString()}),a=>({...a,task:{...a.task,recoverUpload:true,recoveryId:'another_recovery_id'}}),a=>({...a,task:{...a.task,stage:'analysis'}})])test('invalid unit authorization cannot reserve, create a scope or call an adapter',async()=>{
 const f=fixture(),p='jobs/assisted_upload_'+f.options.requestId;f.seed(p,change(f.docs.get(p).data));assert.equal((await f.run()).status,'blocked');assert.equal(f.scoped.length,0);assert.deepEqual((await f.store.get('settings/financial')).data,f.original);
});
test('scope is minted only after confirmed consumed receipt and rejects a stale receipt',async()=>{
 const f=fixture(),p='jobs/assisted_upload_'+f.options.requestId,r=await f.store.get(p);await assert.rejects(createAssistedScope({store:f.store,path:p,receipt:r}));
 const c=await f.store.patch(p,{status:'consumed',consumed_at:new Date().toISOString()},{updateTime:r.updateTime});await assert.rejects(createAssistedScope({store:f.store,path:p,receipt:{...c,updateTime:'stale'}}));
});
for(const change of [{balance_observed_at:null},{ongoing_costs_observed_at:null},{remaining_credit_cents:0},{paused:true}])test('unit scope retains global financial gate '+Object.keys(change)[0],async()=>{
 const f=fixture();f.seed('settings/financial',{...f.original,...change});assert.equal((await f.run()).status,'blocked');assert.equal(f.stats().calls,0);assert.equal((await f.store.get('settings/financial')).data.reserved_cents,1850);
});
test('existing claim or any financial history cannot be disguised as a fresh acquisition',async()=>{
 for(const claim of [true,false]){const f=fixture(),id=executionId('Fresh_Reel','upload');if(claim)f.seed('jobs/'+id,{video_id:'Fresh_Reel',stage:'upload',status:'retry_ready'});else f.seed('settings/financial',{...f.original,jobs:{...f.original.jobs,previous:{video_id:'Fresh_Reel',stage:'upload',maximum_cents:10,status:'completed',actual_cents:10}}});await f.run();assert.equal(f.stats().calls,0);}
});
test('two independent approvals share one atomic acquisition slot and immutable invocation scopes',async()=>{
 const entered=deferred(),finish=deferred(),f=fixture({download:async(_video,{onExecutionStopped})=>{entered.resolve();await finish.promise;onExecutionStopped();}});const second=f.approve('Other_Reel','other_request_20261015');
 const first=f.run();await entered.promise;const blocked=await runAssistedUpload(second);assert.equal(blocked.reason,'acquisition_capacity');assert.equal(f.stats().calls,1);assert.notEqual(f.scoped[0].scope,f.scoped[1].scope);assert.ok(Object.isFrozen(f.scoped[0].scope));
 finish.resolve();assert.equal((await first).status,'completed');assert.deepEqual((await f.store.get('settings/financial')).data.batch,f.original.batch);
});
test('download timeout retains new reservation and slot, old1850 remain intact and no replay',async()=>{
 const f=fixture({download:async()=>{throw Object.assign(Error('synthetic'),{name:'TimeoutError'});}});assert.equal((await f.run()).status,'uncertain');assert.equal((await f.store.get('settings/financial')).data.reserved_cents,1860);assert.equal(Object.keys((await f.store.get('settings/acquisition')).data.active).length,1);await f.run();assert.equal(f.stats().calls,1);
});
test('lost final receipt does not invoke a second upload',async()=>{
 const f=fixture(),patch=f.store.patch;f.store.patch=async(p,c,o)=>{if(c.outcome)throw Error('lost receipt');return patch.call(f.store,p,c,o);};assert.equal((await f.run()).reason,'assisted_result_unconfirmed');await f.run();assert.equal(f.stats().calls,1);
});
test('already admitted work can complete after approval expiry; it cannot be reminted or replayed',async()=>{
 let now=Date.now();const f=fixture({clock:()=>now,download:async(_video,{onExecutionStopped})=>{now+=120000;onExecutionStopped();}});assert.equal((await f.run()).status,'completed');await f.run();assert.equal(f.stats().calls,1);
});
test('scoped dependencies reject other stage, video, execution, object, pending result and copied scope',async()=>{
 const f=fixture();await f.run();const {scope,flow,capacity,gate}=f.scoped[0];
 for(const t of [{videoId:scope.videoId,stage:'analysis'},{videoId:'Other_Reel',stage:'upload'},{videoId:scope.videoId,stage:'upload',recoverSettled:true,recoveryId:'another_request_20261015'}])await assert.rejects(flow.run(t));
 await assert.rejects(flow.poll({videoId:scope.videoId}));await assert.rejects(flow.reconcileAnalysis({videoId:scope.videoId}));await assert.rejects(gate({executionId:'wrong',stage:'upload',videoId:scope.videoId}));
 await assert.rejects(capacity.reserveResult({key:'results/instagram/Fresh_Reel/analysis.json'}));
 for(const key of ['originals/instagram/Other_Reel/video.mp4','results/instagram/Fresh_Reel/analysis.json'])await assert.rejects(capacity.admit({bucket:'megabrain-v0-1017370021431-media',key,bytes:5,digest:'a'.repeat(64)}));
});
test('insufficient capacity fails closed before immutable object upload',async()=>{
 const f=fixture();f.seed('settings/capacity',{...f.docs.get('settings/capacity').data,limit_bytes:1});assert.equal((await f.run()).status,'uncertain');assert.equal(f.objects.length,0);
});
test('runtime scope opt-in is disabled by default and requires assisted mode, one ID and quote<=100',()=>{
 const preset=JSON.parse(readFileSync(new URL('../config/analysis-preset.json',import.meta.url))),base={project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',worker_origin:'https://example.run.app',assisted_upload_enabled:true,dispatch_enabled:false,admission_enabled:false,pilot_video_ids:['Fresh_Reel'],quotes:{upload:10}};
 assert.doesNotThrow(()=>workerRuntime(base,preset));assert.doesNotThrow(()=>workerRuntime({...base,assisted_single_upload_enabled:true},preset));
 for(const delta of [{assisted_upload_enabled:false},{pilot_video_ids:['Fresh_Reel','Other_Reel']},{quotes:{upload:101}},{assisted_single_upload_enabled:'yes'}])assert.throws(()=>workerRuntime({...base,assisted_single_upload_enabled:true,...delta},preset));
});

test('unknown approval receipt never constructs a scoped flow or invokes an upload',async()=>{
 const f=fixture(),patch=f.store.patch;f.store.patch=async(p,c,o)=>{if(c.consumed_at){await patch.call(f.store,p,c,o);throw Error('lost consume receipt');}return patch.call(f.store,p,c,o);};
 assert.equal((await f.run()).reason,'assisted_acquisition_unconfirmed');assert.equal(f.scoped.length,0);await f.run();assert.equal(f.stats().calls,0);assert.deepEqual((await f.store.get('settings/financial')).data,f.original);
});
test('same consumed request racing has one invocation and scope',async()=>{
 const f=fixture(),results=await Promise.all([f.run(),f.run()]);assert.equal(results.filter(r=>r.status==='completed').length,1);assert.equal(f.scoped.length,1);assert.equal(f.stats().calls,1);
});


test('proven future download error releases only its slot; real ledger keeps new and historical uncertainty',async()=>{
 const f=fixture({download:async(_video,{onExecutionStopped})=>{onExecutionStopped();throw Object.assign(Error('normal synthetic exit'),{code:1});}});
 const result=await f.run();assert.equal(result.status,'uncertain');
 const state=(await f.store.get('settings/financial')).data;
 assert.equal(state.reserved_cents,1860);assert.equal(state.jobs[result.execution_id].status,'uncertain');
 assert.equal(state.jobs[result.execution_id].maximum_cents,10);
 for(const [id,job] of Object.entries(f.original.jobs))assert.deepEqual(state.jobs[id],job);
 assert.deepEqual(state.batch,f.original.batch);
 assert.deepEqual((await f.store.get('settings/acquisition')).data.active,{});
 assert.equal([...f.docs.keys()].filter(path=>path.startsWith('execution_stops/')).length,1);
 await f.run();assert.equal(f.stats().calls,1);
});
