// Recorded usage with versioned list prices; never a BRL ledger settlement.
export const usageRateVersion='google-list-2026-10-14';
const base=service=>({schema_version:1,service,currency:'USD',rate_version:usageRateVersion,billing_confirmed:false,scope:'provider_usage_only_excludes_infrastructure_tax_currency_and_credits'});
const unavailable=(service,reason)=>({...base(service),status:'unavailable',reason});
const count=n=>Number.isSafeInteger(n)&&n>=0;
export function measureGeminiUsage(response,{model,location='global'}={}){
 const service='gemini';
 if(model!=='gemini-3.5-flash-lite'||location!=='global')return unavailable(service,'unsupported_model_or_location');
 const u=response?.usageMetadata;
 if(!u||u.trafficType!=='ON_DEMAND')return unavailable(service,'missing_usage_or_unsupported_traffic');
 const prompt=u.promptTokenCount,output=u.candidatesTokenCount,thoughts=u.thoughtsTokenCount??0,cached=u.cachedContentTokenCount??0;
 if(![prompt,output,thoughts,cached].every(count)||cached>prompt)return unavailable(service,'invalid_token_counts');
 const total=prompt+output+thoughts;
 if(!count(total)||(u.totalTokenCount!==undefined&&u.totalTokenCount!==total)||(u.toolUsePromptTokenCount??0)!==0)return unavailable(service,'inconsistent_or_unsupported_token_usage');
 // Hundredths of micro-USD avoid floating-point price rounding.
 const numerator=(prompt-cached)*30+cached*3+(output+thoughts)*250;
 if(!count(numerator))return unavailable(service,'estimate_exceeds_safe_integer');
 return {...base(service),status:'measured',model,location,traffic_type:u.trafficType,source:'response.usageMetadata',usage:{prompt_tokens:prompt,cached_prompt_tokens:cached,output_tokens:output,thought_tokens:thoughts},list_price_micro_usd:Math.ceil(numerator/100)};
}
function durationNanos(value){
 if(typeof value!=='string')return null;
 const m=/^(\d{1,12})(?:\.(\d{1,9}))?s$/.exec(value);
 return m?BigInt(m[1])*1000000000n+BigInt((m[2]??'').padEnd(9,'0')):null;
}
export function measureSpeechUsage(response,{model,location,mode,audioUri}={}){
 const service='speech';
 if(model!=='chirp_3'||location!=='us'||!['synchronous','batch'].includes(mode))return unavailable(service,'unsupported_speech_configuration');
 let values=[];
 if(mode==='synchronous')values=[['response.metadata.totalBilledDuration',response?.metadata?.totalBilledDuration],['response.totalBilledDuration',response?.totalBilledDuration]];
 else{
  const keys=Object.keys(response?.results??{});
  if(typeof audioUri!=='string'||keys.length!==1||keys[0]!==audioUri)return unavailable(service,'requires_exact_single_audio_file');
  values=[['response.results[file].metadata.totalBilledDuration',response.results[audioUri]?.metadata?.totalBilledDuration],['response.totalBilledDuration',response.totalBilledDuration]];
 }
 const present=values.filter(([,value])=>value!==undefined);
 if(!present.length)return unavailable(service,'missing_billed_duration');
 const durations=present.map(([,value])=>durationNanos(value));
 if(durations.some(n=>n===null)||durations.some(n=>n!==durations[0]))return unavailable(service,'invalid_or_conflicting_billed_duration');
 // Standard v2 recognition: USD0.016/minute. Global and per-file totals
 // describe the same single file and must be counted once, not added.
 const denominator=60n*1000000000n,numerator=durations[0]*16000n;
 const micro=(numerator+denominator-1n)/denominator;
 if(micro>BigInt(Number.MAX_SAFE_INTEGER))return unavailable(service,'estimate_exceeds_safe_integer');
 return {...base(service),status:'measured',model,location,mode,source:present.map(([path])=>path).join(' = '),usage:{billed_duration:present[0][1]},list_price_micro_usd:Number(micro)};
}
export function summarizeUsageMeasurements(records){
 if(!Array.isArray(records))throw Error('Measurements must be an array.');
 const totals={gemini:0,speech:0},missing=[];let measured=0;
 for(const [index,r] of records.entries()){
  if(r?.status!=='measured'||r.schema_version!==1||r.currency!=='USD'||r.rate_version!==usageRateVersion||r.billing_confirmed!==false||!Object.hasOwn(totals,r.service)||!count(r.list_price_micro_usd)){
   missing.push({index,reason:r?.reason??'invalid_measurement'});continue;
  }
  const next=totals[r.service]+r.list_price_micro_usd;
  if(!count(next))throw Error('Usage total exceeds safe integer.');
  totals[r.service]=next;measured++;
 }
 const total=totals.gemini+totals.speech;if(!count(total))throw Error('Usage total exceeds safe integer.');
 return {schema_version:1,currency:'USD',rate_version:usageRateVersion,billing_confirmed:false,records:records.length,measured_records:measured,unavailable_records:missing.length,unavailable:missing,list_price_micro_usd_by_service:totals,list_price_micro_usd:total,scope:base('gemini').scope};
}
