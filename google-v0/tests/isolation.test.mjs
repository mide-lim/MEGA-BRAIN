import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync}from 'node:fs';import {automationChanges}from '../lib/controls.mjs';
test('v0 runtime modules never import the legacy snapshot or production adapters',()=>{
 for(const file of readdirSync(new URL('../lib/',import.meta.url)).filter(f=>f.endsWith('.mjs'))){
  const code=readFileSync(new URL('../lib/'+file,import.meta.url),'utf8');
  assert.doesNotMatch(code,/(?:from\s*|import\s*\()\s*['"][^'"]*(?:web\/|\bpg\b|@aws-sdk)/,file);
  assert.doesNotMatch(code,/DATABASE_URL|\/run\/megabrain|\/opt\/megabrain-pilot/,file);
 }
});
test('new web application has no legacy database or storage dependencies',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../web-google/package.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(pkg.dependencies).sort(),['next','react','react-dom']);
 const server=readFileSync(new URL('../web-google/lib/server.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(server,/(?:from\s*|import\s*\()\s*['"][^'"]*(?:\/web\/|\bpg\b|@aws-sdk)/);
 const docker=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');
 for(const folder of ['web/','private/','runtime/'])assert.ok(docker.split(/\r?\n/).includes(folder));
});
test('v0 controls are independent and cannot change financial authority',()=>{
 assert.deepEqual(automationChanges({action:'set',parallelism:4,analysis_enabled:false}),{analysis_enabled:false,parallelism:4});
 for(const body of [{action:'resume',coverage_verified:true},{action:'set',parallelism:0},{action:'set',enabled:'true'},{action:'set',allocation_cents:200000},{action:'pause',enabled:true}])assert.throws(()=>automationChanges(body));
});
