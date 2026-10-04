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
export function boundedMedia({repository,store,api,authorize,enabled=false,clock=()=>Date.now()}){
 const reply=(message,status)=>Response.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
 async function policy(id,bytes=0){
  const snapshot=await store.get('settings/media_delivery'),p=snapshot?.data;
  if(!enabled||!p||p.enabled!==true||p.schema_version!==1||!Array.isArray(p.allowed_ids)||!p.allowed_ids.includes(id)||!Number.isFinite(Date.parse(p.expires_at))||clock()>=Date.parse(p.expires_at))throw Error('Delivery disabled');
  if(!Number.isSafeInteger(p.maximum_bytes)||p.maximum_bytes<1||p.maximum_bytes>400*1024*1024||!Number.isSafeInteger(p.used_bytes)||p.used_bytes<0||!Number.isSafeInteger(p.requests)||p.requests<0||p.requests>=200||p.used_bytes+bytes>p.maximum_bytes||p.financial_execution_id!=='media_pilot_delivery')throw Error('Delivery limit');
  const f=(await store.get('settings/financial'))?.data,j=f?.jobs?.[p.financial_execution_id];
  if(!j||j.stage!=='media_access'||j.status!=='started'||j.maximum_cents!==420||!Number.isSafeInteger(f.reserved_cents)||f.reserved_cents<420||f.coverage_verified!==true||!Number.isFinite(Date.parse(f.credit_expires_at))||!Number.isFinite(Date.parse(f.ongoing_costs_valid_until))||clock()>=Date.parse(f.credit_expires_at)-72*3600000||clock()>=Date.parse(f.ongoing_costs_valid_until))throw Error('Funding unavailable');
  if(bytes)await store.patch('settings/media_delivery',{used_bytes:p.used_bytes+bytes,requests:p.requests+1},{updateTime:snapshot.updateTime});
  return p;
 }
 async function record(id){const v=await repository.video(id);if(!/^[A-Za-z0-9_-]{5,32}$/.test(id)||!v?.media_verified||v.video_key!==`originals/instagram/${id}/video.mp4`||!/^\d{1,30}$/.test(v.video_generation??'')||!Number.isSafeInteger(v.video_bytes)||v.video_bytes<1||v.video_bytes>100000000)throw Error('Invalid media');return v;}
 return {async metadata(request,id){
  if(await authorize(request)!==true)return reply('Não autorizado',401);
  try{const p=await policy(id);await record(id);return Response.json({url:'/api/media/'+encodeURIComponent(id),expires_at:p.expires_at},{headers:{'Cache-Control':'no-store'}});}catch{return reply('Reprodução pausada ou franquia do piloto esgotada.',503);}
 },async stream(request,id){
  if(await authorize(request)!==true)return reply('Não autorizado',401);
  if(!['GET','HEAD'].includes(request.method))return reply('Método inválido',405);
  try{
   await policy(id);const v=await record(id);let range;try{range=mediaRange(request.headers.get('range'),v.video_bytes);}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${v.video_bytes}`,'Cache-Control':'no-store'}});}
   const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${range.start}-${range.end}/${v.video_bytes}`,'Content-Length':String(range.bytes),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
   if(request.method==='HEAD')return new Response(null,{status:206,headers});
   // Debit before any provider read. A failed/aborted request is never refunded.
   await policy(id,range.bytes);
   const root=`https://storage.googleapis.com/storage/v1/b/${api.project}-media/o/${encodeURIComponent(v.video_key)}?alt=media&generation=${v.video_generation}`;
   const response=await api.request(root,{responseMode:'raw',headers:{Range:`bytes=${range.start}-${range.end}`}});
   if(response.status!==206||response.headers.get('content-range')!==headers['Content-Range']){await response.body?.cancel();throw Error('Unexpected Google range');}
   const reader=response.body.getReader(),parts=[];let total=0;
   try{while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>range.bytes){await reader.cancel();throw Error('Response exceeds range');}parts.push(Buffer.from(r.value));}}finally{reader.releaseLock();}
   if(total!==range.bytes)throw Error('Incomplete response');return new Response(Buffer.concat(parts,total),{status:206,headers});
  }catch{return reply('Reprodução indisponível. Nenhuma repetição automática foi iniciada.',503);}
 }};
}
