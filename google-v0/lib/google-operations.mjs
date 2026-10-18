import {measureGeminiUsage,measureSpeechUsage} from './usage-costs.mjs';
import {sha256} from './storage.mjs';
import {settledRetryId} from './smart-retry.mjs';
import {executionId as stageExecutionId} from './worker-flow.mjs';
import {preparedAudioFields,validatePreparedAudio} from './audio-artifact.mjs';
import {analysisTimeoutMs} from './google-rest.mjs';
import {submitAnalysisWithRetry,maximumAnalysisAttempts} from './analysis-retry.mjs';
import {inspectMedia} from './media-inspector.mjs';
import {buildAnalysisRequest,analysisOutcome} from './analysis.mjs';
import {qualitySourceManifest,qualityDigest,qualityCandidateHash,qualityPublicationRevision,qualitySourceStateHash,evaluateQualityGateV2,prepareQualityCandidateV2} from './reels-quality-gate.mjs';
import {speechWordEvidence} from './reels-speech-evidence.mjs';

// Legacy callers retain the reservation gate. The v2 caller supplies a
// server-owned execution authorization, independently of financial reporting.
export function googleOperations({api,storage,tools,preset,config,gate,executionAuthorization=null,executionIds=null,preparedAudioKey=null,inspect=inspectMedia,qualityEvidence=null,saveQualityReceipt=null,loadContextCatalog=null}){
  if(api.project!=='megabrain-v0-1017370021431'||storage.bucket!==`${api.project}-media`)throw new Error('Adaptadores fora do projeto v0.');
  if(typeof gate!=='function'&&typeof executionAuthorization!=='function')throw new Error('Autorização de execução obrigatória.');
  if(executionAuthorization!==null&&typeof executionAuthorization!=='function'||executionIds!==null&&typeof executionIds!=='function'||preparedAudioKey!==null&&typeof preparedAudioKey!=='function')throw Error('Contexto de execução inválido.');
  if(loadContextCatalog!==null&&typeof loadContextCatalog!=='function')throw Error('Leitura do catálogo vigente inválida.');
  const qualityMode=!!executionAuthorization&&config.reels_quality_policy_version==='gate_v2';
  if(qualityMode&&typeof saveQualityReceipt!=='function')throw Error('Persistência de recibo de qualidade obrigatória para o worker v2.');
  async function admitted(id,stage,videoId){
    if(config?.enabled!==true||config.uploads_enabled!==true)throw new Error('Operações Google desligadas.');
    if(executionAuthorization){await executionAuthorization({executionId:id,stage,videoId});return;}
    const reservation=await gate({executionId:id,stage,videoId});
    if(reservation?.maximum_cents!==budget(stage))throw new Error('Estimativa diverge da reserva iniciada.');
  }
  // Quotes belong to the legacy BRL ledger. Provider usage is independently
  // valued at versioned USD list prices; neither is a confirmed invoice.
  const finance=(cost,measurement)=>({estimatedUsd:null,measuredUsd:measurement?.status==='measured'&&measurement.currency==='USD'&&Number.isSafeInteger(measurement.list_price_micro_usd)&&measurement.list_price_micro_usd>=0?measurement.list_price_micro_usd/1e6:null,estimate:Number.isFinite(cost)&&cost>=0?{amount:cost/100,currency:'BRL',source:'configured_quote'}:null,measurement:measurement??null});
  const result=(id,stage,changes,cost,measurement)=>({video_id:id,stage,changes,actual_cents:cost,...(executionAuthorization?{finance:finance(cost,measurement)}:{})});
  const budget=stage=>{const n=config?.quotes?.[stage];if(executionAuthorization)return Number.isFinite(n)&&n>=0?n:null;if(!Number.isSafeInteger(n)||n<1)throw new Error('Estimativa obrigatória.');return n;};
  const at=async(step,action)=>{const started=performance.now();try{return await action();}catch(error){error.operation_step=step;error.elapsed_ms=Math.max(0,Math.round(performance.now()-started));throw error;}};
  const submitSTT=(url,options)=>at('submit_stt',()=>api.request(url,options));
  const persist=(key,data)=>storage.writeImmutable(key,Buffer.from(JSON.stringify(data)),{contentType:'application/json',uploadsEnabled:true});
  async function captionFor(video,executionId){
    if(video.source_caption?.text)return {source_caption:video.source_caption,caption_status:'captured'};
    // Caption/metadata belong to acquisition. Legacy absence is explicit; an
    // analysis must not start a fresh Instagram extraction outside that limit.
    return {caption_status:'unavailable'};
  }

  const qualityContext=video=>({mediaInspection:qualityEvidence?.mediaInspection??video.media_inspection_receipt??null,transcriptionReceipt:qualityEvidence?.transcriptionReceipt??video.transcription_receipt??null,trustedReviews:[]});
  async function qualityChanges(response,video,rawIdentity){
   const outcome=analysisOutcome(response,video,{requireKnowledge:true,qualityGateV2:qualityContext(video)}),report=outcome.report??{};
   const candidateKey=rawIdentity.key.replace(/analysis\.json$/,'quality-candidate.json');
   const prepared=await prepareQualityCandidateV2({record:video,report,rawResponse:response,expectedPublicationRevision:qualityPublicationRevision(video),...qualityContext(video),ports:{
    saveCandidate:async value=>{const object=await persist(candidateKey,{report:value.report,candidateContentHash:value.candidateContentHash,rawResponseIdentity:rawIdentity,parseReasons:outcome.reasons??[]});return {key:candidateKey,generation:object.generation,candidateContentHash:value.candidateContentHash};},
    saveReceipt:saveQualityReceipt
   }});
   const accepted=outcome.accepted&&prepared.accepted;
   const changes=accepted?{analysis:report,analysis_key:prepared.candidateIdentity.key,analysis_generation:prepared.candidateIdentity.generation,analysis_quality_status:'accepted',analysis_review_reasons:[],analysis_candidate:null,candidate_analysis_key:null,candidate_analysis_generation:null}:{analysis:video.analysis??null,analysis_key:video.analysis_key??null,analysis_generation:video.analysis_generation??null,analysis_quality_status:video.analysis_quality_status??'review_required',analysis_review_reasons:outcome.reasons?.length?outcome.reasons:['quality_gate_v2_not_accepted'],analysis_candidate:outcome.report??null,candidate_analysis_key:prepared.candidateIdentity.key,candidate_analysis_generation:prepared.candidateIdentity.generation,candidate_quality_receipt:prepared.receiptIdentity};
   return {changes,qualityGate:prepared,qualityPublication:accepted?{policyVersion:'gate_v2',expectedSourceStateHash:qualitySourceStateHash(video),expectedPublicationRevision:prepared.expectedPublicationRevision,publicationIdentity:prepared.publicationIdentity,qualityReceipt:prepared.receiptIdentity}:null};
  }
  function sourcePreflight(video){
   const evaluated=evaluateQualityGateV2({record:video,report:{},...qualityContext(video)});
   if(!video.video_sha256||video.media_inspection_receipt?.version!==1||video.media_inspection_receipt.contentSha256!==video.video_sha256||video.media_inspection_receipt.contentBytes!==video.video_bytes||typeof video.transcript!=='string')return {accepted:false,state:'inconclusive',checks:[{code:'SOURCE_INTEGRITY_NOT_RECORDED',state:'inconclusive',reason:'Inspeção de bytes ou transcrição de origem não está registrada para esta revisão.',policyVersion:'gate_v2'}],gaps:evaluated.gaps,replayAllowed:false};
   const checks=evaluated.checks.filter(c=>/^(?:MEDIA_|AUDIO_|TRANSCRIPT_IDENTITY_|TRANSCRIPT_TEMPORAL_)/.test(c.code)&&c.state!=='supported');
   return checks.length?{accepted:false,state:checks.some(c=>c.state==='invalid')?'invalid':'inconclusive',checks,gaps:evaluated.gaps,replayAllowed:false}:null;
  }
  function transcriptionReceipt(video,reference,key,object,{operationIdentity,mode,words}){
   return {version:1,operationIdentity,operationKind:mode==='synchronous'?'local_synchronous_submission':'provider_batch_operation',mode,sourceAudioIdentity:{key:reference.audio_key,generation:reference.audio_generation},resultIdentity:{key,generation:object.generation},rawResultIdentity:{key,generation:object.generation},words,alignmentMeasured:false,providerFidelityMeasured:false};
  }
  const transcriptionIdFor=videoId=>{const id=executionIds?executionIds(videoId,'transcription'):stageExecutionId(videoId,'transcription');if(!/^[A-Za-z0-9_-]{16,100}$/.test(id??''))throw Error('Identidade STT inválida.');return id;};
  const audioKeyFor=videoId=>{const key=preparedAudioKey?.(videoId)??`results/instagram/${videoId}/${transcriptionIdFor(videoId)}/audio.flac`;if(typeof key!=='string'||!key.startsWith(`results/instagram/${videoId}/`)||!/^results\/instagram\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{16,100}\/audio\.flac$/.test(key))throw Error('Referência de áudio fora do Reel.');return key;};
  function audioReference(video,key,object,audio){
    const reference={audio_key:key,audio_generation:object.generation,audio_bytes:audio.length,audio_sha256:sha256(audio),audio_source_key:video.video_key,audio_source_generation:video.video_generation};
    if(object.size!==audio.length||object.sha256!==reference.audio_sha256)throw Error('Áudio persistido não passou na verificação.');
    validatePreparedAudio({...video,...reference},key);
    return reference;
  }
  async function prepareAudio(video,bytes){
    const key=audioKeyFor(video.id);
    // An orphan cannot establish lineage; never overwrite or infer its source.
    if(await storage.metadata(key))throw Error('Áudio existente sem referência exige conferência.');
    const audio=await at('extract_audio',()=>tools.extractAudio(bytes));
    const object=await at('persist_audio',()=>storage.writeImmutable(key,audio,{contentType:'audio/flac',uploadsEnabled:true}));
    return {audio,reference:audioReference(video,key,object,audio)};
  }
  async function transcriptionAudio(video,recordPreparedAudio){
    const key=audioKeyFor(video.id);
    if(validatePreparedAudio(video,key)){
      const source=await at('read_media',()=>storage.metadata(video.video_key));
      if(!source||source.generation!==video.video_generation)throw Error('Geração da mídia de origem diverge do áudio preparado.');
      const object=await at('read_media',()=>storage.metadata(key));
      if(!object||object.generation!==video.audio_generation||Number(object.size)!==video.audio_bytes||object.metadata?.sha256!==video.audio_sha256)throw Error('Objeto de áudio diverge da referência preservada.');
      const audio=await at('read_media',()=>storage.read(key,{generation:video.audio_generation}));
      if(audio.length!==video.audio_bytes||sha256(audio)!==video.audio_sha256)throw Error('Checksum do áudio preparado diverge.');
      return {audio,reference:Object.fromEntries(preparedAudioFields.map(field=>[field,video[field]]))};
    }
    const bytes=await at('read_media',()=>storage.read(video.video_key,{generation:video.video_generation}));
    const prepared=await prepareAudio(video,bytes);
    // The worker persists lineage before a paid request; standalone adapters
    // still preserve the immutable object and refuse an unreferenced replay.
    if(recordPreparedAudio)await recordPreparedAudio(prepared.reference);
    return prepared;
  }

  function speechSettings(){
    if(!/^[a-z0-9_-]+$/.test(config.speech_model??'')||!['global','us'].includes(config.speech_location)||!Array.isArray(config.language_codes)||!config.language_codes.length||config.language_codes.length>3||config.language_codes.some(c=>!/^\w{2,3}-[A-Z]{2}$/.test(c))||(config.speech_model==='chirp_3'&&config.speech_location!=='us'))throw new Error('Modelo, idiomas e região STT precisam ser configurados.');
  }
  const speechOrigin=()=>config.speech_location==='us'?'https://us-speech.googleapis.com':'https://speech.googleapis.com';
  return {
    async sourceFailureMediaAbsent({video}){return video.media_verified!==true&&!video.video_key&&!video.transcript_key&&!video.analysis&&!await storage.metadata(`originals/instagram/${video.id}/video.mp4`);},
    async prepareUploadRecovery({video,sourceOnlyRecovery=false}){
      if(video.media_verified||video.video_key||await storage.metadata('originals/instagram/'+video.id+'/video.mp4'))throw Error('Mídia existente impede repetir download.');
      if(sourceOnlyRecovery){
        const transcription=stageExecutionId(video.id,'transcription'),analyses=[stageExecutionId(video.id,'analysis'),...['megabrain-video-text-v3','megabrain-video-text-v4'].map(r=>stageExecutionId(video.id,'analysis',r))];
        const keys=[audioKeyFor(video.id),'results/instagram/'+video.id+'/'+transcription+'/transcription.json',...analyses.flatMap(id=>[id,settledRetryId(id)].map(job=>'results/instagram/'+video.id+'/'+job+'/analysis.json'))];
        for(const key of keys)if(await storage.metadata(key))throw Error('Artefato preservado exige conferência sem repetir processamento.');
      }
    },
    async prepareSettledAnalysisRetry({video,originalExecutionId}){
      if(video.analysis||video.analysis_key||video.candidate_analysis_key||await storage.metadata(`results/instagram/${video.id}/${originalExecutionId}/analysis.json`))throw Error('Resultado existente exige reconciliação sem inferência.');
      for(const [key,generation] of [[video.video_key,video.video_generation],[video.transcript_key,video.transcript_generation]]){
        const object=await storage.metadata(key);if(!object||object.generation!==generation||Number(object.size)<1)throw Error('Fonte preservada precisa ser conferida.');
      }
    },
    async restoreAnalysisResult({video,executionId}){
      const key=`results/instagram/${video.id}/${executionId}/analysis.json`,object=await storage.metadata(key);
      if(!object||!/^\d+$/.test(object.generation??''))throw Error('Resposta persistida não encontrada.');
      const saved=JSON.parse(await storage.read(key,{generation:object.generation}));
      if(saved.preset_version!==preset.version||saved.model!==config.gemini_model||!saved.response)throw Error('Resposta salva diverge da revisão atual.');
      let caption=video.source_caption?.text?{source_caption:video.source_caption,caption_status:'captured'}:{caption_status:'unavailable'};
      if(!video.source_caption?.text&&!qualityMode){const captionKey=`results/instagram/${video.id}/${executionId}/caption.json`,metadata=await storage.metadata(captionKey);if(metadata){const capture=JSON.parse(await storage.read(captionKey,{generation:metadata.generation}));caption={source_caption:capture,caption_status:'captured'};}}
      if(qualityMode){const prepared=await qualityChanges(saved.response,{...video,...caption},{key,generation:object.generation});return {...result(video.id,'analysis',{...caption,...prepared.changes},budget('analysis'),saved.usage_cost),qualityGate:prepared.qualityGate,qualityPublication:prepared.qualityPublication,artifact:{key,generation:object.generation}};}
      const outcome=analysisOutcome(saved.response,{...video,...caption},{requireKnowledge:['megabrain-video-text-v3','megabrain-video-text-v4'].includes(preset.version),sourceGroundedPublication:!!executionAuthorization});
      const changes=outcome.accepted?{analysis:outcome.report,analysis_key:key,analysis_generation:object.generation,analysis_quality_status:'accepted',analysis_review_reasons:[],analysis_candidate:null,candidate_analysis_key:null,candidate_analysis_generation:null}:{analysis:video.analysis??null,analysis_key:video.analysis_key??null,analysis_generation:video.analysis_generation??null,analysis_quality_status:'review_required',analysis_review_reasons:outcome.reasons,analysis_candidate:outcome.report??null,candidate_analysis_key:key,candidate_analysis_generation:object.generation};
      return {...result(video.id,'analysis',{...caption,...changes},budget('analysis'),saved.usage_cost),artifact:{key,generation:object.generation}};
    },
    async inspectAnalysisArtifact({videoId,executionId}){
      const key=`results/instagram/${videoId}/${executionId}/analysis.json`,object=await storage.metadata(key);
      return object?{key,generation:object.generation}:null;
    },
    async prepareAnalysis({video,executionId}){await at('reserve_result',()=>storage.reserveResult?.(`results/instagram/${video.id}/${executionId}/analysis.json`));if(!video.source_caption?.text)await storage.reserveResult?.(`results/instagram/${video.id}/${executionId}/caption.json`);},
    async upload({video,executionId,recordAcquisitionExtraction}){
      await admitted(executionId,'upload',video.id);const cost=budget('upload');
      const downloaded=await at('download_media',async()=>{const completed=recordAcquisitionExtraction?.();return tools.download(video,{withMetadata:true,onExecutionStopped:completed});}),bytes=Buffer.isBuffer(downloaded)?downloaded:downloaded.bytes,media=await at('inspect_download',()=>inspect(bytes));
      if(media.audio_status!=='present')throw Object.assign(new Error('Áudio ausente ou silencioso; transcrição não iniciada.'),{operation_step:'inspect_download'});
      const key=`originals/instagram/${video.id}/video.mp4`;
      const object=await at('persist_download',()=>storage.writeImmutable(key,bytes,{contentType:'video/mp4',uploadsEnabled:true}));
      const audioPrepared=config.worker_stage==='upload'?await prepareAudio({...video,video_key:key,video_generation:object.generation},bytes):null;
      return result(video.id,'upload',{...(audioPrepared?.reference??{}),video_key:key,video_generation:object.generation,video_bytes:object.size,...(qualityMode?{video_sha256:object.sha256??sha256(bytes),media_inspection_receipt:createMediaInspectionReceipt({video:{...video,video_key:key,video_generation:object.generation},media,bytes})}:{}),media_verified:true,audio_status:media.audio_status,duration_seconds:media.duration_seconds,...(downloaded.source_caption?{source_caption:downloaded.source_caption,caption_status:'captured'}:{caption_status:'unavailable'})},cost);
    },
    async transcription({video,executionId,recordPreparedAudio}){
      await admitted(executionId,'transcription',video.id);budget('transcription');speechSettings();
      // Unit mode reserves room for the durable result before submitting STT.
      if(config.single_reel_pipeline_enabled===true){if(typeof storage.reserveResult!=='function')throw Error('Reserva do resultado STT indisponível.');await storage.reserveResult(`results/instagram/${video.id}/${executionId}/transcription.json`,1048576);}
      const key=`originals/instagram/${video.id}/video.mp4`;
      if(video.video_key!==key||!/^\d+$/.test(video.video_generation??'')||video.media_verified!==true||video.audio_status!=='present')throw new Error('Mídia verificada obrigatória.');
      if(executionId!==transcriptionIdFor(video.id))throw Error('Execução STT fora do caminho imutável.');
      const {audio,reference}=await transcriptionAudio(video,recordPreparedAudio),audioKey=reference.audio_key;
      // Chirp 3 supports synchronous Recognize for audio below one minute.
      // Select before submission; never fall back by repeating a paid request.
      if(config.synchronous_short_audio===true&&config.speech_model==='chirp_3'&&Number.isFinite(video.duration_seconds)&&video.duration_seconds>0&&video.duration_seconds<=55&&audio.length<=7000000){
        const response=await submitSTT(`${speechOrigin()}/v2/projects/${api.project}/locations/${config.speech_location}/recognizers/_:recognize`,{method:'POST',json:{config:{autoDecodingConfig:{},model:config.speech_model,languageCodes:config.language_codes,features:{enableAutomaticPunctuation:true,enableWordTimeOffsets:true}},content:audio.toString('base64')},timeoutMs:120000});
        const text=(response.results??[]).map(r=>r.alternatives?.[0]?.transcript??'').join('\n').trim();
        const key=`results/instagram/${video.id}/${executionId}/transcription.json`;
        const usage=measureSpeechUsage(response,{model:config.speech_model,location:config.speech_location,mode:'synchronous'});
        const object=await persist(key,{mode:'synchronous',model:config.speech_model,text,raw:response,usage_cost:usage});
        return result(video.id,'transcription',{...reference,...(qualityMode?{transcription_receipt:transcriptionReceipt(video,reference,key,object,{operationIdentity:'synchronous:'+executionId,mode:'synchronous',words:speechWordEvidence(response)})}:{}),transcript:text,...(executionAuthorization?{transcript_words:speechWordEvidence(response)}:{}),transcript_status:text?'recognized':'no_speech_recognized',transcript_key:key,transcript_generation:object.generation},budget('transcription'),usage);
      }
      const operation=await submitSTT(`${speechOrigin()}/v2/projects/${api.project}/locations/${config.speech_location}/recognizers/_:batchRecognize`,{method:'POST',json:{config:{autoDecodingConfig:{},model:config.speech_model,languageCodes:config.language_codes,features:{enableAutomaticPunctuation:true,enableWordTimeOffsets:true}},files:[{uri:`gs://${storage.bucket}/${audioKey}`}],recognitionOutputConfig:{inlineResponseConfig:{}}},timeoutMs:120000});
      if(!operation?.name)throw new Error('STT não confirmou identificador.');
      return {video_id:video.id,stage:'transcription',operation_name:operation.name,changes:qualityMode?{...reference,transcription_submission:{operationIdentity:operation.name,operationKind:'provider_batch_operation',sourceAudioIdentity:{key:reference.audio_key,generation:reference.audio_generation}}}:{}};
    },
    async pollTranscription({operationName,videoId,executionId,video=null}){
      await admitted(executionId,'transcription',videoId);
      speechSettings();
      if(!['megabrain-v0-1017370021431','711042421394'].some(owner=>operationName.startsWith(`projects/${owner}/locations/${config.speech_location}/operations/`))||!/^projects\/[a-z0-9-]+\/locations\/(?:global|us)\/operations\/[A-Za-z0-9_-]+$/.test(operationName))throw new Error('Operação STT fora do escopo.');
      const operation=await api.request(`${speechOrigin()}/v2/${operationName}`);
      if(operation.done!==true)return {video_id:videoId,stage:'transcription',pending:true};
      if(operation.error)throw Object.assign(new Error('STT informou falha.'),executionAuthorization?{definitive:true,code:'STT_TERMINAL_FAILURE'}:{});
      const audioUri=`gs://${storage.bucket}/${audioKeyFor(videoId)}`;
      const file=operation.response?.results?.[audioUri];
      if(file?.error)throw Object.assign(new Error('STT informou falha no arquivo.'),executionAuthorization?{definitive:true,code:'STT_TERMINAL_FAILURE'}:{});
      if(!file)throw new Error('STT não retornou o arquivo esperado.');
      const transcript=file.inlineResult?.transcript??file.transcript;
      const text=(transcript?.results??[]).map(r=>r.alternatives?.[0]?.transcript??'').join('\n').trim();
      // Preserve raw results, including timing and uncertainty, even if no speech.
      const key=`results/instagram/${videoId}/${executionId}/transcription.json`;
      const usage=measureSpeechUsage(operation.response,{model:config.speech_model,location:config.speech_location,mode:'batch',audioUri});
      const object=await persist(key,{operation_name:operationName,model:config.speech_model,text,raw:operation.response,usage_cost:usage});
      if(qualityMode&&(!video||!validatePreparedAudio(video,audioKeyFor(videoId))))throw Error('Vínculo do áudio salvo ausente ao coletar STT.');
      return result(videoId,'transcription',{...(qualityMode?{transcription_receipt:transcriptionReceipt(video,video,key,object,{operationIdentity:operationName,mode:'batch',words:speechWordEvidence(transcript)})}:{}),transcript:text,...(executionAuthorization?{transcript_words:speechWordEvidence(transcript)}:{}),transcript_status:text?'recognized':'no_speech_recognized',transcript_key:key,transcript_generation:object.generation},budget('transcription'),usage);
    },
    async analysis({video,executionId,analysisAttempts=[],recordAnalysisAttempts}){
      const timeoutMs=analysisTimeoutMs(config?.analysis_timeout_ms),deadline=performance.now()+timeoutMs;
      await admitted(executionId,'analysis',video.id);const cost=budget('analysis');
      if(!/^gemini-[a-z0-9.-]+$/.test(config.gemini_model??''))throw new Error('Modelo Gemini precisa ser configurado.');
      if(video.video_key!==`originals/instagram/${video.id}/video.mp4`)throw new Error('Mídia fora do escopo.');
      if(qualityMode&&await storage.metadata(`results/instagram/${video.id}/${executionId}/analysis.json`))return this.restoreAnalysisResult({video,executionId});
      if(typeof recordAnalysisAttempts==='function'&&await storage.metadata(`results/instagram/${video.id}/${executionId}/analysis.json`))throw Error('Resultado já existe; conferir sem repetir análise.');
      const caption=await captionFor(video,executionId);
      const analysisRecord={...video,...caption};
      if(qualityMode){const qualityGate=sourcePreflight(analysisRecord);if(qualityGate)return {...result(video.id,'analysis',{analysis_review_reasons:['quality_source_unverified'],analysis_candidate:null,candidate_analysis_key:null,candidate_analysis_generation:null},null,null),qualityGate,qualityPublication:null};}
      const contextCatalogSnapshot=qualityMode?await readAnalysisContextCatalogue(loadContextCatalog,{videoId:video.id,record:analysisRecord}):null;
      const request=buildAnalysisRequest({record:analysisRecord,bucket:storage.bucket,preset,model:config.gemini_model,taxonomySignalsEnabled:config.reels_taxonomy_signals_enabled===true,qualityGateV2Enabled:qualityMode,contextCatalogSnapshot});
      let attempt=analysisAttempts.length;const callDiagnostics=[];
      const submit=()=>at('submit_analysis',()=>{
        const remainingMs=Math.floor(deadline-performance.now());
        if(remainingMs<1)throw Object.assign(new Error('Prazo total da análise esgotado.'),{name:'TimeoutError',google_diagnostic:{operation_step:'submit_analysis',elapsed_ms:timeoutMs,error_name:'TimeoutError',error_code:null,http_status:null,request_id:null,model:config.gemini_model,attempt:attempt+1,timeout_ms:timeoutMs}});
        return api.request(`https://aiplatform.googleapis.com/v1/projects/${api.project}/locations/global/publishers/google/models/${config.gemini_model}:generateContent`,{method:'POST',json:request,timeoutMs:remainingMs,operationStep:'submit_analysis',model:config.gemini_model,attempt:++attempt,onDiagnostic:diagnostic=>{callDiagnostics.push(diagnostic);}});
      });
      const response=typeof recordAnalysisAttempts==='function'?await submitAnalysisWithRetry({submit,admit:()=>admitted(executionId,'analysis',video.id),record:recordAnalysisAttempts,attempts:analysisAttempts,maximumAttempts:config.single_reel_pipeline_enabled===true?1:maximumAnalysisAttempts}):await submit();
      const key=`results/instagram/${video.id}/${executionId}/analysis.json`;
      // Invalid model output is also preserved for diagnosis, never re-generated.
      const usage=measureGeminiUsage(response,{model:config.gemini_model,location:'global'});
      const raw=await at('persist_analysis',()=>persist(key,{preset_version:preset.version,model:config.gemini_model,response,call_diagnostics:callDiagnostics,usage_cost:usage,...(qualityMode?{context_catalogue_receipt:{snapshotHash:contextCatalogSnapshot.snapshotHash,state:contextCatalogSnapshot.state,version:contextCatalogSnapshot.version,policyVersion:contextCatalogSnapshot.policyVersion??null,dataAsOf:contextCatalogSnapshot.dataAsOf??null},context_catalogue_snapshot:contextCatalogSnapshot}:{})}));
      if(qualityMode){const prepared=await qualityChanges(response,analysisRecord,{key,generation:raw.generation});return {...result(video.id,'analysis',{...caption,...prepared.changes},cost,usage),qualityGate:prepared.qualityGate,qualityPublication:prepared.qualityPublication};}
      const outcome=analysisOutcome(response,analysisRecord,{requireKnowledge:['megabrain-video-text-v3','megabrain-video-text-v4'].includes(preset.version),sourceGroundedPublication:!!executionAuthorization});
      const changes=outcome.accepted?{analysis:outcome.report,analysis_key:key,analysis_generation:raw.generation,analysis_quality_status:'accepted',analysis_review_reasons:[],analysis_candidate:null,candidate_analysis_key:null,candidate_analysis_generation:null}:{analysis:video.analysis??null,analysis_key:video.analysis_key??null,analysis_generation:video.analysis_generation??null,analysis_quality_status:'review_required',analysis_review_reasons:outcome.reasons,analysis_candidate:outcome.report??null,candidate_analysis_key:key,candidate_analysis_generation:raw.generation};
      return result(video.id,'analysis',{...caption,...changes},cost,usage);
    }
  };
}

// Called only after the inspector actually probed and decoded these bytes.
export function createMediaInspectionReceipt({video,media,bytes}){
 if(media?.hasVideo!==true||typeof media.hasAudio!=='boolean'||!Number.isFinite(media.duration_seconds)||media.duration_seconds<=0||!Buffer.isBuffer(bytes)||!bytes.length)throw Error('Inspeção real incompleta.');
 const sourceIdentity=qualitySourceManifest(video).video;if(!sourceIdentity)throw Error('Geração da mídia inspecionada ausente.');
 const receipt={kind:'media-inspector',version:1,sourceIdentity,contentSha256:sha256(bytes),contentBytes:bytes.length,decodePassed:true,probePassed:true,durationSeconds:media.duration_seconds,expectedAudio:media.hasAudio,audioTrackPresent:media.hasAudio,audioStatus:media.audio_status,semanticPixelsReviewed:false};
 return {...receipt,receiptId:'media_'+qualityDigest(receipt)};
}

 
// Executed for each new final-analysis request, never at lazy runtime startup.
// A missing catalogue is explicit; old environment snapshots cannot masquerade
// as a current read. Saved-response reconciliation does not read or replay it.
export async function readAnalysisContextCatalogue(loader,context){
 const missing=reason=>{const snapshot={version:'semantic-curator-v1',state:'unavailable',reason,groups:[],noProviders:true};return {...snapshot,snapshotHash:sha256(Buffer.from(JSON.stringify(snapshot)))};};
 if(typeof loader!=='function')return missing('LIVE_CATALOGUE_LOADER_MISSING');
 try{
  const value=await loader(context);
  if(!value||value.version!=='semantic-curator-v1'||!['available','stale','unavailable'].includes(value.state)||!Array.isArray(value.groups)||value.groups.length>64||value.noProviders!==true||!/^[a-f0-9]{64}$/.test(value.snapshotHash??''))return missing('LIVE_CATALOGUE_INVALID');
  const encoded=JSON.stringify(value);
  if(Buffer.byteLength(encoded,'utf8')>30000)return missing('COMPACT_CATALOGUE_LIMIT');
  return JSON.parse(encoded);
 }catch{return missing('LIVE_CATALOGUE_READ_UNAVAILABLE');}
}
