import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {decodeFields,encodeFields} from '../google-v0/lib/firestore.mjs';
import {ReelsRepository} from '../google-v0/lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../google-v0/lib/reels-contextual-catalogue-runtime.mjs';
import {semanticSourceFromSaved,semanticHash} from '../google-v0/lib/reels-semantic-source.mjs';
import {frozenSemanticSourceFromSaved} from '../google-v0/lib/reels-semantic-source-v1.mjs';
import {semanticPromptHash,semanticWireSchemaVersion,semanticSchemaForPhase} from '../google-v0/lib/reels-semantic-provider.mjs';
import {semanticSourceRecoveryPath,semanticSourceRecoveryReceiptValid,validateSemanticSourceRecoveryRow} from '../google-v0/lib/reels-semantic-source-recovery.mjs';
import {rejectedSemanticRecoveryScope as S,rejectedSemanticRecoveryPath,rejectedSemanticRecoveryReviewScope,prepareRejectedSemanticAttemptRecovery,validateRejectedSemanticAttemptRecovery} from '../google-v0/lib/reels-semantic-rejected-attempt-recovery.mjs';
import {prepareSemanticCorrectiveCapability} from '../google-v0/lib/reels-semantic-corrective-capability.mjs';

export const correctiveOwnerScope=Object.freeze({project:'megabrain-v0-1017370021431',location:'us-central1',maximumReadBytes:8*1024*1024,transactionBudgetMs:18000,maximumCaptureMs:300000});
const P=correctiveOwnerScope.project,region='projects/'+P+'/locations/us-central1',documents='projects/'+P+'/databases/(default)/documents/',firestore='https://firestore.googleapis.com/v1/'+documents.slice(0,-1);
const stages=['acquisition','transcription','analysis'],queueKinds=['processing',...stages,'curation'],serviceKinds=['web',...stages];
const fail=code=>{throw Object.assign(Error(code),{code});},need=(value,code)=>{if(!value)fail(code);};
const sha=text=>createHash('sha256').update(text).digest('hex'),same=(a,b)=>semanticHash(a)===semanticHash(b),hex=v=>/^[a-f0-9]{64}$/.test(v??''),date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const jsonBytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
const fixedJob='reels_index/semantic_job_'+S.jobId,fixedFirst='reels_index/semantic_result_'+S.firstBatchId,fixedResult='reels_index/semantic_result_'+S.oldBatchId;
const rawPaths=()=>Array.from({length:12},(_,i)=>'reels_index/semantic_raw_'+S.oldBatchId+'_'+i);
const allowedPath=path=>/^(videos|reels_legacy_content|reels_quality_receipts)\/[A-Za-z0-9_-]{1,128}$/.test(path)||/^(settings\/(reels_v2_taxonomy|reels_v2_semantic_policy|admission|automation)|reels_controls\/(acquisition|transcription|analysis))$/.test(path)||/^reels_index\/(semantic_[A-Za-z0-9_-]{1,180}|contextual_review_[A-Za-z0-9_-]{5,32})$/.test(path);
const metadataSnapshot=row=>({path:row.path,updateTime:row.updateTime,data:row.data,readTime:row.readTime});
function uniqueChecks(checks){
 const found=new Map();for(const c of checks){need(allowedPath(c.path)&&((date(c.updateTime))||c.updateTime===null),'CAS_CHECK_INVALID');if(found.has(c.path))need(found.get(c.path)===c.updateTime,'CAPTURE_VERSION_CHANGED');found.set(c.path,c.updateTime);}
 return [...found].map(([path,updateTime])=>({path,updateTime})).sort((a,b)=>a.path.localeCompare(b.path));
}
function rawQuery(transaction=null){
 return {structuredQuery:{from:[{collectionId:'reels_index'}],select:{fields:[{fieldPath:'kind'},{fieldPath:'batchId'}]},where:{compositeFilter:{op:'AND',filters:[{fieldFilter:{field:{fieldPath:'kind'},op:'EQUAL',value:{stringValue:'semantic_raw'}}},{fieldFilter:{field:{fieldPath:'batchId'},op:'EQUAL',value:{stringValue:S.oldBatchId}}}]}},limit:13},...(transaction?{transaction}:{})};
}
function assertRequest(url,options,commitHash){
 const u=new URL(url),method=options.method??'GET';
 need(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'HTTPS_METADATA_ONLY');
 if(u.hostname==='firestore.googleapis.com'){
  need(method==='POST'&&u.origin+u.pathname===firestore+':'+u.pathname.split(':').at(-1)&&!u.search,'FIRESTORE_ROUTE_DENIED');
  const action=u.pathname.split(':').at(-1),body=options.json??{};
  if(action==='batchGet'){need(Array.isArray(body.documents)&&body.documents.length>0&&body.documents.length<=128&&new Set(body.documents).size===body.documents.length&&body.documents.every(n=>typeof n==='string'&&n.startsWith(documents)&&allowedPath(n.slice(documents.length))),'BATCH_GET_SCOPE_DENIED');return;}
  if(action==='runQuery'){need(same(body,rawQuery(body.transaction??null)),'QUERY_SCOPE_DENIED');return;}
  if(action==='beginTransaction'){need(same(body,{options:{readWrite:{}}}),'TRANSACTION_SCOPE_DENIED');return;}
  if(action==='rollback'){need(typeof body.transaction==='string'&&Object.keys(body).length===1,'ROLLBACK_SCOPE_DENIED');return;}
  if(action==='commit'){need(commitHash&&semanticHash(body)===commitHash,'COMMIT_NOT_ARMED');return;}
  fail('FIRESTORE_ACTION_DENIED');
 }
 need(method==='GET'&&Object.keys(options).every(k=>['method'].includes(k)),'READ_ONLY_SERVICE_METADATA');
 if(u.hostname==='run.googleapis.com'){
  need(serviceKinds.concat('worker').some(k=>u.pathname==='/v2/'+region+'/services/megabrain-v0-'+k),'RUN_METADATA_ROUTE_DENIED');return;
 }
 if(u.hostname==='cloudtasks.googleapis.com'){
  need(queueKinds.some(k=>u.pathname==='/v2/'+region+'/queues/v0-'+k||u.pathname==='/v2/'+region+'/queues/v0-'+k+'/tasks'),'QUEUE_METADATA_ROUTE_DENIED');return;
 }
 fail('HOST_DENIED');
}
export class CorrectiveOwnerMetadataClient{
 #token;#fetch;#commitHash=null;#commitSent=false;
 constructor({token,fetchImpl=globalThis.fetch,clock=Date.now}){need(typeof token==='string'&&token.length>10,'OPAQUE_OWNER_TOKEN_REQUIRED');this.#token=token;this.#fetch=fetchImpl;this.clock=clock;this.bytesRead=0;}
 armCommit(body){
  need(!this.#commitSent&&!this.#commitHash,'COMMIT_ALREADY_ARMED');
  need(typeof body?.transaction==='string'&&Array.isArray(body.writes)&&body.writes.length===3,'THREE_METADATA_WRITES_ONLY');
  const paths=body.writes.map(w=>w.update?.name?.startsWith(documents)?w.update.name.slice(documents.length):null);
  need(new Set(paths).size===3&&paths.includes(fixedJob)&&paths.includes(rejectedSemanticRecoveryPath())&&paths.some(p=>/^reels_index\/semantic_corrective_capability_[a-f0-9]{64}$/.test(p??'')),'FINITE_METADATA_WRITE_PATHS_REQUIRED');
  for(const w of body.writes){need(Object.keys(w).sort().join(',')==='currentDocument,update'&&Object.keys(w.update).sort().join(',')==='fields,name','METADATA_TRANSFORM_DENIED');const path=w.update.name.slice(documents.length);need(path===fixedJob?same(w.currentDocument,{updateTime:S.jobUpdateTime}):same(w.currentDocument,{exists:false}),'METADATA_WRITE_PRECONDITION_REQUIRED');if(path===fixedJob){const job=decodeFields(w.update.fields);need(job.id===S.jobId&&job.status==='prepared'&&job.callsUsed===2&&job.cursor===8&&job.maxCalls===127&&job.batch===null&&job.dispatch?.sequence===2,'COUNTER_OR_DISPATCH_RESET_DENIED');}}
  this.#commitHash=semanticHash(body);
 }
 async request(url,options={}){
  assertRequest(url,options,this.#commitHash);
  const committing=url===firestore+':commit';if(committing){need(!this.#commitSent,'COMMIT_ALREADY_SENT');this.#commitSent=true;}
  let response;
  try{response=await this.#fetch(url,{method:options.method??'GET',headers:{Authorization:'Bearer '+this.#token,...(options.json?{'Content-Type':'application/json'}:{})},...(options.json?{body:JSON.stringify(options.json)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw Object.assign(Error(committing?'COMMIT_ACKNOWLEDGEMENT_UNCERTAIN':'GOOGLE_METADATA_REQUEST_UNCERTAIN'),{code:committing?'COMMIT_ACKNOWLEDGEMENT_UNCERTAIN':'GOOGLE_METADATA_REQUEST_UNCERTAIN',commitSent:committing});}
  let text;try{text=await response.text();}catch{throw Object.assign(Error('GOOGLE_METADATA_RESPONSE_UNCERTAIN'),{code:'GOOGLE_METADATA_RESPONSE_UNCERTAIN',commitSent:committing});}
  this.bytesRead+=Buffer.byteLength(text,'utf8');need(this.bytesRead<=correctiveOwnerScope.maximumReadBytes,'METADATA_READ_BUDGET_EXCEEDED');
  if(!response.ok)throw Object.assign(Error('GOOGLE_METADATA_HTTP_REJECTED'),{code:'GOOGLE_METADATA_HTTP_REJECTED',status:response.status,commitSent:committing});
  try{return JSON.parse(text);}catch{throw Object.assign(Error('GOOGLE_METADATA_RESPONSE_INVALID'),{code:'GOOGLE_METADATA_RESPONSE_INVALID',commitSent:committing});}
 }
 async batchGet(paths,{transaction=null,metadataOnly=false}={}){
  const body={documents:paths.map(p=>documents+p),...(transaction?{transaction}:{}),...(metadataOnly?{mask:{fieldPaths:['id']}}:{})};
  const rows=await this.request(firestore+':batchGet',{method:'POST',json:body});
  need(Array.isArray(rows)&&rows.length===paths.length,'DOCUMENT_CAPTURE_INCOMPLETE');
  const expected=new Set(paths),out=new Map();
  for(const row of rows){
   const name=row.found?.name??row.missing;need(typeof name==='string'&&name.startsWith(documents)&&!Boolean(row.found&&row.missing),'DOCUMENT_CAPTURE_INVALID');
   const path=name.slice(documents.length);need(expected.has(path)&&!out.has(path)&&date(row.readTime),'DOCUMENT_CAPTURE_SCOPE_OR_READTIME_INVALID');
   if(row.found)need(date(row.found.updateTime),'DOCUMENT_EPOCH_MISSING');
   out.set(path,{path,exists:Boolean(row.found),data:row.found?decodeFields(row.found.fields??{}):null,updateTime:row.found?.updateTime??null,readTime:row.readTime});
  }
  return out;
 }
}
export const correctiveServiceConfigurationHash=s=>semanticHash(serviceView(s));
function serviceView(s){const template=structuredClone(s.template);delete template.revision;return {template,traffic:s.traffic??[],ingress:s.ingress,scaling:s.scaling,invokerIamDisabled:s.invokerIamDisabled??false,defaultUriDisabled:s.defaultUriDisabled??false,iapEnabled:s.iapEnabled??false,customAudiences:s.customAudiences??[],binaryAuthorization:s.binaryAuthorization??null};}
export async function inspectCorrectiveFences(client,deployment){
 need(deployment?.ownerIdentity?.kind==='reviewed_owner_identity'&&typeof deployment.ownerIdentity.email==='string','PINNED_PRIVATE_OWNER_IDENTITY_REQUIRED');
 need(deployment?.schemaVersion===1&&/^[a-f0-9]{40}$/.test(deployment.sourceCommit??'')&&/^[a-f0-9]{40}$/.test(deployment.sourceTree??'')&&deployment.hashAlgorithm==='semanticHash-json-utf8-v1','REVIEWED_DEPLOYMENT_MANIFEST_REQUIRED');
 const services={},queues={},reads=[];
 for(const kind of serviceKinds.concat(deployment.services?.worker?'worker':[])){
  const expected=deployment.services?.[kind];need(expected&&typeof expected.revision==='string'&&/^sha256:[a-f0-9]{64}$/.test(expected.imageDigest??'')&&hex(expected.configurationHash),'DEPLOYMENT_SERVICE_PIN_REQUIRED');
  const q=new URLSearchParams({fields:'name,template,traffic,ingress,scaling,invokerIamDisabled,defaultUriDisabled,iapEnabled,customAudiences,binaryAuthorization,latestReadyRevision,terminalCondition,reconciling'});
  const s=await client.request('https://run.googleapis.com/v2/'+region+'/services/megabrain-v0-'+kind+'?'+q);
  need(!s.reconciling&&s.terminalCondition?.state==='CONDITION_SUCCEEDED'&&s.latestReadyRevision===expected.revision,'DEPLOYMENT_NOT_READY_OR_REVISION_CHANGED');
  const c=s.template?.containers?.[0],closed=c?.env?.find(e=>e.name==='MEGABRAIN_REELS_CLOSED_RELEASE')?.value;
  need(typeof c?.image==='string'&&c.image.endsWith('@'+expected.imageDigest)&&semanticHash(serviceView(s))===expected.configurationHash,'DEPLOYMENT_CONFIGURATION_CHANGED');
  if(kind!=='worker')need(closed==='v2','REEL_RUNTIME_NOT_CLOSED');
  services[kind]={revision:s.latestReadyRevision,imageDigest:expected.imageDigest,configurationHash:expected.configurationHash,closedRelease:kind==='worker'?null:closed};
 }
 for(const kind of queueKinds){
  const url='https://cloudtasks.googleapis.com/v2/'+region+'/queues/v0-'+kind;
  const q=await client.request(url+'?fields=name,state'),tasks=await client.request(url+'/tasks?pageSize=1&responseView=BASIC&fields=tasks.name,nextPageToken');
  need(q.name===region+'/queues/v0-'+kind&&q.state==='PAUSED'&&!(tasks.tasks?.length)&&!tasks.nextPageToken,'QUEUES_MUST_REMAIN_PAUSED_EMPTY');
  queues[kind]={name:q.name,state:q.state,empty:true};
 }
 const paths=[...stages.map(s=>'reels_controls/'+s),'settings/admission','settings/automation'];
 const docs=await client.batchGet(paths);
 for(const stage of stages){const row=docs.get('reels_controls/'+stage);need(row?.exists&&row.data.paused===true&&Array.isArray(row.data.active)&&row.data.active.length===0,'REEL_CONTROL_OCCUPIED_OR_OPEN');reads.push({path:row.path,updateTime:row.updateTime});}
 for(const key of ['admission','automation']){const row=docs.get('settings/'+key);need(row?.exists&&row.data.enabled===false,'REEL_WRITER_NOT_DISABLED');reads.push({path:row.path,updateTime:row.updateTime});}
 return {services,queues,checks:reads,observedAt:new Date(client.clock()).toISOString(),fingerprint:semanticHash({services,queues,checks:reads}),providerCalls:0,writes:0};
}
class CaptureStore{
 constructor(client){this.client=client;this.rows=new Map();}
 async get(path){const row=(await this.client.batchGet([path])).get(path),old=this.rows.get(path);if(old)need(old.updateTime===row.updateTime,'CAPTURE_VERSION_CHANGED');this.rows.set(path,row);return row.exists?{data:row.data,updateTime:row.updateTime}:null;}
 row(path){const row=this.rows.get(path);need(row,'CAPTURE_ROW_MISSING');return row;}
 checks(){return [...this.rows.values()].map(r=>({path:r.path,updateTime:r.updateTime}));}
}
function absent(row){return {path:row.path,exists:row.exists,updateTime:row.updateTime,readTime:row.readTime};}
async function queryAbsentRaw(client,transaction=null){
 const rows=await client.request(firestore+':runQuery',{method:'POST',json:rawQuery(transaction)});
 need(Array.isArray(rows)&&rows.length>0&&rows.every(r=>date(r.readTime))&&!rows.some(r=>r.document),'REJECTED_RAW_ABSENCE_NOT_PROVEN');
 return {collection:'reels_index',filters:[{field:'kind',op:'eq',value:'semantic_raw'},{field:'batchId',op:'eq',value:S.oldBatchId}],records:[],complete:true,readTime:rows.map(r=>r.readTime).sort()[0]};
}
export async function collectCorrectivePreparation({client,deployment,evidence,review=null,clock=Date.now}){
 const started=clock(),fences=await inspectCorrectiveFences(client,deployment),store=new CaptureStore(client),repository=new ReelsRepository({store,cacheTtlMs:0}),runtime=new ReelsCatalogueRuntime({repository,clock});
 const job=await store.get(fixedJob);need(job?.data.id===S.jobId&&job.updateTime===S.jobUpdateTime,'FINITE_JOB_EPOCH_CHANGED');
 const j=job.data;need(j.pins?.length===499&&semanticHash(j.pins)===j.cohortHash,'FINITE_COHORT_CHANGED');
 await store.get('settings/reels_v2_semantic_policy');await store.get('reels_index/semantic_authorization_'+semanticHash(j.policy.authorizationId));await store.get(fixedFirst);
 const first=store.row(fixedFirst);need(first.data?.processed===true&&Array.isArray(first.data.rawChunks)&&first.data.rawChunks.length>0&&first.data.rawChunks.length<=12,'FIRST_RESPONSE_NOT_PRESERVED');
 const historicalPath=semanticSourceRecoveryPath(S.firstBatchId);await store.get(historicalPath);
 const historical=store.row(historicalPath);need(historical.exists&&semanticSourceRecoveryReceiptValid(historical.data),'HISTORICAL_RECOVERY_RECEIPT_INVALID');
 const historicalRawChunks=[];for(const path of first.data.rawChunks){need(path.startsWith('reels_index/semantic_raw_'+S.firstBatchId+'_'),'HISTORICAL_RAW_PATH_CHANGED');await store.get(path);const row=store.row(path);need(row.exists,'HISTORICAL_RAW_MISSING');historicalRawChunks.push(metadataSnapshot(row));}
 const currentSources=[];
 for(let offset=0;offset<16;offset++){
  const pin=j.pins[offset],loaded=await runtime.loadSource(pin.id);need(loaded&&same(loaded.sourceVersions,pin.sourceVersions),'SAVED_SOURCE_EPOCH_CHANGED');
  const source=semanticSourceFromSaved(loaded);need(!source.truncated,'COMPLETE_SOURCE_REQUIRED_FOR_CORRECTION');
  if(offset<8){
   const originalPin=first.data.binding.pins.find(p=>p.id===source.id),row=historical.data.rows.find(r=>r.id===source.id);
   need(originalPin&&validateSemanticSourceRecoveryRow(row,source,originalPin,{legacySource:frozenSemanticSourceFromSaved(loaded)}),'HISTORICAL_FIRST_SOURCE_CHANGED');
  }else{
   currentSources.push({id:source.id,sourceProjectionVersion:source.sourceProjectionVersion,semanticProofHash:source.semanticProofHash,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash,readTime:store.row('videos/'+pin.id).readTime});
  }
 }
 await store.get('settings/reels_v2_taxonomy');await store.get('reels_index/semantic_coordinator');
 const schema=semanticSchemaForPhase('extract',{sources:currentSources,catalogue:{groups:[]}});
 const paths=[fixedResult,...rawPaths(),rejectedSemanticRecoveryPath()];
 for(const path of paths)await store.get(path);
 const input={now:new Date(clock()).toISOString(),job:metadataSnapshot(store.row(fixedJob)),policy:metadataSnapshot(store.row('settings/reels_v2_semantic_policy')),authorization:metadataSnapshot(store.row('reels_index/semantic_authorization_'+semanticHash(j.policy.authorizationId))),firstResult:metadataSnapshot(first),editorial:metadataSnapshot(store.row('settings/reels_v2_taxonomy')),sources:currentSources,resultAbsence:absent(store.row(fixedResult)),rawAbsence:{query:await queryAbsentRaw(client),documents:rawPaths().map(p=>absent(store.row(p)))},recoveryAbsence:absent(store.row(rejectedSemanticRecoveryPath())),queue:{...fences.queues.curation,readTime:new Date(clock()).toISOString()},newContract:{wireVersion:semanticWireSchemaVersion,promptHash:semanticPromptHash,schemaHash:semanticHash(schema),schema,sourceCommit:deployment.sourceCommit},evidence:structuredClone(evidence),...(review?{review}:{} )};
 need(clock()-started<correctiveOwnerScope.maximumCaptureMs,'CAPTURE_TIME_BUDGET_EXCEEDED');
 return {input,fences,checks:uniqueChecks([...store.checks(),...fences.checks]),historicalRecovery:metadataSnapshot(historical),historicalRawChunks,coordinator:metadataSnapshot(store.row('reels_index/semantic_coordinator')),scopeHash:rejectedSemanticRecoveryReviewScope(input)};
}
function metadataPacket({collected,deployment,operatorSHA256,trustedReview}){
 const prepared=prepareRejectedSemanticAttemptRecovery(collected.input,{trustedReview});
 const body={schemaVersion:1,kind:'semantic_corrective_owner_packet',jobId:S.jobId,oldBatchId:S.oldBatchId,preparedAt:collected.input.now,expiresAt:new Date(Date.parse(collected.input.now)+300000).toISOString(),sourceCommit:deployment.sourceCommit,sourceTree:deployment.sourceTree,deploymentHash:semanticHash(deployment),operatorSHA256,scopeHash:collected.scopeHash,fenceFingerprint:collected.fences.fingerprint,checks:collected.checks,receipt:prepared.receipt,reviewRequired:!prepared.report.ready,preparationErrors:prepared.report.errors,executionAuthorized:false,providerCalls:0,writes:0,limitations:['Preparation is read-only; a separately pinned owner approval is required for one atomic metadata application.','Historical HTTP400 evidence is aggregate correlation, not request-level diagnosis, billing proof or schema-cause proof.']};
 return {...body,metadataInputHash:semanticHash(body)};
}
export async function prepareCorrectiveOwnerPacket({client,deployment,evidence,review=null,trustedReview=null,operatorSHA256,clock=Date.now}){
 need(hex(operatorSHA256),'OPERATOR_HASH_REQUIRED');
 const collected=await collectCorrectivePreparation({client,deployment,evidence,review,clock});
 return {packet:metadataPacket({collected,deployment,operatorSHA256,trustedReview}),privateCapture:collected};
}
function packetValid(packet){
 if(!packet||packet.kind!=='semantic_corrective_owner_packet'||packet.schemaVersion!==1||packet.executionAuthorized!==false||!hex(packet.metadataInputHash))return false;
 const {metadataInputHash,...body}=packet;return semanticHash(body)===metadataInputHash;
}
export async function applyCorrectiveOwnerPacket({client,packet,expectedPacketSHA256,packetText,deployment,evidence,review,trustedReview,approval,operatorSHA256,clock=Date.now}){
 need(typeof packetText==='string'&&sha(packetText)===expectedPacketSHA256&&packetValid(packet)&&same(JSON.parse(packetText),packet),'EXACT_REVIEWED_PACKET_REQUIRED');
 need(packet.operatorSHA256===operatorSHA256&&hex(operatorSHA256)&&packet.deploymentHash===semanticHash(deployment)&&packet.sourceCommit===deployment.sourceCommit&&packet.sourceTree===deployment.sourceTree,'REVIEWED_OPERATOR_OR_DEPLOYMENT_CHANGED');
 need(packet.receipt&&!packet.reviewRequired&&Date.parse(packet.expiresAt)>clock(),'PREPARED_PACKET_NOT_READY_OR_EXPIRED');
 need(approval?.actorId===deployment.ownerIdentity?.email&&approval.packageHash===packet.metadataInputHash&&approval.packetSHA256===expectedPacketSHA256,'EXACT_OWNER_APPROVAL_REQUIRED');
 const collected=await collectCorrectivePreparation({client,deployment,evidence,review,clock});
 need(collected.scopeHash===packet.scopeHash&&collected.fences.fingerprint===packet.fenceFingerprint&&same(collected.checks,packet.checks),'REVIEWED_METADATA_CHANGED');
 need(validateRejectedSemanticAttemptRecovery(packet.receipt,collected.input,{trustedReview}),'RECOVERY_RECEIPT_NOT_CURRENT');
 const prepared=prepareSemanticCorrectiveCapability({receipt:packet.receipt,preparationInput:collected.input,trustedReview,historicalRecovery:collected.historicalRecovery,historicalRawChunks:collected.historicalRawChunks,coordinator:collected.coordinator,approval:Object.fromEntries(['kind','approvalId','packageHash','sourceCommit','actorId','approvedAt','expiresAt','humanAuthorizationRef'].map(key=>[key,approval[key]])),now:new Date(clock()).toISOString()});
 need(prepared.executable===false&&prepared.executionAuthorized===false&&Array.isArray(prepared.writes)&&prepared.writes.length===3&&prepared.preparedJob?.callsUsed===2&&prepared.preparedJob?.cursor===8&&prepared.preparedJob?.maxCalls===127,'FACTORY_PLAN_INVALID');
 return commitCorrectiveMetadata({client,prepared,checks:collected.checks,packet,deployment,clock});
}
export async function commitCorrectiveMetadata({client,prepared,checks:extraChecks,packet,deployment,clock=Date.now}){
 need(prepared?.receiptPath===rejectedSemanticRecoveryPath()&&/^reels_index\/semantic_corrective_capability_[a-f0-9]{64}$/.test(prepared.path??''),'FINITE_METADATA_WRITE_PATHS_REQUIRED');
 need(prepared.executable===false&&prepared.executionAuthorized===false&&prepared.preparedJob?.id===S.jobId&&prepared.preparedJob.status==='prepared'&&prepared.preparedJob.callsUsed===2&&prepared.preparedJob.cursor===8&&prepared.preparedJob.maxCalls===127&&prepared.preparedJob.batch===null&&prepared.preparedJob.dispatch?.sequence===2,'FACTORY_PLAN_INVALID');
 const checks=uniqueChecks([...extraChecks,...prepared.checks]);
 const allowedWrites=new Set([prepared.receiptPath,prepared.path,fixedJob]);
 need(allowedWrites.size===3&&prepared.writes.every(w=>allowedWrites.has(w.path))&&prepared.writes.find(w=>w.path===fixedJob)?.updateTime===S.jobUpdateTime&&prepared.writes.filter(w=>w.path!==fixedJob).every(w=>w.createOnly===true),'THREE_METADATA_WRITES_ONLY');
 need(same(prepared.writes.find(w=>w.path===fixedJob)?.data,prepared.preparedJob)&&same(prepared.writes.find(w=>w.path===prepared.receiptPath)?.data,packet.receipt)&&same(prepared.writes.find(w=>w.path===prepared.path)?.data,prepared.capability),'FACTORY_WRITE_CONTENT_CHANGED');
 const writes=prepared.writes.map(w=>({update:{name:documents+w.path,fields:encodeFields(w.data)},currentDocument:w.path===fixedJob?{updateTime:w.updateTime}:{exists:false}}));
 need(jsonBytes({writes})<correctiveOwnerScope.maximumReadBytes,'METADATA_COMMIT_TOO_LARGE');
 let transaction=null,commitSent=false,commitAcknowledged=false,readbackAttempted=false;
 const result={kind:'semantic_corrective_owner_result',jobId:S.jobId,oldBatchId:S.oldBatchId,metadataInputHash:packet.metadataInputHash,commitSent:false,commitAcknowledged:false,readbackAttempted:false,writes:0,providerCalls:0,queueWrites:0,executionStarted:false};
 try{
  const begun=await client.request(firestore+':beginTransaction',{method:'POST',json:{options:{readWrite:{}}}});need(typeof begun?.transaction==='string','TRANSACTION_MISSING');transaction=begun.transaction;const started=clock();
  const observed=await client.batchGet(checks.map(c=>c.path),{transaction,metadataOnly:true});
  need(checks.every(c=>observed.get(c.path)?.updateTime===c.updateTime),'ATOMIC_EPOCH_OR_ABSENCE_CHANGED');
  await queryAbsentRaw(client,transaction);
  const finalFences=await inspectCorrectiveFences(client,deployment);
  need(finalFences.fingerprint===packet.fenceFingerprint,'FINAL_FENCES_CHANGED');
  need(clock()-started<correctiveOwnerScope.transactionBudgetMs&&Date.parse(packet.receipt.validUntil)>clock()&&Date.parse(packet.expiresAt)>clock(),'FINAL_TRANSACTION_OR_RECEIPT_EXPIRED');
  const body={transaction,writes};client.armCommit(body);commitSent=true;result.commitSent=true;
  try{
   const committed=await client.request(firestore+':commit',{method:'POST',json:body});
   need(Array.isArray(committed.writeResults)&&committed.writeResults.length===3&&committed.writeResults.every(r=>date(r.updateTime)),'COMMIT_ACKNOWLEDGEMENT_INCOMPLETE');
   commitAcknowledged=true;result.commitAcknowledged=true;
  }catch{
   readbackAttempted=true;result.readbackAttempted=true;
   // Exactly one readback request; never retry the metadata commit.
   const after=await client.batchGet(prepared.writes.map(w=>w.path));
   need(prepared.writes.every(w=>after.get(w.path)?.exists&&same(after.get(w.path).data,w.data)),'COMMIT_UNCERTAIN_STOP_NO_RETRY');
   result.reconciledByOneExactReadback=true;
  }
  result.writes=3;result.applied=true;result.newJobStatus=prepared.preparedJob.status;result.callsUsed=prepared.preparedJob.callsUsed;result.cursor=prepared.preparedJob.cursor;result.capabilityHash=prepared.capability.capabilityHash??semanticHash(prepared.capability);return result;
 }catch(error){
  throw Object.assign(Error(error.code??'CORRECTIVE_APPLICATION_STOPPED'),{code:error.code??'CORRECTIVE_APPLICATION_STOPPED',metadata:{...result,commitSent,commitAcknowledged,readbackAttempted,requiresReconciliation:commitSent&&!commitAcknowledged}});
 }finally{
  if(transaction&&!commitSent)try{await client.request(firestore+':rollback',{method:'POST',json:{transaction}});}catch{}
 }
}
const execute=promisify(execFileCallback);
export async function loadConventionalOwnerSession({ownerIdentity,exec=execute,env=process.env}={}){
 need(ownerIdentity?.kind==='reviewed_owner_identity'&&typeof ownerIdentity.email==='string'&&/^[^\s@]+@[^\s@]+$/.test(ownerIdentity.email),'PINNED_PRIVATE_OWNER_IDENTITY_REQUIRED');
 need(env.CLOUD_SHELL==='true'&&env.GITHUB_ACTIONS!=='true','OWNER_CLOUD_SHELL_REQUIRED');
 need(!Object.keys(env).some(k=>/^(http_proxy|https_proxy|all_proxy)$/i.test(k)&&env[k]),'CONFIGURED_PROXY_UNSUPPORTED');
 const options={encoding:'utf8',maxBuffer:65536,timeout:15000,windowsHide:true};
 const account=(await exec('gcloud',['auth','list','--filter=status:ACTIVE','--format=value(account)'],options)).stdout.trim();
 need(account===ownerIdentity.email,'EXACT_OWNER_ACCOUNT_REQUIRED');
 const project=(await exec('gcloud',['config','get-value','project'],options)).stdout.trim();need(project===P,'EXACT_OWNER_PROJECT_REQUIRED');
 const token=(await exec('gcloud',['auth','print-access-token','--account='+ownerIdentity.email],options)).stdout.trim();need(token.length>10&&!/\s/.test(token),'OPAQUE_OWNER_TOKEN_REQUIRED');
 return {token,account,project};
}
async function pinnedJSON(path,expected){const text=await readFile(path,'utf8');need(hex(expected)&&sha(text)===expected,'PINNED_ARTIFACT_CHANGED');return {text,data:JSON.parse(text)};}
function argsOf(argv){const mode=argv[0],out={mode};need(['prepare','apply'].includes(mode),'EXPLICIT_PREPARE_OR_APPLY_REQUIRED');for(let i=1;i<argv.length;i+=2){need(/^--[a-z-]+$/.test(argv[i])&&argv[i+1]&&!Object.hasOwn(out,argv[i]),'EXPLICIT_UNIQUE_ARGUMENTS_REQUIRED');out[argv[i]]=argv[i+1];}return out;}
export async function correctiveOwnerMain(argv,{stdout=console.log}={}){
 const args=argsOf(argv),deployment=await pinnedJSON(args['--deployment'],args['--deployment-sha']),evidence=await pinnedJSON(args['--evidence'],args['--evidence-sha']),reviewFile=args['--review']?await pinnedJSON(args['--review'],args['--review-sha']):null;
 const review=reviewFile?{path:args['--review'],sha256:args['--review-sha'],data:reviewFile.data}:null;
 const trustedReview=review?{path:review.path,sha256:review.sha256,dataHash:semanticHash(review.data),scopeHash:review.data.scopeHash,actorId:review.data.actorId}:null;
 const operatorSHA256=sha(await readFile(fileURLSelf(),'utf8')),session=await loadConventionalOwnerSession({ownerIdentity:deployment.data.ownerIdentity}),client=new CorrectiveOwnerMetadataClient({token:session.token});
 let output;
 if(args.mode==='prepare')output=(await prepareCorrectiveOwnerPacket({client,deployment:deployment.data,evidence:evidence.data,review,trustedReview,operatorSHA256})).packet;
 else{
  const packet=await pinnedJSON(args['--packet'],args['--packet-sha']),approval=await pinnedJSON(args['--approval'],args['--approval-sha']);
  output=await applyCorrectiveOwnerPacket({client,packet:packet.data,packetText:packet.text,expectedPacketSHA256:args['--packet-sha'],deployment:deployment.data,evidence:evidence.data,review,trustedReview,approval:approval.data,operatorSHA256});
 }
 need(typeof args['--output']==='string','EXPLICIT_OUTPUT_REQUIRED');
 const text=JSON.stringify(output,null,2)+'\n';await writeFile(args['--output'],text,{flag:'wx',mode:0o600});
 stdout(JSON.stringify({mode:args.mode,outputSHA256:sha(text),ready:output.reviewRequired===false,applied:output.applied===true,providerCalls:0,queueWrites:0,sourceBodiesIncluded:false}));return output;
}
const fileURLSelf=()=>new URL(import.meta.url);
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{await correctiveOwnerMain(process.argv.slice(2));}catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]{1,96}$/.test(error.code??'')?error.code:'CORRECTIVE_OWNER_FAILED',...(error.metadata??{}),providerCalls:0,sourceBodiesIncluded:false}));process.exitCode=1;}
