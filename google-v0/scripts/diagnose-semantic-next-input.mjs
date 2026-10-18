import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeFields} from '../lib/firestore.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {ReelsSemanticProvider,semanticPromptHash} from '../lib/reels-semantic-provider.mjs';
import {semanticHash,semanticPolicyVersion,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';

export const payloadAuditScope=Object.freeze({
 sourceCommit:'9ac61d13c1c7e4153384d6e305e4b1d6aa840c68',
 sourceObservationSHA256:'41c61b96dc59ac85929adad158d29712235083ec64a83c337a9394a2118398cd',
 paidInputSHA256:'0b32ed9bf7d4759d80b1e723aa775356eafb6c017a6f59a3890398c92a9440cc',
 jobId:'e79360382d0231e58861f62238ecb166541d15b0247c98e65c22ab6e87630197',
 requestId:'329f1e1297721c60c514687aac0575d90caf32d41e70f020f4a1854ec3d8e98b',
 promptHash:'599038589ef3d3c55d614bc9f7fe390e23ca3b8a29a7c0cf5d19ccdf63f69f72',
 bindingHash:'9d4919c965da1e0e63552e73d2fe35b4e4c23338867abc302117d29b27b587c8',
 catalogueHash:'3fdc0558d8ed9dc8c88f9fa9400e75e20a18565a1eb42f8f3ba3b864b8136399',
 promptTransitionHash:'94955236ab26dcd3a9262e2f42c926065fe6ca39fa8cd080bd95d26ad4e16c6b',
 sourceIds:['C_N6GLrpgI1','C_P8TJ2y_oL','C_QsrpPC3gm','C_sWZFSRMSz','C_Tgw5VSB1z','C_WS2WOR4bX','C_x4pCmit9z','C--mliLp-DA'],
 model:'gemini-3.5-flash',sourceDocuments:738,published:499,maxCalls:127,offset:8,batchSize:8
});
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8');
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const requireValue=(condition,code)=>{if(!condition)fail(code);};
const same=(a,b)=>semanticHash(a)===semanticHash(b);
const supported=new Set(['type','enum','items','minimum','maximum','minItems','maxItems','nullable','properties','description','propertyOrdering','required','anyOf','format']);
export function measureSemanticSchema(schema){
 const result={nodes:0,properties:0,optionalProperties:0,enumFields:0,enumValues:0,maxEnumValues:0,anyOfNodes:0,anyOfBranches:0,maxDepth:0,maxArrayNesting:0,bounds:0,descriptionBytes:0,missingType:[],unsupportedKeywords:[]};
 function visit(node,path,depth,arrays,ancestors){
  requireValue(node&&typeof node==='object'&&!Array.isArray(node),'SCHEMA_NODE_INVALID');
  requireValue(!ancestors.has(node),'SCHEMA_CYCLE_INVALID');
  const branch=new Set(ancestors);branch.add(node);result.nodes++;result.maxDepth=Math.max(result.maxDepth,depth);arrays+=node.type==='ARRAY'?1:0;result.maxArrayNesting=Math.max(result.maxArrayNesting,arrays);
  if(!node.type)result.missingType.push({path,anyOf:Array.isArray(node.anyOf),branchTypes:[...new Set((node.anyOf??[]).map(x=>x.type??'UNSPECIFIED'))]});
  if(node.enum){result.enumFields++;result.enumValues+=node.enum.length;result.maxEnumValues=Math.max(result.maxEnumValues,node.enum.length);}
  result.descriptionBytes+=node.description?bytes(node.description):0;
  for(const key of Object.keys(node))if(!supported.has(key))result.unsupportedKeywords.push(path+'.'+key);
  for(const key of ['minimum','maximum','minItems','maxItems'])if(Object.hasOwn(node,key))result.bounds++;
  if(node.properties){const required=new Set(node.required??[]);result.properties+=Object.keys(node.properties).length;for(const [key,value] of Object.entries(node.properties)){if(!required.has(key))result.optionalProperties++;visit(value,path+'.properties.'+key,depth+1,arrays,branch);}}
  if(node.items)visit(node.items,path+'.items',depth+1,arrays,branch);
  if(node.anyOf){result.anyOfNodes++;result.anyOfBranches+=node.anyOf.length;node.anyOf.forEach((value,index)=>visit(value,path+'.anyOf.'+index,depth+1,arrays,branch));}
 }
 visit(schema,'responseSchema',0,0,new Set());return result;
}

// This function only reads supplied immutable files and captures the current
// adapter request with an in-memory transport. It has no Google client or token.
export async function prepareSemanticNextInputAudit(input,paid,{expected=payloadAuditScope}={}){
 const observation=input?.observation;
 requireValue(input?.schemaVersion===1&&observation?.readOnly===true&&observation.providerCalls===0&&observation.writes===0,'SOURCE_HEADER_INVALID');
 requireValue(input.sourceObservationSHA256===expected.sourceObservationSHA256,'SOURCE_OBSERVATION_CHANGED');
 requireValue([1,2].includes(paid?.schemaVersion)&&paid.kind==='saved_semantic_first_response_reconciliation_input'&&paid.readOnly===true&&paid.providerCalls===0&&paid.writes===0&&paid.sourceObservationSHA256===expected.sourceObservationSHA256,'PAID_HEADER_INVALID');
 requireValue(Array.isArray(observation.records)&&observation.records.length===expected.sourceDocuments,'SOURCE_COUNT_CHANGED');
 requireValue(semanticPromptHash===expected.promptHash,'CURRENT_PROMPT_CHANGED');
 const sourcePaths=new Set(),store=memoryReelsStore();
 for(const row of observation.records){
  requireValue(typeof row.path==='string'&&/^(videos|reels_legacy_content)\/[A-Za-z0-9_-]+$/.test(row.path)&&!sourcePaths.has(row.path)&&typeof row.updateTime==='string','SOURCE_RECORD_INVALID');
  sourcePaths.add(row.path);store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 }
 const taxonomy=observation.taxonomy;
 requireValue(taxonomy&&Array.isArray((taxonomy.data??taxonomy).nodes),'SOURCE_TAXONOMY_INVALID');
 store.docs.set('settings/reels_v2_taxonomy',{data:structuredClone(taxonomy.data??taxonomy),updateTime:taxonomy.updateTime??null});
 const decoded=new Map();
 requireValue(Array.isArray(paid.records)&&paid.records.length===4,'EXACT_FOUR_PAID_RECORDS_REQUIRED');
 for(const row of paid.records){
  requireValue(/^reels_index\/semantic_(job|result|raw|authorization)_[A-Za-z0-9_-]+$/.test(row.path)&&!decoded.has(row.path)&&row.document?.name==='projects/megabrain-v0-1017370021431/databases/(default)/documents/'+row.path&&typeof row.document.updateTime==='string','PAID_RECORD_INVALID');
  decoded.set(row.path,{data:decodeFields(row.document.fields),updateTime:row.document.updateTime});
 }
 const jobs=[...decoded.values()].filter(row=>row.data.kind==='semantic_job'),results=[...decoded.values()].filter(row=>row.data.kind==='semantic_result'),ledgers=[...decoded.values()].filter(row=>row.data.kind==='semantic_authorization'),raws=[...decoded.values()].filter(row=>row.data.kind==='semantic_raw');
 requireValue(jobs.length===1&&results.length===1&&ledgers.length===1&&raws.length===1,'EXACT_PAID_KINDS_REQUIRED');
 const job=jobs[0].data,saved=results[0].data,ledger=ledgers[0].data;
 requireValue(job.id===expected.jobId&&job.total===expected.published&&job.pins?.length===expected.published&&new Set(job.pins.map(p=>p.id)).size===expected.published&&job.policy?.batchSize===expected.batchSize&&job.maxCalls===expected.maxCalls&&job.policy.maxCalls===expected.maxCalls&&job.policy.model===expected.model&&job.policy.autoPromotionEnabled===false,'ORIGINAL_JOB_SCOPE_CHANGED');
 requireValue(job.policyHash===semanticHash(job.policy)&&job.cohortHash===semanticHash(job.pins)&&job.policy.authorizedCohortHash===job.cohortHash,'ORIGINAL_COHORT_INVALID');
 requireValue(ledger.jobId===job.id&&ledger.authorizationId===job.policy.authorizationId&&ledger.cohortHash===job.cohortHash&&ledger.promptHash===job.promptHash&&ledger.maximumCalls===job.maxCalls,'ORIGINAL_LEDGER_CHANGED');
 requireValue(saved.id===semanticHash({jobId:job.id,phase:'extract',cursor:0})&&saved.binding?.jobId===job.id&&saved.binding.phase==='extract'&&saved.binding.cursor===0&&saved.binding.policyHash===job.policyHash&&saved.binding.promptHash===job.promptHash&&saved.bindingHash===semanticHash(saved.binding),'ORIGINAL_RESULT_BINDING_CHANGED');
 const part=raws[0].data;
 requireValue(saved.rawChunks?.length===1&&decoded.get(saved.rawChunks[0])?.data===part&&part.sha256===semanticHash(part.text),'ORIGINAL_RAW_BINDING_CHANGED');
 let originalRaw;try{originalRaw=JSON.parse(part.text);}catch{fail('ORIGINAL_RAW_JSON_INVALID');}
 requireValue(saved.rawHash===semanticHash(originalRaw),'ORIGINAL_RAW_HASH_CHANGED');
 const requestId=semanticHash({jobId:job.id,phase:'extract',cursor:expected.offset});requireValue(requestId===expected.requestId,'NEXT_REQUEST_ID_CHANGED');
 const pins=job.pins.slice(expected.offset,expected.offset+expected.batchSize);requireValue(pins.length===expected.batchSize&&same(pins.map(pin=>pin.id),expected.sourceIds),'NEXT_BATCH_INCOMPLETE');
 const repository=new ReelsRepository({store,cacheTtlMs:0}),runtime=new ReelsCatalogueRuntime({repository}),inventory=await repository.contextualContributions();
 requireValue(inventory.items.length===expected.published&&job.pins.every(pin=>inventory.items.some(item=>item.id===pin.id)&&same(pin.sourceVersions,inventory.sourceVersions.get(pin.id))),'PUBLISHED_INVENTORY_CHANGED');
 const before=semanticHash([...store.docs]),sources=[];
 for(const pin of pins){
  const loaded=await runtime.loadSource(pin.id);
  requireValue(loaded?.item?.publication?.available===true&&same(pin.sourceVersions,loaded.sourceVersions),'NEXT_SOURCE_VERSION_CHANGED');
  const source=semanticSourceFromSaved(loaded);requireValue(source.id===pin.id,'NEXT_SOURCE_ID_CHANGED');sources.push(source);
 }
 const catalogue={version:semanticPolicyVersion,promptHash:semanticPromptHash,groups:[]};
 requireValue(semanticHash(catalogue)===expected.catalogueHash,'OBSERVED_CATALOGUE_HASH_CHANGED');
 const binding={jobId:job.id,phase:'extract',cursor:expected.offset,pins:sources.map(source=>({id:source.id,sourceProjectionVersion:source.sourceProjectionVersion,semanticProofHash:source.semanticProofHash,sourceVersions:source.sourceVersions,editorialHash:source.editorialHash})),catalogueHash:semanticHash(catalogue),policyHash:job.policyHash,promptHash:semanticPromptHash,promptTransitionHash:expected.promptTransitionHash};
 requireValue(semanticHash(binding)===expected.bindingHash,'OBSERVED_NEXT_BINDING_CHANGED');
 let captured=null,captures=0;
 const provider=new ReelsSemanticProvider({api:{project:'megabrain-v0-1017370021431',async request(_url,options){requireValue(captures++===0&&options.method==='POST'&&options.attempt===1,'AUDIT_CAPTURE_SCOPE_INVALID');captured=structuredClone(options.json);return {candidates:[]};}}});
 const envelope=await provider.infer({sources,catalogue,requestId,model:job.policy.model});requireValue(captures===1&&captured,'EXACT_ONE_OFFLINE_CAPTURE_REQUIRED');
 requireValue(before===semanticHash([...store.docs]),'DIAGNOSTIC_MUTATED_MEMORY_SOURCES');
 const metrics=measureSemanticSchema(captured.generationConfig.responseSchema);
 requireValue(metrics.unsupportedKeywords.length===0,'UNSUPPORTED_SCHEMA_KEYWORD');
 const contents=JSON.parse(captured.contents[0].parts[0].text);
 requireValue(contents.phase==='extract'&&contents.requestId===requestId&&contents.sources.length===expected.batchSize&&contents.catalogue.groups.length===0,'CAPTURE_PAYLOAD_CHANGED');
 const report={schemaVersion:1,kind:'semantic_next_input_metadata_audit',sourceCommit:expected.sourceCommit,diagnosticCommit:process.env.GITHUB_SHA??null,sourceObservationSHA256:expected.sourceObservationSHA256,jobId:job.id,offset:expected.offset,sourceIds:pins.map(pin=>pin.id),sourceVersionsUnchanged:true,sourceMemoryUnchanged:true,cohortHash:job.cohortHash,promptHash:semanticPromptHash,bindingHash:semanticHash(binding),catalogueHash:semanticHash(catalogue),promptTransitionHash:expected.promptTransitionHash,requestId,requestHash:envelope.requestHash,generationConfigHash:semanticHash(captured.generationConfig),schemaHash:semanticHash(captured.generationConfig.responseSchema),wireBodySHA256:sha(JSON.stringify(captured)),model:job.policy.model,catalogueGroups:0,adapterRequestsCaptured:1,actualProviderCalls:0,googleWrites:0,networkRequests:0,inferenceExecuted:false,paidResponseReplayed:false,bytes:{schema:bytes(captured.generationConfig.responseSchema),systemInstruction:bytes(captured.systemInstruction),contents:bytes(captured.contents),request:bytes(captured),payload:bytes({sources,catalogue})},schema:metrics,sources:sources.map(source=>({id:source.id,semanticProofHash:source.semanticProofHash,fieldCount:source.fields.length,truncated:source.truncated})),remoteAcceptanceProven:false,incidentCauseEstablished:false,retryAuthorized:false,limitations:['Offline request reconstruction is not Vertex schema validation or inference.','Schema metrics have no published numeric acceptance threshold.','The second uncertain intent is preserved and is not repeated by this diagnostic.','Corpus text, quotations, headers, tokens and full request bodies are intentionally excluded.']};
 const generationConfig=structuredClone(captured.generationConfig);
 const probe={schemaVersion:1,kind:'optional_count_tokens_schema_probe',operation:'countTokens',target:{project:'megabrain-v0-1017370021431',location:'global',publisher:'google',model:job.policy.model,method:'countTokens'},maximumManualRequests:1,automaticRetries:0,executor:'root_reviewed_owner_only',model:job.policy.model,sourceCommit:expected.sourceCommit,diagnosticCommit:process.env.GITHUB_SHA??null,sourceObservationSHA256:expected.sourceObservationSHA256,sourceBindingHash:report.bindingHash,originalAdapterRequestHash:report.requestHash,generationConfigHash:report.generationConfigHash,schemaHash:report.schemaHash,request:{contents:[{role:'user',parts:[{text:'Technical schema probe. No Reel content.'}]}],generationConfig},finiteReelIdsPresentOnlyAsSchemaMetadata:true,sourceTextIncluded:false,sourceIdsInContents:false,inferenceRequested:false,generatedContent:0,providerCallsExecuted:0,googleRequestsExecuted:0,approvedForExecution:false,remoteGenerateContentAcceptanceProven:false,limitations:['CountTokens receives the exact generationConfig but none of the original system instruction or source text.','Counting tokens does not prove GenerateContent acceptance, diagnose the parameter behind HTTP400, measure semantic accuracy or authorize replay.','No call is executed by this packet or its preparation. Owner review is required before any separate Google request.']};
 probe.requestBodyJSON=JSON.stringify(probe.request);probe.requestBodySHA256=sha(probe.requestBodyJSON);probe.packetHash=semanticHash(probe);return {report,probe};
}
export async function diagnoseSemanticNextInput(input,paid,options){return (await prepareSemanticNextInputAudit(input,paid,options)).report;}
async function main(){
 requireValue(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='mide-lim/MEGA-BRAIN','CENTRAL_GITHUB_ACTIONS_REQUIRED');
 const args=process.argv.slice(2);requireValue(args.length===6&&args[0]==='--input'&&args[2]==='--paid-input'&&args[4]==='--output-dir','EXPLICIT_DIAGNOSTIC_PATHS_REQUIRED');
 const [sourceText,paidText]=await Promise.all([readFile(args[1],'utf8'),readFile(args[3],'utf8')]);requireValue(sha(paidText)===payloadAuditScope.paidInputSHA256,'SEALED_PAID_INPUT_CHANGED');
 const {report,probe}=await prepareSemanticNextInputAudit(JSON.parse(sourceText),JSON.parse(paidText));await mkdir(args[5],{recursive:true});await writeFile(join(args[5],'next-input-payload-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await writeFile(join(args[5],'schema-only-count-tokens-probe.json'),JSON.stringify(probe,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({ready:true,sourceCount:report.sourceIds.length,requestHash:report.requestHash,requestBytes:report.bytes.request,schemaBytes:report.bytes.schema,actualProviderCalls:0,googleWrites:0,remoteAcceptanceProven:false,retryAuthorized:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{await main();}catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]{1,96}$/.test(error.code??'')?error.code:'PAYLOAD_AUDIT_FAILED',actualProviderCalls:0,googleWrites:0,rawIncluded:false}));process.exitCode=1;}
