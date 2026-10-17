import {contextLabels} from './knowledge.mjs';
export const publicationRule='saved-source-publication-v1';
const normal=s=>s.normalize('NFC').replace(/\s+/g,' ').trim().toLocaleLowerCase('pt-BR');
const string=s=>typeof s==='string'?s:'';

// Recover source units rather than trusting a paraphrased model field. Every
// value is one contiguous literal span. Caption recipe sections avoid treating
// unrelated background lyrics as preparation; recovered text never invents word-aligned timestamps.
function recipeSourceFields(sources,reviewed){
 if(reviewed.knowledge?.context!=='recipe')return [];
 const fields=[];
 const add=(source,kind,text)=>{
  let rest=text.trim();
  while(rest){
   let end=Math.min(700,rest.length);
   if(end<rest.length){const boundary=rest.slice(0,end).lastIndexOf(' ');if(boundary>350)end=boundary;}
   const value=rest.slice(0,end).trim();
   fields.push({kind,name:kind==='ingredient'?'Ingredientes da legenda':kind==='procedure'?'Preparo da legenda':'Trecho da transcrição da receita',value,evidence:[{source:source.source,excerpt:value,scope:'saved_text_without_time_alignment'}],source_attributed:true});
   rest=rest.slice(end).trim();
  }
 };
 let hasProcedureSection=false;
 for(const source of sources.filter(s=>s.source==='caption')){
  const headings=[...source.text.matchAll(/^(?:[📕❂📝]\s*)?(ingredients|ingredientes|cooking process|modo de preparo|preparo)\s*:[^\S\r\n]*/gimu)];
  for(const [i,heading]of headings.entries()){
   let body=source.text.slice(heading.index+heading[0].length,headings[i+1]?.index??source.text.length);
   const hashtag=body.search(/^\s*#/m);if(hashtag>=0)body=body.slice(0,hashtag);
   if(body.trim()){const kind=/^(ingredients|ingredientes)$/iu.test(heading[1])?'ingredient':'procedure';if(kind==='procedure')hasProcedureSection=true;add(source,kind,body);}
  }
 }
 if(!hasProcedureSection)for(const source of sources.filter(s=>s.source==='transcript'))add(source,'other',source.text);
 return fields;
}

// Sources are copied, never repaired, translated, stitched into a quotation or
// promoted to externally verified facts. Model narrative stays diagnostic.
export function consolidatePublication(reviewed,record,candidate){
 if(string(record.transcript).length>100000||string(record.source_caption?.text).length>50000)throw Error('Fonte salva excede o limite de publicação.');
 const sources=[];
 if(typeof record.source_caption?.text==='string'&&record.source_caption.text.trim()&&record.source_caption.capture_id)
  sources.push({source:'caption',text:record.source_caption.text,capture_id:record.source_caption.capture_id});
 if(typeof record.transcript==='string'&&record.transcript.trim())sources.push({source:'transcript',text:record.transcript});
 const contains=text=>!!string(text).trim()&&sources.some(s=>normal(s.text).includes(normal(text)));
 const conflict=value=>{
  if(typeof value==='string')return (value.match(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{3,}\b/giu)??[]).some(token=>!contains(token));
  if(Array.isArray(value))return value.some(conflict);
  return !!value&&typeof value==='object'&&Object.values(value).some(conflict);
 };
 const fields=(reviewed.knowledge?.fields??[]).filter(f=>!conflict(f));
 const grounded={...reviewed,useful_information:reviewed.useful_information.filter(x=>!conflict(x)),visual_observations:reviewed.visual_observations.filter(x=>!conflict(x)),...(reviewed.knowledge?{knowledge:{...reviewed.knowledge,fields,keywords:reviewed.knowledge.keywords.filter(x=>!conflict(x))}}:{})};
 const names=fields.filter(f=>contains(f.name)).map(f=>f.name);
 const recipe=fields.find(f=>f.kind==='recipe_name'&&contains(f.value));
 const context=contextLabels[reviewed.knowledge?.context]??'Conhecimento do Reel';
 // Correct a detected identifier/product conflict without discarding other narrative.
 const tokens=(string(candidate.title)+' '+string(candidate.summary)).match(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{3,}\b/giu)??[];
 const acceptedFields=new Set(fields.map(f=>JSON.stringify(f)));
 const rejectedProducts=(candidate.knowledge?.fields??[]).filter(f=>f.kind==='product'&&!acceptedFields.has(JSON.stringify(f)));
 const unsafeNarrative=tokens.some(t=>!contains(t))||rejectedProducts.some(f=>[candidate.title,candidate.summary].some(t=>string(f.value).trim()&&normal(string(t)).includes(normal(f.value))));
 const fallbackTitle=contains(candidate.title)?candidate.title:recipe?.value??(names.length?context+': '+[...new Set(names)].slice(0,3).join(', '):context+' — fontes do autor');
 const excerpts=fields.filter(f=>contains(f.value)&&contains(f.name)).slice(0,3).map(f=>f.name+': '+f.value);
 const gapSummary=/quantidades?\s+ausentes?|n[aã]o\s+(?:informa|especific|mencion)|not specified|unspecified|missing information/iu.test(string(candidate.summary));
 const fallbackSummary=excerpts.length?'Segundo as fontes salvas: '+excerpts.join('; ')+'.':'Conteúdo organizado a partir das fontes salvas do autor. Os trechos completos abaixo preservam detalhes que a extração estruturada pode não cobrir.';
 const diagnostics=candidate.publication_review?.rule===publicationRule?candidate.publication_review.candidate:{title:candidate.title,summary:candidate.summary,limitations:structuredClone(candidate.limitations),useful_information:structuredClone(candidate.useful_information),keywords:structuredClone(candidate.knowledge?.keywords??[]),transcript_quality:structuredClone(candidate.transcript_quality),missing_information:structuredClone(candidate.knowledge?.missing_information??[])};
 return {...grounded,title:unsafeNarrative?fallbackTitle:candidate.title,summary:unsafeNarrative||gapSummary?fallbackSummary:candidate.summary,
  limitations:[...reviewed.limitations.filter(x=>!candidate.limitations.includes(x)), 'As fontes registram o que foi publicado ou reconhecido no áudio; não comprovam as alegações nem a exatidão da transcrição.'],
  transcript_quality:{assessment:'Transcrição preservada sem correção automática nem verificação independente do áudio.',uncertain_segments:[]},
  ...(reviewed.knowledge?{knowledge:{...grounded.knowledge,missing_information:[]}}:{}),
  source_consolidation:{rule:publicationRule,sources,recipe_fields:recipeSourceFields(sources,grounded,record),coverage:'complete_saved_text_not_semantic_verification'},
  publication_review:{rule:publicationRule,candidate:diagnostics,narrative_support:unsafeNarrative?'source_fallback_after_identifier_conflict':'candidate_narrative_not_independently_verified',missing_information_status:'candidate_not_independently_verified',inference_replayed:false}
 };
}
