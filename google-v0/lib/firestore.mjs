import {fragmentSpec,hydrateFragments,planFragmentPatch} from './control-fragments.mjs';
function plain(value){return value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;}
export function encodeValue(value){
  if(value===null)return {nullValue:null};
  if(typeof value==='string')return {stringValue:value};
  if(typeof value==='boolean')return {booleanValue:value};
  if(typeof value==='number'&&Number.isFinite(value))return Number.isSafeInteger(value)?{integerValue:String(value)}:{doubleValue:value};
  if(Array.isArray(value)){
    if(value.some(Array.isArray))throw new Error('Firestore não permite arrays diretamente aninhados.');
    return {arrayValue:{values:value.map(encodeValue)}};
  }
  if(plain(value))return {mapValue:{fields:encodeFields(value)}};
  throw new Error('Valor não suportado no Firestore.');
}
// Admission intents are keyed by reel identity, not by application field name.
// Keep this exception at that map boundary; all other schema keys stay strict.
function encodeIntentMap(value){
  if(!plain(value))throw new Error('Mapa de admissão inválido.');
  return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([id,intent])=>{
    if(!/^[A-Za-z0-9_-]{5,32}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||!plain(intent))throw new Error('Identidade de admissão inválida.');
    return [id,{mapValue:{fields:encodeFields(intent)}}];
  }))}};
}
export function encodeFields(data){
  if(!plain(data))throw new Error('Documento deve ser um objeto simples.');
  return Object.fromEntries(Object.entries(data).map(([key,value])=>{
    if(!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)||['__proto__','constructor','prototype'].includes(key))throw new Error('Campo fora do schema permitido.');
    return [key,key==='intents'?encodeIntentMap(value):encodeValue(value)];
  }));
}
export function decodeValue(value){
  if('nullValue'in value)return null;
  if('stringValue'in value)return value.stringValue;
  if('booleanValue'in value)return value.booleanValue;
  if('integerValue'in value){const n=Number(value.integerValue);if(!Number.isSafeInteger(n))throw new Error('Inteiro Firestore fora da precisão permitida.');return n;}
  if('doubleValue'in value){if(!Number.isFinite(value.doubleValue))throw new Error('Número Firestore inválido.');return value.doubleValue;}
  if('timestampValue'in value)return value.timestampValue;
  if('arrayValue'in value)return (value.arrayValue.values??[]).map(decodeValue);
  if('mapValue'in value)return decodeFields(value.mapValue.fields??{});
  throw new Error('Tipo Firestore desconhecido.');
}
export const decodeFields=fields=>Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,decodeValue(value)]));
const collections=new Set(['videos','settings','analyses','migration_runs','jobs','reservations','control_chunks']);
function documentPath(path){
  const [collection,id,...rest]=String(path).split('/');
  if(!collections.has(collection)||!id||rest.length||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('Documento fora do escopo permitido.');
  return `${collection}/${id}`;
}
export class Firestore {
  constructor(api){this.api=api;this.fragmentSnapshots=new Map();this.root=`https://firestore.googleapis.com/v1/projects/${api.project}/databases/(default)/documents`;}
  async get(path){
    for(let attempt=0;attempt<4;attempt++){
      let doc;try{doc=await this.api.request(`${this.root}/${documentPath(path)}`);}catch(error){if(error.status===404)return null;throw error;}
      const snapshot={data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};
      if(!fragmentSpec(path)||!snapshot.data.control_fragments){if(fragmentSpec(path))this.fragmentSnapshots.set(path,snapshot);return snapshot;}
      const records=[];let pageToken;
      do{const page=await this.list('control_chunks',{pageSize:100,pageToken});records.push(...page.records);pageToken=page.nextPageToken;}while(pageToken);
      const latest=await this.api.request(`${this.root}/${documentPath(path)}`);
      if(latest.updateTime!==snapshot.updateTime)continue;
      const hydrated=hydrateFragments(path,snapshot.data,records),view={...snapshot,data:hydrated.data,chunks:hydrated.chunks};
      this.fragmentSnapshots.set(path,view);return view;
    }
    throw Object.assign(Error('Controle mudou durante leitura consistente.'),{status:412});
  }
  async list(collection,{pageSize=100,pageToken}={}){
    if(!collections.has(collection)||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Consulta inválida.');
    const query=new URLSearchParams({pageSize:String(pageSize)});if(pageToken)query.set('pageToken',pageToken);
    const data=await this.api.request(`${this.root}/${collection}?${query}`);
    const prefix=`projects/${this.api.project}/databases/(default)/documents/`;
    return {records:(data.documents??[]).map(doc=>{
      if(typeof doc.name!=='string'||!doc.name.startsWith(prefix))throw new Error('Documento retornado fora do projeto.');
      const path=documentPath(doc.name.slice(prefix.length));
      if(!path.startsWith(collection+'/'))throw new Error('Documento retornado fora da coleção.');
      return {path,data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};
    }),nextPageToken:data.nextPageToken??null};
  }
  async create(path,data){
    const query=new URLSearchParams({'currentDocument.exists':'false'});
    const url=`${this.root}/${documentPath(path)}?${query}`;
    try{const doc=await this.api.request(url,{method:'PATCH',json:{fields:encodeFields(data)}});return {created:true,data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};}
    catch(error){if([409,412].includes(error.status))return {created:false};throw error;}
  }
  async metadataWrite(url,options){
    try{return await this.api.request(url,options);}
    catch(error){if(error.status===429&&error.provider_diagnostic?.status==='RESOURCE_EXHAUSTED')error.metadata_write_rejected=true;throw error;}
  }
  async patch(path,changes,{updateTime}={}){
    if(!updateTime)throw new Error('Atualização requer controle de concorrência.');
    if(fragmentSpec(path)){
      let snapshot=this.fragmentSnapshots.get(path);
      if(!snapshot||snapshot.updateTime!==updateTime)snapshot=await this.get(path);
      if(snapshot?.updateTime!==updateTime)throw Object.assign(Error('Versão de controle mudou.'),{status:412});
      if(snapshot.chunks){
        const {rootChanges,updates}=planFragmentPatch(path,snapshot,changes);
        if(!Object.keys(rootChanges).length&&!updates.length)return snapshot;
        const prefix=`projects/${this.api.project}/databases/(default)/documents/`;
        const write=(target,fields,version)=>({update:{name:prefix+documentPath(target),fields:encodeFields(fields)},updateMask:{fieldPaths:Object.keys(fields)},currentDocument:{updateTime:version}});
        const writes=[write(path,Object.keys(rootChanges).length?rootChanges:{control_fragments:snapshot.data.control_fragments},updateTime),...updates.map(x=>write(x.path,x.changes,x.updateTime))];
        const receipt=await this.metadataWrite(this.root+':commit',{method:'POST',json:{writes}});
        this.fragmentSnapshots.delete(path);
        if(receipt?.writeResults?.length!==writes.length||!receipt.writeResults.every(x=>typeof x.updateTime==='string'&&x.updateTime))throw Error('Confirmação de commit incompleta; conferir estado sem repetir.');
        return {data:{...snapshot.data,...changes,...(rootChanges.control_fragments?{control_fragments:rootChanges.control_fragments}:{})},updateTime:receipt.writeResults[0].updateTime};
      }
    }
    const fields=encodeFields(changes);if(!Object.keys(fields).length)throw new Error('Atualização vazia.');
    const query=new URLSearchParams({'currentDocument.updateTime':updateTime});
    for(const field of Object.keys(fields))query.append('updateMask.fieldPaths',field);
    const doc=await this.metadataWrite(`${this.root}/${documentPath(path)}?${query}`,{method:'PATCH',json:{fields}});
    return {data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};
  }
}

// Only definite rejected metadata writes can be recalculated. This helper never
// encloses a provider call, object upload or create-only execution claim.
export const rejectedVersion=error=>error?.status===412||(error?.status===400&&error.provider_diagnostic?.status==='FAILED_PRECONDITION'&&/does not match the required base version/.test(error.provider_diagnostic?.message??''));
export async function mutateDocument(store,path,calculate,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let rateRejections=0;
 for(let attempt=0;attempt<8;attempt++){
  const snapshot=await store.get(path);if(!snapshot)throw Error('Documento de controle ausente.');
  const {changes,result}=await calculate(snapshot);
  if(!changes)return result;
  try{await store.patch(path,changes,{updateTime:snapshot.updateTime});return result;}
  catch(error){
   if(attempt===7)throw error;
   if(error.metadata_write_rejected===true&&error.status===429&&error.provider_diagnostic?.status==='RESOURCE_EXHAUSTED'){if(++rateRejections>2)throw error;await sleep(100*2**(rateRejections-1));continue;}
   if(!rejectedVersion(error))throw error;
  }
 }
}
