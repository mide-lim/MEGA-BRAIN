import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {projectReel,categoryNavigation,publicationAvailable} from '../lib/reels-model.mjs';
import {withPreservedSummary} from '../lib/reels-preserved-content.mjs';
import {prepareContextualCategoryPlan} from '../lib/reels-contextual-calibration.mjs';
import {calibrationReportView} from '../lib/reels-curation-calibration.mjs';
import {buildSavedQualityDiagnostics} from '../lib/reels-quality-diagnostics.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=v=>structuredClone(v);
export function normalizeCalibrationInput(input){
 if(input?.schemaVersion!==1||!Array.isArray(input.catalogRecords)||input.catalogRecords.length>2000||!Array.isArray(input.records)||input.records.length>40)throw Error('Invalid bounded saved-source input.');
 const raw=new Map(input.catalogRecords.filter(r=>r.path?.startsWith('videos/')).map(r=>[r.path.split('/')[1],r]));
 const legacy=new Map(input.catalogRecords.filter(r=>r.path?.startsWith('reels_legacy_content/')).map(r=>[r.path.split('/')[1],r.data]));
 const projected=[...raw].map(([id,row])=>withPreservedSummary(projectReel({...row.data,id}),legacy.get(id)));
 const navigation=categoryNavigation(projected,input.taxonomy.data);
 const catalog=navigation.items.filter(i=>i.publication?.available).map(item=>{
  const row=raw.get(item.id),v=row.data,l=legacy.get(item.id);
  const sourceIdentity=publicationAvailable(v)?{kind:'native',reelId:item.id,analysisKey:v.analysis_key,analysisGeneration:v.analysis_generation}:{kind:'legacy_preserved',reelId:item.id,recordHash:l?.provenance?.recordHash,sourceSnapshotHash:l?.provenance?.sourceSnapshotHash};
  return {id:item.id,publicationAvailable:true,sourceIdentity,categoryIds:item.categoryIds,manual:item.categoryOverride?.manual===true||item.categoryResolution?.mode==='manual'||navigation.taxonomy.assignments?.some(a=>a.reelId===item.id&&a.manual===true)||false,updateTime:row.updateTime};
 });
 if(catalog.length!==499)throw Error('The reviewed source inventory must contain exactly499 saved published identities.');
 return {...input,catalog};
}
export function prepareCalibrationArtifacts(rawInput,{sourceCommit=null}={}){
 const input=normalizeCalibrationInput(rawInput),{calibration,plan}=prepareContextualCategoryPlan(input),before=input.taxonomy.data;
 if(before.pendingOperationId)throw Error('An unfinished taxonomy operation must be reconciled first.');
 const after=clone(before),operationId=plan.planHash,nextRevision=before.revision+1,affected=new Set(plan.affectedIds);
 for(const group of plan.groups){
  if(!after.nodes.some(n=>n.id===group.categoryId))after.nodes.push({id:group.categoryId,name:group.label,parentId:group.parentCategoryId,manual:false,evidenceCount:group.members.length,calibrationPlanHash:plan.planHash,calibrationReportHash:calibration.reportHash});
  else{const node=after.nodes.find(n=>n.id===group.categoryId);if(node.manual===true)throw Error('Manual node is protected.');node.calibrationPlanHash=plan.planHash;node.evidenceCount=group.members.length;}
  after.rules=(after.rules??[]).filter(rule=>rule.id!==group.rule.id);after.rules.push({...group.rule,calibrationPlanHash:plan.planHash});
 }
 const additions=new Map();
 for(const group of plan.groups)for(const member of group.members){const prior=additions.get(member.id)??new Set(member.priorCategoryIds);prior.add(group.categoryId);additions.set(member.id,prior);}
 after.assignments=(after.assignments??[]).filter(a=>!affected.has(a.reelId));
 for(const [reelId,categories]of additions)after.assignments.push({reelId,categoryIds:[...categories],manual:false,revision:nextRevision,calibrationPlanHash:plan.planHash});
 if(plan.groups.length){after.revision=nextRevision;after.appliedCommands=[...(after.appliedCommands??[]),{id:operationId,fingerprint:plan.planHash,kind:'finite_contextual_calibration'}];}
 const view=calibrationReportView(calibration,plan),calibrationDocument={schemaVersion:1,planHash:plan.planHash,sourceHash:calibration.corpus.sourceCorpusHash,policyVersion:calibration.version,observedAt:input.observedAt,preparedAt:new Date().toISOString(),sourceCommit,report:view,sourceBindings:calibration.sourceBindings,appliedOperationId:operationId,scope:'finite_corpus_only',newContentAutomatic:false,processingStarted:false};
 const quality=buildSavedQualityDiagnostics({candidates:(input.qualityRecords??[]).map(record=>({record,report:record.analysis,mediaInspection:record.media_inspection??null,transcriptionReceipt:record.transcription_receipt??null,trustedReviews:[],historical:true})),observedAt:input.observedAt});
 const owner={schemaVersion:1,kind:'reviewed_additive_curation_metadata',operationId,sourceCommit,observedAt:input.observedAt,planHash:plan.planHash,calibrationReportHash:calibration.reportHash,sourceInputSHA256:null,preconditions:{taxonomyUpdateTime:input.taxonomy.updateTime,taxonomyRevision:before.revision,calibrationAbsent:true,sourceBindings:plan.preconditions.sourceBindings},writes:[...(plan.groups.length?[{path:'settings/reels_v2_taxonomy',data:after}]:[]),{path:'settings/reels_v2_contextual_calibration',data:calibrationDocument}],affectedIds:plan.affectedIds,groupIds:plan.groups.map(g=>g.categoryId),sourceAnalysisWrites:false,newReels:false,providers:false,deletions:false,approvedForApply:false};
 return {input,calibration,plan,view,quality,owner};
}
async function main(){
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--input'||args[2]!=='--output')throw Error('Expected --input PATH --output DIRECTORY.');
 const bytes=await readFile(args[1]);if(bytes.length>4*1024*1024)throw Error('Saved-source input is too large.');
 const sourceCommit=process.env.GITHUB_SHA;if(!/^[a-f0-9]{40}$/.test(sourceCommit??''))throw Error('Preparation is restricted to an identified GitHub Actions source.');
 if(process.env.GITHUB_ACTIONS!=='true')throw Error('Product preparation runs only in GitHub Actions.');
 const result=prepareCalibrationArtifacts(JSON.parse(bytes),{sourceCommit});result.owner.sourceInputSHA256=digest(bytes);
 await mkdir(args[3],{recursive:true});
 for(const [name,value]of [['calibration-report.json',result.calibration],['finite-category-plan.json',result.plan],['calibration-view.json',result.view],['saved-quality-report.json',result.quality],['owner-apply-package.json',result.owner]])await writeFile(join(args[3],name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 await writeFile(join(args[3],'preparation-provenance.json'),JSON.stringify({sourceCommit,runId:process.env.GITHUB_RUN_ID,sourceInputSHA256:digest(bytes),inputSourceObservationSHA256:result.input.sourceObservationSHA256,observedAt:result.input.observedAt,preparedAt:new Date().toISOString(),inventory:result.calibration.corpus.inventoryCount,evaluated:result.calibration.corpus.evaluatedCount,groupCount:result.plan.groups.length,affectedIds:result.plan.affectedIds.length,processingEnabled:false,googleCredentialsUsed:false,providerCalls:0,sourceAnalysisWrites:0},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({prepared:true,inventory:result.calibration.corpus.inventoryCount,evaluated:result.calibration.corpus.evaluatedCount,groups:result.plan.groups.length,affected:result.plan.affectedIds.length,providerCalls:0}));
}
if(process.argv[1]?.endsWith('/prepare-contextual-calibration.mjs'))await main();
