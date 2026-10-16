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
import {executeDownloadProcess,downloadProcessEnded} from '../lib/download-executor.mjs';
const run=promisify(execFile);
assert.equal((await run('yt-dlp',['--version'])).stdout.trim(),'2026.08.19');
assert.match((await run('ffmpeg',['-version'])).stdout,/ffmpeg version 5\.1\.9/);
// Anonymous Instagram's primary API path requires an actual curl_cffi target.
// Versions alone do not prove that the native handler can load in this image.
const transportProbe=String.raw`import importlib.metadata as metadata
import json
import socket
from yt_dlp import YoutubeDL
from yt_dlp.networking.impersonate import ImpersonateTarget
import curl_cffi
def deny_network(*args, **kwargs):
    raise AssertionError("Unexpected network in Instagram transport smoke")
socket.create_connection = deny_network
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
with YoutubeDL({"quiet": True, "no_warnings": True, "cachedir": False}) as ydl:
    targets = [str(target) for target, handler in ydl._get_available_impersonate_targets()
               if target.client == "chrome" and handler == "curl_cffi"]
    assert ydl._impersonate_target_available(ImpersonateTarget()), "No actual impersonation transport"
    assert targets, "Actual curl_cffi Chrome fingerprint target is required for anonymous Instagram"
print(json.dumps({"chrome_targets": len(targets), "versions": {
    name: metadata.version(name) for name in ["curl-cffi", "cffi", "certifi", "pycparser"]
}}))
`;
const transport=JSON.parse((await run('python',['-c',transportProbe],{timeout:10000,maxBuffer:16384})).stdout);
assert.ok(transport.chrome_targets>0);
assert.deepEqual(transport.versions,{'curl-cffi':'0.16.0',cffi:'2.1.1',certifi:'2026.7.22',pycparser:'3.0'});
const folder=await mkdtemp(join(tmpdir(),'v0-worker-smoke-'));
try{
 // A normal tool error may close its streams while a detached child survives.
 // The packaged supervisor must wait for that child, without network or media.
 const marker=join(folder,'descendant-ended');
 const child=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ended'),60);`;
 const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();process.exit(1);`;
 let failed;
 try{await executeDownloadProcess(process.execPath,['-e',parent],{timeout:3000,maxBuffer:4096});}catch(error){failed=error;}
 assert.equal(failed?.code,1);assert.equal(downloadProcessEnded(failed),true);
 assert.equal(await readFile(marker,'utf8'),'ended');
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
console.log('Worker smoke passed: fixed tools, actual curl_cffi Chrome transport, supervised detached descendant closure, synthetic audio, extraction, anonymous rejection, bounded request. No Google calls.');
