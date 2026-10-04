import test from 'node:test';
import assert from 'node:assert/strict';
import {SampleImporter} from '../lib/sample-importer.mjs';
import {sha256} from '../lib/storage.mjs';
const bytes=Buffer.from('sample bytes');
const source={id:'DXVj0SkDesv',source_url:'https://www.instagram.com/p/DXVj0SkDesv/',status:'analyzed',video_key:'original/instagram/reels/DXVj0SkDesv/video.mp4',duration_seconds:60,object_bytes:bytes.length,transcript:'Texto original\n sem alteração.',analysis:{categories:['Tecnologia']}};
function dependencies({hasAudio=true}={}){
  const writes=[],documents=[];
  return {writes,documents,options:{sourceReader:async()=>bytes,financialCheck:async()=>({ready:true,uploads_enabled:true}),mediaInspector:async()=>({hasVideo:true,hasAudio,duration_seconds:60}),storage:{maxBytes:1000,writeImmutable:async(key,value)=>{writes.push({key,value});return {generation:'123',sha256:sha256(value)};}},firestore:{create:async(path,data)=>{documents.push({path,data});return {created:true};}},clock:()=> '2026-10-03T00:00:00Z'}};
}
test('dry-run and disabled uploads never call a source reader or Google',async()=>{
  const d=dependencies();d.options.sourceReader=async()=>{throw Error('must not read');};
  const importer=new SampleImporter(d.options);
  assert.equal((await importer.run({records:[source]})).mode,'dry-run');
  await assert.rejects(()=>importer.run({records:[source]},{apply:true}));assert.equal(d.writes.length,0);
});
test('copy preserves transcript and historical report without re-transcribing or deleting',async()=>{
  const d=dependencies();const result=await new SampleImporter(d.options).run({records:[source]},{apply:true,uploadsEnabled:true});
  assert.equal(result.source_deletions,0);assert.equal(result.paid_model_calls,0);assert.equal(d.writes.length,3);
  assert.equal(d.documents[0].data.transcript,source.transcript);assert.deepEqual(d.documents[0].data.analysis_legacy,source.analysis);
  assert.equal(d.documents[0].data.analysis,null);assert.equal(d.documents[0].data.source_sha256,sha256(bytes));
});
test('audio-less copies are marked for attention and are not silently passed as complete',async()=>{
  const d=dependencies({hasAudio:false});await new SampleImporter(d.options).run({records:[source]},{apply:true,uploadsEnabled:true});
  assert.equal(d.documents[0].data.status,'needs_attention');assert.equal(d.documents[0].data.has_audio,false);
});
test('a changed source checksum blocks all uploads',async()=>{
  const d=dependencies();await assert.rejects(()=>new SampleImporter(d.options).run({records:[{...source,source_sha256_metadata:'invalid'}]},{apply:true,uploadsEnabled:true}));
  assert.equal(d.writes.length,0);
});
test('financial rejection precedes every source read and upload',async()=>{
  const d=dependencies();let reads=0;d.options.sourceReader=async()=>{reads++;return bytes;};d.options.financialCheck=async()=>({ready:false,uploads_enabled:true});
  await assert.rejects(()=>new SampleImporter(d.options).run({records:[source]},{apply:true,uploadsEnabled:true}));
  assert.equal(reads,0);assert.equal(d.writes.length,0);
});
