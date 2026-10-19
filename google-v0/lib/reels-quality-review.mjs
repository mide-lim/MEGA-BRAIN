import {qualityCandidateHash,qualityDigest,qualitySourceManifest} from './reels-quality-gate.mjs';
import {contextualPropositionEntries,semanticQualityPolicyVersion} from './reels-quality-semantic-policy.mjs';
import {sha256} from './storage.mjs';
import {analysisReportOutcome} from './analysis.mjs';
import {knowledgeReadiness} from './reels-quality.mjs';

// An authenticated operator seals an actual independent review. These helpers
// never produce editorial verdicts or call a model. The authenticated import
// below creates the protected selection only after verifying the real approval.
export const qualityReviewVersion='independent-source-review-v1';
export const qualityReviewIdPattern=/^review_[a-f0-9]{64}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const list=v=>Array.isArray(v)?v:[];
const text=(v,max=2000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const same=(a,b)=>a!==undefined&&b!==undefined&&qualityDigest(a)===qualityDigest(b);
const need=(condition,message)=>{if(!condition)throw Object.assign(Error(message),{code:'QUALITY_REVIEW_INVALID',status:409,definitive:true});};
const identity=v=>v&&text(v.key,512)&&/^\d{1,30}$/.test(v.generation??'');
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const fieldPattern=/^(?:title|summary|useful_information\.\d+\.(?:claim|application)|visual_observations\.\d+|knowledge\.fields\.\d+\.(?:value|name|kind)|knowledge\.keywords\.\d+\.term|contextualSignals\.(?:primaryContext|units\.\d+|attributes\.\d+|evidence\.[A-Za-z0-9_-]{1,100}))$/;
function knownField(report,path){
 if(!fieldPattern.test(path??''))return false;
 if(path.startsWith('contextualSignals.evidence.'))return list(report.contextualSignals?.evidence).some(e=>e.id===path.slice('contextualSignals.evidence.'.length));
 let value=report;for(const key of path.split('.')){if(!value||!Object.hasOwn(value,key))return false;value=value[key];}return value!==undefined&&value!==null;
}
function artifactValid(value,binding){
 const prefix=`results/instagram/${binding.reelId}/${binding.executionId}/quality-review/`;
 return keys(value,['key','generation','sha256'])&&identity(value)&&value.key.startsWith(prefix)&&/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,150}\.(?:json|png|jpe?g)$/.test(value.key.slice(prefix.length))&&digestPattern.test(value.sha256??'');
}
export function qualityReviewBinding({record,originalReport,executionId,rawResponseIdentity,originalCandidateIdentity}={}){
 need(/^[A-Za-z0-9_-]{5,32}$/.test(record?.id??'')&&digestPattern.test(executionId??''),'Execução e Reel exatos obrigatórios para a revisão.');
 const prefix=`results/instagram/${record.id}/${executionId}/`;
 need(identity(rawResponseIdentity)&&rawResponseIdentity.key===prefix+'analysis.json'&&keys(rawResponseIdentity,['key','generation']),'Resposta original fora da execução revisada.');
 need(identity(originalCandidateIdentity)&&originalCandidateIdentity.key===prefix+'quality-candidate.json'&&keys(originalCandidateIdentity,['key','generation']),'Candidato original fora da execução revisada.');
 need(originalReport&&typeof originalReport==='object'&&!Array.isArray(originalReport),'Relatório original preservado obrigatório.');
 const sourceManifest=qualitySourceManifest(record);
 return {executionId,reelId:record.id,rawResponseIdentity,originalCandidateIdentity,originalReportHash:qualityCandidateHash(originalReport),sourceManifest,sourceManifestHash:qualityDigest(sourceManifest)};
}
export const qualityReviewSelectionId=binding=>'source_review_'+qualityDigest({version:qualityReviewVersion,...binding});
const bodyKeys=['version','createdBy','kind','policyVersion','executionId','reelId','rawResponseIdentity','originalCandidateIdentity','originalReportHash','sourceManifest','sourceManifestHash','report','reportHash','authorIdentity','reviewerIdentity','reviewerExecutor','method','observedAt','reviewEvidence','importEvidence','entries'];
function validateBody(body,{binding,record}){
 need(keys(body,bodyKeys)&&body.version===qualityReviewVersion&&body.createdBy==='operator:source-review-v1'&&['human_source_review','independent_source_review'].includes(body.kind)&&body.policyVersion===semanticQualityPolicyVersion,'Origem ou versão da revisão independente inválida.');
 for(const [key,value]of Object.entries(binding))need(same(body[key],value),'Revisão não corresponde à fonte original: '+key);
 need(text(body.authorIdentity,200)&&text(body.reviewerIdentity,200)&&body.authorIdentity!==body.reviewerIdentity&&['human','codex-native','external'].includes(body.reviewerExecutor)&&text(body.method,1000)&&text(body.observedAt,40)&&Number.isFinite(Date.parse(body.observedAt)),'Proveniência independente incompleta.');
 need(body.report&&typeof body.report==='object'&&!Array.isArray(body.report)&&body.reportHash===qualityCandidateHash(body.report),'Hash do relatório revisado divergente.');
 need(Buffer.byteLength(JSON.stringify(body),'utf8')<=700000&&Array.isArray(body.entries)&&body.entries.length>0&&body.entries.length<=256,'Revisão vazia ou acima do limite.');
 need(artifactValid(body.reviewEvidence,binding),'Artefato do parecer fora da execução revisada.');
 if(body.importEvidence!==undefined)need(keys(body.importEvidence,['packageIdentity','draftArtifact'])&&['packageIdentity','draftArtifact'].every(k=>artifactValid(body.importEvidence[k],binding)&&body.importEvidence[k].key.endsWith('.json')),'Vínculo durável da importação inválido.');
 const seen=new Set(),propositions=new Map(contextualPropositionEntries(body.report).map(e=>[e.fieldPath,e.propositionHash]));
 for(const entry of body.entries){
  need(keys(entry,['fieldPath','verdict','reason','method','propositionHash','visualPixelsReviewed','frameArtifact','frameArtifacts','frameSampleSeconds','videoIdentity','sourceManifest'])&&knownField(body.report,entry.fieldPath)&&!seen.has(entry.fieldPath),'Campo desconhecido ou revisão conflitante/duplicada.');seen.add(entry.fieldPath);
  need(['supported','inconclusive','invalid'].includes(entry.verdict)&&text(entry.reason,4000)&&(entry.method===undefined||text(entry.method,1000)),'Veredito independente, método ou motivo ausente.');
  if(propositions.has(entry.fieldPath))need(entry.propositionHash===propositions.get(entry.fieldPath),'Proposição revisada divergente.');
  else need(entry.propositionHash===undefined,'Hash de proposição fora de campo contextual.');
  const hasVisual=['visualPixelsReviewed','frameArtifact','frameArtifacts','frameSampleSeconds','videoIdentity','sourceManifest'].some(k=>Object.hasOwn(entry,k));
  if(hasVisual){
   need(entry.visualPixelsReviewed===true&&same(entry.videoIdentity,binding.sourceManifest.video)&&same(entry.sourceManifest,binding.sourceManifest),'Revisão visual sem identidade exata.');
   const plural=entry.frameArtifacts!==undefined;
   need(!plural||entry.frameArtifact===undefined&&entry.frameSampleSeconds===undefined,'Provas visuais singular e plural não podem ser misturadas.');
   const frames=plural?entry.frameArtifacts:[{artifact:entry.frameArtifact,sampleSeconds:entry.frameSampleSeconds}];
   need(Array.isArray(frames)&&frames.length>0&&frames.length<=32,'Coleção visual vazia ou acima do limite.');
   const frameIds=new Set();
   for(const frame of frames){
    need(keys(frame,['artifact','sampleSeconds'])&&artifactValid(frame.artifact,binding)&&/\.(?:png|jpe?g)$/.test(frame.artifact.key),'Artefato visual inválido ou sem pixels.');
    const id=frame.artifact.key+'@'+frame.artifact.generation;need(!frameIds.has(id),'Artefato visual duplicado no campo.');frameIds.add(id);
    need(Array.isArray(frame.sampleSeconds)&&frame.sampleSeconds.length>0&&frame.sampleSeconds.length<=128&&new Set(frame.sampleSeconds).size===frame.sampleSeconds.length&&frame.sampleSeconds.every(t=>Number.isFinite(t)&&t>=0&&t<=record.duration_seconds),'Amostras visuais fora da duração salva.');
   }
  }
 }
}
export function sealQualitySourceReview({record,originalReport,executionId,rawResponseIdentity,originalCandidateIdentity,report,entries,...provenance}={}){
 const binding=qualityReviewBinding({record,originalReport,executionId,rawResponseIdentity,originalCandidateIdentity});
 const body={version:qualityReviewVersion,createdBy:'operator:source-review-v1',kind:'independent_source_review',policyVersion:semanticQualityPolicyVersion,...binding,report,reportHash:qualityCandidateHash(report),...provenance,entries};
 validateBody(body,{binding,record});
 const review={id:'review_'+qualityDigest(body),...body};
 const selection={id:qualityReviewSelectionId(binding),kind:'source_review_selection',createdBy:'operator:source-review-v1',reviewId:review.id,reviewHash:qualityDigest(review)};
 return {review,selection};
}
export function verifyQualitySourceReview({review,selection,record,originalReport,executionId,rawResponseIdentity,originalCandidateIdentity,requestedReviewId=null}={}){
 const binding=qualityReviewBinding({record,originalReport,executionId,rawResponseIdentity,originalCandidateIdentity});
 need(keys(review,['id',...bodyKeys])&&qualityReviewIdPattern.test(review?.id??''),'Identidade de revisão selada inválida.');
 const {id,...body}=review;need(id==='review_'+qualityDigest(body),'Conteúdo da revisão selada diverge.');validateBody(body,{binding,record});
 need(keys(selection,['id','kind','createdBy','reviewId','reviewHash'])&&selection.id===qualityReviewSelectionId(binding)&&selection.kind==='source_review_selection'&&selection.createdBy==='operator:source-review-v1'&&selection.reviewId===id&&selection.reviewHash===qualityDigest(review),'Seleção de revisão do servidor divergente.');
 need(requestedReviewId===null||requestedReviewId===id,'A revisão selecionada mudou; confira antes de aplicar.');
 const common={kind:review.kind,policyVersion:review.policyVersion,reportHash:review.reportHash,sourceManifestHash:review.sourceManifestHash,method:review.method,observedAt:review.observedAt,reviewerIdentity:review.reviewerIdentity};
 return {report:structuredClone(review.report),trustedReviews:review.entries.map(entry=>({...common,...structuredClone(entry),receiptId:id+':'+entry.fieldPath})),reviewIdentity:{reviewId:id,reviewHash:selection.reviewHash,selectionId:selection.id}};
}
// No scan, model-chosen object key, or provider access: two server records and
// bounded immutable artifacts belonging to this exact saved execution only.
export async function loadQualitySourceReview({store,storage,...input}={}){
 const binding=qualityReviewBinding(input),selectionId=qualityReviewSelectionId(binding),selectionPath='reels_quality_receipts/'+selectionId;
 const selected=await store.get(selectionPath);
 if(!selected){need(!input.requestedReviewId,'Recibo independente selecionado ausente.');return null;}
 need(qualityReviewIdPattern.test(selected.data?.reviewId??''),'Seleção de revisão inválida.');
 const reviewPath='reels_quality_receipts/'+selected.data.reviewId,saved=await store.get(reviewPath);
 need(saved?.data,'Recibo independente selecionado ausente.');
 need(text(selected.updateTime,100)&&text(saved.updateTime,100),'Versão persistida da revisão ausente.');
 const verified=verifyQualitySourceReview({...input,review:saved.data,selection:selected.data});
 const read=reviewArtifactReader(storage,binding);
 for(const artifact of [saved.data.reviewEvidence,...Object.values(saved.data.importEvidence??{}),...saved.data.entries.flatMap(e=>e.frameArtifacts?.map(f=>f.artifact)??(e.frameArtifact?[e.frameArtifact]:[]))])await read(artifact);
 return {...verified,sourceVersions:[{path:selectionPath,updateTime:selected.updateTime},{path:reviewPath,updateTime:saved.updateTime}]};
}

// One bounded reader is shared across package, editorial files and every PNG.
// Metadata alone is never enough: each generation is read and byte-hashed.
function reviewArtifactReader(storage,binding){
 const seen=new Map();let total=0;
 return async artifact=>{
  need(artifactValid(artifact,binding),'Artefato fora da execução revisada.');
  const key=artifact.key+'@'+artifact.generation,existing=seen.get(key);
  if(existing){need(same(existing.artifact,artifact),'Identidade de artefato com hashes conflitantes.');return existing.bytes;}
  need(seen.size<64,'Número de artefatos de revisão acima do limite.');
  const meta=await storage.metadata(artifact.key),size=Number(meta?.size);
  need(meta?.generation===artifact.generation&&Number.isSafeInteger(size)&&size>0&&size<=8000000&&meta.metadata?.sha256===artifact.sha256,'Artefato revisado sem geração, tamanho ou hash conferíveis.');
  total+=size;need(total<=20000000,'Artefatos da revisão acima do limite total.');
  const bytes=await storage.read(artifact.key,{generation:artifact.generation});
  need(bytes.length===size&&sha256(bytes)===artifact.sha256,'Bytes do artefato revisado divergentes.');seen.set(key,{artifact,bytes});return bytes;
 };
}
function reviewJson(bytes){need(bytes.length<=700000,'Arquivo editorial acima do limite.');try{return JSON.parse(bytes.toString('utf8'));}catch{need(false,'Arquivo editorial inválido.');}}
function fieldValue(report,path){
 if(path.startsWith('contextualSignals.evidence.'))return list(report.contextualSignals?.evidence).find(e=>e.id===path.slice('contextualSignals.evidence.'.length));
 return path.split('.').reduce((value,key)=>value?.[key],report);
}
export function sealApprovedEditorialReview({draft,approval,draftArtifact,approvalArtifact,frames,...input}={}){
 const binding=qualityReviewBinding(input),{record}=input;
 need([draft?.editorIdentity,draft?.reviewerIdentity,approval?.run_id].every(v=>text(v,200))&&[draft?.editorThreadId,draft?.reviewerThreadId,approval?.native_thread_id].every(v=>text(v,100)),'Identidades nativas obrigatórias da edição e revisão ausentes.');
 need(draft?.executionId===binding.executionId&&draft.reelId===binding.reelId&&draft.originalReportHash===binding.originalReportHash&&same(draft.rawResponseIdentity,binding.rawResponseIdentity)&&same(draft.originalCandidateIdentity,binding.originalCandidateIdentity)&&same(draft.sourceManifest,binding.sourceManifest),'Rascunho editorial pertence a outra resposta ou fonte.');
 need(approval?.kind==='independent_editorial_approval_not_production_receipt'&&approval.decision==='approved_for_exact_report_and_entries'&&approval.executor==='codex-native'&&approval.run_id===draft.reviewerIdentity&&approval.native_thread_id===draft.reviewerThreadId&&approval.native_thread_id!==draft.editorThreadId&&approval.draft?.sha256===draftArtifact.sha256,'Parecer independente não aprova o rascunho exato.');
 need(same(draft.normativeEditorialFields,['report','entriesForIndependentApproval'])&&Array.isArray(draft.entriesForIndependentApproval)&&draft.entriesForIndependentApproval.length>0&&draft.entriesForIndependentApproval.length<=256&&Array.isArray(approval.entryReviews)&&draft.entriesForIndependentApproval.length===approval.entryReviews.length,'Campos editoriais normativos ou pareceres ausentes.');
 const byName=new Map(),propositions=new Map(contextualPropositionEntries(draft.report).map(e=>[e.fieldPath,e.propositionHash])),seen=new Set();
 need(Array.isArray(frames)&&frames.length<=32,'Coleção de quadros excede o limite.');
 for(const frame of frames){need(keys(frame,['name','artifact'])&&text(frame.name,151)&&!byName.has(frame.name)&&artifactValid(frame.artifact,binding)&&frame.artifact.key.split('/').at(-1)===frame.name&&/\.(?:png|jpe?g)$/.test(frame.name),'Identidade do quadro inválida ou duplicada.');byName.set(frame.name,frame.artifact);}
 const entries=draft.entriesForIndependentApproval.map(entry=>{
  need(keys(entry,['fieldPath','verdict','reason','reviewedFrameNames','frameSampleSeconds'])&&knownField(draft.report,entry.fieldPath)&&!seen.has(entry.fieldPath),'Campo editorial desconhecido ou duplicado.');seen.add(entry.fieldPath);
  const checked=approval.entryReviews.find(e=>e.fieldPath===entry.fieldPath);
  need(checked?.decision==='approve'&&checked.verdict===entry.verdict&&text(checked.method,1000)&&text(checked.independentReason,4000)&&same(checked.exactReviewedValue,fieldValue(draft.report,entry.fieldPath)),'Parecer não corresponde ao valor integral do campo: '+entry.fieldPath);
  const {reviewedFrameNames,frameSampleSeconds}=entry,value={fieldPath:entry.fieldPath,verdict:checked.verdict,reason:checked.independentReason,method:checked.method};
  if(propositions.has(entry.fieldPath))value.propositionHash=propositions.get(entry.fieldPath);
  if(reviewedFrameNames!==undefined||frameSampleSeconds!==undefined){
   need(checked.pixelsReviewed===true&&Array.isArray(checked.reviewedFrames)&&same(reviewedFrameNames,checked.reviewedFrames.map(f=>f.name))&&same(frameSampleSeconds,checked.reviewedFrames.map(f=>f.timestampSeconds)),'Coleção completa de quadros do campo diverge.');
   value.visualPixelsReviewed=true;value.videoIdentity=binding.sourceManifest.video;value.sourceManifest=binding.sourceManifest;
   value.frameArtifacts=checked.reviewedFrames.map(frame=>{
    const artifact=byName.get(frame.name);need(same(frame.sourceVideo,binding.sourceManifest.video)&&artifact?.sha256===frame.sha256,'Quadro revisado ausente, alterado ou de outra geração do vídeo.');
    return {artifact,sampleSeconds:[frame.timestampSeconds]};
   });
  }else need(checked.pixelsReviewed!==true&&!list(checked.reviewedFrames).length,'Entrada editorial omitiu os pixels revistos.');
  return value;
 });
 return sealQualitySourceReview({record,originalReport:input.originalReport,executionId:binding.executionId,rawResponseIdentity:binding.rawResponseIdentity,originalCandidateIdentity:binding.originalCandidateIdentity,report:draft.report,entries,authorIdentity:draft.editorIdentity+'@'+draft.editorThreadId,reviewerIdentity:approval.run_id+'@'+approval.native_thread_id,reviewerExecutor:approval.executor,method:'Independent exact saved-text and selected-frame review; approval and every selected frame are individually pinned.',observedAt:approval.recorded_at,reviewEvidence:approvalArtifact,...(input.importEvidence?{importEvidence:input.importEvidence}:{})});
}
// This is the real authenticated import action, not an offline test or a model
// endpoint. The request may name only an immutable package in this execution.
export async function importQualitySourceReview({store,storage,packageIdentity,...input}={}){
 const binding=qualityReviewBinding(input),read=reviewArtifactReader(storage,binding);
 need(artifactValid(packageIdentity,binding)&&packageIdentity.key.endsWith('.json'),'Pacote editorial deve pertencer à execução.');
 const pkg=reviewJson(await read(packageIdentity));
 need(keys(pkg,['version','kind',...Object.keys(binding),'draftArtifact','approvalArtifact','frames'])&&pkg.version===1&&pkg.kind==='independent_source_review_import','Contrato do pacote editorial inválido.');
 for(const [key,value]of Object.entries(binding))need(same(pkg[key],value),'Pacote não corresponde à fonte original: '+key);
 need(artifactValid(pkg.draftArtifact,binding)&&artifactValid(pkg.approvalArtifact,binding)&&pkg.draftArtifact.key.endsWith('.json')&&pkg.approvalArtifact.key.endsWith('.json')&&Array.isArray(pkg.frames)&&pkg.frames.length<=32,'Referências editoriais obrigatórias ausentes.');
 const draft=reviewJson(await read(pkg.draftArtifact)),approval=reviewJson(await read(pkg.approvalArtifact));
 const sealed=sealApprovedEditorialReview({...input,draft,approval,draftArtifact:pkg.draftArtifact,approvalArtifact:pkg.approvalArtifact,frames:pkg.frames,importEvidence:{packageIdentity,draftArtifact:pkg.draftArtifact}});
 for(const frame of pkg.frames)await read(frame.artifact);
 const verified=verifyQualitySourceReview({...input,...sealed});
 const outcome=analysisReportOutcome(verified.report,input.record,{requireKnowledge:true,qualityGateV2:{mediaInspection:input.record.media_inspection_receipt,transcriptionReceipt:input.record.transcription_receipt,trustedReviews:verified.trustedReviews},contextCatalogSnapshot:input.contextCatalogSnapshot??null});
 need(outcome.report&&qualityCandidateHash(outcome.report)===qualityCandidateHash(verified.report),'Relatório revisado altera fontes salvas.');
 if(!outcome.accepted)throw Object.assign(Error('Parecer preservado em GCS; revisão não aceita pelo contrato de qualidade.'),{code:'QUALITY_REVIEW_NOT_ACCEPTED',status:409});
 const readiness=knowledgeReadiness(outcome.report);
 if(!readiness.accepted)throw Object.assign(Error('Prontidão final não aceita; nenhuma seleção de revisão criada.'),{code:readiness.reasons[0]??'QUALITY_REVIEW_NOT_ACCEPTED',status:409});
 // Do not select an inadmissible review permanently. Every accepted import is
 // create-only; a prior different selection is a conflict, never an overwrite.
 for(const data of [sealed.review,sealed.selection]){
  const path='reels_quality_receipts/'+data.id,created=await store.create(path,data),saved=created.created?created:await store.get(path);
  need(saved?.data&&same(saved.data,data),'Registro imutável da revisão já existe com conteúdo diferente.');
 }
 return loadQualitySourceReview({store,storage,...input,requestedReviewId:sealed.review.id});
}
