import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisOutcome} from '../lib/analysis.mjs';
import {prepareSavedPublicationRepairs} from '../scripts/reconsolidate-saved-analysis.mjs';
import {reelDetail} from '../lib/reels-model.mjs';
const quote=(source,excerpt)=>({source,excerpt,start_seconds:0,end_seconds:10});
const field=(name,value,excerpt,source='transcript',kind='ingredient')=>({kind,name,value,evidence:[quote(source,excerpt)]});
const report=fields=>({title:'Receita inventada',summary:'Quantidades ausentes.',categories:['receitas'],useful_information:[],visual_observations:[],limitations:['Não informa maçã nem limão.'],transcript_quality:{assessment:'Áudio errado, corrigido pelo modelo.',uncertain_segments:[]},knowledge:{context:'recipe',keywords:[],fields,missing_information:['Quantidade de maçã não informada.']}});
const response=report=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}]});
const review=(candidate,record)=>analysisOutcome(response(candidate),record,{requireKnowledge:true,sourceGroundedPublication:true});
test('literal guard rejects joined recipe quotes while complete attributed sources retain assembly, bake and measures',()=>{
 const caption='Ingredients:\n250 g starch\nCooking process:\n- Add potatoes.\n- Cover with foil and bake for an hour.\n- Remove foil and bake until golden brown.';
 const record={id:'Recipe01',duration_seconds:60,transcript:'Música de fundo.',source_caption:{text:caption,capture_id:'capture-1'}};
 const raw=report([field('Polvilho','250 g','250 g starch','caption'),field('Montar e assar','Add potatoes. Cover with foil and bake for an hour.','Add potatoes. Cover with foil and bake for an hour.','caption','procedure'),field('Inventado','999 g','999 g starch','caption')]);const before=structuredClone(raw);
 const result=review(raw,record);assert.equal(result.accepted,true);assert.equal(result.report.knowledge.fields.length,1);
 assert.equal(result.report.source_consolidation.sources[0].text,caption);assert.match(result.report.source_consolidation.sources[0].text,/bake until golden brown/);
 assert.equal(result.report.knowledge.fields.some(f=>f.value.includes('999')),false);assert.deepEqual(raw,before);
 assert.equal(result.report.source_consolidation.sources[1].text,record.transcript);
 const recovered=result.report.source_consolidation.recipe_fields;assert.ok(recovered.some(f=>f.kind==='procedure'&&f.value.includes('bake for an hour')));assert.ok(recovered.some(f=>f.value.includes('golden brown')));assert.ok(recovered.every(f=>caption.includes(f.evidence[0].excerpt)));assert.ok(!recovered.some(f=>f.value.includes('Música')));
});
test('apple and lemon source quantities survive without publishing contradictory candidate gaps',()=>{
 const record={duration_seconds:60,transcript:'Vai colocar uma maçã com a casca. Vai colocar meio limão espremido.'};
 const raw=report([field('Maçã','uma maçã','uma maçã com a casca'),field('Limão','meio limão','meio limão espremido')]);
 const result=review(raw,record).report;assert.equal(result.knowledge.fields.length,2);assert.deepEqual(result.knowledge.missing_information,[]);
 assert.ok(!result.limitations.some(x=>x.includes('Não informa')));assert.equal(result.title,raw.title);assert.ok(!result.summary.includes('ausentes'));
 assert.equal(result.publication_review.candidate.missing_information[0],raw.knowledge.missing_information[0]);
});
test('unsupported product identity cannot leak through title summary or invented STT correction',()=>{
 const raw=report([field('Modelo','BV9300','Blackview BV9300'),field('Bateria','15080 mAh','15080 mAh')]);raw.title='Review BV9300';raw.summary='BV9300 com 15080 mAh';raw.knowledge.keywords=[{term:'BV9300',evidence:[quote('transcript','O novo Blackview BV9900')]}];raw.useful_information=[{claim:'O BV9300 é resistente.',application:'Conhecer o BV9300.',classification:'author_claim',evidence:[quote('transcript','O novo Blackview BV9900')]}];raw.knowledge.context='technology';raw.categories=['hardware-setup'];
 const result=review(raw,{duration_seconds:60,transcript:'O novo Blackview BV9900 tem uma bateria de 15.000 mAh.'}).report;
 for(const value of [result.title,result.summary,JSON.stringify(result.transcript_quality)])assert.doesNotMatch(value,/BV9300|15080|Áudio errado/);
 assert.match(result.source_consolidation.sources[0].text,/BV9900/);assert.equal(result.publication_review.candidate.title,raw.title);assert.equal(result.knowledge.fields.length,0);assert.equal(result.knowledge.keywords.length,0);assert.equal(result.useful_information.length,0);const publicView=reelDetail({id:'Device01',title:'BV9300',analysis_key:'raw',analysis_generation:'1',analysis_quality_status:'accepted',analysis:result});assert.doesNotMatch(JSON.stringify(publicView),/BV9300|15080|Áudio errado/);
});
test('no literal recovery, absent captures, and hostile HTML never become synthetic supporting evidence',()=>{
 const raw=report([field('Forno','999 graus','Forno 999 graus')]);
 const record={duration_seconds:20,transcript:'<img src=x onerror=alert(1)>',source_caption:{text:'Forno 999 graus'}};
 const out=review(raw,record).report;assert.equal(out.knowledge.fields.length,0);assert.equal(out.source_consolidation.sources.length,1);assert.equal(out.source_consolidation.sources[0].text,record.transcript);
 const old=analysisOutcome(response(raw),record,{requireKnowledge:true});assert.equal(old.report.source_consolidation,undefined);
});
test('repair uses the same publication function and binds original generation/version without changing execution proof',()=>{
 const id='Recipe01',key=`results/instagram/${id}/${'a'.repeat(64)}/analysis.json`,raw=report([field('Limão','meio limão','meio limão espremido')]);
 const video={id,status:'completed',analysis_quality_status:'accepted',duration_seconds:30,transcript:'Vai colocar meio limão espremido.',analysis:{...raw,knowledge:{...raw.knowledge,reviewerConfidence:0.61},privateSibling:'preserved'},analysis_key:key,analysis_generation:'123',reels_v2:{operationId:'original'},resultEvidence:{resultHash:'unchanged'}};
 const snapshot={rows:{[id]:{version:'original-version',video,objectMetadata:{bucket:'megabrain-v0-1017370021431-media',name:key,generation:'123'},savedAnalysis:{response:response(raw)}}}};const before=structuredClone(snapshot),opts={ids:[id],sourceSHA256:'b'.repeat(64)};
 const plan=prepareSavedPublicationRepairs(snapshot,opts),row=plan.rows[0];assert.deepEqual(snapshot,before);assert.equal(row.expectedUpdateTime,'original-version');assert.equal(row.overlay.raw.generation,'123');assert.equal(row.changes['analysis.knowledge.fields']?.length??row.afterAnalysis.knowledge.fields.length,1);assert.equal(row.updateMask.some(k=>/reels_v2|execution|ledger|analysis_key|analysis_generation/.test(k)),false);
 assert.equal(row.afterAnalysis.knowledge.reviewerConfidence,0.61);assert.equal(row.afterAnalysis.privateSibling,'preserved');assert.deepEqual(row.afterAnalysis.knowledge.fields,review(raw,video).report.knowledge.fields);assert.deepEqual(row.afterAnalysis.source_consolidation,review(raw,video).report.source_consolidation);assert.equal(plan.approved,false);
 const projected=reelDetail({...video,analysis:row.afterAnalysis});assert.equal(projected.analysis.sourceConsolidation.sources[0].text,video.transcript);
 assert.throws(()=>prepareSavedPublicationRepairs(snapshot,{...opts,ids:['Other001']}));assert.throws(()=>prepareSavedPublicationRepairs({...snapshot,rows:{[id]:{...snapshot.rows[id],video:{...video,duration_seconds:undefined}}}},opts));
 assert.throws(()=>prepareSavedPublicationRepairs({...snapshot,rows:{[id]:{...snapshot.rows[id],objectMetadata:{...snapshot.rows[id].objectMetadata,generation:'999'}}}},opts));
});

test('unstructured recipe transcript recovers omitted starch, heat and cook-with-water as literal source cards',()=>{
 const transcript='Use 250 g de polvilho doce. Ligue por 10 minutos a 180°. Adicione água acima da altura do arroz. Tampe e cozinhe.';
 const raw=report([field('Polvilho','250 g','Use 250g de polvilho doce.')]);const out=review(raw,{duration_seconds:40,transcript}).report;
 const cards=out.source_consolidation.recipe_fields;assert.equal(cards.length,1);assert.ok(cards.some(f=>f.value.includes('250 g')));assert.ok(cards.some(f=>f.value.includes('10 minutos a 180°')));assert.ok(cards.some(f=>f.value.includes('água acima')));assert.ok(cards.every(f=>transcript.includes(f.value)&&f.value===f.evidence[0].excerpt));
 assert.equal(out.knowledge.fields.length,0);assert.equal(out.publication_review.inference_replayed,false);
});

test('ingredients-only caption does not suppress the missing cook-with-water transcript procedure',()=>{
 const raw=report([field('Água','cozinhar com água','Adicione água e tampe. Depois cozinhe.')]);
 const transcript='Adicione água acima da altura do arroz. Tampe a panela e cozinhe.';
 const out=review(raw,{duration_seconds:30,transcript,source_caption:{text:'Ingredientes:\n1 xícara de arroz',capture_id:'capture-rice'}}).report;
 const cards=out.source_consolidation.recipe_fields;assert.ok(cards.some(f=>f.kind==='ingredient'&&f.value==='1 xícara de arroz'));assert.ok(cards.some(f=>f.value===transcript));assert.ok(cards.every(f=>f.evidence[0].start_seconds===undefined));
});
test('valid product narrative remains when its actual supported field survives the guard',()=>{
 const raw=report([field('Modelo','Blackview BV9900','O novo Blackview BV9900','transcript','product')]);raw.title='Review do Blackview BV9900';raw.summary='O autor apresenta o Blackview BV9900.';raw.knowledge.context='technology';raw.categories=['hardware-setup'];
 const out=review(raw,{duration_seconds:30,transcript:'O novo Blackview BV9900 é apresentado pelo autor.'}).report;assert.equal(out.title,raw.title);assert.equal(out.summary,raw.summary);assert.equal(out.knowledge.fields.length,1);
});
