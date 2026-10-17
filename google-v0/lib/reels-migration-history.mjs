import {migrationHash} from './reels-migration.mjs';

// Offline derived views only. No Store, queue, callback, clock or provider is
// accepted. The original typed records belong to the separate protected archive.
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const array=v=>Array.isArray(v)?v:[];
const hash=v=>migrationHash(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{5,32}$/.test(v)?v:null;
const stageMap=new Map([['upload','acquisition'],['acquisition','acquisition'],['transcription','transcription'],['analysis','analysis'],['media_access','media_access']]);
const stage=v=>stageMap.get(v)??null;
const timestamp=v=>typeof v==='string'&&v.length<=64&&/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const day=value=>{if(!value)return null;const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');};
const statusSet=new Set(['pending','registered','queued','claimed','reserved','started','running','submitting','waiting','polling','collecting','applying','completed','analyzed','published','failed','cancelled','not_started','uncertain','needs_attention','reconciling_result','reconciliation_failed','recovering_upload','recovering_429','recovering_firestore_metadata','stopped','review_required','accepted','rejected','superseded','blocked','consumed','authorized']);
const status=v=>statusSet.has(v)?v:'unknown';
const money=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const workerLabel=s=>s==='acquisition'?'Aquisição':s==='transcription'?'Transcrição':s==='analysis'?'Análise':null;
const sourceWorker=v=>typeof v==='string'&&/^(?:reels|megabrain-v0)-(?:acquisition|transcription|analysis|worker)$/.test(v)?v:null;
// PostgreSQL COPY supplies this INTEGER field as a decimal string. This schema
// conversion is intentionally limited to reserved seconds, never to money.
const reservedSeconds=v=>typeof v==='string'&&/^\d{1,16}$/.test(v)?money(Number(v)):money(v);
const historical={historical:true,executable:false};
function controlRecords(snapshot){
 if(snapshot.controls===undefined)return [];
 if(Array.isArray(snapshot.controls))return snapshot.controls;
 if(!object(snapshot.controls))throw Error('Controles históricos devem ser array ou objeto por caminho.');
 return Object.entries(snapshot.controls).map(([key,value])=>{
  if(!object(value))throw Error('Controle objeto deve conter documento ou dados selecionados.');
  return {path:value.path??(key.includes('/')?key:'settings/'+key),data:Object.hasOwn(value,'data')?value.data:value,updateTime:value.updateTime??value.typedSource?.updateTime??null,...(Object.hasOwn(value,'typedSource')?{typedSource:value.typedSource}:{})};
 });
}
function times(data){return {createdAt:timestamp(data.createdAt??data.created_at),queuedAt:timestamp(data.queuedAt??data.queued_at),startedAt:timestamp(data.startedAt??data.started_at),completedAt:timestamp(data.completedAt??data.completed_at??data.finished_at),failedAt:timestamp(data.failedAt??data.failed_at),resultSavedAt:timestamp(data.resultSavedAt??data.result_saved_at)};}
const sourceTypes=new Set(['videos','jobs','reels_executions','execution_stops','analyses','reels_events','settings','control_chunks','reservations','financial_ledger','saved_usage_artifact','automation_attempts','analysis_jobs','stt_reservations','model_budget','stt_budget','automation_state','storage_state','r2_operations','export_limits']);
function provenance(system,kind,key,version,data){return {system,sourceType:sourceTypes.has(kind)?kind:'unmapped_source',sourceRef:hash({system,kind,key,version:version??null}),sourceVersion:timestamp(version),sourceVersionHash:version==null?null:hash(version),recordHash:hash(data)};}
const measurementValid=v=>v?.schema_version===1&&v.status==='measured'&&v.currency==='USD'&&v.billing_confirmed===false&&typeof v.rate_version==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(v.rate_version)&&typeof v.source==='string'&&v.source.length>0&&Number.isSafeInteger(v.list_price_micro_usd)&&v.list_price_micro_usd>=0;

export function projectMigrationHistory({googleSnapshot,legacySnapshot,targetVideos,coverage=null,artifactProofs=[]}={}){
 if(!object(googleSnapshot)||!Array.isArray(googleSnapshot.records)||!object(legacySnapshot)||!object(legacySnapshot.histories)||!Array.isArray(targetVideos)||!Array.isArray(artifactProofs))throw Error('Snapshots e alvos obrigatórios para projeção histórica em cópia.');
 for(const rows of Object.values(legacySnapshot.histories))if(!Array.isArray(rows))throw Error('Tabelas históricas devem conter arrays.');
 const input={googleSnapshot,legacySnapshot,targetVideos,coverage,artifactProofs},inputHash=hash(input),targets=new Map();
 for(const video of targetVideos){if(!id(video?.id)||targets.has(video.id))throw Error('Identidade alvo inválida ou repetida.');targets.set(video.id,video);}
 const sourceVideos=new Map(array(googleSnapshot.records).filter(r=>r?.path?.startsWith('videos/')).map(r=>[id(r.data?.id??r.path.slice(7)),r.data]));
 const historyView=[],unlinkedHistory=[],accounting=[],selection=[],ledger=new Map(),jobAccountingFallbacks=new Map(),usages=new Map(),estimates=new Map(),seen=new Set();
 let duplicates=0,ledgerDuplicates=0;
 function link(reelId){
  if(!reelId)return {linked:false,reason:'EXPLICIT_REEL_ID_UNAVAILABLE'};
  if(!targets.has(reelId))return {linked:false,reason:'REEL_NOT_IN_TARGET_COPY'};
  if(!sourceVideos.has(reelId))return {linked:false,reason:'NEW_REGISTERED_COPY_HISTORY_DETACHED'};
  const source=sourceVideos.get(reelId),target=targets.get(reelId);
  if(target.status==='registered'&&['failed','needs_attention','uncertain','reconciliation_failed'].includes(source.status)&&source.status!==target.status)return {linked:false,reason:'RESET_COPY_HISTORY_DETACHED'};
  return {linked:true,reason:null};
 }
 function pushHistory(kind,data,p,{rowKind=kind}={}){
  const target=targets.get(id(data.reelId??data.video_id??data.videoId));
  // A reviewed permanent reset is a tombstone for old operational history.
  // Re-importing a historical snapshot must not recreate erased failure logs,
  // including detached rows in the global activity archive. Accounting is kept.
  if(target?.operational_reset?.rule==='confirmed-legacy-failure-reset-v1')return 'erased_confirmed_failure_history';
  const reelId=id(data.reelId??data.video_id??data.videoId),s=stage(data.stage),linked=link(reelId);
  const worker=sourceWorker(data.worker),row={id:hash({view:'history',source:p.sourceRef,record:p.recordHash}),kind:rowKind,...historical,reelId,stage:s,worker,workerLabelDerived:worker?null:workerLabel(s),sourceStatus:status(data.status??data.review_status),statusDisplay:'historical',...times(data),provenance:[p]};
  if(linked.linked)historyView.push(row);else unlinkedHistory.push({...row,reason:linked.reason});
  return linked.linked?'history':'unlinked';
 }
 function finance(kind,reelId,s,amount,currency,at,provenances,extra={}){
  const linked=link(reelId);
  return {id:hash({view:'finance',kind,sources:provenances.map(p=>p.sourceRef).sort(),stage:s}),kind,...historical,reelId,operationallyLinked:false,historyLinked:linked.linked,stage:s,amount,currency,recordedAt:at,day:day(at),billed:null,provenance:provenances,...extra};
 }
 function ledgerRow(key,data,p){
  if(!object(data)){accounting.push(finance('unknown',null,null,null,null,null,[p],{reason:'INVALID_LEDGER_ENTRY_ARCHIVED'}));return;}
  const identity=hash({system:p.system,ledgerJob:key}),rows=ledger.get(identity)??[];
  if(rows.some(r=>r.p.recordHash===p.recordHash)){ledgerDuplicates++;rows.find(r=>r.p.recordHash===p.recordHash).provenances.push(p);}
  else rows.push({data,p,provenances:[p]});
  ledger.set(identity,rows);
 }
 function usage(identity,value,p,{reelId=null,s=null,at=null,proofValid=true}={}){
  const rows=usages.get(identity)??[];rows.push({value,p,reelId,s,at,proofValid});usages.set(identity,rows);
 }
 function executionKey(data,fallback=null){
  return [data.executionId,data.execution_id,data.job_id,fallback].find(v=>typeof v==='string'&&v.length>0&&v.length<=200)??null;
 }
 function usageIdentity(data,fallback=null){const execution=executionKey(data,fallback);return execution?hash({usageExecution:execution,stage:stage(data.stage)}):null;}
 const normalizedControls=controlRecords(googleSnapshot),googleRows=[...googleSnapshot.records,...normalizedControls];
 for(const record of googleRows){
  if(!object(record)||typeof record.path!=='string'||!object(record.data))throw Error('Documento histórico Google inválido.');
  const data=record.data,collection=record.path.split('/')[0],version=record.updateTime??record.typedSource?.updateTime??null,p=provenance('google',collection,record.path,version,data),identity=hash({path:record.path,version,recordHash:p.recordHash});
  if(seen.has(identity)){duplicates++;selection.push({sourceRef:p.sourceRef,disposition:'duplicate',reason:'EXACT_SOURCE_VERSION_DUPLICATE'});continue;}seen.add(identity);
  let disposition='outside_scope',reason='NOT_A_HISTORY_OR_FINANCE_RECORD';
  if(['jobs','reels_executions','execution_stops','analyses','reels_events'].includes(collection)){
   const kind={jobs:'execution',reels_executions:'execution',execution_stops:'execution_stop',analyses:'analysis_review',reels_events:'runtime_event'}[collection];
   disposition=pushHistory(kind,data,p);reason=null;
   if(['jobs','reels_executions'].includes(collection)){
    const financeData=data.rawResult?.finance,measurement=financeData?.measurement;
    const execution=executionKey(data,record.path.slice(collection.length+1)),identity=usageIdentity(data,execution);
    if(Object.hasOwn(data,'actual_cents')||Object.hasOwn(data,'maximum_cents')){const rows=jobAccountingFallbacks.get(execution)??[];rows.push({data,p});jobAccountingFallbacks.set(execution,rows);}
    if(measurement!=null||['transcription','analysis'].includes(data.stage))usage(identity,measurement??null,p,{reelId:id(data.reelId??data.video_id),s:stage(data.stage),at:timestamp(data.resultSavedAt??data.result_saved_at??data.completedAt??data.completed_at)});
    const estimate=financeData?.estimate;
    if(object(estimate)&&['BRL','USD'].includes(estimate.currency)&&Number.isFinite(estimate.amount)&&estimate.amount>=0){const key=hash({estimateExecution:identity,currency:estimate.currency}),rows=estimates.get(key)??[];rows.push({estimate,p,reelId:id(data.reelId??data.video_id),s:stage(data.stage),at:timestamp(data.createdAt??data.created_at)});estimates.set(key,rows);}
   }
   if(data.usage_cost!==undefined){
    const identity=usageIdentity(data,null);
    if(identity)usage(identity,data.usage_cost,p,{reelId:id(data.reelId??data.video_id),s:stage(data.stage),at:timestamp(data.result_saved_at??data.completed_at)});
    else accounting.push(finance('unknown',id(data.reelId??data.video_id),stage(data.stage),null,null,null,[p],{reason:'USAGE_OPERATION_ID_UNAVAILABLE'}));
   }
  }
  if(record.path==='settings/financial'&&object(data.jobs)){
   disposition='finance';reason='LEDGER_AGGREGATE_PRESERVED_NOT_DOUBLE_COUNTED';for(const [key,row]of Object.entries(data.jobs))ledgerRow(key,row,provenance('google','financial_ledger',key,version,row));
  }else if(collection==='control_chunks'&&data.owner==='settings/financial'&&object(data.entries)){
   disposition='finance';reason='LEDGER_FRAGMENT_PROJECTED';for(const [key,row]of Object.entries(data.entries))ledgerRow(key,row,provenance('google','financial_ledger',key,version,row));
  }else if(collection==='reservations'){
   disposition='finance';reason='RESERVATION_NOT_EXECUTED_SPEND';
   const max=money(data.maximum_cents),at=timestamp(data.created_at??data.createdAt);
   accounting.push(finance('reservation',id(data.reelId??data.video_id),stage(data.stage),max===null?null:max/100,max===null?null:'BRL',at,[p],{reason:'LEGACY_RESERVATION_ONLY'}));
  }
  selection.push({sourceRef:p.sourceRef,disposition,reason});
 }
 for(const [table,rows]of Object.entries(legacySnapshot.histories))for(let index=0;index<rows.length;index++){
  const data=rows[index];if(!object(data))throw Error('Linha histórica PostgreSQL inválida.');
  const p=provenance('postgresql',table,index,null,data);let disposition='unlinked',reason=null;
  if(table==='automation_attempts')disposition=pushHistory('automation_attempt',data,p);
  else if(table==='analysis_jobs'){disposition=pushHistory('batch_analysis_job',data,p);reason='BATCH_MEMBERS_NOT_INFERRED';}
  else if(table==='stt_reservations'){
   disposition='finance';reason='RESERVED_SECONDS_NOT_MEASURED_USAGE';
   accounting.push(finance('reservation',null,'transcription',null,null,timestamp(data.created_at),[p],{reason,reservedSeconds:reservedSeconds(data.seconds)}));
  }else unlinkedHistory.push({id:hash({view:'snapshot',source:p.sourceRef}),kind:'legacy_snapshot',...historical,reelId:null,stage:null,sourceStatus:'unknown',statusDisplay:'historical',provenance:[p],reason:'SNAPSHOT_NOT_AN_EXECUTION_OR_MEASUREMENT'});
  selection.push({sourceRef:p.sourceRef,disposition,reason});
 }
 for(let index=0;index<artifactProofs.length;index++){
  const proof=artifactProofs[index];if(!object(proof))throw Error('Prova de artefato inválida.');
  const value=proof.usage_cost??proof.data?.usage_cost,p=provenance('google','saved_usage_artifact',index,proof.generation??null,proof),identity=usageIdentity(proof,null);
  const verified=proof.sourceVerified===true&&/^[a-f0-9]{64}$/.test(proof.sha256??'')&&/^\d+$/.test(String(proof.generation??''))&&typeof proof.key==='string'&&proof.key.length>0;
  if(value!==undefined&&identity)usage(identity,value,p,{reelId:id(proof.reelId??proof.video_id),s:stage(proof.stage),at:timestamp(proof.recordedAt??proof.completed_at),proofValid:verified});
  else accounting.push(finance('unknown',id(proof.reelId??proof.video_id),stage(proof.stage),null,null,null,[p],{reason:value===undefined?'SAVED_USAGE_UNAVAILABLE':'USAGE_OPERATION_ID_UNAVAILABLE'}));
  selection.push({sourceRef:p.sourceRef,disposition:'finance',reason:verified?null:'ARTIFACT_PROVENANCE_UNVERIFIED'});
 }
 let conflicts=0,temporalConflicts=0;
 // The ledger is the accounting source when both snapshots represent the same
 // job. Preserve a job's own explicit accounting only if its ledger is absent.
 for(const [execution,rows]of jobAccountingFallbacks)if(!ledger.has(hash({system:'google',ledgerJob:execution})))for(const row of rows)ledgerRow(execution,row.data,row.p);
 for(const rows of ledger.values()){
  const signatures=new Set(rows.map(({data})=>hash({video:id(data.video_id??data.reelId),stage:stage(data.stage),status:status(data.status),actual:money(data.actual_cents),maximum:money(data.maximum_cents)}))),provenances=rows.flatMap(r=>r.provenances),data=rows[0].data,reelId=id(data.video_id??data.reelId),s=stage(data.stage);
  if(signatures.size>1){conflicts++;accounting.push(finance('unknown',reelId,s,null,null,null,provenances,{reason:'CONFLICTING_LEDGER_VERSIONS'}));continue;}
  const actual=money(data.actual_cents),maximum=money(data.maximum_cents),settlements=[...new Set(rows.flatMap(r=>['completedAt','completed_at','settledAt','settled_at'].map(k=>timestamp(r.data[k]))).filter(Boolean))],creations=[...new Set(rows.flatMap(r=>['createdAt','created_at'].map(k=>timestamp(r.data[k]))).filter(Boolean))],at=settlements.length===1?settlements[0]:null;
  if(settlements.length>1){conflicts++;temporalConflicts++;}
  accounting.push(finance('accounting',reelId,s,actual===null?null:actual/100,actual===null?null:'BRL',at,provenances,{reason:settlements.length>1?'CONFLICTING_LEDGER_SETTLEMENT_DATES':'LEGACY_ACCOUNTING_NOT_MEASURED_OR_BILLED',sourceStatus:status(data.status)}));
  if(['reserved','started','uncertain'].includes(data.status)){
   if(creations.length>1){conflicts++;temporalConflicts++;}
   accounting.push(finance('reservation',reelId,s,maximum===null?null:maximum/100,maximum===null?null:'BRL',creations.length===1?creations[0]:null,provenances,{reason:creations.length>1?'CONFLICTING_LEDGER_RESERVATION_DATES':'OPEN_LEGACY_RESERVATION_NOT_EXECUTED_SPEND'}));
  }
 }
 for(const rows of estimates.values()){
  const first=rows[0],values=new Set(rows.map(r=>r.estimate.amount)),dates=[...new Set(rows.map(r=>r.at).filter(Boolean))],provenances=rows.map(r=>r.p);
  if(values.size>1)conflicts++;if(dates.length>1){conflicts++;temporalConflicts++;}
  accounting.push(finance('estimate',first.reelId,first.s,values.size===1?first.estimate.amount:null,first.estimate.currency,dates.length===1?dates[0]:null,provenances,{reason:values.size>1?'CONFLICTING_ESTIMATE_VERSIONS':dates.length>1?'CONFLICTING_ESTIMATE_DATES':'SAVED_QUOTE_NOT_MEASURED_OR_BILLED'}));
 }
 for(const rows of usages.values()){
  const proven=rows.filter(r=>r.proofValid&&measurementValid(r.value)),fingerprints=new Set(proven.map(r=>hash(r.value))),first=rows[0],provenances=rows.map(r=>r.p);
  if(fingerprints.size>1){conflicts++;accounting.push(finance('unknown',first.reelId,first.s,null,null,null,provenances,{reason:'CONFLICTING_PROVIDER_MEASUREMENTS'}));continue;}
  if(!proven.length){accounting.push(finance('unknown',first.reelId,first.s,null,null,null,provenances,{reason:'PROVIDER_MEASUREMENT_UNVERIFIED_OR_UNAVAILABLE'}));continue;}
  const measured=proven[0],atValues=[...new Set(proven.map(r=>r.at).filter(Boolean))],at=atValues.length===1?atValues[0]:null;
  accounting.push(finance('provider_usage',measured.reelId,measured.s,measured.value.list_price_micro_usd/1e6,'USD',at,provenances,{reason:'SAVED_PROVIDER_USAGE_AT_ORIGINAL_RATE',rateVersion:measured.value.rate_version,billingConfirmed:false}));
 }
 const days=new Map();
 for(const entry of accounting){if(!entry.day)continue;const key=entry.day+':'+entry.kind+':'+(entry.currency??'unknown');let total=days.get(key);if(!total){total={day:entry.day,kind:entry.kind,currency:entry.currency,amount:null,knownRecords:0,unknownRecords:0,billed:null};days.set(key,total);}if(entry.amount===null)total.unknownRecords++;else{total.amount=(total.amount??0)+entry.amount;total.knownRecords++;}}
 const byId=(a,b)=>a.id.localeCompare(b.id);historyView.sort(byId);unlinkedHistory.sort(byId);accounting.sort(byId);
 const coverageResult={sourceCoverageHash:coverage===null?null:hash(coverage),inputGoogleRows:googleRows.length,inputControlRows:normalizedControls.length,googleRowsWithoutSourceVersion:googleRows.filter(r=>!(r.updateTime??r.typedSource?.updateTime)).length,inputLegacyHistoryRows:Object.values(legacySnapshot.histories).reduce((n,rows)=>n+rows.length,0),inputArtifactProofs:artifactProofs.length,sourceRowsAccounted:selection.length,duplicateSourceVersions:duplicates,duplicateLedgerEntries:ledgerDuplicates,linkedHistoricalRows:historyView.length,unlinkedHistoricalRows:unlinkedHistory.length,financeEntries:accounting.length,unknownFinanceEntries:accounting.filter(r=>r.amount===null).length,unallocatedFinanceEntries:accounting.filter(r=>r.day===null).length,conflicts,temporalConflicts,selection};
 const result={historyView,financeView:{entries:accounting,days:[...days.values()].sort((a,b)=>(a.day+':'+a.kind+':'+a.currency).localeCompare(b.day+':'+b.kind+':'+b.currency)),unallocated:accounting.filter(r=>r.day===null).map(r=>r.id),coverage:{billingConfirmed:false,costsComplete:false,source:'provided_snapshots_only'}},unlinkedHistory,coverage:coverageResult,limitations:['Visão derivada offline; não persiste registros, ativa execução nem comprova consulta pela web.','Fontes não fornecidas e vínculos ausentes permanecem desconhecidos; snapshots não provam completude do histórico.','Accounting BRL e reservas legadas não são uso medido, fatura ou gasto diário comprovado. Sem data de término, valor permanece sem alocação diária.','Histórico de novos registrados e erros resetados é separado da operação; o financeiro global é preservado sem vincular comandos.','Referências de proveniência são opacas; os registros brutos, diagnósticos e chaves privadas permanecem exclusivamente no arquivo protegido.']};
 if(hash(input)!==inputHash)throw Error('Snapshot de origem alterado pela projeção.');
 return {...result,proof:{inputHash,outputHash:hash(result),sourceUnchanged:true,allInputRowsAccounted:selection.length===googleRows.length+Object.values(legacySnapshot.histories).reduce((n,rows)=>n+rows.length,0)+artifactProofs.length,noRunnableDocuments:true,noOutboxOrControls:true,newRuntimeAdmissionActivated:false,realMigrationApplied:false}};
}
