import {readFileSync,writeFileSync,openSync,writeSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {GoogleREST} from '../lib/google-rest.mjs';
import {Firestore,decodeFields,encodeValue} from '../lib/firestore.mjs';
import {prepareConfirmedFailureReset,applyConfirmedFailureReset,resetMetadataRecord,resetSnapshotFields} from '../lib/reels-confirmed-failure-reset.mjs';
const project='megabrain-v0-1017370021431';
const sha=v=>createHash('sha256').update(v).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
async function parallelReads(tasks){let cursor=0;const out=new Array(tasks.length);await Promise.all(Array.from({length:Math.min(8,tasks.length)},async()=>{while(cursor<tasks.length){const index=cursor++;out[index]=await tasks[index]();}}));return out.flat().filter(Boolean);}
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
export function createResetOwnerStore(api,{assertRuntimeClosed}={}){
 need(typeof assertRuntimeClosed==='function','Independent four-service runtime guard required.');
 const firestore=new Firestore(api);
 async function getRecord(path,transaction){
  let r;
  if(transaction){
   // batchGet binds both found and missing documents to this exact read/write
   // transaction. Missing legacy publications are guarded reads, not an HTTP
   // 404 interpreted outside the transaction or an untracked absence check.
   const name=`projects/${project}/databases/(default)/documents/${path}`,rows=await api.request(firestore.root+':batchGet',{method:'POST',json:{documents:[name],transaction}});
   need(Array.isArray(rows),'Transactional document response must be streamed rows.');
   const documents=rows.filter(row=>row.found||row.missing);need(documents.length===1,'Transactional document membership differs.');
   const row=documents[0];if(row.missing){need(row.missing===name&&!row.found,'Missing document outside requested identity.');return null;}
   need(!Object.hasOwn(row,'missing')&&row.found?.name===name,'Found document outside requested identity.');r=row.found;
  }else{
   try{r=await api.request(firestore.root+'/'+path);}catch(error){if(error.status===404)return null;throw error;}
  }
  return resetMetadataRecord({path,data:decodeFields(r.fields??{}),updateTime:r.updateTime});
 }
 async function globalGuards(transaction){return parallelReads([()=>getRecord('settings/capacity',transaction),()=>getRecord('settings/financial',transaction),()=>scan('control_chunks',resetSnapshotFields.control_chunks,[],transaction)]);}
 async function scan(collection,select,filters=[],transaction){
  const out=[],seen=new Set();let cursor;
  do{
   const q={from:[{collectionId:collection}],select:{fields:select.map(fieldPath=>({fieldPath}))},orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit:500};
   const terms=filters.map(f=>({fieldFilter:{field:{fieldPath:f.field},op:f.op==='contains'?'ARRAY_CONTAINS':'EQUAL',value:encodeValue(f.value)}}));if(terms.length)q.where=terms.length===1?terms[0]:{compositeFilter:{op:'AND',filters:terms}};
   if(cursor)q.startAt={values:[{referenceValue:cursor}],before:false};
   const response=await api.request(firestore.root+':runQuery',{method:'POST',json:{structuredQuery:q,...(transaction?{transaction}:{})}}),docs=response.filter(r=>r.document).map(r=>r.document);
   for(const r of docs){const prefix=`projects/${project}/databases/(default)/documents/`;need(r.name?.startsWith(prefix+collection+'/'),'Document outside fixed project/collection.');out.push(resetMetadataRecord({path:r.name.slice(prefix.length),data:decodeFields(r.fields??{}),updateTime:r.updateTime}));}
   cursor=docs.length===500?docs.at(-1).name:null;need(!cursor||!seen.has(cursor),'Metadata pagination did not advance.');seen.add(cursor);
  }while(cursor);return out;
 }
 async function inspectResetMetadata(id,{transaction}={}){
  // All reads share the same Firestore transaction. Only independent metadata
  // requests run concurrently; pagination stays sequential and writes never do.
  const tasks=['videos','reels_legacy_content'].map(collection=>()=>getRecord(collection+'/'+id,transaction));
  for(const collection of ['jobs','reels_executions','execution_stops','analyses','reels_reconciliations','reels_events','reels_command_items','reels_commands','reels_historical_activity']){
   if(collection==='reels_commands'){for(const field of ['selected','accepted'])tasks.push(()=>scan(collection,resetSnapshotFields[collection],[{field,op:'contains',value:id}],transaction));continue;}
   const fields=collection==='jobs'?['video_id','reelId','payload.videoId']:['execution_stops','analyses'].includes(collection)?['video_id','reelId']:['reelId'];
   for(const field of fields)tasks.push(()=>scan(collection,resetSnapshotFields[collection],[{field,op:'eq',value:id}],transaction));
  }
  const rows=await parallelReads(tasks);rows.push(...await globalGuards(transaction));return [...new Map(rows.map(r=>[r.path,r])).values()];
 }
 async function assertClosed(){
  await assertRuntimeClosed();
  for(const stage of ['acquisition','transcription','analysis']){
   const url=firestore.root+'/reels_controls/'+stage+'?mask.fieldPaths=paused&mask.fieldPaths=active&mask.fieldPaths=desiredConcurrency&mask.fieldPaths=effectiveConcurrency',c=await api.request(url),fields=c.fields??{},active=fields.active,contents=active?.arrayValue;
   // Inspect raw REST types here as well as the independent owner guard. An
   // explicit empty array proves occupancy; effectiveConcurrency is capacity.
   const empty=active&&typeof active==='object'&&!Array.isArray(active)&&Object.keys(active).length===1&&Object.hasOwn(active,'arrayValue')&&contents&&typeof contents==='object'&&!Array.isArray(contents)&&Object.keys(contents).every(k=>k==='values')&&(!Object.hasOwn(contents,'values')||Array.isArray(contents.values)&&contents.values.length===0);
   const capacity=name=>fields[name]&&typeof fields[name]==='object'&&!Array.isArray(fields[name])&&Object.keys(fields[name]).length===1&&fields[name].integerValue==='1';
   need(fields.paused?.booleanValue===true&&empty&&capacity('desiredConcurrency')&&capacity('effectiveConcurrency'),'Stage is not closed.');
   const q=await api.request(`https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues/v0-${stage}`);
   need(q.state==='PAUSED','Queue is not paused.');
   const tasks=await api.request(`https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues/v0-${stage}/tasks?pageSize=1`);need(!tasks.tasks?.length&&!tasks.nextPageToken,'Queue is not empty.');
  }
  const legacyQueue=await api.request(`https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues/v0-processing`);need(legacyQueue.state==='PAUSED','Legacy queue is not paused.');
  const legacyTasks=await api.request(`https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues/v0-processing/tasks?pageSize=1`);need(!legacyTasks.tasks?.length&&!legacyTasks.nextPageToken,'Legacy queue is not empty.');
 }
 return {inspectResetMetadata,assertClosed,beginResetTransaction:async()=>{const r=await api.request(firestore.root+':beginTransaction',{method:'POST',json:{options:{readWrite:{}}}});need(typeof r.transaction==='string'&&r.transaction,'Transaction not confirmed.');return r.transaction;},rollbackResetTransaction:async transaction=>api.request(firestore.root+':rollback',{method:'POST',json:{transaction}}),atomicResetCommit:async(writes,{transaction})=>{need(typeof transaction==='string'&&transaction,'Commit requires transaction.');need(Array.isArray(writes)&&writes.length>0&&writes.length<=450&&writes.every(w=>(w.update||w.delete)&&Object.keys(w).every(k=>['update','delete','updateMask','currentDocument'].includes(k))&&!w.verify),'Write outside Firestore update/delete contract.');return api.request(firestore.root+':commit',{method:'POST',json:{writes,transaction}});}};
}
export async function main(args=process.argv.slice(2)){
 const [mode,...pairs]=args,opts={};need(['prepare','apply'].includes(mode)&&pairs.length%2===0,'Use prepare --input metadata.json --output NEW-plan.json; or apply --plan plan.json --approved-sha SHA --confirm delete-confirmed-history --output NEW-receipt.json.');
 const allowed=mode==='prepare'?['--input','--output']:['--plan','--approved-sha','--confirm','--output','--runtime-guard','--runtime-guard-sha'];
 for(let n=0;n<pairs.length;n+=2){need(allowed.includes(pairs[n])&&!opts[pairs[n]],'Invalid or duplicate option.');opts[pairs[n]]=pairs[n+1];}
 need(opts['--output'],'New output path required.');
 if(mode==='prepare'){
  need(opts['--input'],'Metadata input required.');const inputBytes=readFileSync(opts['--input']);need(inputBytes.length<=8000000,'Metadata input exceeds limit.');
  const plan=prepareConfirmedFailureReset(JSON.parse(inputBytes));write(opts['--output'],plan);console.log(JSON.stringify({mode,rows:plan.rows.length,excluded:plan.excluded.length,planSHA256:plan.planSHA256,inputSHA256:sha(inputBytes),googleWrites:0,providerCalls:0,createsErrorBackup:false}));return;
 }
 need(opts['--plan']&&opts['--confirm']==='delete-confirmed-history','Explicit confirmed-history deletion required.');
 const token=process.env.GOOGLE_OAUTH_ACCESS_TOKEN;need(typeof token==='string'&&token.length>0,'Owner token is required in memory; no credential file is read.');
 need(opts['--runtime-guard']&&/^[a-f0-9]{64}$/.test(opts['--runtime-guard-sha']??''),'Reviewed runtime guard required.');
 const assertRuntimeClosed=async()=>{need(sha(readFileSync(opts['--runtime-guard']))===opts['--runtime-guard-sha'],'Runtime guard source changed.');const out=execFileSync('python3',[opts['--runtime-guard']],{encoding:'utf8',timeout:120000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});let proof;try{proof=JSON.parse(out);}catch{throw Error('Runtime guard confirmation missing.');}need(proof.project===project&&proof.closed===true&&proof.fourServicesClosed===true&&proof.fourQueuesClosed===true&&proof.legacyPreserved===true,'Four-service runtime guard rejected.');};
 const api=new GoogleREST({project,tokenProvider:async()=>token}),store=createResetOwnerStore(api,{assertRuntimeClosed});
 need(!existsSync(opts['--output']),'Output already exists; inspect previous result.');
 const journal=openSync(opts['--output']+'.progress.jsonl','wx',0o600);let result;
 try{const onReceipt=async receipt=>{const row={id:receipt.id,status:receipt.status,planSHA256:receipt.planSHA256,...(receipt.expectedUpdateTime?{expectedUpdateTime:receipt.expectedUpdateTime}:{}),...(receipt.observedUpdateTime?{observedUpdateTime:receipt.observedUpdateTime}:{})};writeSync(journal,JSON.stringify(row)+'\n');fsyncSync(journal);};result=await applyConfirmedFailureReset({plan:load(opts['--plan']),approvedPlanSHA256:opts['--approved-sha'],store,project,assertClosed:store.assertClosed,onReceipt});write(opts['--output'],result);}finally{closeSync(journal);}
 console.log(JSON.stringify({mode,resetCount:result.resetCount,alreadyReset:result.alreadyReset,providerCalls:0,startedReels:0,createsErrorBackup:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(()=>{console.error('Confirmed-failure reset stopped. No diagnostics or credentials were exported. Inspect the exact reviewed membership; do not replay an ambiguous write.');process.exitCode=1;});}
