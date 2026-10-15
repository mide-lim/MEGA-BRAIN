// Internal server evidence only. No timer, request disconnect or artifact lookup
// can attest that an attempt ended. The producer runs after awaited work exits.
const jobId=id=>typeof id==='string'&&/^job_[a-f0-9]{64}$/.test(id);
const attemptId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const videoId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
const pathFor=(id,attempt)=>`execution_stops/${id}_${attempt}`;
export class ExecutionStops {
  constructor({store,analysisRevision=null,clock=()=>Date.now()}){
    if(!store||![null,'megabrain-video-text-v3','megabrain-video-text-v4'].includes(analysisRevision))throw Error('Persistência e revisão de encerramento obrigatórias.');
    Object.assign(this,{store,analysisRevision,clock});
  }
  matches(claim,{executionId,videoId:id,stage,attemptId:attempt}){
    return jobId(executionId)&&videoId(id)&&['analysis','upload'].includes(stage)&&attemptId(attempt)&&claim?.data.video_id===id&&claim.data.stage===stage&&claim.data.execution_attempt_id===attempt&&claim.data.analysis_revision===(stage==='analysis'?this.analysisRevision:null)&&typeof claim.updateTime==='string'&&!!claim.updateTime;
  }
  async record({executionId,videoId,stage,attemptId,acquisitionMetrics}){
    const claim=await this.store.get(`jobs/${executionId}`);
    if(!this.matches(claim,{executionId,videoId,stage,attemptId}))return false;
    // Create-only: an old attempt can never overwrite another attempt's proof.
    const proof={schema_version:1,ended:true,execution_id:executionId,attempt_id:attemptId,video_id:videoId,stage,analysis_revision:stage==='analysis'?this.analysisRevision:null,claim_update_time:claim.updateTime,ended_at:new Date(this.clock()).toISOString()};
    if(stage==='upload'&&acquisitionMetrics){
      const m=acquisitionMetrics;
      if(!Number.isSafeInteger(m.duration_ms)||m.duration_ms<0||![0,1].includes(m.adapter_calls)||![0,1].includes(m.extractions))return false;
      proof.acquisition={duration_ms:m.duration_ms,adapter_calls:m.adapter_calls,extractions:m.extractions,outcome:['completed','uncertain','blocked'].includes(claim.data.status)?claim.data.status:'interrupted',diagnostic_ref:`jobs/${executionId}`};
    }
    return (await this.store.create(pathFor(executionId,attemptId),proof)).created;
  }
  async verify({executionId,videoId,stage,claimUpdateTime}){
    if(!jobId(executionId))return null;
    const claim=await this.store.get(`jobs/${executionId}`),attempt=claim?.data.execution_attempt_id;
    if(!this.matches(claim,{executionId,videoId,stage,attemptId:attempt})||claim.updateTime!==claimUpdateTime)return null;
    const evidenceRef=pathFor(executionId,attempt),proof=(await this.store.get(evidenceRef))?.data;
    const resuming=['reconciling_result','reconciliation_failed'].includes(claim.data.status),acquisition=claim.data.reconciliation_stop_proof;
    if(resuming&&(acquisition?.execution_id!==executionId||acquisition.evidence_ref!==evidenceRef||typeof acquisition.claim_update_time!=='string'||!acquisition.claim_update_time||typeof acquisition.verified_at!=='string'||!Number.isFinite(Date.parse(acquisition.verified_at))||Date.parse(acquisition.verified_at)>this.clock()))return null;
    // A resumed CAS uses the current version; its acquisition must still match
    // the immutable evidence for the original ended attempt, not that new version.
    const endedClaimVersion=resuming?acquisition.claim_update_time:claimUpdateTime;
    if(proof?.schema_version!==1||proof.ended!==true||proof.execution_id!==executionId||proof.attempt_id!==attempt||proof.video_id!==videoId||proof.stage!==stage||proof.analysis_revision!==(stage==='analysis'?this.analysisRevision:null)||proof.claim_update_time!==endedClaimVersion||typeof proof.ended_at!=='string'||!Number.isFinite(Date.parse(proof.ended_at))||Date.parse(proof.ended_at)>this.clock())return null;
    return {ended:true,execution_id:executionId,claim_update_time:claimUpdateTime,evidence_ref:evidenceRef};
  }
}
