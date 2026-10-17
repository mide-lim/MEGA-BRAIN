import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {analysisOutcome} from '../lib/analysis.mjs';
import {publicationRule} from '../lib/analysis-publication.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value);
const need=(value,message)=>{if(!value)throw Error(message);};
export function prepareSavedPublicationRepairs(snapshot,{ids,sourceSHA256}={}){
 need(Array.isArray(ids)&&ids.length>0&&ids.length<=10&&new Set(ids).size===ids.length&&ids.every(id=>/^[A-Za-z0-9_-]{5,32}$/.test(id)),'Explicit reviewed membership of at most ten required.');
 need(/^[a-f0-9]{64}$/.test(sourceSHA256??''),'Source snapshot hash required.');
 need(json(Object.keys(snapshot.rows??{}).sort())===json([...ids].sort()),'Snapshot membership differs from reviewed IDs.');
 const rows=ids.map(id=>{
  const row=snapshot.rows[id],record=row.video,object=row.objectMetadata;
  need(record?.id===id&&typeof row.version==='string'&&row.version.length>0,'Original identity/version required.');
  need(Number.isFinite(record.duration_seconds)&&record.duration_seconds>0,'Verified duration required; never infer it from citations.');
  need(object?.bucket==='megabrain-v0-1017370021431-media'&&object.name===record.analysis_key&&object.generation===record.analysis_generation&&/^results\/instagram\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\/analysis\.json$/.test(object.name)&&object.name.split('/')[2]===id,'Immutable raw analysis binding differs.');
  const outcome=analysisOutcome(row.savedAnalysis?.response,record,{requireKnowledge:true,sourceGroundedPublication:true});
  need(outcome.accepted,'Saved result cannot be published: '+outcome.reasons.join(','));
  const fields=['title','summary','useful_information','limitations','transcript_quality','knowledge','source_coverage','source_consolidation','publication_review'];
  const changes={},afterAnalysis=structuredClone(record.analysis);
  const applyLeaves=(before,proposed,path,target,key)=>{
   if(proposed&&typeof proposed==='object'&&!Array.isArray(proposed)){
    target[key]=before&&typeof before==='object'&&!Array.isArray(before)?structuredClone(before):{};
    for(const [child,value]of Object.entries(proposed))applyLeaves(before?.[child],value,path+'.'+child,target[key],child);
   }else{target[key]=structuredClone(proposed);if(json(before)!==json(proposed))changes[path]=proposed;}
  };
  for(const key of fields)applyLeaves(record.analysis?.[key],outcome.report[key],'analysis.'+key,afterAnalysis,key);
  need(Object.keys(changes).length>0,'No new consolidation to publish.');
  const before={analysis:record.analysis,analysis_key:record.analysis_key,analysis_generation:record.analysis_generation};
  const overlay={rule:publicationRule,sourceSnapshotSHA256:sourceSHA256,raw:{bucket:object.bucket,key:object.name,generation:object.generation,sha256:object.metadata?.sha256??null},previousAnalysisSHA256:sha(json(record.analysis)),derivedAnalysisSHA256:sha(json(afterAnalysis)),inferenceReplayed:false};
  changes.analysis_publication_overlay=overlay;
  return {id,expectedUpdateTime:row.version,before,beforeSHA256:sha(json(before)),afterAnalysis,changes,updateMask:Object.keys(changes).sort(),overlay,rawUntouched:true,ledgerExecutionsUntouched:true};
 });
 return {schemaVersion:1,rule:publicationRule,sourceSnapshotSHA256:sourceSHA256,ids:[...ids],rows,approved:false,googleWrites:0,providerCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,membership,output]=process.argv.slice(2);
 need(input&&membership&&output,'Usage: reconsolidate-saved-analysis.mjs snapshot.json reviewed-ids.json NEW-output.json');
 const bytes=readFileSync(input),snapshot=JSON.parse(bytes),ids=JSON.parse(readFileSync(membership));
 const plan=prepareSavedPublicationRepairs(snapshot,{ids,sourceSHA256:sha(bytes)});
 writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({rows:plan.rows.length,approved:false,sha256:sha(readFileSync(output)),googleWrites:0,providerCalls:0}));
}
