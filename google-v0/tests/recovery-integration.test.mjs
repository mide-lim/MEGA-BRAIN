import test from 'node:test';import assert from 'node:assert/strict';
import {WorkerRecovery} from '../lib/worker-recovery.mjs';
import {executionId} from '../lib/worker-flow.mjs';
import {ongoingCostPlan} from '../lib/ongoing-costs.mjs';
test('read-only recovery preserves interrupted paid claims and distinguishes a pending operation',async()=>{
 const id='Reel_123',docs=new Map(),get=async p=>docs.get(p)??null;
 docs.set('videos/'+id,{data:{media_verified:true,audio_status:'present',transcript:'Texto'}});
 const ledger={paused:true,jobs:{}};docs.set('settings/financial',{data:ledger});
 const recovery=new WorkerRecovery({store:{get}});
 assert.equal((await recovery.inspect(id)).status,'ready_for_dispatch');
 for(const stage of ['upload','transcription','analysis']){
  const key=executionId(id,stage);docs.set('jobs/'+key,{data:{status:'started'}});ledger.jobs[key]={status:'started'};
  assert.equal((await recovery.inspect(id)).status,'needs_reconciliation');
  docs.set('jobs/'+key,{data:{status:'completed'}});ledger.jobs[key]={status:'completed'};
 }
 assert.equal((await recovery.inspect(id)).status,'completed');
 const key=executionId(id,'transcription');docs.set('jobs/'+key,{data:{status:'waiting',operation_name:'projects/megabrain-v0-1017370021431/locations/global/operations/123'}});ledger.jobs[key]={status:'started'};
 const plan=await recovery.inspect(id);assert.equal(plan.status,'operation_pending');assert.equal(plan.actions[0].kind,'consult_existing_operation');assert.equal(plan.financial_paused,true);
 docs.get('jobs/'+key).data.operation_name='projects/711042421394/locations/us/operations/v2-123';
 assert.equal((await recovery.inspect(id)).status,'operation_pending');
 docs.get('jobs/'+key).data.operation_name='projects/999999999999/locations/us/operations/v2-123';
 assert.equal((await recovery.inspect(id)).status,'needs_reconciliation');
 ledger.jobs[key].status='uncertain';assert.equal((await recovery.inspect(id)).actions.length,0);
});
test('ongoing storage and cleanup commitments reduce the amount available for processing',()=>{
 const input={storageBytes:10*1073741824,storageCentsPerGiBMonth:15,daysUntilCleanup:30,serviceOperationsCents:100,transferCents:200,cleanupCents:50,remainingCreditCents:150000,allocationRemainingCents:150000,reserveCents:25000,inflightCents:1000};
 assert.equal(ongoingCostPlan(input).commitment_cents,500);
 assert.equal(ongoingCostPlan({...input,remainingCreditCents:26000}).ready,false);
 assert.throws(()=>ongoingCostPlan({...input,storageCentsPerGiBMonth:undefined}));
});

test('administrative resume dispatches a fresh stage without clearing a paid claim and respects pause',async()=>{
 const docs=new Map(),id='Reel_123';let calls=0;
 docs.set('videos/'+id,{data:{media_verified:false}});docs.set('settings/financial',{data:{paused:false,jobs:{}}});docs.set('settings/automation',{data:{enabled:true}});
 const recovery=new WorkerRecovery({store:{get:async p=>docs.get(p)??null},queue:{async enqueue(task){calls++;assert.equal(task.recoveryId,'admin_resume_123456');return {status:'queued'};}}});
 assert.equal((await recovery.resume({videoId:id,recoveryId:'admin_resume_123456'})).status,'queued');
 docs.set('jobs/'+executionId(id,'upload'),{data:{status:'started'}});
 assert.equal((await recovery.resume({videoId:id,recoveryId:'admin_resume_123456'})).status,'needs_reconciliation');assert.equal(calls,1);
 docs.get('settings/automation').data.enabled=false;
 assert.equal((await recovery.resume({videoId:id,recoveryId:'admin_resume_123456'})).status,'paused');assert.equal(calls,1);
});
