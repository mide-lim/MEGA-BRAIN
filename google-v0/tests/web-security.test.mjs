import test from 'node:test';import assert from 'node:assert/strict';
import {validateWebConfig}from '../lib/web-config.mjs';import {sealSession,openSession,ownerAllowed,sessionCookie}from '../lib/web-session.mjs';import {serviceIdentity}from '../lib/service-identity.mjs';
const project='megabrain-v0-1017370021431',origin='https://v0.example.test',key='x'.repeat(64);
const config={environment:'google-v0',project_id:project,origin,media_bucket:project+'-media',allowed_email:'midelim.dev@gmail.com'};
const secrets={session_secret:key,google_client_id:'test.apps.googleusercontent.com',google_client_secret:'test-only'};
test('web configuration rejects production origin, bucket, project and missing own secrets',()=>{
 assert.equal(validateWebConfig(config,secrets).origin,origin);
 for(const change of [{origin:'https://megabrain.midelim.tech'},{project_id:'megabrain-stt'},{media_bucket:'megabrain-media'},{allowed_email:'another@example.test'}])assert.throws(()=>validateWebConfig({...config,...change},secrets));
 assert.throws(()=>validateWebConfig(config,{}));
});
test('v0 sessions reject cross-environment, expired, forged and OAuth cookies',()=>{
 const options={origin,kind:'session',now:1000,ttl:100};const value=sealSession({email:'midelim.dev@gmail.com'},key,options);
 assert.ok(openSession(value,key,{...options,now:1001}));
 for(const change of [{origin:'https://megabrain.midelim.tech'},{kind:'oauth'},{now:1100}])assert.equal(openSession(value,key,{...options,...change}),null);
 assert.equal(openSession(value+'x',key,options),null);assert.notEqual(sessionCookie,'__Host-megabrain');
 assert.equal(ownerAllowed({email:'midelim.dev@gmail.com',email_verified:false,sub:'1'}),false);
});
test('service identity refuses another project before requesting an access token',async()=>{
 const requested=[];const provider=serviceIdentity({project,fetchImpl:async url=>{requested.push(url);return new Response(url.endsWith('project-id')?'megabrain-stt':'other@invalid.test',{headers:{'Metadata-Flavor':'Google'}});}});
 await assert.rejects(provider());assert.equal(requested.some(u=>u.endsWith('/token')),false);
});
test('service identity validates account and caches token without logging it',async()=>{
 let calls=0;const provider=serviceIdentity({project,clock:()=>1000,fetchImpl:async url=>{calls++;const payload=url.endsWith('/token')?JSON.stringify({access_token:'TEST-TOKEN',expires_in:3600}):url.endsWith('project-id')?project:`v0-web@${project}.iam.gserviceaccount.com`;return new Response(payload,{headers:{'Metadata-Flavor':'Google'}});}});
 assert.equal(await provider(),'TEST-TOKEN');assert.equal(await provider(),'TEST-TOKEN');assert.equal(calls,3);
});
