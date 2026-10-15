// Read-only presentation. Fixed messages only: financial status, saved references
// and visible artifacts never authorize a retry or establish worker termination.
const stages={upload:'Aquisição',transcription:'Transcrição',analysis:'Análise',unknown:'Etapa não confirmada'};
export function processingIndicator(video={},progress=null,{paused=false,stale=false}={}){
 const p=!stale&&progress&&Object.hasOwn(stages,progress.stage)&&['reserved','started','completed','cancelled','uncertain'].includes(progress.status)?progress:null;
 const knowledge=video.analysis?.knowledge;
 const malformedKnowledge=!!knowledge&&(!Array.isArray(knowledge.fields)||!Array.isArray(knowledge.keywords)||!Array.isArray(knowledge.missing_information)||knowledge.fields.some(f=>!f||typeof f.name!=='string'||typeof f.value!=='string'||!Array.isArray(f.evidence)));
 const emptyKnowledge=!!knowledge&&(malformedKnowledge||knowledge.fields.length===0);
 const candidate=!!video.analysis_candidate||!!video.candidate_analysis_key||video.analysis_quality_status==='review_required';
 const published=!!video.analysis;
 const attention=video.status==='needs_attention'||emptyKnowledge||candidate||p?.status==='uncertain';
 const inferred=video.media_verified!==true?'upload':typeof video.transcript==='string'&&video.transcript.trim()||video.transcript_status==='no_speech_recognized'?'analysis':'transcription';
 const stage=p?.stage??(published||candidate?'analysis':inferred);
 const out=(code,reason,action,unknown='',at=stage)=>({code,stage:at,stage_label:stages[at],reason,action,unknown,attention,retry_available:false});
 const endUnknown='O encerramento da execução não foi conferido nesta tela. Uma reserva ou resposta salva não comprova o término.';
 if(p?.status==='started')return out('active','A etapa está registrada como iniciada.','Aguardar a operação; não repetir o processamento.',endUnknown);
 if(p?.status==='reserved'&&video.status==='needs_attention')return out('blocked_unsubmitted','A etapa foi bloqueada; a submissão não está confirmada.','Conferir o bloqueio e a reserva; não reenviar.',endUnknown);
 if(p?.status==='reserved')return out('reserved','Há uma reserva; a submissão ainda não está confirmada.',paused?'Aguardar a retomada autorizada; não reenviar.':'Aguardar o início da etapa; não reenviar.',endUnknown);
 if(candidate)return out('candidate','Uma nova resposta está retida para conferência.','Conferir o candidato e preservar a análise publicada; não gerar outra resposta.',endUnknown,'analysis');
 if(emptyKnowledge)return out('knowledge_review',malformedKnowledge?'A estrutura de conhecimento está incompleta.':'A análise publicada tem os campos de conhecimento vazios.','Conferir a extração preservada; não solicitar nova análise paga.','A causa dos campos ausentes não foi confirmada. A análise publicada permanece disponível.','analysis');
 if(published&&video.status==='analyzed'&&p?.status!=='uncertain')return out('accepted','Há uma análise publicada disponível.','Consultar a análise preservada; nenhuma nova análise é necessária.','','analysis');
 if(video.analysis_key&&!published)return out('saved_response','Há uma referência de resposta salva.','Conferir a resposta e comprovar o encerramento antes de reconciliar, sem nova inferência.',endUnknown+' A existência e o conteúdo do objeto ainda precisam de conferência.','analysis');
 if(p?.reason_code==='schema_rejected')return out('schema_rejected','Foi registrada uma rejeição de esquema na análise.','Conferir o diagnóstico e os dados preservados; manter bloqueado, sem nova inferência.',endUnknown,'analysis');
 if(p?.reason_code==='source_metadata_failed')return out('source_metadata_failed','Foi registrada uma falha na obtenção de metadados da origem.','Conferir a fonte e o diagnóstico; manter bloqueado.','A causa atual e o encerramento não estão confirmados. Isso não comprova que o Reel seja privado ou tenha sido excluído.','upload');
 if(attention||p?.status==='cancelled'){
  if(stage==='upload')return out('acquisition_unconfirmed','O download ou preparo do vídeo não foi confirmado.','Conferir a fonte e o diagnóstico; manter bloqueado.','A causa exata e o encerramento não estão confirmados. Isso não comprova que o Reel seja privado ou tenha sido excluído.');
  if(stage==='transcription')return out('transcription_unconfirmed','A transcrição não foi confirmada.','Conferir a operação e o texto já salvo; manter bloqueado.',endUnknown);
  return out('analysis_unconfirmed','O resultado da análise não está confirmado.','Conferir a operação e eventuais respostas salvas; manter bloqueado, sem nova inferência.',endUnknown);
 }
 if(p?.status==='completed'&&p.stage==='analysis'&&!published)return out('analysis_unconfirmed','O registro financeiro terminou, mas não há análise publicada confirmada.','Conferir os dados e eventuais respostas salvas; não repetir a análise.',endUnknown);
 if(video.status==='transcribed'||video.transcript_status==='no_speech_recognized')return out('awaiting_analysis','A transcrição está registrada; a análise ainda não foi confirmada.','Aguardar a etapa de análise conforme os controles existentes.',stale?'Os dados de andamento estão desatualizados.':'','analysis');
 if(video.status==='downloaded')return out('awaiting_transcription','O vídeo está registrado como baixado; a transcrição ainda não foi confirmada.','Aguardar a transcrição conforme os controles existentes.',stale?'Os dados de andamento estão desatualizados.':'','transcription');
 return out('queued',paused?'O processamento de novos itens está pausado.':'O item está cadastrado para processamento.','Aguardar os controles da fila; não reenviar.',stale?'Os dados de andamento estão desatualizados.':'A submissão e o encerramento não foram conferidos.','upload');
}
