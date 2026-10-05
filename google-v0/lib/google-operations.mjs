import {inspectMedia} from './media-inspector.mjs';
import {buildAnalysisRequest,reviewAnalysis,analysisPublication} from './analysis.mjs';

// Only WorkerFlow may call these adapters after claiming and starting a
// financial reservation. The injected gate independently verifies that claim.
export function googleOperations({api,storage,tools,preset,config,gate,inspect=inspectMedia}){
  if(api.project!=='megabrain-v0-1017370021431'||storage.bucket!==`${api.project}-media`)throw new Error('Adaptadores fora do projeto v0.');
  if(typeof gate!=='function')throw new Error('Verificação da reserva obrigatória.');
  async function admitted(id,stage,videoId){
    if(config?.enabled!==true||config.uploads_enabled!==true)throw new Error('Operações Google desligadas.');
    const reservation=await gate({executionId:id,stage,videoId});
    if(reservation?.maximum_cents!==budget(stage))throw new Error('Estimativa diverge da reserva iniciada.');
  }
  const result=(id,stage,changes,cost)=>({video_id:id,stage,changes,actual_cents:cost});
  const budget=stage=>{const n=config?.quotes?.[stage];if(!Number.isSafeInteger(n)||n<1)throw new Error('Estimativa obrigatória.');return n;};
  const at=async(step,action)=>{try{return await action();}catch(error){error.operation_step=step;throw error;}};
  const submitSTT=(url,options)=>at('submit_stt',()=>api.request(url,options));
  const persist=(key,data)=>storage.writeImmutable(key,Buffer.from(JSON.stringify(data)),{contentType:'application/json',uploadsEnabled:true});
  async function captionFor(video,executionId){
    if(video.source_caption?.text)return {source_caption:video.source_caption,caption_status:'captured'};
    if(typeof tools.captureCaption!=='function')return {caption_status:'unavailable'};
    try{
      const capture=await tools.captureCaption(video);
      await persist(`results/instagram/${video.id}/${executionId}/caption.json`,capture);
      return {source_caption:capture,caption_status:'captured'};
    }catch{return {caption_status:'unavailable'};}
  }
  function speechSettings(){
    if(!/^[a-z0-9_-]+$/.test(config.speech_model??'')||!['global','us'].includes(config.speech_location)||!Array.isArray(config.language_codes)||!config.language_codes.length||config.language_codes.length>3||config.language_codes.some(c=>!/^\w{2,3}-[A-Z]{2}$/.test(c))||(config.speech_model==='chirp_3'&&config.speech_location!=='us'))throw new Error('Modelo, idiomas e região STT precisam ser configurados.');
  }
  const speechOrigin=()=>config.speech_location==='us'?'https://us-speech.googleapis.com':'https://speech.googleapis.com';
  return {
    async prepareAnalysis({video,executionId}){await at('reserve_result',()=>storage.reserveResult?.(`results/instagram/${video.id}/${executionId}/analysis.json`));if(!video.source_caption?.text)await storage.reserveResult?.(`results/instagram/${video.id}/${executionId}/caption.json`);},
    async upload({video,executionId}){
      await admitted(executionId,'upload',video.id);const cost=budget('upload');
      const bytes=await tools.download(video),media=await inspect(bytes);
      if(media.audio_status!=='present')throw new Error('Áudio ausente ou silencioso; transcrição não iniciada.');
      const key=`originals/instagram/${video.id}/video.mp4`;
      const object=await storage.writeImmutable(key,bytes,{contentType:'video/mp4',uploadsEnabled:true});
      return result(video.id,'upload',{video_key:key,video_generation:object.generation,video_bytes:object.size,media_verified:true,audio_status:media.audio_status,duration_seconds:media.duration_seconds},cost);
    },
    async transcription({video,executionId}){
      await admitted(executionId,'transcription',video.id);budget('transcription');speechSettings();
      const key=`originals/instagram/${video.id}/video.mp4`;
      if(video.video_key!==key||!/^\d+$/.test(video.video_generation??'')||video.media_verified!==true||video.audio_status!=='present')throw new Error('Mídia verificada obrigatória.');
      const bytes=await at('read_media',()=>storage.read(key,{generation:video.video_generation})),audio=await at('extract_audio',()=>tools.extractAudio(bytes));
      const audioKey=`results/instagram/${video.id}/${executionId}/audio.flac`;
      await at('persist_audio',()=>storage.writeImmutable(audioKey,audio,{contentType:'audio/flac',uploadsEnabled:true}));
      // Chirp 3 supports synchronous Recognize for audio below one minute.
      // Select before submission; never fall back by repeating a paid request.
      if(config.synchronous_short_audio===true&&config.speech_model==='chirp_3'&&Number.isFinite(video.duration_seconds)&&video.duration_seconds>0&&video.duration_seconds<=55&&audio.length<=7000000){
        const response=await submitSTT(`${speechOrigin()}/v2/projects/${api.project}/locations/${config.speech_location}/recognizers/_:recognize`,{method:'POST',json:{config:{autoDecodingConfig:{},model:config.speech_model,languageCodes:config.language_codes,features:{enableAutomaticPunctuation:true,enableWordTimeOffsets:true}},content:audio.toString('base64')},timeoutMs:120000});
        const text=(response.results??[]).map(r=>r.alternatives?.[0]?.transcript??'').join('\n').trim();
        const key=`results/instagram/${video.id}/${executionId}/transcription.json`;
        const object=await persist(key,{mode:'synchronous',model:config.speech_model,text,raw:response});
        return result(video.id,'transcription',{transcript:text,transcript_status:text?'recognized':'no_speech_recognized',transcript_key:key,transcript_generation:object.generation},budget('transcription'));
      }
      const operation=await submitSTT(`${speechOrigin()}/v2/projects/${api.project}/locations/${config.speech_location}/recognizers/_:batchRecognize`,{method:'POST',json:{config:{autoDecodingConfig:{},model:config.speech_model,languageCodes:config.language_codes,features:{enableAutomaticPunctuation:true,enableWordTimeOffsets:true}},files:[{uri:`gs://${storage.bucket}/${audioKey}`}],recognitionOutputConfig:{inlineResponseConfig:{}}},timeoutMs:120000});
      if(!operation?.name)throw new Error('STT não confirmou identificador.');
      return {video_id:video.id,stage:'transcription',operation_name:operation.name};
    },
    async pollTranscription({operationName,videoId,executionId}){
      await admitted(executionId,'transcription',videoId);
      speechSettings();
      if(!['megabrain-v0-1017370021431','711042421394'].some(owner=>operationName.startsWith(`projects/${owner}/locations/${config.speech_location}/operations/`))||!/^projects\/[a-z0-9-]+\/locations\/(?:global|us)\/operations\/[A-Za-z0-9_-]+$/.test(operationName))throw new Error('Operação STT fora do escopo.');
      const operation=await api.request(`${speechOrigin()}/v2/${operationName}`);
      if(operation.done!==true)return {video_id:videoId,stage:'transcription',pending:true};
      if(operation.error)throw new Error('STT informou falha.');
      const audioUri=`gs://${storage.bucket}/results/instagram/${videoId}/${executionId}/audio.flac`;
      const file=operation.response?.results?.[audioUri];
      if(!file||file.error)throw new Error('STT não retornou o arquivo esperado.');
      const transcript=file.inlineResult?.transcript??file.transcript;
      const text=(transcript?.results??[]).map(r=>r.alternatives?.[0]?.transcript??'').join('\n').trim();
      // Preserve raw results, including timing and uncertainty, even if no speech.
      const key=`results/instagram/${videoId}/${executionId}/transcription.json`;
      const object=await persist(key,{operation_name:operationName,model:config.speech_model,text,raw:operation.response});
      return result(videoId,'transcription',{transcript:text,transcript_status:text?'recognized':'no_speech_recognized',transcript_key:key,transcript_generation:object.generation},budget('transcription'));
    },
    async analysis({video,executionId}){
      await admitted(executionId,'analysis',video.id);const cost=budget('analysis');
      if(!/^gemini-[a-z0-9.-]+$/.test(config.gemini_model??''))throw new Error('Modelo Gemini precisa ser configurado.');
      if(video.video_key!==`originals/instagram/${video.id}/video.mp4`)throw new Error('Mídia fora do escopo.');
      const caption=await captionFor(video,executionId);
      const analysisRecord={...video,...caption};
      const request=buildAnalysisRequest({record:analysisRecord,bucket:storage.bucket,preset,model:config.gemini_model});
      const response=await at('submit_analysis',()=>api.request(`https://aiplatform.googleapis.com/v1/projects/${api.project}/locations/global/publishers/google/models/${config.gemini_model}:generateContent`,{method:'POST',json:request,timeoutMs:120000}));
      const key=`results/instagram/${video.id}/${executionId}/analysis.json`;
      // Invalid model output is also preserved for diagnosis, never re-generated.
      const raw=await at('persist_analysis',()=>persist(key,{preset_version:preset.version,model:config.gemini_model,response}));
      const candidate=response.candidates?.[0];
      if(candidate?.finishReason!=='STOP')throw new Error('Resposta Gemini incompleta ou bloqueada.');
      const text=(candidate.content?.parts??[]).filter(p=>p.thought!==true).map(p=>p.text??'').join('');
      const report=reviewAnalysis(JSON.parse(text),analysisRecord);
      if(['megabrain-video-text-v3','megabrain-video-text-v4'].includes(preset.version)&&!report.knowledge)throw new Error('Conhecimento estruturado ausente na nova análise.');
      const publication=analysisPublication(report,video);
      const changes=publication.accepted?{analysis:report,analysis_key:key,analysis_generation:raw.generation,analysis_quality_status:'accepted',analysis_candidate:null,candidate_analysis_key:null,candidate_analysis_generation:null}:{analysis:video.analysis,analysis_key:video.analysis_key,analysis_generation:video.analysis_generation,analysis_quality_status:'review_required',analysis_candidate:report,candidate_analysis_key:key,candidate_analysis_generation:raw.generation};
      return result(video.id,'analysis',{...caption,...changes},cost);
    }
  };
}
