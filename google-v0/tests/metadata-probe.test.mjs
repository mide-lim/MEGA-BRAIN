import test from 'node:test';import assert from 'node:assert/strict';
import {metadataProbeHandler} from '../lib/metadata-probe.mjs';
import {mediaTools} from '../lib/media-tools.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
const videoId='C2hoehMOYqk',jobId='job_'+'a'.repeat(64),batchId='batch_test',video={id:videoId,status:'needs_attention',source_url:'https://www.instagram.com/reel/'+videoId+'/'};
const request=body=>new Request('https://worker.invalid/tasks/diagnose',{method:'POST',body:JSON.stringify(body??{videoId,jobId})});
function fixture(){
 const docs={'settings/financial':{paused:true,batch:{id:batchId,status:'paused',video_ids:[videoId]},jobs:{[jobId]:{status:'uncertain',stage:'upload',video_id:videoId,batch_id:batchId}}},'settings/automation':{enabled:false},['videos/'+videoId]:video,['jobs/'+jobId]:{status:'uncertain',stage:'upload',video_id:videoId}};
 const writes=[];let calls=0;
 const store={get:async p=>docs[p]?{data:structuredClone(docs[p]),updateTime:'v1'}:null,create:async(p,d)=>{if(docs[p])return {created:false};docs[p]=structuredClone(d);writes.push(p);return {created:true,updateTime:'v1'};},patch:async(p,d,o)=>{assert.equal(o.updateTime,'v1');assert.ok(p.startsWith('jobs/probe_'));docs[p]={...docs[p],...structuredClone(d)};writes.push(p);}};
 const config={store,batchId,eligibleVideos:[videoId],authorize:async()=>true,tools:{probeMetadata:async()=>{calls++;return {status:'metadata_failed',diagnostic:{cause:'http_403',stderr:'SECRET',message:'SECRET',command:'SECRET'}};}}};
 return {docs,writes,config,calls:()=>calls};
}
test('authenticated paused probe claims once concurrently, persists safe result and leaves financial/video/original job unchanged',async()=>{
 const f=fixture(),before=structuredClone(f.docs),h=metadataProbeHandler(f.config);
 const responses=await Promise.all([h(request()),h(request())]);assert.deepEqual((await Promise.all(responses.map(r=>r.json()))).map(r=>r.status).sort(),['already_claimed','metadata_failed']);assert.equal(f.calls(),1);
 for(const [p,d]of Object.entries(before))assert.deepEqual(f.docs[p],d);
 assert.equal(f.docs['jobs/probe_'+jobId].diagnostic.cause,'http_403');assert.ok(!JSON.stringify(f.docs).includes('SECRET'));
});
test('denied, malformed, active, foreign and non-upload requests never contact source',async()=>{
 for(const change of [f=>f.config.authorize=async()=>false,f=>f.config.batchId=null,f=>f.config.eligibleVideos=[],f=>f.docs['settings/financial'].paused=false,f=>f.docs['settings/automation'].enabled=true,f=>f.docs['settings/financial'].batch.status='active',f=>f.docs['settings/financial'].jobs[jobId].status='completed',f=>f.docs['settings/financial'].jobs[jobId].stage='analysis',f=>f.docs['jobs/'+jobId].status='completed',f=>f.docs['videos/'+videoId]={...video,id:'different'}]){
  const f=fixture();change(f);assert.ok((await metadataProbeHandler(f.config)(request())).status>=400);assert.equal(f.calls(),0);assert.equal(f.writes.length,0);
 }
 for(const body of [null,{},[],{videoId,jobId,url:'https://evil.invalid'},{videoId,jobId:'bad'}]){const f=fixture();assert.equal((await metadataProbeHandler(f.config)(new Request('https://worker.invalid/tasks/diagnose',{method:'POST',body:JSON.stringify(body)}))).status,400);assert.equal(f.calls(),0);}
});
test('crash or result-write failure preserves the claim and cannot repeat external request',async()=>{
 for(const location of ['tool','write']){
 const f=fixture();if(location==='tool')f.config.tools.probeMetadata=async()=>{throw Error('SECRET');};else f.config.store.patch=async()=>{throw Error('SECRET');};
 const h=metadataProbeHandler(f.config),r=await h(request());assert.equal(r.status,500);assert.ok(!(await r.text()).includes('SECRET'));assert.equal((await (await h(request())).json()).status,'already_claimed');assert.equal(f.docs['jobs/probe_'+jobId].status,'started');
 }
});
test('resuming between initial check and claim prevents metadata request',async()=>{
 const f=fixture(),create=f.config.store.create;f.config.store.create=async(...args)=>{const r=await create(...args);f.docs['settings/automation'].enabled=true;return r;};
 assert.equal((await metadataProbeHandler(f.config)(request())).status,409);assert.equal(f.calls(),0);
});
test('metadata tool uses bounded skip-download, same format and zero retries; retains no returned private metadata',async()=>{
 const calls=[];const tools=mediaTools({run:async(tool,args,options)=>{calls.push({tool,args,options});if(args.includes('--dump-single-json'))return {stdout:JSON.stringify({display_id:videoId,url:'SECRET',description:'SECRET'})};return {stdout:tool==='yt-dlp'?'2026.10.01\n':'ffmpeg version 5.1.9'};}});
 const r=await tools.probeMetadata(video);assert.equal(r.status,'metadata_available');assert.equal(calls.length,3);assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(r.diagnostic.yt_dlp_version,'2026.10.01');
 const c=calls[0];assert.ok(c.args.includes('--skip-download'));assert.equal(c.args[c.args.indexOf('-f')+1],'bestvideo+bestaudio/best[acodec!=none]');assert.equal(c.options.timeout,20000);assert.equal(c.options.maxBuffer,1048576);assert.ok(!c.args.includes('-o'));for(const flag of ['--retries','--fragment-retries','--extractor-retries'])assert.equal(c.args[c.args.indexOf(flag)+1],'0');
});
test('metadata failure reports bounded cause, never raw output; versions may fail',async()=>{
 let attempts=0;const tools=mediaTools({run:async(_t,args)=>{if(args.includes('--dump-single-json')){attempts++;throw Object.assign(Error('SECRET'),{code:1,stderr:'HTTP Error 403 SECRET',stdout:'SECRET'});}throw Error('SECRET');}});
 const r=await tools.probeMetadata(video);assert.equal(attempts,1);assert.equal(r.status,'metadata_failed');assert.equal(r.diagnostic.cause,'http_403');assert.equal(r.diagnostic.yt_dlp_version,null);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('invalid source and mismatched metadata do not produce false availability',async()=>{
 let calls=0;const tools=mediaTools({run:async()=>{calls++;return {stdout:JSON.stringify({id:'other',url:'SECRET'})};}});
 assert.equal((await tools.probeMetadata({...video,source_url:'https://evil.invalid/'})).status,'metadata_failed');assert.equal(calls,0);
 assert.equal((await tools.probeMetadata(video)).status,'metadata_failed');
});
test('HTTP adapter preserves diagnostic route and authorization; rejects other routes',async()=>{
 const server=workerHTTP(async r=>Response.json({path:new URL(r.url).pathname,auth:r.headers.get('authorization')}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const origin='http://127.0.0.1:'+server.address().port;const r=await fetch(origin+'/tasks/diagnose',{method:'POST',body:'{}',headers:{authorization:'Bearer fixture'}});assert.deepEqual(await r.json(),{path:'/tasks/diagnose',auth:'Bearer fixture'});assert.equal((await fetch(origin+'/unknown',{method:'POST'})).status,404);}finally{await new Promise(resolve=>server.close(resolve));}
});
