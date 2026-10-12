// A bounded lexical guard, not semantic verification. Unsupported number words,
// unit spellings and conversions are not inferred. Literal evidence is checked
// separately by reviewKnowledge before a field can be published.
const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,half:0.5,uno:1,una:1,due:2,tre:3,quattro:4,cinque:5,sei:6,sette:7,otto:8,nove:9,dieci:10,mezza:0.5,mezzo:0.5,um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,meia:0.5,meio:0.5};
const unitGroups={
 g:['g','gram','grams','grama','gramas','grammi'],
 kg:['kg','kilogram','kilograms','quilograma','quilogramas'],
 ml:['ml','milliliter','milliliters','mililitro','mililitros'],
 l:['l','liter','liters','litro','litros'],
 tablespoon:['tablespoon','tablespoons','tbsp','colher de sopa','colheres de sopa','col. de sopa','cucchiaio','cucchiai','ст.л','ст.л.'],
 teaspoon:['teaspoon','teaspoons','tsp','colher de cha','colheres de cha','col. de cha','cucchiaino','cucchiaini'],
 spoonful:['spoonful','spoonfuls','colherada','colheradas','colher','colheres'],
 cup:['cup','cups','xicara','xicaras','xic','xic.','tazza','tazze'],
 minute:['minute','minutes','minuto','minutos','minuti','min','минут','минуты','минута'],
 second:['second','seconds','segundo','segundos','secondi','sec'],
 hour:['hour','hours','hora','horas','ore'],
 celsius:['°c','celsius'],fahrenheit:['°f','fahrenheit']
};
const units=new Map(Object.entries(unitGroups).flatMap(([unit,aliases])=>aliases.map(alias=>[alias,unit])));
const escapePattern=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const unitPattern=[...units.keys()].sort((a,b)=>b.length-a.length).map(escapePattern).join('|');
const numberPattern='\\d+(?:[.,]\\d+)?';
const unitEnd='(?![\\p{L}])';
function quantities(text,procedure){
 let invalid=false;
 let normalized=String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 // List markers are not quantities and cannot justify "one minute".
 if(procedure)normalized=normalized.replace(/^\s*\d+[.)]\s+/gm,'');
 // Ignore only locative articles before a closed set of cooking containers.
 // "um minuto", "uma colher" and every digit still require numeric support.
 if(procedure)normalized=normalized.replace(/\b(para|em|sobre|dentro de)\s+(?:um|uma)\s+(?=(?:recipiente|tigela|frigideira|travessa|panela|refratario)\b)/g,'$1 ');
 normalized=normalized.replace(/([¼½¾])/g,(_,v)=>' '+({'¼':'1/4','½':'1/2','¾':'3/4'}[v]));
 normalized=normalized.replace(/(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)/g,(_,whole,numerator,denominator)=>{
  if(Number(denominator)===0){invalid=true;return '';}
  return String(Number(whole??0)+Number(numerator)/Number(denominator));
 });
 normalized=normalized.replace(/\b[a-z]+\b/g,w=>words[w]===undefined?w:String(words[w])).replace(/\s+/g,' ');
 // "half a cup" is one fractional measure, not half plus an extra one.
 normalized=normalized.replace(new RegExp('('+numberPattern+')\\s+(?:a|an)\\s+(?=(?:'+unitPattern+')'+unitEnd+')','gu'),'$1 ');
 normalized=normalized.replace(new RegExp('\\b(?:a|an)\\s+(?=(?:'+unitPattern+')'+unitEnd+')','gu'),'1 ');
 const numbers=(normalized.match(new RegExp(numberPattern,'g'))??[]).map(n=>Number(n.replace(',','.')));
 const measures=[...normalized.matchAll(new RegExp('('+numberPattern+')\\s*('+unitPattern+')'+unitEnd,'gu'))]
  .map(m=>({number:Number(m[1].replace(',','.')),unit:units.get(m[2])}));
 return {invalid,numbers,measures};
}
export function supportedCaptionNumbers(field){
 if(!['ingredient','quantity','preparation_time','serving_count','procedure'].includes(field.kind)||!field.evidence?.length||field.evidence.some(e=>e.source!=='caption'))return true;
 const procedure=field.kind==='procedure';
 // Parse excerpts separately: fragments cannot create a new measure at a join.
 const sources=field.evidence.map(e=>quantities(e.excerpt,procedure));
 const value=quantities(field.value,procedure);
 if(value.invalid||sources.some(s=>s.invalid))return false;
 const known=sources.flatMap(s=>s.numbers),measures=sources.flatMap(s=>s.measures);
 return value.numbers.every(n=>known.includes(n))&&value.measures.every(m=>measures.some(s=>s.number===m.number&&s.unit===m.unit));
}
