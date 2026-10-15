import test from 'node:test';import assert from 'node:assert/strict';
import {processingIndicator} from '../lib/processing-indicator.mjs';
import {attentionFixtures,missingKnowledgeFixtures} from '../qa/attention-fixtures.mjs';
import {loadLibrarySnapshot} from '../lib/library-sync.mjs';
const job=(stage,status,reason_code)=>({stage,status,reason_code});

test('inventoried262 reconcile207 published analyses and61 unique attention items including6 accepted empty extractions',async()=>{
 const f=attentionFixtures(),p=new Map(f.items.map(x=>[x.id,x]));let page=0;
 const rows=await loadLibrarySnapshot(async()=>++page===1?{videos:[...f.videos.slice(0,200),f.videos[0]],next_cursor:'last'}:{videos:f.videos.slice(200),next_cursor:null});
 assert.equal(rows.length,262);assert.equal(rows.filter(v=>v.analysis).length,207);
 const attention=rows.filter(v=>processingIndicator(v,p.get(v.id)).attention);assert.equal(attention.length,61);assert.equal(new Set(attention.map(v=>v.id)).size,61);
 const counts={};for(const v of attention){const i=processingIndicator(v,p.get(v.id));counts[i.code]=(counts[i.code]??0)+1;assert.equal(i.retry_available,false);}
 assert.deepEqual(counts,{knowledge_review:6,source_metadata_failed:51,schema_rejected:2,analysis_unconfirmed:1,candidate:1});
 assert.equal(attention.filter(v=>processingIndicator(v,p.get(v.id)).stage==='upload').length,51);
 assert.equal(attention.filter(v=>processingIndicator(v,p.get(v.id)).stage==='analysis').length,10);
});

for(const stage of ['upload','transcription','analysis'])test(`${stage} active or reserved never offers retry or falsely proves end`,()=>{
 for(const status of ['started','reserved']){
  const result=processingIndicator({status:'pending'},job(stage,status),{paused:true});assert.equal(result.stage,stage);assert.equal(result.retry_available,false);assert.match(result.action,/Aguardar/);assert.match(result.unknown,/encerramento.*não foi conferido/);
 }
 const blocked=processingIndicator({status:'needs_attention'},job(stage,'reserved'));assert.equal(blocked.code,'blocked_unsubmitted');assert.match(blocked.reason,/submissão não está confirmada/);assert.match(blocked.action,/não reenviar/);
});

test('source failure is a safe known category, never a private/deleted verdict',()=>{
 for(const error of ['Private reel','Deleted','https://signed?token=SECRET',null]){
  const v={status:'needs_attention',error};const out=processingIndicator(v,job('upload','completed','source_metadata_failed'));
  assert.equal(out.code,'source_metadata_failed');assert.match(out.unknown,/não comprova.*privado.*excluído/);assert.match(out.action,/manter bloqueado/);assert.ok(!JSON.stringify(out).includes('SECRET'));
 }
 const out=processingIndicator({status:'needs_attention',media_verified:false});assert.equal(out.code,'acquisition_unconfirmed');assert.match(out.unknown,/causa exata.*não estão confirmados/);
});

test('saved response reference permits only checking before reconciliation, never new inference',()=>{
 const v={status:'needs_attention',media_verified:true,transcript:'Preservada',analysis_key:'results/instagram/Reel_1/job_saved/analysis.json'};
 const out=processingIndicator(v,job('analysis','completed'));assert.equal(out.code,'saved_response');assert.match(out.action,/comprovar o encerramento antes de reconciliar, sem nova inferência/);assert.match(out.unknown,/existência e o conteúdo.*conferência/);assert.equal(out.retry_available,false);
 const active=processingIndicator(v,job('analysis','started'));assert.equal(active.code,'active');assert.match(active.action,/Aguardar/);
});

test('candidate preserves published knowledge and accepted empty/malformed structure never requests paid reanalysis',()=>{
 const f=attentionFixtures(),published=f.videos[6],before=structuredClone(published);
 assert.equal(processingIndicator(published).code,'accepted');assert.equal(processingIndicator(published).attention,false);
 for(const fields of [[],null,{},[null],[{name:"Invalid"}]]){const v=structuredClone(published);v.analysis.knowledge.fields=fields;const out=processingIndicator(v);assert.equal(out.code,'knowledge_review');assert.equal(out.attention,true);assert.match(out.action,/não solicitar nova análise paga/);assert.ok(v.analysis);}
 const candidate={...published,analysis_candidate:{summary:'Novo candidato'}};const saved=structuredClone(candidate);assert.equal(processingIndicator(candidate).code,'candidate');assert.match(processingIndicator(candidate).action,/preservar a análise publicada/);assert.deepEqual(candidate,saved);assert.deepEqual(published,before);
});

test('uncertain transcription, analysis and stale progress show safe unknowns',()=>{
 assert.equal(processingIndicator({status:'needs_attention',media_verified:true},job('transcription','uncertain')).code,'transcription_unconfirmed');
 assert.equal(processingIndicator({status:'needs_attention',media_verified:true,transcript:'Texto'},job('analysis','uncertain')).code,'analysis_unconfirmed');
 const published=attentionFixtures().videos[6];assert.equal(processingIndicator(published,job('analysis','started'),{stale:true}).code,'accepted');
 const next=processingIndicator({status:'downloaded',media_verified:true},job('analysis','started'),{stale:true});assert.equal(next.stage,'transcription');assert.match(next.unknown,/desatualizados/);
});

test('financial completion alone never implies published analysis or worker end',()=>{
 const out=processingIndicator({status:'transcribed',media_verified:true,transcript:'Texto'},job('analysis','completed'));assert.equal(out.code,'analysis_unconfirmed');assert.match(out.reason,/financeiro.*não há análise publicada/);assert.match(out.unknown,/não comprova o término/);
});

test('arbitrary diagnostics and unknown reason codes cannot enter fixed presentation',()=>{
 const out=processingIndicator({status:'needs_attention',error:'SECRET signed-url',provider_diagnostic:'TOKEN'},job('upload','uncertain','SECRET'));assert.ok(!JSON.stringify(out).includes('SECRET'));assert.ok(!JSON.stringify(out).includes('TOKEN'));
 assert.equal(processingIndicator({status:'pending'},job('__proto__','started')).code,'queued');
});

for(const [name,value,remove]of [['null',null],['false',false],['empty string',''],['missing',undefined,true],['undefined',undefined],['zero',0],['number',42],['string','invalid'],['array',[]],['object',{}]])test(`published whole knowledge ${name} is included for review without changing its report`,()=>{
 const v=structuredClone(attentionFixtures().videos[6]);if(remove)delete v.analysis.knowledge;else v.analysis.knowledge=value;const before=structuredClone(v);
 const i=processingIndicator(v,job('analysis','completed'));assert.equal(i.code,'knowledge_review');assert.equal(i.attention,true);assert.equal(i.stage,'analysis');assert.match(i.reason,/estrutura de conhecimento.*incompleta/);assert.match(i.action,/não solicitar nova análise paga/);assert.equal(i.retry_available,false);assert.deepEqual(v,before);
});

test('reported missing-whole-block variants all reconcile while their published reports remain available',()=>{
 const f=missingKnowledgeFixtures(),before=structuredClone(f),p=new Map(f.items.map(i=>[i.id,i]));
 assert.equal(f.videos.filter(v=>v.analysis).length,4);assert.equal(f.videos.filter(v=>processingIndicator(v,p.get(v.id)).attention).length,4);
 assert.ok(f.videos.every(v=>processingIndicator(v,p.get(v.id)).code==='knowledge_review'));assert.deepEqual(f,before);
});

test('missing whole knowledge does not change active/reserved/candidate priority or unpublished classification',()=>{
 const v=missingKnowledgeFixtures().videos[0];
 for(const status of ['started','reserved']){const i=processingIndicator(v,job('analysis',status));assert.equal(i.code,status==='started'?'active':'reserved');assert.equal(i.attention,true);assert.match(i.action,/Aguardar/);assert.equal(i.retry_available,false);}
 const candidate=processingIndicator({...v,analysis_candidate:{summary:'Retido'}});assert.equal(candidate.code,'candidate');assert.match(candidate.action,/preservar a análise publicada/);
 assert.equal(processingIndicator({status:'pending',analysis:null}).code,'queued');assert.equal(processingIndicator({status:'pending',analysis:null}).attention,false);
 const valid=attentionFixtures().videos[6];assert.equal(processingIndicator(valid).code,'accepted');assert.equal(processingIndicator(valid).attention,false);
});
