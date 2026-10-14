// A failed page/update must never replace a complete visible snapshot.
export async function loadLibrarySnapshot(readPage,{signal}={}){
 const records=new Map(),seen=new Set();let cursor;
 do{
  signal?.throwIfAborted();
  const result=await readPage('/api/library'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal});
  signal?.throwIfAborted();
  if(!Array.isArray(result.videos)||result.videos.some(v=>!v||typeof v.id!=='string'||!v.id))throw new Error('Resposta da biblioteca inválida.');
  for(const video of result.videos)records.set(video.id,video);
  const next=result.next_cursor;
  if(next!==null&&next!==undefined&&(typeof next!=='string'||!next))throw new Error('Cursor da biblioteca inválido.');
  if(next&&seen.has(next))throw new Error('A biblioteca repetiu uma página.');
  if(next)seen.add(next);cursor=next;
 }while(cursor);
 return [...records.values()];
}
export function progressItems(financial){
 const items=financial?.progress?.items;
 if(!Array.isArray(items)||items.some(x=>!x||!/^[A-Za-z0-9_-]{5,32}$/.test(x.id??'')||typeof x.version!=='string'||!['upload','transcription','analysis'].includes(x.stage)||!['reserved','started','completed','cancelled','uncertain'].includes(x.status)))throw Error('Andamento dos vídeos indisponível.');
 return items;
}
export async function loadVideoUpdates(read,ids,{signal}={}){
 const records=[];
 for(let start=0;start<ids.length;start+=40){
  signal?.throwIfAborted();
  const requested=ids.slice(start,start+40);
  const page=await read('/api/library?ids='+encodeURIComponent(requested.join(',')),{signal});
  if(!Array.isArray(page.videos)||page.videos.length!==requested.length||new Set(page.videos.map(v=>v?.id)).size!==requested.length||page.videos.some(v=>!requested.includes(v?.id)))throw Error('Atualização incompleta dos vídeos.');
  records.push(...page.videos);
 }
 return records;
}
export function mergeVideoUpdates(videos,updates){
 const map=new Map(videos.map(v=>[v.id,v]));for(const v of updates)map.set(v.id,v);return [...map.values()];
}
export function videoStatus(video,progress,paused=false){
 if(video.status==='needs_attention')return 'Precisa de atenção';
 const label={upload:'vídeo',transcription:'transcrição',analysis:'análise'};
 if(progress?.status==='uncertain')return 'Etapa interrompida';
 if(progress?.status==='started')return {upload:'Baixando vídeo',transcription:'Transcrevendo áudio',analysis:'Analisando vídeo'}[progress.stage]??'Em processamento';
 if(progress?.status==='reserved')return paused?label[progress.stage]?.replace(/^./,c=>c.toUpperCase())+' aguardando retomada':'Preparando '+label[progress.stage];
 if(video.analysis&&video.status==='analyzed')return 'Análise concluída';
 if(video.status==='transcribed')return 'Transcrição concluída · aguardando análise';
 if(video.status==='downloaded')return 'Vídeo baixado · aguardando transcrição';
 return paused?'Na fila · processamento pausado':'Na fila';
}
// Single flight. Import/manual refresh can request one fresh snapshot AFTER an older flight.
export function createLibrarySynchronizer({read,onChange,onError,signal,now=Date.now,fullIntervalMs=60000}){
 let videos=[],financial=null,controls=null,versions=new Map(),initialized=false,lastFull=0,flight=null,queuedFull=false,stopped=false;
 const emit=()=>{signal?.throwIfAborted();if(!stopped)onChange({videos,financial,controls,updatedAt:now()});};
 async function state(){
  const values=await Promise.allSettled([read('/api/controls',{signal}),read('/api/financial',{signal})]);
  signal?.throwIfAborted();
  const errors=values.filter(x=>x.status==='rejected').map(x=>x.reason);
  const next=values[1].status==='fulfilled'?values[1].value:null;let items=null;
  if(next)try{items=progressItems(next);}catch(error){errors.push(error);}
  return {controls:values[0].status==='fulfilled'?values[0].value.automation:null,financial:next,items,error:errors[0]};
 }
 async function cycle(full){
  const before=await state();
  if(full){
   const snapshot=await loadLibrarySnapshot(read,{signal});signal?.throwIfAborted();
   videos=snapshot;financial=before.financial??financial;controls=before.controls??controls;
   if(!before.items&&financial)financial={...financial,progress:{items:financial.progress?.items??[],stale:true}};
   if(before.items)versions=new Map(before.items.map(x=>[x.id,x.version]));initialized=true;lastFull=now();emit();
  }
  // Read again after a full traversal so a result completed during pagination cannot be missed.
  const next=full?await state():before;
  if(next.error)throw next.error;
  const ids=next.items.filter(x=>versions.get(x.id)!==x.version).map(x=>x.id);
  const updates=await loadVideoUpdates(read,ids,{signal});signal?.throwIfAborted();
  videos=mergeVideoUpdates(videos,updates);financial=next.financial;controls=next.controls;
  versions=new Map(next.items.map(x=>[x.id,x.version]));emit();
 }
 function refresh({full=false,afterCurrent=false}={}){
  if(stopped)return Promise.resolve();
  if(flight){if(full&&afterCurrent)queuedFull=true;return flight;}
  flight=(async()=>{
   let nextFull=full||queuedFull||!initialized||now()-lastFull>=fullIntervalMs;
   do{queuedFull=false;await cycle(nextFull);nextFull=queuedFull;}while(queuedFull&&!stopped);
  })().catch(error=>{if(!stopped&&!signal?.aborted&&error.name!=='AbortError')onError(error);}).finally(()=>{flight=null;});
  return flight;
 }
 return {refresh,stop(){stopped=true;queuedFull=false;}};
}
// Fast ticks read progression only; the synchronizer discovers the complete corpus once a minute.
export function watchLibrary(refresh,{document:doc,timers,intervalMs=15000}){
 const tick=()=>{if(doc.visibilityState==='visible')refresh();};
 const timer=timers.setInterval(tick,intervalMs);
 doc.addEventListener('visibilitychange',tick);
 return ()=>{timers.clearInterval(timer);doc.removeEventListener('visibilitychange',tick);};
}
