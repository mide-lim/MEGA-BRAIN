import {hash,nowISO,fail,key,ensure,cas} from './reels-runtime.mjs';
const path='settings/reels_v2_finance';
const dayOf=value=>{const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(k=>parts.find(p=>p.type===k)?.value).join('-');};
const amount=value=>Number.isFinite(value)&&value>=0;
const measured=value=>value?.schema_version===1&&value.status==='measured'&&value.currency==='USD'&&value.billing_confirmed===false&&typeof value.rate_version==='string'&&value.rate_version.length>0&&typeof value.source==='string'&&value.source.length>0&&Number.isSafeInteger(value.list_price_micro_usd)&&value.list_price_micro_usd>=0;
export class ReelsFinance {
 constructor({repository,clock=Date.now}){this.repository=repository;this.store=repository.store;this.clock=clock;}
 async jobs(){
  const jobs=[];let cursor;const seen=new Set();
  do{const page=await this.store.query('reels_executions',{select:['id','reelId','stage','status','predecessorId','createdAt','completedAt','failedAt','resultSavedAt','rawResult.valid','rawResult.finance'],limit:500,cursor});jobs.push(...page.records.map(r=>r.data));cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Consulta financeira não avançou.');if(cursor)seen.add(cursor);}while(cursor);
  return jobs;
 }
 async read({from,to}={}){
  const today=dayOf(this.clock());from??=today;to??=today;if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||new Date(from).toISOString().slice(0,10)!==from||new Date(to).toISOString().slice(0,10)!==to||Date.parse(to)-Date.parse(from)>366*86400000)throw fail('INVALID_RANGE','Período inválido.');
  const config=(await this.store.get(path))?.data??{},jobs=await this.jobs(),days=new Map();
  const get=day=>{if(!days.has(day))days.set(day,{day,admitted:0,completed:0,published:0,failed:0,estimatedUsd:null,estimatedByCurrency:null,measuredUsd:null,billed:null,uncertain:0});return days.get(day);};
  for(let timestamp=Date.parse(from+'T12:00:00Z');timestamp<=Date.parse(to+'T12:00:00Z');timestamp+=86400000)get(new Date(timestamp).toISOString().slice(0,10));
  const counted=new Set(),rates=new Set();let estimates=0,measurements=0,unavailable=0,lastMeasurementAt=null;
  const increment=(day,metric,reelId)=>{if(!day||!reelId)return;const key=day.day+':'+metric+':'+reelId;if(counted.has(key))return;counted.add(key);day[metric]++;};
  for(const job of jobs){const entered=dayOf(job.createdAt),finished=dayOf(job.completedAt??job.failedAt),creation=days.get(entered),completion=days.get(finished);
   if(!job.predecessorId)increment(creation,'admitted',job.reelId);
   if(job.stage==='analysis'&&job.status==='completed'){increment(completion,'completed',job.reelId);if(job.rawResult?.valid===true)increment(completion,'published',job.reelId);}
   if(job.status==='failed')increment(completion,'failed',job.reelId);if(job.status==='uncertain')increment(creation,'uncertain',job.reelId);
   const recordedAt=job.resultSavedAt??job.completedAt??job.failedAt??job.createdAt,recorded=days.get(dayOf(recordedAt)),finance=job.rawResult?.finance;
   if(!finance){if(recorded&&['transcription','analysis'].includes(job.stage)&&['completed','failed','uncertain','applying'].includes(job.status))unavailable++;continue;}
   if(creation){
    if(amount(finance.estimatedUsd)){creation.estimatedUsd=(creation.estimatedUsd??0)+finance.estimatedUsd;estimates++;}
    const estimate=finance.estimate;if(estimate&&['BRL','USD'].includes(estimate.currency)&&amount(estimate.amount)){
     creation.estimatedByCurrency??={};creation.estimatedByCurrency[estimate.currency]=(creation.estimatedByCurrency[estimate.currency]??0)+estimate.amount;estimates++;
    }
   }
   // Independent validation is a distinct measured call, including rejected
   // candidates. Never replace original analysis usage or turn unknown into 0.
   if(finance.qualityValidation){
    const validation=finance.qualityValidation,day=days.get(dayOf(validation.observedAt)),usage=validation.measurement;
    if(day){if(measured(usage)){day.measuredUsd=(day.measuredUsd??0)+usage.list_price_micro_usd/1e6;measurements++;rates.add(usage.rate_version);if(!lastMeasurementAt||Date.parse(validation.observedAt)>Date.parse(lastMeasurementAt))lastMeasurementAt=validation.observedAt;}else unavailable++;}
   }
   // Usage belongs to the day the result was recorded, including an applying
   // execution. A late STT collection must not move its USD usage to admission.
   const measurement=finance.measurement;
   if(recorded){
    const value=measured(measurement)?measurement.list_price_micro_usd/1e6:!Object.hasOwn(finance,'measurement')&&amount(finance.measuredUsd)?finance.measuredUsd:null;
    if(value!==null){recorded.measuredUsd=(recorded.measuredUsd??0)+value;measurements++;if(measured(measurement))rates.add(measurement.rate_version);if(!lastMeasurementAt||Date.parse(recordedAt)>Date.parse(lastMeasurementAt))lastMeasurementAt=recordedAt;}
    else if(['transcription','analysis'].includes(job.stage))unavailable++;
   }
  }
  for(const official of config.days??[]){if(days.has(official.day)&&official.billed&&typeof official.billed.currency==='string'&&Number.isFinite(official.billed.amount))days.get(official.day).billed=official.billed;}
  return {days:[...days.values()],budget:config.budget??{amount:null,currency:'BRL'},coverage:{operational:{from,to,observedAt:nowISO(this.clock),source:'reels-v2-executions'},estimates:estimates?{from,to,observedAt:nowISO(this.clock),source:'reels-v2-executions.rawResult.finance',records:estimates}:config.coverage?.estimates??null,measured:measurements||unavailable?{from,to,observedAt:nowISO(this.clock),source:'reels-v2-executions.rawResult.finance',records:measurements,unavailableRecords:unavailable,lastMeasurementAt,rateVersions:[...rates].sort().join(', ')||null,currency:'USD',billingConfirmed:false}:config.coverage?.measured??null,billing:config.coverage?.billing??null},observedAt:nowISO(this.clock),note:'Referência informativa. Uso medido valorizado por preços de tabela versionados em USD; não é fatura. Estimativas permanecem na moeda original. Ausência de custo é desconhecida.'};
 }
 async update(input){key(input.idempotencyKey);if(input.amount!==null&&(!Number.isFinite(input.amount)||input.amount<0||input.amount>1e12)||!['BRL','USD'].includes(input.currency))throw fail('INVALID_BUDGET','Referência inválida.');
  const id=hash(input.idempotencyKey),fingerprint=hash({amount:input.amount,currency:input.currency});await ensure(this.store,path,{budget:{amount:null,currency:'BRL'},days:[],coverage:null,appliedCommands:[]});
  const updated=await cas(this.store,path,data=>{const prior=(data.appliedCommands??[]).find(x=>x.id===id);if(prior){if(prior.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já utilizada.',409);return null;}return {budget:{amount:input.amount,currency:input.currency},appliedCommands:[...(data.appliedCommands??[]),{id,fingerprint}],observedAt:nowISO(this.clock)};});return {budget:updated.data.budget,observedAt:updated.data.observedAt};
 }
}
