import {migrationHash} from './reels-migration.mjs';

// Data-only reconciliation. A Reel ID links a current Google object to a Reel;
// it never proves that an older R2 object contained the same bytes.
const sha=/^[a-f0-9]{64}$/;
const rid=/^[A-Za-z0-9_-]{5,32}$/;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const clone=v=>structuredClone(v);
export function assertImportJson(value,parents=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(!object(value)&&!Array.isArray(value)||object(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Importação aceita somente dados JSON.');
 if(parents.has(value))throw Error('Referência circular na importação.');
 for(const k of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,k);if(typeof k!=='string'||d.get||d.set)throw Error('Acessores e símbolos não são dados JSON.');}
 parents.add(value);for(const v of Object.values(value))assertImportJson(v,parents);parents.delete(value);
}
function index(rows,key,label){const result=new Map();for(const row of rows){const id=key(row);if(!id||result.has(id))throw Error('Identidade inválida ou duplicada: '+label);result.set(id,row);}return result;}
const size=v=>Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
const identity=v=>migrationHash([v.bucket??null,v.key??v.name??null,String(v.generation??'')]);
function complete(v){return object(v)&&typeof v.bucket==='string'&&!!v.bucket&&typeof v.key==='string'&&!!v.key&&/^\d+$/.test(String(v.generation??''))&&size(v.size)!==null&&sha.test(v.sha256??'');}
function seal(body){return {...body,hash:migrationHash(body)};}
export function verifyBackupLinkManifest(manifest,input){
 assertImportJson(manifest);const {hash,...body}=manifest;
 if(body.schemaVersion!==1||body.kind!=='reels_backup_link_manifest'||!sha.test(hash??'')||migrationHash(body)!==hash)throw Error('Manifesto de vínculos alterado.');
 if(input&&buildBackupLinkManifest(input).hash!==hash)throw Error('Origens dos vínculos divergentes.');return true;
}
export function buildBackupLinkManifest(input){
 assertImportJson(input);
 if(!object(input)||Object.keys(input).some(k=>!['googleSnapshot','legacySnapshot','physicalCopyReceipt','originAliases','humanBackupAssertion'].includes(k)))throw Error('Escopo de vínculos inválido.');
 const {googleSnapshot:g,legacySnapshot:l,physicalCopyReceipt:p,originAliases=[]}=input;
 if(!object(g)||!Array.isArray(g.records)||!Array.isArray(g.objectInventory)||!object(l)||!Array.isArray(l.videos)||!object(p)||!Array.isArray(p.objects)||!Array.isArray(originAliases))throw Error('Origens de vínculos incompletas.');
 const google=index(g.records.filter(r=>r.path?.startsWith('videos/')),r=>rid.test(r.path.slice(7))?r.path.slice(7):null,'vídeos Google');
 const legacy=index(l.videos,v=>rid.test(v?.id)?v.id:null,'vídeos legados');
 const inventory=index(g.objectInventory,v=>identity({...v,bucket:v.bucket??g.bucket}), 'inventário Google');
 const receipts=index(p.objects,v=>identity(v),'recibo físico');
 const verified=new Map();
 for(const [key,proof]of receipts){
  const original=inventory.get(key);
  if(!original||!complete(proof)||proof.sourceVerified!==true||proof.restoreVerified!==true||size(original.size)!==size(proof.size)||original.sha256&&original.sha256!==proof.sha256)throw Error('Recibo físico não corresponde ao inventário fornecido.');
  verified.set(key,proof);
 }
 const aliases=new Map();
 for(const alias of originAliases){
  if(!object(alias)||!rid.test(alias.reelId??'')||!complete(alias.source)||!complete(alias.target)||alias.sourceVerified!==true||!sha.test(alias.evidenceHash??'')||alias.source.sha256!==alias.target.sha256||size(alias.source.size)!==size(alias.target.size))throw Error('Alias exige prova explícita da origem e igualdade de bytes.');
  const old=legacy.get(alias.reelId),target=verified.get(identity(alias.target));
  if(!old||old.video_key!==alias.source.key||!target||target.sha256!==alias.target.sha256||size(target.size)!==size(alias.target.size)||old.video_bucket&&old.video_bucket!==alias.source.bucket||old.video_generation&&String(old.video_generation)!==String(alias.source.generation))throw Error('Alias diverge da origem ou do recibo.');
  if(aliases.has(alias.reelId))throw Error('Alias duplicado ou ambíguo.');aliases.set(alias.reelId,alias);
 }
 const entries=[];
 for(const id of [...new Set([...google.keys(),...legacy.keys()])].sort()){
  const gr=google.get(id),v=gr?.data,old=legacy.get(id),alias=aliases.get(id);
  if(v?.id!==undefined&&v.id!==id)throw Error('ID Google diverge do documento.');
  const key=v?.video_key?{bucket:v.video_bucket??v.storage_bucket??g.bucket??null,key:v.video_key,generation:v.video_generation??null}:null;
  const proof=key?verified.get(identity(key)):null;
  const current=proof?{status:'current_google_media_verified',bucket:proof.bucket,key:proof.key,generation:String(proof.generation),size:size(proof.size),sha256:proof.sha256,proofHash:migrationHash(proof),recordHash:migrationHash(gr),legacyBytesEqualityProven:false}:key?{status:'current_google_reference_unverified',...key,legacyBytesEqualityProven:false}:null;
  const legacyReference=old?.video_key?{key:old.video_key,bucket:old.video_bucket??l.bucket??null,generation:old.video_generation??null,status:alias?'origin_alias_bytes_verified':'backup_reference_unlocated',humanBackupConfirmed:typeof input.humanBackupAssertion==='string'&&!!input.humanBackupAssertion.trim(),sourceHash:migrationHash(old),alias:alias?clone(alias):null,deleted:false,missing:false}:null;
  entries.push({reelId:id,currentGoogle:current,legacyReference,processingEligible:false});
 }
 return seal({schemaVersion:1,kind:'reels_backup_link_manifest',sourceHashes:{googleSnapshot:migrationHash(g),legacySnapshot:migrationHash(l),physicalCopyReceipt:migrationHash(p),originAliases:migrationHash(originAliases)},humanBackupAssertion:input.humanBackupAssertion??null,entries,counts:{reels:entries.length,currentGoogleMediaVerified:entries.filter(e=>e.currentGoogle?.status==='current_google_media_verified').length,legacyMediaReferences:entries.filter(e=>e.legacyReference).length,originAliasesBytesVerified:aliases.size,legacyReferencesUnlocated:entries.filter(e=>e.legacyReference?.status==='backup_reference_unlocated').length},execution:{mode:'data_only',processing:false,sourceWrites:0,sourceDeletions:0,newPhysicalReads:0},limitations:['Recibos fornecidos são evidências externas; esta função não lê novamente bytes nem prova cobertura de outros buckets.','Vínculo por documento Google identifica a mídia atual do Reel, sem presumir igualdade com um original R2.','Referência de backup não localizada permanece preservada; não é diagnóstico de perda ou autorização de processamento.']});
}
