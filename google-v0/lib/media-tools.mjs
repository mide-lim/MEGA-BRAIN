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
export function mediaTools({run=execute,maxBytes=100000000,downloadEnabled=false}={}){
  return {
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
    async download(video){
      if(!downloadEnabled)throw new Error('Downloads desligados.');
      const links=parseReelLinks(video.source_url);
      if(links.length!==1||links[0].id!==video.id)throw new Error('Origem diverge do vídeo.');
      return temporary(async folder=>{
        const file=join(folder,'video.mp4');
        // No shell, user config, cookies, playlists, retries or silent fallback
        // to a video-only format. Missing audio is a diagnostic outcome.
        await run('yt-dlp',['--ignore-config','--no-playlist','--no-progress','--no-warnings','--retries','0','--fragment-retries','0','--extractor-retries','0','--socket-timeout','20','--max-filesize',String(maxBytes),'-f','bestvideo+bestaudio/best[acodec!=none]','--merge-output-format','mp4','--remux-video','mp4','-o',file,'--',links[0].url],{timeout:180000,maxBuffer:262144});
        const info=await stat(file);if(!info.isFile()||info.size<1||info.size>maxBytes)throw new Error('Download fora do limite.');
        return readFile(file);
      });
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
