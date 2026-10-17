import {createHash} from 'node:crypto';
import {validateCategoryIds} from './category-taxonomy.mjs';
import {reviewKnowledge,fieldLabels} from './knowledge.mjs';
import {semanticQualityPolicyVersion,literalClaimSupport,evaluateContextualPropositions,contextualPropositionEntries,typedFieldLiteralRule} from './reels-quality-semantic-policy.mjs';
import {validatePreparedAudio} from './audio-artifact.mjs';
export const qualityPolicyVersion='gate_v2';
const list=v=>Array.isArray(v)?v:[];
const normalize=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const present=s=>typeof s==='string'&&s.trim().length>0;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const qualityCandidateHash=report=>{
 const copy={...(report??{})};delete copy.publication_review;delete copy.qualityReceipt;delete copy.quality_receipt;
 return qualityDigest(copy);
};
export const qualityReceiptIdPattern=/^quality_[a-f0-9]{64}$/;
export const qualityDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const identity=(key,generation)=>present(key)&&/^\d+$/.test(String(generation??''))?{key,generation:String(generation)}:null;
const same=(a,b)=>!!a&&!!b&&qualityDigest(a)===qualityDigest(b);
const resultIdentity=value=>value&&present(value.key)&&/^\d+$/.test(String(value.generation??''))?{key:value.key,generation:String(value.generation)}:null;
const rangeValid=(v,duration)=>Number.isFinite(v.start_seconds)&&Number.isFinite(v.end_seconds)&&v.start_seconds>=0&&v.end_seconds>=v.start_seconds&&v.end_seconds<=duration;
const check=(code,state,reason,extra={})=>({code,state,reason,policyVersion:qualityPolicyVersion,ruleVersion:semanticQualityPolicyVersion,...extra});

// These identities come from the saved source record, not the model response.
// Unknown identities stay absent and cannot support a gate-v2 literal claim.
export function qualitySourceManifest(record={}){
 return {reelId:record.id??null,video:identity(record.video_key,record.video_generation),audio:identity(record.audio_key??record.prepared_audio_key,record.audio_generation??record.prepared_audio_generation),transcript:identity(record.transcript_key,record.transcript_generation),caption:present(record.source_caption?.capture_id)?{captureId:record.source_caption.capture_id}:null};
}
function sourceText(record,source){
 return source==='caption'?record.source_caption?.text:source==='transcript'?record.transcript:null;
}
export function checkTemporalUnits(units,duration){
 if(!Array.isArray(units))return {state:'not_recorded',count:0};
 let end=0;
 for(const unit of units){
  if(!rangeValid(unit,duration)||unit.start_seconds<end)return {state:'invalid',count:units.length};
  end=unit.end_seconds;
 }
 return {state:units.length?'present_unverified':'not_recorded',count:units.length};
}
function verifiedReview(path,reportHash,manifestHash,reviews,{visual=false}={}){
 // Only a separately loaded server record may review meaning or pixels.
 return list(reviews).find(r=>r&&r.fieldPath===path&&r.reportHash===reportHash&&r.sourceManifestHash===manifestHash&&r.verdict==='supported'&&present(r.receiptId)&&['human_source_review','independent_source_review'].includes(r.kind)&&(!visual||r.visualPixelsReviewed===true&&resultIdentity(r.frameArtifact)&&r.sourceManifestHash===qualityDigest(r.sourceManifest)&&same(r.videoIdentity,r.sourceManifest?.video)));
}
function temporalAnchor(e,record,transcriptionReceipt){
 if(e.start_seconds===undefined&&e.end_seconds===undefined)return {state:'not_recorded',verified:false};
 if(!rangeValid(e,record.duration_seconds))return {state:'invalid',verified:false};
 const units=transcriptionReceipt?.words??transcriptionReceipt?.segments;
 if(!Array.isArray(units)||!units.length)return {state:'unknown',verified:false};
 if(checkTemporalUnits(units,record.duration_seconds).state==='invalid')return {state:'invalid',verified:false};
 const matching=units.filter(w=>w.start_seconds>=e.start_seconds&&w.end_seconds<=e.end_seconds);
 const text=matching.map(w=>w.word??w.text??w.transcript??'').join(' ');
 if(!present(text))return {state:'unknown',verified:false};
 return normalize(text).includes(normalize(e.excerpt))?{state:'supported',verified:true}:{state:'invalid',verified:false};
}
function evaluateClaim(path,value,evidence,record,manifest,reportHash,manifestHash,reviews,transcriptionReceipt){
 if(!present(value))return check('CLAIM_EMPTY','invalid','Afirmação vazia.',{fieldPath:path});
 const refs=list(evidence);
 let literal=false,invalid=false,visual=path.startsWith('visual_observations.'),negated=false,temporalUnknown=false;
 for(const e of refs){
  if(!e||!['caption','transcript','video'].includes(e.source)){invalid=true;continue;}
  if(e.source==='video'){
   visual=true;
   if(!manifest.video||!same(e.sourceIdentity,manifest.video)||!rangeValid(e,record.duration_seconds))invalid=true;
   continue;
  }
  const saved=sourceText(record,e.source),sourceIdentity=manifest[e.source];
  if(!sourceIdentity||!same(e.sourceIdentity,sourceIdentity)||!present(e.excerpt)||!present(saved)||!normalize(saved).includes(normalize(e.excerpt))){invalid=true;continue;}
  if(e.source==='transcript'){
   const temporal=temporalAnchor(e,record,transcriptionReceipt);
   if(temporal.state==='invalid'){invalid=true;continue;}
   if(temporal.state==='unknown')temporalUnknown=true;
  }
  const support=literalClaimSupport(value,e.excerpt);
  if(support==='literal')literal=true;
  if(support==='negated_context')negated=true;
 }
 if(invalid)return check('CLAIM_EVIDENCE_INVALID','invalid','Referência inválida, tempo contraditório ou identidade incompatível com a fonte salva.',{fieldPath:path});
 if(negated)return check('CLAIM_NEGATED_CONTEXT','inconclusive','O valor foi extraído de contexto negativo; citação parcial não confirma afirmação positiva.',{fieldPath:path});
 if(literal&&!temporalUnknown&&!visual)return check('LITERAL_CLAIM_SUPPORTED','supported','Afirmação integral ancorada como texto da fonte identificada; não comprova alegação externa ou fidelidade do STT.',{fieldPath:path,verificationLevel:'literal_anchor_verified'});
 const review=verifiedReview(path,reportHash,manifestHash,reviews,{visual});
 if(review)return check(visual?'VISUAL_REVIEW_SUPPORTED':'SEMANTIC_REVIEW_SUPPORTED','supported','Revisão independente vinculada à afirmação e às fontes.',{fieldPath:path,verificationLevel:visual?'visual_support_independently_verified':'semantic_support_reviewed',reviewReceiptId:review.receiptId});
 return check(visual?'VISUAL_SUPPORT_UNVERIFIED':temporalUnknown?'TRANSCRIPT_ANCHOR_UNALIGNED':'CLAIM_SUPPORT_UNVERIFIED','inconclusive',visual?'Janela, texto ou booleano não comprovam pixels; apoio visual independente ausente.':temporalUnknown?'Intervalo citado sem palavras ou segmentos que comprovem o trecho nesse intervalo.':'A citação presente não comprova o significado da afirmação completa.',{fieldPath:path});
}
function contextualEvidenceReview(report,record,manifest,reportHash,manifestHash,reviews,transcriptionReceipt){
 const output=[],seen=new Set();
 for(const e of list(report.contextualSignals?.evidence)){
  if(!e||!present(e.id)||seen.has(e.id)){output.push({id:e?.id??null,state:'invalid',reason:'duplicate_or_missing_evidence_id'});continue;}seen.add(e.id);
  const source=manifest[e.sourceKind],expected=e.sourceKind==='caption'?source?.captureId:source?source.key+'@'+source.generation:null;
  if(!expected||e.sourceIdentity!==expected){output.push({id:e.id,state:'invalid',reason:'source_identity_mismatch'});continue;}
  const visual=e.sourceKind==='video',range={start_seconds:e.timeRange?.startSeconds,end_seconds:e.timeRange?.endSeconds,excerpt:e.excerpt};
  let temporal={state:'not_recorded',verified:false};
  if(visual){
   if(!rangeValid(range,record.duration_seconds)){output.push({id:e.id,state:'invalid',reason:'visual_range_invalid'});continue;}
  }else if(!present(e.excerpt)||!normalize(sourceText(record,e.sourceKind)).includes(normalize(e.excerpt))){output.push({id:e.id,state:'invalid',reason:'literal_anchor_missing'});continue;}
  else if(e.sourceKind==='transcript'){
   temporal=temporalAnchor(range,record,transcriptionReceipt);
   if(temporal.state==='invalid'){output.push({id:e.id,state:'invalid',reason:'temporal_anchor_mismatch'});continue;}
  }
  const review=verifiedReview('contextualSignals.evidence.'+e.id,reportHash,manifestHash,reviews,{visual});
  const common={id:e.id,temporalAnchorVerified:temporal.verified,sourceIdentity:expected,sourceKind:e.sourceKind,policyVersion:semanticQualityPolicyVersion};
  output.push(review?{...common,state:'supported',verificationLevel:visual?'visual_support_independently_verified':'semantic_support_reviewed',reviewReceiptId:review.receiptId}:{...common,state:visual||temporal.state==='unknown'?'present_unverified':'supported',verificationLevel:visual?'source_present':'literal_anchor_verified',reason:visual?'pixels_not_independently_reviewed':'literal_only_not_proposition_review'});
 }
 return output;
}
// Admission policy for a *new* already-received candidate. It has no provider,
// replay, queue, financial or historical-publication side effects. The caller
// must validate report shape with the existing contract before this policy.
export function evaluateQualityGateV2({record={},report,mediaInspection=null,transcriptionReceipt=null,trustedReviews=[]}={}){
 const sourceManifest=qualitySourceManifest(record),checks=[],gaps=[],reportHash=qualityCandidateHash(report),sourceManifestHash=qualityDigest(sourceManifest);
 if(!report||typeof report!=='object')return {policyVersion:qualityPolicyVersion,accepted:false,state:'inconclusive',reportHash,sourceManifestHash,sourceManifest,checks:[check('RESPONSE_NOT_RECEIVED','inconclusive','Resposta ausente não confirma falha nem autoriza repetição paga.')],gaps:[],replayAllowed:false};
 if(!sourceManifest.video||record.media_verified!==true||!Number.isFinite(record.duration_seconds)||record.duration_seconds<=0)checks.push(check('MEDIA_IDENTITY_MISSING','inconclusive','Identidade ou duração verificável da mídia ausente.'));
 else if(!mediaInspection||mediaInspection.kind!=='media-inspector'||!present(mediaInspection.receiptId)||!same(mediaInspection.sourceIdentity,sourceManifest.video))checks.push(check('MEDIA_INSPECTION_MISSING','inconclusive','Recibo de inspeção real vinculado à geração da mídia ausente.'));
 else if(mediaInspection.decodePassed!==true||mediaInspection.probePassed!==true||mediaInspection.durationSeconds!==record.duration_seconds||mediaInspection.expectedAudio===true&&mediaInspection.audioTrackPresent!==true)checks.push(check('MEDIA_INSPECTION_INVALID','invalid','Inspeção salva não confirma decodificação, duração ou trilha esperada.'));
 else checks.push(check('MEDIA_INSPECTED','supported','Recibo de inspeção salvo e identidade da mídia conferidos.'));
 const transcript=typeof record.transcript==='string'?record.transcript:null;
 if(transcript===null){gaps.push(check('TRANSCRIPT_NOT_RECORDED','not_recorded','Sem transcrição salva; não se infere ausência de fala.'));}
 else if(!sourceManifest.transcript||!sourceManifest.audio||!transcriptionReceipt||!present(transcriptionReceipt.operationIdentity)||!resultIdentity(transcriptionReceipt.rawResultIdentity)||!same(transcriptionReceipt.sourceAudioIdentity,sourceManifest.audio)||!same(transcriptionReceipt.resultIdentity,sourceManifest.transcript))checks.push(check('TRANSCRIPT_IDENTITY_MISSING','inconclusive','Áudio, operação ou resposta bruta da transcrição sem vínculo verificável.'));
 else{
  try{if(!validatePreparedAudio(record,record.audio_key))throw Error('audio');}catch{checks.push(check('AUDIO_SOURCE_BINDING_INVALID','invalid','Áudio preparado sem vínculo atômico verificável à mesma geração do vídeo.'));}
  const temporal=checkTemporalUnits(transcriptionReceipt.words??transcriptionReceipt.segments,record.duration_seconds);
  checks.push(check('TRANSCRIPT_TEMPORAL_ORDER',temporal.state==='invalid'?'invalid':'supported',temporal.state==='invalid'?'Tempos salvos fora da duração, sobrepostos ou fora de ordem.':'Identidades preservadas e limites temporais coerentes quando fornecidos; isso não prova fidelidade ou alinhamento com o áudio.'));
  if(temporal.state!=='invalid')gaps.push(check('TRANSCRIPT_ALIGNMENT_UNMEASURED','unknown','Tempos e confiança do provedor não são acurácia medida nem prova independente de alinhamento.'));
  if(!transcript.trim())gaps.push(check('NO_SPEECH_RECOGNIZED','not_recorded','Texto vazio preservado; silêncio e falta de informação não são falha STT.'));
 }
 try{
  validateCategoryIds(report.categories);
  if(!present(report.title)||!present(report.summary)||!Array.isArray(report.useful_information)||!report.useful_information.every(i=>present(i?.claim)&&typeof i?.application==='string'&&['author_claim','visual_observation','interpretation'].includes(i.classification)&&Array.isArray(i.evidence)&&i.evidence.length>0)||!Array.isArray(report.visual_observations)||!report.visual_observations.every(v=>typeof v==='string')||!Array.isArray(report.limitations)||!report.limitations.every(v=>typeof v==='string')||!present(report.transcript_quality?.assessment)||!Array.isArray(report.transcript_quality?.uncertain_segments)||!report.transcript_quality.uncertain_segments.every(s=>typeof s==='string'))throw Error('shape');
  if(report.knowledge){const reviewed=reviewKnowledge(report.knowledge,record);if(reviewed.omitted)throw Error('omitted');}
  else throw Error('missing_knowledge');
 }catch{checks.push(check('REPORT_CONTRACT_INVALID','invalid','Estrutura principal ou campo de conhecimento inválido sob o contrato tipado.'));}
 const q=report.qualityEvidenceV2;
 if(q?.version!==2)checks.push(check('NARRATIVE_EVIDENCE_MISSING','inconclusive','Contrato versionado de evidência para título e resumo ausente.'));
 for(const path of ['title','summary'])checks.push(evaluateClaim(path,report[path],q?.[path],record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 for(const [index,item]of list(report.useful_information).entries())checks.push(evaluateClaim('useful_information.'+index+'.claim',item?.claim,item?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 for(const [index,item]of list(report.knowledge?.fields).entries()){
  checks.push(evaluateClaim('knowledge.fields.'+index+'.value',item?.value,item?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
  const roleRule=typedFieldLiteralRule(item),roleReview=verifiedReview('knowledge.fields.'+index+'.kind',reportHash,sourceManifestHash,trustedReviews);
  checks.push(check(roleRule?'TYPED_FIELD_RULE_SUPPORTED':roleReview?'TYPED_FIELD_REVIEW_SUPPORTED':'TYPED_FIELD_ROLE_UNVERIFIED',roleRule||roleReview?'supported':'inconclusive',roleRule?'Papel tipado conferido por regra textual limitada: '+roleRule:roleReview?'Papel tipado conferido por recibo independente.':'Texto literal não comprova por si só o papel tipado do campo.',{fieldPath:'knowledge.fields.'+index+'.kind',typedRule:roleRule,reviewReceiptId:roleReview?.receiptId??null}));
  if(item?.name!==fieldLabels[item?.kind])checks.push(evaluateClaim('knowledge.fields.'+index+'.name',item?.name,item?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 }
 for(const [index,item]of list(report.knowledge?.keywords).entries())checks.push(evaluateClaim('knowledge.keywords.'+index+'.term',item?.term,item?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 for(const [index,item]of list(report.useful_information).entries())if(present(item?.application))checks.push(evaluateClaim('useful_information.'+index+'.application',item.application,q?.applications?.find(e=>e.index===index)?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 // Contextual facets are optional. Their absence never turns a legitimate
 // knowledge gap into a failed provider stage or a reason to replay A.
 for(const [index,value]of list(report.visual_observations).entries())checks.push(evaluateClaim('visual_observations.'+index,value,q?.visualObservations?.find(e=>e.index===index)?.evidence,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt));
 if(report.knowledge?.context==='recipe'){
  const saved=list(report.source_consolidation?.sources);
  const expected=[...(present(record.source_caption?.text)?[{source:'caption',text:record.source_caption.text,capture_id:record.source_caption.capture_id}]:[]),...(present(record.transcript)?[{source:'transcript',text:record.transcript}]:[])];
  if(expected.some(source=>!saved.some(s=>s.source===source.source&&s.text===source.text&&(source.source!=='caption'||s.capture_id===source.capture_id))))checks.push(check('RECIPE_SAVED_SOURCE_INCOMPLETE','inconclusive','A publicação da receita precisa preservar integralmente as fontes salvas; campos extraídos sozinhos não demonstram cobertura.'));
  else checks.push(check('RECIPE_SAVED_SOURCE_PRESERVED','supported','Fontes completas preservadas sem inventar ingredientes, quantidades ou etapas.'));
  gaps.push(check('RECIPE_SEMANTIC_COMPLETENESS_UNMEASURED','unknown','Texto completo preservado não certifica extração semântica completa; lacunas legítimas continuam explícitas.'));
 }
 if(!report.contextualSignals)gaps.push(check('CONTEXTUAL_ATTRIBUTES_NOT_RECORDED','not_recorded','Atributos contextuais opcionais ausentes; não bloqueiam conhecimento principal válido.'));
 const contextualEvidence=contextualEvidenceReview(report,record,sourceManifest,reportHash,sourceManifestHash,trustedReviews,transcriptionReceipt);
 const contextualPropositions=evaluateContextualPropositions({report,reportHash,sourceManifestHash,contextualEvidence,trustedReviews});
 const invalid=checks.some(c=>c.state==='invalid'),accepted=checks.length>0&&checks.every(c=>c.state==='supported');
 return {policyVersion:qualityPolicyVersion,semanticPolicyVersion:semanticQualityPolicyVersion,accepted,contextualEvidence,contextualPropositions,state:accepted?'supported':invalid?'invalid':'inconclusive',reportHash,sourceManifestHash,sourceManifest,checks,gaps,replayAllowed:false};
}

// Save the exact response/candidate first, then an immutable gate receipt, then
// CAS the accepted pointer. Ports are server-owned persistence adapters. A
// failed B/index consumer is deliberately outside this function.
export function verifyPublicationQualityReceipt({video,receipt}={}){
 const ref=video?.publication?.qualityReceipt;
 const untrusted=reason=>({trusted:false,reason,policyVersion:'historical_baseline',receiptId:ref?.receiptId??null,candidateContentHash:null,verifiedEvidenceIds:[],literalEvidenceIds:[],verifiedAttributes:[],verifiedUnits:[],verifiedPrimaryContext:null});
 if(!qualityReceiptIdPattern.test(ref?.receiptId??''))return untrusted('receipt_not_recorded');
 if(!receipt||receipt.id!==ref.receiptId||receipt.createdBy!=='server:gate_v2'||receipt.policyVersion!==qualityPolicyVersion||receipt.verdict!=='accepted')return untrusted('receipt_not_accepted');
 const {id,...receiptBody}=receipt;
 if(id!=='quality_'+qualityDigest(receiptBody))return untrusted('receipt_id_mismatch');
 if(ref.receiptHash!==qualityDigest(receipt))return untrusted('receipt_hash_mismatch');
 if(receipt.reelId!==video.id||receipt.analysisKey!==video.analysis_key||String(receipt.analysisGeneration)!==String(video.analysis_generation))return untrusted('publication_identity_mismatch');
 const candidateContentHash=qualityCandidateHash(video.analysis);
 if(receipt.candidateContentHash!==candidateContentHash||!video.analysis||!list(receipt.checks).length||receipt.checks.some(c=>c.state!=='supported'))return untrusted('candidate_or_gate_mismatch');
 const manifest=qualitySourceManifest(video);
 if(!receipt.sourceManifest||receipt.sourceManifestHash!==qualityDigest(receipt.sourceManifest)||!same(manifest,receipt.sourceManifest))return untrusted('source_manifest_mismatch');
 const propositions=receipt.contextualPropositions?.policyVersion===semanticQualityPolicyVersion?receipt.contextualPropositions:null;
 const exactPropositions=new Map(contextualPropositionEntries(video.analysis).map(e=>[e.fieldPath,e.propositionHash]));
 const verified=entry=>exactPropositions.get(entry?.fieldPath)===entry?.propositionHash&&entry?.state==='supported'&&entry.policyVersion===semanticQualityPolicyVersion&&entry.reportHash===candidateContentHash&&entry.sourceManifestHash===receipt.sourceManifestHash&&present(entry.reviewReceiptId);
 return {trusted:true,reason:null,policyVersion:qualityPolicyVersion,receiptId:receipt.id,candidateContentHash,verifiedAttributes:list(propositions?.attributes).filter(verified),verifiedUnits:list(propositions?.units).filter(verified),verifiedPrimaryContext:verified(propositions?.primaryContext)?propositions.primaryContext:null,verifiedEvidenceIds:list(receipt.contextualEvidence).filter(e=>e.state==='supported'&&['semantic_support_reviewed','visual_support_independently_verified'].includes(e.verificationLevel)&&present(e.reviewReceiptId)).map(e=>e.id),literalEvidenceIds:list(receipt.contextualEvidence).filter(e=>e.state==='supported'&&e.verificationLevel==='literal_anchor_verified').map(e=>e.id)};
}
export async function persistQualityCandidateV2({record,report,rawResponse,ports,expectedPublicationRevision=null,...evidence}={}){
 for(const method of ['saveCandidate','saveReceipt','compareAndSetPublication'])if(typeof ports?.[method]!=='function')throw Error('Porta de persistência de qualidade ausente: '+method);
 if(rawResponse===undefined||rawResponse===null)return {accepted:false,state:'inconclusive',replayAllowed:false,reasons:['response_not_received'],publicationChanged:false};
 const saved=await ports.saveCandidate({reelId:record.id,rawResponse,report,candidateContentHash:qualityCandidateHash(report)});
 const candidateIdentity=resultIdentity(saved);
 if(saved?.candidateContentHash!==qualityCandidateHash(report))throw Error('Hash do candidato persistido incompatível.');
 if(!candidateIdentity)throw Error('Candidato precisa de identidade durável antes da avaliação.');
 const gate=evaluateQualityGateV2({record,report,...evidence});
 const receiptBody={createdBy:'server:gate_v2',policyVersion:qualityPolicyVersion,verdict:gate.accepted?'accepted':'rejected',reelId:record.id,analysisKey:candidateIdentity.key,analysisGeneration:candidateIdentity.generation,candidateContentHash:gate.reportHash,sourceManifest:gate.sourceManifest,sourceManifestHash:gate.sourceManifestHash,checks:gate.checks,gaps:gate.gaps,semanticPolicyVersion:semanticQualityPolicyVersion,contextualEvidence:gate.contextualEvidence??[],contextualPropositions:gate.contextualPropositions??null};
 const receipt={id:'quality_'+qualityDigest(receiptBody),...receiptBody};
 const receiptIdentity={receiptId:receipt.id,receiptHash:qualityDigest(receipt)};
 const savedReceipt=await ports.saveReceipt(receipt);
 if(savedReceipt?.id!==receipt.id||savedReceipt?.receiptHash!==receiptIdentity.receiptHash)throw Error('Recibo precisa de confirmação durável antes da publicação.');
 if(!gate.accepted)return {...gate,candidateIdentity,receiptIdentity,publicationChanged:false};
 const publicationIdentity={...candidateIdentity,reportHash:gate.reportHash};
 const committed=await ports.compareAndSetPublication({reelId:record.id,expectedPublicationRevision,publicationIdentity,qualityPolicyVersion,qualityReceipt:receiptIdentity,sourceManifest:gate.sourceManifest});
 if(committed?.applied!==true)return {...gate,accepted:false,state:'inconclusive',candidateIdentity,receiptIdentity,publicationChanged:false,reasons:['publication_revision_conflict']};
 return {...gate,candidateIdentity,receiptIdentity,publicationIdentity,publicationChanged:true,event:{eventType:'publicationAccepted',reelId:record.id,publicationIdentity,qualityPolicyVersion,sourceManifest:gate.sourceManifest,contextualSignals:report.contextualSignals??null}};
}
