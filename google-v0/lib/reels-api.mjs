import {ReelsCatalogueRuntime} from './reels-contextual-catalogue-runtime.mjs';
import {ReelsService} from './reels-service.mjs';
import {ReelsTaxonomy} from './reels-taxonomy.mjs';
import {ReelsFinance} from './reels-finance.mjs';
import {ReelsReconciliation} from './reels-reconciliation.mjs';
import {ReelsContextualCurator} from './reels-contextual-curation.mjs';
import {ReelsCurationCalibration} from './reels-curation-calibration.mjs';
import {fail,safeError} from './reels-runtime.mjs';
const headers={'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'};
const response=(data,status=200)=>Response.json(data,{status,headers});
async function body(request){const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>1048576))throw fail('BODY_TOO_LARGE','Conteúdo excede o limite.',413);if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw fail('INVALID_CONTENT_TYPE','Envie JSON.',415);let bytes=0,text='';if(!request.body)throw fail('INVALID_JSON','JSON ausente.');const reader=request.body.getReader(),decoder=new TextDecoder();try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1048576){await reader.cancel();throw fail('BODY_TOO_LARGE','Conteúdo excede o limite.',413);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}try{const result=JSON.parse(text);if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{throw fail('INVALID_JSON','JSON inválido.');}}
function query(url){const result=Object.fromEntries(url.searchParams);if(result.limit!==undefined){if(!/^\d+$/.test(result.limit)||Number(result.limit)<1||Number(result.limit)>100)throw fail('INVALID_LIMIT','Limite inválido.');result.limit=Number(result.limit);}for(const [k,v]of Object.entries(result)){if(typeof v==='string'&&v.length>(k==='cursor'?8192:k==='facets'?4096:500))throw fail('INVALID_INPUT','Filtro muito longo.');}return result;}
export function reelsAPI({repository,authorize,sameOrigin,processingEnabled=false,clock=Date.now,onQueued,onCommandQueued,contextual,service=new ReelsService({repository,processingEnabled,clock,onQueued,onCommandQueued}),reconciliation=new ReelsReconciliation({repository,processingEnabled,clock})}){
 const taxonomy=new ReelsTaxonomy({repository,clock}),finance=new ReelsFinance({repository,clock});
 let catalogue;
 const getCatalogue=()=>catalogue??=new ReelsCatalogueRuntime({repository,clock});
 let contextualCurator=contextual;
 const getContextual=()=>contextualCurator??=new ReelsContextualCurator({repository,clock});
 repository.contextualMatchingIds=async filters=>getContextual().matchingIds(filters);
 let calibration;
 const getCalibration=()=>calibration??=new ReelsCurationCalibration({repository,contextual:getContextual(),clock});
 const controls={processingAllowed:processingEnabled===true,processingReason:processingEnabled===true?null:'Processamento real desabilitado nesta entrega.'};
 return async function handle(request){
  try{
   if(!await authorize(request))return response({error:'Não autorizado.',code:'UNAUTHORIZED'},401);
   if(typeof repository.contextualContributions==='function')getCatalogue();
   const url=new URL(request.url);if(!url.pathname.startsWith('/api/reels/'))throw fail('NOT_FOUND','Rota não encontrada.',404);const path=url.pathname.slice('/api/reels/'.length),parts=path.split('/');
   if(!['GET','POST'].includes(request.method))throw fail('METHOD_NOT_ALLOWED','Método não permitido.',405);
   if(request.method==='POST'&&!await sameOrigin(request))throw fail('ORIGIN_REJECTED','Origem não autorizada.',403);
   if(request.method==='GET'){
    const q=query(url);
    if(path==='summary')return response({...await repository.summary(),...controls});
    if(path==='items')return response(await repository.list(q));
    if(parts[0]==='items'&&parts.length===2){const item=await repository.detail(decodeURIComponent(parts[1]));if(!item)throw fail('NOT_FOUND','Reel não encontrado.',404);return response({item});}
    if(path==='queues')return response({...await repository.queues(),...controls});
     if(path==='curation/catalogue')return response(await getCatalogue().overview());
     if(path==='curation/calibration')return response(await getCalibration().overview());
     if(path==='quality/saved')return response(await getCalibration().savedQuality(q));
     if(path==='quality')return response({...await repository.quality(q),...controls});
     if(path==='contextual')return response(await getContextual().overview(q));
     if(parts[0]==='contextual'&&parts.length===2){const item=await getContextual().detail(decodeURIComponent(parts[1]));if(!item)throw fail('NOT_FOUND','Conteúdo publicado não encontrado.',404);return response(item);}
    if(path==='events')return response(await repository.events(q));
    if(path==='historical-activity')return response(await repository.historicalActivity(q));
    if(path==='historical-finance')return response(await repository.historicalFinance());
    if(path==='categories')return response({...await repository.categories(),discovery:await taxonomy.coverage()});
    if(path==='finance')return response(await finance.read(q));
    if(parts[0]==='commands'&&parts.length===2)return response(await service.operation(decodeURIComponent(parts[1])));
    if(parts[0]==='reconciliations'&&parts.length===2)return response(await reconciliation.inspect(decodeURIComponent(parts[1])));
   }else{const input=await body(request);
    if(path==='register'){if(typeof input.links!=='string'||input.links.length>200000)throw fail('INVALID_LINKS','Links inválidos.');return response({...await repository.registerLinks(input.links),automaticProcessingStarted:false});}
    if(path==='preview')return response(await service.preview(input.selection,input.type));
    if(path==='commands')return response(await service.command(input));
    if(path==='reconciliations')return response(await reconciliation.command(input));
    if(path==='categories'){
     const changed=await taxonomy.mutate(input);
     if(input.preview!==true&&input.action==='reclassify'&&Array.isArray(input.reelIds))for(const id of [...new Set(input.reelIds)]){try{await getCatalogue().project(id,{type:'editorialChanged',eventId:'taxonomy-'+(changed.operationId??input.idempotencyKey)+'-'+id});}catch{}}
     return response(changed);
    }
    if(path==='finance')return response(await finance.update(input));
   }
   throw fail('NOT_FOUND','Rota não encontrada.',404);
  }catch(error){const known=Number.isInteger(error?.status)&&error.status>=400&&error.status<500;return response({error:known?error.message:safeError(error).message,code:known?(error.code??'INVALID_REQUEST'):'SERVICE_UNAVAILABLE',...(/^[a-f0-9]{64}$/.test(error.operationId??'')?{operationId:error.operationId}:{})},known?error.status:503);}
 };
}
