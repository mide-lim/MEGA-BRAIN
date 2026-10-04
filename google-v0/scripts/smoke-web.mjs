import {spawn}from 'node:child_process';import {fileURLToPath}from 'node:url';import {cpSync,existsSync}from 'node:fs';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../web-google/',import.meta.url));
const server=fileURLToPath(new URL('../web-google/.next/standalone/web-google/server.js',import.meta.url));
if(!existsSync(server))throw new Error('Compile web-google antes do smoke test.');
cpSync(root+'.next/static',root+'.next/standalone/web-google/.next/static',{recursive:true});
// Only basic OS variables; no developer credential/config environment is inherited.
const env={NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HOSTNAME:'127.0.0.1',PORT:'32971'};
for(const name of ['PATH','SystemRoot','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
const child=spawn(process.execPath,[server],{env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let diagnostic='';child.stdout.on('data',d=>{diagnostic=(diagnostic+d).slice(-2000);});child.stderr.on('data',d=>{diagnostic=(diagnostic+d).slice(-2000);});
const base='http://127.0.0.1:32971';
try{
 let response;
 for(let attempt=0;attempt<40;attempt++){
  if(child.exitCode!==null)throw new Error('Servidor encerrou: '+diagnostic);
  try{response=await fetch(base,{redirect:'manual',signal:AbortSignal.timeout(1000)});break;}catch{await new Promise(r=>setTimeout(r,250));}
 }
 assert.ok(response,'Servidor não iniciou.');assert.equal(response.status,200);const html=await response.text();assert.ok(html.includes('Entrar com Google'));
 const css=html.match(/href="([^"]+\.css[^"]*)"/);assert.ok(css,'CSS ausente');assert.equal((await fetch(base+css[1])).status,200);
 for(const route of ['/api/library','/api/controls','/api/financial','/api/video/AbCdE123']){
  const r=await fetch(base+route);assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);
 }
 assert.equal((await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"links":"https://instagram.com/p/AbCdE123/"}'})).status,401);
 assert.equal((await fetch(base+'/auth/login',{redirect:'manual'})).status,503);
 assert.equal((await fetch(base+'/auth/callback?state=invalid&code=invalid',{redirect:'manual'})).status,403);
 console.log(JSON.stringify({home:200,css:200,private_routes:401,unconfigured_login:503,invalid_callback:403,google_requests:0,credentials_loaded:false}));
}finally{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});}
