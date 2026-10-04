import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewKnowledge,searchKnowledge} from '../lib/knowledge.mjs';
const record={transcript:'Use 200 gramas de frango.',duration_seconds:30};
const e={source:'transcript',start_seconds:1,end_seconds:4,excerpt:record.transcript};
const knowledge=()=>({context:'recipe',keywords:[{term:'frango',evidence:[e]}],fields:[{kind:'ingredient',name:'Frango',value:'200 gramas',evidence:[e]}],missing_information:['Rendimento não informado.']});
test('structured knowledge preserves supported fields and rejects invented quotations',()=>{
 const raw=knowledge();raw.fields.push({kind:'ingredient',name:'Sal',value:'1 colher',evidence:[{...e,excerpt:'Adicione uma colher de sal.'}]});const copy=structuredClone(raw);
 const result=reviewKnowledge(raw,record);assert.equal(result.omitted,1);assert.equal(result.knowledge.fields.length,1);assert.deepEqual(raw,copy);
 assert.ok(searchKnowledge({analysis:{title:'Receita',knowledge:result.knowledge}},'frango 200'));
 assert.ok(!searchKnowledge({analysis:{title:'Receita',knowledge:result.knowledge}},'sal'));
});
test('empty transcript accepts explicit video evidence but rejects transcript evidence',()=>{
 const raw=knowledge();raw.fields[0].evidence=[{...e,source:'video',excerpt:'A tela identifica 200 g de frango.'}];
 const result=reviewKnowledge(raw,{...record,transcript:''});assert.equal(result.knowledge.keywords.length,0);assert.equal(result.knowledge.fields.length,1);
});
test('out-of-range evidence and oversized structures fail safely',()=>{
 const raw=knowledge();raw.fields[0].evidence=[{...e,end_seconds:31}];assert.equal(reviewKnowledge(raw,record).knowledge.fields.length,0);
 assert.throws(()=>reviewKnowledge({...raw,context:'invented'},record));
 assert.throws(()=>reviewKnowledge({...raw,keywords:Array(21).fill(raw.keywords[0])},record));
});

 test('caption supplement is searchable without changing original model fields',async()=>{const {combinedKnowledge,reviewIdentity}=await import('../lib/knowledge.mjs');const v={id:'example',analysis_key:'results/instagram/example/run-123/analysis.json',analysis_generation:'7',analysis:{title:'Receita',knowledge:{context:'recipe',fields:[],keywords:[],missing_information:[]}},knowledge_supplement:{fields:[{name:'Queijo',value:'200 g Emmental',kind:'ingredient',evidence:[{source:'caption',excerpt:'200 g Emmental cheese'}]}],keywords:[]}};assert.equal(combinedKnowledge(v).fields.length,1);assert.equal(v.analysis.knowledge.fields.length,0);assert.equal(searchKnowledge(v,'Emmental'),true);assert.equal(reviewIdentity(v),'run-123@7');});
