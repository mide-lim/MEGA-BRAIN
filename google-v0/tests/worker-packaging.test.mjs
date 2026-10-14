import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('worker image file selection can load its processing and retry imports without repository files',async()=>{
 const dockerfile=await readFile(new URL('../Dockerfile.worker',import.meta.url),'utf8'),folder=await mkdtemp(join(tmpdir(),'megabrain-worker-package-'));
 try{
  let copied=0;
  for(const line of dockerfile.split(/\r?\n/)){
   if(!line.startsWith('COPY '))continue;
   const parts=line.trim().split(/\s+/),destination=parts.at(-1);
   for(const source of parts.slice(1,-1).filter(part=>!part.startsWith('--')&&part.startsWith('lib/'))){
    const output=join(folder,destination.endsWith('/')?source:destination.replace(/^\/app\//,''));
    await mkdir(dirname(output),{recursive:true});await copyFile(new URL('../'+source,import.meta.url),output);copied++;
   }
  }
  assert.ok(copied>20);
  const result=await run(process.execPath,['--input-type=module','-e',"await import('./lib/worker-runtime.mjs'); await import('./lib/smart-retry.mjs'); console.log('package-ready')"],{cwd:folder,timeout:10000});
  assert.match(result.stdout,/package-ready/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
