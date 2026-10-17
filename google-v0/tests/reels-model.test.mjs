import test from 'node:test';import assert from 'node:assert/strict';
import {projectReel,reelDetail,reelStatus,categoryNavigation,initialReelsTaxonomy,reelsCategoryGroups}from '../lib/reels-model.mjs';
import {categoryDefinitions} from '../lib/category-taxonomy.mjs';
const published={id:'Reel_001',status:'analyzed',analysis_key:'published',analysis_generation:'7',analysis_quality_status:'accepted',analysis:{title:'Sopa',summary:'Receita',categories:['food'],knowledge:{context:'recipe',fields:[],keywords:[],missing_information:['quantidade']}}};
test('published result is distinct from candidate, unknown fields remain null',()=>{const v={...published,analysis_quality_status:'review_required',analysis_candidate:{title:'Rejected'},candidate_analysis_key:'candidate'};const d=reelDetail(v);assert.equal(d.title,'Sopa');assert.equal(d.candidate.available,true);assert.equal(d.analysis.publishedAt,null);assert.deepEqual(d.analysis.knowledge.missingInformation,['quantidade']);assert.equal(projectReel({...v,analysis_key:null}).publication.available,false);});
test('caption distinguishes missing, explicit empty and present from transcript',()=>{assert.equal(reelDetail(published).caption.state,'missing');assert.equal(reelDetail({...published,source_caption:{text:''}}).caption.state,'empty');const d=reelDetail({...published,source_caption:{text:'Legenda'},transcript:'Fala'});assert.equal(d.caption.text,'Legenda');assert.equal(d.transcript.text,'Fala');});
test('uncertain and unknown legacy statuses never become confirmed failure or success',()=>{for(const status of ['needs_attention','unknown','reconciliation_failed'])assert.equal(reelStatus({status}),'uncertain');assert.equal(reelStatus({status:'needs_attention',failure_confirmed:true}),'failed');assert.equal(reelStatus({status:'pending',reels_v2:{status:'waiting'}}),'waiting');assert.equal(projectReel({...published,reels_v2:{status:'queued',stage:'transcription'}}).stage,'transcription');});
test('categories exclude unpublished candidates and deduplicate final IDs',()=>{assert.deepEqual(projectReel({id:'Reel_002',analysis_candidate:{categories:['food']},categoryIds:['food']}).categoryIds,[]);assert.deepEqual(projectReel({...published,categoryIds:['food','food']}).categoryIds,['food']);});

test('provider diagnostics cannot expose credentials in public error messages',()=>{for(const message of ['{"token":"secret"}','Authorization: Basic secret','HTTPS://host.test/private?api_key=secret','Bearer secret']){const item=projectReel({id:'Reel_002',status:'failed',error:{message}});assert.equal(item.error.message,'Falha confirmada; confira a ação disponível.');assert.equal(JSON.stringify(item).includes('secret'),false);}});
test('primitive or malformed publication bodies do not enter the final acervo',()=>{for(const analysis of [true,'text',[],null])assert.equal(projectReel({...published,analysis}).publication.available,false);});
test('rejected candidate state is independent of preserved publication quality',()=>{const d=reelDetail({...published,analysis_candidate:{summary:'reject'},reels_v2:{candidate:{state:'invalid',reason:'QUALITY_VALIDATION_FAILED'}}});assert.equal(d.candidate.state,'invalid');assert.equal(d.publication.available,true);assert.equal(d.analysis.summary,'Receita');});

test('approved contextual navigation unifies aliases without inventing per-Reel categories or losing raw labels',()=>{
 const raw={...published,analysis:{...published.analysis,categories:['Receitas','Culinária','Tema sem destino'],references:[{name:'Referência preservada'}]}},before=structuredClone(raw);
 const item=projectReel(raw),result=categoryNavigation([item]);
 assert.deepEqual(result.items[0].categoryIds,['receitas']);assert.deepEqual(result.items[0].categorySourceIds,raw.analysis.categories);
 assert.deepEqual(result.items[0].categoryResolution.unresolved,['Tema sem destino']);
 assert.deepEqual(result.taxonomy.nodes.map(n=>[n.id,n.parentId]),[['group-alimentacao',null],['receitas','group-alimentacao']]);
 assert.deepEqual(raw,before);assert.deepEqual(item.categoryIds,raw.analysis.categories);
});
test('all approved destinations fit in seven contextual roots and a single primary route per automatic source',()=>{
 const items=categoryDefinitions.map((d,n)=>projectReel({...published,id:'Reel_'+n,categoryIds:[d.id]})),result=categoryNavigation(items),roots=result.taxonomy.nodes.filter(n=>n.parentId===null);
 assert.equal(roots.length,7);assert.deepEqual(roots.map(n=>n.name),reelsCategoryGroups.map(n=>n.name));
 assert.ok(result.items.every(i=>i.categoryIds.length===1));assert.equal(result.taxonomy.nodes.length,7+categoryDefinitions.length);
 const mixed=categoryNavigation([projectReel({...published,categoryIds:['Tecnologia','Programação','Marketing','Rótulo desconhecido']})]);
 assert.deepEqual(mixed.items[0].categoryIds,['desenvolvimento-software']);assert.equal(mixed.taxonomy.nodes.some(n=>n.id==='a-organizar'),false);
});
test('unresolved source goes to Outros temas without inferring a recipe from title, keywords or references',()=>{
 const item=projectReel({...published,title:'Receita de frango',categoryIds:['Tema não coberto'],tags:['receita'],analysis:{...published.analysis,knowledge:{context:'recipe'},references:[{name:'Frango'}]}}),result=categoryNavigation([item]);
 assert.deepEqual(result.items[0].categoryIds,['a-organizar']);assert.equal(result.taxonomy.nodes.find(n=>n.id==='a-organizar').parentId,'group-outros');
 assert.deepEqual(result.items[0].categoryResolution.unresolved,['Tema não coberto']);
 assert.deepEqual(initialReelsTaxonomy([projectReel({...published,analysis_key:null})]).nodes,[]);
});
test('legacy flat read projection is pure but a manual tree, assignments and rules are preserved for reconciliation',()=>{
 const items=[projectReel({...published,categoryIds:['Receitas','Culinária']})],flat={revision:0,nodes:[{id:'Receitas',name:'Receitas',parentId:null,manual:false},{id:'Culinária',name:'Culinária',parentId:null,manual:false}],assignments:[],rules:[],appliedCommands:[]},before=structuredClone(flat);
 const contextual=categoryNavigation(items,flat);assert.equal(contextual.taxonomy.compatibility.mode,'official-contexts');assert.equal(contextual.taxonomy.nodes.length,2);assert.deepEqual(flat,before);
 const managed={revision:4,nodes:[{id:'manual-custom',name:'Meu recorte',parentId:null,manual:true}],assignments:[{reelId:published.id,categoryIds:['manual-custom'],manual:true}],rules:[{id:'retained-rule',enabled:false}],appliedCommands:[{id:'old-command'}]},copy=structuredClone(managed),result=categoryNavigation(items,managed);
 assert.deepEqual(result.items[0].categoryIds,['manual-custom']);assert.deepEqual(result.taxonomy.nodes,managed.nodes);assert.deepEqual(result.taxonomy.rules,managed.rules);
 assert.equal(result.taxonomy.compatibility.requiresCopyReconciliation,true);assert.deepEqual(managed,copy);
});
test('manual per-Reel override survives even if its destination is missing; gap is explicit instead of silently reclassifying',()=>{
 const item=projectReel({...published,categoryIds:['missing-manual'],taxonomy_override:{manual:true,revision:2}}),result=categoryNavigation([item]);
 assert.deepEqual(result.items[0].categoryIds,['missing-manual']);assert.deepEqual(result.taxonomy.compatibility.missingManualIds,['missing-manual']);assert.deepEqual(result.taxonomy.nodes,[]);
});
test('an initialized official tree still uses one primary while preserving evidence-based custom descendants',()=>{
 const items=[projectReel({...published,categoryIds:['receitas','nutricao']})],official=initialReelsTaxonomy(categoryDefinitions.map((d,n)=>projectReel({...published,id:'Reel_'+n,categoryIds:[d.id]})));
 assert.deepEqual(categoryNavigation(items,official).items[0].categoryIds,['receitas']);
 const withChild={...official,revision:2,nodes:[...official.nodes,{id:'auto-format',name:'Receita única',parentId:'receitas',manual:false}],rules:[{kind:'structured_recurrence',categoryId:'auto-format',enabled:true}]};
 const result=categoryNavigation([projectReel({...published,categoryIds:['receitas','auto-format']})],withChild);
 assert.deepEqual(result.items[0].categoryIds,['receitas','auto-format']);assert.equal(result.taxonomy.nodes.find(n=>n.id==='auto-format').parentId,'receitas');
});
test('manual navigation uses the newest revision instead of resurrecting an older saved assignment',()=>{
 const item=projectReel({...published,categoryIds:['manual-new'],taxonomy_override:{manual:true,revision:5}}),saved={revision:5,nodes:[{id:'manual-new',name:'Atual',parentId:null,manual:true},{id:'manual-old',name:'Antiga',parentId:null,manual:true}],assignments:[{reelId:published.id,categoryIds:['manual-old'],manual:true,revision:2}],rules:[],appliedCommands:[]},original=structuredClone(saved);
 assert.deepEqual(categoryNavigation([item],saved).items[0].categoryIds,['manual-new']);assert.deepEqual(saved,original);
 const older=projectReel({...published,categoryIds:['manual-old'],taxonomy_override:{manual:true,revision:2}}),newer={...saved,assignments:[{reelId:published.id,categoryIds:['manual-new'],manual:true,revision:5},{reelId:published.id,categoryIds:['manual-old'],manual:true,revision:3}]};
 assert.deepEqual(categoryNavigation([older],newer).items[0].categoryIds,['manual-new']);
 const newerAutomatic=projectReel({...published,categoryIds:['receitas'],taxonomy_override:{manual:false,revision:6}});
 assert.deepEqual(categoryNavigation([newerAutomatic],saved).items[0].categoryIds,['receitas']);
});
