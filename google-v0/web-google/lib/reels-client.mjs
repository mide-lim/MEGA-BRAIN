export const stages = {acquisition:'Aquisição e preparo',transcription:'Transcrição',analysis:'Análise e publicação'};
export const statuses = {registered:'Cadastrado',queued:'Na fila',running:'Executando',waiting:'Aguardando',completed:'Concluído',failed:'Precisa de atenção',uncertain:'Conclusão incerta'};
export const workspaces = [['all','Todos os Reels','▦'],['queues','Filas','⇄'],['categories','Categorias','⌘'],['library','Biblioteca','▤'],['attention','Precisa de atenção','△'],['finance','Financeiro','$'],['activity','Atividade','≋']];
export function queryString(values={}) {const q=new URLSearchParams();for(const [k,v] of Object.entries(values)) if(v!==''&&v!==null&&v!==undefined)q.set(k,String(v));return q.toString();}
export async function request(path, {signal,body,refresh,...options}={}) {
 const response=await fetch('/api/reels'+path,{...options,signal,cache:'no-store',credentials:'same-origin',headers:{...(typeof refresh==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(refresh)?{'X-Reels-Refresh':refresh}:{}),...(body?{'Content-Type':'application/json'}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json();}catch{throw new Error('A resposta do serviço não pôde ser lida. Tente atualizar.');}
 if(!response.ok){const error=new Error(data.error||'Não foi possível concluir esta ação.');error.code=data.code;error.operationId=data.operationId;error.status=response.status;if(error.operationId)rememberOperation(error.operationId);throw error;}return data;
}
export function key(){return crypto.randomUUID();}
export function number(value){return value===null||value===undefined?'—':Number(value).toLocaleString('pt-BR');}
export function date(value){if(!value)return 'Não informado';const d=new Date(value);return Number.isNaN(d.getTime())?'Não informado':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});}
export function text(value){if(value===null||value===undefined||value==='')return 'Não informado';if(typeof value==='boolean')return value?'Sim':'Não';if(typeof value==='string'||typeof value==='number')return String(value);if(Array.isArray(value))return value.map(text).join(' · ');return Object.entries(value).map(([k,v])=>k+': '+text(v)).join(' · ');}
export function mergeEvents(previous,incoming){const map=new Map(previous.map(x=>[x.id,x]));for(const event of incoming)map.set(event.id,event);return [...map.values()].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,1000);}
export const operationStatuses={pending:'Aguardando encaminhamento',running:'Admissão em andamento',completed:'Comando concluído',failed:'Requer conferência'};
export const exclusionReasons={not_found:'Cadastro não encontrado',already_completed:'Resultado já concluído',requires_retry:'Falha confirmada: use retomada',requires_reconciliation:'Conclusão incerta: concilie antes de repetir',already_in_progress:'Já está em andamento',migration_hold:'Aguardando ativação da migração',changed:'Elegibilidade alterada',not_eligible:'Fora dos critérios desta ação',concurrent_admission_or_not_eligible:'Elegibilidade alterada ou já admitido por outra operação',invalid_stage:'Etapa da falha não comprovada'};
export const reasonLabel=reason=>exclusionReasons[reason]||reason||'Motivo não informado';
export const executionStatuses={...statuses,submitting:'Envio externo em andamento',collecting:'Consultando operação já enviada',applying:'Aplicando resultado salvo'};
export function rememberOperation(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)||typeof window==='undefined')return;sessionStorage.setItem('megabrain:last-operation',id);window.dispatchEvent(new Event('megabrain:operation'));}

