import {categoryDefinitions,categoryKey} from './category-taxonomy.mjs';
const officialLabels=new Map(categoryDefinitions.map(c=>[categoryKey(c.name),c.id]));
// Web read models only. These never make a legacy result publishable by workers.
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'?v:null;
const array=v=>Array.isArray(v)?v:[];
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const LEGACY_LIST_FIELDS=['schemaVersion','reelId','status','originalStatus','historical','executable','provenance.recordHash','provenance.sourceSnapshotHash','analysis.primary_category','analysis.secondary_categories','analysis.summary','analysis.topics'];
export function preservedRecordAvailable(v,id){return v?.schemaVersion===1&&v.reelId===id&&v.status==='legacy_preserved'&&v.historical===true&&v.executable===false&&hash(v.provenance?.recordHash)&&hash(v.provenance?.sourceSnapshotHash);}
export function preservedContentAvailable(v,id){return preservedRecordAvailable(v,id)&&v.originalStatus==='analyzed'&&object(v.analysis)&&typeof v.analysis.summary==='string'&&!!v.analysis.summary.trim();}
const label=v=>text(v)??(object(v)?text(v.name)??text(v.label)??text(v.id):null);
export function preservedSummary(v,id){
 if(!preservedContentAvailable(v,id))return null;
 const a=v.analysis,categories=[a.primary_category,...array(a.secondary_categories)].map(label).filter(Boolean).map(value=>officialLabels.get(categoryKey(value))??value),summary=text(a.summary);
 return {source:'legacy_preserved',title:summary?.split(/\n/)[0]?.slice(0,160)??null,summary,categoryIds:[...new Set(categories.length?categories:['a-organizar'])],tags:array(a.topics).map(label).filter(Boolean)};
}
export function withPreservedSummary(item,legacy){
 const saved=preservedSummary(legacy,item.id);if(!saved)return item;
 if(item.publication.available)return {...item,preservedAlternative:true};
 return {...item,...(item.importHeld?{status:'completed',stage:null,error:null}:{}),title:item.title??saved.title,categoryIds:item.categoryOverride?.manual?item.categoryIds:saved.categoryIds,tags:[...new Set([...item.tags,...saved.tags])],publication:{available:true,revision:null,qualityStatus:'legacy_preserved',summary:saved.summary,source:'legacy_preserved'},preservedAlternative:false};
}
// Explicit fields retain useful legacy knowledge; operational fields and URLs in
// provenance, candidates, diagnostics and backup paths do not cross this boundary.
const contentKeys=new Set(['name','label','title','text','claim','description','value','evidence','evidence_quote','basis','video_id','excerpt','source','start_seconds','end_seconds','importance','confidence','category','url','type','relation','reason','insight','application','useful_value','content','topic','reference','references','action','takeaway','practical_application','how_to_use','why_it_matters','support','status','code','flag','severity','message']);
function content(value,depth=0){if(depth>8)return null;if(value===null||typeof value==='boolean'||typeof value==='number')return value;if(typeof value==='string')return value;if(Array.isArray(value))return value.slice(0,256).map(v=>content(v,depth+1));if(!object(value))return null;return Object.fromEntries(Object.entries(value).filter(([k])=>contentKeys.has(k)).map(([k,v])=>[k,content(v,depth+1)]));}
export function preservedDetail(v,id){
 if(!preservedContentAvailable(v,id))return null;
 const a=v.analysis;
 return {source:'legacy_preserved',publishedAt:null,version:null,summary:text(a.summary),knowledge:null,insights:content(a.useful_value??null),visual:null,evidence:null,legacy:{primaryCategory:label(a.primary_category),secondaryCategories:array(a.secondary_categories).map(label).filter(Boolean),topics:array(a.topics).map(label).filter(Boolean),claims:content(a.claims==null?[]:Array.isArray(a.claims)?a.claims:[a.claims]),references:content(a.candidate_relations==null?[]:Array.isArray(a.candidate_relations)?a.candidate_relations:[a.candidate_relations]),qualityFlags:content(a.quality_flags??null),humanVerified:typeof a.human_verified==='boolean'?a.human_verified:null},note:'Análise antiga preservada. Não foi reprocessada nem recebeu validação de qualidade da versão atual.'};
}
const time=v=>typeof v==='string'&&v.length<=64&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{5,128}$/.test(v)?v:null;
const token=v=>typeof v==='string'&&/^[a-z0-9_.:-]{1,80}$/i.test(v)?v:null;
export const HISTORICAL_FIELDS=['id','kind','historical','executable','reelId','stage','worker','workerLabelDerived','sourceStatus','createdAt','queuedAt','startedAt','completedAt','failedAt','resultSavedAt','reason'];
export function historicalActivity(v){
 if(v.historical!==true||v.executable!==false||!hash(v.id))throw Error('Histórico fora do contrato inerte.');
 return {id:v.id,kind:token(v.kind),historical:true,executable:false,reelId:identifier(v.reelId),stage:token(v.stage),worker:token(v.worker),workerLabelDerived:['Aquisição','Transcrição','Análise'].includes(v.workerLabelDerived)?v.workerLabelDerived:null,sourceStatus:token(v.sourceStatus),at:time(v.completedAt??v.failedAt??v.resultSavedAt??v.startedAt??v.queuedAt??v.createdAt),createdAt:time(v.createdAt),queuedAt:time(v.queuedAt),startedAt:time(v.startedAt),completedAt:time(v.completedAt),failedAt:time(v.failedAt),resultSavedAt:time(v.resultSavedAt),detached:!!v.reason};
}
export const HISTORICAL_FINANCE_FIELDS=['id','kind','historical','executable','reelId','stage','amount','currency','recordedAt','day','reservedSeconds','rateVersion'];
export function historicalFinance(v){
 if(v.historical!==true||v.executable!==false||!hash(v.id))throw Error('Financeiro fora do contrato inerte.');
 return {id:v.id,kind:['accounting','reservation','estimate','provider_usage','unknown'].includes(v.kind)?v.kind:'unknown',historical:true,executable:false,reelId:identifier(v.reelId),stage:token(v.stage),amount:Number.isFinite(v.amount)&&v.amount>=0?v.amount:null,currency:['USD','BRL'].includes(v.currency)?v.currency:null,recordedAt:time(v.recordedAt),day:typeof v.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v.day)?v.day:null,reservedSeconds:Number.isSafeInteger(v.reservedSeconds)&&v.reservedSeconds>=0?v.reservedSeconds:null,billed:null};
}
