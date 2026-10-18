import {createHash} from 'node:crypto';
import {publicationAvailable,projectReel} from './reels-model.mjs';
import {preservedContentAvailable,withPreservedSummary} from './reels-preserved-content.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const semanticHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const semanticPolicyVersion='semantic-curator-v1';
export const semanticContexts=['recipe','technology','health','travel','business','home','general'];
export const semanticStatuses=['prepared','running','paused','completed','uncertain','failed','cancelled'];
export const semanticGroupKinds=['context','format','facet','segment'];
export const semanticPolicyPath='settings/reels_v2_semantic_policy';
export function semanticPolicy(value={}){
 const n=(v,d,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max?v:d;
 const policy={version:semanticPolicyVersion,enabled:value.enabled===true,model:/^gemini-[a-z0-9.-]{1,80}$/.test(value.model??'')?value.model:null,batchSize:n(value.batchSize,8,1,12),maxCalls:n(value.maxCalls,160,1,500),maxSources:n(value.maxSources,499,1,10000),verifierModel:/^gemini-[a-z0-9.-]{1,80}$/.test(value.verifierModel??'')?value.verifierModel:null,authorizationId:typeof value.authorizationId==='string'?value.authorizationId:null,authorizedCohortHash:/^[a-f0-9]{64}$/.test(value.authorizedCohortHash??'')?value.authorizedCohortHash:null,expiresAt:typeof value.expiresAt==='string'?value.expiresAt:null,autoPromotionEnabled:value.autoPromotionEnabled===true,minUniqueMembers:n(value.minUniqueMembers,10,2,10000),calibrationReceipt:value.calibrationReceipt??null};
 return policy;
}
export function semanticSourceFromSaved({video={},legacy=null,item,sourceVersions={},editorial={}}){
 const native=publicationAvailable(video),id=video.id??item?.id;
 if(!/^[A-Za-z0-9_-]{5,32}$/.test(id??'')||!native&&!preservedContentAvailable(legacy,id))throw Error('Somente conhecimento publicado salvo é elegível.');
 item??=withPreservedSummary(projectReel({...video,id}),legacy);
 const identity=native?{kind:'native',reelId:id,analysisKey:video.analysis_key,analysisGeneration:video.analysis_generation}:{kind:'legacy_preserved',reelId:id,recordHash:legacy.provenance.recordHash,sourceSnapshotHash:legacy.provenance.sourceSnapshotHash};
 const report=native?video.analysis:legacy.analysis,fields=[],sourceIdentity=native?'analysis:'+video.analysis_key+'@'+video.analysis_generation:'legacy:'+legacy.provenance.recordHash;
 let chars=0;const truncationReasons=new Set();
 const add=(fieldPath,text,source='saved_analysis',identity=sourceIdentity)=>{if(typeof text!=='string'||!text.trim())return;if(chars>=24000||fields.length>=96){truncationReasons.add('TOTAL_TEXT_OR_FIELD_LIMIT');return;}const captured=text.trim().slice(0,Math.min(12000,24000-chars));if(captured.length<text.trim().length)truncationReasons.add('FIELD_OR_TOTAL_TEXT_TRUNCATED:'+fieldPath);fields.push({fieldPath,text:captured,source,sourceIdentity:identity});chars+=captured.length;};
 const walk=(v,path,depth=0)=>{if(depth>5){truncationReasons.add('STRUCTURE_DEPTH_LIMIT:'+path);return;}if(Array.isArray(v)&&v.length>32)truncationReasons.add('ARRAY_LIMIT:'+path);if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length>32)truncationReasons.add('OBJECT_FIELD_LIMIT:'+path);if(typeof v==='string')add(path,v);else if(Array.isArray(v))v.slice(0,32).forEach((x,i)=>walk(x,path+'.'+i,depth+1));else if(v&&typeof v==='object')for(const k of Object.keys(v).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k)).slice(0,32))walk(v[k],path+'.'+k,depth+1);};
 for(const key of ['title','summary','knowledge','useful_information','useful_value','claims','topics','candidate_relations','limitations'])walk(report?.[key],'analysis.'+key);
 add('caption',video.source_caption?.text??legacy?.caption,'caption',video.source_caption?.capture_id??sourceIdentity);
 add('transcript',native?video.transcript:legacy?.transcript,'transcript',video.transcript_key&&video.transcript_generation?video.transcript_key+'@'+video.transcript_generation:sourceIdentity);
 if(!fields.length)throw Error('Publicação sem texto salvo elegível.');
 const versions={video:sourceVersions.video,...(!native&&sourceVersions.legacy?{legacy:sourceVersions.legacy}:{})};
 if(typeof versions.video!=='string')throw Error('Versão da fonte ausente.');
 const ed={manual:video.taxonomy_override?.manual===true||editorial.manual===true,revision:video.taxonomy_override?.revision??editorial.revision??null,categoryIds:video.taxonomy_override?.manual===true?item.categoryIds:[],suppressedDimensions:editorial.suppressedDimensions??[],suppressedValues:editorial.suppressedValues??[]};
 return {id,title:item.title??report?.title??report?.summary?.slice(0,120)??id,sourceIdentity:identity,sourceVersions:versions,editorial:ed,editorialHash:semanticHash(ed),fields,semanticProofHash:semanticHash({identity,fields}),truncated:truncationReasons.size>0,truncationReasons:[...truncationReasons],sourceCharacters:chars};
}
export function prepareSemanticPlan({inventory,selection={all:true},policy:rawPolicy={},observedAt}){
 const policy=semanticPolicy(rawPolicy),all=[...inventory].filter(x=>x.publicationAvailable!==false).sort((a,b)=>a.id.localeCompare(b.id)),byId=new Map(all.map(x=>[x.id,x]));
 if(byId.size!==all.length||all.some(x=>!/^[A-Za-z0-9_-]{5,32}$/.test(x.id)||typeof x.sourceVersions?.video!=='string'))throw Error('Inventário publicado/versionado inválido.');
 if(selection.all!==true&&!Array.isArray(selection.ids)||selection.all===true&&selection.ids!==undefined)throw Error('Seleção semântica inválida.');
 const ids=selection.all===true?all.map(x=>x.id):[...new Set(selection.ids)].sort();
 if(!ids.length||ids.length>policy.maxSources||ids.some(id=>!byId.has(id)))throw Error('Seleção fora do acervo publicado.');
 const pins=ids.map(id=>({id,sourceVersions:byId.get(id).sourceVersions})),cohortHash=semanticHash(pins),maximumCalls=Math.ceil(ids.length/policy.batchSize)*2+1;
 if(maximumCalls>policy.maxCalls)throw Error('Coorte excede o limite finito de chamadas.');
 const blockingReasons=[];
 if(!policy.enabled)blockingReasons.push('CURATION_NOT_AUTHORIZED');
 if(!policy.model||!policy.verifierModel)blockingReasons.push('MODEL_NOT_CONFIGURED');
 if(!policy.authorizationId||policy.authorizedCohortHash!==cohortHash)blockingReasons.push('COHORT_NOT_AUTHORIZED');
 if(!policy.expiresAt||!Number.isFinite(Date.parse(policy.expiresAt))||Date.parse(policy.expiresAt)<=Date.parse(observedAt))blockingReasons.push('AUTHORIZATION_EXPIRED');
 const preview={publishedCount:all.length,selectedCount:ids.length,cohortHash,batchSize:policy.batchSize,maximumCalls,model:policy.model,providerEnabled:blockingReasons.length===0,blockingReasons};
 return {version:semanticPolicyVersion,pins,policy,preview,previewHash:semanticHash({pins,policy,maximumCalls}),observedAt,providerCalls:0,inferenceStarted:false};
}
