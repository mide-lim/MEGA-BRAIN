// Offline preparation only. Never loads credentials, writes Firestore or activates.
import {readFile,writeFile} from 'node:fs/promises';
import {extendBatch,objectLimit} from '../lib/batch-budget.mjs';
import {reservationDecision} from '../lib/financial-ledger.mjs';
const [source,destination,...extra]=process.argv.slice(2);if(!source||!destination||extra.length)throw Error('Entrada e destino obrigatórios.');
const input=JSON.parse(await readFile(source,'utf8'));
const batch=extendBatch(input.financial,{additionalVideoIds:input.candidates?.map(c=>c.id),existingVideoIds:input.existing_video_ids,budgetCents:input.authorized_budget_cents});
for(const c of input.candidates)if(!new RegExp('^https://(?:www\\.)?instagram\\.com/(?:p|reel|reels)/'+c.id+'/?$').test(c.url))throw Error('URL diverge do vídeo.');
const readiness=reservationDecision({...input.financial,batch},{maximumCents:50,stage:'upload',videoId:batch.video_ids.at(-1)});
const claims=Object.values(input.capacity?.claims??{});
if(input.capacity?.schema_version!==1||claims.length+62*5>objectLimit({batch})||claims.some(c=>!Number.isSafeInteger(c.reserved_bytes)||c.reserved_bytes<1)||claims.reduce((n,c)=>n+c.reserved_bytes,0)!==input.capacity.admitted_bytes)throw Error('Capacidade inconsistente ou insuficiente.');
const plan={mode:'dry-run',ready_for_execution:false,batch,financial_changes:{batch,paused:true},capacity_changes:{claim_limit:objectLimit({batch})},worker_config_changes:{batch_id:batch.id,pilot_video_ids:batch.video_ids},new_video_ids:input.candidates.map(c=>c.id),historical_jobs:Object.keys(input.financial.jobs).length,blocking_reasons:readiness.reasons,unchanged:['spent','reservations','old video IDs','old jobs','credit observations','cost quotes']};
await writeFile(destination,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({videos:62,added:32,budget_cents:30000,ready_for_execution:false}));
