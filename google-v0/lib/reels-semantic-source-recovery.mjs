import {semanticHash,semanticSourceProjectionVersion} from './reels-semantic-source.mjs';
import {validateSemanticOutput} from './reels-semantic-contract.mjs';
import {parseSavedSemanticResponse,semanticPromptHash} from './reels-semantic-provider.mjs';
export const semanticSourceRecoveryVersion='semantic-map-order-recovery-v1';
const list=v=>Array.isArray(v)?v:[],same=(a,b)=>semanticHash(a)===semanticHash(b),hash=v=>/^[a-f0-9]{64}$/.test(v??'');
export const semanticSourceRecoveryPath=batchId=>'reels_index/semantic_source_recovery_'+batchId;
const prefixes=['title','summary','knowledge','useful_information','useful_value','claims','topics','candidate_relations','limitations'].map(x=>'analysis.'+x).concat(['caption','transcript']);
function* permutations(keys){if(keys.length<2){yield keys;return;}for(let i=0;i<keys.length;i++)for(const rest of permutations(keys.filter((_,j)=>j!==i)))yield [keys[i],...rest];}
function* combine(nodes,index=0,prefix=[]){if(index===nodes.length){yield prefix;return;}for(const order of orders(nodes[index]))yield* combine(nodes,index+1,prefix.concat(order));}
function* orders(node){if(node.field){yield [node.field];return;}const keys=[...node.children.keys()],numeric=keys.every(k=>/^\d+$/.test(k)),variants=numeric?[keys.sort((a,b)=>Number(a)-Number(b))]:permutations(keys);for(const variant of variants)yield* combine(variant.map(k=>node.children.get(k)));}
function blocks(fields){
 return prefixes.filter(prefix=>fields.some(f=>f.fieldPath===prefix||f.fieldPath.startsWith(prefix+'.'))).map(prefix=>{
  const root={children:new Map()};for(const field of fields.filter(f=>f.fieldPath===prefix||f.fieldPath.startsWith(prefix+'.'))){let node=root;const suffix=field.fieldPath===prefix?[]:field.fieldPath.slice(prefix.length+1).split('.');for(const segment of suffix){if(!node.children.has(segment))node.children.set(segment,{children:new Map()});node=node.children.get(segment);}node.field=field;}return root;
 });
}
export function reconstructLegacySemanticFieldOrder(source,oldHash,{maxAttempts=50000}={}){
 if(source.truncated||!hash(oldHash)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>50000)return {matched:false,attempts:0,reason:'INCOMPLETE_OR_INVALID_PROJECTION'};
 let attempts=0;for(const fields of combine(blocks(source.fields))){if(++attempts>maxAttempts)return {matched:false,attempts:maxAttempts,reason:'ORDER_SEARCH_LIMIT'};if(semanticHash({identity:source.sourceIdentity,fields})===oldHash)return {matched:true,attempts,fieldOrder:fields.map(f=>f.fieldPath)};}
 return {matched:false,attempts,reason:'LEGACY_PROOF_NOT_RECONSTRUCTED'};
}
export function validateSemanticSourceRecoveryRow(row,source,pin){
 if(!row||source.truncated||source.sourceProjectionVersion!==semanticSourceProjectionVersion||pin.sourceProjectionVersion!==undefined||row.id!==source.id||row.oldSemanticProofHash!==pin.semanticProofHash||row.canonicalSemanticProofHash!==source.semanticProofHash||row.canonicalProjectionVersion!==semanticSourceProjectionVersion||!same(row.sourceIdentity,source.sourceIdentity)||!same(row.sourceVersions,source.sourceVersions)||!same(pin.sourceVersions,source.sourceVersions)||row.editorialHash!==source.editorialHash||pin.editorialHash!==source.editorialHash||!Array.isArray(row.originalFieldOrder)||row.originalFieldOrder.length!==source.fields.length||new Set(row.originalFieldOrder).size!==source.fields.length)return false;
 const fields=new Map(source.fields.map(f=>[f.fieldPath,f])),old=row.originalFieldOrder.map(p=>fields.get(p));return old.every(Boolean)&&semanticHash({identity:source.sourceIdentity,fields:old})===pin.semanticProofHash&&row.fieldSetHash===semanticHash([...source.fields].sort((a,b)=>a.fieldPath<b.fieldPath?-1:a.fieldPath>b.fieldPath?1:0));
}
export function validateSemanticSourceRecovery(receipt,{job,saved,source,pin}){
 if(!receipt||receipt.kind!=='semantic_source_recovery'||receipt.version!==semanticSourceRecoveryVersion||receipt.jobId!==job.id||receipt.batchId!==job.batch?.id||receipt.resultId!==saved.id||receipt.originalBindingHash!==job.batch.bindingHash||receipt.originalBindingHash!==saved.bindingHash||receipt.savedRawHash!==saved.rawHash||receipt.requestHash!==(saved.requestHash??null)||receipt.promptHash!==job.batch.binding.promptHash||receipt.promptHash!==semanticPromptHash||!hash(receipt.receiptHash))return false;
 const {receiptHash,...body}=receipt;if(semanticHash(body)!==receiptHash||!same(saved.binding,job.batch.binding))return false;
 return validateSemanticSourceRecoveryRow(list(receipt.rows).find(r=>r.id===source.id),source,pin);
}
export function prepareSemanticSourceRecovery({job,saved,envelope,sources,sourceObservationSHA256,sourceCommit,observedAt,maxAttempts=50000}){
 const report={schemaVersion:1,kind:'semantic_source_recovery_diagnostic',sourceCommit,sourceObservationSHA256,observedAt,jobId:job?.id??null,batchId:job?.batch?.id??null,resultId:saved?.id??null,ready:false,gates:[],sources:[],providerCalls:0,writes:0,rawIncluded:false,semanticAccuracyMeasured:false};
 const gate=(code,passed)=>{report.gates.push({code,passed});return passed;};
 if(!gate('EXACT_FIRST_SAVED_EXTRACT',!!job&&job.callsUsed===1&&job.cursor===0&&job.phase==='extract'&&['paused','running'].includes(job.status)&&job.batch?.status==='submitting'&&job.batch.phase==='extract'&&saved?.id===job.batch.id&&saved.phase==='extract'))return {report,receipt:null};
 if(!gate('RAW_AND_ORIGINAL_BINDING_VALID',hash(saved.rawHash)&&saved.rawHash===semanticHash(envelope.rawResponse)&&saved.bindingHash===semanticHash(saved.binding)&&saved.bindingHash===job.batch.bindingHash&&same(saved.binding,job.batch.binding)&&job.batch.binding.promptHash===semanticPromptHash&&job.promptHash===semanticPromptHash&&job.policyHash===job.batch.binding.policyHash))return {report,receipt:null};
 if(!gate('JOB_AUTHORIZATION_CURRENT',job.policy?.enabled===true&&semanticHash(job.policy)===job.policyHash&&Number.isFinite(Date.parse(observedAt))&&Date.parse(job.policy.expiresAt)>Date.parse(observedAt)))return {report,receipt:null};
 const pins=list(job.batch.binding.pins),sourceMap=new Map(list(sources).map(s=>[s.id,s]));
 if(!gate('EXACT_BATCH_COVERAGE',pins.length>0&&pins.length<=12&&pins.length===sources.length&&sourceMap.size===pins.length&&pins.every(p=>sourceMap.has(p.id))))return {report,receipt:null};
 const rows=[];for(const pin of pins){
  const source=sourceMap.get(pin.id),currentJobPin=list(job.pins).find(p=>p.id===pin.id),complete=!source.truncated&&source.sourceProjectionVersion===semanticSourceProjectionVersion,versions=!!currentJobPin&&same(source.sourceVersions,pin.sourceVersions)&&same(source.sourceVersions,currentJobPin.sourceVersions),editorial=pin.editorialHash===source.editorialHash;
  const found=complete&&versions&&editorial?reconstructLegacySemanticFieldOrder(source,pin.semanticProofHash,{maxAttempts}):{matched:false,attempts:0,reason:!complete?'TRUNCATED_SOURCE':!versions?'SOURCE_VERSION_CHANGED':'EDITORIAL_CHANGED'};
  report.sources.push({id:source.id,sourceIdentity:source.sourceIdentity,sourceVersions:source.sourceVersions,oldSemanticProofHash:pin.semanticProofHash,canonicalSemanticProofHash:source.semanticProofHash,complete,versionsMatch:versions,editorialMatches:editorial,fieldCount:source.fields.length,truncationReasons:source.truncationReasons??[],legacyOrderVerified:found.matched,orderAttempts:found.attempts,reason:found.reason??null});
  if(found.matched)rows.push({id:source.id,sourceIdentity:source.sourceIdentity,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash,oldSemanticProofHash:pin.semanticProofHash,canonicalSemanticProofHash:source.semanticProofHash,canonicalProjectionVersion:semanticSourceProjectionVersion,fieldSetHash:semanticHash([...source.fields].sort((a,b)=>a.fieldPath<b.fieldPath?-1:a.fieldPath>b.fieldPath?1:0)),originalFieldOrder:found.fieldOrder,complete:true});
 }
 if(!gate('ALL_SOURCES_COMPLETE_EXACT_OLD_PROOF_RECONSTRUCTED',rows.length===pins.length))return {report,receipt:null};
 try{validateSemanticOutput(parseSavedSemanticResponse(envelope),sources,{groups:[]});gate('SAVED_OUTPUT_CONTRACT_AND_LITERAL_QUOTES_VALID',true);}catch(e){gate('SAVED_OUTPUT_CONTRACT_AND_LITERAL_QUOTES_VALID',false);report.contractError=/^[A-Z0-9_]{1,96}$/.test(e.code??'')?e.code:'SAVED_CONTRACT_INVALID';return {report,receipt:null};}
 const receipt={kind:'semantic_source_recovery',version:semanticSourceRecoveryVersion,jobId:job.id,batchId:job.batch.id,resultId:saved.id,sourceCommit,sourceObservationSHA256,observedAt,originalBindingHash:saved.bindingHash,savedRawHash:saved.rawHash,requestHash:saved.requestHash??null,promptHash:job.batch.binding.promptHash,canonicalProjectionVersion:semanticSourceProjectionVersion,rows,scope:'exact_saved_first_batch_only',providerCalls:0,originalBindingUnchanged:true,rawUnchanged:true};
 receipt.receiptHash=semanticHash(receipt);report.ready=true;report.receiptHash=receipt.receiptHash;report.sourceCount=rows.length;return {report,receipt};
}
