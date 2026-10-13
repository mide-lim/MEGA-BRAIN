import test from 'node:test';import assert from 'node:assert/strict';
import {loadLibrarySnapshot,watchLibrary}from '../lib/library-sync.mjs';
test('loads282 records over eight bounded pages, including results beyond40',async()=>{
 const data=Array.from({length:282},(_,i)=>({id:'v'+i,analysis:i>=217?{title:'accepted'}:null}));let calls=0;
 const result=await loadLibrarySnapshot(async url=>{calls++;const start=Number(new URL(url,'http://fixture').searchParams.get('cursor')??0);return {videos:data.slice(start,start+40),next_cursor:start+40<data.length?String(start+40):null};});
 assert.equal(calls,8);assert.equal(result.length,282);assert.equal(result.filter(v=>v.analysis).length,65);assert.equal(result.at(-1).id,'v281');
});
test('deduplicates IDs, refresh replaces obsolete records, no arbitrary corpus cutoff',async()=>{
 let calls=0;const result=await loadLibrarySnapshot(async()=>++calls===1?{videos:[{id:'same',status:'pending'}],next_cursor:'next'}:{videos:[{id:'same',status:'analyzed'},{id:'last'}],next_cursor:null});
 assert.deepEqual(result,[{id:'same',status:'analyzed'},{id:'last'}]);
 assert.deepEqual(await loadLibrarySnapshot(async()=>({videos:[{id:'last'}]})),[{id:'last'}]);
});
test('later-page failure rejects full refresh without delivering partial results',async()=>{
 let calls=0;await assert.rejects(loadLibrarySnapshot(async()=>{if(++calls===2)throw Error('page unavailable');return {videos:[{id:'first'}],next_cursor:'next'};}),/page unavailable/);assert.equal(calls,2);
});
test('repeated cursor and malformed pages fail instead of truncating or looping',async()=>{
 await assert.rejects(loadLibrarySnapshot(async()=>({videos:[],next_cursor:'loop'})),/repetiu/);
 for(const page of [{videos:null},{videos:[{}]},{videos:[],next_cursor:123}])await assert.rejects(loadLibrarySnapshot(async()=>page));
});
test('cancellation stops traversal before requesting another page',async()=>{
 const c=new AbortController();let calls=0;await assert.rejects(loadLibrarySnapshot(async()=>{calls++;c.abort();return {videos:[{id:'x'}],next_cursor:'more'};},{signal:c.signal}),{name:'AbortError'});assert.equal(calls,1);
});
test('visible-only timer, return-to-tab refresh and cleanup',()=>{
 let tick,listener,refreshed=0,cleared=false;const doc={visibilityState:'visible',addEventListener:(name,fn)=>{listener=fn;},removeEventListener:(name,fn)=>{assert.equal(fn,listener);listener=null;}};
 const stop=watchLibrary(()=>refreshed++,{document:doc,timers:{setInterval:(fn,ms)=>{tick=fn;assert.equal(ms,60000);return 7;},clearInterval:id=>{assert.equal(id,7);cleared=true;}}});
 tick();doc.visibilityState='hidden';tick();listener();assert.equal(refreshed,1);doc.visibilityState='visible';listener();assert.equal(refreshed,2);stop();assert.equal(cleared,true);assert.equal(listener,null);
});
