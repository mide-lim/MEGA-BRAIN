// Keep a complete snapshot: a failed page must never replace the visible library.
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
  if(next&&seen.has(next))throw new Error('A biblioteca repetiu uma página. Tente atualizar novamente.');
  if(next)seen.add(next);cursor=next;
 }while(cursor);
 return [...records.values()];
}
// Refresh only a visible screen; load() owns the non-overlap guard.
export function watchLibrary(refresh,{document:doc,timers,intervalMs=60000}){
 const tick=()=>{if(doc.visibilityState==='visible')refresh();};
 const timer=timers.setInterval(tick,intervalMs);
 doc.addEventListener('visibilitychange',tick);
 return ()=>{timers.clearInterval(timer);doc.removeEventListener('visibilitychange',tick);};
}
