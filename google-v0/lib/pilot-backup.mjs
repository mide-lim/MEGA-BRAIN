// Administrative export/restore only. Never included in worker images.
import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
const project='megabrain-v0-1017370021431',bucket=project+'-media';
const collections=['videos','settings','analyses','migration_runs','jobs','reservations'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
async function documents(store){
 const result=[];
 for(const collection of collections){
  let pageToken=null;const seen=new Set();
  do{
   const page=await store.list(collection,{pageSize:100,pageToken});
   for(const record of page.records){
    if(typeof record.path!=='string'||!new RegExp('^'+collection+'/[A-Za-z0-9_-]{1,128}$').test(record.path)||typeof record.updateTime!=='string')throw new Error('Documento fora do escopo do backup.');
    result.push(record);if(result.length>5000)throw new Error('Backup acima do limite do piloto.');
   }
   pageToken=page.nextPageToken;
   if(pageToken){if(seen.has(pageToken))throw new Error('Paginação circular.');seen.add(pageToken);}
  }while(pageToken);
 }
 return result.sort((a,b)=>a.path.localeCompare(b.path));
}
function objectDescriptor(object){
 if(object.bucket!==bucket||typeof object.name!=='string'||!object.name.split('/').every(s=>/^[A-Za-z0-9_.-]+$/.test(s)&&!['.','..'].includes(s))||!['originals','results','previews','temporary'].includes(object.name.split('/')[0])||!/^\d+$/.test(object.generation??'')||!Number.isSafeInteger(object.bytes)||object.bytes<1||object.bytes>100000000||!/^[a-f0-9]{64}$/.test(object.sha256??''))throw new Error('Objeto fora do escopo do backup.');
 return {bucket,name:object.name,generation:object.generation,bytes:object.bytes,sha256:object.sha256};
}
function objectCatalog(objects){
 if(!Array.isArray(objects)||objects.length>200)throw new Error('Catálogo acima do limite do piloto.');
 const list=objects.map(objectDescriptor).sort((a,b)=>a.name.localeCompare(b.name));
 if(new Set(list.map(o=>o.name)).size!==list.length)throw new Error('Objeto duplicado.');
 return list;
}
async function readRegular(path,limit){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('Arquivo de backup inválido.');return readFile(path);}
export async function exportPilotBackup({store,objects,directory,queuePaused,clock=()=>Date.now()}){
 if(!isAbsolute(directory)||queuePaused!==true)throw new Error('Backup exige destino absoluto e fila pausada conferida.');
 const initial=await documents(store);
 const settings=Object.fromEntries(initial.filter(d=>d.path.startsWith('settings/')).map(d=>[d.path,d.data]));
 if(settings['settings/automation']?.enabled!==false||settings['settings/financial']?.paused!==true||Object.values(settings['settings/financial']?.jobs??{}).some(j=>['upload','transcription','analysis'].includes(j.stage)&&['reserved','started'].includes(j.status)))throw new Error('Pausar e drenar execuções antes do backup.');
 const catalog=objectCatalog(await objects.list());
 // mkdir must fail for existing paths: no overwrite or deletion of previous backups.
 await mkdir(directory,{mode:0o700});await mkdir(join(directory,'objects'),{mode:0o700});
 const docs=Buffer.from(canonical(initial));await writeFile(join(directory,'documents.json'),docs,{flag:'wx',mode:0o600});
 const saved=[];
 for(const object of catalog){
  const bytes=await objects.read(object.name,{generation:object.generation});
  if(!Buffer.isBuffer(bytes)||bytes.length!==object.bytes||hash(bytes)!==object.sha256)throw new Error('Checksum da mídia diverge; backup incompleto.');
  const file=hash(Buffer.from(object.name))+'.bin';await writeFile(join(directory,'objects',file),bytes,{flag:'wx',mode:0o600});saved.push({...object,file});
 }
 // Detect late writes, new documents and new objects. Partial backups have no manifest.
 if(hash(Buffer.from(canonical(await documents(store))))!==hash(docs)||JSON.stringify(objectCatalog(await objects.list()))!==JSON.stringify(catalog))throw new Error('Dados alterados durante backup; repetir após drenar, em novo diretório.');
 const manifest={schema_version:1,project,bucket,created_at:new Date(clock()).toISOString(),documents_sha256:hash(docs),document_count:initial.length,objects:saved};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
 return {completed:true,document_count:initial.length,object_count:saved.length};
}
export async function verifyPilotBackup(directory){
 if(!isAbsolute(directory))throw new Error('Destino absoluto obrigatório.');
 const manifest=JSON.parse(await readRegular(join(directory,'manifest.json'),1000000));
 if(manifest.schema_version!==1||manifest.project!==project||manifest.bucket!==bucket||!/^[a-f0-9]{64}$/.test(manifest.documents_sha256??''))throw new Error('Manifesto de backup inválido.');
 const catalog=objectCatalog(manifest.objects),docs=await readRegular(join(directory,'documents.json'),20000000);
 if(hash(docs)!==manifest.documents_sha256)throw new Error('Documentos corrompidos.');
 const records=JSON.parse(docs);if(!Array.isArray(records)||records.length!==manifest.document_count||records.length>5000)throw new Error('Contagem de documentos inválida.');
 const paths=new Set();
 for(const record of records){if(!collections.some(c=>new RegExp('^'+c+'/[A-Za-z0-9_-]{1,128}$').test(record.path??''))||paths.has(record.path))throw new Error('Caminho de restauração inválido.');paths.add(record.path);}
 for(const object of catalog){
  const source=manifest.objects.find(o=>o.name===object.name),expected=hash(Buffer.from(object.name))+'.bin';
  if(source.file!==expected)throw new Error('Caminho de arquivo inválido.');
  const bytes=await readRegular(join(directory,'objects',expected),100000000);
  if(bytes.length!==object.bytes||hash(bytes)!==object.sha256)throw new Error('Mídia corrompida.');
 }
 return {manifest,records,verified:true};
}
export async function restorePilotBackupLocally({source,destination}){
 if(!isAbsolute(destination))throw new Error('Destino absoluto obrigatório.');
 const verified=await verifyPilotBackup(source);
 await mkdir(destination,{mode:0o700});await mkdir(join(destination,'objects'),{mode:0o700});
 // Local recovery material only; no dispatching, inference or Google mutations.
 for(const object of verified.manifest.objects)await writeFile(join(destination,'objects',object.file),await readRegular(join(source,'objects',object.file),100000000),{flag:'wx',mode:0o600});
 await writeFile(join(destination,'documents.json'),JSON.stringify(verified.records),{flag:'wx',mode:0o600});
 await writeFile(join(destination,'manifest.json'),JSON.stringify(verified.manifest),{flag:'wx',mode:0o600});
 await verifyPilotBackup(destination);
 return {restored_locally:true,google_import_performed:false,activation_changed:false,object_count:verified.manifest.objects.length};
}
