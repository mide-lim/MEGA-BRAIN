import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleREST} from '../google-v0/lib/google-rest.mjs';
import {installOwnerSerialTransport} from './owner-serial-transport.mjs';

const project='megabrain-v0-1017370021431';
const root='https://firestore.googleapis.com/v1/projects/'+project+'/databases/(default)/documents';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const headers={get:()=>null};

test('one complete GoogleREST request at a time includes delayed JSON across multiple instances',async()=>{
 const bodyStarted=deferred(),releaseBody=deferred(),calls=[];let active=0,maxActive=0;
 const fetchImpl=async(url,options)=>{
  active++;maxActive=Math.max(maxActive,active);const index=calls.length;calls.push({url,options});
  return {ok:true,status:200,headers,json:async()=>{if(index===0){bodyStarted.resolve();await releaseBody.promise;}active--;return {index};}};
 };
 const apiA=new GoogleREST({project,tokenProvider:async()=>'fixture-owner-A',fetchImpl});
 const apiB=new GoogleREST({project,tokenProvider:async()=>'fixture-owner-B',fetchImpl});
 const transaction='fixture-transaction-identity';
 const input={method:'POST',headers:{'X-Fixture':'unchanged'},json:{documents:['projects/'+project+'/databases/(default)/documents/videos/Reel_001'],transaction}};
 const commit={method:'POST',json:{transaction,writes:[{delete:'projects/'+project+'/databases/(default)/documents/reels_historical_activity/fixture',currentDocument:{updateTime:'2026-10-17T00:00:00Z'}}]}};
 const original=structuredClone({input,commit});
 const first=apiA.request(root+'/reels_controls/acquisition');
 const second=apiB.request(root+':batchGet',input);
 const third=apiA.request(root+':commit',commit);
 await bodyStarted.promise;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1,'the second fetch must wait for the first JSON body');
 assert.equal(active,1);releaseBody.resolve();
 assert.deepEqual(await Promise.all([first,second,third]),[{index:0},{index:1},{index:2}]);
 assert.equal(maxActive,1);assert.equal(active,0);
 assert.deepEqual(calls.map(c=>c.url),[root+'/reels_controls/acquisition',root+':batchGet',root+':commit']);
 assert.deepEqual(calls.map(c=>c.options.method),['GET','POST','POST']);
 assert.deepEqual(JSON.parse(calls[1].options.body),input.json);
 assert.deepEqual(JSON.parse(calls[2].options.body),commit.json);
 assert.equal(calls[1].options.headers.Authorization,'Bearer fixture-owner-B');
 assert.equal(calls[2].options.headers.Authorization,'Bearer fixture-owner-A');
 assert.equal(calls[1].options.headers['X-Fixture'],'unchanged');
 assert.ok(calls.every(c=>c.options.headers['x-goog-user-project']===project&&c.options.redirect==='error'));
 assert.deepEqual({input,commit},original,'caller transaction, payload and headers remain unmodified');
});

test('a transport rejection is returned unchanged once and the following request is not poisoned',async()=>{
 const failure=new TypeError('synthetic connection refusal');const urls=[];let active=0,maxActive=0;
 const api=new GoogleREST({project,tokenProvider:async()=>'fixture-owner',fetchImpl:async(url)=>{
  urls.push(url);active++;maxActive=Math.max(maxActive,active);
  if(url.endsWith('/failed')){active--;throw failure;}
  return {ok:true,status:200,headers,json:async()=>{active--;return {saved:true};}};
 }});
 const first=api.request(root+'/failed'),second=api.request(root+'/succeeded');
 await assert.rejects(first,error=>error===failure);
 assert.deepEqual(await second,{saved:true});
 assert.deepEqual(urls,[root+'/failed',root+'/succeeded'],'no automatic replay of the failed request');
 assert.equal(maxActive,1);assert.equal(active,0);
});

test('the original project and identity guards remain effective and installation is idempotent',async()=>{
 let fetches=0;const api=new GoogleREST({project,tokenProvider:async()=>'fixture-owner',fetchImpl:async()=>{fetches++;return {ok:true,status:200,headers,json:async()=>({ok:true})};}});
 const request=GoogleREST.prototype.request;
 assert.equal(installOwnerSerialTransport(),false);assert.equal(GoogleREST.prototype.request,request);
 await assert.rejects(()=>api.request('https://unapproved.invalid/'),/Endpoint/);
 await assert.rejects(()=>api.request(root,{headers:{Authorization:'forbidden'}}),/identidade/);
 await assert.rejects(()=>api.request('https://firestore.googleapis.com/v1/projects/other-project/databases/(default)/documents'),/Projeto/);
 assert.equal(fetches,0);
 assert.deepEqual(await api.request(root),{ok:true});assert.equal(fetches,1);
});
