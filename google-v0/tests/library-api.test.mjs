import test from 'node:test';import assert from 'node:assert/strict';import {libraryAPI}from '../lib/library-api.mjs';
function setup(allow=true){let reads=0,writes=0;const api=libraryAPI({repository:{page:async()=>{reads++;return {videos:[],next_cursor:null};},controls:async()=>({enabled:false}),updateControls:async()=>{writes++;return {enabled:true};}},ledgerStore:{get:async()=>{reads++;return null;}},authorize:async()=>allow,sameOrigin:r=>r.headers.get('origin')==='https://v0.example.test'});return {api,reads:()=>reads,writes:()=>writes};}
const get=path=>new Request('https://v0.example.test/'+path);
const post=(body,origin='https://v0.example.test')=>new Request('https://v0.example.test/controls',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body});
test('unauthenticated requests make no database reads or writes',async()=>{
 const s=setup(false);for(const handler of ['library','controls','financial'])assert.equal((await s.api[handler](get(handler))).status,401);assert.equal(s.reads(),0);assert.equal(s.writes(),0);
});
test('control updates require matching origin and bounded JSON',async()=>{
 const s=setup();assert.equal((await s.api.controls(post('{}','https://other.test'))).status,403);assert.equal((await s.api.controls(post('x'.repeat(2049)))).status,413);assert.equal(s.writes(),0);
 assert.equal((await s.api.controls(post('{"action":"pause"}'))).status,200);assert.equal(s.writes(),1);
});
test('missing finance state is paused and responses cannot be cached',async()=>{
 const s=setup();const r=await s.api.financial(get('financial'));assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{configured:false,paused:true});
});
test('backend errors expose neither credentials nor internal diagnostics',async()=>{
 const api=libraryAPI({repository:{page:async()=>{throw new Error('PRIVATE-DIAGNOSTIC');}},ledgerStore:{},authorize:async()=>true,sameOrigin:()=>true});const r=await api.library(get('library'));assert.equal(r.status,503);assert.equal((await r.text()).includes('PRIVATE-DIAGNOSTIC'),false);
});

test('overview reports the pilot envelope separately from the overall allocation without exposing job details',async()=>{
 const state={pilot_envelope_cents:20000,allocation_cents:150000,spent_cents:12730,reserved_cents:420,ongoing_commitment_cents:6600,jobs:{private:{status:'uncertain',secret:'HIDDEN'}}};
 const api=libraryAPI({repository:{},ledgerStore:{get:async()=>({data:state})},authorize:async()=>true,sameOrigin:()=>true});
 const data=await(await api.financial(get('financial'))).json();assert.equal(data.pilot_envelope_cents,20000);assert.equal(data.allocation_cents,150000);assert.equal(data.ongoing_commitment_cents,6600);assert.equal(data.uncertain_operations,1);assert.equal(JSON.stringify(data).includes('HIDDEN'),false);
});
