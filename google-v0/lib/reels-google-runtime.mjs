import {GoogleREST} from './google-rest.mjs';
import {serviceIdentity} from './service-identity.mjs';
import {Firestore} from './firestore.mjs';
import {Storage} from './storage.mjs';
import {googleOperations} from './google-operations.mjs';
import {mediaTools} from './media-tools.mjs';
import {inspectMedia} from './media-inspector.mjs';
import {workerAuthorization} from './worker-auth.mjs';
import {ReelsRepository} from './reels-repository.mjs';
import {ReelsPipeline,executionId,STAGES} from './reels-pipeline.mjs';
import {ReelsDispatcher} from './reels-dispatcher.mjs';
import {knowledgeReadiness} from './reels-quality.mjs';
import {ReelsTaxonomy} from './reels-taxonomy.mjs';
import {ensure} from './reels-runtime.mjs';
const PROJECT='megabrain-v0-1017370021431';
const legacy={acquisition:'upload',transcription:'transcription',analysis:'analysis'};
const denied=()=>Response.json({error:'Processamento real desabilitado nesta entrega.',code:'PROCESSING_DISABLED'},{status:423,headers:{'Cache-Control':'no-store'}});
export function reelsGoogleRuntime(config,preset,{stage,authorize,dependencies={}}={}){
 if(config?.project!==PROJECT||!STAGES.includes(stage))throw Error('Projeto e etapa fixa obrigatórios.');
 const enabled=config.reels_processing_enabled===true;
 // Factories are lazy: a disabled runtime never requests service identity,
 // creates provider adapters, reads a database or dispatches a task.
 let runtime;
 const auth=authorize??(enabled?workerAuthorization({audience:config.worker_origin}):null);
 function build(){
  if(runtime)return runtime;
  const api=dependencies.api??new GoogleREST({project:PROJECT,buckets:[PROJECT+'-media'],tokenProvider:serviceIdentity({project:PROJECT,account:'v0-worker'})});
  const store=dependencies.store??new Firestore(api),repository=dependencies.repository??new ReelsRepository({store});
  const storage=dependencies.storage??new Storage(api,PROJECT+'-media',{maxBytes:100000000});
  const tools=dependencies.tools??mediaTools({downloadEnabled:true});
  const dispatcher=dependencies.dispatcher??new ReelsDispatcher({api,store,routes:config.stage_routes,enabled});
  async function scoped(input){
   const snapshot=await store.get('reels_executions/'+input.executionId),job=snapshot?.data;
   if(!job||job.reelId!==input.videoId||job.stage!==stage||job.owner!==input.claim?.owner||!['submitting','collecting'].includes(job.status))throw Error('Claim não autoriza esta operação.');
   const check=async({executionId:id,stage:adapterStage,videoId})=>{
    const current=(await store.get('reels_executions/'+job.id))?.data;
    if(!enabled||id!==job.id||videoId!==job.reelId||adapterStage!==legacy[job.stage]||current?.owner!==job.owner||!['submitting','collecting'].includes(current.status))throw Error('Execução não autorizada.');
   };
   const video=input.video??await repository.raw(job.reelId);
   const adapter=(dependencies.operationsFactory??googleOperations)({api,storage,tools,preset,config:{...config,enabled:true,uploads_enabled:true,worker_stage:legacy[stage],single_reel_pipeline_enabled:true,reels_taxonomy_signals_enabled:true},executionAuthorization:check,executionIds:(id,s)=>executionId(job.operationId,id,s==='upload'?'acquisition':s),preparedAudioKey:id=>id===job.reelId&&video?.audio_key?video.audio_key:null});
   return {adapter,job,video};
  }
  const operations={
   async acquire(input){const {adapter,job,video}=await scoped(input);
    // An already verified source is reused without consulting Instagram.
    if(video?.media_verified&&video.video_key===`originals/instagram/${job.reelId}/video.mp4`&&/^\d+$/.test(video.video_generation??'')){
     const object=await storage.metadata(video.video_key);if(!object||object.generation!==video.video_generation||Number(object.size)!==video.video_bytes)throw Object.assign(Error('Mídia preservada diverge da referência.'),{definitive:true});
     return {changes:{video_key:video.video_key,video_generation:video.video_generation,video_bytes:video.video_bytes,media_verified:true,audio_status:video.audio_status,duration_seconds:video.duration_seconds},reused:true};
    }
    // Stop proof has its own immutable receipt. Updating the execution here
    // would invalidate the claim version held by saveAndApply after download.
    const result=await adapter.upload({...input,video,recordAcquisitionExtraction:()=>async()=>{await ensure(store,'execution_stops/'+job.id,{id:job.id,reelId:job.reelId,stage:job.stage,owner:job.owner,executorStoppedAt:new Date().toISOString()});}});
    return {changes:result.changes,estimatedCents:result.actual_cents??null};
   },
   async transcribe(input){const {adapter,video}=await scoped(input);const result=await adapter.transcription({...input,video});return result.operation_name?{pending:true,operationName:result.operation_name,changes:result.changes??{}}:{changes:result.changes,estimatedCents:result.actual_cents??null};},
   async pollTranscription(input){const {adapter}=await scoped(input);const result=await adapter.pollTranscription(input);return result.pending?{pending:true}:{changes:result.changes,estimatedCents:result.actual_cents??null};},
   async analyze(input){const {adapter,video}=await scoped(input);const result=await adapter.analysis({...input,video});const quality=knowledgeReadiness(result.changes?.analysis);
    const valid=result.changes?.analysis_quality_status==='accepted'&&quality.accepted;
    const changes={...result.changes};if(!valid&&changes.analysis){changes.analysis_candidate=changes.analysis;changes.candidate_analysis_key=changes.analysis_key;changes.candidate_analysis_generation=changes.analysis_generation;changes.analysis=video.analysis??null;changes.analysis_key=video.analysis_key??null;changes.analysis_generation=video.analysis_generation??null;changes.analysis_quality_status='review_required';}
    return {changes,valid,quality,artifact:{key:result.changes?.candidate_analysis_key??result.changes?.analysis_key??null,generation:result.changes?.candidate_analysis_generation??result.changes?.analysis_generation??null},estimatedCents:result.actual_cents??null};
   }
  };
  const taxonomy=new ReelsTaxonomy({repository});
  const pipeline=new ReelsPipeline({repository,store,operations,processingEnabled:enabled,effectiveCapacity:config.reels_effective_capacity??{acquisition:1,transcription:1,analysis:1},onPublished:job=>taxonomy.discover({automatic:true,sourceReelId:job.reelId,sourceExecutionId:job.id}),onQueued:async job=>{const receipt=await dispatcher.enqueue(job);if(receipt.status!=='sent')throw Error('Entrega à fila não confirmada; retomar pelo outbox.');return receipt;}});
  runtime={pipeline,store,repository,dispatcher};return runtime;
 }
 return async request=>{
  if(!enabled)return denied();
  if(await auth?.(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/tasks/run')return Response.json({error:'Rota inválida.'},{status:405});
  let body;try{const text=await request.text();if(Buffer.byteLength(text)>2048)throw Error();body=JSON.parse(text);if(!body||Object.keys(body).some(k=>!['executionId','poll'].includes(k))||!/^[a-f0-9]{64}$/.test(body.executionId??'')||body.poll!==undefined&&typeof body.poll!=='boolean')throw Error();}catch{return Response.json({error:'Tarefa inválida.'},{status:400});}
  try{const {pipeline,store}=build();const saved=await store.get('reels_executions/'+body.executionId);if(!saved||saved.data.stage!==stage||body.poll&&stage!=='transcription')return Response.json({error:'Tarefa fora da etapa fixa.'},{status:409});
   const result=body.poll?await pipeline.collect(body):await pipeline.run(body);
   const retryable=['TECHNICAL_BACKPRESSURE','EXECUTION_IN_PROGRESS'].includes(result.reason)||result.status==='applying';return Response.json(result,{status:retryable?503:200,headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Execução requer conferência; estado preservado.'},{status:503,headers:{'Cache-Control':'no-store'}});}
 };
}
