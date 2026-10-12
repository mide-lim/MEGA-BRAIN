// Offline plan only. No Google client, credentials, imports or paid calls.
import {readFile,writeFile} from 'node:fs/promises';
import {prepareBatch,batchLimits} from '../lib/batch-budget.mjs';
import {reservationDecision} from '../lib/financial-ledger.mjs';
const [inputPath,outputPath,...extra]=process.argv.slice(2);
if(!inputPath||!outputPath||extra.length)throw Error('Uso: node prepare-batch.mjs entrada.json plano.json');
const input=JSON.parse(await readFile(inputPath,'utf8'));
const {financial,capacity,existing_video_ids:existingVideoIds,candidates}=input;
if(!Array.isArray(existingVideoIds)||existingVideoIds.length!==20||new Set(existingVideoIds).size!==20||!Array.isArray(candidates)||candidates.length!==30)throw Error('Inventário de 20 e lote de 30 obrigatórios.');
for(const c of candidates)if(!new RegExp('^https://(?:www\\.)?instagram\\.com/(?:p|reel|reels)/'+c.id+'/?$').test(c.url))throw Error('URL diverge do identificador.');
const batch=prepareBatch(financial,{id:input.batch_id,videoIds:candidates.map(c=>c.id),existingVideoIds});
// Validates the complete ledger, but intentionally reports stale/paused controls.
const readiness=reservationDecision({...financial,batch},{maximumCents:50,stage:'upload',videoId:batch.video_ids[0]});
const claims=Object.values(capacity?.claims??{});
if(capacity?.schema_version!==1||claims.length+30*5>batchLimits.objects||claims.some(c=>!Number.isSafeInteger(c.reserved_bytes)||c.reserved_bytes<1)||claims.reduce((n,c)=>n+c.reserved_bytes,0)!==capacity.admitted_bytes)throw Error('Capacidade ou histórico de objetos inválido.');
const plan={mode:'dry-run',activation_changed:false,batch,financial_changes:{batch,paused:true},capacity_changes:{claim_limit:batchLimits.objects},worker_config_changes:{batch_id:batch.id,pilot_video_ids:batch.video_ids},historical_jobs:Object.keys(financial.jobs).length,planned_new_operations:90,planned_new_object_slots:150,estimated_processing_cents:12600,protected_overhead_cents:2400,ready_for_execution:false,blocking_reasons:readiness.reasons,remaining_checks:['Verify candidate availability, duration and cost quotes','Refresh genuine credit and ongoing-cost observations','Prepare media-review allowance within protected overhead','Independent review and deployment of this control','Apply plan conditionally against fresh document versions with queue paused; activate only after all checks']};
await writeFile(outputPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode:plan.mode,videos:batch.video_ids.length,budget_cents:batch.budget_cents,processing_cents:12600,overhead_cents:2400,ready_for_execution:false}));
