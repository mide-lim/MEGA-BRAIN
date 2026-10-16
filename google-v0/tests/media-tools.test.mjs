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

test('successful metadata probe records success instead of a spurious unknown failure',async()=>{
 const tools=mediaTools({run:async(tool,args)=>{if(args.includes('--dump-single-json'))return {stdout:JSON.stringify({display_id:video.id})};if(tool==='yt-dlp')return {stdout:'2026.08.19'};return {stdout:'ffmpeg version 5.1.9'};}});
 const result=await tools.probeMetadata(video);assert.equal(result.status,'metadata_available');assert.equal(result.diagnostic.cause,'none');assert.equal(result.diagnostic.exit_code,0);assert.doesNotMatch(result.diagnostic.message,/desconhecida|falha|não forneceu/);
 assert.equal(safeDownloadDiagnostic({cause:'none',phase:'metadata',exit_code:1}).cause,'unknown');assert.equal(safeDownloadDiagnostic({cause:'none',phase:'transfer',exit_code:0}).cause,'unknown');
});

const detailCases=[
 ['Unable to extract shared data','metadata_extraction_failed'],
 ['Unable to extract additional data','metadata_extraction_failed'],
 ['Failed to parse JSON','metadata_json_invalid'],
 ['JSONDecodeError: malformed response','metadata_json_invalid'],
 ['checkpoint_required','source_auth_challenge'],
 ['challenge_required','source_auth_challenge'],
 ['login_required','source_auth_challenge'],
 ['Rate-limit reached','source_rate_limited'],
 ['Please wait a few minutes before you try again','source_rate_limited'],
 ['HTTP Error 400: Bad Request','source_http_400'],
 ['HTTP Error 401: Unauthorized','source_http_401'],
 ['HTTP Error 503: Service Unavailable','source_http_5xx'],
 ['[SSL: CERTIFICATE_VERIFY_FAILED]','tls_validation_failed'],
 ['Unsupported URL','extractor_unavailable']
];
for(const [stderr,detail] of detailCases)test(`fixed safe detail without changing coarse cause: ${detail}: ${stderr}`,async()=>{
 let extractions=0;
 const hostile=' Cookie: sessionid=SECRET Authorization: Bearer SECRET user@example.test https://cdn.invalid/media?token=SECRET /tmp/private';
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{
  if(args[0]==='--version')return {stdout:'2026.08.19'};
  if(args[0]==='-version')return {stdout:'ffmpeg version 5.1.9'};
  extractions++;
  throw Object.assign(Error('private message'+hostile),{code:1,stderr:stderr+hostile,stdout:'[Instagram] Extracting URL:'+hostile});
 }});
 await assert.rejects(tools.download(video),error=>{
  const d=error.download_diagnostic;
  assert.equal(d.cause,'unknown');assert.equal(d.detail_code,detail);assert.equal(d.phase,'metadata');assert.equal(d.exit_code,1);
  assert.notEqual(d.message,'A ferramenta não forneceu uma causa reconhecida.');
  assert.deepEqual(safeDownloadDiagnostic(d),d,'detail survives the existing persistence sanitizer');
  assert.equal(error.message,d.message);assert.equal(error.stderr,undefined);assert.equal(error.stdout,undefined);
  assert.doesNotMatch(JSON.stringify(d)+error.message,/SECRET|Cookie|Bearer|sessionid|https:|example\.test|\/tmp\/|private/);
  return true;
 });
 assert.equal(extractions,1,'diagnostics must not trigger another extraction');
});
test('unclassified real metadata shape stays unknown and states the evidence limit',async()=>{
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{
  if(args.length===1)throw Error('version unavailable');
  throw Object.assign(Error('HTTP Error 403 in a private exception message'),{code:1,stderr:'An unrecognized failure user@example.test',stdout:'[Instagram] Extracting URL: private'});
 }});
 await assert.rejects(tools.download(video),error=>{
  const d=error.download_diagnostic;assert.equal(d.cause,'unknown');assert.equal(d.detail_code,'metadata_error_unclassified');
  assert.match(d.message,/encerrou com erro durante a leitura dos metadados/);assert.match(d.message,/não identifica a causa/);
  assert.doesNotMatch(JSON.stringify(d),/403|example\.test|private/);return true;
 });
});
test('supplemental details never override known causes or accept arbitrary text',()=>{
 for(const detail of ['https://secret.invalid/?token=SECRET','Cookie: SECRET','__proto__','constructor']){
  const d=safeDownloadDiagnostic({cause:'unknown',phase:'transfer',exit_code:1,detail_code:detail,message:'SECRET'});
  assert.equal(d.detail_code,undefined);assert.doesNotMatch(JSON.stringify(d),/SECRET|Cookie|https/);
 }
 for(const exit_code of [null,0,-1,256,'1']){
  assert.equal(safeDownloadDiagnostic({cause:'unknown',phase:'metadata',exit_code,detail_code:'source_auth_challenge'}).detail_code,undefined);
 }
 const known=safeDownloadDiagnostic({cause:'http_403',phase:'metadata',exit_code:1,detail_code:'source_auth_challenge'});
 assert.equal(known.detail_code,undefined);assert.match(known.message,/HTTP 403/);
});
test('tool classification only inspects bounded tail and never persists it',async()=>{
 const tools=mediaTools({downloadEnabled:true,run:async(tool,args)=>{
  if(args.length===1)throw Error('version unavailable');
  throw Object.assign(Error('ignored'),{code:1,stderr:'checkpoint_required\n'+'SENSITIVE'.repeat(40000)+'\nAn unrecognized failure',stdout:'[Instagram] Extracting URL'});
 }});
 await assert.rejects(tools.download(video),error=>{
  assert.equal(error.download_diagnostic.detail_code,'metadata_error_unclassified');
  assert.ok(Buffer.byteLength(JSON.stringify(error.download_diagnostic))<1000);
  assert.doesNotMatch(JSON.stringify(error.download_diagnostic),/SENSITIVE|checkpoint/);return true;
 });
});
test('metadata probe uses the same safe detailed failure contract',async()=>{
 const tools=mediaTools({run:async(tool,args)=>{
  if(args[0]==='--version')return {stdout:'2026.08.19'};
  if(args[0]==='-version')return {stdout:'ffmpeg version 5.1.9'};
  throw Object.assign(Error('PRIVATE'),{code:1,stderr:'Unable to extract shared data https://private.invalid/?token=SECRET'});
 }});
 const result=await tools.probeMetadata(video);assert.equal(result.status,'metadata_failed');
 assert.equal(result.diagnostic.cause,'unknown');assert.equal(result.diagnostic.detail_code,'metadata_extraction_failed');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SECRET|https:/);
});


test('detail enum rejects coercible objects without leaking fields or invoking coercion',()=>{
 let coercions=0;
 const object={secret:'SYNTHETIC_SECRET',toString(){coercions++;return 'source_auth_challenge';}};
 const wrapped=new String('source_auth_challenge');wrapped.secret='SYNTHETIC_SECRET';
 const array=['source_auth_challenge'];array.secret='SYNTHETIC_SECRET';
 const number=new Number(1);number.secret='SYNTHETIC_SECRET';number.toString=()=>{coercions++;return 'source_auth_challenge';};
 for(const detail_code of [object,wrapped,array,[['source_auth_challenge']],number,Symbol('SYNTHETIC_SECRET'),null,42]){
  const d=safeDownloadDiagnostic({cause:'unknown',phase:'metadata',exit_code:1,detail_code});
  assert.equal(d.detail_code,'metadata_error_unclassified');
  assert.equal(typeof d.detail_code,'string');
  assert.doesNotMatch(JSON.stringify(d),/SYNTHETIC_SECRET|source_auth_challenge|secret/);
 }
 assert.equal(coercions,0);
});


test('coarse cause enum also rejects objects and JSON arrays without invoking coercion',()=>{
 let coercions=0;
 const object={secret:'SYNTHETIC_SECRET',toString(){coercions++;return 'http_403';}};
 for(const cause of [object,['http_403'],[['http_403']],new String('http_403'),Symbol('SYNTHETIC_SECRET')]){
  const d=safeDownloadDiagnostic({cause,phase:'metadata',exit_code:1});
  assert.equal(d.cause,'unknown');assert.equal(typeof d.cause,'string');
  assert.equal(d.detail_code,'metadata_error_unclassified');
  assert.doesNotMatch(JSON.stringify(d),/SYNTHETIC_SECRET|http_403|secret/);
 }
 assert.equal(coercions,0);
});
