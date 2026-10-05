import test from 'node:test';import assert from 'node:assert/strict';
import {StorageCapacity,newCapacity} from '../lib/storage-capacity.mjs';
test('concurrent immutable uploads cannot reserve the same remaining space and uncertain uploads hold capacity',async()=>{
 let data={...newCapacity(),enabled:true,limit_bytes:1200},version=0;
 const store={async get(path){return path==='settings/financial'?{data:{ongoing_storage_planned_bytes:1200}}:{data:structuredClone(data),updateTime:String(version)};},async patch(_p,changes,{updateTime}){if(updateTime!==String(version))throw new Error('Conflict');data={...data,...structuredClone(changes)};version++;}};
 const capacity=new StorageCapacity(store),base={bucket:'megabrain-v0-1017370021431-media',key:'originals/test/video.mp4',bytes:100,digest:'a'.repeat(64)};
 const results=await Promise.allSettled([capacity.admit(base),capacity.admit({...base,key:'originals/other/video.mp4'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(data.admitted_bytes,1129);
 assert.equal((await capacity.admit(base)).duplicate,true);assert.equal(data.admitted_bytes,1129);
 await assert.rejects(capacity.admit({...base,digest:'b'.repeat(64)}));
 data.enabled=false;await assert.rejects(capacity.admit(base));
});

test('result capacity is reserved before inference and sealed without a second object slot',async()=>{
 let data={...newCapacity(),enabled:true,claim_limit:200,limit_bytes:2000000},version=0;
 const store={async get(path){return path==='settings/financial'?{data:{ongoing_storage_planned_bytes:2000000}}:{data:structuredClone(data),updateTime:String(version)};},async patch(_p,changes,{updateTime}){assert.equal(updateTime,String(version));data={...data,...structuredClone(changes)};version++;}};
 const capacity=new StorageCapacity(store),key={bucket:'megabrain-v0-1017370021431-media',key:'results/reel/revision/analysis.json'};
 await capacity.reserveResult({...key,maximumBytes:1000});const reserved=data.admitted_bytes;
 await capacity.admit({...key,bytes:500,digest:'a'.repeat(64)});
 assert.equal(data.admitted_bytes,reserved);assert.equal(Object.values(data.claims).length,1);assert.equal(Object.values(data.claims)[0].pending,false);
 await assert.rejects(capacity.admit({...key,bytes:600,digest:'b'.repeat(64)}));
 data.limit_bytes=reserved;await assert.rejects(capacity.reserveResult({...key,key:'results/another/analysis.json'}));
});
