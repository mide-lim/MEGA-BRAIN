import test from 'node:test';
import assert from 'node:assert/strict';
import {Firestore,encodeFields} from '../lib/firestore.mjs';
const project='megabrain-v0-1017370021431',prefix='projects/'+project+'/databases/(default)/documents/',root='https://firestore.googleapis.com/v1/'+prefix.slice(0,-1);
function transport({stale=false,ackLost=false,readbackMatch=true}={}){
 const calls=[],data={kind:'semantic_job',id:'a'.repeat(64),status:'prepared'},path='reels_index/semantic_job_'+'a'.repeat(64),source='videos/QaSaved_1';
 const api={project,request:async(url,o={})=>{calls.push({url,options:structuredClone(o)});
 if(url===root+':beginTransaction'){assert.deepEqual(o.json,{options:{readWrite:{}}});return {transaction:'synthetic-transaction'};}
 if(url===root+':batchGet'){assert.equal(o.json.transaction,'synthetic-transaction');assert.deepEqual(o.json.mask,{fieldPaths:['id']});return o.json.documents.map(name=>name===prefix+source?{found:{name,updateTime:stale?'changed':'source-v1'}}:{missing:name});}
 if(url===root+':commit'){assert.equal(o.json.transaction,'synthetic-transaction');for(const w of o.json.writes){assert.deepEqual(Object.keys(w).sort(),['currentDocument','update']);assert.ok(w.update.name.startsWith(prefix+'reels_index/semantic_'));assert.equal(w.verify,undefined);}if(ackLost)throw Error('acknowledgement lost');return {writeResults:[{updateTime:'written-v2'}]};}
 if(url===root+':rollback')return {};
 if(url===root+'/'+path)return {name:prefix+path,fields:encodeFields(readbackMatch?data:{...data,status:'uncertain'}),updateTime:'written-v2'};
 throw Error('Unexpected synthetic endpoint '+url);
 }};
 const store=new Firestore(api);store.metadataWrite=(url,o)=>api.request(url,o);
 return {calls,store,input:{checks:[{path:source,updateTime:'source-v1'},{path,updateTime:null}],writes:[{path,data}]}};
}
test('semantic transaction reads exact versions in a transaction and writes only derivative full replacements',async()=>{
 const x=transport();assert.equal((await x.store.commitSemantic(x.input)).applied,true);assert.equal(x.calls.filter(c=>c.url.endsWith(':commit')).length,1);assert.equal(x.calls.some(c=>c.options.json?.writes?.some(w=>w.update?.name.includes('/videos/'))),false);
});
test('stale source rolls back before commit and disallowed source write never starts a transaction',async()=>{
 const x=transport({stale:true});assert.equal((await x.store.commitSemantic(x.input)).applied,false);assert.equal(x.calls.some(c=>c.url.endsWith(':commit')),false);assert.equal(x.calls.at(-1).url,root+':rollback');
 const y=transport();y.input.writes[0].path='videos/QaSaved_1';await assert.rejects(()=>y.store.commitSemantic(y.input));assert.equal(y.calls.length,0);
});
test('ambiguous commit reads back once and never blindly retries or invents a successful acknowledgement',async()=>{
 const x=transport({ackLost:true});assert.equal((await x.store.commitSemantic(x.input)).reconciled,true);assert.equal(x.calls.filter(c=>c.url.endsWith(':commit')).length,1);
 const y=transport({ackLost:true,readbackMatch:false});await assert.rejects(()=>y.store.commitSemantic(y.input),e=>e.requiresReconciliation===true);assert.equal(y.calls.filter(c=>c.url.endsWith(':commit')).length,1);
});
