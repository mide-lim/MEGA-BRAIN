import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
const execute=promisify(execFile);
export function parseProbe(data,{maxDurationSeconds=600}={}){
  const duration=Number(data?.format?.duration);
  const streams=Array.isArray(data?.streams)?data.streams:[];
  if(!streams.some(s=>s.codec_type==='video')||!Number.isFinite(duration)||duration<=0||duration>maxDurationSeconds)throw new Error('Vídeo inválido ou fora do tamanho de piloto.');
  return {hasVideo:true,hasAudio:streams.some(s=>s.codec_type==='audio'),duration_seconds:duration};
}
export function audioStatus(stderr,hasAudio){
  if(!hasAudio)return {audio_status:'missing',peak_db:null};
  const match=stderr.match(/max_volume:\s*(-inf|-?\d+(?:\.\d+)?)\s*dB/);
  if(!match)throw new Error('Não foi possível verificar o nível de áudio.');
  const peak=match[1]==='-inf'?-Infinity:Number(match[1]);
  return {audio_status:peak<=-80?'silent':'present',peak_db:Number.isFinite(peak)?peak:null};
}
export async function inspectMedia(bytes,{maxBytes=100000000,maxDurationSeconds=600,run=execute}={}){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)throw new Error('Mídia acima do limite ou vazia.');
  const tempRoot=resolve(tmpdir());const folder=await mkdtemp(join(tempRoot,'megabrain-v0-media-'));
  try{
    const file=join(folder,'video.mp4');await writeFile(file,bytes,{mode:0o600});
    const probe=await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name','-of','json',file],{timeout:15000,maxBuffer:65536});
    const media=parseProbe(JSON.parse(probe.stdout),{maxDurationSeconds});
    const args=['-nostdin','-xerror','-threads','1','-i',file];
    if(media.hasAudio)args.push('-af','volumedetect');args.push('-f','null','-');
    const decode=await run('ffmpeg',args,{timeout:120000,maxBuffer:524288});
    return {...media,...audioStatus(decode.stderr,media.hasAudio)};
  }finally{
    const target=resolve(folder);
    if(dirname(target)!==tempRoot||!basename(target).startsWith('megabrain-v0-media-'))throw new Error('Diretório temporário fora do escopo de limpeza.');
    await rm(target,{recursive:true,force:true});
  }
}
