import {recoverableAnalysis429} from './analysis-retry.mjs';
import {validateBatch,batchLimits} from './batch-budget.mjs';
import {safeDownloadDiagnostic} from './media-tools.mjs';
import {createHash} from 'node:crypto';

const stages=['upload','transcription','analysis'];
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
export const completedEmptyTranscript=(video,videoId)=>video?.transcript_status==='no_speech_recognized'&&video.transcript===''&&video.transcript_key===`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`&&/^\d+$/.test(video.transcript_generation??'');
export const executionId=(videoId,stage,revision=null)=>{
  if(revision!==null&&(stage!=='analysis'||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(revision)))throw new Error('Revisão de execução inválida.');
  return 'job_'+createHash('sha256').update(`${videoId}:${stage}:${revision??'v0'}`).digest('hex');
};
const ownsResult=(result,id,stage)=>result?.video_id===id&&result?.stage===stage;
const failureDiagnostic=error=>({operation_step:['download_media','inspect_download','persist_download','read_media','extract_audio','persist_audio','submit_stt','reserve_result','submit_analysis','persist_analysis'].includes(error?.operation_step)?error.operation_step:'adapter_or_reservation',http_status:Number.isInteger(error?.status)?error.status:null,tool_code:Number.isInteger(error?.code)||typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:null,...(error?.provider_diagnostic?{provider:error.provider_diagnostic}:{}),...(error?.download_diagnostic?{download:safeDownloadDiagnostic(error.download_diagnostic)}:{})});

// Adapters must persist artifacts before returning. A submitted asynchronous
// operation is polled by its persisted name, never submitted a second time.
export class WorkerFlow {
  constructor({store,ledger,operations,quotes,eligibleVideos=null,analysisRevision=null,batchId=null,clock=()=>Date.now()}){
    if(analysisRevision!==null&&!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision))throw new Error('Revisão de análise inválida.');
    this.analysisRevision=analysisRevision;this.batchId=batchId;
    if(batchId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(batchId))throw new Error('Lote inválido.');
    if(!store||!ledger||!operations||!quotes)throw new Error('Integrações do worker obrigatórias.');
    Object.assign(this,{store,ledger,operations,quotes,clock});
    if(eligibleVideos!==null&&(!Array.isArray(eligibleVideos)||eligibleVideos.length>(batchId?batchLimits.videos:20)||eligibleVideos.some(id=>!validId(id))||new Set(eligibleVideos).size!==eligibleVideos.length))throw new Error('Amostra do piloto inválida.');
    this.eligibleVideos=eligibleVideos===null?null:new Set(eligibleVideos);
  }
  async run({videoId,stage,recoverAnalysis429=false}){
    if(!validId(videoId)||!stages.includes(stage)||typeof recoverAnalysis429!=='boolean'||recoverAnalysis429&&stage!=='analysis')throw new Error('Tarefa fora do escopo.');
    if(this.eligibleVideos&&!this.eligibleVideos.has(videoId))return {status:'blocked',reason:'outside_pilot'};
    if(this.batchId){const batch=validateBatch((await this.store.get('settings/financial'))?.data?.batch);if(batch.id!==this.batchId||batch.status!=='active'||!batch.video_ids.includes(videoId))return {status:'blocked',reason:'outside_active_batch'};}
    const controls=(await this.store.get('settings/automation'))?.data;
    if(!controls?.enabled||(stage==='transcription'&&!controls.transcription_enabled)||(stage==='analysis'&&!controls.analysis_enabled))return {status:'paused'};
    const video=await this.store.get(`videos/${videoId}`);
    if(!video)throw new Error('Vídeo não cadastrado.');
    if(stage!=='upload'&&video.data.media_verified!==true)return {status:'blocked',reason:'media_not_verified'};
    if(stage==='transcription'&&video.data.audio_status!=='present')return {status:'blocked',reason:'audio_not_verified'};
    if(stage==='analysis'&&(typeof video.data.transcript!=='string'||!video.data.transcript.trim())&&!completedEmptyTranscript(video.data,videoId))return {status:'blocked',reason:'transcript_missing'};
    const revision=stage==='analysis'?this.analysisRevision:null;
    const id=executionId(videoId,stage,revision),path=`jobs/${id}`;
    const existing=await this.store.get(path);
    let recovery=false,recovery429=false,analysisAttempts=[];
    if(recoverAnalysis429){
      if(!recoverableAnalysis429(existing?.data)||video.data.analysis||video.data.analysis_key||video.data.candidate_analysis_key)return {status:'blocked',reason:'analysis_not_recoverable_429'};
      const financial=(await this.store.get('settings/financial'))?.data,prior=financial?.jobs?.[id];
      if(prior?.status!=='uncertain'||prior.video_id!==videoId||prior.stage!=='analysis'||prior.maximum_cents!==this.quotes.analysis)return {status:'blocked',reason:'reservation_not_recoverable_429'};
      analysisAttempts=existing.data.analysis_attempts??[{number:1,status:'http_429',legacy_diagnostic:existing.data.failure_diagnostic}];
      await this.store.patch(path,{status:'recovering_429',analysis_attempts:analysisAttempts},{updateTime:existing.updateTime});recovery429=true;
    }

    if(recovery429){/* Existing claim and reservation are retained. */}else if(existing?.data.status==='retry_ready'){const financial=await this.store.get('settings/financial');if(financial?.data.jobs?.[id])return {status:'blocked',reason:'previous_financial_attempt'};await this.store.patch(path,{status:'claimed'},{updateTime:existing.updateTime});recovery=true;}else if(existing)return {status:existing.data.status,execution_id:id,duplicate:true};
    const maximumCents=this.quotes[stage];
    if(!Number.isSafeInteger(maximumCents)||maximumCents<1)throw new Error('Estimativa conservadora ausente.');
    const operation=this.operations[stage];
    if(typeof operation!=='function')throw new Error('Adaptador da etapa indisponível.');
    // Firestore create-only makes concurrent queue deliveries converge here.
    const claimed=recovery||recovery429?{created:true}:await this.store.create(path,{video_id:videoId,stage,status:'claimed',created_at:new Date(this.clock()).toISOString()});
    if(!claimed.created)return {status:'claimed',execution_id:id,duplicate:true};
    let started=false;
    const save=async changes=>{const current=await this.store.get(path);await this.store.patch(path,changes,{updateTime:current.updateTime});};
    try{
      if(revision&&video.data.analysis){
        const archive=await this.store.create(`analyses/${id}_previous`,{video_id:videoId,analysis:video.data.analysis,analysis_key:video.data.analysis_key??null,analysis_generation:video.data.analysis_generation??null,archived_at:new Date(this.clock()).toISOString()});
        if(!archive.created){const previous=await this.store.get(`analyses/${id}_previous`);if(!recovery||previous?.data.analysis_key!==video.data.analysis_key||previous?.data.analysis_generation!==video.data.analysis_generation)throw new Error('Histórico da análise já existe; conferir antes de executar.');}
      }
      if(stage==='analysis'&&typeof this.operations.prepareAnalysis==='function')await this.operations.prepareAnalysis({video:{...video.data,id:videoId},executionId:id});
      if(recovery429){await this.ledger.resumeAnalysis429(id);started=true;}else{
        await this.ledger.reserve({executionId:id,videoId,stage,maximumCents,...(revision?{analysisRevision:revision}:{})});
        await save({status:'reserved'});
        await this.ledger.transition(id,'start');started=true;
      }
      await save({status:'started'});
      const result=await operation({video:{...video.data,id:videoId},executionId:id,...(stage==='analysis'?{analysisAttempts,recordAnalysisAttempts:async history=>{if(history.at(-1)?.status==='started'){const controls=(await this.store.get('settings/automation'))?.data;if(!controls?.enabled||!controls.analysis_enabled)throw Error('Análise pausada durante espera.');}await save({analysis_attempts:history});}}:{})});
      if(!ownsResult(result,videoId,stage))throw new Error('Resultado não pertence à tarefa.');
      if(result.operation_name){
        if(stage!=='transcription'||typeof result.operation_name!=='string'||!/^projects\/(?:megabrain-v0-1017370021431|711042421394)\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_-]+$/.test(result.operation_name))throw new Error('Operação assíncrona inválida.');
        await save({status:'waiting',operation_name:result.operation_name});
        return {status:'waiting',execution_id:id};
      }
      return await this.finish({path,id,videoId,stage,result,maximumCents});
    }catch(error){
      if(started){try{await this.ledger.transition(id,'uncertain');}catch{/* An open started reservation also prevents replay. */}}
      await save({status:started?'uncertain':'blocked',failure_diagnostic:failureDiagnostic(error)});
      const current=await this.store.get(`videos/${videoId}`);
      await this.store.patch(`videos/${videoId}`,{status:'needs_attention',error:started?'Etapa interrompida; resultado e reserva precisam de conferência.':'Etapa bloqueada antes de executar; confira configuração e reserva.',updated_at:new Date(this.clock()).toISOString()},{updateTime:current.updateTime});
      return {status:started?'uncertain':'blocked',execution_id:id};
    }
  }
  async poll({videoId}){
    if(!validId(videoId))throw new Error('Vídeo inválido.');
    if(this.eligibleVideos&&!this.eligibleVideos.has(videoId))return {status:'blocked',reason:'outside_pilot'};
    if(this.batchId){const batch=validateBatch((await this.store.get('settings/financial'))?.data?.batch);if(batch.id!==this.batchId||batch.status!=='active'||!batch.video_ids.includes(videoId))return {status:'blocked',reason:'outside_active_batch'};}
    const stage='transcription',id=executionId(videoId,stage),path=`jobs/${id}`,snapshot=await this.store.get(path);
    if(snapshot?.data.status!=='waiting')return {status:snapshot?.data.status??'absent'};
    if(typeof this.operations.pollTranscription!=='function')throw new Error('Consulta STT indisponível.');
    // Claim this poll using the document version. Duplicate poll deliveries fail
    // before the adapter. Crashes remain visible for manual reconciliation.
    await this.store.patch(path,{status:'polling'},{updateTime:snapshot.updateTime});
    try{
      const result=await this.operations.pollTranscription({operationName:snapshot.data.operation_name,videoId,executionId:id});
      if(!ownsResult(result,videoId,stage))throw new Error('Resultado STT inválido.');
      if(result.pending===true){const current=await this.store.get(path);await this.store.patch(path,{status:'waiting'},{updateTime:current.updateTime});return {status:'waiting'};}
      return await this.finish({path,id,videoId,stage,result,maximumCents:this.quotes[stage]});
    }catch{
      try{await this.ledger.transition(id,'uncertain');}catch{}
      const current=await this.store.get(path);await this.store.patch(path,{status:'uncertain'},{updateTime:current.updateTime});
      const video=await this.store.get(`videos/${videoId}`);
      await this.store.patch(`videos/${videoId}`,{status:'needs_attention',error:'Transcrição interrompida; resultado e reserva precisam de conferência.',updated_at:new Date(this.clock()).toISOString()},{updateTime:video.updateTime});
      return {status:'uncertain',execution_id:id};
    }
  }
  async finish({path,id,videoId,stage,result,maximumCents}){
    if(!Number.isSafeInteger(result.actual_cents)||result.actual_cents<0||result.actual_cents>maximumCents)throw new Error('Custo precisa de reconciliação.');
    const allowed=stage==='upload'?['video_key','video_generation','video_bytes','media_verified','audio_status','duration_seconds']:stage==='transcription'?['transcript','transcript_status','transcript_key','transcript_generation']:['analysis','analysis_key','analysis_generation','source_caption','caption_status','analysis_quality_status','analysis_review_reasons','analysis_candidate','candidate_analysis_key','candidate_analysis_generation'];
    const changes=result.changes;
    if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(key=>!allowed.includes(key)))throw new Error('Persistência fora do schema da etapa.');
    if(stage==='upload'&&(changes.media_verified!==true||changes.audio_status!=='present'))throw new Error('Mídia precisa de diagnóstico.');
    if(stage==='transcription'&&(typeof changes.transcript!=='string'||!changes.transcript.trim())&&!completedEmptyTranscript(changes,videoId))throw new Error('Transcrição vazia precisa de diagnóstico.');
    if(stage==='transcription'&&changes.transcript_status!==undefined&&!['recognized','no_speech_recognized'].includes(changes.transcript_status))throw new Error('Estado da transcrição inválido.');
    if(changes.source_caption){const c=changes.source_caption;if(typeof c.text!=='string'||!c.text.trim()||c.text.length>50000||c.capture_id!==createHash('sha256').update(c.text).digest('hex'))throw Error('Legenda capturada inválida.');}
    if(changes.caption_status!==undefined&&!['captured','unavailable'].includes(changes.caption_status))throw Error('Estado da legenda inválido.');
    const reviewRequired=stage==='analysis'&&changes.analysis_quality_status==='review_required';
    if(reviewRequired&&(changes.candidate_analysis_key!==`results/instagram/${videoId}/${id}/analysis.json`||!/^\d+$/.test(changes.candidate_analysis_generation??'')))throw new Error('Candidato persistido da própria execução obrigatório.');
    if(changes.analysis_review_reasons!==undefined&&(!Array.isArray(changes.analysis_review_reasons)||changes.analysis_review_reasons.some(r=>!['incomplete_response','invalid_json','invalid_categories','invalid_report','missing_knowledge','unsupported_revision'].includes(r))))throw new Error('Motivo de revisão inválido.');
    if(stage==='analysis'&&!reviewRequired&&(!changes.analysis||typeof changes.analysis!=='object'))throw new Error('Análise ausente.');
    const video=await this.store.get(`videos/${videoId}`);
    if(reviewRequired&&(JSON.stringify(changes.analysis??null)!==JSON.stringify(video.data.analysis??null)||(changes.analysis_key??null)!==(video.data.analysis_key??null)||(changes.analysis_generation??null)!==(video.data.analysis_generation??null)))throw new Error('Revisão pendente não pode substituir análise publicada.');
    await this.store.patch(`videos/${videoId}`,{...changes,status:stage==='upload'?'downloaded':stage==='transcription'?'transcribed':changes.analysis_quality_status==='review_required'?'needs_attention':'analyzed',error:changes.analysis_quality_status==='review_required'?'Resposta recebida com problemas de qualidade; confira o candidato preservado. A análise publicada não foi substituída.':null,updated_at:new Date(this.clock()).toISOString(),...(stage==='upload'?{has_audio:true}:{})},{updateTime:video.updateTime});
    // Persist result before settling. A later failure holds the reservation and
    // requires reconciliation; it never re-runs inference to recover bookkeeping.
    await this.ledger.transition(id,'complete',{actualCents:result.actual_cents});
    const job=await this.store.get(path);await this.store.patch(path,{status:'completed',completed_at:new Date(this.clock()).toISOString()},{updateTime:job.updateTime});
    return {status:'completed',execution_id:id};
  }
}
