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
