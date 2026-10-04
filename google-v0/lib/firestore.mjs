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
export function encodeFields(data){
  if(!plain(data))throw new Error('Documento deve ser um objeto simples.');
  return Object.fromEntries(Object.entries(data).map(([key,value])=>{
    if(!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)||['__proto__','constructor','prototype'].includes(key))throw new Error('Campo fora do schema permitido.');
    return [key,encodeValue(value)];
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
const collections=new Set(['videos','settings','analyses','migration_runs','jobs','reservations']);
function documentPath(path){
  const [collection,id,...rest]=String(path).split('/');
  if(!collections.has(collection)||!id||rest.length||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('Documento fora do escopo permitido.');
  return `${collection}/${id}`;
}
export class Firestore {
  constructor(api){this.api=api;this.root=`https://firestore.googleapis.com/v1/projects/${api.project}/databases/(default)/documents`;}
  async get(path){
    try{const doc=await this.api.request(`${this.root}/${documentPath(path)}`);return {data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};}
    catch(error){if(error.status===404)return null;throw error;}
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
  async patch(path,changes,{updateTime}={}){
    if(!updateTime)throw new Error('Atualização requer controle de concorrência.');
    const fields=encodeFields(changes);if(!Object.keys(fields).length)throw new Error('Atualização vazia.');
    const query=new URLSearchParams({'currentDocument.updateTime':updateTime});
    for(const field of Object.keys(fields))query.append('updateMask.fieldPaths',field);
    const doc=await this.api.request(`${this.root}/${documentPath(path)}?${query}`,{method:'PATCH',json:{fields}});
    return {data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};
  }
}
