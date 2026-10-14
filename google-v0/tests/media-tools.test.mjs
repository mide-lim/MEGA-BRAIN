import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access} from 'node:fs/promises';
import {mediaTools,safeDownloadDiagnostic} from '../lib/media-tools.mjs';
const video={id:'Reel_123',source_url:'https://www.instagram.com/p/Reel_123/'};
const cases=[
 ['HTTP Error 403: Forbidden','http_403'],['HTTP Error 404: Not Found','http_404'],['HTTP Error 429: Too Many Requests','http_429'],
 ['Login required','login_required'],['This content is not available','unavailable'],['Requested format is not available','format_unavailable'],
 ['Temporary failure in name resolution','network_error'],['Connection reset by peer','network_error'],['Read timed out','timeout'],['An unrecognized failure','unknown']
];
for(const [stderr,cause] of cases)test(`bounded safe diagnostic for ${cause}: ${stderr}`,async()=>{
 const calls=[];let ticks=0;
 const tools=mediaTools({downloadEnabled:true,clock:()=>ticks++?150:100,run:async(tool,args,options)=>{
  calls.push({tool,args,options});
  if(args[0]==='--version')return {stdout:'2026.03.17\n'};
  if(args[0]==='-version')return {stdout:'ffmpeg version 5.1.9-0+deb12u1 Copyright\n'};
  throw Object.assign(new Error('secret command https://private.invalid/?token=SECRET'),{code:1,stderr:stderr+'\nCookie: sessionid=SECRET\nAuthorization: Bearer SECRET\nhttps://cdn.invalid/file?token=SECRET',stdout:'[Instagram] Extracting URL: secret\n[download] Destination: /tmp/secret'});
 }});
 let caught;try{await tools.download(video);}catch(error){caught=error;}
 assert.ok(caught);const d=caught.download_diagnostic;
 assert.equal(d.cause,cause);assert.equal(d.elapsed_ms,50);assert.equal(d.exit_code,1);assert.equal(d.yt_dlp_version,'2026.03.17');assert.equal(d.ffmpeg_version,'5.1.9');
 assert.equal(d.phase,cause==='format_unavailable'?'format_selection':'transfer');
 assert.equal(caught.operation_step,'download_media');assert.equal(caught.stderr,undefined);assert.equal(caught.stdout,undefined);
 assert.doesNotMatch(JSON.stringify(d)+caught.message,/SECRET|https:|sessionid|Bearer|\/tmp\//);
 const downloadCalls=calls.filter(c=>c.args.includes('--max-filesize'));assert.equal(downloadCalls.length,1);
 for(const flag of ['--retries','--fragment-retries','--extractor-retries'])assert.equal(downloadCalls[0].args[downloadCalls[0].args.indexOf(flag)+1],'0');
 assert.ok(!downloadCalls[0].args.some(a=>a.includes('cookies')));
});
for(const [output,phase] of [['[Instagram] Extracting URL','metadata'],['[info] Reel: Downloading 1 format(s)','format_selection'],['[Merger] Merging formats','merge'],['[VideoRemuxer] Remuxing video','remux'],['unrecognized output','unknown']])test(`last observed phase ${phase}`,async()=>{
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{if(args.length===1)throw Error('version query failed');throw Object.assign(Error('failure'),{code:1,stdout:output,stderr:'unrecognized'});}});
 await assert.rejects(tools.download(video),e=>{assert.equal(e.download_diagnostic.phase,phase);assert.equal(e.download_diagnostic.cause,'unknown');assert.equal(e.download_diagnostic.yt_dlp_version,null);return true;});
});
test('successful download is unchanged and does not query versions',async()=>{
 let count=0,path;
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{count++;path=args[args.indexOf('-o')+1];await writeFile(path,Buffer.from('media'));return {stdout:''};}});
 assert.equal((await tools.download(video)).toString(),'media');assert.equal(count,1);await assert.rejects(access(path));
});
for(const [code,killed,cause] of [['ERR_CHILD_PROCESS_STDIO_MAXBUFFER',false,'output_limit'],['ETIMEDOUT',false,'timeout'],[null,true,'process_interrupted']])test(`process failure ${cause}`,async()=>{
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{if(args.length===1)return {stdout:'bad secret version'};throw Object.assign(Error('raw secret'),{code,killed});}});
 await assert.rejects(tools.download(video),e=>{assert.equal(e.download_diagnostic.cause,cause);assert.equal(e.download_diagnostic.yt_dlp_version,null);return true;});
});
test('missing or oversized final file is diagnosed and temporary files removed',async()=>{
 for(const size of [null,5]){
  let path;
  const tools=mediaTools({downloadEnabled:true,maxBytes:4,run:async(tool,args)=>{if(args.length===1)return {stdout:'unavailable'};path=args[args.indexOf('-o')+1];if(size!==null)await writeFile(path,Buffer.alloc(size));return {stdout:''};}});
  await assert.rejects(tools.download(video),e=>{assert.equal(e.download_diagnostic.phase,'file_validation');assert.equal(e.download_diagnostic.cause,'file_invalid');return true;});await assert.rejects(access(path));
 }
});
test('persistence serializer drops forged arbitrary diagnostic fields',()=>{
 const d=safeDownloadDiagnostic({phase:'https://secret',cause:'secret',message:'Cookie: SECRET',stderr:'SECRET',elapsed_ms:Infinity,exit_code:999,yt_dlp_version:'2026.03.17 SECRET',ffmpeg_version:'5.1.9 SECRET'});
 assert.equal(d.phase,'unknown');assert.equal(d.cause,'unknown');assert.equal(d.elapsed_ms,null);assert.equal(d.exit_code,null);assert.doesNotMatch(JSON.stringify(d),/SECRET|Cookie|https/);
});

test('empty media response is a procedural metadata failure and does not prove deletion',async()=>{
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{if(args.length===1)throw Error('version');throw Object.assign(Error('secret'),{code:1,stderr:'ERROR: Instagram sent an empty media response',stdout:'[Instagram] Extracting URL'});}});
 await assert.rejects(tools.download(video),e=>{assert.equal(e.download_diagnostic.cause,'empty_media_response');assert.equal(e.download_diagnostic.phase,'metadata');assert.doesNotMatch(e.message,/removido|privado|secret/);return true;});
});
test('download captures bounded caption from the same extraction and removes its raw metadata',async()=>{
 let count=0,infoPath;
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{count++;assert.ok(args.includes('--write-info-json'));const path=args[args.indexOf('-o')+1];infoPath=path.replace(/\.mp4$/,'.info.json');await writeFile(path,Buffer.from('media'));await writeFile(infoPath,JSON.stringify({display_id:video.id,description:'Descrição preservada',signed_url:'SECRET'}));return {stdout:''};}});
 const result=await tools.download(video,{withMetadata:true});assert.equal(count,1);assert.equal(result.bytes.toString(),'media');assert.equal(result.source_caption.text,'Descrição preservada');assert.doesNotMatch(JSON.stringify(result.source_caption),/SECRET|signed_url/);await assert.rejects(access(infoPath));
});
test('mismatched caption metadata cannot contaminate the video or cause another extraction',async()=>{
 let count=0;const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{count++;const path=args[args.indexOf('-o')+1];await writeFile(path,Buffer.from('media'));await writeFile(path.replace(/\.mp4$/,'.info.json'),JSON.stringify({display_id:'Other_123',description:'wrong caption'}));return {stdout:''};}});
 const result=await tools.download(video,{withMetadata:true});assert.equal(result.source_caption,null);assert.equal(count,1);assert.equal(result.bytes.toString(),'media');
});
