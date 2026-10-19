import test from 'node:test';
import assert from 'node:assert/strict';
import {Firestore,encodeFields,decodeFields} from '../lib/firestore.mjs';
test('Firestore preserves raw transcription, nullable values and nested legacy report',()=>{
  const data={id:'DXVj0SkDesv',transcript:'Linha 1\n  Linha 2 — áudio.',duration_seconds:12.3,has_audio:true,analysis:null,analysis_legacy:{categories:['Tecnologia'],evidence:[{quote:'Linha 1',seconds:0}]}};
  assert.deepEqual(decodeFields(encodeFields(data)),data);
  assert.throws(()=>encodeFields({bad:Infinity}));assert.throws(()=>encodeFields({'unsafe.field':'value'}));
  assert.throws(()=>encodeFields({nested:[[1]]}));assert.throws(()=>decodeFields({n:{integerValue:'9007199254740993'}}));
});
test('document create uses an absent-document precondition and preserves existing records',async()=>{
  const calls=[];const api={project:'megabrain-v0-test',request:async(url,options)=>{calls.push({url,options});const e=Error('conflict');e.status=409;throw e;}};
  assert.deepEqual(await new Firestore(api).create('videos/DXVj0SkDesv',{id:'DXVj0SkDesv'}),{created:false});
  assert.ok(calls[0].url.includes('currentDocument.exists=false'));
  assert.equal(calls[0].options.method,'PATCH');
});
test('patch changes only selected fields and requires an optimistic-lock timestamp',async()=>{
  const calls=[];const api={project:'megabrain-v0-test',request:async(url,options)=>{calls.push({url,options});return {fields:options.json.fields,updateTime:'2026-10-03T00:00:00Z'};}};
  const db=new Firestore(api);await assert.rejects(()=>db.patch('settings/automation',{enabled:false}));
  await db.patch('settings/automation',{enabled:false},{updateTime:'2026-10-02T00:00:00Z'});
  assert.ok(calls[0].url.includes('updateMask.fieldPaths=enabled'));
  assert.ok(calls[0].url.includes('currentDocument.updateTime='));
  await assert.rejects(()=>db.get('videos/id/../../settings/private'));
});

test('admission intent keys accept reel identities without relaxing ordinary schema fields',()=>{
  const ids=['C1xnKh5PLwZ','DC9-c4-Rg11','_Reel-123','9Reel_123'];
  const data={intents:Object.fromEntries(ids.map(id=>[id,{status:'pending',created_at:'2026-10-14T01:22:53Z'}]))};
  assert.deepEqual(decodeFields(encodeFields(data)),data);
  for(const id of ['unsafe.field','unsafe/path','x'.repeat(33),'__proto__','constructor','prototype']){
    assert.throws(()=>encodeFields({intents:JSON.parse(`{"${id}":{"status":"pending"}}`)}));
  }
  assert.throws(()=>encodeFields({intents:{abc:{status:'pending'}}}));
  assert.throws(()=>encodeFields({intents:{Reel_123:null}}));
  assert.throws(()=>encodeFields({intents:[]}));
  assert.throws(()=>encodeFields({'unsafe-field':1}));
  assert.throws(()=>encodeFields({other_map:{'DC9-c4-Rg11':{status:'pending'}}}));
  assert.throws(()=>encodeFields({intents:{'DC9-c4-Rg11':{'unsafe-field':1}}}));
});


test('execution-end evidence stays in the bounded internal collection with create-only semantics',async()=>{
 const calls=[];const api={project:'megabrain-v0-test',request:async(url,options)=>{calls.push({url,options});return {fields:options.json.fields,updateTime:'2026-10-15T00:00:00Z'};}};
 const db=new Firestore(api),path='execution_stops/job_'+('a'.repeat(64))+'_12345678-1234-4123-8123-123456789abc';
 assert.equal((await db.create(path,{schema_version:1,ended:true,claim_update_time:'v1'})).created,true);
 assert.ok(calls[0].url.includes('/execution_stops/'));assert.ok(calls[0].url.includes('currentDocument.exists=false'));
 await assert.rejects(()=>db.get(path+'/extra'));await assert.rejects(()=>db.get('execution_stops/../jobs'));
});

function recoveryWire({stalePath=null,unexpected=false,ambiguous=false}={}){
 const executionId='a'.repeat(64),reelId='Reel_001',reviewId='review_'+'b'.repeat(64),selectionId='source_review_'+'c'.repeat(64),receiptId='d'.repeat(64),prefix='projects/megabrain-v0-test/databases/(default)/documents/';
 const reviewVersions=[{path:'reels_quality_receipts/'+reviewId,updateTime:'review-v1'},{path:'reels_quality_receipts/'+selectionId,updateTime:'selection-v1'}],receipt={id:receiptId,receiptHash:'e'.repeat(64),kind:'quality_review_recovery',executionId,reelId,result:{qualityReview:{reviewId,selectionId}}};
 const expected=new Map([['reels_executions/'+executionId,'job-v1'],['videos/'+reelId,'video-v1'],['reels_controls/analysis','control-v1'],...reviewVersions.map(v=>[v.path,v.updateTime]),['reels_reconciliations/'+receiptId,null]]),calls=[];
 const api={project:'megabrain-v0-test',request:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith(':beginTransaction')){assert.deepEqual(options.json,{options:{readWrite:{}}});return {transaction:'quality-tx'};}
  if(url.endsWith(':batchGet')){assert.equal(options.json.transaction,'quality-tx');assert.deepEqual(new Set(options.json.documents),new Set([...expected.keys()].map(p=>prefix+p)));const rows=[...expected].map(([path,version])=>version===null?{missing:prefix+path}:{found:{name:prefix+path,updateTime:stalePath===path?'concurrent-v2':version}});if(unexpected)rows.push({found:{name:prefix+'settings/other',updateTime:'x'}});return rows;}
  if(url.endsWith(':rollback'))return {};
  if(url.endsWith(':commit')){if(ambiguous)throw Error('lost commit response');return {writeResults:[{updateTime:'receipt-v1'},{updateTime:'job-v2'}]};}
  assert.fail('unexpected request '+url);
 }};
 return {db:new Firestore(api),calls,prefix,expected,args:{executionId,reelId,executionVersion:'job-v1',videoVersion:'video-v1',controlVersion:'control-v1',reviewVersions,receipt}};
}
test('quality recovery transaction freezes all source versions and creates only receipt plus execution pointer',async()=>{
 const f=recoveryWire();assert.deepEqual(await f.db.beginQualityRecovery(f.args),{applied:true});
 const commit=f.calls.find(c=>c.url.endsWith(':commit')).options.json;assert.equal(commit.transaction,'quality-tx');assert.equal(commit.writes.length,2);
 assert.equal(commit.writes[0].update.name,f.prefix+'reels_reconciliations/'+f.args.receipt.id);assert.deepEqual(commit.writes[0].currentDocument,{exists:false});
 assert.deepEqual(commit.writes[1].currentDocument,{updateTime:'job-v1'});assert.deepEqual(commit.writes[1].updateMask.fieldPaths,['status','qualityReviewRecovery']);
 const changes=decodeFields(commit.writes[1].update.fields);assert.equal(changes.status,'applying');assert.equal(changes.rawResult,undefined);assert.equal(changes.resultEvidence,undefined);assert.equal(changes.attempt,undefined);assert.ok(!f.calls.some(c=>c.url.endsWith(':rollback')));
});
test('any changed recovery dependency rolls back without writes; unexpected reads fail closed',async()=>{
 const sample=recoveryWire();
 for(const path of [...sample.expected.keys()].filter(p=>!p.startsWith('reels_reconciliations/'))){const f=recoveryWire({stalePath:path});assert.deepEqual(await f.db.beginQualityRecovery(f.args),{applied:false});assert.equal(f.calls.filter(c=>c.url.endsWith(':commit')).length,0);assert.equal(f.calls.filter(c=>c.url.endsWith(':rollback')).length,1);}
 const bad=recoveryWire({unexpected:true});await assert.rejects(bad.db.beginQualityRecovery(bad.args),/inesperada/);assert.equal(bad.calls.filter(c=>c.url.endsWith(':commit')).length,0);
 const duplicate=recoveryWire();duplicate.args.reviewVersions=[duplicate.args.reviewVersions[0],duplicate.args.reviewVersions[0]];await assert.rejects(duplicate.db.beginQualityRecovery(duplicate.args));assert.equal(duplicate.calls.length,0);
});
test('ambiguous recovery commit propagates uncertainty without an automatic second commit',async()=>{
 const f=recoveryWire({ambiguous:true});await assert.rejects(f.db.beginQualityRecovery(f.args),/lost commit response/);assert.equal(f.calls.filter(c=>c.url.endsWith(':commit')).length,1);
});
