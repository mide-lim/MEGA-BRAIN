const STAGES=['acquisition','transcription','analysis'];
const PERMISSIONS=['tasksCreate','tasksGet','tasksFullView','actAs','runInvoker','firestore'];
const FRESH_MS=15*60*1000;
const commitPattern=/^[a-f0-9]{40}$/;
const retryPolicy={maxAttempts:20,maxRetryDurationSeconds:3600,minBackoffSeconds:10,maxBackoffSeconds:60,maxDoublings:3};
const fresh=(value,now)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now&&now-Date.parse(value)<=FRESH_MS;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
export function prepareReelsPilot({candidateCommit,observation,now=Date.now()}={}){
 if(!commitPattern.test(candidateCommit??''))throw new Error('Candidato deve ser um SHA completo de 40 caracteres hexadecimais.');
 if(!Number.isFinite(now))throw new Error('Data de preparação inválida.');
 const input=object(observation),blockers=[];
 const block=(code,message)=>blockers.push({code,message});
 if(input.schemaVersion!==2||input.mode!=='pre_activation')block('OBSERVATION_SCHEMA','Observação sanitizada ausente ou incompatível.');
 if(input.candidateCommit!==candidateCommit)block('CANDIDATE_MISMATCH','Metadados não estão vinculados ao candidato exato.');
 if(!fresh(input.observedAt,now))block('METADATA_STALE','Renovar a observação somente de leitura; validade máxima de 15 minutos.');
 if(input.processingEnabled!==false)block('PROCESSING_NOT_DISABLED','Comprovar processamento desabilitado antes de qualquer publicação.');
 if(input.dispatchEnabled!==false)block('DISPATCH_NOT_DISABLED','Comprovar despacho desabilitado antes de qualquer publicação.');
 const bindings=object(input.bindings);
 for(const service of ['web',...STAGES])if(bindings[service]!==true)block('BINDING_'+service.toUpperCase(),'Comprovar imagem, entrada e rotas compatíveis do serviço '+service+' no candidato.');
 const queues=Array.isArray(input.queues)?input.queues:[];
 for(const stage of STAGES){
  const matches=queues.filter(queue=>queue?.stage===stage),queue=matches[0];
  if(matches.length!==1){block('QUEUE_'+stage.toUpperCase(),'Observar exatamente uma fila para a etapa '+stage+'.');continue;}
  if(!['RUNNING','PAUSED'].includes(queue.state)||queue.taskCount!==0)block('QUEUE_NOT_CLOSED_'+stage.toUpperCase(),'Comprovar estado conhecido e fila vazia, com runtime e despacho fechados na etapa '+stage+'.');
  if(queue.maxConcurrentDispatches!==1)block('QUEUE_CONCURRENCY_'+stage.toUpperCase(),'Comprovar concorrência um na fila da etapa '+stage+'.');
  const current=object(queue.retryPolicy);
  if(Object.entries(retryPolicy).some(([field,value])=>current[field]!==value))block('RETRY_POLICY_'+stage.toUpperCase(),'Política atual da etapa '+stage+' não corresponde à proposta de retomada limitada; qualquer alteração exige autorização futura.');
 }
 const iam=object(input.iam);
 if(iam.effectivePermissionsObserved!==true||!fresh(iam.observedAt,now))block('IAM_PROOF_REQUIRED','Comprovar permissões efetivas e atuais; nomes de papéis ou configuração não bastam.');
 for(const permission of PERMISSIONS)if(iam[permission]!==true)block('IAM_'+permission.toUpperCase(),'Permissão efetiva ainda não comprovada: '+permission+'.');
 const isolation=object(input.isolation),candidates=object(input.candidates),release=object(input.holdReleasePlan);
 // Global unknown legacy calls remain protected. Only a positively demonstrated
 // disjoint sample can satisfy this pre-activation check; lease expiry is no proof.
 const proofFields=['identityAndVersionBound','enumeratedScopeComplete','noLegacyJobOrClaimOverlap','noDispatchOrAdmissionOverlap','noFinancialOrCapacityOverlap','noV2ExecutionOrOutboxOverlap','noSavedMediaOrPaidResultOverlap','namespaceBoundariesVerified','legacyUncertainPreserved'];
 if(!fresh(isolation.observedAt,now)||proofFields.some(field=>isolation[field]!==true)||isolation.proofKind!=='positive_per_sample_inventory'||typeof isolation.evidenceDigest!=='string'||!/^[a-f0-9]{64}$/.test(isolation.evidenceDigest))block('SAMPLE_ISOLATION_UNPROVEN','Comprovar isolamento positivo atual por identidade e versão, inventário completo e limites de namespace; ausência v2 ou lease expirado não basta.');
 if(!Number.isSafeInteger(isolation.legacyUncertainRemaining)||isolation.legacyUncertainRemaining<0)block('LEGACY_RETENTION_UNPROVEN','Registrar explicitamente as incertezas legadas preservadas, sem declarar conciliação global.');
 if(candidates.count!==1||candidates.currentHeld!==true||candidates.currentEligible!==false||candidates.identityAndVersionBound!==true||candidates.registered!==true)block('CANDIDATE_SAMPLE_UNPROVEN','Fixar uma amostra registrada, retida e inelegível agora, com identidade e versão privadas vinculadas.');
 if(release.count!==1||release.exactIdentityAndVersionBound!==true||release.compareAndSetRequired!==true||release.onlyImportHoldActive!==true||release.authorizationRequired!==true||release.applied!==false)block('HOLD_RELEASE_PLAN_UNPROVEN','Preparar somente liberação futura de um hold por CAS exato e autorização separada, sem aplicar.');
 if(input.concurrency!==1)block('CONCURRENCY_UNPROVEN','Comprovar concorrência um por etapa para a proposta inicial.');
 return {schemaVersion:2,mode:'pre_activation',candidateCommit,preparedAt:new Date(now).toISOString(),status:'prepared_not_run',processAuthorized:false,activationAllowed:false,technicalPrerequisitesMet:blockers.length===0,technicalPreflightReady:blockers.length===0,executionReady:false,currentEligible:false,releaseRequired:true,legacyOccupancyReconciled:false,legacyUncertainRemaining:Number.isSafeInteger(isolation.legacyUncertainRemaining)&&isolation.legacyUncertainRemaining>=0?isolation.legacyUncertainRemaining:null,blockers,
  proposal:{sampleSize:1,concurrencyPerStage:1,stageQueues:STAGES.map(stage=>({stage,retryPolicy:{...retryPolicy},apply:false})),oldProcessingQueue:'preserve_unchanged',
   publication:{processingEnabled:false,dispatchEnabled:false,activate:false},activation:'future_explicit_authorization_for_exact_candidate_and_private_sample',budgetGate:false},
  stopCriteria:['Qualquer submissão paga duplicada ou resultado externo incerto: suspender novas entradas da etapa e preservar a ocupação.','Divergência de identidade, versão, posse ou artefatos: interromper novas entradas e conciliar.','Falha compartilhada, capacidade excedida ou perda de persistência: suspender a etapa afetada.'],
  preservation:{delete:false,releaseReservations:false,removeHolds:false,preservePublication:true,preserveCandidates:true,preserveArtifacts:true},
  rollback:['Suspender novas entradas e despacho sem remover tarefas, acervo, resultados ou reservas.','Manter coleta e persistência de operações já enviadas no mesmo identificador; nunca ressubmeter por timeout.','Reverter publicação somente com versão revisada e autorização correspondente, conservando evidências.'],
  nextAction:blockers.length?'resolve_blockers_with_fresh_read_only_evidence':'request_separate_publication_and_activation_review',
  limitations:['Esta função apenas avalia uma observação fornecida; não verifica infraestrutura nem prova execução real.','Metadados e permissões desconhecidos bloqueiam a proposta. A preparação não concede autorização.','IDs e documentos da amostra permanecem em evidência privada externa ao repositório.']};
}
