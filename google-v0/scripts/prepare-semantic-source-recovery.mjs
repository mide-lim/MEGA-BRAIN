import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {decodeFields} from '../lib/firestore.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {semanticHash,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {prepareSemanticSourceRecovery} from '../lib/reels-semantic-source-recovery.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='mide-lim/MEGA-BRAIN')throw Error('CENTRAL_GITHUB_ACTIONS_REQUIRED');
 const args=process.argv.slice(2);if(args.length!==6||args[0]!=='--input'||args[2]!=='--paid-input'||args[4]!=='--output-dir')throw Error('EXPLICIT_RECOVERY_PATHS_REQUIRED');
 const input=JSON.parse(await readFile(args[1],'utf8')),paid=JSON.parse(await readFile(args[3],'utf8')),observation=input.observation;
 if(input.schemaVersion!==1||paid.schemaVersion!==1||paid.kind!=='saved_semantic_first_response_reconciliation_input'||paid.readOnly!==true||paid.providerCalls!==0||paid.writes!==0||observation.readOnly!==true||observation.providerCalls!==0||observation.writes!==0||input.sourceObservationSHA256!==paid.sourceObservationSHA256||input.sourceObservationSHA256!=='41c61b96dc59ac85929adad158d29712235083ec64a83c337a9394a2118398cd')throw Error('RECOVERY_INPUT_PROVENANCE_INVALID');
 const store=memoryReelsStore();for(const row of observation.records)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 const taxonomy=observation.taxonomy;store.docs.set('settings/reels_v2_taxonomy',{data:structuredClone(taxonomy.data??taxonomy),updateTime:taxonomy.updateTime??'synthetic-ci-taxonomy'});
 const records=new Map();for(const row of paid.records){if(!/^reels_index\/semantic_(job|result|raw)_[A-Za-z0-9_-]+$/.test(row.path)||records.has(row.path)||row.document.name!=='projects/megabrain-v0-1017370021431/databases/(default)/documents/'+row.path)throw Error('PAID_RECORD_SCOPE_INVALID');const record={data:decodeFields(row.document.fields),updateTime:row.document.updateTime};records.set(row.path,record);store.docs.set(row.path,structuredClone(record));}
 const jobs=[...records].filter(([,r])=>r.data.kind==='semantic_job'),results=[...records].filter(([,r])=>r.data.kind==='semantic_result');if(jobs.length!==1||results.length!==1)throw Error('EXACT_JOB_RESULT_REQUIRED');
 const job=jobs[0][1].data,saved=results[0][1].data,parts=[];for(const path of saved.rawChunks){const part=records.get(path)?.data;if(!part||part.kind!=='semantic_raw'||part.sha256!==semanticHash(part.text))throw Error('PAID_RAW_CHUNK_INVALID');parts.push(part.text);}
 const envelope={...saved,rawResponse:JSON.parse(parts.join(''))};if(semanticHash(envelope.rawResponse)!==saved.rawHash)throw Error('PAID_RAW_HASH_INVALID');
 const repository=new ReelsRepository({store,cacheTtlMs:0}),runtime=new ReelsCatalogueRuntime({repository}),sources=[];for(const pin of job.batch.binding.pins){const source=await runtime.loadSource(pin.id);sources.push(semanticSourceFromSaved(source));}
 const result=prepareSemanticSourceRecovery({job,saved,envelope,sources,sourceObservationSHA256:input.sourceObservationSHA256,sourceCommit:process.env.GITHUB_SHA,observedAt:new Date().toISOString()});
 await mkdir(args[5],{recursive:true});await writeFile(join(args[5],'source-recovery-report.json'),JSON.stringify(result.report,null,2)+'\n',{flag:'wx'});if(result.receipt)await writeFile(join(args[5],'source-recovery-receipt.json'),JSON.stringify(result.receipt,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({ready:result.report.ready,sourceCount:result.report.sources.length,truncated:result.report.sources.filter(s=>!s.complete).length,ordersReconstructed:result.report.sources.filter(s=>s.legacyOrderVerified).length,contractError:result.report.contractError??null,receiptHash:result.report.receiptHash??null,providerCalls:0,writes:0,rawIncluded:false}));
 if(!result.report.ready)process.exitCode=2;
}
try{await main();}catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]{1,96}$/.test(error.code??error.message??'')?(error.code??error.message):'RECOVERY_DIAGNOSTIC_FAILED',providerCalls:0,writes:0,rawIncluded:false}));process.exitCode=1;}
