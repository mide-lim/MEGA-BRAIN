import {randomUUID}from 'node:crypto';
export function mediaAPI({repository,signer,ledger,authorize,enabled=false,maximumCents}){
  const reply=(value,status)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  return async(request,id)=>{
    try{if(await authorize(request)!==true)return reply({error:'Não autorizado'},401);}catch{return reply({error:'Não autorizado'},401);}
    if(request.method!=='GET')return reply({error:'Método inválido'},405);
    if(enabled!==true||!Number.isSafeInteger(maximumCents)||maximumCents<1)return reply({error:'Reprodução Google ainda não ativada com reserva financeira.'},503);
    if(!/^[A-Za-z0-9_-]{5,32}$/.test(id??''))return reply({error:'Vídeo inválido'},400);
    try{
      const record=await repository.video(id);if(!record)return reply({error:'Vídeo não encontrado'},404);
      if(!record.media_verified||record.video_key!==`originals/instagram/${id}/video.mp4`||!/^\d{1,30}$/.test(record.video_generation??'')||!Number.isSafeInteger(record.video_bytes)||record.video_bytes<1||record.video_bytes>100000000)return reply({error:'Mídia Google ainda não validada.'},409);
      const executionId='media_'+randomUUID().replaceAll('-','');
      const result=await signer.issue({id,generation:record.video_generation,
        financialCheck:()=>ledger.reserve({executionId,videoId:id,stage:'media_access',maximumCents}),
        markStarted:()=>ledger.transition(executionId,'start'),markUncertain:()=>ledger.transition(executionId,'uncertain')});
      // Keep the full transfer reservation: issuing a URL does not prove usage/cost.
      return reply(result,200);
    }catch{return reply({error:'Não foi possível autorizar a reprodução. A reserva deve ser conferida antes de repetir.'},503);}
  };
}
