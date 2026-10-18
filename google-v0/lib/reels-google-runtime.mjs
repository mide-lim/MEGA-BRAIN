import {GoogleREST} from './google-rest.mjs';
import {serviceIdentity} from './service-identity.mjs';
import {Firestore} from './firestore.mjs';
import {Storage} from './storage.mjs';
import {googleOperations,createMediaInspectionReceipt} from './google-operations.mjs';
import {mediaTools} from './media-tools.mjs';
import {inspectMedia} from './media-inspector.mjs';
import {workerAuthorization} from './worker-auth.mjs';
import {ReelsRepository} from './reels-repository.mjs';
import {ReelsCatalogueRuntime} from './reels-contextual-catalogue-runtime.mjs';
import {ReelsPipeline,executionId,STAGES} from './reels-pipeline.mjs';
import {ReelsDispatcher} from './reels-dispatcher.mjs';
import {ReelsService} from './reels-service.mjs';
import {ReelsCommandRunner} from './reels-command-runner.mjs';
import {reelsProcessingEnabled} from './reels-runtime-policy.mjs';
import {qualityDigest} from './reels-quality-gate.mjs';
import {knowledgeReadiness} from './reels-quality.mjs';
import {ReelsTaxonomy} from './reels-taxonomy.mjs';
import {ensure} from './reels-runtime.mjs';
const PROJECT='megabrain-v0-1017370021431';
const legacy={acquisition:'upload',transcription:'transcription',analysis:'analysis'};
const denied=()=>Response.json({error:'Processamento real desabilitado nesta entrega.',code:'PROCESSING_DISABLED'},{status:423,headers:{'Cache-Control':'no-store'}});
export function reelsGoogleRuntime(config,preset,{stage,authorize,dependencies={}}={}){
 if(config?.project!==PROJECT||!STAGES.includes(stage))throw Error('Projeto e etapa fixa obrigatórios.');
 const enabled=reelsProcessingEnabled(config);
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
    const video=await repository.raw(job.reelId);
    if(video?.import_hold?.active===true||video?.reels_v2?.operationId!==job.operationId||video.reels_v2.executionId!==job.id)throw Object.assign(Error('Execução não possui mais o Reel.'),{definitive:true,code:'EXECUTION_SUPERSEDED'});
    if(current.status==='submitting'&&(await store.get('reels_controls/'+job.stage))?.data.paused===true)throw Object.assign(Error('Etapa pausada antes da submissão.'),{definitive:true,code:'STAGE_PAUSED'});
   };
   // Preparation may take time. Fence each paid POST again at the transport
   // boundary so a pause after audio preparation cannot submit new STT/Gemini.
   const adapterAPI={project:api.project,request:async(url,options)=>{
    if(options?.method==='POST'&&/^https:\/\/(?:[a-z0-9-]+-)?(?:speech|aiplatform)\.googleapis\.com\//.test(url))await check({executionId:job.id,stage:legacy[job.stage],videoId:job.reelId});
    return api.request(url,options);
   }};
   const video=input.video??await repository.raw(job.reelId);
   const adapter=(dependencies.operationsFactory??googleOperations)({api:adapterAPI,storage,tools,preset,config:{...config,enabled:true,uploads_enabled:true,worker_stage:legacy[stage],single_reel_pipeline_enabled:true,reels_taxonomy_signals_enabled:true,reels_quality_policy_version:'gate_v2'},executionAuthorization:check,executionIds:(id,s)=>executionId(job.operationId,id,s==='upload'?'acquisition':s),preparedAudioKey:id=>id===job.reelId&&video?.audio_key?video.audio_key:null,inspect:dependencies.inspect??inspectMedia,qualityEvidence:{mediaInspection:video?.media_inspection_receipt??null,transcriptionReceipt:video?.transcription_receipt??null},saveQualityReceipt:async receipt=>{
    const path='reels_quality_receipts/'+receipt.id,receiptHash=qualityDigest(receipt);
    const created=await store.create(path,receipt),saved=created.created?created:await store.get(path);
    if(!saved?.data||qualityDigest(saved.data)!==receiptHash)throw Error('Recibo de qualidade salvo diverge; ponteiro preservado.');
    return {id:receipt.id,receiptHash};
   }});
   return {adapter,job,video};
  }
  const operations={
   async acquire(input){const {adapter,job,video}=await scoped(input);
    // An already verified source is reused without consulting Instagram.
    if(video?.media_verified&&video.video_key===`originals/instagram/${job.reelId}/video.mp4`&&/^\d+$/.test(video.video_generation??'')){
     const object=await storage.metadata(video.video_key);if(!object||object.generation!==video.video_generation||Number(object.size)!==video.video_bytes)throw Object.assign(Error('Mídia preservada diverge da referência.'),{definitive:true});
     let receipt=video.media_inspection_receipt,videoSha=video.video_sha256;
     const receiptBody=receipt?Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='receiptId')):null;
     if(!receipt||receipt.version!==1||receipt.sourceIdentity?.key!==video.video_key||receipt.sourceIdentity?.generation!==video.video_generation||receipt.contentSha256!==videoSha||receipt.contentBytes!==video.video_bytes||receipt.decodePassed!==true||receipt.probePassed!==true||receipt.receiptId!=='media_'+qualityDigest(receiptBody)||receipt.durationSeconds!==video.duration_seconds){
      const bytes=await storage.read(video.video_key,{generation:video.video_generation});
      if(bytes.length!==video.video_bytes)throw Error('Bytes da mídia salva divergentes.');
      const media=await (dependencies.inspect??inspectMedia)(bytes);
      if(media.audio_status!=='present')throw Object.assign(Error('Áudio esperado não confirmado pela reinspeção.'),{definitive:true});
      receipt=createMediaInspectionReceipt({video,media,bytes});if(videoSha&&receipt.contentSha256!==videoSha)throw Object.assign(Error('Checksum da mídia preservada diverge.'),{definitive:true});videoSha=receipt.contentSha256;
     }
     return {changes:{video_key:video.video_key,video_generation:video.video_generation,video_bytes:video.video_bytes,video_sha256:videoSha,media_inspection_receipt:receipt,media_verified:true,audio_status:receipt.audioStatus,duration_seconds:receipt.durationSeconds},reused:true};
    }
    if(await storage.metadata(`originals/instagram/${job.reelId}/video.mp4`))throw Object.assign(Error('Objeto existente sem referência verificada; conciliar antes de adquirir.'),{requiresReconciliation:true,code:'MEDIA_REFERENCE_REQUIRES_RECONCILIATION'});
    // Stop proof has its own immutable receipt. Updating the execution here
    // would invalidate the claim version held by saveAndApply after download.
    const result=await adapter.upload({...input,video,recordAcquisitionExtraction:()=>async()=>{await ensure(store,'execution_stops/'+job.id,{id:job.id,reelId:job.reelId,stage:job.stage,owner:job.owner,executorStoppedAt:new Date().toISOString()});}});
    return {changes:result.changes,estimatedCents:result.actual_cents??null,finance:result.finance??null};
   },
   async transcribe(input){const {adapter,video}=await scoped(input);const result=await adapter.transcription({...input,video});return result.operation_name?{pending:true,operationName:result.operation_name,changes:result.changes??{}}:{changes:result.changes,estimatedCents:result.actual_cents??null,finance:result.finance??null};},
   async pollTranscription(input){const {adapter,video}=await scoped(input);const result=await adapter.pollTranscription({...input,video});return result.pending?{pending:true}:{changes:result.changes,estimatedCents:result.actual_cents??null,finance:result.finance??null};},
   async analyze(input){const {adapter,video}=await scoped(input);const result=await adapter.analysis({...input,video});const quality=knowledgeReadiness(result.changes?.analysis);
    const valid=result.changes?.analysis_quality_status==='accepted'&&quality.accepted&&result.qualityGate?.accepted===true&&result.qualityPublication?.policyVersion==='gate_v2';
    const changes={...result.changes};if(!valid&&changes.analysis&&result.qualityGate?.accepted!==false){changes.analysis_candidate=changes.analysis;changes.candidate_analysis_key=changes.analysis_key;changes.candidate_analysis_generation=changes.analysis_generation;changes.analysis=video.analysis??null;changes.analysis_key=video.analysis_key??null;changes.analysis_generation=video.analysis_generation??null;changes.analysis_quality_status='review_required';changes.candidate_quality_receipt=result.qualityPublication?.qualityReceipt??changes.candidate_quality_receipt??null;}
    return {changes,valid,quality:result.qualityGate?{...result.qualityGate,accepted:valid,state:valid?'supported':result.qualityGate.state==='invalid'?'invalid':'inconclusive',readiness:quality}:{accepted:false,state:'inconclusive',checks:[],gaps:[],readiness:quality},qualityPublication:valid?result.qualityPublication:null,artifact:{key:result.changes?.candidate_analysis_key??result.changes?.analysis_key??null,generation:result.changes?.candidate_analysis_generation??result.changes?.analysis_generation??null},estimatedCents:result.actual_cents??null,finance:result.finance??null};
   }
  };
  const taxonomy=new ReelsTaxonomy({repository});
  const pipeline=new ReelsPipeline({repository,store,operations,processingEnabled:enabled,requiredQualityPolicyVersion:'gate_v2',effectiveCapacity:config.reels_effective_capacity??{acquisition:1,transcription:1,analysis:1},onPublished:job=>new ReelsCatalogueRuntime({repository}).project(job.reelId,{type:'publicationAccepted',eventId:job.id}),onQueued:async job=>{const receipt=await dispatcher.enqueue(job);if(receipt.status!=='sent')throw Error('Entrega à fila não confirmada; retomar pelo outbox.');return receipt;}});
  const service=new ReelsService({repository,processingEnabled:enabled,onQueued:async job=>{const receipt=await dispatcher.enqueue(job);if(receipt.status!=='sent')throw Error('Despacho requer retomada.');return receipt;},onCommandQueued:(operation,options)=>dispatcher.enqueueControl(operation,options)});
  const runner=new ReelsCommandRunner({service,dispatcher,enabled,pageSize:25});
  runtime={pipeline,store,repository,dispatcher,service,runner};return runtime;
 }
 return async request=>{
  if(!enabled)return denied();
  if(await auth?.(request)!==true)return Response.json({error:'Acesso negado.'},{status:401});
  const route=new URL(request.url).pathname,control=route==='/tasks/control';
  if(request.method!=='POST'||!['/tasks/run','/tasks/control'].includes(route))return Response.json({error:'Rota inválida.'},{status:405});
  if(control&&stage!=='acquisition')return Response.json({error:'Controle exige serviço de aquisição.'},{status:409});
  let body;try{
   const text=await request.text();if(Buffer.byteLength(text)>2048)throw Error();body=JSON.parse(text);
   const allowed=control?['operationId','sequence','outboxId']:['executionId','poll','outboxId'];
   if(!body||Object.keys(body).some(k=>!allowed.includes(k))||!/^[a-f0-9]{64}$/.test((control?body.operationId:body.executionId)??'')||body.outboxId!==undefined&&!/^[a-f0-9]{64}$/.test(body.outboxId)||control&&(!Number.isSafeInteger(body.sequence)||body.sequence<0)||!control&&body.poll!==undefined&&typeof body.poll!=='boolean')throw Error();
  }catch{return Response.json({error:'Tarefa inválida.'},{status:400});}
  try{
   const {pipeline,store,dispatcher,runner}=build();
   if(control){
    // Control always carries the durable outbox identity; only the queue identity
    // can authenticate this route. It runs a finite page and awaits continuation.
    await dispatcher.acknowledge({...body,stage});
    return Response.json(await runner.run(body),{headers:{'Cache-Control':'no-store'}});
   }
   const saved=await store.get('reels_executions/'+body.executionId);if(!saved||saved.data.stage!==stage||body.poll&&stage!=='transcription')return Response.json({error:'Tarefa fora da etapa fixa.'},{status:409});
   if(body.outboxId)await dispatcher.acknowledge({...body,poll:Boolean(body.poll),stage});
   const result=body.poll?await pipeline.collect(body):await pipeline.run(body);
   const retryable=['TECHNICAL_BACKPRESSURE','EXECUTION_IN_PROGRESS'].includes(result.reason)||result.status==='applying';return Response.json(result,{status:retryable?503:200,headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Execução requer conferência; estado preservado.'},{status:503,headers:{'Cache-Control':'no-store'}});}
 };
}
