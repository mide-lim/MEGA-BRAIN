// Frozen projection from commit 8150c85ad40f48c5cac50048f9b233506259068c.
// Only symbol names are isolated; no provider, policy or mutation is present.
import {createHash} from 'node:crypto';
import {publicationAvailable,projectReel} from './reels-model.mjs';
import {preservedContentAvailable,withPreservedSummary} from './reels-preserved-content.mjs';
export const frozenSemanticSourceCommit='8150c85ad40f48c5cac50048f9b233506259068c';
export const frozenSemanticSourceBlob='6ed5f435bc4dd6e8cf7aa2d77726e21167b02679';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const frozenHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function frozenEditorial(item,editorial={}){
 return {manual:item?.categoryOverride?.manual===true||editorial.manual===true,revision:item?.categoryOverride?.revision??editorial.revision??null,categoryIds:item?.categoryOverride?.manual===true?item.categoryIds:[],suppressedDimensions:editorial.suppressedDimensions??[],suppressedValues:editorial.suppressedValues??[]};
}
export function frozenSemanticSourceFromSaved({video={},legacy=null,item,sourceVersions={},editorial={}}){
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
 const ed=frozenEditorial(item,editorial);
 return {id,title:item.title??report?.title??report?.summary?.slice(0,120)??id,sourceIdentity:identity,sourceVersions:versions,editorial:ed,editorialHash:frozenHash(ed),fields,semanticProofHash:frozenHash({identity,fields}),truncated:truncationReasons.size>0,truncationReasons:[...truncationReasons],sourceCharacters:chars};
}
