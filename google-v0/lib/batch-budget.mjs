// A bounded extension for one additional batch, not an unbounded ledger migration.
export const batchLimits=Object.freeze({videos:262,budgetCents:120000,overheadCents:2400,jobs:1200,objects:2400});
const id=/^[A-Za-z0-9_-]{5,32}$/;
const batchId=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const cents=n=>Number.isSafeInteger(n)&&n>=0;
export function validateBatch(batch){
 if(!batch||batch.schema_version!==1||!batchId.test(batch.id??'')||!['paused','active'].includes(batch.status)||!((batch.video_ids?.length===30&&batch.budget_cents===15000)||(batch.video_ids?.length===62&&batch.budget_cents===30000)||(batch.video_ids?.length===262&&batch.budget_cents===120000))||!cents(batch.overhead_cents)||batch.overhead_cents>batchLimits.overheadCents||!Array.isArray(batch.video_ids)||![30,62,262].includes(batch.video_ids.length)||batch.video_ids.some(v=>typeof v!=='string'||!id.test(v))||new Set(batch.video_ids).size!==batch.video_ids.length)throw Error('Perfil de lote ou teto autorizado inválido.');
 if(batch.video_ids.length===262&&(batch.parallelism!==4||!Array.isArray(batch.active_video_ids)||batch.active_video_ids.length>4||new Set(batch.active_video_ids).size!==batch.active_video_ids.length||batch.active_video_ids.some(v=>!batch.video_ids.includes(v))))throw Error('Quatro vias com identidades validas obrigatorias.');
 return batch;
}
export function batchUsage(state){
 const batch=validateBatch(state.batch);let spent=0,reserved=0,uncertain=false;
 for(const job of Object.values(state.jobs??{})){
  if(job.batch_id===undefined)continue;
  if(job.batch_id!==batch.id||!batch.video_ids.includes(job.video_id))throw Error('Execução fora do lote registrado.');
  if(job.status==='completed'){if(!cents(job.actual_cents))throw Error('Custo do lote inválido.');spent+=job.actual_cents;}
  if(['reserved','started','uncertain'].includes(job.status)){if(!cents(job.maximum_cents))throw Error('Reserva do lote inválida.');reserved+=job.maximum_cents;}
  if(job.status==='uncertain')uncertain=true;
 }
 if(!Number.isSafeInteger(spent+reserved))throw Error('Totais do lote inválidos.');
 return {spent_cents:spent,reserved_cents:reserved,overhead_cents:batch.overhead_cents,available_cents:Math.max(0,batch.budget_cents-batch.overhead_cents-spent-reserved),uncertain};
}
export function batchDecision(state,{videoId,maximumCents}={}){
 if(!state.batch)return {ready:true,available_cents:Infinity,reasons:[]};
 const batch=validateBatch(state.batch),usage=batchUsage(state),reasons=[];
 if(batch.status!=='active')reasons.push('Lote pausado.');
 if(!batch.video_ids.includes(videoId))reasons.push('Vídeo fora do lote autorizado.');
 if(batch.video_ids.length===262){
  if(!batch.active_video_ids.includes(videoId)&&batch.active_video_ids.length>=4)reasons.push('Quatro videos em andamento.');
  if(Object.values(state.jobs??{}).some(j=>j.batch_id===batch.id&&j.video_id===videoId&&['reserved','started'].includes(j.status)))reasons.push('Uma etapa deste video ja esta em andamento.');
 }else if(Object.values(state.jobs??{}).some(j=>j.batch_id===batch.id&&['reserved','started'].includes(j.status)))reasons.push('Uma etapa do lote já está em andamento.');
 if(usage.uncertain)reasons.push('Resultado incerto no lote exige conferência.');
 if(!cents(maximumCents)||maximumCents<1||maximumCents>usage.available_cents)reasons.push('Teto do lote insuficiente.');
 return {ready:!reasons.length,reasons,...usage};
}
export function prepareBatch(state,{id:label,videoIds,existingVideoIds=[]}={}){
 if(state.batch||Object.values(state.jobs??{}).some(j=>j.batch_id!==undefined))throw Error('Lote já configurado; não substituir histórico.');
 if(state.paused!==true||Object.values(state.jobs??{}).some(j=>['upload','transcription','analysis'].includes(j.stage)&&['reserved','started'].includes(j.status)))throw Error('Pausar e drenar etapas antes de preparar lote.');
 const batch={schema_version:1,id:label,status:'paused',budget_cents:videoIds.length===30?15000:30000,overhead_cents:batchLimits.overheadCents,video_ids:[...videoIds]};validateBatch(batch);
 const previous=new Set([...existingVideoIds,...Object.values(state.jobs??{}).map(j=>j.video_id)]);
 if(batch.video_ids.some(v=>previous.has(v)))throw Error('Lote deve conter somente vídeos novos.');
 if(Object.keys(state.jobs??{}).length+batch.video_ids.length*3>jobLimit({batch}))throw Error('Histórico e lote excedem o limite de operações.');
 return batch;
}
export function objectLimit(financial){if(!financial?.batch)return 200;validateBatch(financial.batch);return financial.batch.video_ids.length===30?400:financial.batch.video_ids.length===62?800:batchLimits.objects;}
export function checkBatchObject(financial,key){
 if(!financial?.batch)return;
 const batch=validateBatch(financial.batch),parts=key.split('/');
 if(batch.status!=='active'||!['originals','results'].includes(parts[0])||parts[1]!=='instagram'||!batch.video_ids.includes(parts[2]))throw Error('Objeto fora do lote ativo.');
}

export function jobLimit(state){if(!state?.batch)return 100;validateBatch(state.batch);return state.batch.video_ids.length===30?200:state.batch.video_ids.length===62?400:batchLimits.jobs;}
// Pure preparation; no data write or automatic activation. The operator supplies
// the explicitly authorized total, and keeps the original batch identity/history.
export function extendBatch(state,{additionalVideoIds,existingVideoIds=[],budgetCents}={}){
 const previous=validateBatch(state?.batch);batchUsage(state);
 if(state.paused!==true||previous.status!=='paused'||previous.video_ids.length!==30||previous.budget_cents!==15000||budgetCents!==30000)throw Error('Expansão requer lote original pausado e teto autorizado de R$300.');
 if(Object.values(state.jobs??{}).some(j=>['upload','transcription','analysis'].includes(j.stage)&&['reserved','started'].includes(j.status))||batchUsage(state).uncertain)throw Error('Conferir etapas abertas antes de expandir.');
 if(!Array.isArray(additionalVideoIds)||additionalVideoIds.length!==32||new Set(additionalVideoIds).size!==32)throw Error('32 vídeos novos únicos obrigatórios.');
 const used=new Set([...previous.video_ids,...existingVideoIds,...Object.values(state.jobs??{}).map(j=>j.video_id)]);
 if(additionalVideoIds.some(v=>typeof v!=='string'||!id.test(v)||used.has(v)))throw Error('Expansão deve conter somente vídeos novos.');
 const batch={...previous,budget_cents:budgetCents,video_ids:[...previous.video_ids,...additionalVideoIds]};validateBatch(batch);
 const missingStages=previous.video_ids.reduce((n,v)=>n+['upload','transcription','analysis'].filter(stage=>!Object.values(state.jobs??{}).some(j=>j.video_id===v&&j.stage===stage&&j.status!=='cancelled')).length,0);
 if(Object.keys(state.jobs??{}).length+missingStages+96>jobLimit({batch}))throw Error('Histórico excede capacidade da expansão.');
 return batch;
}

// Owner-authorized expansion keeps the existing identity and every old record.
export function extendBatch200(state,{additionalVideoIds,existingVideoIds=[],budgetCents}={}){
 const previous=validateBatch(state?.batch);const usage=batchUsage(state);
 if(state.paused!==true||previous.status!=='paused'||previous.video_ids.length!==62||previous.budget_cents!==30000||budgetCents!==120000)throw Error('Expansao requer perfil62 pausado e tetoR1200 autorizado.');
 if(usage.uncertain||Object.values(state.jobs??{}).some(j=>['reserved','started'].includes(j.status)&&j.batch_id===previous.id))throw Error('Conferir etapas do lote antes de expandir.');
 if(!Array.isArray(additionalVideoIds)||additionalVideoIds.length!==200||new Set(additionalVideoIds).size!==200)throw Error('200 videos novos unicos obrigatorios.');
 const used=new Set([...previous.video_ids,...existingVideoIds,...Object.values(state.jobs??{}).map(j=>j.video_id)]);
 if(additionalVideoIds.some(v=>typeof v!=='string'||!id.test(v)||used.has(v)))throw Error('Somente videos novos validos.');
 const batch={...previous,budget_cents:budgetCents,video_ids:[...previous.video_ids,...additionalVideoIds],parallelism:4,active_video_ids:[]};validateBatch(batch);
 if(Object.keys(state.jobs??{}).length+600>jobLimit({batch}))throw Error('Historico excede capacidade da expansao.');
 return batch;
}
