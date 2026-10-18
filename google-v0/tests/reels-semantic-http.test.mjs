import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {workerHTTP} from '../lib/worker-http.mjs';
import {fixedStageRuntime} from '../lib/fixed-stage-runtime.mjs';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {closedReleaseConfig} from '../lib/reels-runtime-policy.mjs';
import {workerAuthorization} from '../lib/worker-auth.mjs';
import {semanticHash} from '../lib/reels-semantic-source.mjs';

const project='megabrain-v0-1017370021431',audience='https://megabrain-v0-analysis-711042421394.us-central1.run.app',now=Date.parse('2026-10-18T03:57:00.000Z');
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),kid='synthetic-ci-key',jwk={...publicKey.export({format:'jwk'}),kid,use:'sig',alg:'RS256'};
function token(overrides={}){const header=Buffer.from(JSON.stringify({alg:'RS256',kid})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:audience,email:'v0-queue@'+project+'.iam.gserviceaccount.com',email_verified:true,sub:'synthetic-queue-subject',iat:Math.floor(now/1000)-10,exp:Math.floor(now/1000)+300,...overrides})).toString('base64url');return header+'.'+payload+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+payload),privateKey).toString('base64url');}
async function start(stage='analysis'){
 const deliveries=[],certRequests=[],config=closedReleaseConfig({project,worker_origin:audience,reels_processing_enabled:true},{MEGABRAIN_REELS_CLOSED_RELEASE:'v2'});
 const authorize=workerAuthorization({audience,clock:()=>now,fetchImpl:async url=>{certRequests.push(url);assert.equal(url,'https://www.googleapis.com/oauth2/v3/certs');return Response.json({keys:[jwk]});}});
 // Compose the production HTTP adapter and fixed-stage selector, replacing
 // only certificates and the final metadata-job port. No Google/provider is used.
 const handler=fixedStageRuntime(stage,config,null,{reelsFactory:(c,p,{stage:fixed})=>reelsGoogleRuntime(c,p,{stage:fixed,authorize,dependencies:{semantic:{runDelivery:async body=>{deliveries.push(body);return {job:{id:body.jobId,status:'prepared',callsUsed:0}};}}}})});
 const server=workerHTTP(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const origin='http://127.0.0.1:'+server.address().port;
 return {deliveries,certRequests,async request(path,{body={},bearer=null,headers={},method='POST'}={}){const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json()};},async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
test('real HTTP boundary reaches queue authorization and exact curation handler in closed fixed-stage runtime',{timeout:30000},async()=>{
 const s=await start(),jobId='a'.repeat(64),body={jobId,sequence:0,outboxId:semanticHash({jobId,sequence:0})};
 try{
  // This is 404 on the old workerHTTP allowlist, so the regression covers
  // the missing layer rather than calling reelsGoogleRuntime directly.
  assert.equal((await s.request('/tasks/curation',{body})).status,401);assert.equal(s.deliveries.length,0);assert.equal(s.certRequests.length,0);
  for(const bearer of [token({aud:'https://wrong.run.app'}),token({email:'other@'+project+'.iam.gserviceaccount.com'}),'invalid.signature.token'])assert.equal((await s.request('/tasks/curation',{body,bearer})).status,401);
  assert.equal((await s.request('/tasks/curation',{body,bearer:token(),headers:{'x-serverless-authorization':'Bearer alternate'}})).status,401);
  assert.equal(s.deliveries.length,0);
  assert.equal((await s.request('/tasks/curation',{body:{...body,videoId:'not-permitted'},bearer:token()})).status,400);assert.equal(s.deliveries.length,0);
  const accepted=await s.request('/tasks/curation',{body,bearer:token()});assert.equal(accepted.status,200);assert.equal(accepted.body.job.callsUsed,0);assert.deepEqual(s.deliveries,[{...body,maxBatches:3}]);assert.equal(s.certRequests.length,1);
  for(const path of ['/tasks/run','/tasks/control'])assert.equal((await s.request(path,{body,bearer:token()})).status,423);
  assert.equal((await s.request('/not-a-task',{body,bearer:token()})).status,404);assert.equal((await s.request('/tasks/curation',{method:'GET'})).status,405);assert.equal(s.deliveries.length,1);
 }finally{await s.close();}
});
test('curation HTTP route cannot select acquisition or transcription while their processing fences remain closed',{timeout:30000},async()=>{
 for(const stage of ['upload','transcription']){const s=await start(stage);try{assert.equal((await s.request('/tasks/curation',{bearer:token()})).status,405);assert.equal((await s.request('/tasks/run',{bearer:token()})).status,423);assert.equal(s.deliveries.length,0);assert.equal(s.certRequests.length,0);}finally{await s.close();}}
});
