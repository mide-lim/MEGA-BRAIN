import {ReelsService} from './reels-service.mjs';
import {ReelsPipeline} from './reels-pipeline.mjs';
import {ReelsDispatcher} from './reels-dispatcher.mjs';
import {ReelsReconciliation} from './reels-reconciliation.mjs';
import {ReelsCatalogueRuntime} from './reels-contextual-catalogue-runtime.mjs';
import {ReelsSemanticCurator} from './reels-semantic-curator.mjs';
import {ReelsSemanticDispatcher} from './reels-semantic-dispatcher.mjs';
import {reelsProcessingEnabled} from './reels-runtime-policy.mjs';
import {fail} from './reels-runtime.mjs';
const PROJECT='megabrain-v0-1017370021431';
const stages={upload:['acquisition','v0-acquisition'],transcription:['transcription','v0-transcription'],analysis:['analysis','v0-analysis']};
export function validateReelsStageRoutes(routes){
 for(const [key,[stage,queue]] of Object.entries(stages)){
  const route=routes?.[key];
  const allowed=[`https://megabrain-v0-${stage}-711042421394.us-central1.run.app`,`https://megabrain-v0-${stage}-i5gepiv7hq-uc.a.run.app`];
  if(route?.queue!==queue||!allowed.includes(route.workerOrigin))throw Error('Rota deve apontar para a etapa existente no projeto autorizado.');
 }
 return routes;
}
export function reelsWebRuntime({repository,api,config={},clock=Date.now}){
 if(api?.project!==PROJECT||(config.project_id??config.project)!==PROJECT)throw Error('Projeto de operação web inválido.');
 const processingEnabled=reelsProcessingEnabled(config),store=repository.store;
 if(processingEnabled)validateReelsStageRoutes(config.stage_routes);
 const dispatcher=new ReelsDispatcher({api,store,routes:config.stage_routes,enabled:processingEnabled,clock});
 const confirm=async promise=>{const receipt=await promise;if(receipt?.status!=='sent')throw fail('DISPATCH_UNCONFIRMED','Encaminhamento ainda sem confirmação. Recupere a mesma operação.',503);return receipt;};
 const onQueued=job=>confirm(dispatcher.enqueue(job));
 const onCommandQueued=(operation,options)=>confirm(dispatcher.enqueueControl(operation,options));
 const service=new ReelsService({repository,processingEnabled,clock,onQueued,onCommandQueued});
 const catalogue=new ReelsCatalogueRuntime({repository,clock}),semanticDispatcher=new ReelsSemanticDispatcher({api,workerOrigin:config.stage_routes?.analysis?.workerOrigin}),semantic=new ReelsSemanticCurator({repository,clock,enqueue:job=>semanticDispatcher.enqueue(job)});
 // Deliberately no provider adapters in the web. Recovering an external
 // operation creates a poll outbox for its worker, never a new submission.
 const pipeline=new ReelsPipeline({repository,store,operations:{},processingEnabled,clock,onQueued,onPublished:job=>catalogue.project(job.reelId,{type:'publicationAccepted',eventId:job.id})});
 const reconciliation=new ReelsReconciliation({repository,store,pipeline,processingEnabled,clock});
 return {service,pipeline,reconciliation,dispatcher,processingEnabled,semantic};
}
