import {createHash} from 'node:crypto';
export const fragmentCount=16;
const specs={'settings/financial':{field:'jobs',prefix:'financial_jobs',key:/^[A-Za-z][A-Za-z0-9_]{0,99}$/},'settings/capacity':{field:'claims',prefix:'capacity_claims',key:/^object_[a-f0-9]{64}$/}};
export const fragmentSpec=path=>specs[path]??null;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const serialized=value=>JSON.stringify(canonical(value));
export const mapDigest=map=>createHash('sha256').update(serialized(map)).digest('hex');
export const fragmentIndex=key=>parseInt(createHash('sha256').update(key).digest('hex').slice(0,2),16)%fragmentCount;
export const fragmentPath=(spec,index)=>`control_chunks/${spec.prefix}_${index.toString(16).padStart(2,'0')}`;
export function splitControlMap(path,map){
 const spec=fragmentSpec(path);if(!spec||!map||Array.isArray(map)||typeof map!=='object')throw Error('Mapa de controle inválido.');
 const chunks=Array.from({length:fragmentCount},()=>({}));
 for(const [key,value] of Object.entries(map)){if(!spec.key.test(key)||['__proto__','constructor','prototype'].includes(key)||!value||typeof value!=='object'||Array.isArray(value))throw Error('Entrada de controle inválida.');chunks[fragmentIndex(key)][key]=value;}
 return chunks;
}
export function fragmentMarker(path,map){const spec=fragmentSpec(path);splitControlMap(path,map);return {schema_version:1,count:fragmentCount,field:spec.field,entry_count:Object.keys(map).length,digest:mapDigest(map)};}
export function hydrateFragments(path,root,records){
 const spec=fragmentSpec(path),m=root.control_fragments;
 if(!spec||m?.schema_version!==1||m.count!==fragmentCount||m.field!==spec.field||!Number.isSafeInteger(m.entry_count)||m.entry_count<0||!/^[a-f0-9]{64}$/.test(m.digest??'')||!root[spec.field]||Object.keys(root[spec.field]).length)throw Error('Manifesto fragmentado inválido.');
 const chunks=[],map={};
 for(let index=0;index<fragmentCount;index++){
  const record=records.find(x=>x.path===fragmentPath(spec,index));
  if(!record?.updateTime||record.data?.schema_version!==1||record.data.owner!==path||record.data.index!==index||!record.data.entries||Array.isArray(record.data.entries))throw Error('Fragmento ausente ou inválido.');
  for(const [key,value] of Object.entries(record.data.entries)){
   if(!spec.key.test(key)||fragmentIndex(key)!==index||Object.hasOwn(map,key)||!value||typeof value!=='object'||Array.isArray(value))throw Error('Conteúdo de fragmento inválido.');map[key]=value;
  }
  chunks.push(record);
 }
 if(Object.keys(map).length!==m.entry_count||mapDigest(map)!==m.digest)throw Error('Fragmentos divergem do manifesto.');
 return {data:{...root,[spec.field]:map},chunks};
}
export function planFragmentPatch(path,snapshot,changes){
 const spec=fragmentSpec(path);if(!spec||!snapshot?.chunks||Object.hasOwn(changes,'control_fragments'))throw Error('Atualização de fragmentos fora do contrato.');
 const roots={...changes},updates=[];
 if(Object.hasOwn(changes,spec.field)){
  const previous=snapshot.data[spec.field],next=changes[spec.field];const chunks=splitControlMap(path,next);
  if(Object.keys(previous).some(key=>!Object.hasOwn(next,key)))throw Error('Histórico de controle não pode ser removido.');
  for(let index=0;index<fragmentCount;index++)if(serialized(chunks[index])!==serialized(snapshot.chunks[index].data.entries))updates.push({...snapshot.chunks[index],changes:{entries:chunks[index]}});
  delete roots[spec.field];if(updates.length)roots.control_fragments=fragmentMarker(path,next);
 }
 return {rootChanges:roots,updates};
}
export function planControlMigration({financial,capacity,automation,admission,project}){
 if(project!=='megabrain-v0-1017370021431'||financial?.data?.paused!==true||automation?.data?.enabled!==false||admission?.data?.enabled!==false||Object.values(financial.data.jobs??{}).some(j=>['upload','transcription','analysis'].includes(j.stage)&&j.status==='started'))throw Error('Pausar admissão e drenar operações iniciadas antes da migração.');
 const prefix=`projects/${project}/databases/(default)/documents/`,writes=[],proof=[];
 for(const [path,snapshot] of [['settings/financial',financial],['settings/capacity',capacity]]){
  const spec=fragmentSpec(path);if(!snapshot?.updateTime||snapshot.data.control_fragments)throw Error('Snapshot legado obrigatório.');
  const map=snapshot.data[spec.field],chunks=splitControlMap(path,map),marker=fragmentMarker(path,map);
  proof.push({path,updateTime:snapshot.updateTime,entries:marker.entry_count,digest:marker.digest,legacy_snapshot:snapshot.data});
  writes.push({path:`analyses/control_archive_${spec.prefix}_${marker.digest.slice(0,16)}`,data:{owner:path,source_update_time:snapshot.updateTime,original:snapshot.data,digest:marker.digest},exists:false});
  chunks.forEach((entries,index)=>writes.push({path:fragmentPath(spec,index),data:{schema_version:1,owner:path,index,entries},exists:false}));
  writes.push({path,changes:{[spec.field]:{},control_fragments:marker},updateTime:snapshot.updateTime});
 }
 // Both controls guard the cutover in the same atomic commit, not just in a prior read.
 for(const [path,snapshot] of [['settings/automation',automation],['settings/admission',admission]]){
  if(!snapshot.updateTime)throw Error('Versão dos controles obrigatória.');writes.push({path,changes:{enabled:false},updateTime:snapshot.updateTime});
 }
 return {schema_version:1,project,prefix,writes,proof,applied:false,requires_independent_review:true};
}
