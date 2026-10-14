import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {parseReelLinks} from './links.mjs';
const execute=promisify(execFile);
async function temporary(action){
  const root=resolve(tmpdir()),folder=await mkdtemp(join(root,'megabrain-v0-tools-'));
  try{return await action(folder);}finally{
    const target=resolve(folder);
    if(dirname(target)!==root||!basename(target).startsWith('megabrain-v0-tools-'))throw new Error('Limpeza fora do escopo.');
    await rm(target,{recursive:true,force:true});
  }
}
const messages=Object.freeze({none:'Consulta de metadados concluída com sucesso.',empty_media_response:'O extrator recebeu uma resposta sem mídia; a disponibilidade do Reel não foi confirmada.',unknown:'A ferramenta não forneceu uma causa reconhecida.',http_403:'A origem respondeu HTTP 403; a causa da restrição não foi determinada.',http_404:'A origem respondeu HTTP 404; isso não comprova remoção definitiva.',http_429:'A origem respondeu HTTP 429 (limitação de requisições).',login_required:'A ferramenta informou que o acesso exige autenticação.',unavailable:'A ferramenta informou que o conteúdo não está disponível.',format_unavailable:'A ferramenta não encontrou o formato solicitado.',network_error:'A ferramenta informou falha de conexão ou resolução de nome.',timeout:'A ferramenta informou tempo limite excedido.',process_interrupted:'O processo foi interrompido; a causa não foi determinada.',output_limit:'O processo excedeu o limite de saída de diagnóstico.',file_invalid:'O arquivo final está ausente, vazio ou acima do limite.',local_io:'Houve uma falha local de leitura ou escrita.'});
const phases=new Set(['unknown','source_validation','metadata','format_selection','transfer','merge','remux','file_validation','media_validation','storage_write']);
const version=(v,kind)=>typeof v==='string'&&(kind==='yt-dlp'?/^\d{4}\.\d{2}\.\d{2}$/:/^\d+\.\d+(?:\.\d+)?$/).test(v)?v:null;
// Only fixed messages and allowlisted scalar values cross the persistence boundary.
// Never forward stderr, stdout, error.message, commands, URLs or arbitrary labels.
export function safeDownloadDiagnostic(value){
 let cause=Object.hasOwn(messages,value?.cause)?value.cause:'unknown';
 if(cause==='none'&&(value?.phase!=='metadata'||value?.exit_code!==0))cause='unknown';
 return {phase:phases.has(value?.phase)?value.phase:'unknown',phase_source:['boundary','tool_output'].includes(value?.phase_source)?value.phase_source:'boundary',cause,message:messages[cause],elapsed_ms:Number.isSafeInteger(value?.elapsed_ms)&&value.elapsed_ms>=0&&value.elapsed_ms<=600000?value.elapsed_ms:null,exit_code:Number.isInteger(value?.exit_code)&&value.exit_code>=0&&value.exit_code<=255?value.exit_code:null,tool:'yt-dlp',yt_dlp_version:version(value?.yt_dlp_version,'yt-dlp'),ffmpeg_version:version(value?.ffmpeg_version,'ffmpeg')};
}
function classifyDownload(error,phase){
 // Inspect bounded output in memory only. A reported HTTP status is not an
 // assertion about whether the reel was deleted, private or region-blocked.
 const text=String(error?.stderr??'').slice(-262144);
 let cause='unknown';
 if(error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')cause='output_limit';
 else if(error?.code==='ETIMEDOUT'||/timed out|TimeoutError/i.test(text))cause='timeout';
 else if(error?.killed)cause='process_interrupted';
 else if(/HTTP Error 429\b/.test(text))cause='http_429';
 else if(/HTTP Error 403\b/.test(text))cause='http_403';
 else if(/HTTP Error 404\b/.test(text))cause='http_404';
 else if(/empty media response|no video formats found|unable to extract.*video/i.test(text)){cause='empty_media_response';phase='metadata';}
 else if(/Requested format is not available/i.test(text)){cause='format_unavailable';phase='format_selection';}
 else if(/login required|log in to access|authentication required/i.test(text))cause='login_required';
 else if(/content is not available|video is unavailable|video has been removed/i.test(text))cause='unavailable';
 else if(/Temporary failure in name resolution|Name or service not known|Connection reset|Connection refused|Network is unreachable/i.test(text))cause='network_error';
 else if(phase==='file_validation'&&['ENOENT','INVALID_MEDIA_FILE'].includes(error?.code))cause='file_invalid';
 else if(['ENOSPC','EACCES','EIO'].includes(error?.code))cause='local_io';
 return {cause,phase};
}
export function mediaTools({run=execute,maxBytes=100000000,downloadEnabled=false,clock=()=>Date.now()}={}){
 async function versions(){
  const result={};
  for(const [tool,args,field,pattern] of [['yt-dlp',['--version'],'yt_dlp_version',/^(\d{4}\.\d{2}\.\d{2})\s*$/],['ffmpeg',['-version'],'ffmpeg_version',/^ffmpeg version (\d+\.\d+(?:\.\d+)?)/]]){
   try{const {stdout}=await run(tool,args,{timeout:2000,maxBuffer:16384});result[field]=String(stdout).match(pattern)?.[1]??null;}catch{result[field]=null;}
  }
  return result;
 }

  return {
    async probeMetadata(video){
      const started=clock();let phase='source_validation';
      try{
        const links=parseReelLinks(video.source_url);
        if(links.length!==1||links[0].id!==video.id)throw new Error('Origem inválida.');
        phase='metadata';
        const {stdout}=await run('yt-dlp',['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--retries','0','--fragment-retries','0','--extractor-retries','0','--socket-timeout','10','-f','bestvideo+bestaudio/best[acodec!=none]','--',links[0].url],{timeout:20000,maxBuffer:1048576});
        const metadata=JSON.parse(stdout);
        if(!metadata||metadata.display_id!==video.id&&metadata.id!==video.id)throw new Error('Metadados inválidos.');
        const diagnostic=safeDownloadDiagnostic({phase:'metadata',phase_source:'boundary',cause:'none',elapsed_ms:Math.max(0,Math.round(clock()-started)),exit_code:0,...await versions()});
        return {status:'metadata_available',diagnostic};
      }catch(error){
        return {status:'metadata_failed',diagnostic:safeDownloadDiagnostic({...classifyDownload(error,phase),phase_source:'boundary',elapsed_ms:Math.max(0,Math.round(clock()-started)),exit_code:error.code,...(phase==='source_validation'?{}:await versions())})};
      }
    },
    async captureCaption(video){
      const links=parseReelLinks(video.source_url);
      if(links.length!==1||links[0].id!==video.id)throw Error('Origem diverge do vídeo.');
      const {stdout}=await run('yt-dlp',['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--retries','0','--extractor-retries','0','--socket-timeout','20','--',links[0].url],{timeout:45000,maxBuffer:1048576});
      const metadata=JSON.parse(stdout);
      if(metadata.display_id!==video.id&&metadata.id!==video.id)throw Error('Metadados divergem do Reel.');
      const text=metadata.description;
      if(typeof text!=='string'||!text.trim()||text.length>50000)throw Error('Legenda não disponível.');
      return {text,capture_id:createHash('sha256').update(text).digest('hex'),captured_at:new Date().toISOString(),source_url:links[0].url,scope:'Post description supplied by Instagram extractor',method:'yt-dlp-metadata'};
    },
    async download(video,{withMetadata=false}={}){
      const started=clock();let phase='source_validation',phaseSource='boundary';
      try{
        if(!downloadEnabled)throw new Error('Downloads desligados.');
        const links=parseReelLinks(video.source_url);
        if(links.length!==1||links[0].id!==video.id)throw new Error('Origem diverge do vídeo.');
        return await temporary(async folder=>{
          const file=join(folder,'video.mp4');phase='unknown';
          // One download command, with the existing caps and zero retries.
          try{await run('yt-dlp',['--ignore-config','--no-playlist','--no-progress','--no-warnings','--retries','0','--fragment-retries','0','--extractor-retries','0','--socket-timeout','20','--max-filesize',String(maxBytes),'-f','bestvideo+bestaudio/best[acodec!=none]',...(withMetadata?['--write-info-json']:[]),'--merge-output-format','mp4','--remux-video','mp4','-o',file,'--',links[0].url],{timeout:180000,maxBuffer:262144});}
          catch(error){
            // Last observed tool milestone; absent output remains unknown.
            const output=String(error.stdout??'').slice(-262144);
            for(const line of output.split(/\r?\n/)){
              if(/^\[Instagram\]/.test(line)){phase='metadata';phaseSource='tool_output';}
              if(/^\[info\].*Downloading .*format/.test(line)){phase='format_selection';phaseSource='tool_output';}
              if(/^\[download\]/.test(line)){phase='transfer';phaseSource='tool_output';}
              if(/^\[Merger\]/.test(line)){phase='merge';phaseSource='tool_output';}
              if(/^\[VideoRemuxer\]/.test(line)){phase='remux';phaseSource='tool_output';}
            }
            throw error;
          }
          phase='file_validation';phaseSource='boundary';
          const info=await stat(file);if(!info.isFile()||info.size<1||info.size>maxBytes)throw Object.assign(new Error('Download fora do limite.'),{code:'INVALID_MEDIA_FILE'});
          const bytes=await readFile(file);
          if(!withMetadata)return bytes;
          let sourceCaption=null;
          try{
            const infoFile=join(folder,'video.info.json'),details=await stat(infoFile);
            if(details.size>1048576)throw Error('Metadados acima do limite.');
            const metadata=JSON.parse(await readFile(infoFile,'utf8'));
            if(metadata.display_id!==video.id&&metadata.id!==video.id)throw Error('Metadados divergentes.');
            const text=metadata.description;
            if(typeof text==='string'&&text.trim()&&text.length<=50000)sourceCaption={text,capture_id:createHash('sha256').update(text).digest('hex'),captured_at:new Date(clock()).toISOString(),source_url:links[0].url,scope:'Post description supplied by Instagram extractor',method:'yt-dlp-download-metadata'};
          }catch{/* Caption is optional; media validation still applies. */}
          return {bytes,source_caption:sourceCaption};
        });
      }catch(error){
        const classified=classifyDownload(error,phase);
        const diagnostic=safeDownloadDiagnostic({...classified,phase_source:classified.phase!==phase?'tool_output':phaseSource,elapsed_ms:Math.max(0,Math.round(clock()-started)),exit_code:error.code,...(phase==='source_validation'?{}:await versions())});
        // Replace the exception too, so downstream logging cannot leak raw tool output.
        throw Object.assign(new Error(diagnostic.message),{code:diagnostic.exit_code,operation_step:'download_media',download_diagnostic:diagnostic});
      }
    },
    async extractAudio(bytes){
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)throw new Error('Vídeo inválido.');
      return temporary(async folder=>{
        const source=join(folder,'video.mp4'),output=join(folder,'audio.flac');await writeFile(source,bytes,{mode:0o600});
        await run('ffmpeg',['-nostdin','-v','error','-xerror','-threads','1','-i',source,'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','flac',output],{timeout:120000,maxBuffer:65536});
        const info=await stat(output);if(!info.isFile()||info.size<1||info.size>maxBytes)throw new Error('Áudio fora do limite.');
        return readFile(output);
      });
    }
  };
}
