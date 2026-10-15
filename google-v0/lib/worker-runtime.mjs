import {assistedUploadHandler} from './assisted-upload.mjs';
import {WorkerAdmission,admissionHandler} from './worker-admission.mjs';
import {metadataProbeHandler} from './metadata-probe.mjs';
import {serviceIdentity} from './service-identity.mjs';
import {GoogleREST} from './google-rest.mjs';
import {Firestore} from './firestore.mjs';
import {Storage} from './storage.mjs';
import {StorageCapacity} from './storage-capacity.mjs';
import {FinancialLedger} from './financial-ledger.mjs';
import {WorkerFlow} from './worker-flow.mjs';
import {AcquisitionControl} from './acquisition-control.mjs';
import {ExecutionStops} from './execution-stops.mjs';
import {workerReservationGate} from './worker-reservation-gate.mjs';
import {googleOperations} from './google-operations.mjs';
import {mediaTools} from './media-tools.mjs';
import {WorkerQueue,workerHandler} from './worker-queue.mjs';
import {workerAuthorization} from './worker-auth.mjs';

// No HTTP listener or deployment here. A private authenticated queue handler
// must be connected separately; creating this factory makes no Google calls.
export function workerRuntime(config,preset,{withHandler=false}={}){
  if(config?.project!=='megabrain-v0-1017370021431'||config.cost_accounting!=='conservative_estimate_not_invoice')throw new Error('Configuração independente do worker obrigatória.');
  if(config.assisted_upload_enabled!==undefined&&typeof config.assisted_upload_enabled!=='boolean')throw Error('Modo assistido inválido.');
  const assisted=config.assisted_upload_enabled===true;
  if(config.assisted_single_upload_enabled!==undefined&&typeof config.assisted_single_upload_enabled!=='boolean')throw Error('Escopo unitário inválido.');
  const single=config.assisted_single_upload_enabled===true;
  if(single&&(!assisted||config.pilot_video_ids?.length!==1||!Number.isSafeInteger(config.quotes?.upload)||config.quotes.upload<1||config.quotes.upload>100))throw Error('Escopo unitário exige modo assistido, um vídeo e teto até100centavos.');
  if(assisted&&(config.dispatch_enabled!==false||config.admission_enabled!==false||!Array.isArray(config.pilot_video_ids)||!config.pilot_video_ids.length||config.pilot_video_ids.length>6||new Set(config.pilot_video_ids).size!==config.pilot_video_ids.length||config.pilot_video_ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{5,32}$/.test(id))))throw Error('Modo assistido exige escopo privado e produtores desligados.');
  const project=config.project,bucket=project+'-media';
  const api=new GoogleREST({project,buckets:[bucket],tokenProvider:serviceIdentity({project,account:'v0-worker'})});
  const store=new Firestore(api);
  const tools=mediaTools({downloadEnabled:config.downloads_enabled===true});
  if(config.analysis_revision&&config.analysis_revision!==preset.version)throw new Error('Preset diverge da revisão autorizada.');
  const stops=new ExecutionStops({store,analysisRevision:config.analysis_revision??null});
  const acquisition=new AcquisitionControl({store,maximumParallelism:assisted?1:4,verifyExecutionStopped:input=>stops.verify(input)});
  const makeFlow=(assistedScope=null)=>{
    const capacity=new StorageCapacity(store,{assistedScope});
    const storage=new Storage(api,bucket,{admitObject:input=>capacity.admit(input),reserveObject:input=>capacity.reserveResult(input)});
    const ledger=new FinancialLedger(store,{assistedScope});
    const operations=googleOperations({api,storage,tools,preset,config,gate:workerReservationGate(store,{assistedScope})});
    return new WorkerFlow({assistedScope,acquisition,recordExecutionStopped:input=>stops.record(input),verifyExecutionStopped:input=>stops.verify(input),store,ledger,operations,quotes:config.quotes,eligibleVideos:config.pilot_video_ids??[],analysisRevision:config.analysis_revision??null,batchId:config.batch_id??null,autoHoldTerminalSources:assistedScope?false:config.auto_hold_terminal_sources===true});
  };
  const flow=makeFlow();
  if(!withHandler)return flow;
  const authorize=workerAuthorization({audience:config.worker_origin});
  const assistedHandler=assistedUploadHandler({store,flow,authorize,enabled:assisted,allowedVideoIds:config.pilot_video_ids??[],createScopedFlow:single?makeFlow:null});
  if(assisted)return async request=>{
    if(new URL(request.url).pathname==='/tasks/assisted-upload')return assistedHandler(request);
    if(await authorize(request)!==true)return Response.json({error:'Acesso negado.'},{status:401,headers:{'Cache-Control':'no-store'}});
    return Response.json({status:'blocked',reason:'assisted_only'},{status:409,headers:{'Cache-Control':'no-store'}});
  };
  const queue=new WorkerQueue({api,store,workerOrigin:config.worker_origin,enabled:config.dispatch_enabled===true});
  const processing=workerHandler({flow,queue,authorize});
  const probe=metadataProbeHandler({store,tools,authorize,batchId:config.batch_id,eligibleVideos:config.pilot_video_ids??[]});
  const admission=admissionHandler({authorize,admission:new WorkerAdmission({store,queue,acquisition,batchId:config.batch_id,quotes:config.quotes,enabled:config.admission_enabled===true})});
  return request=>{const path=new URL(request.url).pathname;return path==='/tasks/assisted-upload'?assistedHandler(request):path==='/tasks/diagnose'?probe(request):path==='/tasks/admit'?admission(request):processing(request);};
}
