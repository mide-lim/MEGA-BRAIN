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
 assert.deepEqual(categoryList(videos),['Ferramentas','Produtividade','Receitas e preparo']);assert.equal(categoryMatches(videos[0],'Culinária'),true);assert.equal(JSON.stringify(videos),copy);
});

test('an explicitly funded expansion preserves prior usage and permits more than 200 requests',async()=>{
 const f=fixture({maximum_bytes:1073741824,maximum_requests:2000,used_bytes:382698648,requests:200});
 const get=f.store.get;f.store.get=async p=>{const s=await get(p);if(p==='settings/financial'){s.data.reserved_cents=1100;s.data.jobs.media_pilot_delivery.maximum_cents=1100;s.data.paused=true;}return s;};
 f.api.request=async()=>{assert.equal(f.data.used_bytes,382698748);assert.equal(f.data.requests,201);return new Response(Buffer.alloc(100),{status:206,headers:{'Content-Range':'bytes 0-99/100'}});};
 assert.equal((await f.handler.stream(new Request('https://app'),id)).status,206);
 assert.equal(f.data.used_bytes,382698748);assert.equal(f.data.requests,201);
});
test('larger transfer allowance requires its full proportional financial reservation',async()=>{
 for(const funding of [{maximum:420,reserved:420},{maximum:1075,reserved:1075},{maximum:1100,reserved:1099},{maximum:1101,reserved:1101},{maximum:1100.5,reserved:1101}]){
 const f=fixture({maximum_bytes:1073741824,maximum_requests:2000}),get=f.store.get;
 f.store.get=async p=>{const s=await get(p);if(p==='settings/financial'){s.data.reserved_cents=funding.reserved;s.data.jobs.media_pilot_delivery.maximum_cents=funding.maximum;}return s;};
 assert.equal((await f.handler.stream(new Request('https://app'),id)).status,503);assert.equal(f.reads(),0);assert.equal(f.data.requests,0);
 }
 const f=fixture({maximum_bytes:1073741824,maximum_requests:2000}),get=f.store.get;
 f.store.get=async p=>{const s=await get(p);if(p==='settings/financial'){s.data.reserved_cents=1076;s.data.jobs.media_pilot_delivery.maximum_cents=1076;}return s;};
 assert.equal((await f.handler.metadata(new Request('https://app'),id)).status,200);
});
test('invalid or exhausted limits and missing permission stay blocked before storage',async()=>{
 for(const p of [{maximum_requests:2001},{maximum_requests:0},{maximum_requests:1.5},{maximum_bytes:1073741825},{maximum_requests:2000,requests:2000},{maximum_requests:2000,used_bytes:100},{allowed_ids:[]}]){
 const f=fixture(p);assert.equal((await f.handler.stream(new Request('https://app'),id)).status,503);assert.equal(f.reads(),0);
 }
 for(const [p,expected] of [[{allowed_ids:[]},'Este vídeo ainda não foi liberado para reprodução.'],[{requests:200},'Franquia de requisições de reprodução esgotada.'],[{used_bytes:101},'Franquia de transferência de vídeo esgotada.']]){
 const f=fixture(p);assert.equal((await (await f.handler.metadata(new Request('https://app'),id)).json()).error,expected);
 }
});
test('concurrent requests cannot spend the same last bytes or request slot',async()=>{
 const f=fixture({maximum_requests:2000,requests:1999});let version=1;
 const get=f.store.get;f.store.get=async p=>{const s=await get(p);return {data:structuredClone(s.data),updateTime:String(version)};};
 f.store.patch=async(_p,changes,{updateTime})=>{if(updateTime!==String(version))throw Error('conflict');Object.assign(f.data,changes);version++;};
 const results=await Promise.all([f.handler.stream(new Request('https://app'),id),f.handler.stream(new Request('https://app'),id)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[206,503]);assert.equal(f.reads(),1);assert.equal(f.data.requests,2000);assert.equal(f.data.used_bytes,100);
});
