import {serviceIdentity} from './service-identity.mjs';
import {GoogleREST} from './google-rest.mjs';
import {Firestore} from './firestore.mjs';
import {Storage} from './storage.mjs';
import {StorageCapacity} from './storage-capacity.mjs';
import {FinancialLedger} from './financial-ledger.mjs';
import {WorkerFlow} from './worker-flow.mjs';
import {workerReservationGate} from './worker-reservation-gate.mjs';
import {googleOperations} from './google-operations.mjs';
import {mediaTools} from './media-tools.mjs';
import {WorkerQueue,workerHandler} from './worker-queue.mjs';
import {workerAuthorization} from './worker-auth.mjs';

// No HTTP listener or deployment here. A private authenticated queue handler
// must be connected separately; creating this factory makes no Google calls.
export function workerRuntime(config,preset,{withHandler=false}={}){
  if(config?.project!=='megabrain-v0-1017370021431'||config.cost_accounting!=='conservative_estimate_not_invoice')throw new Error('Configuração independente do worker obrigatória.');
  const project=config.project,bucket=project+'-media';
  const api=new GoogleREST({project,buckets:[bucket],tokenProvider:serviceIdentity({project,account:'v0-worker'})});
  const store=new Firestore(api),capacity=new StorageCapacity(store),storage=new Storage(api,bucket,{admitObject:input=>capacity.admit(input),reserveObject:input=>capacity.reserveResult(input)}),ledger=new FinancialLedger(store);
  const tools=mediaTools({downloadEnabled:config.downloads_enabled===true});
  const operations=googleOperations({api,storage,tools,preset,config,gate:workerReservationGate(store)});
  if(config.analysis_revision&&config.analysis_revision!==preset.version)throw new Error('Preset diverge da revisão autorizada.');
  const flow=new WorkerFlow({store,ledger,operations,quotes:config.quotes,eligibleVideos:config.pilot_video_ids??[],analysisRevision:config.analysis_revision??null});
  if(!withHandler)return flow;
  const queue=new WorkerQueue({api,store,workerOrigin:config.worker_origin,enabled:config.dispatch_enabled===true});
  return workerHandler({flow,queue,authorize:workerAuthorization({audience:config.worker_origin})});
}
