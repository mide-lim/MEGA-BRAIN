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
import {reelsWebRuntime} from '../lib/reels-web-runtime.mjs';
import {ReelsCommandRunner} from '../lib/reels-command-runner.mjs';
import {executionId} from '../lib/reels-pipeline.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';

// Same isolated esbuild/HTTP pattern as server.mjs; the legacy harness is retained.
// This mounts the real Workspace and operational API, injecting only the database.
export async function startReelsFixtureServer({operational=false}={}) {
 const root=fileURLToPath(new URL('.',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'megabrain-reels-qa-'));
 const fixture=reelsFixture(),store=memoryReelsStore(fixture.documents),repository=new ReelsRepository({store,cacheTtlMs:0}),calls=[],holds=new Set(),failures=new Map(),staleResponses=new Map(),externalAttempts=[];
 const catalogueRuntime=new ReelsCatalogueRuntime({repository});
 async function seedSavedContributions(ids,options={}){const outcomes=[];for(const id of ids)outcomes.push(await catalogueRuntime.project(id,{type:'baselinePublicationRegistered',...(options[id]||options)}));return outcomes;}
 let server,origin;const externalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{externalAttempts.push('external fetch attempted');throw Error('External fetch forbidden in Reels browser QA');};
 // Explicit synthetic mode for browser journeys. No Cloud Tasks client, ADC,
 // provider adapter or task executor is installed; delivery stays in this Map.
 const project='megabrain-v0-1017370021431',tasks=new Map(),stageRoutes=Object.fromEntries(['acquisition','transcription','analysis'].map(stage=>[stage==='acquisition'?'upload':stage,{queue:'v0-'+stage,workerOrigin:`https://megabrain-v0-${stage}-711042421394.us-central1.run.app`}]));
 const taskAPI={project,request:async(url,options={})=>{if(!url.startsWith('https://cloudtasks.googleapis.com/v2/'))throw Error('Unexpected synthetic API');if(options.method==='POST'){const task=options.json.task;if(tasks.has(task.name))throw Object.assign(Error('exists'),{status:409});tasks.set(task.name,structuredClone(task));return task;}const name=url.split('/v2/')[1].split('?')[0],task=tasks.get(name);if(!task)throw Object.assign(Error('missing'),{status:404});return task;}};
 const runtime=operational?reelsWebRuntime({repository,api:taskAPI,config:{project,reels_runtime_version:'v2',reels_processing_enabled:true,stage_routes:stageRoutes}}):null;
 if(operational){
  const id='QaRecover',operationId='qa-reconciliation-operation',jobId=executionId(operationId,id,'transcription'),owner='qa-reconciliation-owner',operationName=`projects/${project}/locations/us/operations/qa-saved-operation`;
  await store.create('videos/'+id,{id,title:'Operação salva para conferir',status:'uncertain',stage:'transcription',created_at:fixture.at,reels_v2:{status:'uncertain',stage:'transcription',operationId,executionId:jobId,error:{uncertain:true,retryable:false}}});
  await store.create('reels_executions/'+jobId,{id:jobId,reelId:id,operationId,stage:'transcription',status:'uncertain',owner,operationName,operationEvidence:{schemaVersion:1,executionId:jobId,reelId:id,operationId,stage:'transcription',owner,operationName},createdAt:fixture.at});
 }
 const api=reelsAPI({repository,...(runtime?{service:runtime.service,reconciliation:runtime.reconciliation}:{}),processingEnabled:operational,authorize:async request=>request.headers.get('cookie')?.includes('qa_session=local')===true,sameOrigin:async request=>request.headers.get('origin')===origin});
 async function cleanup(){for(const hold of holds)hold.release();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}globalThis.fetch=externalFetch;const target=resolve(temp);if(dirname(target)!==resolve(tmpdir())||!target.includes('megabrain-reels-qa-'))throw Error('Cleanup outside QA directory');await rm(target,{recursive:true,force:true});}
 try {
  // Explicit fixture bootstrap through the same metadata-only runtime used by
  // publication events. GET requests never create contributions.
  await store.create('settings/reels_v2_contextual_catalogue',{schemaVersion:1,status:'active',policyVersion:'saved-publication-catalogue-v1',operationId:'0'.repeat(64),sourceObservationSHA256:'0'.repeat(64),sourceHash:'0'.repeat(64),inventoryIds:['QaPub_tech','QaPub_food'],inventoryCount:2,evaluatedCount:2,observedAt:fixture.at,activatedBy:'synthetic_fixture_bootstrap',incremental:{enabled:true,eventDriven:true,noProviders:true}});
  await seedSavedContributions(['QaPub_tech','QaPub_food']);
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
     if(staleResponses.has(path)){const fixture=staleResponses.get(path),sourceAsOf=fixture.sourceAsOf;if(--fixture.remaining<=0)staleResponses.delete(path);call.result.cache={...(call.result.cache??{}),stale:true};if(sourceAsOf){call.result.sourceStale=true;call.result.dataAsOf=sourceAsOf;}}
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
  return {origin,calls,store,repository,catalogueRuntime,seedSavedContributions,fixture,externalAttempts,tasks,close:cleanup,
   async pumpControls(){if(!runtime)throw Error('Synthetic operational mode required');const runner=new ReelsCommandRunner({service:runtime.service,dispatcher:runtime.dispatcher,pageSize:25,enabled:true});let count=0;for(const [name,task]of [...tasks]){if(!task.httpRequest.url.endsWith('/tasks/control'))continue;const body=JSON.parse(Buffer.from(task.httpRequest.body,'base64').toString());await runtime.dispatcher.acknowledge({...body,stage:'acquisition'});await runner.run(body);tasks.delete(name);count++;}return count;},
   failNext(path,message='Leitura sintética indisponível.',status=503){failures.set(path,{message,status});},
   // Optional source timestamp is a synthetic presentation fixture only.
   staleNext(path,sourceAsOf=null,count=1){staleResponses.set(path,{sourceAsOf,remaining:count});},
   holdNext(match){let release,notify;const wait=new Promise(r=>{release=r;}),started=new Promise(r=>{notify=r;});const hold={match,release,notify,wait,started:false};holds.add(hold);return {started,release};},
   async appendEvent(){const id='99999999999999999999_qa';await store.create('reels_events/'+id,{id,at:new Date().toISOString(),reelId:'QaPub_tech',stage:'analysis',worker:'qa-worker',level:'info',type:'qa_new',message:'Evento incremental após pausa.'});return id;}
  };
 }catch(error){await cleanup();throw error;}
}
