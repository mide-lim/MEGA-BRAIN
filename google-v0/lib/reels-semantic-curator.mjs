import {semanticContractSpec as spec} from './reels-semantic-contract-definition.mjs';
import {frozenSemanticSourceFromSaved} from './reels-semantic-source-v1.mjs';
import {validateSemanticSourceRecovery,semanticSourceRecoveryPath,semanticSourceRecoveryVersion,validateSemanticSourceRecoveryMember,semanticSourceRecoveryReceiptValid,projectRecoveredSemanticOutput,validateSemanticPromptTransition} from './reels-semantic-source-recovery.mjs';
import {semanticCalibrationReceiptValid} from './reels-semantic-calibration.mjs';
import {randomUUID} from 'node:crypto';
import {ReelsCatalogueRuntime,catalogueEditorialForItem} from './reels-contextual-catalogue-runtime.mjs';
import {semanticHash,semanticPolicy,semanticPolicyPath,semanticPolicyVersion,semanticSourceFromSaved,semanticEditorial,prepareSemanticPlan} from './reels-semantic-source.mjs';
import {validateSemanticOutput,validateSemanticVerificationEvidence,automaticSemanticPromotion,semanticContractVersion} from './reels-semantic-contract.mjs';
import {parseSavedSemanticResponse,semanticPromptHash} from './reels-semantic-provider.mjs';
const list=v=>Array.isArray(v)?v:[];
const clone=v=>structuredClone(v);
const problem=(code,message,status=409)=>Object.assign(Error(message),{code,status});
const compactEvidence=(m,resultId,proposalId,type='member')=>({...m,evidence:[],evidenceCount:list(m.evidence).length,proofSourceBindings:Object.fromEntries(list(m.evidence).map(p=>[p.source,p.sourceIdentity])),evidenceRef:{resultId,proposalId,type}});
const compactDecision=d=>({reelId:d.reelId,verdict:d.verdict,semanticProofHash:d.semanticProofHash,resultId:d.resultId});
const compactGroup=g=>({...g,definition:String(g.definition??'').slice(0,600),aliases:list(g.aliases).slice(0,4).map(x=>x.slice(0,80)),positiveCriteria:list(g.positiveCriteria).slice(0,2).map(x=>x.slice(0,200)),negativeCriteria:list(g.negativeCriteria).slice(0,2).map(x=>x.slice(0,200)),projection:{bounded:true,fullDefinitionHash:semanticHash(g),limits:{definition:600,aliases:4,criteria:2,criterionCharacters:200}}});
const groupPath=id=>'reels_index/semantic_group_'+id;
const jobPath=id=>'reels_index/semantic_job_'+id;
const resultPath=id=>'reels_index/semantic_result_'+id;
const validHash=id=>/^[a-f0-9]{64}$/.test(id??'');
const sourceCurrent=(a,b)=>semanticHash(a??{})===semanticHash(b??{});
const publicJob=j=>({id:j.id,status:j.status,phase:j.phase,total:j.total??j.pins?.length??0,processed:j.cursor,callsUsed:j.callsUsed,maxCalls:j.maxCalls,uncertain:j.status==='uncertain',dispatch:j.dispatch,reason:j.reason??null,createdAt:j.createdAt,updatedAt:j.updatedAt,cohortHash:j.cohortHash,model:j.policy.model,verifierModel:j.policy.verifierModel,verificationProcessed:j.verifyCursor??0,proposalOverflowCount:list(j.proposalOverflow).length,coverageLimit:j.coverageLimit??null});
export class ReelsSemanticCurator{
 constructor({repository,provider=null,enqueue=null,clock=Date.now,leaseMs=180000}){
  if(!repository?.store)throw Error('Curador semântico exige repositório.');
  this.repository=repository;this.store=repository.store;this.provider=provider;this.enqueue=enqueue;this.clock=clock;this.leaseMs=leaseMs;
  this.catalogue=repository.catalogueRuntime??new ReelsCatalogueRuntime({repository,clock});
  repository.semanticCurator=this;
 }
 now(){return new Date(this.clock()).toISOString();}
 async scan(kind,select){const rows=[];let cursor;const seen=new Set();do{const page=await this.store.query('reels_index',{filters:[{field:'kind',op:'eq',value:kind}],select,limit:500,cursor});rows.push(...page.records);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Curadoria não avançou.');if(cursor)seen.add(cursor);}while(cursor);return rows;}
 async policy(){const snapshot=await this.store.get(semanticPolicyPath);return {snapshot,data:semanticPolicy(snapshot?.data)};}
 async inventory(){const s=await this.repository.contextualContributions();return {...s,inventory:s.items.map(i=>({id:i.id,publicationAvailable:true,sourceVersions:s.sourceVersions.get(i.id)}))};}
 async plan(selection){const [s,p]=await Promise.all([this.inventory(),this.policy()]);return {source:s,policySnapshot:p.snapshot,...prepareSemanticPlan({inventory:s.inventory,selection,policy:p.data,observedAt:this.now()})};}
 async preview(selection){const p=await this.plan(selection);return {preview:{...p.preview,previewHash:p.previewHash},previewHash:p.previewHash,inferenceStarted:false,observedAt:this.now()};}
 async commit(checks,writes){if(typeof this.store.commitSemantic!=='function')throw problem('SEMANTIC_STORE_UNAVAILABLE','Persistência transacional da curadoria indisponível.',503);const r=await this.store.commitSemantic({checks,writes});if(r?.applied!==true)throw problem('SEMANTIC_VERSION_CHANGED','Fontes ou edição mudaram; a operação permanece preservada.');return r;}
 dispatchFor(id,sequence,status='pending'){return {sequence,outboxId:semanticHash({jobId:id,sequence}),status,reason:null};}
 async create(input){
  if(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>160||!validHash(input.previewHash))throw problem('INVALID_SEMANTIC_COMMAND','Confirme uma prévia válida.',400);
  const id=semanticHash({kind:'semantic_job',key:input.idempotencyKey}),path=jobPath(id),existing=await this.store.get(path),fingerprint=semanticHash({selection:input.selection,previewHash:input.previewHash});
  if(existing){if(existing.data.fingerprint!==fingerprint)throw problem('IDEMPOTENCY_CONFLICT','Chave usada para outra seleção.');await this.dispatch(existing.data);return {job:publicJob((await this.store.get(path)).data),created:false};}
  const p=await this.plan(input.selection);
  if(p.previewHash!==input.previewHash)throw problem('SEMANTIC_PREVIEW_CHANGED','A prévia mudou; confira o novo conjunto.');
  if(!p.preview.providerEnabled)throw problem('SEMANTIC_NOT_AUTHORIZED','A curadoria aguarda autorização finita, modelos e fila próprios.',423);
  const authorizationPath='reels_index/semantic_authorization_'+semanticHash(p.policy.authorizationId),authorization=await this.store.get(authorizationPath);if(authorization)throw problem('SEMANTIC_AUTHORIZATION_CONSUMED','Esta autorização finita já foi utilizada.');
  const coordinatorPath='reels_index/semantic_coordinator',coordinator=await this.store.get(coordinatorPath);
  if(coordinator){const previous=await this.store.get(jobPath(coordinator.data.jobId));if(coordinator.data.authorizationId===p.policy.authorizationId||previous&&['prepared','running','paused','uncertain'].includes(previous.data.status))throw problem('SEMANTIC_JOB_ALREADY_EXISTS','Esta autorização já tem uma curadoria ou resultado que exige conferência.');}
  const now=this.now(),job={kind:'semantic_job',schemaVersion:1,id,fingerprint,status:'prepared',total:p.pins.length,phase:'extract',cursor:0,verifyCursor:0,pins:p.pins,cohortHash:p.preview.cohortHash,previewHash:p.previewHash,policy:p.policy,policyHash:semanticHash(p.policy),promptHash:semanticPromptHash,policyVersion:p.policySnapshot.updateTime,maxCalls:p.preview.maximumCalls,callsUsed:0,dispatch:this.dispatchFor(id,0),batch:null,createdAt:now,updatedAt:now};
  await this.commit([{path,updateTime:null},{path:authorizationPath,updateTime:null},{path:coordinatorPath,updateTime:coordinator?.updateTime??null},{path:semanticPolicyPath,updateTime:p.policySnapshot.updateTime}], [{path,data:job},{path:authorizationPath,data:{kind:'semantic_authorization',authorizationId:p.policy.authorizationId,jobId:id,cohortHash:p.preview.cohortHash,promptHash:semanticPromptHash,maximumCalls:p.preview.maximumCalls,consumedAt:now}},{path:coordinatorPath,data:{kind:'semantic_coordinator',jobId:id,authorizationId:p.policy.authorizationId,cohortHash:p.preview.cohortHash,createdAt:now}}]);
  await this.dispatch(job);return {job:publicJob((await this.store.get(path)).data),created:true};
 }
 async dispatch(job){
  if(!['prepared','running'].includes(job.status))return {status:'not_needed'};
  if(typeof this.enqueue!=='function')return {status:'pending',reason:'CURATION_TRANSPORT_NOT_CONFIGURED'};
  let outcome;try{outcome=await this.enqueue(clone(job));}catch{outcome={status:'pending',reason:'CURATION_DISPATCH_PENDING'};}
  const current=await this.store.get(jobPath(job.id));
  if(current?.data.dispatch.outboxId===job.dispatch.outboxId&&current.data.status!== 'completed')try{await this.commit([{path:jobPath(job.id),updateTime:current.updateTime}],[{path:jobPath(job.id),data:{...current.data,dispatch:{...current.data.dispatch,status:outcome?.status==='sent'?'sent':'pending',reason:outcome?.reason??null},updatedAt:this.now()}}]);}catch{}
  return outcome;
 }
 async currentGroups(){return (await this.scan('semantic_group',['kind','id','key','name','context','parentId','dimension','groupKind','definition','aliases','positiveCriteria','negativeCriteria','members','negativeExamples','possibleDuplicates','status','reason','revision','protected','manual','verification','updatedAt','policyHash','jobIds','originJobId','activationMinimum'])).map(r=>({...r,data:{...r.data,kind:r.data.groupKind}}));}
 async loadSources(pins,{recovery=null}={}){
  const results=new Array(pins.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(8,pins.length)},async()=>{while(cursor<pins.length){const index=cursor++,pin=pins[index],source=await this.catalogue.loadSource(pin.id);if(!source?.item.publication.available||!sourceCurrent(pin.sourceVersions,source.sourceVersions))throw problem('SEMANTIC_SOURCE_CHANGED','Uma publicação ou edição mudou; não reanalisar automaticamente.');const extracted=semanticSourceFromSaved(source),legacySource=frozenSemanticSourceFromSaved(source);if(pin.editorialHash&&pin.editorialHash!==extracted.editorialHash)throw problem('SEMANTIC_SOURCE_CHANGED','Edição diverge do envio salvo.');if(pin.sourceProjectionVersion&&pin.sourceProjectionVersion!==extracted.sourceProjectionVersion)throw problem('SEMANTIC_SOURCE_CHANGED','Versão da projeção mudou.');if(pin.semanticProofHash&&pin.semanticProofHash!==extracted.semanticProofHash){if(!recovery||!validateSemanticSourceRecovery(recovery.snapshot?.data,{job:recovery.job,saved:recovery.saved,source:extracted,pin,legacySource}))throw problem('SEMANTIC_SOURCE_CHANGED','Prova diverge do envio salvo; recibo exato de reconciliação necessário.');extracted.sourceReconciliation={version:semanticSourceRecoveryVersion,receiptId:recovery.job.batch.id,receiptHash:recovery.snapshot.data.receiptHash,originalSemanticProofHash:pin.semanticProofHash,originalBindingHash:recovery.saved.bindingHash,originalResultId:recovery.saved.id,originalRawHash:recovery.saved.rawHash,canonicalSemanticProofHash:extracted.semanticProofHash,canonicalProjectionVersion:extracted.sourceProjectionVersion};source.checks.push({path:semanticSourceRecoveryPath(recovery.job.batch.id),updateTime:recovery.snapshot.updateTime});}results[index]={source:extracted,legacySource,checks:source.checks};}}));
  return {sources:results.map(r=>r.source),legacySources:new Map(results.map(r=>[r.source.id,r.legacySource])),checks:this.uniqueChecks(results.flatMap(r=>r.checks))};
 }
 uniqueChecks(checks){const m=new Map();for(const c of checks){if(m.has(c.path)&&m.get(c.path)!==c.updateTime)throw problem('SEMANTIC_SOURCE_CHANGED','Revisões divergentes no mesmo lote.');m.set(c.path,c.updateTime);}return [...m].map(([path,updateTime])=>({path,updateTime}));}
 async envelopeSave(batchId,envelope,binding){
  const path=resultPath(batchId),existing=await this.store.get(path);if(existing){if(existing.data.bindingHash!==semanticHash(binding))throw Error('Resposta salva pertence a outra chamada.');return existing;}
  const raw=JSON.stringify(envelope.rawResponse),rawHash=semanticHash(envelope.rawResponse);if(typeof raw!=='string'||raw.length>2000000)throw Object.assign(Error('Resposta paga excedeu armazenamento seguro; conferir sem repetir.'),{requiresReconciliation:true});
  const parts=[];for(let i=0;i<raw.length;i+=180000){const chunkPath='reels_index/semantic_raw_'+batchId+'_'+parts.length,part=raw.slice(i,i+180000),old=await this.store.get(chunkPath);if(old&&old.data.sha256!==semanticHash(part))throw Error('Fragmento semântico diverge.');if(!old)await this.store.create(chunkPath,{kind:'semantic_raw',batchId,index:parts.length,text:part,sha256:semanticHash(part)});parts.push(chunkPath);}
  const data={kind:'semantic_result',id:batchId,binding,bindingHash:semanticHash(binding),rawHash,rawChunks:parts,model:envelope.model,requestHash:envelope.requestHash??null,usage:envelope.usage??null,providerResponseId:envelope.providerResponseId??null,phase:envelope.phase,receivedAt:this.now(),processed:false};
  await this.store.create(path,data);const saved=await this.store.get(path);if(!saved||saved.data.bindingHash!==data.bindingHash||saved.data.rawHash!==rawHash)throw Object.assign(Error('Resposta paga sem confirmação durável.'),{requiresReconciliation:true});return saved;
 }
 async envelopeRead(saved,{checks=null}={}){const chunks=[];for(const p of saved.data.rawChunks){const c=await this.store.get(p);if(!c||semanticHash(c.data.text)!==c.data.sha256)throw Error('Resposta salva incompleta.');if(checks)checks.push({path:p,updateTime:c.updateTime});chunks.push(c.data.text);}const rawResponse=JSON.parse(chunks.join(''));if(semanticHash(rawResponse)!==saved.data.rawHash)throw Error('Checksum de resposta diverge.');return {...saved.data,rawResponse};}
 async authorizationLedger(job){
  const path='reels_index/semantic_authorization_'+semanticHash(job.policy.authorizationId),snapshot=await this.store.get(path),data=snapshot?.data;if(!data||data.kind!=='semantic_authorization'||data.jobId!==job.id||data.authorizationId!==job.policy.authorizationId||data.cohortHash!==job.cohortHash||data.promptHash!==job.promptHash||data.maximumCalls!==job.maxCalls)throw problem('SEMANTIC_AUTHORIZATION_LEDGER_CHANGED','A autorização consumida não corresponde ao trabalho.');return {path,...snapshot};
 }
 async promptAuthorization(job){
  const ledger=await this.authorizationLedger(job),ledgerCheck={path:ledger.path,updateTime:ledger.updateTime};
  if(job.promptHash===semanticPromptHash)return {checks:[ledgerCheck],receipt:null,transitionHash:null};
  const firstId=semanticHash({jobId:job.id,phase:'extract',cursor:0}),path=semanticSourceRecoveryPath(firstId),[recovery,original]=await Promise.all([this.store.get(path),this.store.get(resultPath(firstId))]);
  if(!validateSemanticPromptTransition(recovery?.data,job,original?.data,ledger))throw problem('SEMANTIC_PROMPT_TRANSITION_REQUIRED','A versão do contrato exige transição finita aprovada.');
  return {receipt:recovery.data,transitionHash:recovery.data.transitionHash,checks:[ledgerCheck,{path,updateTime:recovery.updateTime},{path:resultPath(firstId),updateTime:original.updateTime}]};
 }
 async alignmentCheckpointMetadata(job,{inventory=null}={}){
  const cp=job.alignmentCheckpoint;if(job.status!=='paused'||job.reason!=='SEMANTIC_ALIGNMENT_CHECKPOINT'||cp?.status!=='pending_review'||cp.callsUsed!==2||cp.cursor!==16||job.callsUsed!==2||job.cursor!==16||cp.promptHash!==semanticPromptHash)return false;
  try{
   const [p,saved,inv,taxonomy]=await Promise.all([this.policy(),this.store.get(resultPath(cp.resultId)),inventory?Promise.resolve(inventory):this.inventory(),this.store.get('settings/reels_v2_taxonomy')]),auth=await this.promptAuthorization(job),s=saved?.data;
   if(!p.data.enabled||Date.parse(p.data.expiresAt)<=this.clock()||semanticHash(p.data)!==job.policyHash||auth.transitionHash!==cp.transitionHash||!s||s.processed!==true||s.phase!=='extract'||s.bindingHash!==cp.bindingHash||s.rawHash!==cp.rawHash||semanticHash(s.binding)!==s.bindingHash||s.binding.promptHash!==semanticPromptHash||s.binding.promptTransitionHash!==auth.transitionHash||!sourceCurrent(s.binding.pins,cp.pins))return false;
   return cp.pins.length===8&&cp.pins.every(pin=>{const item=inv.items.find(i=>i.id===pin.id);return item&&sourceCurrent(pin.sourceVersions,inv.sourceVersions.get(pin.id))&&pin.editorialHash===semanticHash(semanticEditorial(item,catalogueEditorialForItem(item,taxonomy?.data??{})));});
  }catch{return false;}
 }
 async releaseAlignmentCheckpoint(input){
  if(!validHash(input.jobId))throw problem('INVALID_JOB','Curadoria inválida.',400);
  if(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>160)throw problem('INVALID_COMMAND','Chave de operação obrigatória.',400);
  const receiptPath='reels_index/semantic_alignment_release_'+semanticHash(input.idempotencyKey),fingerprint=semanticHash({action:'advance',jobId:input.jobId}),prior=await this.store.get(receiptPath);
  if(prior){if(prior.data.fingerprint!==fingerprint)throw problem('IDEMPOTENCY_CONFLICT','Chave reutilizada.');return {...await this.job(input.jobId),duplicate:true};}
  const snapshot=await this.store.get(jobPath(input.jobId));if(!snapshot||!await this.alignmentCheckpointMetadata(snapshot.data))throw problem('SEMANTIC_ALIGNMENT_CHECKPOINT_NOT_READY','A conferência desta amostra ainda não autoriza continuação.');
  const job=snapshot.data,cp=job.alignmentCheckpoint,[saved,p]=await Promise.all([this.store.get(resultPath(cp.resultId)),this.policy()]),auth=await this.promptAuthorization(job),loaded=await this.loadSources(cp.pins),checks=[{path:jobPath(job.id),updateTime:snapshot.updateTime},{path:receiptPath,updateTime:null},{path:resultPath(cp.resultId),updateTime:saved.updateTime},{path:semanticPolicyPath,updateTime:p.snapshot.updateTime},...auth.checks,...loaded.checks];
  if(semanticHash(p.data)!==job.policyHash||!p.data.enabled||Date.parse(p.data.expiresAt)<=this.clock()||job.callsUsed>=job.maxCalls||saved.data.bindingHash!==cp.bindingHash||saved.data.rawHash!==cp.rawHash||saved.data.binding.promptTransitionHash!==auth.transitionHash)throw problem('SEMANTIC_ALIGNMENT_CHECKPOINT_NOT_READY','A amostra ou autorização mudou.');
  const output=parseSavedSemanticResponse(await this.envelopeRead(saved,{checks}));validateSemanticOutput(output,loaded.sources,{groups:cp.catalogueAtSubmission??[]});
  const now=this.now(),next={...job,status:'prepared',reason:'SEMANTIC_ALIGNMENT_CHECKPOINT_RELEASED',alignmentCheckpoint:{...cp,status:'released',releasedAt:now,releaseReceipt:receiptPath},updatedAt:now};
  await this.commit(this.uniqueChecks(checks),[{path:jobPath(job.id),data:next},{path:receiptPath,data:{kind:'semantic_alignment_release',fingerprint,jobId:job.id,checkpointHash:semanticHash(cp),resultId:cp.resultId,rawHash:cp.rawHash,bindingHash:cp.bindingHash,transitionHash:auth.transitionHash,releasedAt:now}}]);
  await this.dispatch(next);return this.job(job.id);
 }
 async runDelivery({jobId,sequence,outboxId,maxBatches=1}){
  if(!validHash(jobId)||!Number.isSafeInteger(sequence)||sequence<0||outboxId!==semanticHash({jobId,sequence})||!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>3)throw problem('INVALID_SEMANTIC_DELIVERY','Entrega inválida.',400);
  let snapshot=await this.store.get(jobPath(jobId));if(!snapshot)throw problem('SEMANTIC_JOB_NOT_FOUND','Curadoria não encontrada.',404);
  if(sequence>snapshot.data.dispatch.sequence)throw problem('SEMANTIC_DELIVERY_AHEAD','Entrega fora da sequência.');
  if(sequence<snapshot.data.dispatch.sequence){await this.dispatch(snapshot.data);return {job:publicJob(snapshot.data),duplicate:true};}
  for(let i=0;i<maxBatches;i++){
   snapshot=await this.store.get(jobPath(jobId));const job=snapshot.data;
   if(!['prepared','running'].includes(job.status))return {job:publicJob(job)};
   const p=await this.policy();if(semanticHash(p.data)!==job.policyHash||!p.data.enabled||Date.parse(p.data.expiresAt)<=this.clock()){await this.stop(snapshot,'paused','SEMANTIC_AUTHORIZATION_CHANGED');break;}
   if(job.batch?.status==='submitting'){
    const saved=await this.store.get(resultPath(job.batch.id));
    if(saved){try{await this.applySaved(snapshot,saved);}catch(e){const fresh=await this.store.get(jobPath(job.id));await this.stop(fresh,e.requiresReconciliation?'uncertain':'paused',e.code??'SAVED_RESPONSE_REQUIRES_REVIEW');break;}continue;}
    if(Date.parse(job.batch.leaseUntil)>this.clock())throw problem('SEMANTIC_LEASE_ACTIVE','Entrega já em execução.',503);
    await this.stop(snapshot,'uncertain','PAID_SUBMISSION_OUTCOME_UNCERTAIN');break;
   }
   if(job.callsUsed>=job.maxCalls){await this.stop(snapshot,'paused','FINITE_CALL_BUDGET_EXHAUSTED');break;}
   let loaded;try{loaded=await this.loadSources(job.phase==='consolidate'?job.pins.slice(0,0):job.pins.slice(job.phase==='extract'?job.cursor:job.verifyCursor,(job.phase==='extract'?job.cursor:job.verifyCursor)+job.policy.batchSize));}catch{await this.stop(snapshot,'paused','SEMANTIC_SOURCE_CHANGED');break;}
   let promptAuth;try{promptAuth=await this.promptAuthorization(job);}catch{await this.stop(snapshot,'paused','SEMANTIC_PROMPT_TRANSITION_REQUIRED');break;}
   const groups=await this.currentGroups();
   // Include all current definitions for cross-batch semantic reuse. No fixed
   // regex/word-count classifier substitutes for these provider calls.
   const catalogue={version:semanticPolicyVersion,promptHash:semanticPromptHash,groups:groups.map(g=>compactGroup({id:g.data.id,key:g.data.key,name:g.data.name,context:g.data.context,kind:g.data.kind,dimension:g.data.dimension,definition:g.data.definition,aliases:g.data.aliases,positiveCriteria:g.data.positiveCriteria,negativeCriteria:g.data.negativeCriteria,protected:g.data.protected,manual:g.data.manual,automaticMutable:!g.data.protected&&!g.data.manual&&g.data.status!=='rejected',status:g.data.status}))};
   if(groups.length>128){await this.stop(snapshot,'paused','EXISTING_CATALOGUE_EXCEEDS_REVIEWED_CAP');break;}
   const reviewGroups=groups.filter(g=>g.data.status!=='rejected'&&!g.data.manual&&!g.data.protected),selected=new Set(loaded.sources.map(s=>s.id)),members=reviewGroups.flatMap(g=>list(g.data.members).filter(m=>selected.has(m.id)).map(m=>({groupId:g.data.id,reelId:m.id,role:m.role,unitIds:m.unitIds,evidence:m.evidence,evidenceRef:m.evidenceRef??null,sourceIdentity:m.sourceIdentity,sourceReconciliation:m.sourceReconciliation??null,semanticProofHash:m.semanticProofHash,editorialHash:m.editorialHash,sourceVersions:m.sourceVersions,proofSourceBindings:m.proofSourceBindings??{}}))),negativeExamples=reviewGroups.flatMap(g=>list(g.data.negativeExamples).filter(m=>selected.has(m.id)).map(m=>({groupId:g.data.id,reelId:m.id,reason:m.reason,evidence:m.evidence,evidenceRef:m.evidenceRef??null,sourceIdentity:m.sourceIdentity,sourceReconciliation:m.sourceReconciliation??null,semanticProofHash:m.semanticProofHash,editorialHash:m.editorialHash,sourceVersions:m.sourceVersions,proofSourceBindings:m.proofSourceBindings??{}}))),profiles=[];
   if(job.phase==='verify')try{
    const proofCache=new Map();for(const m of [...members,...negativeExamples]){const full=await this.hydrateEvidence({...m,id:m.reelId},proofCache);m.evidence=full.evidence;delete m.evidenceRef;}
    for(const source of loaded.sources){const p=await this.store.get('reels_index/semantic_profile_'+source.id),saved=p?await this.store.get(resultPath(p.data.resultId)):null,pin=list(saved?.data.binding?.pins).find(x=>x.id===source.id);
     if(!p||!saved||p.data.jobId!==job.id||saved.data.binding.jobId!==job.id||saved.data.binding.phase!=='extract'||p.data.semanticProofHash!==source.semanticProofHash||p.data.editorialHash!==source.editorialHash||!sourceCurrent(pin?.sourceVersions,source.sourceVersions))throw Error('Perfil salvo não corresponde à fonte exata.');
     if(pin.semanticProofHash!==source.semanticProofHash||pin.editorialHash!==source.editorialHash){
      const recoverySnapshot=await this.store.get(semanticSourceRecoveryPath(saved.data.id)),context={...job,batch:{id:saved.data.id,binding:saved.data.binding,bindingHash:saved.data.bindingHash}};
      if(!validateSemanticSourceRecovery(recoverySnapshot?.data,{job:context,saved:saved.data,source,pin,legacySource:loaded.legacySources.get(source.id)})||p.data.sourceReconciliation?.receiptHash!==recoverySnapshot.data.receiptHash||p.data.sourceReconciliation?.originalSemanticProofHash!==pin.semanticProofHash)throw Error('Proveniência reconciliada do perfil não confere.');
      loaded.checks.push({path:semanticSourceRecoveryPath(saved.data.id),updateTime:recoverySnapshot.updateTime});
     }
     loaded.checks.push({path:'reels_index/semantic_profile_'+source.id,updateTime:p.updateTime},{path:resultPath(saved.data.id),updateTime:saved.updateTime});
     const profileRecovery=p.data.sourceReconciliation?await this.store.get(semanticSourceRecoveryPath(saved.data.id)):null,output=projectRecoveredSemanticOutput(parseSavedSemanticResponse(await this.envelopeRead(saved,{checks:loaded.checks})),profileRecovery?.data),original=list(output.profiles).find(x=>x.reelId===source.id);if(!original)throw Error('Unidades salvas ausentes.');profiles.push({...p.data,units:original.units});
    }
   }catch{await this.stop(snapshot,'paused','SEMANTIC_SAVED_PROOF_BINDING_CHANGED');break;}
   const phasePayload=job.phase==='extract'?{sources:loaded.sources,catalogue}:job.phase==='consolidate'?{groups:catalogue.groups}:{sources:loaded.sources,groups:catalogue.groups.filter(g=>reviewGroups.some(r=>r.data.id===g.id)),members,negativeExamples,profiles};
   if(JSON.stringify(phasePayload).length>320000){await this.stop(snapshot,'paused','SEMANTIC_INPUT_LIMIT_BEFORE_SUBMISSION');break;}
   const batchId=semanticHash({jobId,phase:job.phase,cursor:job.phase==='verify'?job.verifyCursor:job.cursor}),binding={jobId,phase:job.phase,cursor:job.phase==='verify'?job.verifyCursor:job.cursor,pins:loaded.sources.map(s=>({id:s.id,sourceProjectionVersion:s.sourceProjectionVersion,semanticProofHash:s.semanticProofHash,sourceVersions:s.sourceVersions,editorialHash:s.editorialHash})),catalogueHash:semanticHash(catalogue),policyHash:job.policyHash,promptHash:semanticPromptHash,promptTransitionHash:promptAuth.transitionHash},batch={id:batchId,status:'submitting',phase:job.phase,offset:binding.cursor,sourceIds:loaded.sources.map(s=>s.id),bindingHash:semanticHash(binding),binding,leaseOwner:randomUUID(),leaseUntil:new Date(this.clock()+this.leaseMs).toISOString(),startedAt:this.now(),groupVersions:groups.map(g=>({path:g.path,updateTime:g.updateTime}))};
   if(typeof this.provider?.[job.phase==='extract'?'infer':job.phase==='consolidate'?'consolidate':'verify']!=='function'){await this.stop(snapshot,'paused','SEMANTIC_PROVIDER_NOT_READY');break;}
   const checks=this.uniqueChecks([{path:jobPath(job.id),updateTime:snapshot.updateTime},{path:semanticPolicyPath,updateTime:p.snapshot?.updateTime??null},...loaded.checks,...promptAuth.checks,...groups.map(g=>({path:g.path,updateTime:g.updateTime}))]);
   const intent={...job,status:'running',batch,callsUsed:job.callsUsed+1,updatedAt:this.now()};
   try{await this.commit(checks,[{path:jobPath(job.id),data:intent}]);}catch{break;}
   const live=await this.store.get(jobPath(job.id));
   try{
    if(!this.provider)throw Error('Provider semântico não configurado.');
    let envelope;
    if(job.phase==='extract')envelope=await this.provider.infer({...phasePayload,requestId:batchId,model:job.policy.model});
    else if(job.phase==='consolidate')envelope=await this.provider.consolidate({...phasePayload,requestId:batchId,model:job.policy.verifierModel});
    else envelope=await this.provider.verify({...phasePayload,requestId:batchId,model:job.policy.verifierModel});
    const saved=await this.envelopeSave(batchId,envelope,binding);await this.applySaved(live,saved);
   }catch(error){const latest=await this.store.get(jobPath(job.id));if(latest?.data.batch?.id===batchId&&latest.data.batch.status==='submitting'){const known=await this.store.get(resultPath(batchId));await this.stop(latest,error.requiresReconciliation?'uncertain':error.status===409?'paused':known?'failed':'uncertain',error.code??(known?'SAVED_RESPONSE_REQUIRES_REVIEW':'PAID_SUBMISSION_OR_PERSISTENCE_UNCERTAIN'));};break;}
  }
  const final=(await this.store.get(jobPath(jobId))).data;await this.dispatch(final);return {job:publicJob((await this.store.get(jobPath(jobId))).data)};
 }
 async stop(snapshot,status,reason){await this.commit([{path:jobPath(snapshot.data.id),updateTime:snapshot.updateTime}],[{path:jobPath(snapshot.data.id),data:{...snapshot.data,status,reason,updatedAt:this.now()}}]);}
 async applySaved(snapshot,saved,{commandReceipt=null,deferContinuation=false}={}){
  const job=snapshot.data,batch=job.batch,currentPolicy=await this.policy();
  if(semanticHash(currentPolicy.data)!==job.policyHash||!currentPolicy.data.enabled||Date.parse(currentPolicy.data.expiresAt)<=this.clock())throw problem('SEMANTIC_AUTHORIZATION_CHANGED','Autorização mudou após a resposta salva.');
  if(!batch||saved.data.id!==batch.id||saved.data.bindingHash!==batch.bindingHash)throw Error('Resultado não pertence ao intent durável.');
  const rawChecks=[],envelope=await this.envelopeRead(saved,{checks:rawChecks});let output;
  try{output=parseSavedSemanticResponse(envelope);}catch(e){await this.stop(snapshot,'failed',e.code??'SAVED_RESPONSE_INVALID');return;}
  const recoverySnapshot=await this.store.get(semanticSourceRecoveryPath(batch.id)),loaded=await this.loadSources(batch.binding.pins,{recovery:{snapshot:recoverySnapshot,job,saved:saved.data}}),groups=await this.currentGroups(),byGroup=new Map(groups.map(g=>[g.data.id,g])),writes=[],checks=[{path:jobPath(job.id),updateTime:snapshot.updateTime},{path:semanticPolicyPath,updateTime:currentPolicy.snapshot.updateTime},{path:resultPath(batch.id),updateTime:saved.updateTime},...loaded.checks,...rawChecks,...groups.map(g=>({path:g.path,updateTime:g.updateTime}))];
  const ledger=await this.authorizationLedger(job);checks.push({path:ledger.path,updateTime:ledger.updateTime});
  if(commandReceipt){checks.push({path:commandReceipt.path,updateTime:null});writes.push(commandReceipt);}
  if(batch.binding.promptHash!==semanticPromptHash){if(saved.data.binding.promptHash!==job.promptHash||!semanticSourceRecoveryReceiptValid(recoverySnapshot?.data)||recoverySnapshot.data.promptHash!==job.promptHash||recoverySnapshot.data.approvedNextPromptHash!==semanticPromptHash)throw problem('SEMANTIC_PROMPT_TRANSITION_REQUIRED','O resultado salvo exige vínculo ao contrato original.');}else if(job.promptHash!==semanticPromptHash){const auth=await this.promptAuthorization(job);if(batch.binding.promptTransitionHash!==auth.transitionHash)throw problem('SEMANTIC_PROMPT_TRANSITION_REQUIRED','O lote não contém a transição aprovada.');checks.push(...auth.checks);}
  output=projectRecoveredSemanticOutput(output,recoverySnapshot?.data);
  // Sources and manual/group definitions must still match the exact submission.
  if(groups.some(g=>batch.groupVersions.find(x=>x.path===g.path)?.updateTime!==g.updateTime)||batch.groupVersions.some(g=>!groups.some(x=>x.path===g.path)))throw problem('SEMANTIC_EDITORIAL_CHANGED','Edição mudou após resposta salva; não repetir inferência.');
  let next={...job,status:deferContinuation?'prepared':'running',reason:deferContinuation?'SAVED_RESPONSE_APPLIED_AWAITING_DELIVERY':null,batch:null,updatedAt:this.now(),dispatch:this.dispatchFor(job.id,job.dispatch.sequence+1)};
  if(job.phase==='extract'){
   const validated=validateSemanticOutput(output,loaded.sources,{groups:groups.map(g=>g.data)});
   for(const profile of validated.profiles){const path='reels_index/semantic_profile_'+profile.reelId,old=await this.store.get(path);checks.push({path,updateTime:old?.updateTime??null});writes.push({path,data:{kind:'semantic_profile',...profile,units:profile.units.map(u=>({...u,evidence:[],evidenceCount:u.evidence.length})),jobId:job.id,resultId:batch.id,promptHash:batch.binding.promptHash,updatedAt:this.now()}});}
   let groupSlots=Math.max(0,128-groups.length);const overflow=[];
   for(const proposal of validated.groups){
    if(!byGroup.has(proposal.id)&&groupSlots--<=0){overflow.push(proposal.id);continue;}
    const old=byGroup.get(proposal.id),prior=old?.data;
    if(prior?.protected||prior?.manual||prior?.status==='rejected')continue;
    const members=new Map(list(prior?.members).map(m=>[m.id,m]));for(const m of proposal.members)if(!m.manualProtected)members.set(m.id,compactEvidence(m,batch.id,proposal.id));
    const negative=new Map(list(prior?.negativeExamples).map(m=>[m.id,m]));for(const m of proposal.negativeExamples)negative.set(m.id,compactEvidence(m,batch.id,proposal.id,'negative'));
    const data={...prior,...proposal,kind:'semantic_group',groupKind:proposal.kind,jobIds:[...new Set([...list(prior?.jobIds),job.id])],originJobId:prior?.originJobId??job.id,members:[...members.values()],negativeExamples:[...negative.values()],revision:(prior?.revision??0)+1,status:prior?.status==='active'?'candidate':'candidate',protected:prior?.protected??false,manual:prior?.manual??false,verification:{status:'pending',members:[],negativeExamples:[]},updatedAt:this.now()};
    const path=groupPath(proposal.id);if(!old)checks.push({path,updateTime:null});writes.push({path,data});
   }
   next.proposalOverflow=[...list(job.proposalOverflow),...overflow];next.proposalLimit=128;next.coverageLimit=overflow.length?'PROPOSALS_RETAINED_IN_RAW_NOT_PROMOTED':job.coverageLimit??null;
   next.cursor=Math.min(job.pins.length,job.cursor+loaded.sources.length);if(next.cursor===job.pins.length)next.phase='consolidate';
   if(job.promptHash!==semanticPromptHash&&job.callsUsed===2&&next.cursor===16&&!job.alignmentCheckpoint){const auth=await this.promptAuthorization(job);checks.push(...auth.checks);next.status='paused';next.reason='SEMANTIC_ALIGNMENT_CHECKPOINT';next.alignmentCheckpoint={version:'semantic-alignment-checkpoint-v1',status:'pending_review',resultId:batch.id,rawHash:saved.data.rawHash,bindingHash:saved.data.bindingHash,promptHash:batch.binding.promptHash,transitionHash:auth.transitionHash,pins:batch.binding.pins,callsUsed:2,cursor:16,catalogueAtSubmission:groups.map(g=>({id:g.data.id,key:g.data.key,kind:g.data.kind,context:g.data.context,dimension:g.data.dimension??null,name:g.data.name,aliases:list(g.data.aliases)})),createdAt:this.now()};}
  }else if(job.phase==='consolidate'){
   if(output.version!==1||!Array.isArray(output.resolutions)||output.resolutions.length!==groups.length)throw Error('Consolidação global incompleta.');
   const decisions=new Map();for(const d of output.resolutions){if(!byGroup.has(d.groupId)||decisions.has(d.groupId)||!['keep','merge','reject'].includes(d.decision)||(typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>spec.limits.resolutionReason))throw Error('Consolidação inválida.');decisions.set(d.groupId,d);}
   const mutable=new Map(groups.map(g=>[g.data.id,clone(g.data)]));
   for(const d of decisions.values()){
    const source=mutable.get(d.groupId);if(source.protected||source.manual)continue;
    if(d.decision==='reject'){source.status='rejected';source.reason=d.reason;}
    if(d.decision==='merge'){
     const target=mutable.get(d.mergeInto);
     if(!target||target.id===source.id||decisions.get(target.id)?.decision!=='keep'||source.context!==target.context||source.kind!==target.kind||source.dimension!==target.dimension||target.protected||target.manual||target.status==='rejected')throw Error('Merge semântico incompatível ou ciclo.');
     if(target.members.some(m=>list(source.negativeExamples).some(n=>n.id===m.id))||source.members.some(m=>list(target.negativeExamples).some(n=>n.id===m.id)))throw problem('SEMANTIC_MERGE_CONTRADICTORY_EVIDENCE','As provas positivas e negativas do merge entram em conflito.');
     target.members=[...new Map([...target.members,...source.members].map(m=>[m.id,m])).values()];target.negativeExamples=[...new Map([...list(target.negativeExamples),...list(source.negativeExamples)].map(m=>[m.id,m])).values()];target.aliases=[...new Set([...target.aliases,source.name,...source.aliases])];source.status='rejected';source.mergedInto=target.id;source.reason=d.reason;
    }
   }
   for(const g of mutable.values())if(!g.manual&&!g.protected)writes.push({path:groupPath(g.id),data:{...g,kind:'semantic_group',groupKind:g.kind,revision:g.revision+1,consolidationResultId:batch.id,updatedAt:this.now()}});
   next.phase='verify';next.verifyCursor=0;
  }else{
   if(output.version!==1||!Array.isArray(output.members)||!Array.isArray(output.negativeExamples))throw Error('Verificação semântica inválida.');
   const ids=new Set(loaded.sources.map(s=>s.id)),sourceById=new Map(loaded.sources.map(s=>[s.id,s]));
   const validateDecisions=(rows,expected)=>{
    const decisions=new Map();for(const d of rows){const k=d.groupId+':'+d.reelId,s=sourceById.get(d.reelId);if(!expected.has(k)||decisions.has(k)||!['supported','inconclusive','invalid'].includes(d.verdict)||typeof d.reason!=='string'||!Array.isArray(d.evidence))throw Error('Decisão de verificador fora da associação.');
     validateSemanticVerificationEvidence(d,s,{negative:expected.get(k)==='negative'});
     decisions.set(k,{...d,resultId:batch.id,model:envelope.model,requestHash:envelope.requestHash,verifiedAt:this.now(),semanticProofHash:s.semanticProofHash});
    }if(decisions.size!==expected.size)throw Error('Verificador omitiu associações.');return decisions;};
   const expectedMembers=new Map(groups.filter(g=>g.data.status!=='rejected'&&!g.data.manual&&!g.data.protected).flatMap(g=>list(g.data.members).filter(m=>ids.has(m.id)).map(m=>[g.data.id+':'+m.id,'member']))),expectedNegative=new Map(groups.filter(g=>g.data.status!=='rejected'&&!g.data.manual&&!g.data.protected).flatMap(g=>list(g.data.negativeExamples).filter(m=>ids.has(m.id)).map(m=>[g.data.id+':'+m.id,'negative'])));
   const memberDecisions=validateDecisions(output.members,expectedMembers),negativeDecisions=validateDecisions(output.negativeExamples,expectedNegative);
   for(const row of groups){
    const g=row.data;if(g.status==='rejected'||g.protected||g.manual)continue;
    const prior=g.verification??{},m=new Map(list(prior.members).map(x=>[x.reelId,x])),n=new Map(list(prior.negativeExamples).map(x=>[x.reelId,x]));
    for(const d of memberDecisions.values())if(d.groupId===g.id)m.set(d.reelId,compactDecision(d));for(const d of negativeDecisions.values())if(d.groupId===g.id)n.set(d.reelId,compactDecision(d));
    const verified=g.members.every(x=>m.get(x.id)?.verdict==='supported'&&m.get(x.id).semanticProofHash===x.semanticProofHash)&&list(g.negativeExamples).every(x=>n.get(x.id)?.verdict==='supported'&&n.get(x.id).semanticProofHash===x.semanticProofHash),verification={status:verified?'supported':'pending',members:[...m.values()],negativeExamples:[...n.values()],authorModel:job.policy.model,verifierModel:job.policy.verifierModel,independentPhase:true,promptHash:batch.binding.promptHash};
    const promotion=automaticSemanticPromotion({...g,verification},job.policy,{promptHash:batch.binding.promptHash});
    writes.push({path:row.path,data:{...g,kind:'semantic_group',groupKind:g.kind,verification,status:verified&&promotion.allowed?'active':'candidate',reason:verified?promotion.reason:'INDEPENDENT_VERIFICATION_PENDING_OR_INCONCLUSIVE',revision:g.revision+1,activationMinimum:job.policy.minUniqueMembers,updatedAt:this.now(),categoryId:verified&&promotion.allowed&&g.kind!=='facet'?(g.kind==='format'?'ctx_format_'+g.key:'semantic_'+g.id):null}});
   }
   next.verifyCursor=Math.min(job.pins.length,job.verifyCursor+loaded.sources.length);if(next.verifyCursor===job.pins.length){next.status='completed';next.phase='complete';next.dispatch={...next.dispatch,status:'not_needed'};next.completedAt=this.now();}
  }
  writes.push({path:jobPath(job.id),data:next},{path:resultPath(batch.id),data:{...saved.data,processed:true,processedAt:this.now()}});
  await this.commit(this.uniqueChecks(checks),writes);
 }
 async freshGroups(){
  const [rows,inv,taxonomySnapshot,policy]=await Promise.all([this.currentGroups(),this.inventory(),this.store.get('settings/reels_v2_taxonomy'),this.policy()]),versions=inv.sourceVersions,taxonomy=taxonomySnapshot?.data??{};let stale=!!taxonomy.pendingOperationId;
  const recoverySnapshots=new Map();for(const m of rows.flatMap(r=>[...list(r.data.members),...list(r.data.negativeExamples)])){const id=m.sourceReconciliation?.receiptId;if(id&&!recoverySnapshots.has(id)){const snapshot=validHash(id)?await this.store.get(semanticSourceRecoveryPath(id)):null;recoverySnapshots.set(id,snapshot?.data??null);}}
  const current=m=>{if(m.sourceReconciliation&&!validateSemanticSourceRecoveryMember(recoverySnapshots.get(m.sourceReconciliation.receiptId),m))return false;const item=inv.items.find(i=>i.id===m.id);if(!item||!sourceCurrent(m.sourceVersions,versions.get(m.id)))return false;const ed=semanticEditorial(item,catalogueEditorialForItem(item,taxonomy));return m.editorialHash===semanticHash(ed)&&(!ed.manual&&!m.manualProtected||m.manualMembership===true);};
  const groups=rows.map(r=>{
   const negatives=list(r.data.negativeExamples).filter(current),negativeStale=negatives.length!==list(r.data.negativeExamples).length;
   const bound=list(r.data.members).filter(current),memberBindingStale=bound.length!==list(r.data.members).length,members=bound.filter(m=>m.manualMembership===true||['central','supporting'].includes(m.role));if(memberBindingStale)stale=true;
   if(negativeStale)stale=true;
   const automaticInvalid=!r.data.manual&&(negativeStale||memberBindingStale||r.data.status==='active'&&members.length<(r.data.activationMinimum??policy.data.minUniqueMembers)),eligibleStatus=automaticInvalid?'candidate':r.data.status,categoryId=eligibleStatus==='active'&&r.data.kind!=='facet'?(r.data.kind==='format'?'ctx_format_'+r.data.key:'semantic_'+r.data.id):null;
   return {...r.data,status:eligibleStatus,members,negativeExamples:negatives,memberCount:members.length,categoryId,inclusionCriteria:r.data.positiveCriteria,exclusionCriteria:r.data.negativeCriteria,filter:r.data.kind==='facet'?{semanticFacet:r.data.id}:r.data.kind==='format'?{category:'ctx_format_'+r.data.key}:{category:'semantic_'+r.data.id}};
  });
  return {groups,sourceStale:stale,inventory:inv,taxonomySnapshot,observedAt:this.now(),dataAsOf:groups.map(g=>g.updatedAt).filter(Boolean).sort()[0]??this.now()};
 }
 async reconciliationMetadata(j){
  if(j.status!=='paused'||j.batch?.status!=='submitting'||j.phase!=='extract')return false;
  const [saved,receipt]=await Promise.all([this.store.get(resultPath(j.batch.id)),this.store.get(semanticSourceRecoveryPath(j.batch.id))]);const r=receipt?.data,s=saved?.data;
  return !!s&&s.processed===false&&s.id===j.batch.id&&s.bindingHash===j.batch.bindingHash&&s.bindingHash===semanticHash(s.binding)&&semanticSourceRecoveryReceiptValid(r)&&r.jobId===j.id&&r.batchId===j.batch.id&&r.resultId===s.id&&r.originalBindingHash===s.bindingHash&&r.savedRawHash===s.rawHash&&r.requestHash===(s.requestHash??null)&&r.promptHash===j.promptHash&&r.promptHash===s.binding.promptHash&&r.approvedNextPromptHash===semanticPromptHash&&r.rows.length===list(j.batch.binding.pins).length;
 }
 async publicJob(j,{inventory=null}={}){return {...publicJob(j),canReconcileSaved:await this.reconciliationMetadata(j),canContinueAlignmentCheckpoint:await this.alignmentCheckpointMetadata(j,{inventory})};}
 async overview(){
  const [state,p,jobs,profiles]=await Promise.all([this.freshGroups(),this.policy(),this.scan('semantic_job',['kind','id','status','phase','cursor','verifyCursor','callsUsed','maxCalls','policy','total','dispatch','reason','createdAt','updatedAt','cohortHash','proposalOverflow','coverageLimit','batch','promptHash','policyHash','policyVersion','pins','alignmentCheckpoint']),this.scan('semantic_profile',['kind','reelId','state','sourceVersions','semanticProofHash','updatedAt'])]);
  const current=profiles.filter(p=>sourceCurrent(p.data.sourceVersions,state.inventory.sourceVersions.get(p.data.reelId))),unknown=current.filter(p=>p.data.state!=='proposed').length;
  let preview;try{preview=await this.preview({all:true});}catch{preview={preview:{blockingReasons:['SAVED_INVENTORY_UNAVAILABLE']}};}
  const view=g=>({...g,members:undefined,negativeExamples:undefined,verification:g.verification?{status:g.verification.status,authorModel:g.verification.authorModel,verifierModel:g.verification.verifierModel}:null});
  return {policy:{...p.data,calibrationReceipt:undefined,providerConfigured:!!p.data.model&&!!p.data.verifierModel,calibrated:semanticCalibrationReceiptValid(p.data.calibrationReceipt),blockingReasons:preview.preview.blockingReasons},coverage:{published:state.inventory.inventory.length,evaluated:current.length,unknown,pending:Math.max(0,state.inventory.inventory.length-current.length),stale:profiles.length-current.length},jobs:(await Promise.all(jobs.map(r=>this.publicJob(r.data,{inventory:state.inventory})))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),groups:state.groups.map(view),proposals:state.groups.filter(g=>g.status==='candidate').map(view),observedAt:state.observedAt,dataAsOf:state.dataAsOf,sourceStale:state.sourceStale,inferenceOnGet:false};
 }
 async job(id){if(!validHash(id))throw problem('INVALID_JOB','Curadoria inválida.',400);const j=await this.store.get(jobPath(id));if(!j)throw problem('NOT_FOUND','Curadoria não encontrada.',404);return {job:await this.publicJob(j.data),observedAt:this.now(),inferenceOnGet:false};}
 async hydrateEvidence(member,cache=new Map()){
  if(!member.evidenceRef)return member;
  const ref=member.evidenceRef;if(!cache.has(ref.resultId)){const saved=await this.store.get(resultPath(ref.resultId));if(!saved)throw Error('Prova salva ausente.');cache.set(ref.resultId,parseSavedSemanticResponse(await this.envelopeRead(saved)));cache.set('metadata:'+ref.resultId,saved.data);}
  if(member.sourceReconciliation){const recovery=await this.store.get(semanticSourceRecoveryPath(member.sourceReconciliation.receiptId)),metadata=cache.get('metadata:'+ref.resultId);if(!validateSemanticSourceRecoveryMember(recovery?.data,member)||metadata.rawHash!==recovery.data.savedRawHash||metadata.bindingHash!==recovery.data.originalBindingHash)throw Error('Proveniência da citação reconciliada não confere.');}
  const recoveryReceipt=member.sourceReconciliation?await this.store.get(semanticSourceRecoveryPath(member.sourceReconciliation.receiptId)):null,output=projectRecoveredSemanticOutput(cache.get(ref.resultId),recoveryReceipt?.data),proposal=list(output.groups).find(g=>(g.existingGroupId??semanticHash({version:semanticContractVersion,context:g.context,kind:g.kind,dimension:g.dimension??null,key:g.key}))===ref.proposalId),source=list(ref.type==='negative'?proposal?.negativeExamples:proposal?.members).find(m=>m.reelId===member.id);
  if(!source)throw Error('Vínculo da prova salva não corresponde ao membro.');
  return {...member,evidence:list(source.evidence).map(p=>({fieldPath:p.fieldPath,excerpt:p.excerpt,source:p.fieldPath==='caption'?'caption':p.fieldPath==='transcript'?'transcript':'saved_analysis',sourceIdentity:member.proofSourceBindings?.[p.fieldPath==='caption'?'caption':p.fieldPath==='transcript'?'transcript':'saved_analysis']??null,anchorHash:semanticHash({identity:member.sourceIdentity,path:p.fieldPath,excerpt:p.excerpt}),verification:'saved_semantic_result_source_anchor'}))};
 }
 async detail(id,{memberId=null}={}){
  if(!validHash(id))throw problem('INVALID_GROUP','Grupo inválido.',400);const state=await this.freshGroups(),g=state.groups.find(g=>g.id===id);if(!g)throw problem('NOT_FOUND','Grupo não encontrado.',404);
  if(memberId!==null&&!g.members.some(m=>m.id===memberId))throw problem('NOT_FOUND','Membro não encontrado.',404);
  const selected=memberId?g.members.filter(m=>m.id===memberId):g.members.slice(0,20),cache=new Map(),hydrated=new Map();for(const m of selected)hydrated.set(m.id,await this.hydrateEvidence(m,cache));
  const members=g.members.map(m=>({...hydrated.get(m.id)??m,sourceProofHash:m.semanticProofHash,proofAvailable:!!m.evidenceRef||list(m.evidence).length>0})),negatives=[];for(const m of list(g.negativeExamples).slice(0,10))negatives.push(await this.hydrateEvidence(m,cache));
  return {group:{...g,members},members,positiveExamples:members.slice(0,5),negativeExamples:negatives,proofDetails:{hydratedMembers:selected.length,totalMembers:members.length,complete:selected.length===members.length,memberQuery:'memberId',hydratedNegativeExamples:negatives.length,totalNegativeExamples:list(g.negativeExamples).length,negativeComplete:negatives.length===list(g.negativeExamples).length,rawPreserved:true},observedAt:state.observedAt,dataAsOf:state.dataAsOf,sourceStale:state.sourceStale,inferenceOnGet:false};
 }
 async matchingIds(id,{facet=false,state=null}={}){
  state??=await this.freshGroups();const root=state.groups.find(g=>g.id===id&&g.status==='active'&&(facet?g.kind==='facet':g.kind!=='facet'));if(!root)return [];
  const ids=new Set([id]);if(!facet){let changed=true;while(changed){changed=false;for(const g of state.groups)if(g.status==='active'&&!['facet','format'].includes(g.kind)&&(ids.has(g.parentId)||ids.has(String(g.parentId).replace(/^semantic_/,'')))&&!ids.has(g.id)){ids.add(g.id);changed=true;}}}
  return [...new Set(state.groups.filter(g=>ids.has(g.id)&&g.status==='active').flatMap(g=>g.members.map(m=>m.id)))];
 }
 async categoryIds(categoryId,state=null){state??=await this.freshGroups();const parents=new Set([categoryId]),groups=new Set();let changed=true;while(changed){changed=false;for(const g of state.groups)if(g.status==='active'&&g.kind!=='facet'&&(parents.has(g.parentId)||parents.has('semantic_'+g.parentId))&&!groups.has(g.id)){groups.add(g.id);parents.add(g.kind==='format'?'ctx_format_'+g.key:'semantic_'+g.id);changed=true;}}return [...new Set(state.groups.filter(g=>groups.has(g.id)).flatMap(g=>g.members.map(m=>m.id)))];}
 async formatIds(value,state=null){state??=await this.freshGroups();return [...new Set([...state.groups.filter(g=>g.kind==='format'&&g.key===value&&g.status==='active').flatMap(g=>g.members.map(m=>m.id)),...await this.categoryIds('ctx_format_'+value,state)])];}
 async nodes(state=null){state??=await this.freshGroups();const active=state.groups.filter(g=>g.status==='active'&&!['facet','format'].includes(g.kind));return Promise.all(active.map(async g=>({id:'semantic_'+g.id,name:g.name,parentId:validHash(g.parentId)?'semantic_'+g.parentId:g.parentId,count:(await this.matchingIds(g.id,{state})).length,directCount:g.memberCount,manual:g.manual===true,semantic:true,groupId:g.id})));}
 async command(input){
  const common=['action','idempotencyKey'],allowed={preview:['selection'],create:['selection','previewHash'],advance:['jobId'],reconcile_saved:['jobId'],group_create:['name','parentId','definition','aliases'],group_rename:['groupId','revision','name'],group_merge:['groupId','revision','targetId','targetRevision'],group_reject:['groupId','revision'],group_protect:['groupId','revision','protected'],group_approve:['groupId','revision'],group_assign:['groupId','revision','reelIds','addIds','removeIds']}[input?.action];
  if(!allowed||Object.keys(input).some(k=>![...common,...allowed].includes(k)))throw problem('INVALID_SEMANTIC_COMMAND','Ação ou parâmetros inválidos.',400);
  if(input.action==='preview')return this.preview(input.selection);
  if(input.action==='create')return this.create(input);
  if(input.action==='advance')return this.releaseAlignmentCheckpoint(input);
  if(input.action==='reconcile_saved'){
   if(input.idempotencyKey!==undefined&&(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>160))throw problem('INVALID_COMMAND','Chave de operação inválida.',400);
   const commandPath=input.idempotencyKey?'reels_index/semantic_recovery_command_'+semanticHash(input.idempotencyKey):null,fingerprint=semanticHash({action:input.action,jobId:input.jobId}),prior=commandPath?await this.store.get(commandPath):null;
   if(prior){if(prior.data.fingerprint!==fingerprint)throw problem('IDEMPOTENCY_CONFLICT','Chave reutilizada.');return {...await this.job(input.jobId),duplicate:true};}
   const j=await this.store.get(jobPath(input.jobId)),saved=j?.data.batch?await this.store.get(resultPath(j.data.batch.id)):null;if(!j||!saved)throw problem('SEMANTIC_RESULT_NOT_RECEIVED','Nenhum resultado salvo autoriza retomada.');if(!await this.reconciliationMetadata(j.data))throw problem('SEMANTIC_SAVED_RECOVERY_NOT_READY','Resposta salva exige recibo e conferência antes de aplicar.');
   const commandReceipt=commandPath?{path:commandPath,data:{kind:'semantic_recovery_command',fingerprint,jobId:j.data.id,resultId:saved.data.id,rawHash:saved.data.rawHash,bindingHash:saved.data.bindingHash,appliedAt:this.now()}}:null;
   await this.applySaved(j,saved,{commandReceipt,deferContinuation:true});return this.job(input.jobId);
  }
  return this.groupCommand(input);
 }
 async groupCommand(input){
  if(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<8||input.idempotencyKey.length>160)throw problem('INVALID_COMMAND','Chave de operação obrigatória.',400);
  const receiptPath='reels_index/semantic_command_'+semanticHash(input.idempotencyKey),fingerprint=semanticHash(input),prior=await this.store.get(receiptPath);
  if(prior){if(prior.data.fingerprint!==fingerprint)throw problem('IDEMPOTENCY_CONFLICT','Chave reutilizada.');return {group:prior.data.group,duplicate:true};}
  const creating=input.action==='group_create',id=creating?semanticHash({manualGroup:input.idempotencyKey}):input.groupId;if(!validHash(id))throw problem('INVALID_GROUP','Grupo inválido.',400);
  const path=groupPath(id),old=await this.store.get(path),state=await this.freshGroups();
  if(!creating&&(!old||old.data.revision!==input.revision))throw problem('SEMANTIC_GROUP_REVISION_CHANGED','O grupo mudou. Atualize antes de editar.');
  let g=creating?{kind:'semantic_group',groupKind:'segment',dimension:null,id,key:'manual-'+id.slice(0,16),context:'general',name:input.name,parentId:input.parentId,definition:input.definition,aliases:[],positiveCriteria:[],negativeCriteria:[],members:[],negativeExamples:[],status:'active',revision:1,protected:true,manual:true,updatedAt:this.now()}:clone(old.data),checks=[{path,updateTime:old?.updateTime??null},{path:receiptPath,updateTime:null},{path:'settings/reels_v2_taxonomy',updateTime:state.taxonomySnapshot?.updateTime??null}],writes=[];
  const validText=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
  if(creating&&(!validText(g.name,120)||!validText(g.definition,2400)||g.parentId!==null&&!validText(g.parentId,128)))throw problem('INVALID_GROUP','Nome, definição e contexto pai são obrigatórios.',400);
  if(creating){g.aliases=list(input.aliases).filter(x=>validText(x,120)).slice(0,24);const parent=state.groups.find(x=>x.id===g.parentId||'semantic_'+x.id===g.parentId||x.categoryId===g.parentId);if(parent){if(parent.status!=='active'||parent.kind==='facet')throw problem('INVALID_PARENT','O pai precisa ser uma categoria ativa.',400);g.context=parent.context;g.parentId=parent.categoryId??'semantic_'+parent.id;}const ancestry={receitas:'recipe','group-tecnologia':'technology','group-saude':'health','group-viagens':'travel','group-trabalho':'business','group-casa':'home'};if(g.parentId!==null&&!parent&&!list(state.taxonomySnapshot?.data.nodes).some(n=>n.id===g.parentId))throw problem('INVALID_PARENT','O contexto pai não existe.',400);g.context=parent?.context??ancestry[g.parentId]??'general';g.categoryId='semantic_'+g.id;}
  if(input.action==='group_assign'){
   const delta=input.reelIds===undefined,validIds=(v,max)=>Array.isArray(v)&&v.length<=max&&v.every(x=>/^[A-Za-z0-9_-]{5,32}$/.test(x));
   if(delta?(!validIds(input.addIds??[],100)||!validIds(input.removeIds??[],100)||(input.addIds??[]).length+(input.removeIds??[]).length>100):(!validIds(input.reelIds,500)||input.addIds!==undefined||input.removeIds!==undefined))throw problem('INVALID_SELECTION','Seleção ou alterações de membros inválidas.',400);
   const ids=[...new Set(delta?input.addIds??[]:input.reelIds)],loaded=await this.loadSources(ids.map(id=>{const version=state.inventory.sourceVersions.get(id);if(!version)throw problem('NOT_PUBLISHED','Seleção fora do acervo.');return {id,sourceVersions:version};}));
   const members=new Map((delta?list(g.members):[]).map(m=>[m.id,m]));for(const id of input.removeIds??[])members.delete(id);
   checks.push(...loaded.checks);for(const source of loaded.sources)members.set(source.id,{id:source.id,title:source.title,sourceIdentity:source.sourceIdentity,sourceVersions:source.sourceVersions,semanticProofHash:source.semanticProofHash,editorialHash:source.editorialHash,manualMembership:true,manualProtected:source.editorial.manual,role:'unknown',unitIds:[],evidence:[],basis:'OWNER_EXPLICIT_EDITORIAL_ASSIGNMENT'});
   if(members.size>500)throw problem('INVALID_SELECTION','Grupo excede o acervo finito autorizado.',400);g.members=[...members.values()];g.negativeExamples=list(g.negativeExamples).filter(n=>!members.has(n.id));g.manual=true;g.protected=true;g.reason='OWNER_EXPLICIT_EDITORIAL_ASSIGNMENT';
  }else if(input.action==='group_rename'){if(!validText(input.name,120))throw problem('INVALID_NAME','Nome inválido.',400);g.name=input.name.trim();g.manual=true;}
  else if(input.action==='group_reject'){g.status='rejected';g.reason='OWNER_REJECTED';g.protected=true;g.manual=true;g.categoryId=null;}
  else if(input.action==='group_protect'){if(typeof input.protected!=='boolean')throw problem('INVALID_PROTECTION','Proteção inválida.',400);g.protected=input.protected;g.manual=true;}
  else if(input.action==='group_approve'){
   const fresh=state.groups.find(x=>x.id===id);if(!fresh||fresh.members.length!==list(g.members).length||fresh.negativeExamples.length!==list(g.negativeExamples).length||!fresh.members.length)throw problem('SEMANTIC_MEMBERS_CHANGED','Membros mudaram ou estão vazios; confira as fontes.');
   g.status='active';g.manual=true;g.protected=true;g.reason='OWNER_EDITORIAL_APPROVAL_NOT_UNIVERSAL_ACCURACY';g.categoryId=g.groupKind==='facet'?null:g.groupKind==='format'?'ctx_format_'+g.key:'semantic_'+g.id;
   for(const m of [...fresh.members,...fresh.negativeExamples]){checks.push({path:'videos/'+m.id,updateTime:m.sourceVersions.video});if(m.sourceVersions.legacy)checks.push({path:'reels_legacy_content/'+m.id,updateTime:m.sourceVersions.legacy});}
  }else if(input.action==='group_merge'){
   const targetPath=groupPath(input.targetId),target=await this.store.get(targetPath);if(!target||target.data.revision!==input.targetRevision||target.data.id===id||target.data.context!==g.context||target.data.groupKind!==g.groupKind||target.data.dimension!==g.dimension||target.data.status==='rejected'||g.status==='rejected')throw problem('INVALID_MERGE','Grupos incompatíveis ou versão alterada.');
   const targetFresh=state.groups.find(x=>x.id===target.data.id),sourceFresh=state.groups.find(x=>x.id===g.id);if(!targetFresh||!sourceFresh||targetFresh.members.length!==list(target.data.members).length||sourceFresh.members.length!==list(g.members).length)throw problem('SEMANTIC_MEMBERS_CHANGED','Fontes mudaram antes da união.');for(const m of [...sourceFresh.members,...targetFresh.members]){checks.push({path:'videos/'+m.id,updateTime:m.sourceVersions.video});if(m.sourceVersions.legacy)checks.push({path:'reels_legacy_content/'+m.id,updateTime:m.sourceVersions.legacy});}
   if(list(target.data.members).some(m=>list(g.negativeExamples).some(n=>n.id===m.id))||list(g.members).some(m=>list(target.data.negativeExamples).some(n=>n.id===m.id)))throw problem('SEMANTIC_MERGE_CONTRADICTORY_EVIDENCE','Resolva primeiro as associações positivas e negativas em conflito.');
   const t={...target.data,negativeExamples:[...new Map([...list(target.data.negativeExamples),...list(g.negativeExamples)].map(n=>[n.id,n])).values()],members:[...new Map([...target.data.members,...g.members].map(m=>[m.id,m])).values()],aliases:[...new Set([...target.data.aliases,g.name,...g.aliases])],revision:target.data.revision+1,manual:true,protected:true,updatedAt:this.now()};checks.push({path:targetPath,updateTime:target.updateTime});writes.push({path:targetPath,data:t});g.status='rejected';g.mergedInto=t.id;g.reason='OWNER_MERGE';g.categoryId=null;g.manual=true;
  }else if(!creating&&!['group_assign','group_rename','group_reject','group_protect'].includes(input.action))throw problem('INVALID_ACTION','Ação de curadoria inválida.',400);
  if(!creating)g.revision++;g.updatedAt=this.now();writes.push({path,data:g},{path:receiptPath,data:{kind:'semantic_command',fingerprint,group:Object.fromEntries(Object.entries({...g,kind:g.groupKind}).filter(([k])=>k!=='members')),createdAt:this.now()}});
  await this.commit(this.uniqueChecks(checks),writes);return {group:{...g,kind:g.groupKind,memberCount:g.members.length,categoryId:g.status==='active'&&g.groupKind!=='facet'?(g.groupKind==='format'?'ctx_format_'+g.key:'semantic_'+g.id):null}};
 }
}
export async function loadLiveContextCatalogue(repository){
 try{
  const service=repository.semanticCurator??new ReelsSemanticCurator({repository}),state=await service.freshGroups(),policy=await service.policy(),active=state.groups.filter(g=>g.status==='active'),sourceVersionHash=semanticHash([...state.inventory.sourceVersions].sort(([a],[b])=>a.localeCompare(b)));
  if(active.length>64)return {version:semanticPolicyVersion,state:'unavailable',reason:'COMPACT_CATALOGUE_GROUP_LIMIT',groups:[],totalGroupCount:active.length,complete:false,noProviders:true,snapshotHash:semanticHash({state:'unavailable',reason:'COMPACT_CATALOGUE_GROUP_LIMIT',sourceVersionHash,policyVersion:policy.snapshot?.updateTime??null})};
  const groups=active.map(g=>({id:g.id,name:g.name,context:g.context,kind:g.kind,dimension:g.dimension??null,parentId:g.parentId,definition:g.definition,aliases:list(g.aliases),positiveCriteria:list(g.positiveCriteria),negativeCriteria:list(g.negativeCriteria),revision:g.revision,protected:g.protected,sourceBindingHash:semanticHash(g.members.map(m=>({id:m.id,sourceVersions:m.sourceVersions,semanticProofHash:m.semanticProofHash,editorialHash:m.editorialHash})))}));
  const snapshot={version:semanticPolicyVersion,state:state.sourceStale?'stale':'available',policyVersion:policy.snapshot?.updateTime??null,sourceVersionHash,groups,groupCount:groups.length,totalGroupCount:active.length,complete:!state.sourceStale,dataAsOf:state.dataAsOf,noProviders:true};snapshot.snapshotHash=semanticHash(snapshot);
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>30000)return {version:semanticPolicyVersion,state:'unavailable',reason:'COMPACT_CATALOGUE_BYTE_LIMIT',groups:[],totalGroupCount:active.length,complete:false,noProviders:true,snapshotHash:semanticHash({state:'unavailable',reason:'COMPACT_CATALOGUE_BYTE_LIMIT',sourceVersionHash,policyVersion:snapshot.policyVersion})};return snapshot;
 }catch{return {version:semanticPolicyVersion,state:'unavailable',reason:'LIVE_CATALOGUE_READ_UNAVAILABLE',groups:[],complete:false,noProviders:true,snapshotHash:semanticHash({state:'unavailable',reason:'LIVE_CATALOGUE_READ_UNAVAILABLE'})};}
}
