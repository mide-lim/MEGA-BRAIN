import {knowledgeSchema,reviewKnowledge} from './knowledge.mjs';
const ID = /^[A-Za-z0-9_-]{5,32}$/;
export const reportSchema = {
  type:'OBJECT',required:['title','summary','categories','useful_information','visual_observations','limitations','transcript_quality','knowledge'],
  properties:{
    knowledge:knowledgeSchema,
    title:{type:'STRING'},summary:{type:'STRING'},categories:{type:'ARRAY',items:{type:'STRING'}},
    useful_information:{type:'ARRAY',items:{type:'OBJECT',required:['claim','application','classification','evidence'],properties:{
      claim:{type:'STRING'},application:{type:'STRING'},classification:{type:'STRING',enum:['author_claim','visual_observation','interpretation']},
      evidence:{type:'ARRAY',items:{type:'OBJECT',required:['source','start_seconds','end_seconds','excerpt'],properties:{
        source:{type:'STRING',enum:['transcript','video']},start_seconds:{type:'NUMBER'},end_seconds:{type:'NUMBER'},excerpt:{type:'STRING'}
      }}}
    }}},
    visual_observations:{type:'ARRAY',items:{type:'STRING'}},limitations:{type:'ARRAY',items:{type:'STRING'}},
    transcript_quality:{type:'OBJECT',required:['assessment','uncertain_segments'],properties:{assessment:{type:'STRING'},uncertain_segments:{type:'ARRAY',items:{type:'STRING'}}}}
  }
};

export function buildAnalysisRequest({record,bucket,preset,model}) {
  if (!ID.test(record?.id ?? '')) throw new Error('Identificador inválido.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '')) throw new Error('Bucket inválido.');
  if (!Number.isFinite(record.duration_seconds) || record.duration_seconds <= 0) throw new Error('Duração verificada ausente.');
  if (!record.media_verified) throw new Error('A mídia precisa ser validada antes da análise.');
  if (!preset?.version || !preset.system_instruction || !preset.user_instruction) throw new Error('Preset incompleto.');
  const transcript=typeof record.transcript==='string'?record.transcript:'';
  if (transcript.length>100000) throw new Error('Transcrição excede o escopo do piloto.');
  return {
    systemInstruction:{parts:[{text:preset.system_instruction}]},
    contents:[{role:'user',parts:[
      {fileData:{mimeType:'video/mp4',fileUri:`gs://${bucket}/originals/instagram/${record.id}/video.mp4`}},
      {text:JSON.stringify({task:preset.user_instruction,preset_version:preset.version,video_id:record.id,duration_seconds:record.duration_seconds,transcript_raw:transcript,transcript_missing:!transcript.trim()})}
    ]}],
    generationConfig:{...(model==='gemini-3.5-flash-lite'?{thinkingConfig:{thinkingLevel:'MINIMAL'}}:{temperature:0.2}),maxOutputTokens:preset.version==='megabrain-video-text-v3'?8192:4096,responseMimeType:'application/json',responseSchema:reportSchema}
  };
}

const normalize=text=>text.normalize('NFC').replace(/\s+/g,' ').trim();
export function validateAnalysis(report,record) {
  const fail=message=>{throw new Error(message);};
  for(const field of ['title','summary']) if(typeof report?.[field]!=='string'||!report[field].trim())fail(`Campo obrigatório: ${field}.`);
  for(const field of ['categories','visual_observations','limitations']) if(!Array.isArray(report[field])||!report[field].every(v=>typeof v==='string'))fail(`Campo inválido: ${field}.`);
  if(!report.categories.length||report.categories.some(v=>!v.trim()))fail('Categorias vazias.');
  const quality=report.transcript_quality;
  if(!quality||typeof quality.assessment!=='string'||!Array.isArray(quality.uncertain_segments)||!quality.uncertain_segments.every(v=>typeof v==='string'))fail('Qualidade da transcrição ausente.');
  if(!Array.isArray(report.useful_information))fail('Informações úteis inválidas.');
  const transcript=normalize(record.transcript??'');
  for(const item of report.useful_information){
    if(typeof item.claim!=='string'||!item.claim.trim()||typeof item.application!=='string'||!['author_claim','visual_observation','interpretation'].includes(item.classification))fail('Informação útil inválida.');
    if(!Array.isArray(item.evidence)||!item.evidence.length)fail('Informação útil sem evidência.');
    for(const e of item.evidence){
      if(!['transcript','video'].includes(e.source)||typeof e.excerpt!=='string'||!e.excerpt.trim())fail('Evidência inválida.');
      if(!Number.isFinite(e.start_seconds)||!Number.isFinite(e.end_seconds)||e.start_seconds<0||e.end_seconds<e.start_seconds||e.end_seconds>record.duration_seconds)fail('Evidência fora da duração do vídeo.');
      if(e.source==='transcript'&&(!transcript||!transcript.includes(normalize(e.excerpt))))fail('Citação não consta na transcrição original.');
    }
  }
  return report;
}

// Keep the original model response intact. An unsupported useful-information
// item is omitted from the published report, never rewritten into a quotation.
export function reviewAnalysis(report,record) {
  validateAnalysis({...report,useful_information:[]},record);
  if(!Array.isArray(report.useful_information))throw new Error('Informações úteis inválidas.');
  const accepted=[],rejected=[];
  for(const [index,item] of report.useful_information.entries()){
    try{validateAnalysis({...report,useful_information:[item]},record);accepted.push(item);}
    catch{rejected.push(index);}
  }
  const reviewed={...report,useful_information:accepted,limitations:[...report.limitations]};
  if(!normalize(record.transcript??'')){
    reviewed.transcript_quality={assessment:'O STT não retornou texto reconhecido; não há transcrição para avaliar. Isso não comprova ausência de fala no vídeo.',uncertain_segments:[]};
    const limitation='Transcrição vazia: resumo e categorias dependem da análise do vídeo; não há evidência textual do STT.';
    if(!reviewed.limitations.includes(limitation))reviewed.limitations.push(limitation);
  }
  if(report.knowledge!==undefined){
    const result=reviewKnowledge(report.knowledge,record);reviewed.knowledge=result.knowledge;
    if(result.omitted)reviewed.limitations.push(`${result.omitted} campo(s) ou palavra(s)-chave omitido(s) por evidência inválida. O resultado original foi preservado.`);
  }
  if(rejected.length)reviewed.limitations.push(`${rejected.length} informação(ões) útil(eis) omitida(s): evidência inválida ou citação não literal na transcrição. A resposta original foi preservada para revisão.`);
  return validateAnalysis(reviewed,record);
}
