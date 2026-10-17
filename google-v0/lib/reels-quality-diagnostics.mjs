import {createHash} from 'node:crypto';
import {evaluateQualityGateV2,qualityPolicyVersion} from './reels-quality-gate.mjs';
import {semanticQualityPolicyVersion} from './reels-quality-semantic-policy.mjs';
import {normalizeSearch,projectExecution,stageName} from './reels-model.mjs';

export const queueCurationVersion='queue-curation-v1';
export const qualityEvidenceStates=Object.freeze(['supported','present_unverified','not_recorded','not_applicable','unknown','inconclusive','invalid']);
const statuses=['registered','published','confirmed_failure','uncertain','valid_partial','unknown','queued','running','waiting'];
const stages=['acquisition','transcription','analysis'];
const list=v=>Array.isArray(v)?v:[];
const text=v=>typeof v==='string'?v:null;
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v)?v:null;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const invalid=()=>Object.assign(Error('Filtro de curadoria inválido.'),{status:400,code:'INVALID_QUERY'});
const diagnosis=(code,state,message)=>({code,state,message});
function operationalState(item){
 if(item.publication?.available===true)return 'published';
 if(item.error?.uncertain===true||item.status==='uncertain')return 'uncertain';
 if(item.status==='failed')return 'confirmed_failure';
 if(item.status==='registered')return 'registered';
 if(['queued','running','waiting'].includes(item.status))return item.status;
 if(item.media?.available===true||item.transcript?.state==='present'||item.transcript?.state==='empty')return 'valid_partial';
 return 'unknown';
}
function publication(item){
 const p=item.publication??{},available=p.available===true,source=available?(p.source==='legacy_preserved'?'legacy_preserved':'native'):null;
 // "accepted" alone is the historical worker's status, never a gate-v2 receipt.
 const gate=available&&p.qualityPolicyVersion==='gate_v2'&&safeId(p.qualityReceiptId);
 return {available,source,revision:text(p.revision),qualityPolicyVersion:available?(gate?'gate_v2':'historical_baseline'):null,qualityReceiptId:gate?p.qualityReceiptId:null,evidenceStatus:available?(gate?'supported':'present_unverified'):'not_recorded'};
}
function rowFor(item,executions){
 const status=operationalState(item),published=publication(item),diagnostics=[];
 if(status==='uncertain')diagnostics.push(diagnosis('RESULT_UNCERTAIN','inconclusive','Resultado da operação não confirmado. Dados preservados; nenhuma repetição automática.'));
 if(status==='confirmed_failure')diagnostics.push(diagnosis('CONFIRMED_FAILURE','invalid','Falha registrada nesta operação. O diagnóstico não determina a disponibilidade da origem.'));
 if(published.available)diagnostics.push(diagnosis(published.qualityPolicyVersion==='gate_v2'?'GATE_V2_RECEIPT':'HISTORICAL_PUBLICATION',published.evidenceStatus,published.qualityPolicyVersion==='gate_v2'?'Publicação vinculada ao recibo de qualidade versionado.':'Publicação histórica preservada. O gate v2 não foi aplicado retroativamente.'));
 if(item.media?.available===true)diagnostics.push(diagnosis('SAVED_MEDIA','present_unverified','Mídia salva disponível. Esta listagem não repete inspeção de bytes, áudio ou pixels.'));
 if(status==='registered')diagnostics.push(diagnosis('REGISTERED_READY','not_applicable','Cadastro pronto fora das filas; nenhuma execução foi iniciada por esta consulta.'));
 if(status==='valid_partial')diagnostics.push(diagnosis('VALID_SAVED_PARTIAL','present_unverified','Artefato salvo disponível sem publicação completa; lacuna não é falha confirmada.'));
 if(status==='unknown')diagnostics.push(diagnosis('NO_SAVED_PROOF','not_recorded','Sem evidência suficiente nesta projeção para avaliar as etapas.'));
 if(published.available&&published.qualityPolicyVersion==='historical_baseline')diagnostics.push(diagnosis('HISTORICAL_SEMANTIC_LIMIT','unknown','Presença de análise, transcrição ou citação não comprova fidelidade semântica nem alinhamento temporal.'));
 const last=executions.at(-1);
 return {reelId:item.id,title:text(item.title),status,stage:stageName(item.stage),worker:safeId(item.error?.worker??last?.worker),publication:published,diagnostics,executions:executions.map(e=>({...e,qualityState:e.status==='uncertain'?'inconclusive':e.status==='failed'?'invalid':e.status==='completed'?'present_unverified':'unknown'}))};
}
function metrics(executions){
 return stages.map(id=>{
  const rows=executions.filter(e=>e.stage===id);
  return {id,attempts:rows.length,uniqueReels:new Set(rows.map(e=>e.reelId)).size,confirmedFailures:rows.filter(e=>e.status==='failed'&&e.error?.uncertain!==true).length,uncertain:rows.filter(e=>e.status==='uncertain'||e.error?.uncertain===true).length,completed:rows.filter(e=>e.status==='completed').length,active:rows.filter(e=>['running','submitting','waiting','collecting','applying'].includes(e.status)).length,queued:rows.filter(e=>e.status==='queued').length};
 });
}
// Pure projection. It accepts projected public metadata and trusted saved stage
// executions, never calls providers, inspects uncertain artifacts, or mutates queues.
export function buildQueueCuration({items=[],executions=[],observedAt=null,executionAvailability='available',filters={},limit=50,cursor=null}={}){
 if(!['available','unavailable','partial'].includes(executionAvailability)||!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>100)throw invalid();
 for(const [key,value]of Object.entries(filters)){
  if(!['q','status','source','stage','worker','cohortId'].includes(key)||typeof value!=='string'||value.length>500)throw invalid();
  if(value&&((key==='status'&&!statuses.includes(value))||(key==='source'&&!['native','legacy_preserved','unpublished'].includes(value))||(key==='stage'&&!stages.includes(value))))throw invalid();
 }
 const unique=new Map(),conflicts=new Set();
 for(const raw of list(executions)){
  const e=projectExecution(raw);if(!e.id||!e.reelId||!e.stage||!e.status)continue;
  const entry={...e,cohortId:safeId(raw.cohortId)??null};
  const previous=unique.get(e.id);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(entry)){conflicts.add(e.id);continue;}
  unique.set(e.id,entry);
 }
 // Conflicting identities do not contribute invented attempt metrics.
 const trusted=[...unique.values()].filter(e=>!conflicts.has(e.id));
 const byReel=new Map();
 for(const e of trusted){const existing=byReel.get(e.reelId)??[];existing.push(e);byReel.set(e.reelId,existing);}
 for(const rows of byReel.values())rows.sort((a,b)=>(a.createdAt??'').localeCompare(b.createdAt??'')||(a.attempt??0)-(b.attempt??0)||a.id.localeCompare(b.id));
 const reelMap=new Map();for(const item of list(items))if(safeId(item?.id)&&!reelMap.has(item.id))reelMap.set(item.id,item);
 const all=[...reelMap.values()].map(item=>rowFor(item,byReel.get(item.id)??[])).sort((a,b)=>a.reelId.localeCompare(b.reelId));
 const counts=Object.fromEntries(statuses.map(s=>[s,all.filter(i=>i.status===s).length]));counts.reels=all.length;counts.published=all.filter(i=>i.publication.available).length;
 const terms=normalizeSearch(filters.q).trim().split(/\s+/).filter(Boolean);
 const rows=all.filter(i=>(!filters.status||i.status===filters.status)&&(!filters.source||(i.publication.source??'unpublished')===filters.source)&&(!filters.stage||i.stage===filters.stage||i.executions.some(e=>e.stage===filters.stage))&&(!filters.worker||i.worker===filters.worker||i.executions.some(e=>e.worker===filters.worker))&&(!filters.cohortId||i.executions.some(e=>e.cohortId===filters.cohortId))&&terms.every(t=>normalizeSearch([i.reelId,i.title,...i.diagnostics.map(d=>d.message)].join(' ')).includes(t)));
 const queryHash=hash(filters);let after=null;
 if(cursor){try{const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());if(parsed.queryHash!==queryHash||!safeId(parsed.after))throw invalid();after=parsed.after;}catch{throw invalid();}}
 const remaining=rows.filter(r=>!after||r.reelId.localeCompare(after)>0),page=remaining.slice(0,Number(limit));
 const cohorts=[...new Set(trusted.map(e=>e.cohortId))].sort((a,b)=>String(a).localeCompare(String(b)));
 return {version:queueCurationVersion,observedAt,availability:{state:executionAvailability==='unavailable'?'partial':conflicts.size||executionAvailability==='partial'?'partial':'available',executions:executionAvailability,conflictingExecutionIdentities:conflicts.size},counts,coverage:{source:'saved_published_and_trusted_executions',qualityPolicyVersion:'historical_baseline_or_receipted_gate_v2',semanticQualityMeasured:false,currentFailureRate:null,reason:'Contagens de estoque não são taxas de falha. Tentativas e Reels únicos são separados por etapa e coorte; coorte ausente permanece desconhecida.'},stages:executionAvailability==='unavailable'?null:metrics(trusted),cohortMetrics:executionAvailability==='unavailable'?null:cohorts.map(cohortId=>({cohortId,known:cohortId!==null,stages:metrics(trusted.filter(e=>e.cohortId===cohortId))})),items:page,total:all.length,matched:rows.length,limit:Number(limit),nextCursor:remaining.length>page.length?Buffer.from(JSON.stringify({queryHash,after:page.at(-1).reelId})).toString('base64url'):null,processingAllowed:false};
}

// Offline evaluation of already saved candidates. It neither fetches sources nor
// turns a failed proof into a provider failure or changes a historical pointer.
export function buildSavedQualityDiagnostics({candidates=[],observedAt=null}={}){
 const seen=new Set(),rows=[];
 for(const item of list(candidates)){
  const record=item?.record??{},reelId=safeId(record.id);
  if(!reelId)continue;
  const gate=evaluateQualityGateV2({record,report:item.report,mediaInspection:item.mediaInspection,transcriptionReceipt:item.transcriptionReceipt,trustedReviews:item.trustedReviews});
  const key=reelId+':'+gate.reportHash+':'+gate.sourceManifestHash;
  if(seen.has(key))continue;seen.add(key);
  const historical=item.historical===true;
  const propositions=gate.contextualPropositions??{},all=[...list(propositions.attributes),...list(propositions.units),...(propositions.primaryContext?[propositions.primaryContext]:[])];
  rows.push({reelId,reportHash:gate.reportHash,sourceManifestHash:gate.sourceManifestHash,publicationClass:historical?'historical_baseline':'candidate',state:historical?'present_unverified':gate.state,gateWouldAccept:gate.accepted,publicationChanged:false,checks:gate.checks,gaps:gate.gaps,contextual:{total:all.length,states:Object.fromEntries(qualityEvidenceStates.map(state=>[state,all.filter(p=>p.state===state).length]))},sourceCoverage:{video:!!gate.sourceManifest?.video,audio:!!gate.sourceManifest?.audio,transcript:!!gate.sourceManifest?.transcript,caption:!!gate.sourceManifest?.caption,mediaInspectionRecorded:!!item.mediaInspection,transcriptionReceiptRecorded:!!item.transcriptionReceipt},replayAllowed:false});
 }
 rows.sort((a,b)=>a.reelId.localeCompare(b.reelId)||a.reportHash.localeCompare(b.reportHash));
 return {version:'saved-quality-diagnostics-v1',policyVersion:qualityPolicyVersion,ruleVersion:semanticQualityPolicyVersion,observedAt,source:'provided_saved_artifacts_only',candidates:rows,coverage:{candidateCount:rows.length,uniqueReels:new Set(rows.map(r=>r.reelId)).size,historical:rows.filter(r=>r.publicationClass==='historical_baseline').length,byState:Object.fromEntries(qualityEvidenceStates.map(state=>[state,rows.filter(r=>r.state===state).length])),semanticQualityMeasured:false,accuracy:null,precision:null,reason:'Verificação de contratos e âncoras sobre fontes salvas. Ausência de prova, contradição e falha operacional são distintas; nenhuma precisão geral foi medida.'},processingAllowed:false,providerCalls:0,publicationChanged:false};
}
