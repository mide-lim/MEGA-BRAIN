import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsReconciliation,reconciliationEvidence} from '../lib/reels-reconciliation.mjs';
import {ReelsPipeline} from '../lib/reels-pipeline.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {hash} from '../lib/reels-runtime.mjs';
function memory(){let version=0;const docs=new Map();return {docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,data)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(data),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,data,{updateTime}={})=>{const old=docs.get(p);if(!old||old.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(data)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);}};}
const proof=job=>({schemaVersion:1,executionId:job.id,reelId:job.reelId,operationId:job.operationId,stage:job.stage,owner:job.owner});
async function setup({kind='result',enabled=true,jobChanges={},videoChanges={}}={}){
 const store=memory(),job={id:'execution_001',reelId:'Reel_001',operationId:'command_001',stage:'analysis',status:'uncertain',owner:'private_worker_owner',...jobChanges};
 if(kind==='result'){job.rawResult={valid:true,changes:{analysis:{summary:'saved only'},analysis_key:'object',analysis_generation:'7',analysis_quality_status:'accepted'}};job.resultEvidence={...proof(job),resultHash:hash(job.rawResult)};}
 if(kind==='operation'){job.stage='transcription';job.operationName='projects/private/operations/saved';job.operationEvidence={...proof(job),operationName:job.operationName};}
 await store.create('reels_executions/'+job.id,job);await store.create('videos/'+job.reelId,{id:job.reelId,analysis:{summary:'previous publication'},analysis_candidate:{summary:'previous candidate'},reels_v2:{operationId:job.operationId,executionId:job.id,status:'uncertain',stage:job.stage},...videoChanges});
 await store.create('reels_controls/'+job.stage,{active:[job.id],desiredConcurrency:1,paused:true});
 const repository={store,raw:async id=>(await store.get('videos/'+id))?.data,refresh:async()=>{}},calls=[];
 const pipeline=new ReelsPipeline({repository,processingEnabled:enabled,operations:{analyze:()=>{throw Error('No submit allowed');},pollTranscription:()=>{throw Error('No poll on web');}},onQueued:async job=>calls.push(job)});
 return {store,job,repository,pipeline,calls,reconciliation:new ReelsReconciliation({repository,pipeline,processingEnabled:enabled})};
}
const input=(action='apply_saved_result',idempotencyKey='reconciliation-key-001')=>({executionId:'execution_001',action,idempotencyKey});
test('inspection is read only, private receipts stay private, default gate stays closed',async()=>{
 const c=await setup({enabled:false}),before=structuredClone([...c.store.docs]),result=await c.reconciliation.inspect(c.job.id);
 assert.equal(result.evidence.savedResult,'verified');assert.equal(result.actions[0].enabled,false);assert.deepEqual([...c.store.docs],before);
 assert.doesNotMatch(JSON.stringify(result),/private_worker_owner|saved only|projects\/private/);
 await assert.rejects(()=>c.reconciliation.command(input()),e=>e.code==='PROCESSING_DISABLED');assert.deepEqual([...c.store.docs],before);
});
test('legacy artifacts, foreign owner, changed payload and changed version cannot prove this paid execution',async()=>{
 for(const corrupt of [job=>job.resultEvidence=null,job=>job.resultEvidence.owner='other_owner',job=>job.rawResult.changes.analysis.summary='altered',job=>job.resultEvidence.schemaVersion=2,job=>job.resultEvidence.executionId='other_execution']){
  const c=await setup(),snapshot=await c.store.get('reels_executions/'+c.job.id),job=snapshot.data;corrupt(job);await c.store.patch('reels_executions/'+c.job.id,job,{updateTime:snapshot.updateTime});
  const before=structuredClone([...c.store.docs]);assert.equal((await c.reconciliation.inspect(c.job.id)).actions.length,0);
  await assert.rejects(()=>c.reconciliation.command(input()),e=>e.code==='RECONCILIATION_UNAVAILABLE');assert.deepEqual([...c.store.docs],before);
 }
});
test('absence never releases occupied capacity or turns uncertain into confirmed failure',async()=>{
 const c=await setup({kind:'none'}),before=structuredClone([...c.store.docs]);const result=await c.reconciliation.inspect(c.job.id);
 assert.equal(result.blockedReason,'VERIFIABLE_EVIDENCE_REQUIRED');await assert.rejects(()=>c.reconciliation.command(input()),e=>e.status===409);assert.deepEqual([...c.store.docs],before);
});
test('superseded execution and migration holds cannot publish, even with a valid saved receipt',async()=>{
 for(const videoChanges of [{reels_v2:{operationId:'new_command',executionId:'new_execution'}},{import_hold:{active:true}}]){
  const c=await setup({videoChanges}),before=structuredClone([...c.store.docs]);assert.equal((await c.reconciliation.inspect(c.job.id)).actions.length,0);
  await assert.rejects(()=>c.reconciliation.command(input()),e=>e.status===409);assert.deepEqual([...c.store.docs],before);
 }
});
test('saved result is applied once and durable receipt survives lost HTTP acknowledgement',async()=>{
 const c=await setup(),first=await c.reconciliation.command(input());assert.equal(first.reconciliation.status,'completed');assert.equal(first.reconciliation.executionStatus,'completed');
 const after=structuredClone([...c.store.docs]);const replay=await c.reconciliation.command(input());assert.deepEqual(replay,first);assert.deepEqual([...c.store.docs],after);
 assert.equal((await c.store.get('videos/Reel_001')).data.analysis.summary,'saved only');assert.equal((await c.store.get('videos/Reel_001')).data.analysis_candidate.summary,'previous candidate');
 await assert.rejects(()=>c.reconciliation.command(input('collect_saved_operation')),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('saved LRO only queues a durable poll and preserves publication, candidate and capacity',async()=>{
 const c=await setup({kind:'operation'}),before=(await c.store.get('videos/Reel_001')).data,result=await c.reconciliation.command(input('collect_saved_operation'));
 assert.equal(result.reconciliation.executionStatus,'waiting');assert.equal(c.calls.length,1);assert.equal(c.calls[0].poll,true);
 const video=(await c.store.get('videos/Reel_001')).data;assert.deepEqual(video.analysis,before.analysis);assert.deepEqual(video.analysis_candidate,before.analysis_candidate);assert.deepEqual((await c.store.get('reels_controls/transcription')).data.active,['execution_001']);
 await c.reconciliation.command(input('collect_saved_operation'));assert.equal(c.calls.length,1);
});
test('API enforces auth/origin, rejects client evidence and never dispatches a GET',async()=>{
 const c=await setup(),api=reelsAPI({repository:c.repository,reconciliation:c.reconciliation,processingEnabled:true,authorize:r=>r.headers.get('authorization')==='test-session',sameOrigin:r=>r.headers.get('origin')==='https://reels.test'});
 const req=(path,body,headers={})=>new Request('https://reels.test/api/reels/'+path,{headers:{authorization:'test-session',origin:'https://reels.test','content-type':'application/json',...headers},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 assert.equal((await api(req('reconciliations/execution_001',null,{authorization:''}))).status,401);
 assert.equal((await api(req('reconciliations',input(),{origin:'https://foreign.test'}))).status,403);
 const before=structuredClone([...c.store.docs]);assert.equal((await api(req('reconciliations/execution_001'))).status,200);assert.deepEqual([...c.store.docs],before);
 for(const extra of [{rawResult:{}},{confirmedNotSubmitted:true},{processingEnabled:true},{evidenceVersion:'forged'},{operationName:'forged'}]){
  const response=await api(req('reconciliations',{...input(),...extra}));assert.equal(response.status,400);assert.equal((await response.json()).code,'INVALID_RECONCILIATION');
 }
 assert.deepEqual([...c.store.docs],before);
});
test('changing the execution after inspection is rejected before apply',async()=>{
 const c=await setup(),recover=c.pipeline.recover.bind(c.pipeline);c.pipeline.recover=async args=>{const snapshot=await c.store.get('reels_executions/'+c.job.id);await c.store.patch('reels_executions/'+c.job.id,{owner:'replacement_owner'},{updateTime:snapshot.updateTime});return recover(args);};
 await assert.rejects(()=>c.reconciliation.command(input()),e=>e.status===409||e.status===412);
 assert.equal((await c.store.get('videos/Reel_001')).data.analysis.summary,'previous publication');assert.deepEqual((await c.store.get('reels_controls/analysis')).data.active,['execution_001']);
});
test('interruption between apply and receipt save recovers from durable completion without applying again',async()=>{
 const c=await setup(),patch=c.store.patch;let lost=true;c.store.patch=async(path,data,options)=>{if(path.startsWith('reels_reconciliations/')&&data.status==='completed'&&lost){lost=false;throw Error('receipt save interrupted');}return patch(path,data,options);};
 await assert.rejects(()=>c.reconciliation.command(input()),/interrupted/);assert.equal((await c.store.get('reels_executions/'+c.job.id)).data.status,'completed');
 const result=await c.reconciliation.command(input());assert.equal(result.reconciliation.status,'completed');assert.equal(result.reconciliation.executionStatus,'completed');assert.equal((await c.store.get('videos/Reel_001')).data.analysis.summary,'saved only');
});
test('saved apply resumes only through a proved successor chain and never regresses the advanced stage',async()=>{
 const c=await setup({jobChanges:{stage:'acquisition'}}),nextId=hash({operationId:c.job.operationId,reelId:c.job.reelId,stage:'transcription'});
 await c.store.create('reels_executions/'+nextId,{id:nextId,operationId:c.job.operationId,reelId:c.job.reelId,stage:'transcription',status:'queued',predecessorId:c.job.id});
 const video=await c.store.get('videos/Reel_001');await c.store.patch('videos/Reel_001',{reels_v2:{operationId:c.job.operationId,executionId:nextId,stage:'transcription',status:'queued'}},{updateTime:video.updateTime});
 assert.equal((await c.reconciliation.inspect(c.job.id)).evidence.verifiedSuccessor,true);
 await c.reconciliation.command(input());const after=(await c.store.get('videos/Reel_001')).data;
 assert.equal(after.reels_v2.executionId,nextId);assert.equal(after.reels_v2.stage,'transcription');assert.equal(after.analysis.summary,'previous publication');
 const next=await c.store.get('reels_executions/'+nextId);await c.store.patch('reels_executions/'+nextId,{predecessorId:'unrelated'},{updateTime:next.updateTime});
 assert.equal((await c.reconciliation.inspect(c.job.id)).evidence.verifiedSuccessor,false);
});
