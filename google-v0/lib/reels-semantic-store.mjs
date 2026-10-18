import {isDeepStrictEqual} from 'node:util';
import {encodeFields} from './firestore.mjs';
const allowedWrite=p=>/^reels_index\/semantic_[A-Za-z0-9_-]{1,110}$/.test(p);
const allowedRead=p=>allowedWrite(p)||/^(?:videos|reels_legacy_content)\/[A-Za-z0-9_-]{5,32}$/.test(p)||/^reels_index\/contextual_review_[A-Za-z0-9_-]{5,32}$/.test(p)||/^reels_quality_receipts\/quality_[a-f0-9]{64}$/.test(p)||['settings/reels_v2_taxonomy','settings/reels_v2_semantic_policy','settings/reels_v2_contextual_catalogue'].includes(p);
export async function commitSemanticStore(store,{checks,writes}){
 if(!Array.isArray(checks)||!checks.length||checks.length>1024||!Array.isArray(writes)||!writes.length||writes.length>160)throw Error('Transação semântica fora do limite.');
 const expected=new Map();for(const c of checks){if(!allowedRead(c.path)||expected.has(c.path)||c.updateTime!==null&&(typeof c.updateTime!=='string'||!c.updateTime||c.updateTime.length>100))throw Error('Precondição semântica inválida.');expected.set(c.path,c.updateTime);}
 const targets=new Set();for(const w of writes){if(!allowedWrite(w.path)||targets.has(w.path)||!expected.has(w.path)||!w.data?.kind?.startsWith('semantic_')||JSON.stringify(w.data).length>800000)throw Error('Escrita fora dos derivados semânticos.');encodeFields(w.data);targets.add(w.path);}
 const prefix='projects/'+store.api.project+'/databases/(default)/documents/',begin=await store.api.request(store.root+':beginTransaction',{method:'POST',json:{options:{readWrite:{}}}}),transaction=begin?.transaction;
 if(typeof transaction!=='string'||!transaction)throw Error('Transação semântica não confirmada.');
 let closed=false;const rollback=async()=>{try{await store.api.request(store.root+':rollback',{method:'POST',json:{transaction}});}catch{}};
 try{
  const rows=await store.api.request(store.root+':batchGet',{method:'POST',json:{documents:[...expected.keys()].map(p=>prefix+p),mask:{fieldPaths:['id']},transaction}});
  if(!Array.isArray(rows))throw Error('Leitura semântica incompleta.');
  const observed=new Map();for(const r of rows){const name=r.found?.name??r.missing;if(typeof name!=='string'||!name.startsWith(prefix)||r.found&&r.missing)throw Error('Resposta semântica externa.');const path=name.slice(prefix.length);if(!expected.has(path)||observed.has(path)||r.found&&typeof r.found.updateTime!=='string')throw Error('Leitura semântica inconsistente.');observed.set(path,r.found?r.found.updateTime:null);}
  if(observed.size!==expected.size)throw Error('Precondições semânticas incompletas.');
  if([...expected].some(([p,t])=>observed.get(p)!==t)){await rollback();closed=true;return {applied:false,reason:'SEMANTIC_VERSION_CHANGED'};}
  const body={transaction,writes:writes.map(w=>({update:{name:prefix+w.path,fields:encodeFields(w.data)},currentDocument:expected.get(w.path)===null?{exists:false}:{updateTime:expected.get(w.path)}}))};
  let receipt;try{receipt=await store.metadataWrite(store.root+':commit',{method:'POST',json:body});if(receipt?.writeResults?.length!==writes.length||receipt.writeResults.some(r=>typeof r.updateTime!=='string'))throw Error('Recibo semântico incompleto.');}
  catch(cause){const after=await Promise.all(writes.map(w=>store.get(w.path)));if(after.every((s,i)=>s&&isDeepStrictEqual(s.data,writes[i].data))){closed=true;return {applied:true,reconciled:true};}throw Object.assign(Error('Commit semântico sem confirmação; consultar sem repetir inferência.'),{requiresReconciliation:true,cause});}
  closed=true;return {applied:true,writeResults:receipt.writeResults};
 }finally{if(!closed)await rollback();}
}
