const forbiddenProject='megabrain-stt';
export class GoogleREST {
  constructor({project,tokenProvider,fetchImpl=fetch,buckets=[]}) {
    if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project??'')||project===forbiddenProject)throw new Error('Projeto Google isolado obrigatório.');
    if(typeof tokenProvider!=='function')throw new Error('Identidade de execução obrigatória.');
    if(!Array.isArray(buckets)||buckets.some(b=>typeof b!=='string'||!b.startsWith(project+'-')||!/^[a-z0-9-]{3,63}$/.test(b)))throw new Error('Bucket precisa pertencer ao escopo da v0.');
    this.project=project;this.tokenProvider=tokenProvider;this.fetch=fetchImpl;this.buckets=new Set(buckets);
  }
  async request(url,{method='GET',json,body,headers={},timeoutMs=30000,responseMode='json',maxResponseBytes=100000000}={}) {
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
    const token=await this.tokenProvider();
    if(typeof token!=='string'||!token)throw new Error('Credencial indisponível.');
    const response=await this.fetch(url,{method,headers:{...headers,Authorization:`Bearer ${token}`,'x-goog-user-project':this.project,...(json!==undefined?{'Content-Type':'application/json'}:{})},body:json!==undefined?JSON.stringify(json):body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok){const error=new Error(`Google HTTP ${response.status}; nenhuma repetição automática.`);error.status=response.status;throw error;}
    if(responseMode==='bytes'){
      if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1)throw new Error('Limite de resposta inválido.');
      if(Number(response.headers.get('content-length'))>maxResponseBytes){await response.body?.cancel();throw new Error('Objeto acima do limite de leitura.');}
      if(!response.body)return Buffer.alloc(0);
      const reader=response.body.getReader();const chunks=[];let total=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;
        if(total>maxResponseBytes){await reader.cancel();throw new Error('Objeto acima do limite de leitura.');}chunks.push(Buffer.from(value));}}
      finally{reader.releaseLock();}
      return Buffer.concat(chunks,total);
    }
    if(responseMode==='raw')return response;
    if(response.status===204)return null;
    return response.json();
  }
  async countAnalysisTokens(model,request) {
    if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Modelo inválido.');
    const url=`https://aiplatform.googleapis.com/v1/projects/${this.project}/locations/global/publishers/google/models/${model}:countTokens`;
    return this.request(url,{method:'POST',json:{contents:request.contents,systemInstruction:request.systemInstruction}});
  }
  async generateAnalysis(model,request,{financialCheck,markStarted,markUncertain}) {
    if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Modelo inválido.');
    if(typeof financialCheck!=='function'||typeof markStarted!=='function'||typeof markUncertain!=='function')throw new Error('Reserva e registro da execução obrigatórios.');
    const decision=await financialCheck();
    if(!decision?.ready || decision.paid_calls_enabled !== true)throw new Error('Execução paga bloqueada pela verificação financeira ou controle de ativação.');
    await markStarted();
    try{return await this.request(`https://aiplatform.googleapis.com/v1/projects/${this.project}/locations/global/publishers/google/models/${model}:generateContent`,{method:'POST',json:request,timeoutMs:120000});}
    catch(error){await markUncertain({http_status:error.status??null});throw error;}
  }
}
