// Only protected server configuration selects v2 and permits dispatch.
export function reelsProcessingEnabled(config={}){
 const mode=config.reels_runtime_version,flag=config.reels_processing_enabled;
 if(mode!==undefined&&mode!=='v2')throw Error('Versão operacional inválida.');
 if(flag!==undefined&&typeof flag!=='boolean')throw Error('Permissão de processamento deve ser booleana.');
 if(flag===true&&mode!=='v2')throw Error('Processamento exige runtime v2 explícito.');
 return mode==='v2'&&flag===true;
}
