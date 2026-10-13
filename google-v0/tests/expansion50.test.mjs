import test from 'node:test';import assert from 'node:assert/strict';
import {prepareBatch,extendBatch,validateBatch,batchUsage,jobLimit,objectLimit} from '../lib/batch-budget.mjs';
import {newLedger,reservationDecision,FinancialLedger} from '../lib/financial-ledger.mjs';
import {WorkerFlow} from '../lib/worker-flow.mjs';
import {normalizedCategoryIds,validateCategoryIds} from '../lib/category-taxonomy.mjs';
import {analysisOutcome} from '../lib/analysis.mjs';
const ids=Array.from({length:30},(_,i)=>'previous_'+i),more=Array.from({length:32},(_,i)=>'additional_'+i),now=Date.parse('2026-10-13T04:00:00Z');
function original(){const s={...newLedger(),remaining_credit_cents:140000,coverage_verified:true,balance_observed_at:new Date(now).toISOString(),credit_expires_at:'2026-11-23T00:00:00Z',ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}};return {...s,batch:prepareBatch(s,{id:'existing_batch',videoIds:ids})};}
const expansion=s=>extendBatch(s,{additionalVideoIds:more,existingVideoIds:['old_video'],budgetCents:30000});
test('explicit expansion preserves old batch identity, history and reservations without activating',()=>{
 const s=original();s.jobs.prior={video_id:ids[0],stage:'analysis',maximum_cents:250,status:'completed',actual_cents:250,batch_id:s.batch.id};s.spent_cents=250;
 s.jobs.old_unknown={video_id:'old_video',stage:'analysis',maximum_cents:100,status:'uncertain'};s.reserved_cents=100;
 const before=structuredClone(s),b=expansion(s);assert.deepEqual(s,before);assert.equal(b.id,s.batch.id);assert.equal(b.status,'paused');assert.deepEqual(b.video_ids,[...ids,...more]);assert.equal(b.budget_cents,30000);
 assert.equal(jobLimit(s),200);assert.equal(objectLimit(s),400);assert.equal(jobLimit({...s,batch:b}),400);assert.equal(objectLimit({...s,batch:b}),800);assert.equal(batchUsage({...s,batch:b}).spent_cents,250);
});
test('profile/budget pairing, duplicates, old videos, active states and uncertain outcomes cannot authorize expansion',()=>{
 const s=original(),b=expansion(s);
 for(const change of [{video_ids:b.video_ids.slice(1)},{budget_cents:15000},{budget_cents:30001},{budget_cents:29999},{video_ids:[...ids]}])assert.throws(()=>validateBatch({...b,...change}));
 for(const change of [{paused:false},{batch:{...s.batch,status:'active'}},{jobs:{run:{video_id:ids[0],stage:'upload',maximum_cents:50,status:'started'}}},{jobs:{run:{video_id:ids[0],stage:'upload',maximum_cents:50,status:'uncertain',batch_id:s.batch.id}}}])assert.throws(()=>expansion({...s,...change}));
 for(const changed of [more.slice(1),[ids[0],...more.slice(1)],[more[0],...more.slice(1,31),more[0]]])assert.throws(()=>extendBatch(s,{additionalVideoIds:changed,budgetCents:30000}));
 assert.throws(()=>extendBatch(s,{additionalVideoIds:more,existingVideoIds:[more[0]],budgetCents:30000}));assert.throws(()=>extendBatch(s,{additionalVideoIds:more}));assert.throws(()=>expansion({...s,batch:b}));
});
test('expanded budget and job bound are enforced at exact limits',()=>{
 const s=original(),b=expansion(s),active={...s,batch:{...b,status:'active'},paused:false};
 const spent=27500;active.jobs.done={video_id:ids[0],stage:'analysis',maximum_cents:spent,status:'completed',actual_cents:spent,batch_id:b.id};active.spent_cents=spent;
 assert.equal(reservationDecision(active,{now,stage:'upload',maximumCents:100,videoId:more[0]}).ready,true);assert.equal(reservationDecision(active,{now,stage:'upload',maximumCents:101,videoId:more[0]}).ready,false);
 const jobs=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['prior_'+i,{video_id:'historical_'+i,stage:'analysis',maximum_cents:1,status:'completed',actual_cents:1}]));
 assert.doesNotThrow(()=>reservationDecision({...s,jobs:jobs(200)},{now,stage:'upload',maximumCents:1,videoId:ids[0]}));assert.throws(()=>reservationDecision({...s,jobs:jobs(201)},{now,stage:'upload',maximumCents:1,videoId:ids[0]}));
 assert.doesNotThrow(()=>reservationDecision({...active,jobs:jobs(400)},{now,stage:'upload',maximumCents:1,videoId:more[0]}));assert.throws(()=>reservationDecision({...active,jobs:jobs(401)},{now,stage:'upload',maximumCents:1,videoId:more[0]}));
});
test('expanded worker remains scoped to registered membership before any adapter call',async()=>{
 const s=original(),b=expansion(s),flow=new WorkerFlow({store:{get:async()=>({data:{...s,batch:{...b,status:'active'}}})},ledger:{},operations:{},quotes:{upload:50},eligibleVideos:[...ids,...more],batchId:b.id});
 assert.equal((await flow.run({videoId:'outside_video',stage:'upload'})).reason,'outside_pilot');
 assert.throws(()=>new WorkerFlow({store:{},ledger:{},operations:{},quotes:{},eligibleVideos:[...ids,...more,'extra_video'],batchId:b.id}));
});
test('normalization only removes a redundant known technology fallback and never broadens validation',()=>{
 for(const specific of ['hardware-setup','design-digital','desenvolvimento-software','inteligencia-artificial','ferramentas-produtividade'])for(const input of [[specific,'tecnologia-geral'],['tecnologia-geral',specific]]){const copy=[...input];assert.deepEqual(normalizedCategoryIds(input),[specific]);assert.deepEqual(input,copy);validateCategoryIds(normalizedCategoryIds(input));}
 for(const invalid of [['a-organizar','hardware-setup'],['a-organizar','tecnologia-geral'],['tecnologia-geral','nutricao'],['tecnologia-geral','unknown'],['hardware-setup','hardware-setup'],['hardware-setup','tecnologia-geral','design-digital']])assert.throws(()=>validateCategoryIds(normalizedCategoryIds(invalid)));
 assert.deepEqual(normalizedCategoryIds(['receitas','nutricao']),['receitas','nutricao']);assert.deepEqual(normalizedCategoryIds(['tecnologia-geral']),['tecnologia-geral']);
});
test('normalization operates on parsed copy while retaining raw response and evidence review',()=>{
 const report={title:'Equipamento',summary:'Descrição do equipamento.',categories:['hardware-setup','tecnologia-geral'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Clara',uncertain_segments:[]}};
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}]},copy=JSON.stringify(response);
 const r=analysisOutcome(response,{id:'example_video',duration_seconds:10,transcript:'Equipamento'});assert.equal(r.accepted,true);assert.deepEqual(r.report.categories,['hardware-setup']);assert.ok(r.report.limitations.some(x=>x.includes('redundante')));assert.equal(JSON.stringify(response),copy);
 const bad={...report,categories:['hardware-setup','unknown']};assert.equal(analysisOutcome({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(bad)}]}}]},{id:'example_video',duration_seconds:10,transcript:'Equipamento'}).accepted,false);
});

test('62 full videos fit fixed quotes and R$300 with97historical jobs preserved',async()=>{
 let state=original();state.jobs=Object.fromEntries(Array.from({length:97},(_,i)=>['old_'+i,{video_id:'old_video_'+i,stage:'analysis',maximum_cents:250,status:i<94?'completed':'uncertain',...(i<94?{actual_cents:250}:{})}]));state.spent_cents=23500;state.reserved_cents=750;const history=structuredClone(state.jobs);
 state={...state,batch:{...expansion(state),status:'active'},paused:false};let version=0;
 const store={get:async()=>({data:structuredClone(state),updateTime:String(version)}),patch:async(_p,c,o)=>{assert.equal(o.updateTime,String(version));state={...state,...structuredClone(c)};version++;}};const ledger=new FinancialLedger(store,{clock:()=>now});
 for(const [i,videoId]of [...ids,...more].entries())for(const [stage,maximumCents]of [['upload',50],['transcription',120],['analysis',250]]){const executionId='new_'+i+'_'+stage;await ledger.reserve({executionId,videoId,stage,maximumCents});await ledger.transition(executionId,'start');await ledger.transition(executionId,'complete',{actualCents:maximumCents});}
 assert.equal(Object.keys(state.jobs).length,283);assert.equal(batchUsage(state).spent_cents,26040);assert.equal(batchUsage(state).available_cents,1560);assert.equal(state.reserved_cents,750);for(const [k,v]of Object.entries(history))assert.deepEqual(state.jobs[k],v);
 await assert.rejects(ledger.reserve({executionId:'repeat',videoId:ids[0],stage:'analysis',maximumCents:250}));
});
test('offline expansion CLI emits paused plan, preserves input and rejects output overwrite',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');const folder=await mkdtemp(join(tmpdir(),'megabrain-expansion-test-'));
 try{
 const input={financial:original(),capacity:{schema_version:1,claims:{},admitted_bytes:0},existing_video_ids:['old_video'],authorized_budget_cents:30000,candidates:more.map(id=>({id,url:'https://www.instagram.com/reel/'+id+'/'}))};const text=JSON.stringify(input),source=join(folder,'input.json'),dest=join(folder,'plan.json');await writeFile(source,text);
 const script=new URL('../scripts/extend-batch.mjs',import.meta.url).pathname;execFileSync(process.execPath,[script,source,dest]);const plan=JSON.parse(await readFile(dest,'utf8'));assert.equal(plan.batch.video_ids.length,62);assert.equal(plan.batch.status,'paused');assert.equal(plan.ready_for_execution,false);assert.equal(plan.capacity_changes.claim_limit,800);assert.equal(await readFile(source,'utf8'),text);assert.throws(()=>execFileSync(process.execPath,[script,source,dest],{stdio:'pipe'}));
 }finally{await rm(folder,{recursive:true,force:true});}
});
