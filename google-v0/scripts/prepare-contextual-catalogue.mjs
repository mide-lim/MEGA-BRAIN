import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {projectReel,categoryNavigation,publicationAvailable} from '../lib/reels-model.mjs';
import {withPreservedSummary} from '../lib/reels-preserved-content.mjs';
import {projectContextualPublication,contextualHash} from '../lib/reels-contextual-projection.mjs';
import {prepareContextualCatalogue,contextualCataloguePolicy} from '../lib/reels-contextual-catalogue.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const reject=message=>{throw Error(message);};
export function normalizeSavedCatalogueInput(input){
 const o=input?.observation;if(input?.schemaVersion!==1||o?.readOnly!==true||o.writes!==0||o.providerCalls!==0||!Array.isArray(o.records)||o.records.length>2000||!input.formatAnnotations?.sealedBeforeNewAlgorithmPredictions||!input.blindAnnotations?.sealedBeforeNewAlgorithmPredictions)reject('Frozen saved-source observation and sealed independent annotations required.');
 if(input.formatAnnotations.sourceObservationSHA256!==input.sourceObservationSHA256||input.blindAnnotations.sourceObservationSHA256!==input.sourceObservationSHA256)reject('Annotations belong to another source observation.');
 const videos=new Map(),legacy=new Map();
 for(const row of o.records){const parts=row.path?.split('/');if(parts?.length!==2||!row.updateTime)reject('Source record identity/version missing.');const map=parts[0]==='videos'?videos:parts[0]==='reels_legacy_content'?legacy:null;if(!map||map.has(parts[1]))reject('Source inventory contains duplicate/out-of-scope paths.');map.set(parts[1],row);}
 const projected=categoryNavigation([...videos].map(([id,row])=>withPreservedSummary(projectReel({...row.data,id}),legacy.get(id)?.data)),o.taxonomy.data);
 const catalog=[],records=[],sources=new Map();
 for(const item of projected.items.filter(i=>i.publication.available)){
  const v=videos.get(item.id),isNative=publicationAvailable(v.data),l=isNative?null:legacy.get(item.id);if(!isNative&&!l)reject('Preserved source missing.');
  const source={item,video:v.data,legacy:l?.data??null,sourceUpdateTime:{video:v.updateTime,...(l?{legacy:l.updateTime}:{})}};
  const entry=projectContextualPublication(source);if(!entry)reject('Published identity did not yield an accepted-source projection.');
  const sourceJson=JSON.stringify(source),sourceSnapshotHash=sha(sourceJson);
  catalog.push({id:item.id,publicationAvailable:true,sourceIdentity:entry.sourceIdentity,categoryIds:item.categoryIds,manual:item.categoryOverride?.manual===true||item.categoryResolution?.mode==='manual',updateTime:v.updateTime});
  records.push({sourceJson,sourceSnapshotHash});sources.set(item.id,{source,entry,sourceSnapshotHash});
 }
 if(catalog.length!==499||new Set(catalog.map(i=>i.id)).size!==499)reject('This bootstrap must bind the complete reviewed499-publication inventory.');
 return {schemaVersion:1,catalog,records,sources,taxonomy:o.taxonomy,observedAt:o.observedEnd,sourceObservationSHA256:input.sourceObservationSHA256};
}
export function bindIndependentFormatReviews(input,normalized){
 const reviews=[],bindings=[],withheld=[];
 for(const a of input.formatAnnotations.annotations??[]){
  const found=normalized.sources.get(a.reelId);if(!found)reject('Annotation identity absent from preserved inventory.');
  if(a.state!=='supported'){withheld.push({id:a.reelId,state:a.state,reason:a.reason});continue;}
  const {source,entry,sourceSnapshotHash}=found;
  if(a.publicationBinding?.analysisKey!==source.video.analysis_key||String(a.publicationBinding?.analysisGeneration)!==String(source.video.analysis_generation))reject('Annotated original publication pointer changed.');
  const frequency=new Map();for(const u of a.units)for(const ref of u.evidenceRefs)frequency.set(ref,(frequency.get(ref)??0)+1);
  const removedSharedRefs=[];
  const units=a.units.map(u=>({unitId:u.unitId,evidenceRefs:u.evidenceRefs.filter(ref=>{if(frequency.get(ref)>1){removedSharedRefs.push(ref);return false;}return true;})}));
  if(units.some(u=>!u.evidenceRefs.length))reject('Distinct reviewed preparations require distinct literal anchors.');
  const evidence=a.evidence.map(e=>{
   const text=e.sourceKind==='caption'?source.video.source_caption?.text:source.video.transcript??source.legacy?.transcript;
   if(typeof text!=='string'||!text.includes(e.excerpt))reject('Independent annotation literal is absent from frozen saved source.');
   const sourceIdentity=e.sourceKind==='caption'?source.video.source_caption?.capture_id:source.video.transcript_key&&source.video.transcript_generation?source.video.transcript_key+'@'+source.video.transcript_generation:source.legacy?.provenance?.recordHash?'legacy:'+source.legacy.provenance.recordHash:'saved-transcript:'+entry.sourceProofHash;
   return {...e,sourceIdentity};
  });
  const review={schemaVersion:1,kind:'independent_format_review',reelId:a.reelId,value:a.value,state:'supported',sourceIdentity:entry.sourceIdentity,sourceProofHash:entry.sourceProofHash,sourceSnapshotHash,reviewId:a.reviewId,reviewer:input.formatAnnotations.reviewer,reviewedAt:input.formatAnnotations.reviewedAt,evidence,units};
  reviews.push(review);bindings.push({reelId:a.reelId,reviewId:a.reviewId,reviewHash:contextualHash(review),sourceSnapshotHash,originalSourceProofHash:entry.sourceProofHash,annotationFileSHA256:input.annotationHashes['full-catalogue-format-annotations-v1.json'],removedSharedUnitRefs:[...new Set(removedSharedRefs)],literalAnchors:evidence.length,units:units.length,author:'independent_codex_native_source_review',notHumanOrAudiovisualCertification:true});
 }
 return {reviews,bindings,withheld};
}
function blindComparison(input,result){
 const byId=new Map(result.contributions.map(c=>[c.data.reelId,c.data.entry])),reviewedIds=new Set(input.formatAnnotations.annotations.filter(a=>a.state==='supported').map(a=>a.reelId));
 return {annotationSHA256:input.annotationHashes['full-catalogue-blind-labels-v1.json'],method:'sealed_purposive_source_labels; compared_to_saved_projection_not_whole_population_accuracy',totalCases:input.blindAnnotations.cases.length,rows:input.blindAnnotations.cases.map(a=>{const e=byId.get(a.id);if(!e)reject('Blind source case absent.');const expectedContext=a.context,contextAgreement=e.context.value===expectedContext||expectedContext==='unknown'&&e.context.state!=='supported';return {id:a.id,expectedContext,projectedContext:e.context.value,contextState:e.context.state,contextAgreement,expectedFormat:a.recipeFormat,projectedFormat:e.format.value,formatState:e.format.state,formatReviewUsed:reviewedIds.has(a.id),evaluationRole:reviewedIds.has(a.id)?'format_review_input_not_holdout':'independent_conservative_comparison',ingredientEvidence:e.attributes.filter(x=>x.dimensionId==='ingredient').map(x=>({value:x.valueId,state:x.state,role:x.role,polarity:x.polarity})),limitations:a.reason};}),precisionGeneralized:false,notes:['Contexts are preserved saved analysis classifications; agreement is not endorsement of claims or video accuracy.','Format decisions used as source reviews are explicitly excluded from any holdout/generalization claim.','Unknown/withheld is not a false fact or processing failure.']};
}
export function prepareSavedCatalogueArtifacts(input,{sourceCommit,sourceInputSHA256}={}){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit??''))reject('Exact preparation commit required.');
 const n=normalizeSavedCatalogueInput(input),bound=bindIndependentFormatReviews(input,n),result=prepareContextualCatalogue({...n,formatReviews:bound.reviews});
 if(result.contributions.length!==499||result.catalogue.projectionCoverage.missingCount!==0)reject('Bootstrap failed complete499 identity coverage.');
 const operationId=contextualHash({kind:'saved_contextual_catalogue_bootstrap',sourceCommit,sourceObservationSHA256:input.sourceObservationSHA256,policy:contextualCataloguePolicy,contributions:result.contributions.map(w=>[w.data.reelId,w.data.idempotencyKey]).sort((a,b)=>a[0].localeCompare(b[0])),reviews:bound.bindings.map(b=>b.reviewHash).sort()});
 const before=n.taxonomy.data;if(before.pendingOperationId)reject('Pending taxonomy operation must be reconciled.');
 const after=structuredClone(before);after.revision=before.revision+1;
 for(const [value,name]of [['single_recipe','Receita única'],['recipe_collection','Várias receitas']]){
  const id='ctx_format_'+value,existing=after.nodes.find(node=>node.id===id);if(existing&&existing.manual!==false)reject('Reserved format node already has a protected manual definition.');
  if(!existing)after.nodes.push({id,name,parentId:'receitas',kind:'catalogue_format',formatValue:value,manual:false});
 }
 after.appliedCommands=[...(after.appliedCommands??[]),{id:operationId,fingerprint:operationId,kind:'contextual_catalogue_bootstrap'}];
 const manifest={schemaVersion:1,status:'active',policyVersion:contextualCataloguePolicy.version,operationId,sourceObservationSHA256:input.sourceObservationSHA256,sourceHash:result.sourceHash,inventoryIds:result.inventoryIds,inventoryCount:499,evaluatedCount:499,observedAt:n.observedAt,activatedBy:'reviewed_bootstrap',incremental:{enabled:true,eventDriven:true,noProviders:true}};
 const owner={schemaVersion:1,kind:'saved_contextual_catalogue_bootstrap',operationId,sourceCommit,sourceInputSHA256,sourceObservationSHA256:input.sourceObservationSHA256,policyVersion:contextualCataloguePolicy.version,sourceBindings:result.sourceBindings,preconditions:{taxonomyUpdateTime:n.taxonomy.updateTime,taxonomyRevision:before.revision,catalogueAbsent:true},contributionWrites:result.contributions,reviewWrites:bound.reviews.map(r=>({path:'reels_index/contextual_review_'+r.reelId,data:{kind:'contextual_review',reelId:r.reelId,reviewHash:contextualHash(r),review:r}})),settingsWrites:[{path:'settings/reels_v2_taxonomy',data:after},{path:'settings/reels_v2_contextual_catalogue',data:manifest}],sourceAnalysisWrites:false,providers:false,deletions:false,newReels:false,approvedForApply:false};
 return {result,owner,bound,blind:blindComparison(input,result),sourceObservationSHA256:input.sourceObservationSHA256,annotationHashes:input.annotationHashes};
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))reject('Preparation executes only in central GitHub Actions.');
 const a=process.argv.slice(2);if(a.length!==4||a[0]!=='--input'||a[2]!=='--output')reject('Expected --input PATH --output DIRECTORY');
 const bytes=await readFile(a[1]);if(bytes.length>6*1024*1024)reject('Input limit exceeded.');
 const r=prepareSavedCatalogueArtifacts(JSON.parse(bytes),{sourceCommit:process.env.GITHUB_SHA,sourceInputSHA256:sha(bytes)});await mkdir(a[3],{recursive:true});
 const files={'catalogue-view.json':r.result.catalogue,'bootstrap-plan.json':r.owner,'source-bindings.json':r.result.sourceBindings,'format-review-bindings.json':r.bound,'blind-comparison.json':r.blind,'coverage-ledger.json':r.result.contributions.map(w=>({id:w.data.reelId,sourceIdentity:w.data.sourceIdentity,sourceVersions:w.data.sourceVersions,sourceProofHash:w.data.sourceProofHash,context:w.data.entry.context,format:w.data.entry.format,dimensions:w.data.entry.coverage,formatReview:w.data.entry.formatReview??null})), 'preparation-provenance.json':{sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,sourceInputSHA256:sha(bytes),sourceObservationSHA256:r.sourceObservationSHA256,annotationHashes:r.annotationHashes,inventory:499,evaluated:499,missing:0,reviewedFormats:r.bound.reviews.length,withheld:r.bound.withheld.length,providers:0,newReels:0,sourceAnalysisWrites:0,processingEnabled:false}};
 for(const [name,data]of Object.entries(files))await writeFile(join(a[3],name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({prepared:true,inventory:499,evaluated:499,formats:r.result.catalogue.formats.map(f=>({value:f.value,count:f.count})),contextCoverage:r.result.catalogue.projectionCoverage,providers:0}));
}
if(process.argv[1]?.endsWith('/prepare-contextual-catalogue.mjs'))await main();
