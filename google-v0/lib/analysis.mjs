import {consolidatePublication,preservePublicationSourcesV2} from './analysis-publication.mjs';
import {categoryIds,categoryOptions,taxonomyVersion,validateCategoryIds,normalizedCategoryIds,categorySelectionSchema,genericCategoryIds} from './category-taxonomy.mjs';
import {knowledgeSchema,reviewKnowledge} from './knowledge.mjs';
import {qualitySourceManifest,evaluateQualityGateV2,qualityCategoryOptions} from './reels-quality-gate.mjs';
import {taxonomySignalsSchema,taxonomySignalsInstruction,qualityEvidenceV2Schema,contextualSignalsSchema,qualityGateV2Instruction,sourceAnchoredEvidenceContract,normalizeSourceAnchoredReport,sourceAnchorsInstruction,visualObservationsContract,visualObservationsInstruction} from './reels-analysis-contract.mjs';
const ID = /^[A-Za-z0-9_-]{5,32}$/;
export const reportSchema = {
  type:'OBJECT',required:['title','summary','categories','useful_information','visual_observations','limitations','transcript_quality','knowledge'],
  properties:{
    knowledge:knowledgeSchema,
    title:{type:'STRING'},summary:{type:'STRING'},categories:categorySelectionSchema(),
    useful_information:{type:'ARRAY',items:{type:'OBJECT',required:['claim','application','classification','evidence'],properties:{
      claim:{type:'STRING'},application:{type:'STRING'},classification:{type:'STRING',enum:['author_claim','visual_observation','interpretation']},
      evidence:{type:'ARRAY',items:{type:'OBJECT',required:['source','start_seconds','end_seconds','excerpt'],properties:{
        source:{type:'STRING',enum:['transcript','video','caption']},start_seconds:{type:'NUMBER'},end_seconds:{type:'NUMBER'},excerpt:{type:'STRING'}
      }}}
    }}},
    visual_observations:{type:'ARRAY',items:{type:'STRING'}},limitations:{type:'ARRAY',items:{type:'STRING'}},
    transcript_quality:{type:'OBJECT',required:['assessment','uncertain_segments'],properties:{assessment:{type:'STRING'},uncertain_segments:{type:'ARRAY',items:{type:'STRING'}}}}
  }
};

// Vertex responseSchema requires anyOf to stand alone at its schema node.
// Check the generated contract locally before a provider request is submitted.
export function validateProviderResponseSchema(schema){
  if(!schema||typeof schema!=='object'||Array.isArray(schema))throw new Error('Schema de resposta inválido.');
  if(Object.hasOwn(schema,'anyOf')){
    if(Object.keys(schema).length!==1||!Array.isArray(schema.anyOf)||!schema.anyOf.length)throw new Error('anyOf deve ser o único campo do nó de schema.');
    for(const branch of schema.anyOf)validateProviderResponseSchema(branch);
  }
  if(schema.items)validateProviderResponseSchema(schema.items);
  for(const child of Object.values(schema.properties??{}))validateProviderResponseSchema(child);
}

export const analysisCategoryOptions=qualityCategoryOptions;

export function buildAnalysisRequest({record,bucket,preset,model,taxonomySignalsEnabled=false,qualityGateV2Enabled=false,contextCatalogSnapshot=null}) {
  if (!ID.test(record?.id ?? '')) throw new Error('Identificador inválido.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '')) throw new Error('Bucket inválido.');
  if (!Number.isFinite(record.duration_seconds) || record.duration_seconds <= 0) throw new Error('Duração verificada ausente.');
  if (!record.media_verified) throw new Error('A mídia precisa ser validada antes da análise.');
  if (!preset?.version || !preset.system_instruction || !preset.user_instruction) throw new Error('Preset incompleto.');
  const transcript=typeof record.transcript==='string'?record.transcript:'';
  if (transcript.length>100000) throw new Error('Transcrição excede o escopo do piloto.');
  const caption=record.source_caption?.text??'';
  if(typeof caption!=='string'||caption.length>50000)throw new Error('Legenda fora do limite.');
  const options=qualityGateV2Enabled?analysisCategoryOptions(contextCatalogSnapshot):categoryOptions(),additionalIds=options.filter(c=>!categoryIds.includes(c.id)).map(c=>c.id);
  let schema=taxonomySignalsEnabled?{...reportSchema,properties:{...reportSchema.properties,taxonomySignals:taxonomySignalsSchema}}:reportSchema,anchors=null;
  if(qualityGateV2Enabled){
   schema=structuredClone(schema);schema.properties.categories=categorySelectionSchema(additionalIds);
   anchors=sourceAnchoredEvidenceContract(record,qualitySourceManifest(record));
   schema.properties.qualityEvidenceV2=structuredClone(qualityEvidenceV2Schema);schema.properties.contextualSignals=structuredClone(contextualSignalsSchema);
   schema.properties.evidence_contract={type:'STRING',enum:[anchors.version]};schema.properties.evidence_anchor_hash={type:'STRING',enum:[anchors.hash]};
   schema.required=[...schema.required,'qualityEvidenceV2','evidence_contract','evidence_anchor_hash','visual_observations_contract'];
   schema.properties.visual_observations_contract={type:'STRING',enum:[visualObservationsContract]};
   const visualEvidence=structuredClone(anchors.evidence);visualEvidence.minItems=1;
   const visualItem=visualEvidence.items;
   visualItem.properties.source.enum=['video'];
   visualItem.properties.sourceIdentity={type:'OBJECT',required:['key','generation'],properties:{key:{type:'STRING'},generation:{type:'STRING'}}};
   for(const key of ['start_ref','end_ref'])visualItem.properties[key].enum=anchors.anchors.map(a=>a.ref);
   schema.properties.visual_observations={type:'ARRAY',items:{type:'OBJECT',required:['observation','evidence'],properties:{observation:{type:'STRING'},evidence:visualEvidence}}};
   delete schema.properties.qualityEvidenceV2.properties.visualObservations;
   schema.properties.qualityEvidenceV2.required=schema.properties.qualityEvidenceV2.required.filter(k=>k!=='visualObservations');
   for(const key of ['title','summary'])schema.properties.qualityEvidenceV2.properties[key]=structuredClone(anchors.evidence);
   for(const key of ['applications'])schema.properties.qualityEvidenceV2.properties[key].items.properties.evidence=structuredClone(anchors.evidence);
   schema.properties.useful_information.items.properties.evidence=structuredClone(anchors.factualEvidence);
   schema.properties.knowledge.properties.fields.items.properties.evidence=structuredClone(anchors.factualEvidence);
   schema.properties.knowledge.properties.keywords.items.properties.evidence=structuredClone(anchors.factualEvidence);
   schema.properties.contextualSignals.properties.evidence=anchors.contextual;
   if(taxonomySignalsEnabled){
    const transcript=anchors.factualEvidence.items.properties?.source.enum.includes('transcript');
    const units=schema.properties.taxonomySignals.properties.units;
    units.items.properties.evidence=transcript?structuredClone(anchors.factualEvidence):{type:'ARRAY',maxItems:0,items:{type:'STRING'}};
    if(transcript){const item=units.items.properties.evidence.items;item.properties.source.enum=['transcript'];item.properties.sourceIdentity={type:'OBJECT',required:['key','generation'],properties:{key:{type:'STRING'},generation:{type:'STRING'}}};item.required=[...new Set([...item.required,'start_ref','end_ref'])];}
    else delete schema.properties.taxonomySignals;
   }
   if(contextCatalogSnapshot!==null&&(typeof contextCatalogSnapshot!=='object'||Array.isArray(contextCatalogSnapshot)||JSON.stringify(contextCatalogSnapshot).length>30000))throw Error('Catálogo contextual fora do limite.');
  }
  validateProviderResponseSchema(schema);
  const request={
    systemInstruction:{parts:[{text:preset.system_instruction+' Em categories escolha somente IDs de category_options, conforme o conteúdo. Avalie conjuntamente a finalidade desenvolvida no vídeo, transcript_raw e caption_raw quando disponíveis; uma palavra isolada ou um objeto citado não determina o destino. O primeiro ID deve ser o destino principal: a finalidade do vídeo, não cada objeto citado. Respeite o scope de cada opção. Prefira uma categoria. Inclua no máximo uma segunda apenas se houver outro assunto desenvolvido de forma substancial e independente; menções, ingredientes, setor da marca e ferramentas usadas ficam nas palavras-chave. Tecnologia geral e a-organizar devem ser usados sozinhos. Se nenhuma servir, use a-organizar. Assuntos específicos ficam em knowledge.keywords com evidências; não crie categorias. A taxonomia não confirma alegações do autor.'}]},
    contents:[{role:'user',parts:[
      {fileData:{mimeType:'video/mp4',fileUri:`gs://${bucket}/originals/instagram/${record.id}/video.mp4`},...(preset.version==='megabrain-video-text-v4'?{videoMetadata:{fps:2}}:{})},
      {text:JSON.stringify({task:preset.user_instruction,category_options:options,category_taxonomy_version:taxonomyVersion,preset_version:preset.version,video_id:record.id,duration_seconds:record.duration_seconds,transcript_raw:transcript,...(qualityGateV2Enabled?{quality_policy_version:'gate_v2',source_manifest:qualitySourceManifest(record),evidence_contract:anchors.version,evidence_anchor_hash:anchors.hash,visual_observations_contract:visualObservationsContract,source_time_anchors:anchors.anchors,context_catalog_snapshot:contextCatalogSnapshot}:{}),transcript_missing:!transcript.trim(),...((taxonomySignalsEnabled||qualityGateV2Enabled)?{transcript_words:Array.isArray(record.transcript_words)?record.transcript_words:[],transcript_segments:Array.isArray(record.transcript_segments)?record.transcript_segments:[]}:{}),caption_raw:caption,caption_capture_id:record.source_caption?.capture_id??null,caption_missing:!caption.trim(),source_url:record.source_url})}
    ]}],
    generationConfig:{...(model==='gemini-3.5-flash-lite'?{thinkingConfig:{thinkingLevel:'MINIMAL'}}:{temperature:0.2}),maxOutputTokens:8192,responseMimeType:'application/json',responseSchema:schema}
  };
  if(taxonomySignalsEnabled&&schema.properties.taxonomySignals)request.systemInstruction.parts[0].text+=taxonomySignalsInstruction;
  if(qualityGateV2Enabled&&!anchors.hasTimedTranscript)request.systemInstruction.parts[0].text+=' A transcrição salva não tem alinhamento temporal: omita taxonomySignals. Não substitua evidência de transcrição indisponível por vídeo nem invente intervalos; preserve somente itens sustentados por outra fonte identificada e registre a lacuna.';
  if(qualityGateV2Enabled)request.systemInstruction.parts[0].text+=qualityGateV2Instruction+sourceAnchorsInstruction+visualObservationsInstruction;
  return request;
}

const normalize=text=>text.normalize('NFC').replace(/\s+/g,' ').replace(/([\p{Script=Han}\d])\s+(?=[\p{Script=Han}\d])/gu,'$1').trim();
export function validateAnalysis(report,record,{requireCategoryIds=false,additionalCategoryIds=[]}={}) {
  const fail=message=>{throw new Error(message);};
  for(const field of ['title','summary']) if(typeof report?.[field]!=='string'||!report[field].trim())fail(`Campo obrigatório: ${field}.`);
  for(const field of ['categories','visual_observations','limitations']) if(!Array.isArray(report[field])||!report[field].every(v=>typeof v==='string'))fail(`Campo inválido: ${field}.`);
  if(!report.categories.length||report.categories.some(v=>!v.trim()))fail('Categorias vazias.');
  if(requireCategoryIds)validateCategoryIds(report.categories,{additionalIds:additionalCategoryIds});
  const quality=report.transcript_quality;
  if(!quality||typeof quality.assessment!=='string'||!Array.isArray(quality.uncertain_segments)||!quality.uncertain_segments.every(v=>typeof v==='string'))fail('Qualidade da transcrição ausente.');
  if(!Array.isArray(report.useful_information))fail('Informações úteis inválidas.');
  const transcript=normalize(record.transcript??'');
  for(const item of report.useful_information){
    if(typeof item.claim!=='string'||!item.claim.trim()||typeof item.application!=='string'||!['author_claim','visual_observation','interpretation'].includes(item.classification))fail('Informação útil inválida.');
    if(!Array.isArray(item.evidence)||!item.evidence.length)fail('Informação útil sem evidência.');
    for(const e of item.evidence){
      if(e.source==='caption'){if(typeof e.excerpt!=='string'||!e.excerpt.trim()||!record.source_caption?.capture_id||!normalize(record.source_caption.text??'').includes(normalize(e.excerpt)))fail('Citação não consta na legenda capturada.');continue;}
      if(!['transcript','video'].includes(e.source)||typeof e.excerpt!=='string'||!e.excerpt.trim())fail('Evidência inválida.');
      if(!Number.isFinite(e.start_seconds)||!Number.isFinite(e.end_seconds)||e.start_seconds<0||e.end_seconds<e.start_seconds||e.end_seconds>record.duration_seconds)fail('Evidência fora da duração do vídeo.');
      if(e.source==='transcript'&&(!transcript||!transcript.includes(normalize(e.excerpt))))fail('Citação não consta na transcrição original.');
    }
  }
  return report;
}

// Keep the original model response intact. An unsupported useful-information
// item is omitted from the published report, never rewritten into a quotation.
export function reviewAnalysis(report,record,{requireCategoryIds=false,sourceGroundedPublication=false}={}) {
  if(sourceGroundedPublication&&(!Number.isFinite(record.duration_seconds)||record.duration_seconds<=0))throw Error('Duração verificada obrigatória para consolidar fontes salvas.');
  validateAnalysis({...report,useful_information:[]},record,{requireCategoryIds});
  if(!Array.isArray(report.useful_information))throw new Error('Informações úteis inválidas.');
  const accepted=[],rejected=[];
  for(const [index,item] of report.useful_information.entries()){
    try{validateAnalysis({...report,useful_information:[item]},record,{requireCategoryIds});accepted.push(item);}
    catch{rejected.push(index);}
  }
  const reviewed={...report,useful_information:accepted,limitations:[...report.limitations]};
  if(requireCategoryIds)reviewed.category_taxonomy_version=taxonomyVersion;
  if(!normalize(record.transcript??'')){
    reviewed.transcript_quality={assessment:'O STT não retornou texto reconhecido; não há transcrição para avaliar. Isso não comprova ausência de fala no vídeo.',uncertain_segments:[]};
    const limitation='Transcrição vazia: resumo e categorias dependem da análise do vídeo; não há evidência textual do STT.';
    if(!reviewed.limitations.includes(limitation))reviewed.limitations.push(limitation);
  }
  reviewed.source_coverage={video:true,transcript:!!normalize(record.transcript??''),caption:!!record.source_caption?.text,caption_capture_id:record.source_caption?.capture_id??null};
  if(!reviewed.source_coverage.caption){const warning='Legenda do post indisponível nesta revisão: a cobertura textual do Instagram está incompleta.';if(!reviewed.limitations.includes(warning))reviewed.limitations.push(warning);}
  if(report.knowledge!==undefined){
    const result=reviewKnowledge(report.knowledge,record);reviewed.knowledge=result.knowledge;
    if(result.omitted)reviewed.limitations.push(`${result.omitted} campo(s) ou palavra(s)-chave omitido(s) por evidência inválida. O resultado original foi preservado.`);
  }
  if(rejected.length)reviewed.limitations.push(`${rejected.length} informação(ões) útil(eis) omitida(s): evidência inválida ou citação não literal na transcrição. A resposta original foi preservada para revisão.`);
  return validateAnalysis(sourceGroundedPublication?consolidatePublication(reviewed,record,report):reviewed,record,{requireCategoryIds});
}

export function analysisPublication(report,record){
 const empty=report.knowledge?.fields?.length===0;
 const keepPrevious=empty&&(record.analysis?.knowledge?.fields?.length??0)>0;
 return {accepted:!keepPrevious,reason:keepPrevious?'A nova revisão não produziu campos sustentados; a revisão anterior foi preservada.':null};
}

// Only evaluates a response already received. Storage and provider failures are
// deliberately outside this boundary and must retain operational uncertainty.
export function analysisOutcome(response,record,{requireKnowledge=false,sourceGroundedPublication=false,qualityGateV2=null,contextCatalogSnapshot=null}={}){
 const candidate=response?.candidates?.[0];
 if(candidate?.finishReason!=='STOP')return {accepted:false,reasons:['incomplete_response']};
 let parsed;
 try{parsed=JSON.parse((candidate.content?.parts??[]).filter(p=>p.thought!==true).map(p=>p.text??'').join(''));}
 catch{return {accepted:false,reasons:['invalid_json']};}
 if(qualityGateV2!==null){try{parsed=normalizeSourceAnchoredReport(parsed,record,qualitySourceManifest(record));}catch(error){return {accepted:false,reasons:['invalid_evidence_transport'],...(error.code==='EVIDENCE_ENTRY_INVALID'&&error.transportSection==='taxonomySignals.units'?{transportDiagnostic:{code:'EVIDENCE_ENTRY_INVALID',section:'taxonomySignals.units'}}:{})};}}
 return analysisReportOutcome(parsed,record,{requireKnowledge,sourceGroundedPublication,qualityGateV2,contextCatalogSnapshot});
}

// Reviews contain the stored, normalized report contract. Never wrap one in a
// pretend provider response or normalize its saved numeric references again.
export function analysisReportOutcome(parsed,record,{requireKnowledge=false,sourceGroundedPublication=false,qualityGateV2=null,contextCatalogSnapshot=null}={}){
 const additionalCategoryIds=qualityGateV2!==null?analysisCategoryOptions(contextCatalogSnapshot).filter(c=>!categoryIds.includes(c.id)).map(c=>c.id):[];
 const categories=normalizedCategoryIds(parsed?.categories);
 if(qualityGateV2===null&&categories!==parsed?.categories)parsed={...parsed,categories,limitations:Array.isArray(parsed.limitations)?[...parsed.limitations,'Categoria geral de tecnologia redundante omitida; a resposta original foi preservada.']:parsed.limitations};
 try{validateCategoryIds(parsed?.categories,{additionalIds:additionalCategoryIds});}
 catch{return {accepted:false,reasons:['invalid_categories']};}
 let report;
 try{if(qualityGateV2!==null){validateAnalysis(parsed,record,{requireCategoryIds:true,additionalCategoryIds});report=preservePublicationSourcesV2(parsed,record);}else report=reviewAnalysis(parsed,record,{requireCategoryIds:true,sourceGroundedPublication});}
 catch{return {accepted:false,reasons:['invalid_report']};}
 if(requireKnowledge&&!report.knowledge)return {accepted:false,reasons:['missing_knowledge']};
 const publication=analysisPublication(report,record);
 if(qualityGateV2!==null){
  const quality=evaluateQualityGateV2({...qualityGateV2,record,report,contextCatalogSnapshot});
  return {accepted:publication.accepted&&quality.accepted,report,quality,reasons:!publication.accepted?['unsupported_revision']:quality.accepted?[]:['quality_gate_v2_not_accepted']};
 }
 return {accepted:publication.accepted,report,reasons:publication.accepted?[]:['unsupported_revision']};
}

// Operator-selected correction of a received response, not a new model call.
// This returns a proposal and provenance; it never publishes or resumes work.
export function reviewSavedCategorySelection(response,record,{categories,reason,requireKnowledge=true}={}){
 if(typeof reason!=='string'||reason.trim().length<20||reason.length>1000)throw Error('Justificativa explícita da seleção obrigatória.');
 const candidate=response?.candidates?.[0];
 if(candidate?.finishReason!=='STOP')throw Error('Resposta original incompleta; correção de categorias não permitida.');
 let original;
 try{original=JSON.parse((candidate.content?.parts??[]).filter(p=>p.thought!==true).map(p=>p.text??'').join(''));}catch{throw Error('JSON original inválido.');}
 const ids=original?.categories;
 if(!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2||ids.some(id=>!categoryIds.includes(id))||!ids.some(id=>genericCategoryIds.includes(id))||ids.every(id=>genericCategoryIds.includes(id)))throw Error('Correção restrita ao conflito entre categoria geral e específica oficiais.');
 const prior=analysisOutcome(response,record,{requireKnowledge});
 if(prior.accepted||!prior.reasons.includes('invalid_categories'))throw Error('Resposta não exige esta correção de categorias.');
 validateCategoryIds(categories);
 if(categories.some(id=>!ids.includes(id)))throw Error('Selecionar somente categorias já propostas; não inventar destino.');
 if(!Array.isArray(original.limitations))throw Error('Relatório original inválido.');
 const revised={...original,categories:[...categories],limitations:[...original.limitations,'Seleção de categoria revisada a partir da resposta salva: '+reason.trim()+(/[.!?]$/.test(reason.trim())?' ':'. ')+'A resposta original foi preservada.']};
 const proposal={candidates:[{...candidate,content:{...candidate.content,parts:[{text:JSON.stringify(revised)}]}}]};
 const outcome=analysisOutcome(proposal,record,{requireKnowledge});
 return {...outcome,category_review:{original_categories:[...ids],selected_categories:[...categories],reason:reason.trim(),inference_replayed:false,publication_performed:false}};
}
