import {createHash} from 'node:crypto';
import {buildSavedQualityDiagnostics} from './reels-quality-diagnostics.mjs';
import {publicationAvailable} from './reels-model.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fault=(message,code='INVALID_QUERY',status=400)=>Object.assign(Error(message),{status,code});
const policyDescription='Critérios versionados para próximas execuções; esta consulta avalia somente provas salvas e preserva publicações históricas.';
const rules=Object.freeze([{id:'media',label:'Mídia identificada e inspeção de decodificação'},{id:'transcription',label:'Áudio, operação, resposta salva e coerência temporal'},{id:'claims',label:'Afirmações, título e resumo ligados às fontes'},{id:'visual',label:'Observação visual com prova independente'},{id:'publication',label:'Candidato e recibo duráveis antes de substituir publicação'}]);
function sameIdentity(a,b){return !!a&&!!b&&['kind','reelId','analysisKey','analysisGeneration','recordHash','sourceSnapshotHash'].every(k=>(a[k]??null)===(b[k]??null));}

const calibrationReasons={TRAIN_POSITIVE_OR_NEGATIVE_SAMPLE_INSUFFICIENT:'Poucos exemplos positivos ou negativos na preparação.',HOLDOUT_POSITIVE_OR_NEGATIVE_SAMPLE_INSUFFICIENT:'Poucos exemplos positivos ou negativos na validação separada.',EMPIRICAL_PRECISION_TARGET_NOT_MET:'A regra ainda não atende à precisão exigida nesta amostra.',RECALL_OR_SOURCE_COVERAGE_INSUFFICIENT:'A cobertura dos exemplos positivos ainda é insuficiente.',TRAIN_POSITIVE_INSUFFICIENT:'Poucos exemplos positivos na preparação.',TRAIN_NEGATIVE_INSUFFICIENT:'Poucos exemplos negativos na preparação.',HOLDOUT_POSITIVE_INSUFFICIENT:'Poucos exemplos positivos na validação separada.',HOLDOUT_NEGATIVE_INSUFFICIENT:'Poucos exemplos negativos na validação separada.',FALSE_POSITIVE_OBSERVED:'A regra incluiu conteúdo sem apoio suficiente.',FINITE_REVIEWED_SUPPORT_INSUFFICIENT:'O grupo ainda tem poucos membros auditados.',UNLABELED_POSITIVE_PREDICTIONS:'Há inclusões previstas sem revisão independente.',RECALL_BELOW_POLICY:'A cobertura dos exemplos positivos ficou abaixo do critério.'};
const metricView=m=>m?{...m,total:m.total??m.labelled??m.evaluated??null,abstained:m.abstained??m.abstentionCount??null}:null;
export function calibrationReportView(report,plan=null){
 if(!report)return null;
 return {policyVersion:report.version,observedAt:report.observedAt,evaluatedCount:report.corpus?.evaluatedCount??null,unknownCount:report.corpus?.unevaluatedCount??null,groups:list(report.rules).map(rule=>({id:rule.ruleId,label:rule.label,state:rule.status,reason:list(rule.reasonCodes).map(code=>calibrationReasons[code]??'Critério de calibração ainda não atendido.').join(' '),members:list(rule.members),memberCount:rule.reviewedMemberCount??list(rule.members).length,metrics:{train:metricView(rule.train),holdout:metricView(rule.holdout)},ruleHash:report.policyHash,appliedCategoryId:list(plan?.groups).find(group=>group.calibrationRuleId===rule.ruleId)?.categoryId??null})),limitations:['Calibração restrita aos membros e às fontes auditadas; não é uma amostra representativa de todo o acervo.','O intervalo e as métricas descrevem a amostra, sem certificar novos vídeos.','Ingrediente em ao menos um preparo não significa tema central ou lista inteira centrada nesse ingrediente.','Conteúdo não avaliado permanece desconhecido; nenhuma análise paga foi refeita.']};
}

export class ReelsCurationCalibration{
 constructor({repository,contextual,clock=Date.now}){this.repository=repository;this.contextual=contextual;this.clock=clock;}
 async overview(){
  const snapshot=await this.contextual.snapshotData(),saved=await this.repository.store.get('settings/reels_v2_contextual_calibration'),data=saved?.data;
  const base={observedAt:new Date(this.clock()).toISOString(),dataAsOf:snapshot.dataAsOf,sourceStale:snapshot.sourceStale,scope:'finite_current_corpus',inventoryCount:snapshot.acceptedInventory,semanticQualityMeasured:false,processingStarted:false,policyDescription:'Agrupamentos limitados às publicações e provas auditadas. O resultado não certifica vídeos futuros nem todo o acervo.'};
  if(!data||data.schemaVersion!==1||!validHash(data.planHash)||!validHash(data.sourceHash)||!data.report)return {...base,available:false,evaluatedCount:null,unknownCount:snapshot.acceptedInventory,groups:[],limitations:['Calibração ainda não aplicada. Recorrência observada não é uma categoria automática aprovada.']};
  const report=data.report,entries=new Map(snapshot.entries.map(e=>[e.id,e])),taxonomy=(await this.repository.store.get('settings/reels_v2_taxonomy'))?.data??{};
  const groups=list(report.groups).map(group=>{
   const original=list(group.members),members=original.filter(member=>{
    const entry=entries.get(member.id),proof=member.publicationProofHash??member.proofContentHash;
    if(!entry||!validHash(proof)||(entry.sourceProofHash??entry.proofContentHash)!==proof||!sameIdentity(entry.sourceIdentity,member.sourceIdentity))return false;
    const manual=list(taxonomy.assignments).find(a=>a.reelId===member.id&&a.manual===true);
    if(manual||entry.manual===true||entry.curation?.manual===true)return false;
    return true;
   }).map(member=>({...member,title:entries.get(member.id)?.title??member.title??member.id}));
   const changed=members.length!==original.length,node=list(taxonomy.nodes).find(n=>n.id===group.appliedCategoryId),nodeTrusted=!!node&&node.manual!==true&&node.calibrationPlanHash===data.planHash;
   return {...group,members,memberCount:members.length,state:changed?'insufficient':group.state,reason:changed?'Alguma publicação ou edição mudou. Revise as provas antes de ampliar este grupo.':group.reason,appliedCategoryId:!changed&&nodeTrusted?node.id:null,sourceChanged:changed};
  });
  return {...base,available:true,policyVersion:report.policyVersion??data.policyVersion,sourceHash:data.sourceHash,planHash:data.planHash,calibrationObservedAt:report.observedAt??data.observedAt,evaluatedCount:report.evaluatedCount??null,unknownCount:report.unknownCount??null,groups,limitations:list(report.limitations),automaticScope:'audited_members_only',newContentAutomatic:false};
 }
 async savedQuality(input={}){
  const limit=Number(input.limit??25),q=typeof input.q==='string'?input.q.trim():'',source=input.source??'';
  if(!Number.isInteger(limit)||limit<1||limit>25||q.length>500||!['','native','legacy_preserved'].includes(source))throw fault('Consulta de qualidade inválida.');
  const normalized=q.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const all=(await this.repository.items()).filter(i=>i.publication?.available).sort((a,b)=>a.id.localeCompare(b.id));
  const rows=all.filter(i=>(!source||(i.publication.source==='legacy_preserved'?'legacy_preserved':'native')===source)&&(!q||[i.id,i.title,i.creator].join(' ').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').includes(normalized)));
  const queryHash=sha({q,source,limit}),catalogHash=sha(rows.map(i=>[i.id,i.publication.revision??null]));let offset=0;
  if(input.cursor){let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw fault('Cursor de qualidade inválido.');}if(cursor.queryHash!==queryHash||cursor.catalogHash!==catalogHash||!Number.isInteger(cursor.offset)||cursor.offset<0||cursor.offset>rows.length)throw fault('A seleção mudou; atualize a consulta.','QUALITY_CURSOR_CHANGED',409);offset=cursor.offset;}
  const selected=rows.slice(offset,offset+limit),items=[];
  // Only selected published source records are read. No execution/error scan,
  // media load, provider adapter, queue or taxonomy writer exists on this path.
  for(const item of selected){
   const raw=await this.repository.raw(item.id);
   if(!raw||!publicationAvailable(raw)||item.publication.source==='legacy_preserved'){
    items.push({reelId:item.id,title:item.title,policyVersion:'gate_v2',historical:true,state:'present_unverified',diagnostics:[{code:'PRESERVED_BASELINE',state:'unknown',message:'Publicação preservada sob a regra anterior. Não há contrato de provas v2 para certificar retroativamente.'}],sourceHash:sha({id:item.id,revision:item.publication.revision??null}),gateWouldAccept:null,publicationChanged:false});continue;
   }
   const result=buildSavedQualityDiagnostics({candidates:[{record:raw,report:raw.analysis,mediaInspection:raw.media_inspection??null,transcriptionReceipt:raw.transcription_receipt??null,trustedReviews:[],historical:true}],observedAt:new Date(this.clock()).toISOString()});
   const row=result.candidates[0];
   items.push({reelId:item.id,title:item.title,policyVersion:result.policyVersion,historical:true,state:row.state,diagnostics:[...row.checks,...row.gaps].map(check=>({code:check.code,state:check.state,message:check.reason,fieldPath:check.fieldPath??null})),coverage:row.sourceCoverage,sourceHash:row.sourceManifestHash,gateWouldAccept:row.gateWouldAccept,publicationChanged:false});
  }
  const observation=this.repository.observation?.()??{};
  return {observedAt:new Date(this.clock()).toISOString(),dataAsOf:observation.observedAt??null,sourceStale:observation.cache?.stale===true,policyVersion:'gate_v2',policyDescription,rules,scope:'saved_publications_diagnostic_only',total:rows.length,inventoryCount:all.length,evaluated:items.length,items,nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify({queryHash,catalogHash,offset:offset+limit})).toString('base64url'):null,semanticQualityMeasured:false,processingStarted:false,limitations:['Diagnóstico documental, sem reinspeção do áudio ou dos pixels.','Lacuna de prova na regra nova não transforma publicado em falha nem autoriza repetição de análise.']};
 }
}
