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
