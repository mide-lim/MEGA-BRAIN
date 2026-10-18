import test from 'node:test';
import assert from 'node:assert/strict';
import {Firestore,encodeFields} from '../lib/firestore.mjs';
import {projectContextualContribution} from '../lib/reels-contextual-catalogue.mjs';
import {makeFullCatalogueFixture} from './reels-contextual-catalogue-fixture.mjs';
const ID='EmuCatalogue01',path='reels_index/contextual_'+ID;
function replacement(){
 const input=makeFullCatalogueFixture(),s=JSON.parse(input.records[2].sourceJson);s.video.id=ID;s.item.id=ID;
 return projectContextualContribution({...s,sourceVersions:{video:'2026-10-18T00:15:00.000Z'},observedAt:input.observedAt});
}
const checkRows=()=>[{path:'videos/'+ID,updateTime:'2026-10-18T00:15:00.000Z'},{path:'settings/reels_v2_taxonomy',updateTime:'tax-version'},{path:'settings/reels_v2_contextual_catalogue',updateTime:'manifest-version'},{path:'reels_index/contextual_review_'+ID,updateTime:null},{path,updateTime:null}];
test('derived store wire carries every read in one transaction and only a full update write; no verify opcode or provider',async()=>{
 const calls=[],checks=checkRows(),data=replacement(),prefix='projects/demo-megabrain/databases/(default)/documents/';
 const api={project:'demo-megabrain',request:async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith(':beginTransaction'))return {transaction:'transaction-fixture'};
  if(url.endsWith(':batchGet'))return checks.slice().reverse().map(c=>c.updateTime?{found:{name:prefix+c.path,updateTime:c.updateTime,fields:{}}}:{missing:prefix+c.path});
  if(url.endsWith(':commit'))return {writeResults:[{updateTime:'new-version'}]};
  throw Error('Unexpected request');
 }};
 const result=await new Firestore(api).compareAndReplaceDerived({path,replacement:data,checks});
 assert.equal(result.applied,true);assert.equal(calls.length,3);
 assert.deepEqual(calls[0].options.json,{options:{readWrite:{}}});
 assert.equal(calls[1].options.json.transaction,'transaction-fixture');assert.equal(calls[1].options.json.documents.length,checks.length);
 const commit=calls[2].options.json;assert.equal(commit.transaction,'transaction-fixture');assert.equal(commit.writes.length,1);assert.ok(commit.writes[0].update);assert.equal(commit.writes[0].verify,undefined);assert.equal(commit.writes[0].updateMask,undefined);assert.deepEqual(commit.writes[0].currentDocument,{exists:false});
});
test('missing source precondition and a changed transactional source stop before any write',async()=>{
 let committed=0,rolledBack=0;const checks=checkRows(),prefix='projects/demo-megabrain/databases/(default)/documents/';
 const store=new Firestore({project:'demo-megabrain',request:async(url)=>{
  if(url.endsWith(':beginTransaction'))return {transaction:'tx'};
  if(url.endsWith(':batchGet'))return checks.map(c=>c.updateTime?{found:{name:prefix+c.path,updateTime:c.path.startsWith('videos/')?'changed':c.updateTime,fields:{}}}:{missing:prefix+c.path});
  if(url.endsWith(':rollback')){rolledBack++;return {};}if(url.endsWith(':commit')){committed++;throw Error('must not commit');}
 }});
 await assert.rejects(store.compareAndReplaceDerived({path,replacement:replacement(),checks:checks.filter(c=>!c.path.startsWith('videos/'))}),/precondição|versão/);
 assert.equal((await store.compareAndReplaceDerived({path,replacement:replacement(),checks})).applied,false);assert.equal(committed,0);assert.equal(rolledBack,1);
});
test('ambiguous metadata commit is read back once and never automatically repeated',async()=>{
 let committed=0;const checks=checkRows(),prefix='projects/demo-megabrain/databases/(default)/documents/',store=new Firestore({project:'demo-megabrain',request:async(url)=>{
  if(url.endsWith(':beginTransaction'))return {transaction:'tx'};
  if(url.endsWith(':batchGet'))return checks.map(c=>c.updateTime?{found:{name:prefix+c.path,updateTime:c.updateTime,fields:{}}}:{missing:prefix+c.path});
  if(url.endsWith(':commit')){committed++;throw Error('response unavailable');}if(url.endsWith(':rollback'))return {};
  throw Object.assign(Error('not saved'),{status:404});
 }});
 await assert.rejects(store.compareAndReplaceDerived({path,replacement:replacement(),checks}),e=>e.requiresReconciliation===true);assert.equal(committed,1);
});
test('Firestore emulator proves transactional source fencing and removal of obsolete derived fields',{skip:!process.env.FIRESTORE_EMULATOR_HOST,timeout:180000},async()=>{
 const host=process.env.FIRESTORE_EMULATOR_HOST,requests=[],api={project:'demo-megabrain',request:async(url,options={})=>{
  const target=url.replace('https://firestore.googleapis.com','http://'+host),started=Date.now();
  const response=await fetch(target,{method:options.method??'GET',headers:{'content-type':'application/json'},...(options.json?{body:JSON.stringify(options.json)}:{}),signal:AbortSignal.timeout(15000)});
  requests.push({method:options.method??'GET',path:new URL(target).pathname,transaction:!!options.json?.transaction,status:response.status,elapsed:Date.now()-started});
  const text=await response.text();let body;try{body=text?JSON.parse(text):{};}catch{throw Error('Emulator returned invalid JSON');}
  if(!response.ok){const diagnostic={method:options.method??'GET',path:new URL(target).pathname,httpStatus:response.status,firestoreStatus:body.error?.status??null,message:String(body.error?.message??'').slice(0,1200)};console.error(JSON.stringify({syntheticEmulatorFailure:diagnostic}));throw Object.assign(Error('Emulator request failed: '+response.status+' '+diagnostic.firestoreStatus),{status:response.status});}
  return body;
 }};
 const store=new Firestore(api),input=makeFullCatalogueFixture(),source=JSON.parse(input.records[2].sourceJson);source.video.id=ID;source.item.id=ID;
 await store.create('videos/'+ID,source.video);await store.create('settings/reels_v2_taxonomy',{revision:1,nodes:[],assignments:[],rules:[]});await store.create('settings/reels_v2_contextual_catalogue',{status:'active',policyVersion:'saved-publication-catalogue-v1'});
 await store.create(path,{kind:'contextual_contribution',reelId:ID,obsolete:'must disappear'});
 const video=await store.get('videos/'+ID),taxonomy=await store.get('settings/reels_v2_taxonomy'),manifest=await store.get('settings/reels_v2_contextual_catalogue'),previous=await store.get(path),review=await store.get('reels_index/contextual_review_'+ID);
 const value=projectContextualContribution({...source,sourceVersions:{video:video.updateTime},observedAt:input.observedAt}),checks=[{path:'videos/'+ID,updateTime:video.updateTime},{path:'settings/reels_v2_taxonomy',updateTime:taxonomy.updateTime},{path:'settings/reels_v2_contextual_catalogue',updateTime:manifest.updateTime},{path:'reels_index/contextual_review_'+ID,updateTime:review?.updateTime??null},{path,updateTime:previous.updateTime}];
 assert.equal((await store.compareAndReplaceDerived({path,replacement:value,checks})).applied,true);
 const after=await store.get(path);assert.deepEqual(after.data,value);assert.equal(after.data.obsolete,undefined);
 // Change the synthetic source using the documented Write precondition in a
 // commit body: the emulator PATCH query adapter decoded that timestamp as 0.
 const changed=await api.request(store.root+':commit',{method:'POST',json:{writes:[{update:{name:'projects/'+api.project+'/databases/(default)/documents/videos/'+ID,fields:encodeFields({...source.video,title:'New source metadata'})},currentDocument:{updateTime:video.updateTime}}]}});
 assert.equal(changed.writeResults.length,1);assert.notEqual(changed.writeResults[0].updateTime,video.updateTime);
 const revised=await store.get('videos/'+ID);assert.equal(revised.data.title,'New source metadata');assert.equal(revised.updateTime,changed.writeResults[0].updateTime);
 checks.find(c=>c.path===path).updateTime=after.updateTime;
 assert.equal((await store.compareAndReplaceDerived({path,replacement:value,checks})).applied,false);
 assert.equal((await store.get(path)).updateTime,after.updateTime);
 assert.ok(requests.some(r=>r.path.endsWith(':batchGet')&&r.transaction));assert.ok(requests.some(r=>r.path.endsWith(':commit')&&r.transaction));
});
