import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {workerAuthorization} from '../lib/worker-auth.mjs';
test('worker verifies Google signature, exact audience, own queue identity and expiry before execution',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),audience='https://v0-worker-test.run.app';let fetches=0;
 const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
 const authorize=workerAuthorization({audience,clock:()=>1000000,fetchImpl:async url=>{assert.equal(url,'https://www.googleapis.com/oauth2/v3/certs');fetches++;return Response.json({keys:[jwk]});}});
 const token=changes=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:audience,email:'v0-queue@megabrain-v0-1017370021431.iam.gserviceaccount.com',email_verified:true,sub:'123',iat:990,exp:1990,...changes})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');};
 const req=(value,headers={})=>new Request(audience+'/tasks/run',{headers:{authorization:'Bearer '+value,...headers}});
 assert.equal(await authorize(req(token({}))),true);assert.equal(await authorize(req(token({}))),true);assert.equal(fetches,1);
 for(const changes of [{aud:'https://other.run.app'},{email:'attacker@example.com'},{exp:999},{iss:'https://attacker.example'},{email_verified:false}])assert.equal(await authorize(req(token(changes))),false);
 const good=token({});assert.equal(await authorize(req(good.slice(0,-5)+'AAAAA')),false);
 assert.equal(await authorize(req(good,{'x-serverless-authorization':'Bearer anything'})),false);
 assert.equal(await authorize(new Request(audience)),false);
});
