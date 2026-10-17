import {migrationHash} from './reels-migration.mjs';
import {restoreMigrationCopyBackup,buildMigrationCopyPlan} from './reels-migration-copy.mjs';
import {assertImportJson,verifyBackupLinkManifest,buildBackupLinkManifest} from './reels-backup-links.mjs';
import {projectMigrationHistory} from './reels-migration-history.mjs';

// This module has no Store/transport/apply entry point. All documents below are
// proposals for an isolated JSON copy; historical collections are never outbox.
const sha=/^[a-f0-9]{64}$/;
const clone=v=>structuredClone(v);
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const allowedCollections=new Set(['videos','reels_legacy_content','reels_historical_activity','reels_historical_finance','reels_historical_coverage','reels_backup_links']);
const historical={historical:true,executable:false};
function seal(body){return {...body,hash:migrationHash(body)};}
function sources(value){if(!object(value)||!Object.keys(value).length||Object.values(value).some(x=>!sha.test(x??'')))throw Error('Hashes dos arquivos de origem obrigatórios.');return value;}
function validateProjection(h){
 if(!object(h)||!Array.isArray(h.historyView)||!Array.isArray(h.unlinkedHistory)||!Array.isArray(h.financeView?.entries)||!Array.isArray(h.financeView?.days)||!object(h.coverage)||h.proof?.sourceUnchanged!==true||h.proof?.noRunnableDocuments!==true)throw Error('Projeção histórica inválida.');
 const {proof,...body}=h;if(migrationHash(body)!==proof.outputHash)throw Error('Projeção histórica alterada.');
 for(const row of [...h.historyView,...h.unlinkedHistory,...h.financeView.entries])if(!sha.test(row.id??'')||row.executable!==false||row.historical!==true)throw Error('Linha histórica sem identidade inerte.');
}
function planPackage({copyBackup,backupLinks,linkInputs,historyProjection,historyInputs={coverage:null,artifactProofs:[]},sourceHashes}){
 const input=restoreMigrationCopyBackup(copyBackup),plan=buildMigrationCopyPlan(input),g=input.googleSnapshot,l=input.legacySnapshot;
 sources(sourceHashes);verifyBackupLinkManifest(backupLinks);
 if(backupLinks.sourceHashes.googleSnapshot!==migrationHash(g)||backupLinks.sourceHashes.legacySnapshot!==migrationHash(l))throw Error('Vínculos não correspondem aos snapshots.');
 if(!object(linkInputs)||!object(linkInputs.physicalCopyReceipt)||Object.keys(linkInputs).some(k=>!['physicalCopyReceipt','originAliases','humanBackupAssertion'].includes(k)))throw Error('Entradas originais dos vínculos obrigatórias.');
 const recomputedLinks=buildBackupLinkManifest({googleSnapshot:g,legacySnapshot:l,...linkInputs});
 if(recomputedLinks.hash!==backupLinks.hash)throw Error('Vínculos não correspondem ao recibo e aliases fornecidos.');
 validateProjection(historyProjection);
 if(!object(historyInputs)||Object.keys(historyInputs).some(k=>!['coverage','artifactProofs'].includes(k)))throw Error('Entradas históricas fora do escopo.');
 const recomputedHistory=projectMigrationHistory({googleSnapshot:g,legacySnapshot:l,targetVideos:plan.targetCopy.videos,coverage:historyInputs.coverage??null,artifactProofs:historyInputs.artifactProofs??[]});
 // The caller supplies the historical source inputs separately when coverage
 // or saved usage proofs were used. Bind them, never trust output flags alone.
 if(migrationHash(historyProjection)!==migrationHash(recomputedHistory))throw Error('Histórico não corresponde às origens e alvos da cópia.');
 const googleIds=new Set(g.records.filter(r=>r.path.startsWith('videos/')).map(r=>r.path.slice(7))),links=new Map(backupLinks.entries.map(r=>[r.reelId,r])),legacySnapshotHash=migrationHash(l);
 const records=[];
 for(const v of plan.targetCopy.videos)if(!googleIds.has(v.id))records.push({path:'videos/'+v.id,data:{...clone(v),import_hold:{active:true,reason:'migration_not_activated'}}});
 for(const v of l.videos){
  if(v.analysis===null||v.analysis===undefined){if(v.transcript===null||v.transcript===undefined)continue;}
  records.push({path:'reels_legacy_content/'+v.id,data:{schemaVersion:1,reelId:v.id,status:'legacy_preserved',analysis:clone(v.analysis??null),transcript:clone(v.transcript??null),originalStatus:typeof v.status==='string'?v.status:null,updatedAt:v.updated_at??null,provenance:{system:'postgresql',recordHash:migrationHash(v),sourceSnapshotHash:legacySnapshotHash},backupLink:clone(links.get(v.id)??null),...historical}});
 }
 for(const link of backupLinks.entries)records.push({path:'reels_backup_links/'+link.reelId,data:{...clone(link),...historical}});
 for(const row of [...historyProjection.historyView,...historyProjection.unlinkedHistory])records.push({path:'reels_historical_activity/'+row.id,data:clone(row)});
 for(const row of historyProjection.financeView.entries)records.push({path:'reels_historical_finance/'+row.id,data:clone(row)});
 const coverageId=migrationHash({backupHash:copyBackup.hash,linksHash:backupLinks.hash,historyHash:historyProjection.proof.outputHash,sourceHashes});
 records.push({path:'reels_historical_coverage/'+coverageId,data:{schemaVersion:1,...historical,sourceHashes:clone(sourceHashes),historyCoverage:clone(historyProjection.coverage),financeCoverage:clone(historyProjection.financeView.coverage),financeDays:clone(historyProjection.financeView.days),unallocated:clone(historyProjection.financeView.unallocated),backupLinksHash:backupLinks.hash,migrationPlanHash:plan.hash}});
 records.sort((a,b)=>a.path.localeCompare(b.path));
 const paths=new Set();for(const record of records){const [collection,id,...rest]=record.path.split('/');if(!allowedCollections.has(collection)||!id||rest.length||paths.has(record.path))throw Error('Documento duplicado ou coleção fora do escopo.');paths.add(record.path);}
 return {schemaVersion:1,kind:'reels_web_import_package',sourceHashes:clone(sourceHashes),sourceBackupHash:copyBackup.hash,migrationPlanHash:plan.hash,backupLinksHash:backupLinks.hash,historyInputHash:historyProjection.proof.inputHash,historyOutputHash:historyProjection.proof.outputHash,googlePreconditions:g.records.map(r=>({path:r.path,recordHash:migrationHash(r)})).sort((a,b)=>a.path.localeCompare(b.path)),records,protectedArchiveHash:migrationHash(plan.protectedArchive),counts:{targetReels:plan.counts.targetVideos,preservedGoogleReels:googleIds.size,newReelDocuments:plan.counts.targetVideos-googleIds.size,legacyContentDocuments:records.filter(r=>r.path.startsWith('reels_legacy_content/')).length,historyDocuments:records.filter(r=>r.path.startsWith('reels_historical_activity/')).length,financeDocuments:historyProjection.financeView.entries.length},execution:{mode:'copy_only',applySupported:false,newRuntimeAdmissionActivated:false,processingEnabled:false,sourceWrites:0,sourceDeletions:0},limitations:['Pacote privado de preparação: contém acervo e nunca deve ser publicado no repositório público.','Os documentos Google existentes não são reescritos; conteúdo legado é uma alternativa preservada, sem inventar publicação ou qualidade moderna.','Históricos e financeiro permanecem coleções inertes, separados de comandos, filas, execuções e controles ativos.','A materialização JSON não autoriza importação real, corte de escritor, processamento, exclusão nem publicação.']};
}
export function buildWebImportPackage(input){assertImportJson(input);if(!object(input)||Object.keys(input).some(k=>!['copyBackup','backupLinks','linkInputs','historyProjection','historyInputs','sourceHashes'].includes(k)))throw Error('Escopo do pacote inválido.');return seal(planPackage(input));}
export function verifyWebImportPackage(pkg,input){assertImportJson(pkg);const {hash,...body}=pkg;if(body.schemaVersion!==1||body.kind!=='reels_web_import_package'||!sha.test(hash??'')||migrationHash(body)!==hash||buildWebImportPackage(input).hash!==hash)throw Error('Pacote ou suas origens divergiram.');return true;}
export function materializeIntoCopy({package:pkg,targetCopy,expectedSourceHashes,...input}){
 assertImportJson({package:pkg,targetCopy,expectedSourceHashes,...input});
 verifyWebImportPackage(pkg,input);sources(expectedSourceHashes);
 if(migrationHash(expectedSourceHashes)!==migrationHash(pkg.sourceHashes)||!object(targetCopy)||!Array.isArray(targetCopy.records))throw Error('Pré-condições da cópia divergentes.');
 const before=migrationHash(targetCopy),byPath=new Map();
 for(const row of targetCopy.records){if(typeof row.path!=='string'||!object(row.data)||byPath.has(row.path))throw Error('Destino da cópia inválido ou duplicado.');byPath.set(row.path,row);}
 for(const required of pkg.googlePreconditions)if(!byPath.has(required.path)||migrationHash(byPath.get(required.path))!==required.recordHash)throw Error('Origem Google mudou; não sobrescrever.');
 let inserted=0,unchanged=0;
 for(const row of pkg.records){const existing=byPath.get(row.path);if(existing){if(migrationHash(existing)!==migrationHash(row))throw Error('Conflito no destino: '+row.path);unchanged++;}else{byPath.set(row.path,clone(row));inserted++;}}
 const result={...clone(targetCopy),records:[...byPath.values()].map(clone)};
 if(migrationHash(targetCopy)!==before)throw Error('A origem da cópia foi alterada.');
 return {targetCopy:result,receipt:{schemaVersion:1,packageHash:pkg.hash,sourceHashes:clone(pkg.sourceHashes),inputCopyHash:before,outputCopyHash:migrationHash(result),inserted,unchanged,sourceUnchanged:true,googleRecordsPreserved:true,realMigrationApplied:false,processing:false,deletions:0}};
}
