import test from 'node:test';import assert from 'node:assert/strict';
import {boundedMedia,mediaRange}from '../lib/bounded-media.mjs';
import {categoryList,categoryMatches}from '../lib/category-display.mjs';
test('range reads are capped and invalid/multiple ranges rejected',()=>{
 assert.deepEqual(mediaRange('bytes=0-',5000000),{start:0,end:2097151,bytes:2097152});
 assert.deepEqual(mediaRange('bytes=-10',100),{start:90,end:99,bytes:10});
 for(const value of ['bytes=100-200','bytes=0-1,3-4','bytes=5-1','bytes=-0'])assert.throws(()=>mediaRange(value,100));
});
const id='C2S6yZjgJyr',now=Date.now();
function fixture(overrides={}){
 let reads=0;const data={schema_version:1,enabled:true,allowed_ids:[id],expires_at:new Date(now+10000).toISOString(),maximum_bytes:100,used_bytes:0,requests:0,financial_execution_id:'media_pilot_delivery',...overrides};
 const store={get:async path=>({updateTime:'v1',data:path==='settings/media_delivery'?data:{reserved_cents:420,coverage_verified:true,credit_expires_at:new Date(now+1000000000).toISOString(),ongoing_costs_valid_until:new Date(now+10000).toISOString(),jobs:{media_pilot_delivery:{stage:'media_access',status:'started',maximum_cents:420}}}}),patch:async(path,changes)=>Object.assign(data,changes)};
 const repository={video:async()=>({media_verified:true,video_key:`originals/instagram/${id}/video.mp4`,video_generation:'123',video_bytes:100})};
 const api={project:'megabrain-v0-1017370021431',request:async()=>{reads++;assert.equal(data.used_bytes,100);return new Response(Buffer.alloc(100),{status:206,headers:{'Content-Range':'bytes 0-99/100'}});}};
 return {handler:boundedMedia({repository,store,api,authorize:async()=>true,enabled:true,clock:()=>now}),data,reads:()=>reads,store,repository,api};
}
test('authenticated bounded playback debits before reading and blocks exhausted allowance',async()=>{
 const f=fixture(),r=await f.handler.stream(new Request('https://app/api/media/'+id),id);assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,100);assert.equal(f.reads(),1);
 assert.equal((await f.handler.stream(new Request('https://app/api/media/'+id),id)).status,503);assert.equal(f.reads(),1);
});
test('anonymous, expired, unfunded and foreign video requests never read storage',async()=>{
 for(const o of [{enabled:false},{expires_at:new Date(now).toISOString()},{allowed_ids:[]},{requests:200}]){const f=fixture(o);assert.equal((await f.handler.stream(new Request('https://app'),id)).status,503);assert.equal(f.reads(),0);}
 const f=fixture();const h=boundedMedia({...f,authorize:async()=>false,enabled:true});assert.equal((await h.stream(new Request('https://app'),id)).status,401);assert.equal(f.reads(),0);
});
test('metadata/HEAD do not consume transfer and metadata exposes no Google bearer URL',async()=>{
 const f=fixture();const r=await f.handler.metadata(new Request('https://app'),id);assert.equal((await r.json()).url,'/api/media/'+id);
 assert.equal((await f.handler.stream(new Request('https://app',{method:'HEAD'}),id)).status,206);assert.equal(f.data.requests,0);assert.equal(f.reads(),0);
});
test('category display merges case, accents and curated language aliases without altering reports',()=>{
 const videos=[{analysis:{categories:['culinária','Receitas']}},{analysis:{categories:['Culinária','receitas','Productivity','Tools']}}];const copy=JSON.stringify(videos);
 assert.deepEqual(categoryList(videos),['Culinária','Ferramentas','Produtividade','Receitas']);assert.equal(categoryMatches(videos[0],'Culinária'),true);assert.equal(JSON.stringify(videos),copy);
});
