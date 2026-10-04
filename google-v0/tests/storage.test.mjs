import test from 'node:test';
import assert from 'node:assert/strict';
import {Storage,sha256} from '../lib/storage.mjs';
const bucket='megabrain-v0-test-media',key='originals/instagram/DXVj0SkDesv/video.mp4',bytes=Buffer.from('verified media');
test('disabled uploads make zero requests',async()=>{
  let calls=0;const api={buckets:new Set([bucket]),request:async()=>{calls++;}};
  await assert.rejects(()=>new Storage(api,bucket).writeImmutable(key,bytes));assert.equal(calls,0);
});
test('immutable upload uses generation zero and verifies the destination bytes',async()=>{
  const calls=[];const api={buckets:new Set([bucket]),request:async(url,options)=>{
    calls.push({url,options});if(calls.length===1){const e=Error('missing');e.status=404;throw e;}
    if(calls.length===2)return {generation:'123'};return bytes;
  }};
  const r=await new Storage(api,bucket).writeImmutable(key,bytes,{uploadsEnabled:true,contentType:'video/mp4'});
  assert.equal(r.sha256,sha256(bytes));assert.equal(r.created,true);
  assert.ok(calls[1].url.includes('ifGenerationMatch=0'));assert.ok(calls[2].url.includes('generation=123'));
});
test('existing identical file is verified and reused; mismatches are never overwritten',async()=>{
  let writes=0;const api={buckets:new Set([bucket]),request:async(url,options)=>{
    if(options?.method==='POST')writes++;
    return options?.responseMode==='bytes'?bytes:{size:String(bytes.length),generation:'123',metadata:{sha256:sha256(bytes)}};
  }};
  const storage=new Storage(api,bucket);assert.equal((await storage.writeImmutable(key,bytes,{uploadsEnabled:true})).created,false);
  await assert.rejects(()=>storage.writeImmutable(key,Buffer.from('different'),{uploadsEnabled:true}));
  assert.equal(writes,0);await assert.rejects(()=>storage.read('originals/../private'));
});
test('a corrupt destination fails checksum verification',async()=>{
  let count=0;const api={buckets:new Set([bucket]),request:async()=>{
    count++;if(count===1){const e=Error('missing');e.status=404;throw e;}
    return count===2?{generation:'123'}:Buffer.from('corrupted');
  }};
  await assert.rejects(()=>new Storage(api,bucket).writeImmutable(key,bytes,{uploadsEnabled:true}));
});
