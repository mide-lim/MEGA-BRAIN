import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync}from 'node:fs';
import {boundedMedia,mediaRange}from '../lib/bounded-media.mjs';
import {categoryList,categoryMatches}from '../lib/category-display.mjs';
const id='C2S6yZjgJyr',now=Date.now();
const request=(range,method='GET')=>new Request('https://app/api/media/'+id,{method,headers:range?{Range:range}:{}});
function fixture({video={},authorized=true,response,storageError}={}){
 const calls=[],lookups=[];
 const repository={video:async key=>{lookups.push(key);return {media_verified:true,video_key:`originals/instagram/${id}/video.mp4`,video_generation:'123',video_bytes:100,...video};}};
 const api={project:'megabrain-v0-1017370021431',request:async(url,options)=>{calls.push({url,options});if(storageError)throw storageError;return response?.()??new Response(Buffer.alloc(100),{status:206,headers:{'Content-Range':'bytes 0-99/100'}});}};
 // Any accidental policy/finance access fails, including reads; playback cannot reserve.
 const store={get:async()=>assert.fail('Playback must not inspect processing/financial controls'),patch:async()=>assert.fail('Playback must not mutate controls or reserves')};
 const handler=boundedMedia({repository,store,api,authorize:async()=>authorized,clock:()=>now});
 return {handler,calls,lookups,repository,store,api};
}
test('range reads are capped and invalid/multiple ranges rejected',()=>{
 assert.deepEqual(mediaRange('bytes=0-',5000000),{start:0,end:2097151,bytes:2097152});
 assert.deepEqual(mediaRange('bytes=-10',100),{start:90,end:99,bytes:10});
 for(const value of ['bytes=100-200','bytes=0-1,3-4','bytes=5-1','bytes=-0','items=0-2','bytes=9007199254740992-'])assert.throws(()=>mediaRange(value,100));
 for(const size of [0,100000001,1.5,NaN])assert.throws(()=>mediaRange(null,size));
});
test('owner can repeatedly play the persisted generation without pilot/financial state',async()=>{
 const f=fixture();for(let i=0;i<3;i++){const r=await f.handler.stream(request(),id);assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,100);}
 assert.equal(f.calls.length,3);for(const call of f.calls){const u=new URL(call.url);assert.equal(u.hostname,'storage.googleapis.com');assert.equal(u.searchParams.get('generation'),'123');assert.equal(u.searchParams.get('alt'),'media');assert.equal(decodeURIComponent(u.pathname.split('/o/')[1]),`originals/instagram/${id}/video.mp4`);assert.equal(call.options.headers.Range,'bytes=0-99');}
});
test('expired credit, paused processing, closed or exhausted old delivery policy never gate archive playback',async()=>{
 for(const oldState of [{paused:true},{credit_expires_at:'2000-01-01',ongoing_costs_valid_until:'2000-01-01'},{enabled:false,allowed_ids:[],expires_at:'2000-01-01',requests:2000,maximum_requests:2000,used_bytes:1073741824,maximum_bytes:1073741824},{jobs:{legacy:{status:'uncertain'}}}]){
 const f=fixture();f.store.get=async()=>assert.fail('Old state must be irrelevant: '+JSON.stringify(oldState));
 assert.equal((await f.handler.metadata(request(),id)).status,200);assert.equal((await f.handler.stream(request(),id)).status,206);
 }
});
test('anonymous metadata and stream never inspect repository or storage',async()=>{
 const f=fixture({authorized:false});assert.equal((await f.handler.metadata(request(),id)).status,401);assert.equal((await f.handler.stream(request(),id)).status,401);assert.equal(f.calls.length,0);assert.equal(f.lookups.length,0);
});
test('authorization is checked again on every stream request after metadata',async()=>{
 let authorized=true;const f=fixture(),h=boundedMedia({...f,authorize:async()=>authorized});assert.equal((await h.metadata(request(),id)).status,200);authorized=false;assert.equal((await h.stream(request(),id)).status,401);assert.equal(f.calls.length,0);
});
test('metadata/HEAD expose only an authenticated route and never read media',async()=>{
 const f=fixture(),r=await f.handler.metadata(request(),id),body=await r.json();assert.equal(body.url,'/api/media/'+id);assert.equal(Date.parse(body.expires_at),now+300000);assert.equal(r.headers.get('cache-control'),'no-store');
 const h=await f.handler.stream(request(undefined,'HEAD'),id);assert.equal(h.status,206);assert.equal(h.headers.get('content-length'),'100');assert.equal(h.body,null);assert.equal(f.calls.length,0);
});
test('invalid and traversal IDs fail before repository access',async()=>{
 for(const key of ['../settings/financial','abc','x'.repeat(33),'abcde%2f..',null,{}]){const f=fixture();assert.equal((await f.handler.metadata(request(),key)).status,404);assert.equal((await f.handler.stream(request(),key)).status,404);assert.equal(f.lookups.length,0);assert.equal(f.calls.length,0);}
});
test('missing, foreign, unverified and oversized media never reach storage',async()=>{
 for(const video of [{media_verified:false},{media_verified:'false'},{video_generation:123},{video_key:'originals/instagram/foreign/video.mp4'},{video_key:'../video.mp4'},{video_generation:'1&alt=media'},{video_generation:''},{video_bytes:0},{video_bytes:100000001},{video_bytes:100.5}]){const f=fixture({video});assert.equal((await f.handler.stream(request(),id)).status,404);assert.equal(f.calls.length,0);}
 const f=fixture();f.repository.video=async()=>null;assert.equal((await f.handler.metadata(request(),id)).status,404);
});
test('invalid ranges and methods do not read storage',async()=>{
 const f=fixture();const r=await f.handler.stream(request('bytes=100-'),id);assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */100');assert.equal((await f.handler.stream(request(undefined,'POST'),id)).status,405);assert.equal(f.calls.length,0);
});
test('2MiB request cap is enforced at Google boundary',async()=>{
 const size=5000000,bytes=2097152;const f=fixture({video:{video_bytes:size},response:()=>new Response(Buffer.alloc(bytes),{status:206,headers:{'Content-Range':`bytes 0-${bytes-1}/${size}`}})});
 const r=await f.handler.stream(request('bytes=0-'),id);assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,bytes);assert.equal(f.calls[0].options.headers.Range,`bytes=0-${bytes-1}`);
});
test('provider full bodies, wrong generation-size ranges and invalid lengths are never forwarded',async()=>{
 for(const [status,contentRange,length,bodyBytes] of [[200,'bytes 0-99/100',100,100],[206,'bytes 0-99/101',100,100],[206,'bytes 0-99/100',101,101],[206,'bytes 0-99/100',null,101],[206,'bytes 0-99/100',null,99]]){
 const f=fixture({response:()=>new Response(Buffer.alloc(bodyBytes),{status,headers:{'Content-Range':contentRange,...(length===null?{}:{'Content-Length':String(length)})}})});const r=await f.handler.stream(request(),id);assert.equal(r.status,503);assert.ok((await r.json()).error.includes('carregar novamente'));
 }
});
test('missing file and storage access failure have distinct safe errors without paid retry',async()=>{
 for(const [status,expected] of [[404,404],[403,503],[429,503]]){const f=fixture({storageError:Object.assign(Error('private diagnostic'),{status})});const r=await f.handler.stream(request(),id);assert.equal(r.status,expected);const text=await r.text();assert.ok(!text.includes('private diagnostic'));assert.ok(!text.includes('reserva'));assert.equal(f.calls.length,1);}
});
test('production wiring cannot reinstate the obsolete pilot flag and UI offers manual reload',()=>{
 const server=readFileSync(new URL('../web-google/lib/server.mjs',import.meta.url),'utf8'),preview=readFileSync(new URL('../web-google/app/video-preview.jsx',import.meta.url),'utf8');assert.ok(server.includes('boundedMedia({repository,api,authorize:authenticated})'));assert.ok(!server.includes('media_access_enabled'));assert.ok(preview.includes('Tentar carregar vídeo novamente'));assert.ok(!preview.includes('Confira a autorização'));const streamRoute=readFileSync(new URL('../web-google/app/api/media/[id]/route.js',import.meta.url),'utf8');assert.ok(streamRoute.indexOf('await authenticated()')<streamRoute.indexOf('return await mediaStreamRoute()'));assert.ok(streamRoute.includes('export const HEAD=GET'));
});
test('category display merges case, accents and curated language aliases without altering reports',()=>{
 const videos=[{analysis:{categories:['culinária','Receitas']}},{analysis:{categories:['Culinária','receitas','Productivity','Tools']}}];const copy=JSON.stringify(videos);assert.deepEqual(categoryList(videos),['Ferramentas','Produtividade','Receitas e preparo']);assert.equal(categoryMatches(videos[0],'Culinária'),true);assert.equal(JSON.stringify(videos),copy);
});
