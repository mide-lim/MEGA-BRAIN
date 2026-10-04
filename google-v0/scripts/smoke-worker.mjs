import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {workerRuntime} from '../lib/worker-runtime.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
import {inspectMedia} from '../lib/media-inspector.mjs';
import {mediaTools} from '../lib/media-tools.mjs';
const run=promisify(execFile);
assert.equal((await run('yt-dlp',['--version'])).stdout.trim(),'2026.08.19');
assert.match((await run('ffmpeg',['-version'])).stdout,/ffmpeg version 5\.1\.9/);
const folder=await mkdtemp(join(tmpdir(),'v0-worker-smoke-'));
try{
 const file=join(folder,'synthetic.mp4');
 await run('ffmpeg',['-nostdin','-v','error','-threads','1','-filter_threads','1','-f','lavfi','-i','color=c=black:s=32x32:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',file],{timeout:30000,maxBuffer:65536});
 const bytes=await readFile(file),media=await inspectMedia(bytes);
 assert.equal(media.audio_status,'present');
 const audio=await mediaTools().extractAudio(bytes);assert.ok(audio.length>0);
}finally{await rm(folder,{recursive:true,force:true});}
const config={project:'megabrain-v0-1017370021431',enabled:false,uploads_enabled:false,downloads_enabled:false,dispatch_enabled:false,worker_origin:'https://v0-worker-smoke.run.app',quotes:{},cost_accounting:'conservative_estimate_not_invoice'};
const preset=JSON.parse(await readFile(new URL('../config/analysis-preset.json',import.meta.url),'utf8'));
const server=workerHTTP(workerRuntime(config,preset,{withHandler:true}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 const url=`http://127.0.0.1:${server.address().port}/tasks/run`;
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(url,{method:'POST',body:'x'.repeat(2049)})).status,413);
 assert.equal((await fetch(url)).status,405);
}finally{await new Promise(resolve=>server.close(resolve));}
console.log('Worker smoke passed: fixed tools, synthetic audio, extraction, anonymous rejection, bounded request. No Google calls.');
