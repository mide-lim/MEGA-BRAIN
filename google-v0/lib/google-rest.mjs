// Keep bounded provider error data; never store credentials or full request URLs.
export const safeProviderMessage=value=>typeof value==='string'?value.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/Bearer\s+[^\s]+/gi,'[credential]').replace(/(?:AIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,'[redacted]').replace(/[\x00-\x1f]/g,' ').slice(0,1000):'';
async function providerDiagnostic(response){
  const reader=response.body?.getReader();if(!reader)return null;
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return null;}chunks.push(Buffer.from(value));}}
  catch{return null;}finally{reader.releaseLock();}
  try{const error=JSON.parse(Buffer.concat(chunks).toString()).error;return {status:/^[A-Z_]{1,64}$/.test(error?.status??'')?error.status:null,message:safeProviderMessage(error?.message)};}catch{return null;}
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
    const started=performance.now();let response,requestStage='credential',dispatchAttempted=false,responseBodyComplete=false;
    const apiService=({'aiplatform.googleapis.com':'vertex_ai','firestore.googleapis.com':'firestore','cloudtasks.googleapis.com':'cloud_tasks','storage.googleapis.com':'storage','speech.googleapis.com':'speech','us-speech.googleapis.com':'speech'})[parsed.hostname];
    const diagnostic=error=>({api_service:apiService,request_stage:requestStage,dispatch_attempted:dispatchAttempted,response_received:Boolean(response),response_body_complete:responseBodyComplete,operation_step:['submit_analysis','submit_stt'].includes(operationStep)?operationStep:null,elapsed_ms:Math.max(0,Math.round(performance.now()-started)),error_name:safeErrorName(error?.name),error_code:safeErrorCode(error?.code),http_status:Number.isInteger(response?.status)?response.status:null,request_id:safeRequestId(response?.headers?.get('x-request-id')),model:typeof model==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(model)?model:null,attempt:Number.isSafeInteger(attempt)&&attempt>0&&attempt<=3?attempt:null,timeout_ms:timeoutMs});
    let completed=false;
    try{
      const token=await this.tokenProvider();
      if(typeof token!=='string'||!token)throw new Error('Credencial indisponível.');
      requestStage='request_preparation';const requestBody=json!==undefined?JSON.stringify(json):body;
      requestStage='fetch_started';dispatchAttempted=true;
      response=await this.fetch(url,{method,headers:{...headers,Authorization:`Bearer ${token}`,'x-goog-user-project':this.project,...(json!==undefined?{'Content-Type':'application/json'}:{})},body:requestBody,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      requestStage='http_response_received';
      if(!response.ok){const error=new Error(`Google HTTP ${response.status}; nenhuma repetição automática.`);error.status=response.status;error.provider_diagnostic=await providerDiagnostic(response);throw error;}
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
