import test from 'node:test';
import assert from 'node:assert/strict';
import {stageBoundFlow,stageConfig,workerStages} from '../lib/stage-contract.mjs';
import {workerRuntime} from '../lib/worker-runtime.mjs';

const routes=Object.fromEntries(workerStages.map(stage=>[stage,{queue:stage==='upload'?'v0-acquisition':`v0-${stage}`,workerOrigin:`https://${stage}-example.run.app`}]));
const config=stage=>({project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',worker_stage:stage,worker_origin:routes[stage].workerOrigin,stage_routes:routes,enabled:false,dispatch_enabled:false,admission_enabled:false,quotes:{upload:10,transcription:10,analysis:10}});
test('role config is explicit and cannot silently start the legacy multi-stage entrypoint',()=>{
 for(const stage of workerStages){
  const c=config(stage);assert.equal(stageConfig(c,stage),c);
  assert.throws(()=>workerRuntime(c,{},{}),/entrypoint/);
  for(const changed of [{worker_stage:'other'},{enabled:undefined},{admission_enabled:true},{assisted_upload_enabled:true},{worker_origin:routes[stage==='upload'?'analysis':'upload'].workerOrigin}]){
   if(stage==='upload'&&changed.admission_enabled===true)continue;
   assert.throws(()=>stageConfig({...c,...changed},stage));
  }
 }
});
test('closed role factories reject foreign tasks and do not call any Google API',async()=>{
 let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('External request forbidden');};
 try{
  for(const stage of workerStages){
   const flow=workerRuntime(config(stage),{},{stage,withHandler:false});
   assert.equal((await flow.run({videoId:'Reel_closed',stage,poll:0})).reason,'stage_disabled');
   const other=workerStages.find(x=>x!==stage);
   await assert.rejects(flow.run({videoId:'Reel_closed',stage:other,poll:0}));
   const handler=workerRuntime(config(stage),{},{stage,withHandler:true});
   const response=await handler(new Request('https://worker.invalid/tasks/run',{method:'POST',body:'{}'}));
   assert.equal(response.status,401);
   assert.equal((await handler(new Request('https://worker.invalid/tasks/diagnose',{method:'POST',body:'{}'}))).status,404);
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
test('bound flow validates stage and poll before touching underlying operations',async()=>{
 let calls=0;const flow={quotes:{upload:1},async run(){calls++;return {status:'completed'};},async poll(){calls++;return {status:'waiting'};}};
 for(const stage of workerStages){
  const bound=stageBoundFlow(flow,stage);
  await assert.rejects(bound.run({videoId:'Reel_bound',stage:workerStages.find(x=>x!==stage),poll:0}));
  if(stage!=='transcription')await assert.rejects(bound.poll({videoId:'Reel_bound'}));
  else await assert.rejects(bound.run({videoId:'Reel_bound',stage,poll:1}));
 }
 assert.equal(calls,0);
});
