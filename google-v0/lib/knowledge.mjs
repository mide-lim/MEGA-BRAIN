export const contexts=['recipe','technology','health','travel','business','home','general'];
export const fieldKinds=['recipe_name','ingredient','quantity','preparation_time','serving_count','procedure','tool','concept','problem','requirement','place','activity','price','material','product','practice','benefit_claim','caution','reference','other'];
export const fieldLabels={recipe_name:'Receita',ingredient:'Ingrediente',quantity:'Quantidade',preparation_time:'Tempo de preparo',serving_count:'Rendimento',procedure:'Etapa',tool:'Ferramenta',concept:'Conceito',problem:'Problema resolvido',requirement:'Requisito',place:'Lugar',activity:'Atividade',price:'Preço mencionado',material:'Material',product:'Produto',practice:'Prática',benefit_claim:'Benefício alegado',caution:'Cuidado',reference:'Referência citada',other:'Informação'};
export const contextLabels={recipe:'Receitas',technology:'Tecnologia',health:'Saúde e nutrição',travel:'Viagens',business:'Trabalho e negócios',home:'Casa e estilo',general:'Outros conhecimentos'};
export const evidenceSchema={type:'ARRAY',items:{type:'OBJECT',required:['source','start_seconds','end_seconds','excerpt'],properties:{source:{type:'STRING',enum:['transcript','video','caption']},start_seconds:{type:'NUMBER'},end_seconds:{type:'NUMBER'},excerpt:{type:'STRING'}}}};
export const knowledgeSchema={type:'OBJECT',required:['context','keywords','fields','missing_information'],properties:{
 context:{type:'STRING',enum:contexts},
 keywords:{type:'ARRAY',items:{type:'OBJECT',required:['term','evidence'],properties:{term:{type:'STRING'},evidence:evidenceSchema}}},
 fields:{type:'ARRAY',items:{type:'OBJECT',required:['kind','name','value','evidence'],properties:{kind:{type:'STRING',enum:fieldKinds},name:{type:'STRING'},value:{type:'STRING'},evidence:evidenceSchema}}},
 missing_information:{type:'ARRAY',items:{type:'STRING'}}
}};
const normalize=s=>s.normalize('NFC').replace(/\s+/g,' ').replace(/([\p{Script=Han}\d])\s+(?=[\p{Script=Han}\d])/gu,'$1').trim();
function evidence(items,record){
 if(!Array.isArray(items)||!items.length||items.length>5)throw Error('Conhecimento sem evidência válida.');
 const text=normalize(record.transcript??'');
 const caption=normalize(record.source_caption?.text??'');
 for(const e of items){
  if(e.source==='caption'){if(!record.source_caption?.capture_id||typeof e.excerpt!=='string'||!e.excerpt.trim()||e.excerpt.length>1200||!caption.includes(normalize(e.excerpt)))throw Error('Citação não consta na legenda capturada.');continue;}
  if(!['transcript','video'].includes(e.source)||typeof e.excerpt!=='string'||!e.excerpt.trim()||e.excerpt.length>1200||!Number.isFinite(e.start_seconds)||!Number.isFinite(e.end_seconds)||e.start_seconds<0||e.end_seconds<e.start_seconds||e.end_seconds>record.duration_seconds)throw Error('Evidência de conhecimento inválida.');
  if(e.source==='transcript'&&(!text||!text.includes(normalize(e.excerpt))))throw Error('Citação de conhecimento não consta na transcrição.');
 }
}
export function supportedCaptionNumbers(field){
 if(!['ingredient','quantity','preparation_time','serving_count','procedure'].includes(field.kind)||!field.evidence?.length||field.evidence.some(e=>e.source!=='caption'))return true;
 const numerals=text=>{const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,half:0.5,uno:1,una:1,due:2,tre:3,quattro:4,cinque:5,sei:6,sette:7,otto:8,nove:9,dieci:10,mezza:0.5,mezzo:0.5,um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,meia:0.5,meio:0.5};const normalized=String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/1\s*\/\s*2|½/g,'0.5').replace(/\b[a-z]+\b/g,w=>words[w]===undefined?w:String(words[w]));return (normalized.match(/\d+(?:[.,]\d+)?/g)??[]).map(n=>Number(n.replace(',','.')));};
 const known=numerals(field.evidence.map(e=>e.excerpt).join(' '));return numerals(field.value).every(n=>known.includes(n));
}
export function reviewKnowledge(value,record){
 if(!value||!contexts.includes(value.context)||!Array.isArray(value.keywords)||value.keywords.length>20||!Array.isArray(value.fields)||value.fields.length>40||!Array.isArray(value.missing_information)||value.missing_information.length>20||value.missing_information.some(s=>typeof s!=='string'||s.length>1000))throw Error('Estrutura de conhecimento inválida.');
 let omitted=0;
 const keep=(items,check)=>items.filter(item=>{try{check(item);evidence(item.evidence,record);return true;}catch{omitted++;return false;}});
 const keywords=keep(value.keywords,k=>{if(typeof k.term!=='string'||!k.term.trim()||k.term.length>100)throw Error('Palavra-chave inválida.');});
 const fields=keep(value.fields,f=>{if(!fieldKinds.includes(f.kind)||typeof f.name!=='string'||!f.name.trim()||f.name.length>160||typeof f.value!=='string'||!f.value.trim()||f.value.length>1600||!supportedCaptionNumbers(f))throw Error('Campo inválido.');});
 return {knowledge:{context:value.context,keywords,fields,missing_information:[...value.missing_information]},omitted};
}
export function searchKnowledge(video,query){
 const k=combinedKnowledge(video);if(!k)return false;
 const key=s=>String(s).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
 const terms=key(query).trim().split(/\s+/).filter(Boolean);
 const haystack=key([video.analysis.title,contextLabels[k.context],...k.keywords.map(v=>v.term),...k.fields.flatMap(f=>[f.name,f.value,fieldLabels[f.kind]])].join(' '));
 return terms.every(t=>haystack.includes(t));
}

export function reviewIdentity(video){const match=video.analysis_key?.match(/results\/instagram\/[A-Za-z0-9_-]+\/([^/]+)\/analysis\.json$/);return match?match[1]+(video.analysis_generation?'@'+video.analysis_generation:''):'Sem revisão registrada';}
export function combinedKnowledge(video){const k=video.analysis?.knowledge;if(!k)return null;const supplement=video.analysis?.source_coverage?.caption?null:video.knowledge_supplement;return {...k,fields:[...k.fields,...(supplement?.fields??[])],keywords:[...k.keywords,...(supplement?.keywords??[])],missing_information:[...k.missing_information]};}

export function audioTranscriptLabel(video){
 if(video.audio_status==='absent'||video.has_audio===false)return 'Não tem áudio.';
 const text=(video.transcript??'').trim();
 if(!text||/^\[?\s*(BACKGROUND|MUSIC|SILENCE|NO SPEECH)\s*\]?$/i.test(text))return video.transcript_status==='recognized'||video.transcript_status==='no_speech_recognized'||text?'Sem fala identificada.':'Ainda não transcrito.';
 return text;
}
export function keywordTag(term){const key=String(term).trim().toLocaleLowerCase('pt-BR');const aliases={'batate':'batata','patate':'batata','potatoes':'batata','salsa de pomodoro':'molho de tomate','salsa di pomodoro':'molho de tomate','tomato sauce':'molho de tomate','parsley':'salsinha','prezzemolo':'salsinha'};return '#'+(aliases[key]??key).replace(/^#+/,'').replace(/[^\p{L}\p{N}]+/gu,'_');}
export function knowledgeSummary(video){
 const knowledge=combinedKnowledge(video);if(!knowledge)return [];
 const groups=[...new Set(knowledge.fields.map(f=>f.kind))];
 return groups.map(kind=>({kind,label:fieldLabels[kind],items:knowledge.fields.filter(f=>f.kind===kind).sort((a,b)=>Number(b.evidence.some(e=>e.source==='caption'))-Number(a.evidence.some(e=>e.source==='caption'))).map(field=>({name:field.name,value:field.value,sources:[...new Set(field.evidence.map(e=>e.source))]}))}));
}
