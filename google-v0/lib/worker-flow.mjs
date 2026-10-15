import {settledRetryId,settledRetryAllowed,settledRetryAuthorizationPath} from './smart-retry.mjs';
import {metadataRecoveryAllowed,recoveryAuthorizationPath,uploadRecoveryId} from './firestore-recovery.mjs';
import {terminalSourceFailure,recordSourceHold} from './source-hold.mjs';
import {recoverableUploadFailure} from './upload-recovery.mjs';
import {recoverableAnalysis429} from './analysis-retry.mjs';
import {validateBatch,batchLimits} from './batch-budget.mjs';
import {safeDownloadDiagnostic} from './media-tools.mjs';
import {createHash,randomUUID} from 'node:crypto';

const stages=['upload','transcription','analysis'];
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
export const completedEmptyTranscript=(video,videoId)=>video?.transcript_status==='no_speech_recognized'&&video.transcript===''&&video.transcript_key===`results/instagram/${videoId}/${executionId(videoId,'transcription')}/transcription.json`&&/^\d+$/.test(video.transcript_generation??'');
export const executionId=(videoId,stage,revision=null)=>{
  if(revision!==null&&(stage!=='analysis'||!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(revision)))throw new Error('Revisão de execução inválida.');
  return 'job_'+createHash('sha256').update(`${videoId}:${stage}:${revision??'v0'}`).digest('hex');
};
const ownsResult=(result,id,stage)=>result?.video_id===id&&result?.stage===stage;
const safeGoogleCallDiagnostic=value=>{
 if(!value||!['submit_analysis','submit_stt'].includes(value.operation_step))return null;
 const out={operation_step:value.operation_step};
 for(const key of ['elapsed_ms','timeout_ms'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=890000)out[key]=value[key];
 if(['Error','TypeError','SyntaxError','AbortError','TimeoutError','RangeError'].includes(value.error_name))out.error_name=value.error_name;
 if(Number.isSafeInteger(value.error_code)||typeof value.error_code==='string'&&/^(?:ERR_[A-Z_]{1,48}|E[A-Z]{2,24}|UND_ERR_[A-Z_]{1,48})$/.test(value.error_code))out.error_code=value.error_code;
 if(Number.isInteger(value.http_status)&&value.http_status>=100&&value.http_status<=599)out.http_status=value.http_status;
 if(typeof value.request_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.request_id))out.request_id=value.request_id;
 if(typeof value.model==='string'&&/^[a-z][a-z0-9_.-]{0,63}$/.test(value.model))out.model=value.model;
 if(Number.isInteger(value.attempt)&&value.attempt>=1&&value.attempt<=3)out.attempt=value.attempt;
 return out;
};
const failureDiagnostic=error=>({operation_step:['download_media','inspect_download','persist_download','read_media','extract_audio','persist_audio','submit_stt','reserve_result','submit_analysis','persist_analysis'].includes(error?.operation_step)?error.operation_step:'adapter_or_reservation',http_status:Number.isInteger(error?.status)?error.status:null,tool_code:Number.isInteger(error?.code)||typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:null,...(['TimeoutError','AbortError'].includes(error?.name)?{error_name:error.name}:{}),...(['elapsed_ms','timeout_ms'].reduce((fields,key)=>{if(Number.isSafeInteger(error?.[key]??error?.google_diagnostic?.[key])&&(error?.[key]??error?.google_diagnostic?.[key])>=0&&(error?.[key]??error?.google_diagnostic?.[key])<=890000)fields[key]=error?.[key]??error?.google_diagnostic?.[key];return fields;},{})),...(safeGoogleCallDiagnostic(error?.google_diagnostic)?{google_call:safeGoogleCallDiagnostic(error.google_diagnostic)}:{}),...(error?.provider_diagnostic?{provider:error.provider_diagnostic}:{}),...(error?.download_diagnostic?{download:safeDownloadDiagnostic(error.download_diagnostic)}:{})});

// Adapters must persist artifacts before returning. A submitted asynchronous
// operation is polled by its persisted name, never submitted a second time.
export class WorkerFlow {
  constructor({store,ledger,operations,quotes,eligibleVideos=null,analysisRevision=null,batchId=null,autoHoldTerminalSources=false,verifyExecutionStopped,recordExecutionStopped,acquisition,clock=()=>Date.now()}){
    if(analysisRevision!==null&&!['megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision))throw new Error('Revisão de análise inválida.');
    this.analysisRevision=analysisRevision;this.batchId=batchId;this.autoHoldTerminalSources=autoHoldTerminalSources===true;
    if(batchId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(batchId))throw new Error('Lote inválido.');
    if(!store||!ledger||!operations||!quotes)throw new Error('Integrações do worker obrigatórias.');
    Object.assign(this,{store,ledger,operations,quotes,verifyExecutionStopped,recordExecutionStopped,acquisition,clock});
    if(eligibleVideos!==null&&(!Array.isArray(eligibleVideos)||eligibleVideos.length>(batchId?batchLimits.videos:20)||batchId&&eligibleVideos.length>62&&eligibleVideos.length!==262||eligibleVideos.some(id=>!validId(id))||new Set(eligibleVideos).size!==eligibleVideos.length))throw new Error('Amostra do piloto inválida.');
    this.eligibleVideos=eligibleVideos===null?null:new Set(eligibleVideos);
  }
  async run({videoId,stage,recoverAnalysis429=false,recoverUpload=false,recoverFirestoreWrite=false,recoverSettled=false,recoveryId}){
    if(typeof recoverSettled!=='boolean'||recoverSettled&&(!['upload','analysis'].includes(stage)||recoverUpload||recoverAnalysis429||recoverFirestoreWrite||!/^[A-Za-z0-9_-]{16,64}$/.test(recoveryId??'')))throw Error('Retomada explícita inválida.');
    if(typeof recoverFirestoreWrite!=='boolean'||recoverFirestoreWrite&&(!['upload','transcription'].includes(stage)||recoverUpload||recoverAnalysis429||!/^[A-Za-z0-9_-]{16,64}$/.test(recoveryId??'')))throw new Error('Retomada de metadados inválida.');
    if(typeof recoverUpload!=='boolean'||recoverUpload&&(stage!=='upload'||recoverAnalysis429)||!validId(videoId)||!stages.includes(stage)||typeof recoverAnalysis429!=='boolean'||recoverAnalysis429&&stage!=='analysis')throw new Error('Tarefa fora do escopo.');
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
    const originalId=executionId(videoId,stage,revision);
    const id=recoverSettled?settledRetryId(originalId):recoverFirestoreWrite&&stage==='upload'?uploadRecoveryId(originalId):originalId,path=`jobs/${id}`;
    const existing=await this.store.get(path);
    if(recoverSettled){
      if(existing)return {status:existing.data.status,execution_id:id,duplicate:true};
      const prior=(await this.store.get(`jobs/${originalId}`))?.data,financial=(await this.store.get('settings/financial'))?.data,authorization=(await this.store.get(settledRetryAuthorizationPath(originalId)))?.data;
      if(!settledRetryAllowed({authorization,claim:prior,financial:financial?.jobs?.[originalId],video:video.data,originalId,videoId,stage,maximumCents:this.quotes[stage],recoveryId,now:this.clock()}))return {status:'blocked',reason:'settled_retry_not_authorized'};
      if(typeof this.operations[stage==='upload'?'prepareUploadRecovery':'prepareSettledAnalysisRetry']!=='function')return {status:'blocked',reason:'artifact_check_unavailable'};
    }
    let metadataUpload=false,metadataTranscription=false;
    if(recoverFirestoreWrite){
      if(stage==='upload'&&existing||stage==='transcription'&&existing?.data.firestore_recovery_count)return {status:'recovery_already_claimed',execution_id:id,duplicate:true};
      const priorClaim=stage==='upload'?await this.store.get(`jobs/${originalId}`):existing;
      const financial=(await this.store.get('settings/financial'))?.data;
      const authorization=(await this.store.get(recoveryAuthorizationPath(originalId)))?.data;
      if(!metadataRecoveryAllowed({authorization,claim:priorClaim?.data,financial:financial?.jobs?.[originalId],video:video.data,originalId,videoId,stage,maximumCents:this.quotes[stage],recoveryId,now:this.clock()}))return {status:'blocked',reason:'firestore_recovery_not_authorized'};
      if(stage==='upload'){if(typeof this.operations.prepareUploadRecovery!=='function')return {status:'blocked',reason:'media_absence_check_unavailable'};metadataUpload=true;}
      else{await this.store.patch(path,{status:'recovering_firestore_metadata',firestore_recovery_count:1,firestore_recovery_authorization:recoveryAuthorizationPath(originalId),original_failure_diagnostic:existing.data.failure_diagnostic},{updateTime:existing.updateTime});metadataTranscription=true;}
    }
    let recovery=false,recovery429=false,uploadRecovery=false,analysisAttempts=[];
    if(recoverUpload){
      const probe=(await this.store.get('jobs/probe_'+id))?.data;
      const financial=(await this.store.get('settings/financial'))?.data,prior=financial?.jobs?.[id];
      if(!recoverableUploadFailure(existing?.data)||existing.data.video_id!==videoId||probe?.status!=='metadata_available'||probe.original_job_id!==id||probe.video_id!==videoId||video.data.media_verified||video.data.video_key||typeof this.operations.prepareUploadRecovery!=='function')return {status:'blocked',reason:'upload_not_recoverable'};
      if(prior?.status!=='uncertain'||prior.stage!=='upload'||prior.video_id!==videoId||prior.maximum_cents!==this.quotes.upload||prior.upload_recovery_count)return {status:'blocked',reason:'upload_reservation_not_recoverable'};
      await this.store.patch(path,{status:'recovering_upload',upload_recovery_count:1,original_failure_diagnostic:existing.data.failure_diagnostic},{updateTime:existing.updateTime});uploadRecovery=true;
    }
    if(recoverAnalysis429){
      if(!recoverableAnalysis429(existing?.data)||video.data.analysis||video.data.analysis_key||video.data.candidate_analysis_key)return {status:'blocked',reason:'analysis_not_recoverable_429'};
      const financial=(await this.store.get('settings/financial'))?.data,prior=financial?.jobs?.[id];
      if(prior?.status!=='uncertain'||prior.video_id!==videoId||prior.stage!=='analysis'||prior.maximum_cents!==this.quotes.analysis)return {status:'blocked',reason:'reservation_not_recoverable_429'};
      analysisAttempts=existing.data.analysis_attempts??[{number:1,status:'http_429',legacy_diagnostic:existing.data.failure_diagnostic}];
      await this.store.patch(path,{status:'recovering_429',analysis_attempts:analysisAttempts},{updateTime:existing.updateTime});recovery429=true;
    }

    if(recovery429||uploadRecovery||metadataTranscription){/* Existing claim and reservation are retained. */}else if(existing?.data.status==='retry_ready'){const financial=await this.store.get('settings/financial');if(financial?.data.jobs?.[id])return {status:'blocked',reason:'previous_financial_attempt'};await this.store.patch(path,{status:'claimed'},{updateTime:existing.updateTime});recovery=true;}else if(existing)return {status:existing.data.status,execution_id:id,duplicate:true};
    if(stage==='upload'&&this.acquisition&&(video.data.media_verified||video.data.video_key))return {status:'blocked',reason:'media_requires_reconciliation'};
    const maximumCents=this.quotes[stage];
    if(!Number.isSafeInteger(maximumCents)||maximumCents<1)throw new Error('Estimativa conservadora ausente.');
    const operation=this.operations[stage];
    if(typeof operation!=='function')throw new Error('Adaptador da etapa indisponível.');
    // Firestore create-only makes concurrent queue deliveries converge here.
    const claimed=recovery||recovery429||uploadRecovery||metadataTranscription?{created:true}:await this.store.create(path,{video_id:videoId,stage,status:'claimed',created_at:new Date(this.clock()).toISOString(),...(recoverSettled?{recovery_of:originalId,settled_retry_count:1,recovery_authorization:settledRetryAuthorizationPath(originalId)}:{}),...(metadataUpload?{recovery_of:originalId,firestore_recovery_count:1,firestore_recovery_authorization:recoveryAuthorizationPath(originalId)}:{})});
    if(!claimed.created)return {status:'claimed',execution_id:id,duplicate:true};
    // This identity is generated by the server after acquiring the claim, never
    // accepted from a task payload. Failed ownership writes cannot run adapters.
    const limitedUpload=stage==='upload'&&!!this.acquisition;
    const attemptId=(stage==='analysis'||limitedUpload)&&typeof this.recordExecutionStopped==='function'?randomUUID():null;
    let acquired=false,adapterCalls=0,extractions=0,extractionEndUnconfirmed=false;const acquisitionStarted=this.clock();
    if(attemptId&&!limitedUpload){const current=await this.store.get(path);await this.store.patch(path,{execution_attempt_id:attemptId,analysis_revision:revision},{updateTime:current.updateTime});}
    let started=false;
    const save=async changes=>{const current=await this.store.get(path);await this.store.patch(path,changes,{updateTime:current.updateTime});};
    try{
      if(limitedUpload){
        if(!attemptId)throw Error('Comprovante de aquisição indisponível.');
        acquired=await this.acquisition.acquire({executionId:id,videoId,attemptId});
        if(!acquired){await save({status:'blocked',block_reason:'acquisition_capacity'});return {status:'blocked',reason:'acquisition_capacity',execution_id:id};}
        await save({execution_attempt_id:attemptId,analysis_revision:null});
      }
      if(revision&&video.data.analysis){
        const archive=await this.store.create(`analyses/${id}_previous`,{video_id:videoId,analysis:video.data.analysis,analysis_key:video.data.analysis_key??null,analysis_generation:video.data.analysis_generation??null,archived_at:new Date(this.clock()).toISOString()});
        if(!archive.created){const previous=await this.store.get(`analyses/${id}_previous`);if(!recovery||previous?.data.analysis_key!==video.data.analysis_key||previous?.data.analysis_generation!==video.data.analysis_generation)throw new Error('Histórico da análise já existe; conferir antes de executar.');}
      }
      if(limitedUpload&&!recoverSettled&&!metadataUpload&&!uploadRecovery&&typeof this.operations.prepareUploadRecovery==='function')await this.operations.prepareUploadRecovery({video:{...video.data,id:videoId},executionId:id});
      if(recoverSettled)await this.operations[stage==='upload'?'prepareUploadRecovery':'prepareSettledAnalysisRetry']({video:{...video.data,id:videoId},executionId:id,originalExecutionId:originalId});
      if(stage==='analysis'&&typeof this.operations.prepareAnalysis==='function')await this.operations.prepareAnalysis({video:{...video.data,id:videoId},executionId:id});
      if(metadataUpload)await this.operations.prepareUploadRecovery({video:{...video.data,id:videoId},executionId:id});
      if(metadataTranscription){await this.ledger.transition(id,'start');started=true;}else if(uploadRecovery){await this.operations.prepareUploadRecovery({video:{...video.data,id:videoId},executionId:id});await this.ledger.resumeUpload(id);started=true;}else if(recovery429){await this.ledger.resumeAnalysis429(id);started=true;}else{
        await this.ledger.reserve({executionId:id,videoId,stage,maximumCents,...(revision?{analysisRevision:revision}:{}),...(recoverSettled?{recoveryOf:originalId,recoveryId,settledRetry:true}:metadataUpload?{recoveryOf:originalId,recoveryId}:{})});
        await save({status:'reserved'});
        await this.ledger.transition(id,'start');started=true;
      }
      await save({status:'started'});
      if(limitedUpload)adapterCalls++;
      const result=await operation({...(limitedUpload?{recordAcquisitionExtraction:()=>{if(extractions)throw Error('Extração duplicada bloqueada.');extractions++;extractionEndUnconfirmed=true;return ()=>{extractionEndUnconfirmed=false;};}}:{}),video:{...video.data,id:videoId},executionId:id,...(stage==='analysis'?{analysisAttempts,recordAnalysisAttempts:async history=>{if(history.at(-1)?.status==='started'){const controls=(await this.store.get('settings/automation'))?.data;if(!controls?.enabled||!controls.analysis_enabled)throw Error('Análise pausada durante espera.');}await save({analysis_attempts:history});}}:{})});
      if(!ownsResult(result,videoId,stage))throw new Error('Resultado não pertence à tarefa.');
      if(result.operation_name){
        if(stage!=='transcription'||typeof result.operation_name!=='string'||!/^projects\/(?:megabrain-v0-1017370021431|711042421394)\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_-]+$/.test(result.operation_name))throw new Error('Operação assíncrona inválida.');
        await save({status:'waiting',operation_name:result.operation_name});
        return {status:'waiting',execution_id:id};
      }
      return await this.finish({path,id,videoId,stage,result,maximumCents});
    }catch(error){
      const diagnostic=failureDiagnostic(error);
      if(started&&stage==='upload'&&this.autoHoldTerminalSources&&this.batchId&&terminalSourceFailure(diagnostic)&&typeof this.operations.sourceFailureMediaAbsent==='function'){
        try{
          const current=await this.store.get(`videos/${videoId}`);
          if(await this.operations.sourceFailureMediaAbsent({video:{...current.data,id:videoId}})!==true)throw Error('Ausência de mídia não confirmada.');
          await save({status:'uncertain',failure_diagnostic:diagnostic,source_hold_proof:{media_absent:true,review_record:`analyses/ig_error_${videoId}`}});
          await this.store.patch(`videos/${videoId}`,{status:'needs_attention',instagram_review_status:'awaiting_user_verdict',instagram_error_case:`ig_error_${videoId}`,error:'Falha de origem registrada para seu veredito; nenhuma análise executada.',updated_at:new Date(this.clock()).toISOString()},{updateTime:current.updateTime});
          await recordSourceHold(this.store,{videoId,executionId:id,diagnostic,observedAt:new Date(this.clock()).toISOString()});
          await this.ledger.settleTerminalSourceFailure(id);
          return {status:'source_held',execution_id:id};
        }catch{try{await this.ledger.pauseFailedSourceReconciliation(id);}catch{/* Failed writes remain uncertain; no automatic replay. */}}
      }
      if(started){try{await this.ledger.transition(id,'uncertain');}catch{/* An open started reservation also prevents replay. */}}
      await save({status:started?'uncertain':'blocked',failure_diagnostic:failureDiagnostic(error)});
      const current=await this.store.get(`videos/${videoId}`);
      await this.store.patch(`videos/${videoId}`,{status:'needs_attention',error:started?'Etapa interrompida; resultado e reserva precisam de conferência.':'Etapa bloqueada antes de executar; confira configuração e reserva.',updated_at:new Date(this.clock()).toISOString()},{updateTime:current.updateTime});
      return {status:started?'uncertain':'blocked',execution_id:id};
    }finally{
      // All operation, persistence and error-cleanup promises above have settled.
      // A hard kill or failed evidence write leaves recovery blocked. No replay.
      const acquisitionMetrics={duration_ms:Math.max(0,Math.round(this.clock()-acquisitionStarted)),adapter_calls:adapterCalls,extractions};
      if(limitedUpload&&acquired&&extractionEndUnconfirmed){
        // A rejected execFile promise may leave descendants alive. Neither
        // timeout nor directory cleanup is positive process-tree end evidence.
        try{await save({acquisition_end_status:'unconfirmed',acquisition_metrics:acquisitionMetrics});}catch{/* Capacity stays held even if this diagnostic write fails. */}
      }else if(attemptId&&(!limitedUpload||acquired)){
        try{await this.recordExecutionStopped({executionId:id,videoId,stage,attemptId,...(limitedUpload?{acquisitionMetrics}:{})});}catch{/* Verification below may recover a lost receipt, never missing evidence. */}
        if(limitedUpload)try{await this.acquisition.release({executionId:id,videoId,attemptId});}catch{/* Unknown evidence or release receipt stays held for explicit reconciliation. */}
      }
    }
  }
  async reconcileAnalysis({videoId,authorizationRef,executionId:requestedId}){
    if(!validId(videoId)||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(authorizationRef??''))throw Error('Autorização explícita obrigatória.');
    const f=(await this.store.get('settings/financial'))?.data;
    // Persisting an already received result does not enable paid work or the queue.
    if(!f)return {status:'blocked',reason:'missing_financial_state'};
    if(this.eligibleVideos&&!this.eligibleVideos.has(videoId)||this.batchId&&(f.batch?.id!==this.batchId||!f.batch.video_ids.includes(videoId)))return {status:'blocked',reason:'outside_active_batch'};
    const stage='analysis',originalId=executionId(videoId,stage,this.analysisRevision),id=requestedId??originalId;
    if(id!==originalId&&id!==settledRetryId(originalId))return {status:'blocked',reason:'result_execution_mismatch'};
    const path=`jobs/${id}`,j=await this.store.get(path),video=await this.store.get(`videos/${videoId}`),reservation=f.jobs?.[id],parent=f.jobs?.[originalId],child=id!==originalId;
    if(child&&(j?.data.recovery_of!==originalId||j.data.settled_retry_count!==1||j.data.recovery_authorization!==settledRetryAuthorizationPath(originalId)||reservation?.recovery_of!==originalId||reservation.recovery_kind!=='settled_retry_v1'||parent?.status!=='completed'||parent.recovery_of||parent.video_id!==videoId||parent.stage!==stage||parent.actual_cents!==parent.maximum_cents||parent.maximum_cents!==reservation.maximum_cents||parent.batch_id!==reservation.batch_id||parent.analysis_revision!==this.analysisRevision||reservation.analysis_revision!==this.analysisRevision||parent.manual_reconciliation!=='confirmed_schema400_full_estimate_accounted_analysis_pending'))return {status:'blocked',reason:'result_retry_linkage_mismatch'};
    const conflicting=Object.entries(f.jobs??{}).some(([key,value])=>key!==id&&value.video_id===videoId&&value.stage===stage&&value.status!=='cancelled'&&!(value.status==='completed'&&(child&&key===originalId||(value.analysis_revision??null)!==(this.analysisRevision??null))));
    if(!j||!video||j.data.video_id!==videoId||j.data.stage!==stage||!['started','uncertain','completed','reconciling_result','reconciliation_failed'].includes(j.data.status)||!['started','uncertain','completed'].includes(reservation?.status)||reservation.video_id!==videoId||reservation.stage!==stage||reservation.maximum_cents!==this.quotes.analysis||conflicting||typeof this.operations.restoreAnalysisResult!=='function')return {status:'blocked',reason:'result_requires_reconciliation'};
    if(video.data.analysis_quality_status==='accepted'&&video.data.analysis_key===`results/instagram/${videoId}/${id}/analysis.json`&&j.data.status==='completed')return {status:'completed',duplicate:true};
    const resuming=['reconciling_result','reconciliation_failed'].includes(j.data.status);
    const acquisitionProof=resuming?j.data.reconciliation_stop_proof:null;
    // A legacy resume status is not evidence that an earlier worker stopped.
    if(resuming&&(!j.data.execution_attempt_id||acquisitionProof?.execution_id!==id||typeof acquisitionProof.claim_update_time!=='string'||!acquisitionProof.claim_update_time))return {status:'blocked',reason:'execution_stop_unconfirmed'};
    let stopProof=null;
    if(resuming||['started','uncertain','completed'].includes(j.data.status)&&(j.data.status==='started'||typeof this.recordExecutionStopped==='function'||j.data.execution_attempt_id)){
      // A saved response proves the provider replied, not that its worker stopped.
      if(typeof this.verifyExecutionStopped!=='function')return {status:'blocked',reason:'execution_stop_unconfirmed'};
      let proof;try{proof=await this.verifyExecutionStopped({executionId:id,videoId,stage,claimUpdateTime:j.updateTime,authorizationRef});}catch{return {status:'blocked',reason:'execution_stop_unconfirmed'};}
      if(proof?.ended!==true||proof.execution_id!==id||proof.claim_update_time!==j.updateTime||!/^[A-Za-z0-9][A-Za-z0-9_:#./-]{4,199}$/.test(proof.evidence_ref??'')||resuming&&proof.evidence_ref!==acquisitionProof.evidence_ref)return {status:'blocked',reason:'execution_stop_unconfirmed'};
      // Keep the original acquisition version: subsequent CAS writes deliberately
      // change the claim version, but cannot rebind immutable end evidence.
      stopProof=resuming?acquisitionProof:{execution_id:id,claim_update_time:j.updateTime,evidence_ref:proof.evidence_ref,verified_at:new Date(this.clock()).toISOString()};
    }
    const result=await this.operations.restoreAnalysisResult({video:{...video.data,id:videoId},executionId:id});
    if(!ownsResult(result,videoId,stage)||result.artifact?.key!==`results/instagram/${videoId}/${id}/analysis.json`||!/^\d+$/.test(result.artifact.generation??''))throw Error('Artefato da própria execução obrigatório.');
    await this.store.patch(path,{status:'reconciling_result',original_failure_diagnostic:j.data.original_failure_diagnostic??j.data.failure_diagnostic??null,result_artifact:result.artifact,reconciliation_authorization_ref:authorizationRef,...(stopProof?{reconciliation_stop_proof:stopProof}:{})},{updateTime:j.updateTime});
    try{return await this.finish({path,id,videoId,stage,result,maximumCents:this.quotes.analysis,reconcile:true});}
    catch(error){const current=await this.store.get(path);await this.store.patch(path,{status:'reconciliation_failed'},{updateTime:current.updateTime});throw error;}
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
  async finish({path,id,videoId,stage,result,maximumCents,reconcile=false}){
    if(!Number.isSafeInteger(result.actual_cents)||result.actual_cents<0||result.actual_cents>maximumCents)throw new Error('Custo precisa de reconciliação.');
    const allowed=stage==='upload'?['video_key','video_generation','video_bytes','media_verified','audio_status','duration_seconds','source_caption','caption_status']:stage==='transcription'?['transcript','transcript_status','transcript_key','transcript_generation']:['analysis','analysis_key','analysis_generation','source_caption','caption_status','analysis_quality_status','analysis_review_reasons','analysis_candidate','candidate_analysis_key','candidate_analysis_generation'];
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
    await this.store.patch(`videos/${videoId}`,{...changes,status:stage==='upload'?'downloaded':stage==='transcription'?'transcribed':changes.analysis_quality_status==='review_required'?'needs_attention':'analyzed',error:changes.analysis_quality_status==='review_required'?'Resposta recebida com problemas de qualidade; confira o candidato preservado. A análise publicada não foi substituída.':null,updated_at:new Date(this.clock()).toISOString(),...(stage==='upload'?{has_audio:true,instagram_review_status:null,instagram_error_case:null,retry_status:'completed'}:{})},{updateTime:video.updateTime});
    // Persist result before settling. A later failure holds the reservation and
    // requires reconciliation; it never re-runs inference to recover bookkeeping.
    if(reconcile)await this.ledger.reconcileAnalysisResult(id,{actualCents:result.actual_cents});
    else await this.ledger.transition(id,'complete',{actualCents:result.actual_cents,...(reviewRequired&&(await this.store.get('settings/financial'))?.data?.batch?.video_ids.length===262?{pause:true}:{})});
    const job=await this.store.get(path);await this.store.patch(path,{status:'completed',completed_at:new Date(this.clock()).toISOString()},{updateTime:job.updateTime});
    return {status:'completed',execution_id:id};
  }
}
