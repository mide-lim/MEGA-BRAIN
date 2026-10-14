import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {measureGeminiUsage,measureSpeechUsage,summarizeUsageMeasurements} from '../lib/usage-costs.mjs';
const [input,output,...extra]=process.argv.slice(2);
if(!input||!output||extra.length||resolve(input)===resolve(output))throw Error('Use: node summarize-usage.mjs input.json output.json (different files).');
const records=JSON.parse(readFileSync(input,'utf8'));
if(!Array.isArray(records))throw Error('Input must be an array of local artifact envelopes.');
const measurements=records.map(record=>{
 const a=record?.artifact;
 if(a?.usage_cost)return a.usage_cost;
 if(record?.stage==='analysis')return measureGeminiUsage(a?.response,{model:a?.model,location:'global'});
 if(record?.stage==='transcription')return measureSpeechUsage(a?.raw,{model:a?.model,location:'us',mode:a?.mode==='synchronous'?'synchronous':'batch',audioUri:record.audio_uri});
 return {status:'unavailable',reason:'unsupported_stage_or_artifact'};
});
const report=summarizeUsageMeasurements(measurements);
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({records:report.records,measured:report.measured_records,unavailable:report.unavailable_records,usd_list_price:report.list_price_micro_usd/1e6,billing_confirmed:false}));
