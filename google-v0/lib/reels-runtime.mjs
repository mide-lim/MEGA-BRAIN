import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export const nowISO=clock=>new Date(clock()).toISOString();
export function fail(code,message,status=400){return Object.assign(new Error(message),{code,status});}
export function identifier(value,label='Identificador'){if(typeof value!=='string'||!value||value.length>128||! /^[A-Za-z0-9_-]+$/.test(value))throw fail('INVALID_INPUT',label+' inválido.');return value;}
export function key(value){if(typeof value!=='string'||value.length<8||value.length>128||! /^[A-Za-z0-9_.:-]+$/.test(value))throw fail('INVALID_KEY','Chave de operação inválida.');return value;}
export async function ensure(store,path,data){try{const r=await store.create(path,data);if(r.created)return (await store.get(path))??r;}catch(error){const saved=await store.get(path);if(saved)return saved;throw error;}return store.get(path);}
export async function cas(store,path,calculate,{attempts=8}={}){for(let n=0;n<attempts;n++){const snapshot=await store.get(path);if(!snapshot)throw fail('NOT_FOUND','Registro não encontrado.',404);const changes=await calculate(snapshot.data,snapshot);if(!changes)return snapshot;try{return await store.patch(path,changes,{updateTime:snapshot.updateTime});}catch(error){if(error.status!==412||n===attempts-1)throw error;}}}
export async function all(store,collection){const records=[];let pageToken;do{const page=await store.list(collection,{pageSize:100,pageToken});records.push(...page.records);pageToken=page.nextPageToken;}while(pageToken);return records;}
export const safeError=error=>({code:error?.code&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'OPERATION_FAILED',message:'Não foi possível concluir a operação. Os dados foram preservados.'});
export async function event(store,{id,...data},clock=Date.now){
 const sourceId=id??hash(data),receiptPath='reels_command_items/'+hash('event:'+sourceId),streamPath='settings/reels_v2_event_clock';
 if(await store.get(receiptPath))return;
 await ensure(store,streamPath,{sequence:0,pending:null});
 for(let attempt=0;attempt<64;attempt++){
  let snapshot=await store.get(streamPath);
  if(snapshot.data.pending){const pending=snapshot.data.pending;await ensure(store,'reels_events/'+pending.id,pending.data);await ensure(store,pending.receiptPath,{id:pending.sourceId,eventId:pending.id,type:'event_receipt'});
   try{await store.patch(streamPath,{pending:null},{updateTime:snapshot.updateTime});}catch(error){if(error.status!==412)throw error;}continue;}
  if(await store.get(receiptPath))return;
  const sequence=snapshot.data.sequence+1,eventId=String(sequence).padStart(20,'0')+'_'+sourceId;
  try{await store.patch(streamPath,{sequence,pending:{id:eventId,sourceId,receiptPath,data:{id:eventId,at:nowISO(clock),worker:'reels-v2',level:'info',...data}}},{updateTime:snapshot.updateTime});}catch(error){if(error.status!==412)throw error;}
 }
 throw fail('EVENT_BUSY','Registro de eventos ocupado; tente recuperar o comando.',503);
}

export async function queueOutbox(store,job,{onQueued,clock=Date.now,poll=false,sequence=0}={}){
 const id=hash(job.id+(poll?':poll:'+sequence:':dispatch')),path='reels_command_items/'+id;
 const saved=await ensure(store,path,{id,executionId:job.id,reelId:job.reelId,stage:job.stage,poll,status:'pending',createdAt:nowISO(clock)});
 if(saved.data.status==='sent')return saved.data;
 // Failure must reach the current HTTP delivery. A durable intent alone is
 // insufficient when no task exists yet to resume it.
 if(onQueued)await onQueued({...job,outboxId:id,poll});
 return saved.data;
}
