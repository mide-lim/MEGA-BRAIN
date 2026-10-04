import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign,verify}from 'node:crypto';
import {canonicalMediaRequest,SignedMedia}from '../lib/signed-media.mjs';import {mediaAPI}from '../lib/media-api.mjs';
const project='megabrain-v0-1017370021431',bucket=project+'-media',now=Date.parse('2026-10-03T18:00:00Z');
const params={project,bucket,id:'AbCdE123',generation:'12345',now};
test('V4 signature binds exact generation, GET, own bucket, signer and five-minute expiry',()=>{
 const r=canonicalMediaRequest(params),url=new URL(r.unsignedUrl);assert.equal(url.hostname,'storage.googleapis.com');assert.equal(url.pathname,`/${bucket}/originals/instagram/AbCdE123/video.mp4`);assert.equal(url.searchParams.get('generation'),'12345');assert.equal(url.searchParams.get('X-Goog-Date'),'20261003T180000Z');assert.equal(url.searchParams.get('X-Goog-Expires'),'300');assert.equal(r.expires_at,'2026-10-03T18:05:00.000Z');
 for(const change of [{bucket:'megabrain-media'},{id:'../x'},{generation:'1&x=evil'},{expiresSeconds:301}])assert.throws(()=>canonicalMediaRequest({...params,...change}));
});
test('signing uses IAM, not a stored private key, and produces a verifiable signature',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});let signed;
 const signer=new SignedMedia({project,bucket,clock:()=>now,tokenProvider:async()=>'TEST-TOKEN',fetchImpl:async(url,request)=>{
  assert.ok(url.startsWith('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/v0-web%40'));signed=Buffer.from(JSON.parse(request.body).payload,'base64');return Response.json({signedBlob:sign('RSA-SHA256',signed,privateKey).toString('base64')});}});
 const result=await signer.issue({id:params.id,generation:params.generation,financialCheck:async()=>({ready:true,media_access_enabled:true}),markStarted:async()=>{},markUncertain:async()=>{assert.fail();}});
 assert.equal(verify('RSA-SHA256',signed,publicKey,Buffer.from(new URL(result.url).searchParams.get('X-Goog-Signature'),'hex')),true);
});
test('financial rejection precedes token/signature requests; uncertain result is not retried',async()=>{
 let requests=0,uncertain=0;const signer=new SignedMedia({project,bucket,tokenProvider:async()=>{requests++;return 'TEST';},fetchImpl:async()=>{requests++;throw new Error('timeout');}});
 const input={id:params.id,generation:params.generation,financialCheck:async()=>({ready:false}),markStarted:async()=>{},markUncertain:async()=>{uncertain++;}};
 await assert.rejects(signer.issue(input));assert.equal(requests,0);assert.equal(uncertain,0);
 await assert.rejects(signer.issue({...input,financialCheck:async()=>({ready:true,media_access_enabled:true})}));assert.equal(requests,2);assert.equal(uncertain,1);
});
test('anonymous and disabled media access never read Firestore or sign a URL',async()=>{
 let reads=0;const repository={video:async()=>{reads++;}},signer={issue:async()=>assert.fail()};
 const request=new Request('https://v0.example.test/api/video/AbCdE123');
 assert.equal((await mediaAPI({repository,signer,authorize:async()=>false})(request,params.id)).status,401);
 assert.equal((await mediaAPI({repository,signer,authorize:async()=>true})(request,params.id)).status,503);assert.equal(reads,0);
});
test('unverified media cannot reserve funds and signed access keeps transfer reservation open',async()=>{
 let reserves=0;const transitions=[];
 const ledger={reserve:async()=>{reserves++;return {ready:true,media_access_enabled:true};},transition:async(_id,action)=>{transitions.push(action);}};
 const request=new Request('https://v0.example.test/api/video/AbCdE123');
 const repository={video:async()=>({media_verified:false})};
 const handler=mediaAPI({repository,ledger,signer:{issue:async()=>assert.fail()},authorize:async()=>true,enabled:true,maximumCents:100});
 assert.equal((await handler(request,params.id)).status,409);assert.equal(reserves,0);
 repository.video=async()=>({media_verified:true,video_key:'originals/instagram/AbCdE123/video.mp4',video_generation:'12345',video_bytes:1000});
 const signer={issue:async input=>{assert.equal((await input.financialCheck()).ready,true);await input.markStarted();return {url:'https://storage.googleapis.com/TEST',expires_at:'2026-10-03T18:05:00Z'};}};
 const valid=mediaAPI({repository,ledger,signer,authorize:async()=>true,enabled:true,maximumCents:100});
 const result=await valid(request,params.id);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(reserves,1);assert.deepEqual(transitions,['start']);
});
