const chunkLimit=2*1024*1024;
export function mediaRange(value,size){
 if(!Number.isSafeInteger(size)||size<1||size>100000000)throw Error('Invalid size');
 let start=0,end=size-1;
 if(value){const m=/^bytes=(\d*)-(\d*)$/.exec(value);if(!m||(!m[1]&&!m[2]))throw Error('Invalid range');
 if(!m[1]){const n=Number(m[2]);if(!Number.isSafeInteger(n)||n<1)throw Error('Invalid suffix');start=Math.max(0,size-n);}
 else{start=Number(m[1]);if(m[2])end=Number(m[2]);}}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start<0||end<start)throw Error('Invalid range');
 end=Math.min(end,size-1,start+chunkLimit-1);return {start,end,bytes:end-start+1};
}
// Playback reads an already persisted private object. Processing budgets, old claims
// and pilot delivery counters are not permission to view the owner's own archive.
export function boundedMedia({repository,api,authorize,clock=()=>Date.now()}){
 const reply=(message,status)=>Response.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
 const missing=()=>Object.assign(Error('Missing media'),{status:404});
 const failed=error=>error?.status===404
  ?reply('Arquivo de vídeo não encontrado. A análise salva continua disponível.',404)
  :reply('Não foi possível acessar o vídeo agora. Tente carregar novamente.',503);
 async function record(id){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{5,32}$/.test(id))throw missing();
  const v=await repository.video(id);
  if(v?.media_verified!==true||v.video_key!==`originals/instagram/${id}/video.mp4`||typeof v.video_generation!=='string'||!/^\d{1,30}$/.test(v.video_generation)||!Number.isSafeInteger(v.video_bytes)||v.video_bytes<1||v.video_bytes>100000000)throw missing();
  return v;
 }
 return {async metadata(request,id){
  if(await authorize(request)!==true)return reply('Não autorizado',401);
  try{await record(id);return Response.json({url:'/api/media/'+encodeURIComponent(id),expires_at:new Date(clock()+300000).toISOString()},{headers:{'Cache-Control':'no-store'}});}catch(error){return failed(error);}
 },async stream(request,id){
  if(await authorize(request)!==true)return reply('Não autorizado',401);
  if(!['GET','HEAD'].includes(request.method))return reply('Método inválido',405);
  try{
   const v=await record(id);let range;try{range=mediaRange(request.headers.get('range'),v.video_bytes);}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${v.video_bytes}`,'Cache-Control':'no-store'}});}
   const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${range.start}-${range.end}/${v.video_bytes}`,'Content-Length':String(range.bytes),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
   if(request.method==='HEAD')return new Response(null,{status:206,headers});
   const root=`https://storage.googleapis.com/storage/v1/b/${api.project}-media/o/${encodeURIComponent(v.video_key)}?alt=media&generation=${v.video_generation}`;
   const response=await api.request(root,{responseMode:'raw',headers:{Range:`bytes=${range.start}-${range.end}`}});
   if(response.status!==206||response.headers.get('content-range')!==headers['Content-Range']||(response.headers.has('content-length')&&response.headers.get('content-length')!==headers['Content-Length'])){await response.body?.cancel();throw Error('Unexpected Google range');}
   const reader=response.body.getReader(),parts=[];let total=0;
   try{while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>range.bytes){await reader.cancel();throw Error('Response exceeds range');}parts.push(Buffer.from(r.value));}}finally{reader.releaseLock();}
   if(total!==range.bytes)throw Error('Incomplete response');return new Response(Buffer.concat(parts,total),{status:206,headers});
  }catch(error){return failed(error);}
 }};
}
