// Read model for the published useful_information contract; never edits the source.
const labels=new Map([['author_claim','Afirmação do autor'],['visual_observation','Observação visual'],['interpretation','Interpretação da análise']]);
const sources=new Map([['transcript','Transcrição'],['video','Vídeo'],['caption','Legenda']]);
const text=value=>typeof value==='string'&&value.trim()?value:null;
function evidenceRows(value){
 const values=Array.isArray(value)?value:value==null?[]:[value];
 return values.flatMap(item=>{
  if(typeof item==='string')return text(item)?[{source:'Fonte registrada',excerpt:item,time:null}]:[];
  if(!item||typeof item!=='object')return [];
  const excerpt=text(item.excerpt)??text(item.text)??text(item.evidence_quote);if(!excerpt)return [];
  const timed=item.source!=='caption'&&Number.isFinite(item.start_seconds)&&Number.isFinite(item.end_seconds)&&item.start_seconds>=0&&item.end_seconds>=item.start_seconds;
  return [{source:sources.get(item.source)??'Fonte registrada',excerpt,time:timed?`${item.start_seconds}s–${item.end_seconds}s`:null}];
 });
}
export function insightCards(value){
 const values=Array.isArray(value)?value:value==null?[]:[value];
 return values.flatMap(item=>{
  if(typeof item==='string')return text(item)?[{label:null,claim:item,application:null,evidence:[]}]:[];
  if(!item||typeof item!=='object'||Array.isArray(item))return [];
  const claim=text(item.claim)??text(item.text)??text(item.description)??text(item.insight)??text(item.content);
  const application=text(item.application);if(!claim&&!application)return [];
  return [{label:labels.get(item.classification)??'Ideia registrada',claim,application:application===claim?null:application,evidence:evidenceRows(item.evidence)}];
 });
}
