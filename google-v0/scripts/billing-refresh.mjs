import {billingQuery,summarizeBilling} from '../lib/billing-reconciliation.mjs';
import {decodeFields,encodeFields} from '../lib/firestore.mjs';
const project='megabrain-v0-1017370021431',table='gcp_billing_export_v1_016E8F_C651B0_44F070',dataset='megabrain_billing';
async function run(){
 const tokenResponse=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)});if(!tokenResponse.ok)throw Error('Runtime identity unavailable');const {access_token:token}=await tokenResponse.json();
 async function request(url,method='GET',body){const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});if(!r.ok){const e=new Error('Google request failed');e.status=r.status;throw e;}return r.json();}
 const doc=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/settings/financial`;
 const raw=await request(doc),state=decodeFields(raw.fields);const now=new Date();
 if(!Number.isFinite(Date.parse(state.ongoing_costs_valid_until))||!Number.isFinite(Date.parse(state.credit_expires_at))||now>=new Date(state.ongoing_costs_valid_until)||now>=new Date(state.credit_expires_at))return console.log(JSON.stringify({refresh:'stopped_at_authorized_deadline'}));
 if(state.billing_snapshot?.refreshed_at&&now-new Date(state.billing_snapshot.refreshed_at)<20*3600000)return console.log(JSON.stringify({refresh:'cached'}));
 const start=now.toISOString().slice(0,7)+'-01',end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)).toISOString().slice(0,10);
 const query=billingQuery({project,dataset,table,start,end}),root=`https://bigquery.googleapis.com/bigquery/v2/projects/${project}`;
 const tables=await request(`${root}/datasets/${dataset}/tables?maxResults=20`);if(!tables.tables?.some(t=>t.tableReference?.tableId===table))return console.log(JSON.stringify({refresh:'waiting_for_export_table',previous_snapshot_preserved:true}));
 const dry=await request(root+'/jobs','POST',{configuration:{dryRun:true,query:{...query,timeoutMs:undefined,location:undefined}}});
 if(BigInt(dry.statistics?.query?.totalBytesProcessed??'104857601')>104857600n)throw Error('Billing query above preventive byte limit');
 let result=await request(root+'/queries','POST',query);
 if(!result.jobComplete){const ref=result.jobReference;for(let i=0;i<6&&!result.jobComplete;i++)result=await request(`${root}/queries/${ref.jobId}?location=US&timeoutMs=10000&maxResults=100`);}
 if(!result.jobComplete||result.pageToken)throw Error('Incomplete billing result');
 const names=result.schema.fields.map(f=>f.name),rows=(result.rows??[]).map(r=>Object.fromEntries(r.f.map((f,i)=>[names[i],f.v])));
 const summary=summarizeBilling(rows,project);const stamp=now.toISOString();
 const snapshot={...state.billing_snapshot,...summary,period_label:`${start} até ${end} (fim exclusivo)`,observed_label:stamp,refreshed_at:stamp,source:'Google Cloud Billing Standard export',credit_observed_label:state.billing_snapshot?.credit_observed_label??state.billing_snapshot?.observed_label??'Não conferido',refresh_status:'official_export'};
 const params=new URLSearchParams({'updateMask.fieldPaths':'billing_snapshot','currentDocument.updateTime':raw.updateTime});await request(doc+'?'+params,'PATCH',{fields:encodeFields({billing_snapshot:snapshot})});
 console.log(JSON.stringify({refresh:'completed',project_usage_cents:summary.project_usage_cents,account_usage_cents:summary.account_usage_cents,processing_activation:false}));
}
run().catch(e=>{console.error(JSON.stringify({refresh:'failed',http_status:e.status??null,previous_snapshot_preserved:true}));process.exitCode=1;});
