import {buildMigrationManifest,migrationHash} from './reels-migration.mjs';
import {reelIdPattern} from './reels-model.mjs';
import {fragmentSpec,hydrateFragments} from './control-fragments.mjs';

// Offline planning only. No store, transport, filesystem or provider is accepted.
const clone=value=>structuredClone(value);
const shaPattern=/^[a-f0-9]{64}$/;
const allowedInput=new Set(['source','sourceRevision','googleSnapshot','legacySnapshot','corpus']);
const artifactKinds=['video','audio','transcript','analysis','candidate_analysis','raw_response','analysis_raw','gemini_response','diagnostic','download_diagnostic'];
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function jsonValue(value,ancestors=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!object(value)&&!Array.isArray(value))throw Error('A cópia aceita somente dados JSON, sem adaptadores ou funções.');
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Objeto não JSON na origem.');
 if(ancestors.has(value))throw Error('Referência circular na origem.');
 for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')throw Error('Chave não JSON na origem.');const d=Object.getOwnPropertyDescriptor(value,key);if(d.get||d.set)throw Error('Acessores não JSON na origem.');}
 ancestors.add(value);for(const v of Array.isArray(value)?value:Object.values(value))jsonValue(v,ancestors);ancestors.delete(value);
}
function uniqueBy(values,key,label){const map=new Map();for(const value of values){const id=key(value);if(!id||map.has(id))throw Error('Identidade inválida/duplicada: '+label);map.set(id,value);}return map;}
function controlRecords(snapshot){
 if(Array.isArray(snapshot.controls))return snapshot.controls;
 return Object.entries(snapshot.controls).map(([key,value])=>{
  if(!object(value))throw Error('Controle objeto deve conter documento ou dados selecionados.');
  // Object keys are explicit document paths, or settings IDs for the historical
  // selected-field shape. Preserve the original object; normalize only the index.
  const path=value.path??(key.includes('/')?key:'settings/'+key),data=Object.hasOwn(value,'data')?value.data:value;
  return {path,data,updateTime:value.updateTime??value.typedSource?.updateTime??null,...(Object.hasOwn(value,'typedSource')?{typedSource:value.typedSource}:{})};
 });
}
function googleRecords(snapshot){
 const normalize=r=>object(r)?{...r,updateTime:r.updateTime??r.typedSource?.updateTime??null}:r;
 const base=snapshot.records.map(normalize),controls=controlRecords(snapshot).map(normalize);
 const baseMap=uniqueBy(base,r=>r?.path,'documento Google'),controlMap=uniqueBy(controls,r=>r?.path,'controle Google');
 for(const [path,r]of controlMap){const existing=baseMap.get(path);if(existing){if(migrationHash(existing.data)!==migrationHash(r.data)||(existing.updateTime&&r.updateTime&&existing.updateTime!==r.updateTime))throw Error('Controle diverge do documento Google.');}else baseMap.set(path,r);}
 return [...baseMap.values()];
}
function validId(id){if(typeof id!=='string'||!reelIdPattern.test(id))throw Error('ID de Reel inválido.');return id;}
function sourceUrl(url,id){
 if(url===undefined||url===null)return null;
 let parsed;try{parsed=new URL(url);}catch{throw Error('URL de origem inválida.');}
 const match=parsed.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
 if(parsed.protocol!=='https:'||!['instagram.com','www.instagram.com'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.port||!match||match[1]!==id)throw Error('URL não corresponde ao Reel.');
 return url;
}
function validate(input){
 jsonValue(input);if(!object(input)||Object.keys(input).some(k=>!allowedInput.has(k)))throw Error('Escopo de cópia inválido; aplicar migração não é suportado.');
 if(typeof input.source!=='string'||!input.source.trim()||typeof input.sourceRevision!=='string'||!input.sourceRevision.trim())throw Error('Origem e revisão dos dados obrigatórias.');
 const {googleSnapshot:g,legacySnapshot:l,corpus}=input;
 if(!object(g)||!Array.isArray(g.records)||(!object(g.controls)&&!Array.isArray(g.controls))||!Array.isArray(g.objectInventory)||!object(l)||!Array.isArray(l.videos)||!object(l.histories)||!Array.isArray(corpus))throw Error('Snapshots incompletos.');
 for(const rows of Object.values(l.histories))if(!Array.isArray(rows))throw Error('Histórico deve conservar linhas por tabela.');
 const controlsWithoutTimestamp=new Set(controlRecords(g).filter(r=>!r.updateTime&&!r.typedSource?.updateTime).map(r=>r.path));
 const records=uniqueBy(googleRecords(g),r=>{
  if(!object(r)||!/^\w[\w-]*\/[A-Za-z0-9_-]+$/.test(r.path??'')||!object(r.data)||(!(typeof r.updateTime==='string'&&r.updateTime)&&!controlsWithoutTimestamp.has(r.path)))throw Error('Documento Google inválido.');
  return r.path;
 },'documento Google');
 const googleVideos=new Map();for(const [path,r]of records)if(path.startsWith('videos/')){
  const id=validId(path.slice(7));if(r.data.id!==undefined&&r.data.id!==id)throw Error('ID Google diverge do caminho.');googleVideos.set(id,r);
 }
 const legacyVideos=uniqueBy(l.videos,v=>validId(v?.id),'vídeo legado');
 const corpusRows=uniqueBy(corpus,r=>{const id=validId(r?.id);sourceUrl(r.url,id);if(!Number.isSafeInteger(r.source_line)||r.source_line<1)throw Error('Linha de origem inválida.');return id;},'corpus');
 for(const v of legacyVideos.values())sourceUrl(v.source_url??null,v.id);
 return {records,googleVideos,legacyVideos,corpusRows};
}
function seal(body){return {...body,hash:migrationHash(body)};}
function unseal(envelope,kind){
 jsonValue(envelope);const {hash,...body}=envelope;
 if(body.schemaVersion!==1||body.kind!==kind||!shaPattern.test(hash??'')||migrationHash(body)!==hash)throw Error('Pacote de cópia alterado ou corrompido.');
 return body;
}

export function createMigrationCopyBackup(input){validate(input);return seal({schemaVersion:1,kind:'reels_migration_copy_backup',input:clone(input)});}
export function restoreMigrationCopyBackup(backup){const body=unseal(backup,'reels_migration_copy_backup');validate(body.input);return clone(body.input);}

function executionEvidence(records){return records.filter(r=>['jobs','reels_executions'].includes(r.path.split('/')[0])).map(r=>({...r.data,evidencePath:r.path}));}
function ledgerEvidence(records){
 const rows=[];for(const r of records){
  if(r.path==='settings/financial'&&object(r.data.jobs))for(const [key,v]of Object.entries(r.data.jobs))if(object(v))rows.push({...v,evidencePath:r.path,evidenceKey:key});
  if(r.path.startsWith('control_chunks/')&&r.data.owner==='settings/financial'&&object(r.data.entries))for(const [key,v]of Object.entries(r.data.entries))if(object(v))rows.push({...v,evidencePath:r.path,evidenceKey:key});
  if(r.path.startsWith('reservations/'))rows.push({...r.data,evidencePath:r.path});
 }return rows;
}
function collectArtifactReferences(value,{source,owner,bucket=null},path='',result=[]){
 if(!object(value)&&!Array.isArray(value))return result;
 if(Array.isArray(value)){value.forEach((v,i)=>collectArtifactReferences(v,{source,owner,bucket},path+'['+i+']',result));return result;}
 for(const kind of artifactKinds)if(typeof value[kind+'_key']==='string'&&value[kind+'_key'])result.push({source,owner,field:path?(path+'.'+kind):kind,bucket:value[kind+'_bucket']??value.storage_bucket??bucket,key:value[kind+'_key'],generation:value[kind+'_generation']??null,expectedSha256:value[kind+'_sha256']??null});
 if(typeof value.key==='string'&&value.key&&Object.hasOwn(value,'generation'))result.push({source,owner,field:path||'artifact',bucket:value.bucket??bucket,key:value.key,generation:value.generation??null,expectedSha256:value.sha256??null});
 for(const [key,v]of Object.entries(value))if(object(v)||Array.isArray(v))collectArtifactReferences(v,{source,owner,bucket},path?(path+'.'+key):key,result);
 return result;
}
function artifactAudit(input){
 const refs=[],g=input.googleSnapshot,l=input.legacySnapshot;
 for(const r of googleRecords(g))collectArtifactReferences(r.data,{source:'google',owner:r.path,bucket:g.bucket??null},'',refs);
 for(const v of l.videos)collectArtifactReferences(v,{source:'legacy',owner:'videos/'+v.id,bucket:l.bucket??null},'',refs);
 for(const [table,rows]of Object.entries(l.histories))rows.forEach((r,i)=>collectArtifactReferences(r,{source:'legacy',owner:table+'/'+i,bucket:l.bucket??null},'',refs));
 for(const r of g.artifactReferences??[]){if(!object(r)||typeof r.owner!=='string'||typeof r.key!=='string')throw Error('Referência explícita de artefato inválida.');refs.push({source:'google',owner:r.owner,field:r.field??'explicit',bucket:r.bucket??g.bucket??null,key:r.key,generation:r.generation??null,expectedSha256:r.sha256??null});}
 const inventory=[...g.objectInventory,...(l.objectInventory??[])];
 for(const p of inventory)if(!object(p)||typeof p.key!=='string'||!p.key)throw Error('Inventário de objetos inválido.');
 const identity=p=>migrationHash([p.bucket??null,p.key,String(p.generation??'')]);
 const byIdentity=new Map();for(const p of inventory){const key=identity(p);if(!byIdentity.has(key))byIdentity.set(key,[]);byIdentity.get(key).push(p);}
 const references=refs.map(r=>{
  const proofs=byIdentity.get(identity(r))??[];
  const completeIdentity=typeof r.bucket==='string'&&r.bucket.length>0&&/^\d+$/.test(String(r.generation??''));
  const verified=completeIdentity&&proofs.length>0&&proofs.every(p=>p.sourceVerified===true&&Number.isSafeInteger(p.size??p.bytes)&&(p.size??p.bytes)>=0&&shaPattern.test(p.sha256??'')&&(!r.expectedSha256||r.expectedSha256===p.sha256))&&new Set(proofs.map(p=>migrationHash([p.sha256,p.size??p.bytes]))).size===1;
  return {...r,sourceBytesProofProvided:verified,reason:!completeIdentity?'missing_bucket_or_generation':!proofs.length?'missing_inventory_proof':verified?'provided_source_bytes_proof':'metadata_only_or_conflicting_proof',proofHashes:proofs.map(p=>migrationHash(p)).sort()};
 }).sort((a,b)=>migrationHash(a).localeCompare(migrationHash(b)));
 const uniqueInventory=new Map(inventory.map(p=>[migrationHash(p),p]));
 return {references,inventory:clone(inventory),inventoryCount:inventory.length,distinctInventoryRecords:uniqueInventory.size,referenceCount:references.length,providedSourceBytesProofs:references.filter(r=>r.sourceBytesProofProvided).length,unverifiedReferences:references.filter(r=>!r.sourceBytesProofProvided).length,physicalCopiesPerformed:false,physicalObjectsCopied:0,physicalObjectBytesCopied:0,physicalRestorationVerified:false,note:'Esta função verifica apenas dados e provas fornecidas. Metadados e flags não executam nem comprovam uma nova cópia física; recibos externos de leitura/restauração continuam necessários.'};
}
function fieldConflicts(google,legacy){
 const fields=['source_url','status','video_key','transcript','analysis','error'];
 return fields.filter(k=>Object.hasOwn(google,k)&&Object.hasOwn(legacy,k)&&migrationHash(google[k])!==migrationHash(legacy[k])).map(field=>({field,googleHash:migrationHash(google[field]),legacyHash:migrationHash(legacy[field]),chosen:'google',reason:'preserve_current_google_record'}));
}
function legacyReconciliation(old,id,histories){
 if(!old)return [];
 const reasons=[];
 if(old.status!=='pending')reasons.push('legacy_status_not_proven_unprocessed');
 if(old.analysis!==undefined&&old.analysis!==null||old.transcript!==undefined&&old.transcript!==null||artifactKinds.some(k=>!!old[k+'_key']))reasons.push('legacy_saved_content_requires_reconciliation');
 if(old.uncertain===true||old.paid_result_uncertain===true||old.error?.uncertain===true)reasons.push('legacy_paid_result_uncertain');
 const linked=Object.values(histories).flat().filter(r=>object(r)&&([r.video_id,r.reelId,r.reel_id].includes(id)||typeof r.key==='string'&&r.key.includes(id)));
 if(linked.some(r=>!(r.terminal_confirmed===true&&['failed','cancelled','not_started'].includes(r.status)&&r.paid_result_uncertain!==true&&r.error?.uncertain!==true&&(!(r.operation_name||r.operationName)||r.external_terminal_confirmed===true))))reasons.push('legacy_history_requires_reconciliation');
 return reasons;
}
function snapshotCoverage(snapshot){
 const records=googleRecords(snapshot),byPath=new Map(records.map(r=>[r.path,r])),fragmentAudits=[];
 for(const r of records)if(fragmentSpec(r.path)&&r.data.control_fragments){
  try{const hydrated=hydrateFragments(r.path,r.data,records);fragmentAudits.push({path:r.path,verified:true,chunkCount:hydrated.chunks.length,entryCount:r.data.control_fragments.entry_count,digest:r.data.control_fragments.digest});}
  catch{fragmentAudits.push({path:r.path,verified:false,reason:'missing_or_conflicting_control_fragments'});}
 }
 const missingOwners=[...new Set(records.filter(r=>r.path.startsWith('control_chunks/')&&typeof r.data.owner==='string'&&!byPath.has(r.data.owner)).map(r=>r.data.owner))].sort();
 const typedSourceProvided=records.filter(r=>Object.hasOwn(r,'typedSource')).length,controlsWithoutUpdateTime=controlRecords(snapshot).filter(r=>!r.updateTime&&!r.typedSource?.updateTime).map(r=>r.path).sort();
 return {recordCount:records.length,typedSourceProvided,typedSourceMissing:records.length-typedSourceProvided,controlsWithoutUpdateTime,fragmentAudits,fragmentOwnersWithoutRoot:missingOwners,providedFragmentProofsValid:fragmentAudits.every(a=>a.verified)&&missingOwners.length===0,sourceCollectionCompletenessVerified:false,note:'Restauração exata cobre os registros fornecidos. Cobertura completa das coleções e estabilidade da leitura precisam do recibo externo do coletor. Controles objeto são indexados por caminho explícito ou settings/ID; sem updateTime continuam evidência datada incompleta.'};
}

export function buildMigrationCopyPlan(input){
 const indexed=validate(input),g=input.googleSnapshot,l=input.legacySnapshot;
 const allIds=[...new Set([...indexed.googleVideos.keys(),...indexed.legacyVideos.keys(),...indexed.corpusRows.keys()])].sort();
 const googleData=[...indexed.googleVideos].map(([id,r])=>({...r.data,id}));
 const sourceInventory=g.objectInventory.map(p=>({...p,size:p.size??p.bytes??null}));
 const effectiveRecords=[...indexed.records.values()];
 const googleReview=buildMigrationManifest({source:input.source,sourceRevision:input.sourceRevision,videos:googleData,executionEvidence:executionEvidence(effectiveRecords),ledgerEvidence:ledgerEvidence(effectiveRecords),artifactInventory:sourceInventory,evidenceComplete:false});
 const reviews=new Map(googleReview.entries.map(e=>[e.id,e]));
 const videos=[],entries=[];
 for(const id of allIds){
  const gr=indexed.googleVideos.get(id),old=indexed.legacyVideos.get(id),cr=indexed.corpusRows.get(id),conflicts=gr&&old?fieldConflicts(gr.data,old):[],review=reviews.get(id);
  const legacyBlockers=!gr?legacyReconciliation(old,id,l.histories):[];
  const target=gr?{...clone(gr.data),id}:{id,source_url:cr?.url??old?.source_url??null,status:legacyBlockers.length?'uncertain':'registered',stage:null,...(legacyBlockers.length?{uncertain:true,error:{code:'LEGACY_RECONCILIATION_REQUIRED',uncertain:true,destination:'reconcile',retryable:false}}:{})};
  const blockers=[];
  if(gr&&review.disposition!=='preserve_success')blockers.push('google_requires_reconciliation');
  if(conflicts.length)blockers.push('cross_source_conflict_preserved');
  blockers.push(...legacyBlockers);
  if(!gr&&!target.source_url)blockers.push('missing_source_url');
  videos.push(target);
  entries.push({id,disposition:gr?'preserve_google_in_copy':legacyBlockers.length?'retain_legacy_reconciliation_in_copy':'register_only_in_copy',processingEligible:false,googleSource:gr?{path:gr.path,updateTime:gr.updateTime,recordHash:migrationHash(gr),dataHash:migrationHash(gr.data),typedSourceHash:gr.typedSource===undefined?null:migrationHash(gr.typedSource)}:null,legacySource:old?{table:'videos',recordHash:migrationHash(old),archiveOnly:true}:null,corpusSource:cr?{sourceLine:cr.source_line,recordHash:migrationHash(cr)}:null,targetHash:migrationHash(target),googleReconciliation:review?{disposition:review.disposition,reason:review.reason,manifestEntryHash:migrationHash(review)}:null,conflicts,blockers});
 }
 const artifacts=artifactAudit(input),coverage=snapshotCoverage(g);
 const protectedArchive={legacySnapshot:clone(l),sourceCorpus:clone(input.corpus),excludedFromOperationalHistory:true,reason:'Preservar conteúdo e históricos antigos sem os ligar automaticamente a novos cadastros ou substituir a publicação Google.'};
 const targetCopy={videos,googleRecords:clone(g.records),controls:clone(g.controls),objectInventory:clone(g.objectInventory)};
 const historyTransition={status:'preserved_not_imported_or_reprojected',googleExistingEventRecords:effectiveRecords.filter(r=>r.path.startsWith('reels_events/')).length,legacyTableRows:Object.fromEntries(Object.entries(l.histories).map(([table,rows])=>[table,rows.length])),legacyHistoryOperationallyLinked:false,financialProjectionRebuilt:false,newRuntimeAdmissionActivated:false,note:'O ensaio preserva históricos, reservas e valores de origem. Não importa eventos antigos para o log novo nem recalcula/projeta o financeiro da web.'};
 const body={schemaVersion:1,kind:'reels_migration_copy_plan',source:input.source,sourceRevision:input.sourceRevision,inputHash:migrationHash(input),sourceHashes:{googleSnapshot:migrationHash(g),legacySnapshot:migrationHash(l),corpus:migrationHash(input.corpus)},entries,targetCopy,protectedArchive,artifacts,coverage,historyTransition,counts:{corpus:input.corpus.length,legacyVideos:l.videos.length,googleVideos:indexed.googleVideos.size,googleRecords:g.records.length,googleRecordsIncludingControls:effectiveRecords.length,targetVideos:videos.length,preservedGoogleVideos:indexed.googleVideos.size,newRegisteredOnlyInCopy:entries.filter(e=>e.disposition==='register_only_in_copy').length,newRetainedOnlyInCopy:entries.filter(e=>e.disposition==='retain_legacy_reconciliation_in_copy').length,overlappingGoogleAndLegacy:entries.filter(e=>e.googleSource&&e.legacySource).length,googleOutsideCorpus:entries.filter(e=>e.googleSource&&!e.corpusSource).length,legacyHistoryRows:Object.values(l.histories).reduce((n,rows)=>n+rows.length,0),conflictingIds:entries.filter(e=>e.conflicts.length).length,blockedIds:entries.filter(e=>e.blockers.length).length},execution:{mode:'offline_copy_only',executed:false,applySupported:false,processingEnabled:false,sourceWrites:0,sourceDeletions:0,physicalObjectsCopied:0,migrationReady:false},limitations:['Google é preservado por política de reconciliação; datas não provam que todo campo Google substitui semanticamente o legado. Conflitos permanecem explícitos.','Históricos e financeiro são preservados no snapshot/arquivo protegido, sem fabricar custos ou eventos novos.','O plano não modifica banco, filas, workers, taxonomia ou objetos e não estabelece exclusividade de escritor.','IDs ausentes Google só aparecem Cadastrados na cópia quando não há resultados ou histórico incerto. Demais legados ficam incertos até conciliação; nenhum cadastro real ou comando de admissão é executado.','Gerações ou bytes antigos ausentes mantêm a verificação física pendente. Nenhuma origem legada é usada como fallback de runtime.']};
 return seal(body);
}
export function verifyMigrationCopyPlan(plan,input){unseal(plan,'reels_migration_copy_plan');if(buildMigrationCopyPlan(input).hash!==plan.hash)throw Error('Plano diverge das origens.');return true;}
export function rehearseMigrationCopy(input){
 const before=migrationHash(input),backup=createMigrationCopyBackup(input),restored=restoreMigrationCopyBackup(backup),plan=buildMigrationCopyPlan(restored);
 verifyMigrationCopyPlan(plan,input);const after=migrationHash(input);
 if(after!==before||migrationHash(restored)!==before)throw Error('Origem/restauração divergente.');
 const records=googleRecords(input.googleSnapshot);
 return {backup,plan,proof:{sourceUnchanged:true,snapshotRestoredExactly:true,repeatable:buildMigrationCopyPlan(input).hash===plan.hash,inputHash:before,restoredHash:migrationHash(restored),backupHash:backup.hash,planHash:plan.hash,googleTypedRecordsPreserved:records.every(r=>Object.hasOwn(r,'typedSource')),typedSourceCoverage:{provided:records.filter(r=>Object.hasOwn(r,'typedSource')).length,total:records.length},legacyHistoriesPreserved:true,physicalRestorationVerified:false,physicalObjectsCopied:0,physicalObjectBytesCopied:0,realMigrationApplied:false}};
}
