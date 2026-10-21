// Keep bounded provider error data; never store credentials or full request URLs.
export const safeProviderMessage=value=>typeof value==='string'?value.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/Bearer\s+[^\s]+/gi,'[credential]').replace(/(?:AIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,'[redacted]').replace(/[\x00-\x1f]/g,' ').slice(0,1000):'';
const safeDetailDescription=value=>safeProviderMessage(value).replace(/gs:\/\/[^\s]+/g,'[resource]').replace(/(?:originals|results|projects)\/[^\s,;]+/g,'[resource]').replace(/["'`][^"'`]*(?:["'`]|$)/g,'[value]').replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,'[credential]').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'[identifier]').replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[identifier]').replace(/\b\d{8,}\b/g,'[identifier]').slice(0,512);
const diagnosticFieldNames=new Set(['generation_config','generationConfig','response_schema','responseSchema','response_mime_type','responseMimeType','max_output_tokens','maxOutputTokens','contents','parts','text','fileData','fileUri','mimeType','system_instruction','systemInstruction','model','tools','tool_config','toolConfig','safety_settings','safetySettings','properties','items','type','enum','nullable','required','minItems','maxItems','anyOf','title','summary','categories','useful_information','claim','application','application_evidence','classification','evidence','source','sourceIdentity','key','generation','captureId','excerpt','start_ref','end_ref','visual_observations','observation','knowledge','fields','keywords','qualityEvidenceV2','contextualSignals','taxonomySignals']);
const safeDetailField=value=>typeof value==='string'&&value.length<=256&&/^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*|\[\d{1,4}\])*$/u.test(value)&&value.replace(/\[\d+\]/g,'').split('.').every(v=>diagnosticFieldNames.has(v))?value:'[field redacted]';
function safeProviderDetails(value){
 if(!Array.isArray(value))return [];
 const result=[];
 for(const detail of value.slice(0,4)){
  if(detail?.['@type']==='type.googleapis.com/google.rpc.BadRequest'){
   const violations=Array.isArray(detail.fieldViolations)?detail.fieldViolations.slice(0,4):[];
   result.push({'@type':detail['@type'],fieldViolations:violations.filter(v=>v&&typeof v==='object').map(v=>({field:safeDetailField(v.field),description:safeDetailDescription(v.description)}))});
  }else if(detail?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo'){
   result.push({'@type':detail['@type'],reason:typeof detail.reason==='string'&&/^[A-Z][A-Z_]{0,63}$/.test(detail.reason)?detail.reason:'[reason redacted]',domain:typeof detail.domain==='string'&&/^(?:[a-z][a-z0-9-]{0,30}\.)?googleapis\.com$/.test(detail.domain)?detail.domain:'[domain redacted]'});
  }
 }
 return result;
}
async function providerDiagnostic(response){
 const reader=response.body?.getReader();if(!reader)return {diagnostic:null,bodyComplete:response.body==null,bodyBytes:0,jsonParsed:false};
 let size=0,complete=false;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done){complete=true;break;}size+=value.length;if(size>8192){await reader.cancel();return {diagnostic:null,bodyComplete:false,bodyBytes:size,jsonParsed:false};}chunks.push(Buffer.from(value));}}
 catch{return {diagnostic:null,bodyComplete:false,bodyBytes:size,jsonParsed:false};}finally{reader.releaseLock();}
 try{const body=JSON.parse(Buffer.concat(chunks).toString()),error=body?.error,details=safeProviderDetails(error?.details);return {diagnostic:{status:/^[A-Z_]{1,64}$/.test(error?.status??'')?error.status:null,message:safeProviderMessage(error?.message),...(details.length?{details}:{} )},bodyComplete:complete,bodyBytes:size,jsonParsed:true};}catch{return {diagnostic:null,bodyComplete:complete,bodyBytes:size,jsonParsed:false};}
}
export const defaultAnalysisTimeoutMs=120000;
export const maximumAnalysisTimeoutMs=840000;
export function analysisTimeoutMs(value=defaultAnalysisTimeoutMs){
  if(!Number.isSafeInteger(value)||value<1000||value>maximumAnalysisTimeoutMs)throw new Error('Timeout de análise deve ser inteiro entre 1000 e 840000 ms.');
  return value;
}
const safeErrorName=value=>['Error','TypeError','SyntaxError','AbortError','TimeoutError','RangeError'].includes(value)?value:null;
const safeErrorCode=value=>Number.isSafeInteger(value)?value:typeof value==='string'&&/^(?:ERR_[A-Z_]{1,48}|E[A-Z]{2,24}|UND_ERR_[A-Z_]{1,48})$/.test(value)?value:null;
const safeRequestId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:null;
// Persist only bounded transport metadata already produced by GoogleREST.
// Never copy Error.message/stack, request content, headers, or raw bodies.
export function safeAnalysisFailureDiagnostic(error){
 const d=error?.google_diagnostic;
 if(!d||d.api_service!=='vertex_ai'||d.operation_step!=='submit_analysis')return {};
 const stages=['credential','request_preparation','fetch_started','http_response_received','response_body_read','response_complete'];
 const bounded=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max?v:null;
 const google_diagnostic={api_service:'vertex_ai',operation_step:'submit_analysis',request_stage:stages.includes(d.request_stage)?d.request_stage:null,dispatch_attempted:typeof d.dispatch_attempted==='boolean'?d.dispatch_attempted:null,response_received:typeof d.response_received==='boolean'?d.response_received:null,response_body_complete:typeof d.response_body_complete==='boolean'?d.response_body_complete:null,elapsed_ms:bounded(d.elapsed_ms,maximumAnalysisTimeoutMs+60000),error_name:safeErrorName(d.error_name),error_code:safeErrorCode(d.error_code),http_status:Number.isInteger(d.http_status)&&d.http_status>=100&&d.http_status<=599?d.http_status:null,request_id:safeRequestId(d.request_id),model:typeof d.model==='string'&&/^gemini-[a-z0-9.-]{1,56}$/.test(d.model)?d.model:null,attempt:Number.isSafeInteger(d.attempt)&&d.attempt>=1&&d.attempt<=3?d.attempt:null,timeout_ms:Number.isSafeInteger(d.timeout_ms)&&d.timeout_ms>=1&&d.timeout_ms<=maximumAnalysisTimeoutMs?d.timeout_ms:null};
 const p=error.provider_diagnostic;
 const provider_diagnostic=p&&typeof p==='object'?{status:typeof p.status==='string'&&/^[A-Z_]{1,64}$/.test(p.status)?p.status:null,message:safeProviderMessage(p.message),...(safeProviderDetails(p.details).length?{details:safeProviderDetails(p.details)}:{})}:null;
 if(Number.isSafeInteger(d.response_body_bytes)&&d.response_body_bytes>=0&&d.response_body_bytes<=100000000)google_diagnostic.response_body_bytes=d.response_body_bytes;
 if(typeof d.response_error_json_parsed==='boolean')google_diagnostic.response_error_json_parsed=d.response_error_json_parsed;
 return {google_diagnostic,provider_diagnostic};
}
const forbiddenProject='megabrain-stt';
export class GoogleREST {
  constructor({project,tokenProvider,fetchImpl=fetch,buckets=[]}) {
    if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project??'')||project===forbiddenProject)throw new Error('Projeto Google isolado obrigatório.');
    if(typeof tokenProvider!=='function')throw new Error('Identidade de execução obrigatória.');
    if(!Array.isArray(buckets)||buckets.some(b=>typeof b!=='string'||!b.startsWith(project+'-')||!/^[a-z0-9-]{3,63}$/.test(b)))throw new Error('Bucket precisa pertencer ao escopo da v0.');
    this.project=project;this.tokenProvider=tokenProvider;this.fetch=fetchImpl;this.buckets=new Set(buckets);
  }
  async request(url,{method='GET',json,body,headers={},timeoutMs=30000,responseMode='json',maxResponseBytes=100000000,operationStep=null,model=null,attempt=null,onDiagnostic}={}) {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>maximumAnalysisTimeoutMs)throw new Error('Timeout Google inválido.');
    if(onDiagnostic!==undefined&&typeof onDiagnostic!=='function')throw new Error('Registro diagnóstico inválido.');
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!['aiplatform.googleapis.com','storage.googleapis.com','firestore.googleapis.com','cloudtasks.googleapis.com','speech.googleapis.com','us-speech.googleapis.com'].includes(parsed.hostname))throw new Error('Endpoint Google fora do escopo.');
    if(parsed.username||parsed.password||parsed.hash)throw new Error('URL Google inválida.');
    if(parsed.hostname==='storage.googleapis.com'){
      const match=parsed.pathname.match(/^\/(?:upload\/)?storage\/v1\/b\/([^/]+)(?:\/|$)/);
      if(!match||!this.buckets.has(decodeURIComponent(match[1])))throw new Error('Bucket não autorizado.');
    }else if(!parsed.pathname.startsWith(`/v1/projects/${this.project}/`)&&!parsed.pathname.startsWith(`/v2/projects/${this.project}/`)&&!(this.project==='megabrain-v0-1017370021431'&&['speech.googleapis.com','us-speech.googleapis.com'].includes(parsed.hostname)&&/^\/v2\/projects\/711042421394\/locations\/(?:global|us)\/operations\/[A-Za-z0-9_-]+$/.test(parsed.pathname)))throw new Error('Projeto fora do escopo da v0.');
    if(parsed.hostname==='us-speech.googleapis.com'&&!parsed.pathname.startsWith(`/v2/projects/${this.project}/locations/us/`)&&!/^\/v2\/projects\/711042421394\/locations\/us\/operations\/[A-Za-z0-9_-]+$/.test(parsed.pathname)&&!/^\/v2\/projects\/711042421394\/locations\/us\/operations\/[A-Za-z0-9_-]+$/.test(parsed.pathname))throw new Error('Endpoint STT regional deve usar a região us.');
    if(json!==undefined&&body!==undefined)throw new Error('Corpo ambíguo.');
    if(Object.keys(headers).some(h=>['authorization','x-goog-user-project'].includes(h.toLowerCase())))throw new Error('Cabeçalhos de identidade não podem ser substituídos.');
    const started=performance.now();let response,requestStage='credential',dispatchAttempted=false,responseBodyComplete=false,errorBody=null;
    const apiService=({'aiplatform.googleapis.com':'vertex_ai','firestore.googleapis.com':'firestore','cloudtasks.googleapis.com':'cloud_tasks','storage.googleapis.com':'storage','speech.googleapis.com':'speech','us-speech.googleapis.com':'speech'})[parsed.hostname];
    const diagnostic=error=>({api_service:apiService,request_stage:requestStage,dispatch_attempted:dispatchAttempted,response_received:Boolean(response),response_body_complete:responseBodyComplete,operation_step:['submit_analysis','submit_stt'].includes(operationStep)?operationStep:null,elapsed_ms:Math.max(0,Math.round(performance.now()-started)),error_name:safeErrorName(error?.name),error_code:safeErrorCode(error?.code),http_status:Number.isInteger(response?.status)?response.status:null,request_id:safeRequestId(response?.headers?.get('x-request-id')),model:typeof model==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(model)?model:null,attempt:Number.isSafeInteger(attempt)&&attempt>0&&attempt<=3?attempt:null,timeout_ms:timeoutMs,...(errorBody?{response_body_bytes:errorBody.bodyBytes,response_error_json_parsed:errorBody.jsonParsed}:{})});
    let completed=false;
    try{
      const token=await this.tokenProvider();
      if(typeof token!=='string'||!token)throw new Error('Credencial indisponível.');
      requestStage='request_preparation';const requestBody=json!==undefined?JSON.stringify(json):body;
      requestStage='fetch_started';dispatchAttempted=true;
      response=await this.fetch(url,{method,headers:{...headers,Authorization:`Bearer ${token}`,'x-goog-user-project':this.project,...(json!==undefined?{'Content-Type':'application/json'}:{})},body:requestBody,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      requestStage='http_response_received';
      if(!response.ok){const error=new Error(`Google HTTP ${response.status}; nenhuma repetição automática.`);error.status=response.status;errorBody=await providerDiagnostic(response);responseBodyComplete=errorBody.bodyComplete;error.provider_diagnostic=errorBody.diagnostic;throw error;}
      requestStage='response_body_read';
      if(responseMode==='bytes'){
        if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1)throw new Error('Limite de resposta inválido.');
        if(Number(response.headers.get('content-length'))>maxResponseBytes){await response.body?.cancel();throw new Error('Objeto acima do limite de leitura.');}
        if(!response.body){responseBodyComplete=true;requestStage='response_complete';completed=true;await onDiagnostic?.(diagnostic());return Buffer.alloc(0);}
        const reader=response.body.getReader();const chunks=[];let total=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;
          if(total>maxResponseBytes){await reader.cancel();throw new Error('Objeto acima do limite de leitura.');}chunks.push(Buffer.from(value));}}
        finally{reader.releaseLock();}
        const result=Buffer.concat(chunks,total);responseBodyComplete=true;requestStage='response_complete';completed=true;await onDiagnostic?.(diagnostic());return result;
      }
      const result=responseMode==='raw'?response:response.status===204?null:await response.json();
      responseBodyComplete=responseMode!=='raw';requestStage=responseMode==='raw'?'http_response_received':'response_complete';completed=true;await onDiagnostic?.(diagnostic());return result;
    }catch(error){
      error.google_diagnostic=diagnostic(error);
      if(response)error.status=response.status;
      if(!completed)await onDiagnostic?.(error.google_diagnostic);
      throw error;
    }
  }
  async countAnalysisTokens(model,request) {
    if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Modelo inválido.');
    const url=`https://aiplatform.googleapis.com/v1/projects/${this.project}/locations/global/publishers/google/models/${model}:countTokens`;
    return this.request(url,{method:'POST',json:{contents:request.contents,systemInstruction:request.systemInstruction}});
  }
  async generateAnalysis(model,request,{financialCheck,markStarted,markUncertain,timeoutMs=defaultAnalysisTimeoutMs}) {
    if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Modelo inválido.');
    if(typeof financialCheck!=='function'||typeof markStarted!=='function'||typeof markUncertain!=='function')throw new Error('Reserva e registro da execução obrigatórios.');
    analysisTimeoutMs(timeoutMs);
    const decision=await financialCheck();
    if(!decision?.ready || decision.paid_calls_enabled !== true)throw new Error('Execução paga bloqueada pela verificação financeira ou controle de ativação.');
    await markStarted();
    try{return await this.request(`https://aiplatform.googleapis.com/v1/projects/${this.project}/locations/global/publishers/google/models/${model}:generateContent`,{method:'POST',json:request,timeoutMs,operationStep:'submit_analysis',model,attempt:1});}
    catch(error){await markUncertain({http_status:error.status??null,google_diagnostic:error.google_diagnostic??null});throw error;}
  }
}
