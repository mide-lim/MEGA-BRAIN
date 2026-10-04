import test from 'node:test';import assert from 'node:assert/strict';import {parseReelLinks}from '../lib/links.mjs';import {LibraryRepository}from '../lib/library-repository.mjs';import {libraryAPI}from '../lib/library-api.mjs';
test('new links are normalized and deduplicated without accepting lookalike hosts',()=>{
 assert.deepEqual(parseReelLinks('http://instagram.com/reel/AbCdE123/?x=1\nhttps://www.instagram.com/p/AbCdE123/'),[{id:'AbCdE123',url:'https://www.instagram.com/p/AbCdE123/'}]);
 for(const input of ['https://instagram.com.evil.test/p/AbCdE123/','https://user@instagram.com/p/AbCdE123/','https://instagram.com:444/p/AbCdE123/','https://instagram.com/p/AbCdE123/extra','https://instagram.com/p/%2e%2e/',''])assert.throws(()=>parseReelLinks(input));
});
test('existing records are never overwritten by registering links again',async()=>{
 const data=new Map([['videos/AbCdE123',{status:'analyzed',transcript:'preserved'}]]);
 const repo=new LibraryRepository({create:async(path,document)=>{if(data.has(path))return {created:false};data.set(path,document);return {created:true};}});
 const result=await repo.registerLinks('https://instagram.com/p/AbCdE123/\nhttps://instagram.com/p/NEWvideo1/');assert.equal(result.created,1);assert.equal(result.already_present,1);assert.equal(result.automatic_processing_started,false);assert.equal(data.get('videos/AbCdE123').transcript,'preserved');assert.equal(data.get('videos/NEWvideo1').status,'pending');
});
test('disabled link import makes no writes and rejects cross-origin requests',async()=>{
 let writes=0;const api=libraryAPI({repository:{registerLinks:async()=>{writes++;}},ledgerStore:{},authorize:async()=>true,sameOrigin:r=>r.headers.get('origin')==='https://v0.example.test'});
 const request=origin=>new Request('https://v0.example.test/api/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"links":"https://instagram.com/p/AbCdE123/"}'});
 assert.equal((await api.importLinks(request('https://v0.example.test'))).status,503);assert.equal((await api.importLinks(request('https://other.test'))).status,403);assert.equal(writes,0);
});
