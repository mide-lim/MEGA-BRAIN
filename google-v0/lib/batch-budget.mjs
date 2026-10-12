// A bounded extension for one additional batch, not an unbounded ledger migration.
export const batchLimits=Object.freeze({videos:30,budgetCents:15000,overheadCents:2400,jobs:200,objects:400});
const id=/^[A-Za-z0-9_-]{5,32}$/;
const batchId=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const cents=n=>Number.isSafeInteger(n)&&n>=0;
export function validateBatch(batch){
 if(!batch||batch.schema_version!==1||!batchId.test(batch.id??'')||!['paused','active'].includes(batch.status)||batch.budget_cents!==batchLimits.budgetCents||!cents(batch.overhead_cents)||batch.overhead_cents>batchLimits.overheadCents||!Array.isArray(batch.video_ids)||batch.video_ids.length!==batchLimits.videos||batch.video_ids.some(v=>typeof v!=='string'||!id.test(v))||new Set(batch.video_ids).size!==batch.video_ids.length)throw Error('Lote de 30 ou teto de R$150 inválido.');
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
 if(Object.values(state.jobs??{}).some(j=>j.batch_id===batch.id&&['reserved','started'].includes(j.status)))reasons.push('Uma etapa do lote já está em andamento.');
 if(usage.uncertain)reasons.push('Resultado incerto no lote exige conferência.');
 if(!cents(maximumCents)||maximumCents<1||maximumCents>usage.available_cents)reasons.push('Teto do lote insuficiente.');
 return {ready:!reasons.length,reasons,...usage};
}
export function prepareBatch(state,{id:label,videoIds,existingVideoIds=[]}={}){
 if(state.batch||Object.values(state.jobs??{}).some(j=>j.batch_id!==undefined))throw Error('Lote já configurado; não substituir histórico.');
 if(state.paused!==true||Object.values(state.jobs??{}).some(j=>['upload','transcription','analysis'].includes(j.stage)&&['reserved','started'].includes(j.status)))throw Error('Pausar e drenar etapas antes de preparar lote.');
 const batch={schema_version:1,id:label,status:'paused',budget_cents:batchLimits.budgetCents,overhead_cents:batchLimits.overheadCents,video_ids:[...videoIds]};validateBatch(batch);
 const previous=new Set([...existingVideoIds,...Object.values(state.jobs??{}).map(j=>j.video_id)]);
 if(batch.video_ids.some(v=>previous.has(v)))throw Error('Lote deve conter somente vídeos novos.');
 if(Object.keys(state.jobs??{}).length+batch.video_ids.length*3>batchLimits.jobs)throw Error('Histórico e lote excedem o limite de operações.');
 return batch;
}
export function objectLimit(financial){if(!financial?.batch)return 200;validateBatch(financial.batch);return batchLimits.objects;}
export function checkBatchObject(financial,key){
 if(!financial?.batch)return;
 const batch=validateBatch(financial.batch),parts=key.split('/');
 if(batch.status!=='active'||!['originals','results'].includes(parts[0])||parts[1]!=='instagram'||!batch.video_ids.includes(parts[2]))throw Error('Objeto fora do lote ativo.');
}
