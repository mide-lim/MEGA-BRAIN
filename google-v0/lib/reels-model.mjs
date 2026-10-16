import {categoryDefinitions,resolveCategories,taxonomyVersion} from './category-taxonomy.mjs';
const arr=v=>Array.isArray(v)?v:[];
const str=v=>typeof v==='string'?v:null;
export const reelIdPattern=/^[A-Za-z0-9_-]{5,32}$/;
export const normalizeSearch=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
export const stageName=stage=>({upload:'acquisition',acquisition:'acquisition',transcription:'transcription',analysis:'analysis'}[stage]??null);
const publicId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;
const publicTime=value=>typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export const REEL_EXECUTION_FIELDS=['id','operationId','reelId','stage','worker','status','attempt','predecessorId','queuedAt','createdAt','startedAt','submittedAt','waitingAt','resultSavedAt','completedAt','failedAt','error.code','error.destination','error.uncertain','error.retryable'];
export function projectExecution(value={}){
 value=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 const stage=stageName(value.stage),status=['queued','running','submitting','waiting','collecting','applying','completed','failed','uncertain'].includes(value.status)?value.status:null;
 const worker=typeof value.worker==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(value.worker)?value.worker:null;
 const code=/^[A-Z0-9_]{1,64}$/.test(value.error?.code??'')?value.error.code:(status==='uncertain'?'RECONCILIATION_REQUIRED':'OPERATION_FAILED');
 const uncertain=status==='uncertain'||value.error?.uncertain===true;
 const error=value.error||status==='failed'||status==='uncertain'?{code,message:uncertain?'Resultado não confirmado; requer conciliação.':code==='QUALITY_VALIDATION_FAILED'?'Resultado salvo requer revisão.':'Não foi possível concluir esta etapa. Os dados foram preservados.',stage,worker,destination:uncertain?'reconcile':['retry','review'].includes(value.error?.destination)?value.error.destination:'retry',uncertain,retryable:!uncertain&&value.error?.retryable!==false}:null;
 return {id:publicId(value.id),operationId:publicId(value.operationId),reelId:publicId(value.reelId),stage,worker,status,attempt:Number.isSafeInteger(value.attempt)&&value.attempt>=1?value.attempt:null,predecessorId:publicId(value.predecessorId),queuedAt:publicTime(value.queuedAt??value.createdAt??value.created_at),createdAt:publicTime(value.createdAt??value.created_at),startedAt:publicTime(value.startedAt),submittedAt:publicTime(value.submittedAt),waitingAt:publicTime(value.waitingAt),resultSavedAt:publicTime(value.resultSavedAt),completedAt:publicTime(value.completedAt),failedAt:publicTime(value.failedAt),error};
}
export function publicationAvailable(v){
 // A rejected/new candidate cannot invalidate a different, previously published result.
 return !!(typeof v.analysis_key==='string'&&v.analysis_key&&typeof v.analysis_generation==='string'&&/^\d+$/.test(v.analysis_generation)&&v.analysis&&typeof v.analysis==='object'&&!Array.isArray(v.analysis)&&(v.analysis_quality_status==='accepted'||v.publication?.available===true||(v.analysis_quality_status==='review_required'&&v.candidate_analysis_key&&v.candidate_analysis_key!==v.analysis_key)));
}
export function reelStatus(v){
 const s=v.reels_v2?.status??v.status;
 if(v.uncertain===true||v.error?.uncertain===true||['uncertain','reconciling_result','reconciliation_failed'].includes(s))return 'uncertain';
 if(['running','started','claimed','polling','recovering_firestore_metadata','recovering_upload','recovering_429'].includes(s))return 'running';
 if(['waiting','queued','registered','completed','failed'].includes(s))return s;
 if(['analyzed','published'].includes(s))return publicationAvailable(v)?'completed':'uncertain';
 if(s==='needs_attention')return v.failure_confirmed===true?'failed':'uncertain';
 if(['pending','downloaded','transcribed'].includes(s))return 'registered';
 // Unknown legacy state is retained for reconciliation, never invented as completed.
 return 'uncertain';
}
export function projectReel(v){
 const available=publicationAvailable(v),status=reelStatus(v),a=available?v.analysis:null;
 v={...v,...(v.reels_v2??{}),updated_at:v.reels_v2?.updatedAt??v.updated_at};
 const categoryIds=available?[...new Set(arr(v.categoryIds??v.category_ids??a?.categories).filter(x=>typeof x==='string'))]:[];
 // Provider diagnostics remain private. Arbitrary text cannot safely be redacted
 // into a public UI message (JSON credentials and alternate auth schemes vary).
 const error=status==='failed'||status==='uncertain'?{code:/^[A-Z0-9_]{1,64}$/.test(v.error?.code??v.error_code??'')?(v.error?.code??v.error_code):(status==='uncertain'?'RECONCILIATION_REQUIRED':'CONFIRMED_FAILURE'),message:status==='uncertain'?'Resultado não confirmado; requer conciliação.':'Falha confirmada; confira a ação disponível.',destination:status==='uncertain'?'reconcile':str(v.error?.destination)??'retry',stage:stageName(v.error?.stage??v.stage),worker:str(v.error?.worker??v.worker),retryable:status==='failed'&&v.error?.retryable!==false,uncertain:status==='uncertain'}:null;
 return {id:v.id,sourceUrl:str(v.sourceUrl??v.source_url),title:str(v.title??a?.title),creator:str(v.creator),language:str(v.language),createdAt:str(v.createdAt??v.created_at),updatedAt:str(v.updatedAt??v.updated_at),status,stage:stageName(v.stage),categoryIds,categoryOverride:typeof v.taxonomy_override?.manual==='boolean'?{manual:v.taxonomy_override.manual,revision:v.taxonomy_override.revision??null}:null,tags:[...new Set([...arr(v.tags),...arr(v.published_tags)].filter(x=>typeof x==='string'))],media:{available:v.media_verified===true&&!!v.video_key&&!!v.video_generation},publication:{available,revision:available?str(v.publication?.revision??v.analysis_generation):null,qualityStatus:str(v.analysis_quality_status),summary:str(a?.summary)},error};
}
export function reelDetail(v){
 const item=projectReel(v),caption=typeof v.source_caption==='string'?v.source_caption:v.source_caption?.text;
 const state=typeof caption==='string'?(caption.trim()?'present':'empty'):(v.caption_status==='empty'?'empty':'missing');
 const a=item.publication.available?v.analysis:null,k=a?.knowledge;
 return {...item,caption:{state,text:state==='missing'?null:(caption??''),source:str(v.source_caption?.source??v.source_caption?.capture_id)},transcript:{state:typeof v.transcript==='string'&&(v.transcript.trim()||['recognized','no_speech_recognized'].includes(v.transcript_status))?(v.transcript.trim()?'present':'empty'):'missing',text:str(v.transcript),segments:Array.isArray(v.transcript_segments)?v.transcript_segments:null},analysis:{publishedAt:str(v.analysis_published_at??v.publication?.publishedAt),version:str(a?.version??a?.preset_version),knowledge:k?{context:k.context??null,fields:k.fields??null,missingInformation:k.missingInformation??k.missing_information??null,keywords:k.keywords??null}:null,summary:str(a?.summary),insights:a?.insights??a?.useful_information??null,visual:a?.visual??a?.visual_observations??null,evidence:a?.evidence??null},candidate:{available:!!(v.analysis_candidate||v.candidate_analysis_key),state:!!(v.analysis_candidate||v.candidate_analysis_key)?str(v.reels_v2?.candidate?.state??v.analysis_quality_status):null,reason:v.reels_v2?.candidate?.reason??v.analysis_review_reasons??null},media:{...item.media,url:item.media.available?`/api/media/${v.id}`:null,metadataUrl:item.media.available?`/api/video/${v.id}`:null,durationSeconds:v.duration_seconds??null,generation:v.video_generation??null},executions:Array.isArray(v.executions)?v.executions.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(projectExecution):null};
}
export function matchesReel(item,q={}){
 if(q.workspace==='library'&&(!item.publication.available||!item.categoryIds.length))return false;
 if(q.status&&!String(q.status).split(',').includes(item.status))return false;
 for(const field of ['stage','language'])if(q[field]&&item[field]!==q[field])return false;
 for(const field of ['worker','destination'])if(q[field]&&item.error?.[field]!==q[field])return false;
 if(q.category&&!item.categoryIds.includes(q.category))return false;
 if(q.tag&&!item.tags.includes(q.tag))return false;
 const terms=normalizeSearch(q.q).trim().split(/\s+/).filter(Boolean);
 const hay=normalizeSearch([item.id,item.sourceUrl,item.title,item.creator,item.publication.summary,...item.tags,...item.categoryIds].join(' '));return terms.every(t=>hay.includes(t));
}
export function eligibility(item){return item.status==='registered'?null:item.status==='completed'||item.publication.available?'already_completed':item.status==='failed'?'requires_retry':item.status==='uncertain'?'requires_reconciliation':'already_in_progress';}
// Leaf projection keeps legacy published metadata searchable without fetching report, knowledge or transcript.
export const REEL_LIST_FIELDS=['id','source_url','sourceUrl','title','creator','language','created_at','createdAt','updated_at','updatedAt','status','stage','categoryIds','category_ids','taxonomy_override.manual','taxonomy_override.revision','tags','published_tags','media_verified','video_key','video_generation','analysis_key','analysis_generation','analysis_quality_status','candidate_analysis_key','failure_confirmed','uncertain','worker','error_code','analysis.title','analysis.summary','analysis.categories','publication.available','publication.revision','reels_v2.status','reels_v2.stage','reels_v2.worker','reels_v2.updatedAt','reels_v2.error','reels_v2.candidate','error.code','error.message','error.destination','error.stage','error.worker','error.retryable','error.uncertain'];

// These stable roots are the previously approved categories-v2 contexts. A raw
// label never creates a new root or a category named after an individual Reel.
export const reelsCategoryGroups=Object.freeze([
 ['group-alimentacao','Alimentação'],['group-tecnologia','Tecnologia'],
 ['group-saude','Saúde e bem-estar'],['group-trabalho','Trabalho e negócios'],
 ['group-casa','Casa e estilo'],['group-viagens','Viagens e lugares'],
 ['group-outros','Outros temas']
].map(([id,name])=>Object.freeze({id,name})));
const officialById=new Map(categoryDefinitions.map(n=>[n.id,n]));
const groupByName=new Map(reelsCategoryGroups.map(n=>[n.name,n.id]));
const managedTaxonomy=state=>!!state&&(state.taxonomyVersion===taxonomyVersion||(state.revision??0)>0||arr(state.nodes).some(n=>n.manual===true||n.parentId!=null)||['assignments','rules','appliedCommands'].some(k=>arr(state[k]).length)||!!state.pendingOperationId);
export function initialReelsTaxonomy(items=[]){
 const destinations=new Set(items.filter(i=>i.publication?.available).map(i=>resolveCategories(arr(i.categorySourceIds??i.categoryIds)).primaryId).filter(Boolean));
 const activeGroups=new Set([...destinations].map(id=>officialById.get(id).group));
 const nodes=reelsCategoryGroups.filter(n=>activeGroups.has(n.name)).map(n=>({...n,parentId:null,manual:false,evidenceCount:null}));
 for(const definition of categoryDefinitions)if(destinations.has(definition.id))nodes.push({id:definition.id,name:definition.name,parentId:groupByName.get(definition.group),manual:false,evidenceCount:null});
 return {taxonomyVersion,revision:0,nodes,assignments:[],rules:[],appliedCommands:[]};
}
// Pure navigation compatibility. The source analysis, references, stored labels,
// assignments and revisions are never rewritten by a GET. Once manual actions
// or recurrence rules exist, their exact nodes and IDs take precedence. That
// configuration needs explicit copy validation rather than a silent reset.
export function categoryNavigation(items=[],saved=null){
 const managed=managedTaxonomy(saved),savedNodes=managed?arr(saved.nodes):[],savedIds=new Set(savedNodes.map(n=>n.id));
 const manualAssignments=new Map();
 for(const assignment of arr(saved?.assignments).filter(a=>a.manual===true)){
  const previous=manualAssignments.get(assignment.reelId);
  if(!previous||(assignment.revision??-1)>=(previous.revision??-1))manualAssignments.set(assignment.reelId,assignment);
 }
 const projected=items.map(item=>{
  const source=[...new Set(arr(item.categorySourceIds??item.categoryIds).filter(v=>typeof v==='string'))];
  if(!item.publication?.available)return {...item,categoryIds:[],categorySourceIds:source};
  // An older retained assignment cannot undo a newer override already applied
  // to this Reel. This mirrors the revision guard used by applyAssignments.
  const candidate=manualAssignments.get(item.id),assignment=candidate&&(item.categoryOverride?.revision??-1)>(candidate.revision??-1)?null:candidate,manual=item.categoryOverride?.manual===true||!!assignment;
  const explicit=assignment?arr(assignment.categoryIds):source;
  const resolved=resolveCategories(source);
  const retained=managed?explicit.filter(id=>savedIds.has(id)&&!officialById.has(id)):[];
  // Official primary classification stays singular even when the source holds
  // two valid subject IDs. Persisted custom/recurrence children remain attached
  // to that primary; an unresolved extra label adds no fallback destination.
  const primary=resolved.primaryId&&resolved.primaryId!=='a-organizar'?resolved.primaryId:null;
  const categoryIds=manual?[...new Set(explicit)]:retained.length?[...new Set([...(primary?[primary]:[]),...retained])]:resolved.primaryId?[resolved.primaryId]:[];
  return {...item,categoryIds,categorySourceIds:source,categoryResolution:{version:taxonomyVersion,mode:manual?'manual':retained.length?'preserved-configuration':'official-primary',primaryId:categoryIds[0]??null,topics:resolved.topics,unresolved:resolved.unresolved}};
 });
 const base=initialReelsTaxonomy(projected.filter(i=>i.categoryResolution?.mode==='official-primary'||i.categoryResolution?.mode==='preserved-configuration'&&i.categoryIds.some(id=>officialById.has(id))));
 const nodes=managed?structuredClone(savedNodes):base.nodes;
 if(managed)for(const node of base.nodes)if(!savedIds.has(node.id)){nodes.push(node);savedIds.add(node.id);}
 const missingManualIds=[...new Set(projected.filter(i=>i.categoryResolution?.mode==='manual').flatMap(i=>i.categoryIds).filter(id=>!nodes.some(n=>n.id===id)))];
 const compatibility={mode:managed?'preserved-configuration':'official-contexts',requiresCopyReconciliation:managed&&saved?.taxonomyVersion!==taxonomyVersion,missingManualIds};
 return {items:projected,taxonomy:{...base,...(managed?structuredClone(saved):{}),revision:saved?.revision??0,taxonomyVersion:managed?saved.taxonomyVersion??null:taxonomyVersion,nodes,compatibility}};
}
