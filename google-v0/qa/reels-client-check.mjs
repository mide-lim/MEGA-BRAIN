// Client contract checks; no network or provider calls.
// node reels-client-check.mjs /absolute/checkout/google-v0/web-google/lib/reels-client.mjs
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {queryString,text,number,mergeEvents,request,workspaces}=await import(process.argv[2]?pathToFileURL(process.argv[2]):new URL('../web-google/lib/reels-client.mjs',import.meta.url));
assert.deepEqual(workspaces.map(([id])=>id),['all','queues','categories','library','attention','finance','activity']);
assert.equal(queryString({q:'ação & receita',status:'',cursor:null,missing:undefined,all:false,limit:0}),'q=a%C3%A7%C3%A3o+%26+receita&all=false&limit=0');
assert.equal(text(null),'Não informado');
assert.equal(text(false),'Não');
assert.equal(text(true),'Sim');
assert.equal(text({preservado:true,valor:null}),'preservado: Sim · valor: Não informado');
assert.equal(number(null),'—');
assert.equal(number(0),'0');
const a={id:'a',at:'2026-10-16T11:00:00Z',message:'old'},b={id:'b',at:'2026-10-16T12:00:00Z'};
const events=mergeEvents([a],[b,{...a,message:'updated'}]);
assert.deepEqual(events.map(x=>x.id),['b','a']);
assert.equal(events[1].message,'updated');
assert.equal(mergeEvents([],Array.from({length:1005},(_,i)=>({id:String(i),at:new Date(i*1000).toISOString()}))).length,1000);
const originalFetch=globalThis.fetch;
try {
 let captured;
 globalThis.fetch=async(url,options)=>{captured={url,options};return {ok:true,json:async()=>({created:1})};};
 assert.deepEqual(await request('/register',{method:'POST',body:{links:'https://www.instagram.com/reel/x/'}}),{created:1});
 assert.equal(captured.url,'/api/reels/register');
 assert.equal(captured.options.cache,'no-store');
 assert.equal(captured.options.credentials,'same-origin');
 assert.deepEqual(JSON.parse(captured.options.body),{links:'https://www.instagram.com/reel/x/'});
 assert.equal(captured.options.headers['X-Reels-Refresh'],undefined);
 await request('/categories',{refresh:'qa-explicit-refresh'});assert.equal(captured.options.headers['X-Reels-Refresh'],'qa-explicit-refresh');assert.equal(captured.options.refresh,undefined);
 await request('/items?workspace=library');assert.equal(captured.options.headers['X-Reels-Refresh'],undefined);
 globalThis.fetch=async()=>({ok:false,status:423,json:async()=>({error:'Processamento bloqueado',code:'PROCESSING_DISABLED',operationId:'op1'})});
 await assert.rejects(request('/commands'),e=>e.message==='Processamento bloqueado'&&e.code==='PROCESSING_DISABLED'&&e.operationId==='op1'&&e.status===423);
 globalThis.fetch=async()=>({json:async()=>{throw new Error('invalid JSON');}});
 await assert.rejects(request('/summary'),/A resposta do serviço não pôde ser lida/);
} finally {globalThis.fetch=originalFetch;}
console.log('Reels client checks passed: navigation, query, missing values, event merge, request contract and safe errors.');

