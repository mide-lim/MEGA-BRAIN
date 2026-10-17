import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFields,decodeFields} from '../lib/firestore.mjs';
import {createResetOwnerStore} from '../scripts/reset-confirmed-failures.mjs';
import {prepareConfirmedFailureReset,applyConfirmedFailureReset} from '../lib/reels-confirmed-failure-reset.mjs';
const project='megabrain-v0-1017370021431',host=process.env.FIRESTORE_EMULATOR_HOST;
// Run centrally in GitHub Actions with the official Firestore emulator. Never
// connect this contract test to a Google production host or read credentials.
test('Firestore REST emulator accepts transactional history deletion and preserves media and finance',{skip:!host,timeout:180000},async()=>{
 assert.match(host,/^(?:localhost|127\.0\.0\.1):\d+$/);const origin='http://'+host,root=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`,calls=[];
 const api={project,request:async(url,{method='GET',json}={})=>{assert.ok(url.startsWith(root));calls.push({url,method,json});const r=await fetch(origin+url.slice('https://firestore.googleapis.com'.length),{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},...(json?{body:JSON.stringify(json)}:{})});if(!r.ok)throw Object.assign(Error('emulator HTTP '+r.status),{status:r.status});return r.status===204?{}:r.json();}};
 const id='Reset_'+Date.now(),history='emulator_history_'+Date.now();
 const rawVideo={id,status:'uncertain',uncertain:true,import_hold:{active:true,reason:'migration_not_activated'},error:{code:'LEGACY_RECONCILIATION_REQUIRED',uncertain:true,message:'PRIVATE_ERROR_NOT_BACKED_UP'},video_key:'verified/original.mp4',video_generation:'42',media_verified:true,transcript:'Verified preserved source'};
 await api.request(root+':commit',{method:'POST',json:{writes:[{path:'videos/'+id,data:rawVideo},{path:'reels_historical_activity/'+history,data:{reelId:id,historical:true,executable:false,sourceStatus:'failed'}},{path:'settings/capacity',data:{claims:{}}},{path:'settings/financial',data:{jobs:{}}}].map(r=>({update:{name:root.slice('https://firestore.googleapis.com/v1/'.length)+'/'+r.path,fields:encodeFields(r.data)}}))}});
 const store=createResetOwnerStore(api,{assertRuntimeClosed:async()=>{}}),records=await store.inspectResetMetadata(id),input={schemaVersion:1,observationComplete:true,source:{legacySnapshotSHA256:'a'.repeat(64),auditSHA256:'b'.repeat(64)},attestations:[{id,classification:'download_terminal_failure',sourceStatus:'needs_attention',sourceRecordSHA256:'c'.repeat(64),diagnosticSHA256:'d'.repeat(64)}],records};
 const plan=prepareConfirmedFailureReset(input);assert.equal(plan.rows.length,1);const result=await applyConfirmedFailureReset({plan,approvedPlanSHA256:plan.planSHA256,store,project,assertClosed:async()=>{}});assert.equal(result.resetCount,1);
 const saved=decodeFields((await api.request(root+'/videos/'+id)).fields);assert.equal(saved.status,'registered');assert.equal(saved.error,undefined);assert.equal(saved.uncertain,undefined);assert.equal(saved.import_hold,undefined);assert.equal(saved.video_key,rawVideo.video_key);assert.equal(saved.video_generation,'42');assert.equal(saved.transcript,rawVideo.transcript);
 await assert.rejects(()=>api.request(root+'/reels_historical_activity/'+history),e=>e.status===404);assert.equal((await applyConfirmedFailureReset({plan,approvedPlanSHA256:plan.planSHA256,store,project,assertClosed:async()=>{}})).alreadyReset,1);
 const commits=calls.filter(c=>c.url.endsWith(':commit')&&c.json.transaction);assert.equal(commits.length,1);assert.ok(commits[0].json.writes.every(w=>w.update||w.delete));assert.ok(calls.some(c=>c.url.includes('?transaction=')));assert.ok(calls.some(c=>c.url.endsWith(':runQuery')&&c.json.transaction));
});
