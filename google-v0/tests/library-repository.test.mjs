import test from 'node:test';import assert from 'node:assert/strict';import {LibraryRepository}from '../lib/library-repository.mjs';
test('Google library uses bounded cursor pagination and separates legacy analysis',async()=>{
 let args;const repository=new LibraryRepository({list:async(...a)=>{args=a;return {records:[{data:{id:'video1',video_key:'private-key',transcript:'original',analysis:null,analysis_legacy:{summary:'old'}}}],nextPageToken:'next'};}});
 const result=await repository.page({cursor:'previous'});assert.deepEqual(args,['videos',{pageSize:40,pageToken:'previous'}]);assert.equal(result.next_cursor,'next');assert.equal(result.videos[0].analysis,null);assert.equal(result.videos[0].analysis_legacy.summary,'old');assert.equal('video_key'in result.videos[0],false);
});
test('controls require initialized state and conditional write, without activating financial switch',async()=>{
 let write;const repository=new LibraryRepository({get:async()=>({data:{enabled:false},updateTime:'version1'}),patch:async(...args)=>{write=args;return {data:args[1]};}});
 await repository.updateControls({action:'set',parallelism:4});assert.deepEqual(write,['settings/automation',{parallelism:4},{updateTime:'version1'}]);
 await assert.rejects(repository.updateControls({action:'set',parallelism:5}));await assert.rejects(repository.video('../../production'));
});

test('selected updates bound concurrent reads and use the same safe projection',async()=>{
 let active=0,max=0;const repository=new LibraryRepository({get:async path=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;return {data:{id:path.split('/').at(-1),status:'analyzed',analysis:{title:'Curado'},video_key:'private',provider_diagnostic:'private'}};}});
 const ids=Array.from({length:40},(_,i)=>'Reel_'+i);const selected=await repository.selected(ids);
 assert.equal(max,8);assert.equal(selected.length,40);assert.deepEqual(selected.map(x=>x.id),ids);assert.equal(selected[0].analysis.title,'Curado');assert.ok(!('video_key'in selected[0]));assert.ok(!('provider_diagnostic'in selected[0]));
 const absent=new LibraryRepository({get:async()=>null});await assert.rejects(absent.selected(['Reel_1']),/não encontrado/);
});
