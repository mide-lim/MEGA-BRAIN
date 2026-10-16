import {validateTask} from './worker-queue.mjs';

export const workerStages=Object.freeze(['upload','transcription','analysis']);
export function stageConfig(config,stage){
 if(!workerStages.includes(stage)||config?.worker_stage!==stage)throw Error('Etapa fixa do worker diverge da configuração.');
 if(typeof config.enabled!=='boolean'||typeof config.dispatch_enabled!=='boolean'||typeof config.admission_enabled!=='boolean')throw Error('Controles explícitos de ativação obrigatórios.');
 if(config.assisted_upload_enabled===true||config.assisted_single_upload_enabled===true)throw Error('Modo assistido legado não pertence aos workers por etapa.');
 if(!config.stage_routes||Object.keys(config.stage_routes).sort().join(',')!=='analysis,transcription,upload'||config.stage_routes[stage]?.workerOrigin!==config.worker_origin)throw Error('Rotas das três filas e origem própria obrigatórias.');
 if(stage!=='upload'&&config.admission_enabled!==false)throw Error('Somente aquisição pode admitir vídeos.');
 if(config.enabled&&(!Number.isSafeInteger(config.quotes?.[stage])||config.quotes[stage]<1))throw Error('Quote da própria etapa obrigatória.');
 return config;
}

// The role is server-owned, never an HTTP/task override. Existing claims,
// reservations, provider operations and artifacts remain owned by WorkerFlow.
export function stageBoundFlow(flow,stage,{enabled=true}={}){
 if(!workerStages.includes(stage)||!flow||typeof flow.run!=='function'||typeof flow.poll!=='function'||typeof enabled!=='boolean')throw Error('Fluxo e etapa fixa obrigatórios.');
 const blocked=()=>({status:'blocked',reason:'stage_disabled'});
 return Object.freeze({
  quotes:flow.quotes,
  async run(input){
   const task=validateTask(input);
   if(task.stage!==stage||task.poll!==0)throw Error('Tarefa fora da etapa fixa do worker.');
   return enabled?flow.run(task):blocked();
  },
  async poll(input){
   if(stage!=='transcription'||!input||Object.keys(input).some(k=>k!=='videoId')||!/^[A-Za-z0-9_-]{5,32}$/.test(input.videoId??''))throw Error('Consulta exclusiva de transcrição.');
   return enabled?flow.poll(input):blocked();
  }
 });
}
