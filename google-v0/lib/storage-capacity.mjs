import {createHash} from 'node:crypto';
const bucket='megabrain-v0-1017370021431-media';
export function newCapacity(){return {schema_version:1,enabled:false,limit_bytes:0,admitted_bytes:0,claims:{}};}
export class StorageCapacity{
 constructor(store){this.store=store;}
 async reserveResult({bucket:target,key,maximumBytes=262144}){
  if(target!==bucket||typeof key!=='string'||!key.startsWith('results/')||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>1048576)throw Error('Reserva de resultado fora do escopo.');
  const snapshot=await this.store.get('settings/capacity'),state=snapshot?.data,financial=(await this.store.get('settings/financial'))?.data;
  const cap=state?.claim_limit??100;
  if(state?.enabled!==true||!Number.isSafeInteger(state.limit_bytes)||!Number.isSafeInteger(state.admitted_bytes)||!Number.isSafeInteger(cap)||cap<100||cap>200||state.limit_bytes>financial?.ongoing_storage_planned_bytes||!state.claims)throw Error('Capacidade não liberada.');
  const id='object_'+createHash('sha256').update(target+'/'+key).digest('hex');
  if(state.claims[id])return {duplicate:true};
  const entries=Object.values(state.claims),reservedBytes=Math.ceil(maximumBytes*1.05)+1024;
  if(entries.reduce((n,c)=>n+c.reserved_bytes,0)!==state.admitted_bytes||entries.length>=cap||state.admitted_bytes+reservedBytes>state.limit_bytes)throw Error('Capacidade insuficiente antes da chamada paga.');
  await this.store.patch('settings/capacity',{admitted_bytes:state.admitted_bytes+reservedBytes,claims:{...state.claims,[id]:{pending:true,maximum_bytes:maximumBytes,reserved_bytes:reservedBytes}}},{updateTime:snapshot.updateTime});
  return {reserved_bytes:reservedBytes};
 }
 async admit({bucket:target,key,bytes,digest}){
  if(target!==bucket||typeof key!=='string'||!key.startsWith('originals/')&&!key.startsWith('results/')||!Number.isSafeInteger(bytes)||bytes<1||bytes>100000000||!/^[a-f0-9]{64}$/.test(digest??''))throw new Error('Objeto fora do escopo de capacidade.');
  const snapshot=await this.store.get('settings/capacity'),state=snapshot?.data;
  if(state?.schema_version!==1||state.enabled!==true||!Number.isSafeInteger(state.limit_bytes)||state.limit_bytes<1||!Number.isSafeInteger(state.admitted_bytes)||state.admitted_bytes<0||!state.claims||Array.isArray(state.claims))throw new Error('Capacidade não liberada.');
  const financial=(await this.store.get('settings/financial'))?.data;
  if(!Number.isSafeInteger(financial?.ongoing_storage_planned_bytes)||state.limit_bytes>financial.ongoing_storage_planned_bytes)throw new Error('Capacidade excede projeção financeira.');
  if(!Number.isSafeInteger(state.claim_limit??100)||(state.claim_limit??100)<100||(state.claim_limit??100)>200)throw Error('Limite de objetos inválido.');
  const entries=Object.values(state.claims);
  if(entries.length>(state.claim_limit??100)||entries.some(c=>!Number.isSafeInteger(c.reserved_bytes)||c.reserved_bytes<1)||entries.reduce((n,c)=>n+c.reserved_bytes,0)!==state.admitted_bytes)throw new Error('Reservas de capacidade inconsistentes.');
  const id='object_'+createHash('sha256').update(target+'/'+key).digest('hex'),existing=state.claims[id];
  if(existing?.pending===true){if(bytes>existing.maximum_bytes)throw Error('Resultado excede reserva de capacidade.');await this.store.patch('settings/capacity',{claims:{...state.claims,[id]:{...existing,pending:false,bytes,digest}}},{updateTime:snapshot.updateTime});return {reserved_bytes:existing.reserved_bytes};}
  if(existing){if(existing.bytes!==bytes||existing.digest!==digest)throw new Error('Objeto diverge da reserva imutável.');return {duplicate:true};}
  const reservedBytes=Math.ceil(bytes*1.05)+1024;
  if(entries.length>=(state.claim_limit??100)||state.admitted_bytes+reservedBytes>state.limit_bytes)throw new Error('Capacidade do piloto esgotada.');
  await this.store.patch('settings/capacity',{admitted_bytes:state.admitted_bytes+reservedBytes,claims:{...state.claims,[id]:{bytes,digest,reserved_bytes:reservedBytes}}},{updateTime:snapshot.updateTime});
  return {reserved_bytes:reservedBytes};
 }
}
