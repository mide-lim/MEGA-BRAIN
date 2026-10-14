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
 const stop=watchLibrary(()=>refreshed++,{document:doc,timers:{setInterval:(fn,ms)=>{tick=fn;assert.equal(ms,15000);return 7;},clearInterval:id=>{assert.equal(id,7);cleared=true;}}});
 tick();doc.visibilityState='hidden';tick();listener();assert.equal(refreshed,1);doc.visibilityState='visible';listener();assert.equal(refreshed,2);stop();assert.equal(cleared,true);assert.equal(listener,null);
});

import {createLibrarySynchronizer,videoStatus,loadVideoUpdates}from '../lib/library-sync.mjs';
const progress=(id,status,version)=>({id,stage:'analysis',status,version});
function syncFixture(){
 let rows=[{id:'Reel_A1',status:'pending'}],items=[],time=1000;
 const calls=[],states=[],errors=[];
 const read=async url=>{
  calls.push(url);
  if(url==='/api/controls')return {automation:{enabled:true}};
  if(url==='/api/financial')return {paused:false,progress:{items}};
  const ids=new URL(url,'http://fixture').searchParams.get('ids');
  return {videos:ids?rows.filter(r=>ids.split(',').includes(r.id)):structuredClone(rows),next_cursor:null};
 };
 const sync=createLibrarySynchronizer({read,onChange:s=>states.push(structuredClone(s)),onError:e=>errors.push(e),now:()=>time});
 return {sync,calls,states,errors,read,setRows:r=>{rows=r;},setProgress:i=>{items=i;},advance:n=>{time+=n;}};
}
test('fast progression loads only changed rows and replaces curated fields',async()=>{
 const f=syncFixture();await f.sync.refresh();
 const full=f.calls.filter(x=>x==='/api/library').length;
 f.setRows([{id:'Reel_A1',status:'analyzed',transcript:'texto',analysis:{title:'Curado',knowledge:{keywords:['tema']}}}]);
 f.setProgress([progress('Reel_A1','completed','new')]);f.advance(15000);await f.sync.refresh();
 assert.equal(f.calls.filter(x=>x==='/api/library').length,full);
 assert.equal(f.calls.filter(x=>x.includes('?ids=')).length,1);
 assert.equal(f.states.at(-1).videos[0].analysis.title,'Curado');
 await f.sync.refresh();assert.equal(f.calls.filter(x=>x.includes('?ids=')).length,1);
 f.advance(60000);await f.sync.refresh();assert.equal(f.calls.filter(x=>x==='/api/library').length,full+1);
});
test('registration refresh queued behind old flight cannot be dropped',async()=>{
 const f=syncFixture();let release,started;
 const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});
 let block=true;
 const read=async url=>{
  const result=await f.read(url);
  if(url==='/api/library'&&block){block=false;started();await gate;}
  return result;
 };
 const states=[];const sync=createLibrarySynchronizer({read,onChange:s=>states.push(s),onError:e=>{throw e;}});
 const first=sync.refresh();await began;
 f.setRows([{id:'Reel_A1',status:'pending'},{id:'Reel_New',status:'pending'}]);
 const registration=sync.refresh({full:true,afterCurrent:true});
 release();await Promise.all([first,registration]);
 assert.equal(states.at(-1).videos.length,2);
 assert.equal(f.calls.filter(x=>x==='/api/library').length,2);
});
test('result completed during pagination is caught by post-snapshot progression read',async()=>{
 const f=syncFixture();let during=true;
 const states=[],read=async url=>{
  const response=await f.read(url);
  if(url==='/api/library'&&during){during=false;f.setRows([{id:'Reel_A1',status:'analyzed',analysis:{title:'Novo'}}]);f.setProgress([progress('Reel_A1','completed','finished')]);}
  return response;
 };
 const sync=createLibrarySynchronizer({read,onChange:s=>states.push(s),onError:e=>{throw e;}});
 await sync.refresh();assert.equal(states.at(-1).videos[0].analysis.title,'Novo');
});
test('failed targeted update keeps both old data and version for next-tick retry',async()=>{
 const f=syncFixture();let fail=false;const states=[],errors=[];
 const sync=createLibrarySynchronizer({read:async url=>{if(fail&&url.includes('?ids='))throw Error('interrupted');return f.read(url);},onChange:s=>states.push(structuredClone(s)),onError:e=>errors.push(e)});
 await sync.refresh();f.setRows([{id:'Reel_A1',status:'analyzed',analysis:{title:'Curado'}}]);f.setProgress([progress('Reel_A1','completed','new')]);fail=true;
 await sync.refresh();assert.equal(states.at(-1).videos[0].status,'pending');assert.equal(errors.length,1);
 fail=false;await sync.refresh();assert.equal(states.at(-1).videos[0].analysis.title,'Curado');
});
test('financial outage cannot hide library records or curated results',async()=>{
 const states=[],errors=[];const sync=createLibrarySynchronizer({read:async url=>{
  if(url==='/api/financial')throw Error('finance unavailable');
  if(url==='/api/controls')return {automation:{enabled:false}};
  return {videos:[{id:'Reel_A1',status:'analyzed',analysis:{title:'Disponível'}}]};
 },onChange:s=>states.push(s),onError:e=>errors.push(e)});
 await sync.refresh();assert.equal(states.at(-1).videos[0].analysis.title,'Disponível');assert.equal(errors.length,1);
});
test('no overlap and stopped in-flight reads cannot update an unmounted screen',async()=>{
 const f=syncFixture();let release,started;const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});const states=[];
 const sync=createLibrarySynchronizer({read:async url=>{if(url==='/api/library'){started();await gate;}return f.read(url);},onChange:s=>states.push(s),onError:e=>{throw e;}});
 const p=sync.refresh();await began;const duplicate=sync.refresh();assert.equal(p,duplicate);sync.stop();release();await p;assert.equal(states.length,0);
});
test('targeted updates are bounded, complete and reject foreign or missing rows',async()=>{
 const ids=Array.from({length:83},(_,i)=>'Reel_'+i);let calls=0;
 assert.equal((await loadVideoUpdates(async url=>{calls++;const selected=new URL(url,'http://fixture').searchParams.get('ids').split(',');assert.ok(selected.length<=40);return {videos:selected.map(id=>({id}))};},ids)).length,83);assert.equal(calls,3);
 for(const videos of [[],[{id:'Foreign'}],[{id:'Reel_A1'},{id:'Reel_A1'}]])await assert.rejects(loadVideoUpdates(async()=>({videos}),['Reel_A1']));
});
test('visible lifecycle labels separate pauses, live stages, failure and accepted data',()=>{
 assert.match(videoStatus({status:'pending'},null,true),/Na fila.*pausado/);
 assert.equal(videoStatus({status:'downloaded'},{stage:'transcription',status:'started'}),'Transcrevendo áudio');
 assert.equal(videoStatus({status:'transcribed'},{stage:'analysis',status:'started'}),'Analisando vídeo');
 assert.equal(videoStatus({status:'needs_attention',analysis:{title:'previous'}},{stage:'analysis',status:'completed'}),'Precisa de atenção');
 assert.equal(videoStatus({status:'analyzed',analysis:{title:'Curado'}},{stage:'analysis',status:'completed'}),'Análise concluída');
});
