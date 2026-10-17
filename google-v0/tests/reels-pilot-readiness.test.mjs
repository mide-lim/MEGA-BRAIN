import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareReelsPilot} from '../lib/reels-pilot-readiness.mjs';
const candidateCommit='a'.repeat(40),now=Date.parse('2026-10-17T03:00:00Z'),observedAt=new Date(now).toISOString();
const policy={maxAttempts:20,maxRetryDurationSeconds:3600,minBackoffSeconds:10,maxBackoffSeconds:60};
function observation(){return {schemaVersion:1,candidateCommit,observedAt,processingEnabled:false,dispatchEnabled:false,bindings:{web:true,acquisition:true,transcription:true,analysis:true},queues:['acquisition','transcription','analysis'].map(stage=>({stage,paused:true,taskCount:0,retryPolicy:{...policy}})),iam:{effectivePermissionsObserved:true,observedAt,tasksCreate:true,tasksGet:true,tasksFullView:true,actAs:true,runInvoker:true,firestore:true},legacyOccupancyReconciled:true,proofFreshAt:observedAt,candidates:{count:1,unheld:true,identityBound:true,noActiveOrUncertain:true},concurrency:1};}
const plan=input=>prepareReelsPilot({candidateCommit,observation:input,now});
const codes=report=>report.blockers.map(item=>item.code);
test('unknown metadata stays blocked and never authorizes processing or mutation',()=>{
 const result=plan({});assert.equal(result.technicalPrerequisitesMet,false);assert.equal(result.status,'prepared_not_run');assert.equal(result.processAuthorized,false);assert.equal(result.activationAllowed,false);
 assert.ok(codes(result).includes('LEGACY_OCCUPANCY_UNRECONCILED'));assert.ok(codes(result).includes('IAM_FIRESTORE'));assert.equal(result.proposal.budgetGate,false);assert.equal(result.preservation.delete,false);assert.equal(result.preservation.releaseReservations,false);
});
test('even complete fresh evidence produces only an unapplied proposal for separate authorization',()=>{
 const input=observation(),before=structuredClone(input),result=plan(input);assert.deepEqual(input,before);assert.equal(result.blockers.length,0);assert.equal(result.technicalPrerequisitesMet,true);
 assert.equal(result.processAuthorized,false);assert.equal(result.activationAllowed,false);assert.equal(result.nextAction,'request_separate_activation_review');assert.deepEqual(result.proposal.publication,{processingEnabled:false,dispatchEnabled:false,activate:false});
 assert.equal(result.proposal.stageQueues.length,3);assert.equal(result.proposal.oldProcessingQueue,'preserve_unchanged');assert.ok(result.proposal.stageQueues.every(queue=>queue.apply===false));
});
test('single-attempt stage queues require a future retry change, never touching the old fourth queue',()=>{
 const input=observation();for(const queue of input.queues)queue.retryPolicy.maxAttempts=1;
 input.queues.push({stage:'legacy-processing',paused:false,taskCount:99,retryPolicy:{maxAttempts:1}});
 const result=plan(input);assert.equal(result.blockers.filter(item=>item.code.startsWith('RETRY_POLICY_')).length,3);
 assert.deepEqual(result.proposal.stageQueues.map(queue=>queue.retryPolicy),[policy,policy,policy]);assert.equal(result.proposal.oldProcessingQueue,'preserve_unchanged');
 assert.ok(!JSON.stringify(result).includes('legacy-processing'));
});
test('IAM role declarations and an empty v2 active list cannot establish effective permissions or legacy occupancy',()=>{
 const input=observation();delete input.iam.effectivePermissionsObserved;delete input.legacyOccupancyReconciled;input.active=[];
 let result=plan(input);assert.ok(codes(result).includes('IAM_PROOF_REQUIRED'));assert.ok(codes(result).includes('LEGACY_OCCUPANCY_UNRECONCILED'));
 for(const field of ['tasksCreate','tasksGet','tasksFullView','actAs','runInvoker','firestore']){const changed=observation();changed.iam[field]='unknown';result=plan(changed);assert.ok(codes(result).includes('IAM_'+field.toUpperCase()));}
});
test('exact commit and fresh current observations are mandatory, including legacy and IAM proof dates',()=>{
 assert.throws(()=>prepareReelsPilot({candidateCommit:'main',observation:observation(),now}),/SHA/);
 for(const change of [input=>input.candidateCommit='b'.repeat(40),input=>input.observedAt='2026-10-16T03:00:00Z',input=>input.observedAt='2026-10-18T03:00:00Z',input=>input.proofFreshAt='2026-10-16T03:00:00Z',input=>input.iam.observedAt='2026-10-16T03:00:00Z']){const input=observation();change(input);assert.equal(plan(input).technicalPrerequisitesMet,false);}
});
test('sample bounds, holds, current flags and candidate bindings fail closed',()=>{
 for(const change of [input=>input.candidates.count=2,input=>input.candidates.unheld=false,input=>input.candidates.identityBound=false,input=>input.candidates.noActiveOrUncertain=false,input=>input.concurrency=2,input=>delete input.processingEnabled,input=>input.processingEnabled=true,input=>input.dispatchEnabled=true,input=>input.bindings.web=false,input=>input.queues[0].paused=false,input=>input.queues[0].taskCount=1,input=>input.queues.push({...input.queues[0]})]){const input=observation();change(input);assert.equal(plan(input).technicalPrerequisitesMet,false);}
});
test('output projects only fixed safe fields and never copies private identifiers, provider content or paths',()=>{
 const input=observation();input.privateReelIds=['PRIVATE_REEL_SENTINEL'];input.rawResult='PRIVATE_PROVIDER_SENTINEL';input.iam.secret='PRIVATE_SECRET_SENTINEL';input.queues[0].name='PRIVATE_QUEUE_SENTINEL';
 assert.doesNotMatch(JSON.stringify(plan(input)),/PRIVATE_/);
});
test('CLI accepts only read-only preparation flags and emits a blocked sanitized plan without changing input',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reels-pilot-')),path=join(directory,'observation.json'),script=fileURLToPath(new URL('../scripts/prepare-reels-pilot.mjs',import.meta.url));
 try{
  const source=JSON.stringify({schemaVersion:1,candidateCommit,observedAt:new Date().toISOString(),secret:'PRIVATE_CLI_SENTINEL'});await writeFile(path,source);
  const result=spawnSync(process.execPath,[script,'--observation',path,'--candidate',candidateCommit],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,2);const report=JSON.parse(result.stdout);assert.equal(report.processAuthorized,false);assert.equal(report.status,'prepared_not_run');assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CLI_SENTINEL/);
  const rejected=spawnSync(process.execPath,[script,'--apply',path,'--candidate',candidateCommit],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(rejected.status,1);assert.equal(rejected.stdout,'');assert.equal(await readFile(path,'utf8'),source);
 }finally{await rm(directory,{recursive:true,force:true});}
});
