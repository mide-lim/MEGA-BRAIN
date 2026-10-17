const STAGES=['acquisition','transcription','analysis'];
const PERMISSIONS=['tasksCreate','tasksGet','tasksFullView','actAs','runInvoker','firestore'];
const FRESH_MS=15*60*1000;
const commitPattern=/^[a-f0-9]{40}$/;
const retryPolicy={maxAttempts:20,maxRetryDurationSeconds:3600,minBackoffSeconds:10,maxBackoffSeconds:60};
const fresh=(value,now)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now&&now-Date.parse(value)<=FRESH_MS;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
export function prepareReelsPilot({candidateCommit,observation,now=Date.now()}={}){
 if(!commitPattern.test(candidateCommit??''))throw new Error('Candidato deve ser um SHA completo de 40 caracteres hexadecimais.');
 if(!Number.isFinite(now))throw new Error('Data de preparação inválida.');
 const input=object(observation),blockers=[];
 const block=(code,message)=>blockers.push({code,message});
 if(input.schemaVersion!==1)block('OBSERVATION_SCHEMA','Observação sanitizada ausente ou incompatível.');
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
  if(queue.paused!==true||queue.taskCount!==0)block('QUEUE_NOT_CLOSED_'+stage.toUpperCase(),'Comprovar fila pausada e sem entregas pendentes na etapa '+stage+'.');
  const current=object(queue.retryPolicy);
  if(Object.entries(retryPolicy).some(([field,value])=>current[field]!==value))block('RETRY_POLICY_'+stage.toUpperCase(),'Política atual da etapa '+stage+' não corresponde à proposta de retomada limitada; qualquer alteração exige autorização futura.');
 }
 const iam=object(input.iam);
 if(iam.effectivePermissionsObserved!==true||!fresh(iam.observedAt,now))block('IAM_PROOF_REQUIRED','Comprovar permissões efetivas e atuais; nomes de papéis ou configuração não bastam.');
 for(const permission of PERMISSIONS)if(iam[permission]!==true)block('IAM_'+permission.toUpperCase(),'Permissão efetiva ainda não comprovada: '+permission+'.');
 if(input.legacyOccupancyReconciled!==true||!fresh(input.proofFreshAt,now))block('LEGACY_OCCUPANCY_UNRECONCILED','Conciliar explicitamente ocupações e reservas legadas com v2; active vazio de v2 não comprova ausência de execução paga legada.');
 const candidates=object(input.candidates);
 if(candidates.count!==1||candidates.unheld!==true||candidates.identityBound!==true||candidates.noActiveOrUncertain!==true)block('CANDIDATE_SAMPLE_UNPROVEN','Fixar uma amostra de um Reel sem hold, com identidade vinculada e ausência comprovada de execução ativa ou incerta; não remover holds nesta preparação.');
 if(input.concurrency!==1)block('CONCURRENCY_UNPROVEN','Comprovar concorrência um por etapa para a proposta inicial.');
 return {schemaVersion:1,candidateCommit,preparedAt:new Date(now).toISOString(),status:'prepared_not_run',processAuthorized:false,activationAllowed:false,technicalPrerequisitesMet:blockers.length===0,blockers,
  proposal:{sampleSize:1,concurrencyPerStage:1,stageQueues:STAGES.map(stage=>({stage,retryPolicy:{...retryPolicy},apply:false})),oldProcessingQueue:'preserve_unchanged',
   publication:{processingEnabled:false,dispatchEnabled:false,activate:false},activation:'future_explicit_authorization_for_exact_candidate_and_private_sample',budgetGate:false},
  stopCriteria:['Qualquer submissão paga duplicada ou resultado externo incerto: suspender novas entradas da etapa e preservar a ocupação.','Divergência de identidade, versão, posse ou artefatos: interromper novas entradas e conciliar.','Falha compartilhada, capacidade excedida ou perda de persistência: suspender a etapa afetada.'],
  preservation:{delete:false,releaseReservations:false,removeHolds:false,preservePublication:true,preserveCandidates:true,preserveArtifacts:true},
  rollback:['Suspender novas entradas e despacho sem remover tarefas, acervo, resultados ou reservas.','Manter coleta e persistência de operações já enviadas no mesmo identificador; nunca ressubmeter por timeout.','Reverter publicação somente com versão revisada e autorização correspondente, conservando evidências.'],
  nextAction:blockers.length?'resolve_blockers_with_fresh_read_only_evidence':'request_separate_activation_review',
  limitations:['Esta função apenas avalia uma observação fornecida; não verifica infraestrutura nem prova execução real.','Metadados e permissões desconhecidos bloqueiam a proposta. A preparação não concede autorização.','IDs e documentos da amostra permanecem em evidência privada externa ao repositório.']};
}
