import {createServer} from 'node:http';
import {build} from 'esbuild';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {reelsFixture,memoryReelsStore} from './reels-fixture.mjs';
import {videoBytes} from './video-base64.mjs';

// Same isolated esbuild/HTTP pattern as server.mjs; the legacy harness is retained.
// This mounts the real Workspace and operational API, injecting only the database.
export async function startReelsFixtureServer() {
 const root=fileURLToPath(new URL('.',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'megabrain-reels-qa-'));
 const fixture=reelsFixture(),store=memoryReelsStore(fixture.documents),repository=new ReelsRepository({store,cacheTtlMs:0}),calls=[],holds=new Set(),failures=new Map(),staleResponses=new Set(),externalAttempts=[];
 let server,origin;const externalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{externalAttempts.push('external fetch attempted');throw Error('External fetch forbidden in Reels browser QA');};
 const api=reelsAPI({repository,processingEnabled:false,authorize:async request=>request.headers.get('cookie')?.includes('qa_session=local')===true,sameOrigin:async request=>request.headers.get('origin')===origin});
 async function cleanup(){for(const hold of holds)hold.release();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}globalThis.fetch=externalFetch;const target=resolve(temp);if(dirname(target)!==resolve(tmpdir())||!target.includes('megabrain-reels-qa-'))throw Error('Cleanup outside QA directory');await rm(target,{recursive:true,force:true});}
 try {
  const entry=join(temp,'entry.jsx');await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from ${JSON.stringify(resolve(root,'../web-google/app/reels/workspace.jsx'))};createRoot(document.getElementById('root')).render(<Workspace/>);`);
  await build({entryPoints:[entry],outfile:join(temp,'app.js'),bundle:true,platform:'browser',jsx:'automatic',nodePaths:[join(root,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const bundle=await readFile(join(temp,'app.js')),css=await readFile(resolve(root,'../web-google/app/globals.css'));
  server=createServer(async(req,res)=>{
   try {
    const url=new URL(req.url,origin),path=url.pathname,call={path,query:url.search,method:req.method,status:null};calls.push(call);
    const send=(type,data,status=200)=>{call.status=status;res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);};
    if(req.method==='GET'&&path==='/')return send('text/html','<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>MEGABRAIN - Reels QA</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    if(path==='/app.js')return send('text/javascript',bundle);
    if(path==='/style.css')return send('text/css',css);
    if(path==='/favicon.ico')return send('image/x-icon','',204);
    const held=[...holds].find(h=>!h.started&&h.match(url));if(held){held.started=true;held.notify();await held.wait;holds.delete(held);}
    const failure=failures.get(path);if(failure){failures.delete(path);return send('application/json',JSON.stringify({error:failure.message,code:'QA_UNAVAILABLE'}),failure.status);}
    if(path.startsWith('/api/reels/')){
     let body='';for await(const chunk of req)body+=chunk;call.body=body?JSON.parse(body):null;
     const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})});
     const response=await api(request);call.status=response.status;call.result=await response.json();
     if(staleResponses.delete(path))call.result.cache={...(call.result.cache??{}),stale:true};
     res.writeHead(response.status,Object.fromEntries(response.headers));res.end(JSON.stringify(call.result));return;
    }
    if(path.startsWith('/api/video/')||path.startsWith('/api/media/')){
     if(!req.headers.cookie?.includes('qa_session=local'))return send('application/json',JSON.stringify({error:'Não autorizado.'}),401);
     const id=decodeURIComponent(path.split('/').at(-1));if(!(await repository.detail(id))?.media.available)return send('application/json',JSON.stringify({error:'Mídia indisponível.'}),404);
     if(path.startsWith('/api/video/'))return send('application/json',JSON.stringify({url:'/api/media/'+id,expires_at:new Date(Date.now()+60000).toISOString()}));
     return send('video/webm',videoBytes);
    }
    return send('application/json',JSON.stringify({error:'QA route absent'}),404);
   }catch(error){if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  return {origin,calls,store,repository,fixture,externalAttempts,close:cleanup,
   failNext(path,message='Leitura sintética indisponível.',status=503){failures.set(path,{message,status});},
   staleNext(path){staleResponses.add(path);},
   holdNext(match){let release,notify;const wait=new Promise(r=>{release=r;}),started=new Promise(r=>{notify=r;});const hold={match,release,notify,wait,started:false};holds.add(hold);return {started,release};},
   async appendEvent(){const id='99999999999999999999_qa';await store.create('reels_events/'+id,{id,at:new Date().toISOString(),reelId:'QaPub_tech',stage:'analysis',worker:'qa-worker',level:'info',type:'qa_new',message:'Evento incremental após pausa.'});return id;}
  };
 }catch(error){await cleanup();throw error;}
}
