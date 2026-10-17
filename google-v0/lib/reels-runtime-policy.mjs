// Only protected server configuration selects v2 and permits dispatch.
export function reelsProcessingEnabled(config={}){
 const mode=config.reels_runtime_version,flag=config.reels_processing_enabled;
 if(mode!==undefined&&mode!=='v2')throw Error('Versão operacional inválida.');
 if(flag!==undefined&&typeof flag!=='boolean')throw Error('Permissão de processamento deve ser booleana.');
 if(flag===true&&mode!=='v2')throw Error('Processamento exige runtime v2 explícito.');
 return mode==='v2'&&flag===true;
}

// A protected deployment fence can only select a closed v2 runtime. Enabling
// processing requires removing this fence under a separate reviewed operation.
export function closedReleaseConfig(config={},env=process.env){
 const value=env.MEGABRAIN_REELS_CLOSED_RELEASE;
 if(value===undefined)return config;
 if(value!=='v2')throw Error('Publicação fechada inválida.');
 return {...config,reels_closed_release:true,reels_runtime_version:'v2',reels_processing_enabled:false};
}
