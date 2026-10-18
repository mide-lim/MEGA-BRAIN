import {commitSemanticStore} from './reels-semantic-store.mjs';
import {isDeepStrictEqual} from 'node:util';
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
function encodeStagePlan(value){
 if(!plain(value))throw Error('Plano de etapas inválido.');
 return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([id,stage])=>{
  if(!/^[A-Za-z0-9_-]{5,32}$/.test(id)||!['acquisition','transcription','analysis'].includes(stage))throw Error('Plano de etapas inválido.');
  return [id,{stringValue:stage}];
 }))}};
}
export function encodeFields(data){
  if(!plain(data))throw new Error('Documento deve ser um objeto simples.');
  return Object.fromEntries(Object.entries(data).map(([key,value])=>{
    if(!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)||['__proto__','constructor','prototype'].includes(key))throw new Error('Campo fora do schema permitido.');
    return [key,key==='intents'?encodeIntentMap(value):key==='stagePlan'?encodeStagePlan(value):encodeValue(value)];
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
const collections=new Set(['videos','settings','analyses','migration_runs','jobs','reservations','control_chunks','execution_stops','reels_commands','reels_command_items','reels_executions','reels_events','reels_controls','reels_taxonomy','reels_finance','reels_index','reels_legacy_content','reels_backup_links','reels_historical_activity','reels_historical_finance','reels_historical_coverage','reels_reconciliations','reels_quality_receipts']);
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
  // Projection is required for scans of legacy videos: never fetch transcript or report bodies.
  async query(collection,{select,filters=[],orderBy=[{field:'__name__',direction:'ASCENDING'}],limit=100,cursor}={}){
    if(!collections.has(collection)||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Consulta inválida.');
    const field=value=>{if(typeof value!=='string'||!/^(__name__|[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*)$/.test(value))throw Error('Campo de consulta inválido.');return {fieldPath:value};};
    const q={from:[{collectionId:collection}],limit,orderBy:orderBy.map(x=>{if(!['ASCENDING','DESCENDING'].includes(x.direction))throw Error('Ordenação inválida.');return {field:field(x.field),direction:x.direction};})};
    if(select){if(!Array.isArray(select)||!select.length)throw Error('Projeção inválida.');q.select={fields:select.map(field)};}
    const operators={eq:'EQUAL',lt:'LESS_THAN',lte:'LESS_THAN_OR_EQUAL',gt:'GREATER_THAN',gte:'GREATER_THAN_OR_EQUAL',contains:'ARRAY_CONTAINS'};
    if(filters.length){const parts=filters.map(x=>{if(!operators[x.op])throw Error('Filtro inválido.');return {fieldFilter:{field:field(x.field),op:operators[x.op],value:encodeValue(x.value)}};});q.where=parts.length===1?parts[0]:{compositeFilter:{op:'AND',filters:parts}};}
    const prefix=`projects/${this.api.project}/databases/(default)/documents/`;
    if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw Error('Cursor inválido.');}if(c.collection!==collection||JSON.stringify(c.orderBy)!==JSON.stringify(orderBy)||!Array.isArray(c.values)||c.values.length!==orderBy.length)throw Error('Cursor inválido.');q.startAt={values:c.values,before:false};}
    const rows=await this.api.request(this.root+':runQuery',{method:'POST',json:{structuredQuery:q}});
    if(!Array.isArray(rows))throw Error('Resposta de consulta inválida.');
    const docs=rows.filter(x=>x.document).map(x=>x.document);
    const records=docs.map(doc=>{if(!doc.name?.startsWith(prefix))throw Error('Documento fora do projeto.');const path=documentPath(doc.name.slice(prefix.length));if(!path.startsWith(collection+'/'))throw Error('Documento fora da coleção.');return {path,data:decodeFields(doc.fields??{}),updateTime:doc.updateTime};});
    const last=docs.at(-1);let nextCursor=null,lastCursor=null;
    if(last){const values=orderBy.map(x=>{if(x.field==='__name__')return {referenceValue:last.name};let v={mapValue:{fields:last.fields}};for(const key of x.field.split('.'))v=v?.mapValue?.fields?.[key];if(!v)throw Error('Campo de ordenação ausente.');return v;});lastCursor=Buffer.from(JSON.stringify({collection,orderBy,values})).toString('base64url');if(docs.length===limit)nextCursor=lastCursor;}
    return {records,nextCursor,lastCursor};
  }
  // One derived document only. Source/editorial/review/previous versions are
  // read in the same Firestore read-write transaction as the full replacement.
  async commitSemantic(input){return commitSemanticStore(this,input);}
  async compareAndReplaceDerived({path,replacement,checks}){
    const id=replacement?.reelId;
    if(!/^[A-Za-z0-9_-]{5,32}$/.test(id??'')||path!=='reels_index/contextual_'+id||replacement.kind!=='contextual_contribution'||!Array.isArray(checks))throw Error('Mutação fora do catálogo derivado.');
    const allowed=new Set([path,'videos/'+id,'reels_legacy_content/'+id,'settings/reels_v2_taxonomy','settings/reels_v2_contextual_catalogue','reels_index/contextual_review_'+id]);
    if(checks.length>7)throw Error('Precondições derivadas excedem o escopo.');
    const expected=new Map();for(const c of checks){documentPath(c.path);if(!allowed.has(c.path)&&!/^reels_quality_receipts\/quality_[a-f0-9]{64}$/.test(c.path))throw Error('Precondição fora da fonte contextual.');if(expected.has(c.path)||c.updateTime!==null&&(typeof c.updateTime!=='string'||!c.updateTime))throw Error('Precondição derivada inválida.');expected.set(c.path,c.updateTime);}
    for(const required of [path,'videos/'+id,'settings/reels_v2_taxonomy','settings/reels_v2_contextual_catalogue','reels_index/contextual_review_'+id])if(!expected.has(required))throw Error('Fonte editorial ou revisão sem precondição.');
    if(expected.get('videos/'+id)!==replacement.sourceVersions?.video||!expected.get('settings/reels_v2_contextual_catalogue'))throw Error('Fonte ou manifesto sem versão ativa.');
    if(replacement.sourceVersions?.legacy&&!expected.has('reels_legacy_content/'+id))throw Error('Fonte preservada sem precondição.');
    const prefix='projects/'+this.api.project+'/databases/(default)/documents/',begin=await this.api.request(this.root+':beginTransaction',{method:'POST',json:{options:{readWrite:{}}}}),transaction=begin?.transaction;
    if(typeof transaction!=='string'||!transaction)throw Error('Transação derivada ausente.');
    let finished=false;
    const rollback=async()=>{try{await this.api.request(this.root+':rollback',{method:'POST',json:{transaction}});}catch{}};
    try{
      const rows=await this.api.request(this.root+':batchGet',{method:'POST',json:{documents:[...expected.keys()].map(p=>prefix+p),mask:{fieldPaths:['id']},transaction}});
      if(!Array.isArray(rows))throw Error('Resposta transacional derivada inválida.');
      const observed=new Map();
      for(const row of rows){
        const name=row.found?.name??row.missing;
        if(typeof name!=='string'||!name.startsWith(prefix)||row.found&&row.missing)throw Error('Documento transacional fora do escopo.');
        const p=documentPath(name.slice(prefix.length));if(!expected.has(p)||observed.has(p))throw Error('Resposta transacional repetida ou externa.');
        if(row.found&&typeof row.found.updateTime!=='string')throw Error('Versão transacional ausente.');
        observed.set(p,row.found?row.found.updateTime:null);
      }
      if(observed.size!==expected.size)throw Error('Leitura transacional incompleta.');
      if([...expected].some(([p,v])=>observed.get(p)!==v)){await rollback();finished=true;return {applied:false,reason:'SOURCE_OR_EDITORIAL_VERSION_CHANGED'};}
      const current=expected.get(path),write={update:{name:prefix+documentPath(path),fields:encodeFields(replacement)},currentDocument:current===null?{exists:false}:{updateTime:current}};
      let result;
      try{
        result=await this.metadataWrite(this.root+':commit',{method:'POST',json:{transaction,writes:[write]}});
        if(!Array.isArray(result?.writeResults)||result.writeResults.length!==1||!result.writeResults[0].updateTime)throw Error('Confirmação derivada incompleta.');
      }catch(error){
        // Never repeat the write after an ambiguous acknowledgement.
        const after=await this.get(path);
        if(after&&isDeepStrictEqual(after.data,replacement)){finished=true;return {applied:true,updateTime:after.updateTime,reconciled:true};}
        throw Object.assign(Error('Commit derivado não comprovado; conferir evento sem repetir análise.'),{requiresReconciliation:true,cause:error});
      }
      finished=true;return {applied:true,updateTime:result.writeResults[0].updateTime};
    }finally{if(!finished)await rollback();}
  }

  async commit(writes){
    if(!Array.isArray(writes)||!writes.length||writes.length>450)throw Error('Commit inválido.');
    const prefix=`projects/${this.api.project}/databases/(default)/documents/`;
    const prepared=writes.map(w=>{if(!w.create&&!w.updateTime)throw Error('Commit requer precondição.');const fields=encodeFields(w.data);return {update:{name:prefix+documentPath(w.path),fields},...(w.create?{}:{updateMask:{fieldPaths:Object.keys(fields)}}),currentDocument:w.create?{exists:false}:{updateTime:w.updateTime}};});
    const result=await this.metadataWrite(this.root+':commit',{method:'POST',json:{writes:prepared}});
    if(result?.writeResults?.length!==writes.length||!result.writeResults.every(x=>x.updateTime))throw Error('Commit não confirmado; conferir sem repetir.');return result;
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
