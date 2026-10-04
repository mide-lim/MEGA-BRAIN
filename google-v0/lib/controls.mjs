// Google v0 owns its control schema; it does not load the legacy application.
export function automationChanges(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Pedido inválido.');
  const allowed=new Set(['action','enabled','transcription_enabled','analysis_enabled','parallelism']);
  if(Object.keys(body).some(key=>!allowed.has(key)))throw new Error('Campo inválido.');
  if(body.action==='pause'||body.action==='resume'){
    if(Object.keys(body).length!==1)throw new Error('Ação deve ser isolada.');
    return {enabled:body.action==='resume'};
  }
  if(body.action!=='set')throw new Error('Ação inválida.');
  const changes={};
  for(const key of ['enabled','transcription_enabled','analysis_enabled']){
    if(key in body){if(typeof body[key]!=='boolean')throw new Error('Use ativado ou desativado.');changes[key]=body[key];}
  }
  if('parallelism'in body){
    if(!Number.isInteger(body.parallelism)||body.parallelism<1||body.parallelism>4)throw new Error('Escolha 1x a 4x.');
    changes.parallelism=body.parallelism;
  }
  if(!Object.keys(changes).length)throw new Error('Nenhuma alteração fornecida.');
  return changes;
}
