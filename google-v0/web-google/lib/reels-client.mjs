export const stages = {acquisition:'Aquisição e preparo',transcription:'Transcrição',analysis:'Análise e publicação'};
export const statuses = {registered:'Cadastrado',queued:'Na fila',running:'Executando',waiting:'Aguardando',completed:'Concluído',failed:'Precisa de atenção',uncertain:'Conclusão incerta'};
export const workspaces = [['all','Todos os Reels','▦'],['queues','Filas','⇄'],['categories','Categorias','⌘'],['library','Biblioteca','▤'],['attention','Precisa de atenção','△'],['finance','Financeiro','$'],['activity','Atividade','≋']];
export function queryString(values={}) {const q=new URLSearchParams();for(const [k,v] of Object.entries(values)) if(v!==''&&v!==null&&v!==undefined)q.set(k,String(v));return q.toString();}
export async function request(path, {signal,body,...options}={}) {
 const response=await fetch('/api/reels'+path,{...options,signal,cache:'no-store',credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json();}catch{throw new Error('A resposta do serviço não pôde ser lida. Tente atualizar.');}
 if(!response.ok){const error=new Error(data.error||'Não foi possível concluir esta ação.');error.code=data.code;error.operationId=data.operationId;error.status=response.status;throw error;}return data;
}
export function key(){return crypto.randomUUID();}
export function number(value){return value===null||value===undefined?'—':Number(value).toLocaleString('pt-BR');}
export function date(value){if(!value)return 'Não informado';const d=new Date(value);return Number.isNaN(d.getTime())?'Não informado':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});}
export function text(value){if(value===null||value===undefined||value==='')return 'Não informado';if(typeof value==='boolean')return value?'Sim':'Não';if(typeof value==='string'||typeof value==='number')return String(value);if(Array.isArray(value))return value.map(text).join(' · ');return Object.entries(value).map(([k,v])=>k+': '+text(v)).join(' · ');}
export function mergeEvents(previous,incoming){const map=new Map(previous.map(x=>[x.id,x]));for(const event of incoming)map.set(event.id,event);return [...map.values()].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,1000);}
