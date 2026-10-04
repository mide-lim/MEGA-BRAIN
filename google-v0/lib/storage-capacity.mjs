import {createHash} from 'node:crypto';
const bucket='megabrain-v0-1017370021431-media';
export function newCapacity(){return {schema_version:1,enabled:false,limit_bytes:0,admitted_bytes:0,claims:{}};}
export class StorageCapacity{
 constructor(store){this.store=store;}
 async admit({bucket:target,key,bytes,digest}){
  if(target!==bucket||typeof key!=='string'||!key.startsWith('originals/')&&!key.startsWith('results/')||!Number.isSafeInteger(bytes)||bytes<1||bytes>100000000||!/^[a-f0-9]{64}$/.test(digest??''))throw new Error('Objeto fora do escopo de capacidade.');
  const snapshot=await this.store.get('settings/capacity'),state=snapshot?.data;
  if(state?.schema_version!==1||state.enabled!==true||!Number.isSafeInteger(state.limit_bytes)||state.limit_bytes<1||!Number.isSafeInteger(state.admitted_bytes)||state.admitted_bytes<0||!state.claims||Array.isArray(state.claims))throw new Error('Capacidade não liberada.');
  const financial=(await this.store.get('settings/financial'))?.data;
  if(!Number.isSafeInteger(financial?.ongoing_storage_planned_bytes)||state.limit_bytes>financial.ongoing_storage_planned_bytes)throw new Error('Capacidade excede projeção financeira.');
  const entries=Object.values(state.claims);
  if(entries.length>100||entries.some(c=>!Number.isSafeInteger(c.reserved_bytes)||c.reserved_bytes<1)||entries.reduce((n,c)=>n+c.reserved_bytes,0)!==state.admitted_bytes)throw new Error('Reservas de capacidade inconsistentes.');
  const id='object_'+createHash('sha256').update(target+'/'+key).digest('hex'),existing=state.claims[id];
  if(existing){if(existing.bytes!==bytes||existing.digest!==digest)throw new Error('Objeto diverge da reserva imutável.');return {duplicate:true};}
  const reservedBytes=Math.ceil(bytes*1.05)+1024;
  if(entries.length>=100||state.admitted_bytes+reservedBytes>state.limit_bytes)throw new Error('Capacidade do piloto esgotada.');
  await this.store.patch('settings/capacity',{admitted_bytes:state.admitted_bytes+reservedBytes,claims:{...state.claims,[id]:{bytes,digest,reserved_bytes:reservedBytes}}},{updateTime:snapshot.updateTime});
  return {reserved_bytes:reservedBytes};
 }
}
