import {createHash}from 'node:crypto';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {video,automation,financial} from './fixture.mjs';import {videoBytes} from './video-base64.mjs';
export async function startFixtureServer(){
 const root=fileURLToPath(new URL('.',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'megabrain-frontend-qa-'));
 let server,libraryVideos=[video],failureOffset=null,heldLibrary=null,playbackReady=true,progressOverride=null;
 try{
 const entry=join(temp,'entry.jsx');await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import Library from ${JSON.stringify(resolve(root,'../web-google/app/library.jsx'))};createRoot(document.getElementById('root')).render(<Library/>);`);
 await build({entryPoints:[entry],outfile:join(temp,'app.js'),bundle:true,platform:'browser',jsx:'automatic',nodePaths:[join(root,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const bundle=await readFile(join(temp,'app.js')),css=await readFile(resolve(root,'../web-google/app/globals.css'));const calls=[];
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;calls.push({path,query:new URL(req.url,'http://localhost').search,method:req.method});
  const send=(type,data,status=200)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);};
  if(req.method==='POST'&&path==='/api/import'){
   let body='';for await(const chunk of req)body+=chunk;const links=JSON.parse(body).links.split(/\s+/).filter(Boolean);let created=0;
   for(const link of links){const id=new URL(link).pathname.split('/').filter(Boolean).at(-1);if(!libraryVideos.some(v=>v.id===id)){libraryVideos.push({id,source_url:link,status:'pending',media_verified:false,analysis:null,transcript:''});created++;}}
   return send('application/json',JSON.stringify({created,already_present:links.length-created,automatic_processing_started:false}));
  }
  if(req.method!=='GET')return send('application/json',JSON.stringify({error:'Read-only fixture'}),405);
  if(path==='/')return send('text/html','<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  if(path==='/app.js')return send('text/javascript',bundle);
  if(path==='/style.css')return send('text/css',css);
  if(path==='/api/library'){const ids=new URL(req.url,'http://localhost').searchParams.get('ids');if(ids)return send('application/json',JSON.stringify({videos:libraryVideos.filter(v=>ids.split(',').includes(v.id))}));const offset=Number(new URL(req.url,'http://localhost').searchParams.get('cursor')??0);const snapshot={videos:libraryVideos.slice(offset,offset+40),next_cursor:offset+40<libraryVideos.length?String(offset+40):null};if(heldLibrary&&offset===0){const hold=heldLibrary;heldLibrary=null;hold.started();await hold.wait;}if(offset===failureOffset)return send('application/json',JSON.stringify({error:'Synthetic later-page failure'}),503);return send('application/json',JSON.stringify(snapshot));}
  if(path==='/api/controls')return send('application/json',JSON.stringify({automation}));
  if(path==='/api/financial')return send('application/json',JSON.stringify({...financial,progress:{items:progressOverride??libraryVideos.filter(v=>v.status!=='pending').map(v=>({id:v.id,stage:v.status==='pending'?'upload':v.status==='downloaded'?'transcription':'analysis',status:v.status==='pending'?'reserved':v.status==='analyzed'?'completed':v.status==='needs_attention'?'uncertain':'started',version:createHash('sha256').update(JSON.stringify(v)).digest('hex')}))}}));
  if(path.startsWith('/api/video/')&&libraryVideos.some(v=>v.id===path.split('/').at(-1))){if(!playbackReady)return send('application/json',JSON.stringify({error:'Reprodução ainda não liberada'}),403);const id=path.split('/').at(-1);return send('application/json',JSON.stringify({url:'/api/media/'+id,expires_at:new Date(Date.now()+60000).toISOString()}));}
  if(path.startsWith('/api/media/')&&libraryVideos.some(v=>v.id===path.split('/').at(-1)))return send('video/webm',videoBytes);
  return send('application/json',JSON.stringify({error:'Fixture endpoint absent'}),404);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {origin:'http://127.0.0.1:'+server.address().port,calls,setProgress:items=>{progressOverride=items;},setPlaybackReady:value=>{playbackReady=value;},setLibraryVideos:rows=>{libraryVideos=rows;},setLibraryFailure:offset=>{failureOffset=offset;},holdNextLibrary(){let release,started;const wait=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});heldLibrary={wait,started};return {release,started:began};},close:async()=>{await new Promise(resolve=>server.close(resolve));const target=resolve(temp);if(dirname(target)!==resolve(tmpdir())||!target.includes('megabrain-frontend-qa-'))throw Error('Cleanup outside QA directory');await rm(target,{recursive:true,force:true});}};
 }catch(error){server?.close();await rm(temp,{recursive:true,force:true});throw error;}
}
