const seconds=value=>{if(typeof value!=='string'||!/^\d+(?:\.\d{1,9})?s$/.test(value))return null;const n=Number(value.slice(0,-1));return Number.isFinite(n)&&n>=0?n:null;};
const tokens=value=>String(value).normalize('NFKC').toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]+/gu)??[];
// Only provider word offsets are accepted. No timing is inferred from the text.
export function speechWordEvidence(transcript){
 const words=(transcript?.results??[]).flatMap(r=>r.alternatives?.[0]?.words??[]);if(!words.length||words.length>20000)return [];
 let previous=-1;const out=[];
 for(const w of words){const start=seconds(w.startOffset??w.startTime),end=seconds(w.endOffset??w.endTime);
  if(typeof w.word!=='string'||!w.word.trim()||w.word.length>256||start===null||end===null||end<=start||start<previous)return [];
  previous=start;out.push({word:w.word,start_seconds:start,end_seconds:end});
 }return out;
}
export function evidenceWindow(raw,proof){
 if(typeof proof?.excerpt!=='string'||!raw?.transcript?.includes(proof.excerpt)||!Number.isFinite(proof.start_seconds)||!Number.isFinite(proof.end_seconds)||proof.end_seconds<=proof.start_seconds||!Array.isArray(raw.transcript_words)||!raw.transcript_words.length||raw.transcript_words.length>20000)return false;
 const needle=tokens(proof.excerpt);if(!needle.length)return false;
 const words=[];let previous=-1;
 for(const w of raw.transcript_words){if(typeof w?.word!=='string'||!Number.isFinite(w.start_seconds)||!Number.isFinite(w.end_seconds)||w.start_seconds<0||w.end_seconds<=w.start_seconds||w.start_seconds<previous||w.end_seconds>raw.duration_seconds)return false;previous=w.start_seconds;for(const value of tokens(w.word))words.push({value,start:w.start_seconds,end:w.end_seconds});}
 for(let i=0;i+needle.length<=words.length;i++){
  if(needle.every((value,j)=>words[i+j].value===value)&&words[i].start>=proof.start_seconds-0.5&&words[i+needle.length-1].end<=proof.end_seconds+0.5)return true;
 }return false;
}
