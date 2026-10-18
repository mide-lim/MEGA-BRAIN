import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleREST} from '../lib/google-rest.mjs';
import {ReelsSemanticProvider,semanticFailureDiagnostic} from '../lib/reels-semantic-provider.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {makeSemanticFixture} from './reels-semantic-fixture.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
import {fixedStageRuntime} from '../lib/fixed-stage-runtime.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {closedReleaseConfig} from '../lib/reels-runtime-policy.mjs';

const project='megabrain-v0-1017370021431';
const target='https://aiplatform.googleapis.com/v1/projects/'+project+'/locations/global/test';
function setup({fetchImpl,tokenProvider=async()=> 'private-ci-token'}={}){
 const fixture=makeSemanticFixture(),store=memoryReelsStore();for(const row of fixture.documents)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 const repository=new ReelsRepository({store,cacheTtlMs:0}),api=new GoogleREST({project,tokenProvider,fetchImpl}),provider=new ReelsSemanticProvider({api}),deliveries=[];
 const curator=new ReelsSemanticCurator({repository,provider,enqueue:async j=>{deliveries.push(j);return {status:'sent'};}});
 return {fixture,store,repository,api,provider,curator,deliveries};
}
async function start(s){const p=await s.curator.preview({all:true});const r=await s.curator.create({selection:{all:true},previewHash:p.previewHash,idempotencyKey:'diagnostic-job-key'});s.deliveries.length=0;return r.job;}
const delivery=j=>({jobId:j.id,sequence:j.dispatch.sequence,outboxId:j.dispatch.outboxId,maxBatches:3});
async function observed(s,id){const j=await s.store.get('reels_index/semantic_job_'+id);return {job:j.data,attempt:await s.store.get('reels_index/semantic_attempt_'+j.data.batch.id)};}
function noPrivateText(value){const json=JSON.stringify(value);for(const secret of ['private-ci-token','private source quote','private-user@example.com','https://private.example','Bearer'])assert.equal(json.includes(secret),false);}

test('real adapter HTTP rejection preserves fixed safe diagnosis atomically with counted intent and never resubmits',async()=>{
 let fetches=0;const s=setup({fetchImpl:async()=>{fetches++;return Response.json({error:{status:'INVALID_ARGUMENT',message:'private source quote https://private.example Bearer private-ci-token private-user@example.com'}},{status:400,headers:{'x-request-id':'11111111-1111-4111-8111-111111111111'}});}}),j=await start(s),before=s.store.commitSemantic,commits=[];
 s.store.commitSemantic=async plan=>{commits.push(structuredClone(plan));return before(plan);};
 const r=await s.curator.runDelivery(delivery(j)),o=await observed(s,j.id);
 assert.equal(r.job.status,'uncertain');assert.equal(o.job.callsUsed,1);assert.equal(o.job.cursor,0);assert.equal(o.job.batch.status,'submitting');assert.equal(o.attempt.data.diagnostic.outcome,'http_rejection_received');
 assert.equal(o.attempt.data.diagnostic.apiService,'vertex_ai');assert.equal(o.attempt.data.diagnostic.requestStage,'http_response_received');assert.equal(o.attempt.data.diagnostic.httpStatus,400);assert.equal(o.attempt.data.diagnostic.providerStatus,'INVALID_ARGUMENT');assert.equal(o.attempt.data.diagnostic.billingOutcome,'not_determined');assert.equal(o.attempt.data.diagnostic.retryAllowed,false);
 assert.equal(o.attempt.data.bindingHash,o.job.batch.bindingHash);assert.equal(o.attempt.data.id,o.job.batch.id);assert.ok(commits.some(p=>p.writes.length===2&&p.writes.some(w=>w.data.kind==='semantic_attempt')&&p.writes.some(w=>w.data.kind==='semantic_job'&&w.data.status==='uncertain')&&p.checks.some(c=>c.path==='reels_index/semantic_attempt_'+o.job.batch.id&&c.updateTime===null)));
 assert.equal([...s.store.docs.values()].filter(x=>x.data.kind==='semantic_result'||x.data.kind==='semantic_raw').length,0);noPrivateText(o.attempt.data);noPrivateText(r);
 await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);assert.equal(s.deliveries.length,0);
 const again=await s.curator.job(j.id);assert.equal(again.job.providerDiagnostic.providerStatus,'INVALID_ARGUMENT');assert.equal((await s.curator.overview()).jobs[0].providerDiagnostic.httpStatus,400);
});

test('known zero credential/preflight, transport failure and HTTP200 body failure remain distinct with no replay',async()=>{
 for(const kind of ['credential','transport','body']){
  let fetches=0;const s=setup({tokenProvider:async()=>{if(kind==='credential')throw Error('private-ci-token');return 'private-ci-token';},fetchImpl:async()=>{fetches++;if(kind==='transport')throw Object.assign(TypeError('private source quote'),{cause:{code:'ECONNRESET',message:'private-ci-token'}});return new Response('{broken private source quote',{status:200});}}),j=await start(s);
  await s.curator.runDelivery(delivery(j));const o=await observed(s,j.id),d=o.attempt.data.diagnostic;assert.equal(o.job.status,'uncertain');assert.equal(o.job.callsUsed,1);assert.equal(d.outcome,kind==='credential'?'not_submitted':'submission_uncertain');assert.equal(d.requestStage,kind==='credential'?'credential':kind==='transport'?'fetch_started':'response_body_read');assert.equal(d.dispatchAttempted,kind!=='credential');assert.equal(d.responseReceived,kind==='body');assert.equal(d.httpStatus,kind==='body'?200:null);assert.equal(d.responseBodyComplete,false);assert.equal(fetches,kind==='credential'?0:1);noPrivateText(d);
  await s.curator.runDelivery(delivery(j));assert.equal(fetches,kind==='credential'?0:1);
 }
 const s=setup({fetchImpl:async()=>{throw Error('must not fetch');}});await assert.rejects(()=>s.provider.infer({sources:[],requestId:'a'.repeat(64),model:'gemini-synthetic'}),e=>{const d=semanticFailureDiagnostic(e,{stage:'provider',phase:'extract'});assert.equal(d.outcome,'not_submitted');assert.equal(d.requestStage,'provider_preflight');return true;});
});

test('received envelope followed by Firestore409 cannot become a provider rejection or a safe retry',async()=>{
 let fetches=0;const raw={candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}],usageMetadata:{candidatesTokenCount:1}},s=setup({fetchImpl:async()=>{fetches++;return Response.json(raw);}}),j=await start(s);
 s.curator.envelopeSave=async()=>{throw Object.assign(Error('private source quote'),{status:409,google_diagnostic:{api_service:'firestore',http_status:409,request_stage:'http_response_received',dispatch_attempted:true,response_received:true,response_body_complete:false},provider_diagnostic:{status:'ABORTED',message:'private source quote'}});};
 await s.curator.runDelivery(delivery(j));const o=await observed(s,j.id),d=o.attempt.data.diagnostic;
 assert.equal(o.job.status,'uncertain');assert.equal(d.origin,'semantic_persistence');assert.equal(d.operationStage,'raw_persistence');assert.equal(d.outcome,'response_received_persistence_uncertain');assert.equal(d.apiService,'firestore');assert.equal(d.httpStatus,409);assert.equal(d.providerStatus,null);assert.equal(d.envelopePresent,false);assert.equal(o.job.callsUsed,1);noPrivateText(d);
 await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);
});

test('saved-application error retains existing paid envelope and records a separate application origin',async()=>{
 let fetches=0;const s=setup({fetchImpl:async()=>{fetches++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]});}}),j=await start(s);
 s.curator.applySaved=async()=>{throw Object.assign(Error('private source quote'),{status:409,code:'SEMANTIC_SOURCE_CHANGED'});};
 await s.curator.runDelivery(delivery(j));const o=await observed(s,j.id),d=o.attempt.data.diagnostic;
 assert.equal(o.job.status,'paused');assert.equal(d.origin,'saved_application');assert.equal(d.operationStage,'saved_application');assert.equal(d.outcome,'saved_response_requires_review');assert.equal(d.providerStatus,null);assert.equal(d.envelopePresent,true);assert.equal([...s.store.docs.values()].filter(x=>x.data.kind==='semantic_result').length,1);assert.equal([...s.store.docs.values()].filter(x=>x.data.kind==='semantic_raw').length,1);noPrivateText(d);
 await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);
});

test('diagnostic commit acknowledgement is reconciled by exact readback without writing twice or resubmitting',async()=>{
 let fetches=0,attemptWrites=0;const s=setup({fetchImpl:async()=>{fetches++;throw TypeError('synthetic lost response');}}),j=await start(s),original=s.store.commitSemantic;
 s.store.commitSemantic=async plan=>{const r=await original(plan);if(plan.writes.some(w=>w.data.kind==='semantic_attempt')){attemptWrites++;throw Object.assign(Error('ACK lost'),{requiresReconciliation:true});}return r;};
 await s.curator.runDelivery(delivery(j));const o=await observed(s,j.id);assert.equal(o.job.status,'uncertain');assert.ok(o.attempt);assert.equal(attemptWrites,1);assert.equal(fetches,1);await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);assert.equal(attemptWrites,1);
});

test('diagnostic CAS race cannot overwrite a newer job or erase its original submitting intent',async()=>{
 let fetches=0;const s=setup({fetchImpl:async()=>{fetches++;throw TypeError('synthetic lost response');}}),j=await start(s),original=s.store.commitSemantic;let changed=false;
 s.store.commitSemantic=async plan=>{if(!changed&&plan.writes.some(w=>w.data.kind==='semantic_attempt')){changed=true;const snap=await s.store.get('reels_index/semantic_job_'+j.id);await s.store.patch('reels_index/semantic_job_'+j.id,{status:'uncertain',reason:'OWNER_READBACK_REQUIRED'},{updateTime:snap.updateTime});}return original(plan);};
 await assert.rejects(()=>s.curator.runDelivery(delivery(j)),{code:'SEMANTIC_VERSION_CHANGED'});const o=await observed(s,j.id);assert.equal(o.job.status,'uncertain');assert.equal(o.job.reason,'OWNER_READBACK_REQUIRED');assert.equal(o.job.callsUsed,1);assert.equal(o.job.batch.status,'submitting');assert.equal(o.attempt,null);await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);
});

test('real HTTP worker delivery returns safe uncertain metadata and duplicate delivery never invokes provider twice',{timeout:30000},async()=>{
 let fetches=0;const s=setup({fetchImpl:async()=>{fetches++;return Response.json({error:{status:'PERMISSION_DENIED',message:'private source quote private-ci-token'}},{status:403});}}),j=await start(s),config=closedReleaseConfig({project,worker_origin:'https://synthetic-analysis.run.app',reels_processing_enabled:true},{MEGABRAIN_REELS_CLOSED_RELEASE:'v2'});
 const handler=fixedStageRuntime('analysis',config,null,{reelsFactory:(c,p,{stage})=>reelsGoogleRuntime(c,p,{stage,authorize:async req=>req.headers.get('authorization')==='Bearer synthetic-oidc',dependencies:{semantic:s.curator}})}),server=workerHTTP(handler);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const origin='http://127.0.0.1:'+server.address().port;
 const post=async(auth=true)=>{const {maxBatches,...body}=delivery(j);const r=await fetch(origin+'/tasks/curation',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{authorization:'Bearer synthetic-oidc'}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};};
 try{assert.equal((await post(false)).status,401);assert.equal(fetches,0);const r=await post();assert.equal(r.status,200);assert.equal(r.body.job.status,'uncertain');assert.equal(r.body.job.providerDiagnostic.httpStatus,403);noPrivateText(r.body);assert.equal((await post()).status,200);assert.equal(fetches,1);assert.equal(s.deliveries.length,0);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('HTTP429 and HTTP503 facts do not imply billing reconciliation or permission to retry',async()=>{
 for(const status of [429,503]){
  let fetches=0;const s=setup({fetchImpl:async()=>{fetches++;return Response.json({error:{status:status===429?'RESOURCE_EXHAUSTED':'UNAVAILABLE',message:'private source quote'}},{status});}}),j=await start(s);
  await s.curator.runDelivery(delivery(j));const o=await observed(s,j.id),d=o.attempt.data.diagnostic;
  assert.equal(o.job.status,'uncertain');assert.equal(d.httpStatus,status);assert.equal(d.outcome,status===429?'http_rejection_received':'http_error_received');assert.equal(d.billingOutcome,'not_determined');assert.equal(d.retryAllowed,false);assert.equal(o.job.callsUsed,1);
  await s.curator.runDelivery(delivery(j));assert.equal(fetches,1);noPrivateText(d);
 }
});
