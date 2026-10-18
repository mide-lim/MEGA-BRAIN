import test from 'node:test';
import assert from 'node:assert/strict';
import {CorrectiveOwnerMetadataClient,correctiveOwnerScope,correctiveServiceConfigurationHash,inspectCorrectiveFences,loadConventionalOwnerSession,commitCorrectiveMetadata} from '../../ops/apply-semantic-corrective-capability.mjs';
import {encodeFields,decodeFields} from '../lib/firestore.mjs';
import {semanticHash} from '../lib/reels-semantic-source.mjs';
import {rejectedSemanticRecoveryScope as S,rejectedSemanticRecoveryPath} from '../lib/reels-semantic-rejected-attempt-recovery.mjs';

const project=correctiveOwnerScope.project,region='projects/'+project+'/locations/us-central1',prefix='projects/'+project+'/databases/(default)/documents/',root='https://firestore.googleapis.com/v1/'+prefix.slice(0,-1);
const clockStart=Date.parse('2026-10-18T10:00:00.000Z'),epoch='2026-10-18T09:59:00.000Z',token='synthetic-opaque-token-never-logged';
const stages=['acquisition','transcription','analysis'];
function fixture(){
 const docs=new Map(),services={},deployment={schemaVersion:1,sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),hashAlgorithm:'semanticHash-json-utf8-v1',ownerIdentity:{kind:'reviewed_owner_identity',email:'owner@example.test'},services:{}};
 for(const kind of ['web',...stages,'worker']){
  const service={name:region+'/services/megabrain-v0-'+kind,latestReadyRevision:'synthetic-'+kind+'-rev',terminalCondition:{state:'CONDITION_SUCCEEDED'},template:{containers:[{image:'synthetic/image@sha256:'+semanticHash(kind),env:[{name:'MEGABRAIN_REELS_CLOSED_RELEASE',value:'v2'}]}]},traffic:[],reconciling:false};
  services[kind]=service;deployment.services[kind]={revision:service.latestReadyRevision,imageDigest:'sha256:'+semanticHash(kind),configurationHash:correctiveServiceConfigurationHash(service)};
 }
 for(const stage of stages)docs.set('reels_controls/'+stage,{data:{paused:true,active:[]},updateTime:epoch});
 for(const key of ['admission','automation'])docs.set('settings/'+key,{data:{enabled:false},updateTime:epoch});
 const jobPath='reels_index/semantic_job_'+S.jobId,capPath='reels_index/semantic_corrective_capability_'+semanticHash('synthetic-capability'),receiptPath=rejectedSemanticRecoveryPath();
 const oldJob={kind:'semantic_job',id:S.jobId,status:'uncertain',callsUsed:2,cursor:8,maxCalls:127,originalRawHash:'source-must-remain-unchanged'};
 docs.set(jobPath,{data:oldJob,updateTime:S.jobUpdateTime});docs.set('videos/Synth_saved',{data:{analysis:{summary:'Synthetic immutable saved source'}},updateTime:epoch});
 const receipt={kind:S.version,executionAuthorized:false,validUntil:'2026-10-18T10:05:00.000Z',receiptHash:semanticHash('synthetic receipt')},capability={kind:'semantic_corrective_capability',capabilityHash:semanticHash('synthetic capability'),callsBefore:2,newCalls:3};
 const preparedJob={...oldJob,status:'prepared',batch:null,dispatch:{sequence:2,outboxId:semanticHash({jobId:S.jobId,sequence:2})},reason:'SYNTHETIC_CORRECTIVE_CAPABILITY_READY'};
 const writes=[{path:receiptPath,data:receipt,createOnly:true},{path:capPath,data:capability,createOnly:true},{path:jobPath,data:preparedJob,updateTime:S.jobUpdateTime}];
 const checks=[{path:jobPath,updateTime:S.jobUpdateTime},{path:receiptPath,updateTime:null},{path:capPath,updateTime:null},{path:'videos/Synth_saved',updateTime:epoch},...Array.from({length:12},(_,i)=>({path:'reels_index/semantic_raw_'+S.oldBatchId+'_'+i,updateTime:null})),{path:'reels_index/semantic_result_'+S.oldBatchId,updateTime:null}];
 return {docs,services,deployment,jobPath,prepared:{executable:false,executionAuthorized:false,path:capPath,capability,preparedJob,receiptPath,receiptData:receipt,writes,checks},packet:{metadataInputHash:semanticHash('synthetic metadata'),receipt,expiresAt:receipt.validUntil}};
}
function transport(f,{commitMode='ok',beforeBatchGet=null,mutateFence=null,clockAdvance=0}={}){
 const requests=[],transactions=[],state={now:clockStart,commits:0,readbacks:0,committed:false},reply=(value,status=200)=>({ok:status>=200&&status<300,status,async text(){return JSON.stringify(value);}});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):null;requests.push({url,method:options.method,body,redirect:options.redirect});
  assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.redirect,'error');
  if(u.hostname==='run.googleapis.com'){const kind=u.pathname.split('megabrain-v0-').at(-1);const value=structuredClone(f.services[kind]);if(mutateFence)mutateFence(value,kind);return reply(value);}
  if(u.hostname==='cloudtasks.googleapis.com'){
   if(u.pathname.endsWith('/tasks'))return reply({tasks:[]});
   return reply({name:u.pathname.slice(4),state:'PAUSED'});
  }
  assert.equal(u.hostname,'firestore.googleapis.com');
  if(u.pathname.endsWith(':beginTransaction')){transactions.push('synthetic-transaction');return reply({transaction:transactions.at(-1)});}
  if(u.pathname.endsWith(':runQuery'))return reply([{readTime:new Date(state.now).toISOString()}]);
  if(u.pathname.endsWith(':rollback'))return reply({});
  if(u.pathname.endsWith(':batchGet')){
   if(beforeBatchGet)beforeBatchGet(f,body,state);
   if(state.commits&&!body.transaction)state.readbacks++;
   state.now+=clockAdvance;
   return reply(body.documents.map(name=>{
    const row=f.docs.get(name.slice(prefix.length));
    return row?{found:{name,fields:body.mask?encodeFields(Object.fromEntries(body.mask.fieldPaths.filter(key=>Object.hasOwn(row.data,key)).map(key=>[key,row.data[key]]))):encodeFields(row.data),updateTime:row.updateTime},readTime:new Date(state.now).toISOString()}:{missing:name,readTime:new Date(state.now).toISOString()};
   }));
  }
  if(u.pathname.endsWith(':commit')){
   state.commits++;assert.equal(body.writes.length,3);
   if(commitMode==='unknown-unapplied')throw Error('synthetic acknowledgement lost before fake persistence');
   for(const write of body.writes)f.docs.set(write.update.name.slice(prefix.length),{data:decodeFields(write.update.fields),updateTime:new Date(state.now).toISOString()});
   state.committed=true;if(commitMode==='unknown-applied')throw Error('synthetic acknowledgement lost after fake persistence');
   return reply({writeResults:body.writes.map(()=>({updateTime:new Date(state.now).toISOString()}))});
  }
  throw Error('Unexpected synthetic request');
 };
 return {client:new CorrectiveOwnerMetadataClient({token,fetchImpl,clock:()=>state.now}),requests,state,clock:()=>state.now};
}
test('owner transport denies model, object storage, worker invocation, wrong projects and task writes before any HTTP request',async()=>{
 const seen=[],client=new CorrectiveOwnerMetadataClient({token,fetchImpl:async(...x)=>{seen.push(x);throw Error('must not reach transport');}});
 for(const[url,method]of [
  ['https://aiplatform.googleapis.com/v1/projects/'+project+'/locations/global/publishers/google/models/synthetic:generateContent','POST'],
  ['https://storage.googleapis.com/storage/v1/b/synthetic/o','GET'],
  ['https://synthetic-worker.run.app/curation','POST'],
  ['https://cloudtasks.googleapis.com/v2/'+region+'/queues/v0-curation/tasks','POST'],
  ['https://cloudtasks.googleapis.com/v2/'+region+'/queues/v0-curation:resume','POST'],
  ['https://firestore.googleapis.com/v1/projects/wrong/databases/(default)/documents:batchGet','POST'],
  [root+':commit','POST'],[root+'/videos/Synth_saved','PATCH']
 ])await assert.rejects(()=>client.request(url,{method,...(method==='POST'?{json:{}}:{})}));
 assert.equal(seen.length,0);assert.equal(JSON.stringify(client).includes(token),false);
});
test('conventional owner session uses only gcloud opaque capture and requires pinned private identity, exact account/project and Cloud Shell',async()=>{
 const calls=[],exec=async(bin,args,options)=>{calls.push({bin,args,options});return {stdout:args[0]==='auth'&&args[1]==='list'?'owner@example.test\n':args[0]==='config'?project+'\n':token+'\n'};};
 const ownerIdentity={kind:'reviewed_owner_identity',email:'owner@example.test'},env={CLOUD_SHELL:'true'};
 const session=await loadConventionalOwnerSession({ownerIdentity,env,exec});assert.equal(session.token,token);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.bin==='gcloud'&&!c.options.shell));assert.equal(calls[2].args[1],'print-access-token');
 await assert.rejects(()=>loadConventionalOwnerSession({ownerIdentity,env:{},exec}),{code:'OWNER_CLOUD_SHELL_REQUIRED'});
 await assert.rejects(()=>loadConventionalOwnerSession({ownerIdentity,env:{...env,HTTPS_PROXY:'synthetic-proxy'},exec}),{code:'CONFIGURED_PROXY_UNSUPPORTED'});
 await assert.rejects(()=>loadConventionalOwnerSession({env,exec}),{code:'PINNED_PRIVATE_OWNER_IDENTITY_REQUIRED'});
 await assert.rejects(()=>loadConventionalOwnerSession({ownerIdentity,env,exec:async()=>({stdout:'different@example.test'})}),{code:'EXACT_OWNER_ACCOUNT_REQUIRED'});
});
test('fences read all five paused empty queues, four closed stages plus optional legacy and disabled writers; no source content in output',async()=>{
 const f=fixture(),io=transport(f),result=await inspectCorrectiveFences(io.client,f.deployment);
 assert.equal(Object.keys(result.queues).length,5);assert.equal(Object.keys(result.services).length,5);
 assert.ok(Object.values(result.queues).every(q=>q.state==='PAUSED'&&q.empty));
 assert.equal(io.requests.filter(r=>r.method!=='GET'&&!r.url.endsWith(':batchGet')).length,0);
 assert.deepEqual(io.requests.find(r=>r.url.endsWith(':batchGet')).body.mask.fieldPaths,['paused','active','enabled']);
 assert.equal(JSON.stringify(result).includes('Synthetic immutable saved source'),false);assert.equal(io.state.commits,0);
 for(const change of ['open','occupied','writer','revision','image','environment']){
  const changed=fixture();if(change==='occupied')changed.docs.get('reels_controls/acquisition').data.active=['synthetic'];if(change==='open')changed.docs.get('reels_controls/acquisition').data.paused=false;if(change==='writer')changed.docs.get('settings/admission').data.enabled=true;
  const next=transport(changed,{mutateFence:(value,kind)=>{if(kind!=='analysis')return;if(change==='revision')value.latestReadyRevision='unreviewed';if(change==='image')value.template.containers[0].image='synthetic/image@sha256:'+'0'.repeat(64);if(change==='environment')value.template.containers[0].env[0].value='off';}});
  await assert.rejects(()=>inspectCorrectiveFences(next.client,changed.deployment));assert.equal(next.state.commits,0);
 }
});
test('one atomic three-write commit preserves sources, original counters and old intent metadata',async()=>{
 const f=fixture(),io=transport(f),fences=await inspectCorrectiveFences(io.client,f.deployment),before=structuredClone(f.docs.get('videos/Synth_saved'));f.packet.fenceFingerprint=fences.fingerprint;
 const result=await commitCorrectiveMetadata({client:io.client,prepared:f.prepared,checks:fences.checks,packet:f.packet,deployment:f.deployment,clock:io.clock});
 assert.equal(result.applied,true);assert.equal(result.commitSent,true);assert.equal(result.commitAcknowledged,true);assert.equal(result.readbackAttempted,false);
 assert.equal(io.state.commits,1);assert.equal(io.state.readbacks,0);assert.deepEqual(f.docs.get('videos/Synth_saved'),before);
 const job=f.docs.get(f.jobPath).data;assert.equal(job.callsUsed,2);assert.equal(job.cursor,8);assert.equal(job.maxCalls,127);assert.equal(job.originalRawHash,'source-must-remain-unchanged');
 const commit=io.requests.find(r=>r.url.endsWith(':commit'));assert.equal(commit.body.writes.filter(w=>w.currentDocument.exists===false).length,2);assert.equal(commit.body.writes.find(w=>w.update.name===prefix+f.jobPath).currentDocument.updateTime,S.jobUpdateTime);
 assert.ok(commit.body.writes.every(w=>w.update.name.startsWith(prefix+'reels_index/semantic_')));
 assert.equal(io.requests.filter(r=>r.url.includes('cloudtasks')&&r.method!=='GET').length,0);
});
test('ambiguous acknowledgement triggers exactly one readback and never repeats the commit',async()=>{
 for(const mode of ['unknown-applied','unknown-unapplied']){
  const f=fixture(),io=transport(f,{commitMode:mode}),fences=await inspectCorrectiveFences(io.client,f.deployment);f.packet.fenceFingerprint=fences.fingerprint;
  const call=()=>commitCorrectiveMetadata({client:io.client,prepared:f.prepared,checks:fences.checks,packet:f.packet,deployment:f.deployment,clock:io.clock});
  if(mode==='unknown-applied'){const result=await call();assert.equal(result.reconciledByOneExactReadback,true);assert.equal(result.commitAcknowledged,false);}
  else await assert.rejects(call,{code:'COMMIT_UNCERTAIN_STOP_NO_RETRY'});
  assert.equal(io.state.commits,1);assert.equal(io.state.readbacks,1);
 }
});
test('source/result/raw/capability races, final deadline, illegal write and receipt expiry stop before commit',async()=>{
 for(const kind of ['source','raw','result','capability','deadline','expiry','illegalWrite','counterReset']){
  const f=fixture(),options={};if(kind==='expiry')f.packet.receipt.validUntil='2026-10-18T09:59:59Z';
  if(kind==='illegalWrite')f.prepared.writes[0].path='videos/Synth_saved';
  if(kind==='counterReset')f.prepared.preparedJob.callsUsed=0;
  if(kind==='deadline')options.clockAdvance=19000;
  if(['source','raw','result','capability'].includes(kind))options.beforeBatchGet=(fixture,body)=>{if(!body.transaction)return;const path=kind==='source'?'videos/Synth_saved':kind==='raw'?'reels_index/semantic_raw_'+S.oldBatchId+'_0':kind==='result'?'reels_index/semantic_result_'+S.oldBatchId:fixture.prepared.path;fixture.docs.set(path,{data:{id:'synthetic raced'},updateTime:'2026-10-18T10:00:01Z'});};
  const io=transport(f,options),fences=await inspectCorrectiveFences(io.client,f.deployment);f.packet.fenceFingerprint=fences.fingerprint;
  await assert.rejects(()=>commitCorrectiveMetadata({client:io.client,prepared:f.prepared,checks:fences.checks,packet:f.packet,deployment:f.deployment,clock:io.clock}));
  assert.equal(io.state.commits,0,kind+' must not send any commit');assert.equal(io.state.readbacks,0);
 }
});
