// Framework-neutral route handlers; identity comes from the v0 session adapter.
// No database, credential or production fallback is accepted here.
export function libraryAPI({repository,ledgerStore,authorize,sameOrigin,linkImportEnabled=false}){
  if(!repository||!ledgerStore||typeof authorize!=='function'||typeof sameOrigin!=='function')throw new Error('Dependências isoladas obrigatórias.');
  const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
  async function access(request){try{return (await authorize(request))===true;}catch{return false;}}
  return {
    async importLinks(request){
      if(!await access(request))return reply({error:'Não autorizado'},401);
      if(request.method!=='POST')return reply({error:'Método inválido'},405);
      if(!sameOrigin(request))return reply({error:'Origem inválida'},403);
      if(linkImportEnabled!==true)return reply({error:'Cadastro de links Google ainda não ativado.'},503);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Use JSON'},415);
      let body;
      try{const reader=request.body?.getReader();if(!reader)return reply({error:'Pedido vazio'},400);
        const chunks=[];let total=0;try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>16384){await reader.cancel();return reply({error:'Pedido muito grande'},413);}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
        body=JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
        if(!body||typeof body.links!=='string'||Object.keys(body).some(k=>k!=='links'))return reply({error:'Envie somente os links.'},400);
      }catch{return reply({error:'Pedido inválido'},400);}
      try{return reply(await repository.registerLinks(body.links));}catch{return reply({error:'Não foi possível cadastrar. Confira os links e atualize a biblioteca antes de reenviar.'},400);}
    },
    async library(request){
      if(!await access(request))return reply({error:'Não autorizado'},401);
      if(request.method!=='GET')return reply({error:'Método inválido'},405);
      const url=new URL(request.url),cursor=url.searchParams.get('cursor')??undefined;
      if(cursor&&cursor.length>4096)return reply({error:'Cursor inválido'},400);
      try{return reply(await repository.page({cursor,pageSize:40}));}catch{return reply({error:'Biblioteca Google temporariamente indisponível.'},503);}
    },
    async controls(request){
      if(!await access(request))return reply({error:'Não autorizado'},401);
      if(request.method==='GET'){
        try{return reply({automation:await repository.controls()});}catch{return reply({error:'Controles indisponíveis.'},503);}
      }
      if(request.method!=='POST')return reply({error:'Método inválido'},405);
      if(!sameOrigin(request))return reply({error:'Origem inválida'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Use JSON'},415);
      // Bound request consumption even when Content-Length is omitted.
      let raw='';
      try{
        const reader=request.body?.getReader();if(!reader)return reply({error:'Pedido vazio'},400);
        const chunks=[];let total=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>2048){await reader.cancel();return reply({error:'Pedido muito grande'},413);}chunks.push(Buffer.from(value));}}
        finally{reader.releaseLock();}
        raw=Buffer.concat(chunks,total).toString('utf8');
      }catch{return reply({error:'Pedido inválido'},400);}
      let body;try{body=JSON.parse(raw);}catch{return reply({error:'JSON inválido'},400);}
      try{return reply({automation:await repository.updateControls(body)});}
      catch(error){if([409,412].includes(error.status))return reply({error:'Os controles mudaram. Atualize a tela antes de tentar novamente.'},409);return reply({error:'Não foi possível salvar os controles.'},400);}
    },
    async financial(request){
      if(!await access(request))return reply({error:'Não autorizado'},401);
      if(request.method!=='GET')return reply({error:'Método inválido'},405);
      try{
        const state=(await ledgerStore.get('settings/financial'))?.data;
        if(!state)return reply({configured:false,paused:true});
        const pending=Object.values(state.jobs??{});
        return reply({configured:true,paused:state.paused!==false,coverage_verified:state.coverage_verified===true,
          pilot_envelope_cents:state.pilot_envelope_cents,ongoing_commitment_cents:state.ongoing_commitment_cents,
          allocation_cents:state.allocation_cents,reserve_cents:state.reserve_cents,spent_cents:state.spent_cents,reserved_cents:state.reserved_cents,
          remaining_credit_cents:state.remaining_credit_cents,balance_observed_at:state.balance_observed_at,credit_expires_at:state.credit_expires_at,
          uncertain_operations:pending.filter(j=>j.status==='uncertain').length,
          note:'Controle interno; não é bloqueio de cobrança do Google. Saldo atualizado e custos persistentes precisam de reconciliação.'});
      }catch{return reply({error:'Controle financeiro indisponível; novos trabalhos devem permanecer pausados.'},503);}
    }
  };
}
