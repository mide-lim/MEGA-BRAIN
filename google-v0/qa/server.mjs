import {createServer} from 'node:http';
import {build} from 'esbuild';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {video,automation,financial} from './fixture.mjs';import {videoBytes} from './video-base64.mjs';
export async function startFixtureServer(){
 const root=fileURLToPath(new URL('.',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'megabrain-frontend-qa-'));
 let server,libraryVideos=[video],failureOffset=null;
 try{
 const entry=join(temp,'entry.jsx');await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import Library from ${JSON.stringify(resolve(root,'../web-google/app/library.jsx'))};createRoot(document.getElementById('root')).render(<Library/>);`);
 await build({entryPoints:[entry],outfile:join(temp,'app.js'),bundle:true,platform:'browser',jsx:'automatic',nodePaths:[join(root,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const bundle=await readFile(join(temp,'app.js')),css=await readFile(resolve(root,'../web-google/app/globals.css'));const calls=[];
 server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;calls.push({path,method:req.method});
  const send=(type,data,status=200)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);};
  if(req.method!=='GET')return send('application/json',JSON.stringify({error:'Read-only fixture'}),405);
  if(path==='/')return send('text/html','<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  if(path==='/app.js')return send('text/javascript',bundle);
  if(path==='/style.css')return send('text/css',css);
  if(path==='/api/library'){const offset=Number(new URL(req.url,'http://localhost').searchParams.get('cursor')??0);if(offset===failureOffset)return send('application/json',JSON.stringify({error:'Synthetic later-page failure'}),503);return send('application/json',JSON.stringify({videos:libraryVideos.slice(offset,offset+40),next_cursor:offset+40<libraryVideos.length?String(offset+40):null}));}
  if(path==='/api/controls')return send('application/json',JSON.stringify({automation}));
  if(path==='/api/financial')return send('application/json',JSON.stringify(financial));
  if(path==='/api/video/'+video.id)return send('application/json',JSON.stringify({url:'/api/media/'+video.id,expires_at:new Date(Date.now()+60000).toISOString()}));
  if(path==='/api/media/'+video.id)return send('video/webm',videoBytes);
  return send('application/json',JSON.stringify({error:'Fixture endpoint absent'}),404);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {origin:'http://127.0.0.1:'+server.address().port,calls,setLibraryVideos:rows=>{libraryVideos=rows;},setLibraryFailure:offset=>{failureOffset=offset;},close:async()=>{await new Promise(resolve=>server.close(resolve));const target=resolve(temp);if(dirname(target)!==resolve(tmpdir())||!target.includes('megabrain-frontend-qa-'))throw Error('Cleanup outside QA directory');await rm(target,{recursive:true,force:true});}};
 }catch(error){server?.close();await rm(temp,{recursive:true,force:true});throw error;}
}
