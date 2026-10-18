import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';
import {makeSemanticFixture,semanticEnvelope} from '../tests/reels-semantic-fixture.mjs';
import {contextualHash} from '../lib/reels-contextual-projection.mjs';
import {semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {makeSemanticDomainFixture,seedSemanticDomainManifest,seedSyntheticDomainOwner} from '../tests/reels-semantic-domain-fixture.mjs';

const output=process.env.MEGABRAIN_REELS_DOMAIN_QA_OUTPUT??join(tmpdir(),'megabrain-reels-domain-qa'),checks=[],failures=[];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
async function start(fixture=makeSemanticFixture()){
 const server=await startReelsFixtureServer({semanticFixture:fixture}),context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'qa_session',value:'local',url:server.origin}]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>failures.push(error.message));await page.goto(server.origin);
 const sources=()=>JSON.stringify([...server.store.docs].filter(([path])=>path.startsWith('videos/')||path.startsWith('reels_legacy_content/')).sort(([a],[b])=>a.localeCompare(b)));
 return {server,context,page,fixture,sources,sourceBefore:sources(),async close(){await context.close();await server.close();}};
}
async function navigate(page,label){await page.getByRole('navigation').getByRole('button',{name:new RegExp(label)}).click();await page.getByRole('heading',{name:label,level:1,exact:true}).waitFor();}
async function read(state,path){const response=await state.context.request.get(state.server.origin+'/api/reels'+path);assert.equal(response.status(),200,path);return response.json();}
async function createContext(state,name){
 const {page,server}=state;
 await page.getByRole('button',{name:'+ Criar contexto',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Criar contexto'});
 await dialog.getByLabel('Nome do contexto',{exact:true}).fill(name);await dialog.getByLabel('O que pertence a este contexto',{exact:true}).fill('Organização editorial sintética das publicações salvas, sem inferência.');
 const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/reels/curation/semantic'&&response.request().method()==='POST'&&response.request().postDataJSON()?.action==='group_create');
 await dialog.getByRole('button',{name:'Confirmar alteração',exact:true}).click();const response=await pending;assert.equal(response.status(),200,JSON.stringify(await response.json()));await dialog.waitFor({state:'hidden'});
 assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);return response.json();
}
async function record(name,run){await run();checks.push(name);}

try{
 await record('slow_tree_does_not_hide_semantic_or_manual_context_creation',async()=>{
  const state=await start();const hold=state.server.holdNext(url=>url.pathname==='/api/reels/categories');
  try{
   await navigate(state.page,'Categorias');await hold.started;
   const curator=state.page.getByRole('region',{name:'Curadoria semântica do acervo'});
   await curator.getByRole('heading',{name:'Contextos que fazem sentido juntos',exact:true}).waitFor();await curator.getByLabel('Buscar contextos semânticos',{exact:true}).waitFor();
   const created=await createContext(state,'Contexto com árvore pendente');assert.equal(created.group.manual,true);
   hold.release();await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   assert.equal(state.server.calls.some(call=>call.method==='POST'&&call.body?.action==='create'),false);assert.deepEqual(state.server.externalAttempts,[]);
  }finally{hold.release();await state.close();}
 });
 await record('failed_curator_read_preserves_the_tree_and_manual_tools',async()=>{
  const state=await start();
  try{
   state.server.failNext('/api/reels/curation/semantic','Curadoria sintética indisponível.');
   await navigate(state.page,'Categorias');
   await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();await state.page.getByText('Curadoria sintética indisponível.',{exact:false}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Organizar acervo salvo',exact:true}).isDisabled(),true,'Failed admission read cannot enable provider execution');
   await createContext(state,'Contexto sem depender da consulta');
   await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   const overview=await read(state,'/curation/semantic');assert.ok(overview.groups.some(group=>group.name==='Contexto sem depender da consulta'));assert.equal(state.fixture.calls.length,0);
  }finally{await state.close();}
 });
 await record('failed_tree_read_preserves_loaded_curation_and_manual_tools',async()=>{
  const state=await start();
  try{
   state.server.failNext('/api/reels/categories','Árvore sintética indisponível.');await navigate(state.page,'Categorias');
   await state.page.getByText('Árvore sintética indisponível.',{exact:false}).waitFor();await state.page.getByLabel('Buscar contextos semânticos',{exact:true}).waitFor();
   const created=await createContext(state,'Contexto com árvore indisponível');assert.equal(created.group.manual,true);await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('uncertain_operation_blocks_new_execution_but_not_manual_editorial_actions',async()=>{
  const state=await start();
  try{
   const preview=await state.server.semantic.preview({all:true}),created=await state.server.semantic.create({selection:{all:true},previewHash:preview.previewHash,idempotencyKey:'synthetic-domain-old-operation'});
   const path='reels_index/semantic_job_'+created.job.id,snapshot=await state.server.store.get(path);
   await state.server.store.patch(path,{...snapshot.data,status:'uncertain',reason:'SYNTHETIC_UNCERTAIN',updatedAt:new Date().toISOString()},{updateTime:snapshot.updateTime});
   const preserved=JSON.stringify(await state.server.store.get(path));await navigate(state.page,'Categorias');
   await state.page.getByText(/Uma curadoria já está aberta ou precisa de conferência/).waitFor();assert.equal(await state.page.getByRole('button',{name:'Organizar acervo salvo',exact:true}).isDisabled(),true);
   await createContext(state,'Organização manual independente');
   assert.equal(JSON.stringify(await state.server.store.get(path)),preserved,'Editorial command must not rewrite the uncertain operation or counters');
   assert.equal(state.fixture.calls.length,0);assert.equal(await state.page.getByRole('button',{name:'Continuar curadoria',exact:true}).count(),0);
   await state.page.screenshot({path:join(output,'manual-tools-with-uncertain-operation.png'),fullPage:true});
  }finally{await state.close();}
 });
 await record('library_prioritizes_items_before_auxiliary_element_queries',async()=>{
  const state=await start(),hold=state.server.holdNext(url=>url.pathname==='/api/reels/items'&&url.searchParams.get('workspace')==='library');
  try{
   await navigate(state.page,'Biblioteca');await hold.started;
   assert.equal(state.server.calls.some(call=>call.path==='/api/reels/contextual'),false,'Initial auxiliary queries must wait for the first published items response');
   const auxiliary=state.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/reels/contextual');hold.release();await auxiliary;
   const search=state.page.getByLabel('Buscar no acervo',{exact:true}),updated=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('q')==='QaFull';});
   await search.fill('QaFull');await updated;assert.equal(await search.evaluate(element=>element===document.activeElement),true,'Reading the next result must preserve the search focus');assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{hold.release();await state.close();}
 });
 await record('semantic_tree_nodes_open_the_same_editor_without_legacy_taxonomy_commands',async()=>{
  const state=await start();
  try{
   await navigate(state.page,'Categorias');await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   const created=await createContext(state,'Contexto editorial de teste'),group=created.group;
   const assigned=await state.context.request.post(state.server.origin+'/api/reels/curation/semantic',{headers:{Origin:state.server.origin},data:{action:'group_assign',groupId:group.id,revision:group.revision,addIds:['QaFull_single','QaFull_many'],removeIds:[],idempotencyKey:'synthetic-domain-editor-members'}});
   assert.equal(assigned.status(),200,JSON.stringify(await assigned.json()));
   const refreshed=state.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/reels/categories'&&response.request().method()==='GET');await state.page.getByRole('button',{name:'Atualizar curadoria',exact:true}).click();await refreshed;
   const taxonomy=await read(state,'/categories'),node=taxonomy.nodes.find(node=>node.semanticGroupId===group.id);assert.ok(node);assert.equal(node.editorialOwner,'semantic');assert.equal(node.actionCapabilities.segment,false);
   await state.page.locator('.category-tree .tree-name').filter({hasText:group.name}).click();
   const categoryDetail=state.page.locator('.category-layout > .category-detail').filter({has:state.page.getByRole('heading',{name:group.name,exact:true})});await categoryDetail.getByRole('button',{name:'Gerenciar contexto',exact:true}).click();
   const editor=state.page.getByRole('region',{name:'Detalhes do contexto semântico'});await editor.getByRole('heading',{name:group.name,exact:true}).waitFor();await editor.getByRole('button',{name:'Organizar publicações',exact:true}).waitFor();
   assert.equal(state.server.calls.some(call=>call.path==='/api/reels/categories'&&call.method==='POST'),false,'Semantic tree editing must not call the legacy taxonomy writer');assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('catalogue_format_nodes_are_browsable_but_never_offer_legacy_writers',async()=>{
  const state=await start();
  try{
   const ids=state.fixture.documents.filter(row=>row.path.startsWith('videos/')).map(row=>row.data.id);
   await state.server.store.create('settings/reels_v2_contextual_catalogue',{schemaVersion:1,status:'active',policyVersion:'saved-publication-catalogue-v1',operationId:'0'.repeat(64),sourceObservationSHA256:'0'.repeat(64),sourceHash:'0'.repeat(64),inventoryIds:ids,inventoryCount:ids.length,evaluatedCount:ids.length,observedAt:state.fixture.saved.observedAt,activatedBy:'synthetic_fixture_bootstrap',incremental:{enabled:true,eventDriven:true,noProviders:true}});
   for(const review of state.fixture.saved.formatReviews)await state.server.store.create('reels_index/contextual_review_'+review.reelId,{kind:'contextual_review',reelId:review.reelId,reviewHash:contextualHash(review),review});
   await state.server.seedSavedContributions(ids);const taxonomy=await read(state,'/categories'),node=taxonomy.nodes.find(node=>node.id==='ctx_format_single_recipe');assert.ok(node);assert.equal(node.editorialOwner,'catalogue');assert.equal(node.actionCapabilities.rename,false);
   await navigate(state.page,'Categorias');await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   const ancestors=[];let parent=taxonomy.nodes.find(value=>value.id===node.parentId);while(parent){ancestors.unshift(parent);parent=taxonomy.nodes.find(value=>value.id===parent.parentId);}
   for(const parent of ancestors)await state.page.getByRole('button',{name:'Expandir '+parent.name,exact:true}).click();
   await state.page.locator('.category-tree .tree-name').filter({hasText:node.name}).click();const detail=state.page.locator('.category-layout > .category-detail').filter({has:state.page.getByRole('heading',{name:node.name,exact:true})});
   await detail.getByRole('button',{name:'Explorar na Biblioteca ↗',exact:true}).waitFor();
   for(const name of ['Editar nome','Mover categoria','Unir categorias','Segmentar por evidências','+ Criar subcategoria'])assert.equal(await detail.getByRole('button',{name,exact:true}).count(),0,'Derived format must not expose '+name);
   await state.page.getByRole('button',{name:'+ Criar categoria',exact:true}).click();const createDialog=state.page.getByRole('dialog',{name:'Criar categoria'}),parentSelect=createDialog.getByLabel('Categoria acima',{exact:true});assert.equal(await parentSelect.inputValue(),'','Global creation must not inherit the selected virtual format');const parentIds=await parentSelect.locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(parentIds.includes('receitas'));assert.equal(parentIds.some(id=>id.startsWith('ctx_format_')||id.startsWith('semantic_')),false,'Legacy parent selector must exclude virtual owners');await createDialog.getByRole('button',{name:'Fechar painel',exact:true}).click();await createDialog.waitFor({state:'hidden'});
   await state.page.setViewportSize({width:390,height:844});assert.equal(await state.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Catalogue and domain panels must fit the mobile viewport');
   await state.page.screenshot({path:join(output,'categories-mobile-tools.png'),fullPage:true});assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('missing_editorial_capabilities_never_enable_legacy_mutations_presentation_only',async()=>{
  const state=await start();
  try{
   // Contract presentation fixture only: the real read API still runs; omit one
   // optional capability field to exercise an older/partial server response.
   await state.page.route(state.server.origin+'/api/reels/categories',async route=>{assert.equal(route.request().method(),'GET');const response=await route.fetch(),data=await response.json(),node=data.nodes.find(node=>node.id==='receitas');assert.ok(node);delete node.actionCapabilities;await route.fulfill({response,json:data});});
   await navigate(state.page,'Categorias');await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   await state.page.getByRole('button',{name:'Expandir Alimentação',exact:true}).click();await state.page.getByRole('button',{name:/^Receitas\s*\d+$/}).click();
   const detail=state.page.locator('.category-layout > .category-detail').filter({has:state.page.getByRole('heading',{name:'Receitas',exact:true})});
   await detail.getByRole('button',{name:'Explorar na Biblioteca ↗',exact:true}).waitFor();for(const name of ['Editar nome','Mover categoria','Unir categorias','+ Criar subcategoria'])assert.equal(await detail.getByRole('button',{name,exact:true}).count(),0,'Missing capability must not offer '+name);
   await state.page.getByRole('button',{name:'+ Criar categoria',exact:true}).click();const dialog=state.page.getByRole('dialog',{name:'Criar categoria'}),parents=await dialog.getByLabel('Categoria acima',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value));assert.equal(parents.includes('receitas'),false);
   assert.equal(state.server.calls.some(call=>call.path==='/api/reels/categories'&&call.method==='POST'),false);assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('content_picker_retries_the_same_first_page_without_losing_selection',async()=>{
  const state=await start();
  try{
   await navigate(state.page,'Categorias');await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   const contentResponse=()=>state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('workspace')==='library'&&response.request().method()==='GET';});
   state.server.failNext('/api/reels/items','Seleção inicial indisponível.');const initialFailure=contentResponse();await state.page.getByRole('button',{name:'Organizar conteúdos',exact:true}).click();const initial=await initialFailure;assert.equal(initial.status(),503);
   const dialog=state.page.getByRole('dialog',{name:'Organizar conteúdos'});await dialog.getByRole('alert').filter({hasText:'Seleção inicial indisponível.'}).waitFor();
   const recovered=contentResponse();await dialog.getByRole('button',{name:'Tentar novamente',exact:true}).click();const first=await recovered;assert.equal(first.status(),200);assert.equal(first.url(),initial.url(),'Retry must repeat the current URL, including the empty initial cursor');
   const selection=dialog.getByRole('checkbox',{name:'Organizar QaFull_single',exact:true});await selection.check();await dialog.getByText('1 selecionados',{exact:true}).waitFor();
   state.server.failNext('/api/reels/items','Busca de seleção indisponível.');const searchFailure=contentResponse();await dialog.getByLabel('Buscar conteúdos publicados',{exact:true}).fill('QaFull_single');const failed=await searchFailure;assert.equal(failed.status(),503);await dialog.getByRole('alert').filter({hasText:'Busca de seleção indisponível.'}).waitFor();await dialog.getByText('1 selecionados',{exact:true}).waitFor();
   const repeated=contentResponse();await dialog.getByRole('button',{name:'Tentar novamente',exact:true}).click();const success=await repeated;assert.equal(success.status(),200);assert.equal(success.url(),failed.url(),'Retry must retain query, scope and cursor instead of navigating elsewhere');
   await selection.waitFor();assert.equal(await selection.isChecked(),true,'A failed read and retry must preserve the selected Reel');await dialog.getByText('1 selecionados',{exact:true}).waitFor();
   assert.equal(state.server.calls.some(call=>call.path==='/api/reels/categories'&&call.method==='POST'),false);assert.equal(state.fixture.calls.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('domain_start_requires_explicit_server_eligibility_and_never_falls_back_to_global_creation',async()=>{
  const state=await start(makeSemanticDomainFixture());
  try{
   await seedSemanticDomainManifest({curator:state.server.semantic});const overview=await read(state,'/curation/semantic/domains'),food=overview.domains.find(domain=>domain.id==='food');assert.equal(food.canStart,false);
   await navigate(state.page,'Categorias');await state.page.getByRole('button',{name:'Ver área '+food.label,exact:true}).click();const detail=state.page.getByRole('region',{name:'Detalhes da área'}),button=detail.getByRole('button',{name:'Organizar esta área',exact:true});await button.waitFor();assert.equal(await button.isDisabled(),true);
   await button.evaluate(element=>element.click());assert.equal(state.server.calls.some(call=>call.method==='POST'&&call.path==='/api/reels/curation/semantic/domains'),false,'Blocked UI must not submit a preview or start');
   const refused=await state.context.request.post(state.server.origin+'/api/reels/curation/semantic/domains',{headers:{Origin:state.server.origin},data:{action:'create',domainId:'food',previewHash:'a'.repeat(64),idempotencyKey:'synthetic-blocked-domain-create'}});assert.equal(refused.status(),423);
   assert.equal(state.server.calls.some(call=>call.method==='POST'&&call.path==='/api/reels/curation/semantic'&&call.body?.action==='create'),false);assert.equal(state.fixture.calls.length,0);assert.equal(state.server.semanticDeliveries.length,0);assert.equal(state.sources(),state.sourceBefore);
  }finally{await state.close();}
 });
 await record('authorized_domain_preview_and_single_create_use_real_owner_policy_and_continue_without_the_browser',async()=>{
  const state=await start(makeSemanticDomainFixture());
  try{
   const authorization=await seedSyntheticDomainOwner({curator:state.server.semantic,domainId:'food'}),oldJob=JSON.stringify(await state.server.store.get(authorization.originJob.path)),oldLedger=JSON.stringify(await state.server.store.get(authorization.originLedger.path)),overview=await read(state,'/curation/semantic/domains'),food=overview.domains.find(domain=>domain.id==='food');assert.equal(food.canStart,true);assert.equal(state.fixture.calls.length,0);assert.equal(authorization.selectedIds.length,2);
   await navigate(state.page,'Categorias');await state.page.getByRole('button',{name:'Ver área '+food.label,exact:true}).click();const detail=state.page.getByRole('region',{name:'Detalhes da área'});await detail.getByRole('button',{name:'Organizar esta área',exact:true}).click();
   const dialog=state.page.getByRole('dialog',{name:'Organizar '+food.label,exact:true}),post=action=>state.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/reels/curation/semantic/domains'&&response.request().method()==='POST'&&response.request().postDataJSON()?.action===action),previewed=post('preview');
   await dialog.getByRole('button',{name:'Conferir escopo desta área',exact:true}).click();const previewResponse=await previewed;assert.equal(previewResponse.status(),200);const preview=await previewResponse.json();assert.equal(preview.inferenceStarted,false);assert.equal(preview.preview.domainId,'food');assert.equal(preview.preview.selectedCount,authorization.selectedIds.length);assert.equal(preview.preview.variableBatches,true);assert.equal(preview.preview.providerEnabled,true);assert.equal(state.fixture.calls.length,0);
   await dialog.getByText('publicações no escopo conferido · nenhuma inferência iniciada nesta prévia.',{exact:false}).waitFor();
   const hold=state.server.holdNext(url=>url.pathname==='/api/reels/curation/semantic/domains'),created=post('create');await dialog.getByRole('button',{name:'Iniciar curadoria desta área',exact:true}).click();await hold.started;assert.equal(await dialog.getByRole('button',{name:'Conferindo operação…',exact:true}).isDisabled(),true);assert.equal(state.fixture.calls.length,0);hold.release();
   const response=await created;assert.equal(response.status(),200,JSON.stringify(await response.json()));const result=await response.json();assert.equal(result.created,true);assert.equal(result.job.status,'prepared');await dialog.waitFor({state:'hidden'});await state.page.getByText('Curadoria da área registrada.',{exact:false}).waitFor();
   const posts=state.server.calls.filter(call=>call.path==='/api/reels/curation/semantic/domains'&&call.method==='POST'),creates=posts.filter(call=>call.body.action==='create');assert.equal(creates.length,1);assert.equal(creates[0].body.domainId,'food');assert.equal(creates[0].body.previewHash,preview.preview.previewHash);assert.ok(creates[0].body.idempotencyKey.length>=8);assert.equal(Object.hasOwn(creates[0].body,'selection'),false);assert.equal(state.server.calls.some(call=>call.path==='/api/reels/curation/semantic'&&call.method==='POST'&&call.body?.action==='create'),false);assert.equal(state.server.semanticDeliveries.length,1);assert.equal(state.fixture.calls.length,0);
   const busyOverview=await read(state,'/curation/semantic/domains');assert.ok(busyOverview.domains.every(domain=>domain.canStart===false),'One active specialist must block concurrent starts in every area');await detail.getByRole('status').filter({hasText:'Aguardando início'}).waitFor();const technology=busyOverview.domains.find(domain=>domain.id==='technology');await state.page.getByRole('button',{name:'Ver área '+technology.label,exact:true}).click();assert.equal(await state.page.getByRole('region',{name:'Detalhes da área'}).getByRole('button',{name:'Organizar esta área',exact:true}).isDisabled(),true);await read(state,'/curation/semantic/jobs/'+result.job.id);assert.equal(state.fixture.calls.length,0,'Navigation, preview and create must not call the provider in the browser');
   await state.page.close();await state.server.pumpSemantic();const completed=await read(state,'/curation/semantic/jobs/'+result.job.id);assert.equal(completed.job.status,'completed');assert.equal(completed.job.processed,authorization.selectedIds.length);assert.ok(state.fixture.calls.length>0);assert.ok(state.fixture.calls.filter(call=>call.phase==='extract').every(call=>call.ids.every(id=>authorization.selectedIds.includes(id))));
   assert.equal(JSON.stringify(await state.server.store.get(authorization.originJob.path)),oldJob);assert.equal(JSON.stringify(await state.server.store.get(authorization.originLedger.path)),oldLedger);assert.equal(state.sources(),state.sourceBefore);assert.deepEqual(state.server.externalAttempts,[]);
  }finally{await state.close();}
 });
 await record('destination_proposals_name_each_publication_target_and_origin_and_load_literal_proof_without_inference',async()=>{
  const fixture=makeSemanticDomainFixture({count:22}),otherIds=fixture.ids.slice(-3),foodId=fixture.ids[16],originalInfer=fixture.provider.infer;
  for(const row of fixture.documents.filter(row=>otherIds.includes(row.data.id))){row.data.categoryIds=['a-organizar'];row.data.analysis.categories=['a-organizar'];}
  fixture.provider.infer=async input=>{
   const envelope=await originalInfer(input),output=JSON.parse(envelope.rawResponse.candidates[0].content.parts[0].text);
   output.destinations=input.sources.map(source=>{const target=source.id===otherIds[0]||source.id===foodId?'technology':source.id===otherIds[1]?'food':null,field=source.fields.find(field=>field.fieldPath==='analysis.title')||source.fields[0];return {reelId:source.id,state:target?'suggested':'inconclusive',domainId:target,reason:target?'Synthetic destination proposal with a literal saved-source anchor.':'Synthetic abstention; destination is not established.',evidence:target?[{fieldPath:field.fieldPath,excerpt:field.text.slice(0,80)}]:[]};});
   return {...envelope,rawResponse:semanticEnvelope(output,input.model).rawResponse};
  };
  const state=await start(fixture);
  try{
   await seedSyntheticDomainOwner({curator:state.server.semantic,domainId:'unassigned'});
   for(const domainId of ['unassigned','food']){const preview=await state.server.semantic.preview({domainId}),created=await state.server.semantic.create({selection:{domainId},previewHash:preview.previewHash,idempotencyKey:'synthetic-destinations-'+domainId});await state.server.pumpSemantic();assert.equal((await read(state,'/curation/semantic/jobs/'+created.job.id)).job.status,'completed');}
   const calls=fixture.calls.length,overview=await read(state,'/curation/semantic/domains'),suggestions=overview.destinationPending.suggestions,positive=suggestions.filter(row=>row.state==='suggested'),abstention=suggestions.find(row=>row.state==='inconclusive');assert.equal(overview.destinationPending.count,3);assert.ok(suggestions.length>overview.destinationPending.count,'Destination suggestions are global, not the count of contents in Other');assert.ok(positive.some(row=>row.suggestedDomainId==='technology'));assert.ok(positive.some(row=>row.suggestedDomainId==='food'));assert.ok(abstention);assert.ok(suggestions.every(row=>row.title&&row.detailPath&&row.accepted===false));
   await navigate(state.page,'Categorias');const panel=state.page.getByRole('region',{name:'Propostas de destino'});await panel.getByRole('heading',{name:'Propostas de destino para conferir',exact:true}).waitFor();await panel.getByText('Propostas das diferentes áreas do acervo.',{exact:false}).waitFor();
   for(const row of positive){const card=panel.getByRole('article',{name:'Proposta de destino · '+row.title,exact:true});await card.getByRole('heading',{name:row.title,exact:true}).waitFor();await card.getByText('Destino sugerido: '+row.suggestedDomainLabel,{exact:true}).waitFor();await card.getByText('Curadoria de origem: '+overview.domains.find(domain=>domain.id===row.proposedByDomainId).label,{exact:true}).waitFor();}
   await panel.getByRole('article',{name:'Proposta de destino · '+abstention.title,exact:true}).getByText('Destino não determinado',{exact:true}).waitFor();assert.equal(state.server.calls.some(call=>call.path.startsWith('/api/reels/curation/semantic/domains/destinations/')),false,'Literal evidence is fetched only on explicit request');
   const target=positive.find(row=>row.proposedByDomainId==='unassigned'&&row.suggestedDomainId==='technology'),card=panel.getByRole('article',{name:'Proposta de destino · '+target.title,exact:true}),path='/api/reels/curation/semantic/domains/destinations/'+encodeURIComponent(target.reelId),loaded=state.page.waitForResponse(response=>new URL(response.url()).pathname===path);
   await card.getByRole('button',{name:'Carregar provas de '+target.title,exact:true}).click();const response=await loaded;assert.equal(response.status(),200);const proof=await response.json();assert.equal(proof.inferenceOnGet,false);assert.equal(proof.accepted,false);assert.equal(proof.semanticCertified,false);assert.equal(proof.sourceStale,false);assert.ok(proof.evidence.length>0);
   const source=semanticSourceFromSaved(await state.server.semantic.catalogue.loadSource(target.reelId));assert.deepEqual(proof.sourceVersions,source.sourceVersions);for(const evidence of proof.evidence){assert.ok(source.fields.some(field=>field.fieldPath===evidence.fieldPath&&field.text.includes(evidence.excerpt)));await card.getByText(evidence.excerpt,{exact:true}).waitFor();}await card.getByText('O destino proposto não foi aplicado.',{exact:true}).waitFor();assert.equal(fixture.calls.length,calls,'Loading proofs must not infer');
   const opened=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('q')===target.reelId;});await card.getByRole('button',{name:'Ver publicação na Biblioteca →',exact:true}).click();const publication=await(await opened).json();assert.equal(publication.total,1);assert.deepEqual(publication.items.map(item=>item.id),[target.reelId]);assert.equal(fixture.calls.length,calls);assert.equal(state.sources(),state.sourceBefore);assert.deepEqual(state.server.externalAttempts,[]);
  }finally{await writeFile(join(output,'destination-http-calls.json'),JSON.stringify(state.server.calls,null,2));await state.close();}
 });
 await record('domain_navigation_filters_before_pagination_and_preserves_search_and_area_on_return',async()=>{
  const fixture=makeSemanticFixture(),template=fixture.documents.find(row=>row.path==='videos/QaFull_single'),taxonomy=fixture.documents.find(row=>row.path==='settings/reels_v2_taxonomy');
  fixture.documents=fixture.documents.filter(row=>!row.path.startsWith('videos/')&&!row.path.startsWith('reels_legacy_content/'));
  taxonomy.data.nodes.push({id:'group-technology',name:'Tecnologia',parentId:null},{id:'inteligencia-artificial',name:'Inteligência artificial',parentId:'group-technology'});
  const expected=[];
  for(let index=0;index<40;index++){
   const id='QaDomain_'+String(index).padStart(3,'0'),data=structuredClone(template.data);data.id=id;data.title='Preparo de teste '+String(index).padStart(3,'0');data.creator=index>=30?'@faixa-final':'@faixa-inicial';data.analysis={...data.analysis,title:data.title};data.analysis_key='analysis/'+id+'.json';data.source_caption.capture_id='caption-'+id;
   fixture.documents.push({path:'videos/'+id,data,updateTime:template.updateTime});expected.push(id);
  }
  const tech=structuredClone(template.data);tech.id='QaDomain_tech';tech.title='Tecnologia fora do domínio';tech.category_ids=['inteligencia-artificial'];tech.analysis={...tech.analysis,title:tech.title};tech.analysis_key='analysis/'+tech.id+'.json';fixture.documents.push({path:'videos/'+tech.id,data:tech,updateTime:template.updateTime});
  const other=structuredClone(template.data);other.id='QaDomain_other';other.title='Destino ainda não definido';other.category_ids=['a-organizar'];other.analysis_key='analysis/'+other.id+'.json';fixture.documents.push({path:'videos/'+other.id,data:other,updateTime:template.updateTime});
  const state=await start(fixture);
  try{
   const allIds=[...expected,tech.id,other.id];await state.server.store.create('settings/reels_v2_contextual_catalogue',{schemaVersion:1,status:'active',policyVersion:'saved-publication-catalogue-v1',operationId:'0'.repeat(64),sourceObservationSHA256:'0'.repeat(64),sourceHash:'0'.repeat(64),inventoryIds:allIds,inventoryCount:allIds.length,evaluatedCount:allIds.length,observedAt:template.updateTime,activatedBy:'synthetic_fixture_bootstrap',incremental:{enabled:true,eventDriven:true,noProviders:true}});await state.server.seedSavedContributions(allIds);
   const overview=await read(state,'/curation/semantic/domains'),food=overview.domains.find(domain=>domain.id==='food');assert.ok(food);assert.equal(food.inventoryCount,40);assert.equal(overview.destinationPending.count,1);
   await navigate(state.page,'Categorias');await state.page.getByRole('button',{name:'Ver área '+food.label,exact:true}).click();const detail=state.page.getByRole('region',{name:'Detalhes da área'});await detail.getByRole('heading',{name:food.label,exact:true}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Segmentar por evidências',exact:true}).count(),0,'Removed legacy action must not advertise a known409 route');
   await detail.getByRole('button',{name:'Explorar área na Biblioteca →',exact:true}).click();await state.page.getByText('Área:',{exact:false}).waitFor();
   const contextual=await read(state,'/contextual?curationDomainId=food');assert.equal(contextual.total,40);assert.equal(contextual.facets.find(facet=>facet.dimensionId==='ingredient'&&facet.valueId==='frango')?.supportCount,40,'Element counts and OR options must use the domain, not the42-source inventory');
   const ingredient=state.page.getByRole('button',{name:'Filtrar ingrediente Frango',exact:true});await ingredient.waitFor();assert.match(await ingredient.innerText(),/40/);const faceted=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&url.searchParams.get('facets')?.includes('frango');});await ingredient.click();await faceted;
   const first=await read(state,'/items?workspace=library&curationDomainId=food&limit=25');assert.equal(first.total,40);assert.equal(first.items.length,25);assert.ok(first.nextCursor);
   const next=await read(state,'/items?workspace=library&curationDomainId=food&limit=25&cursor='+encodeURIComponent(first.nextCursor));assert.deepEqual([...first.items,...next.items].map(item=>item.id).sort(),expected);assert.equal(Boolean(next.nextCursor),false);
   const paged=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&url.searchParams.get('limit')==='25';});
   await state.page.getByLabel('Por página',{exact:true}).selectOption('25');await paged;await state.page.getByText('40 resultados · página 1',{exact:true}).waitFor();await state.page.getByRole('button',{name:'Lista',exact:true}).click();
   const second=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&!!url.searchParams.get('cursor');});
   await state.page.getByRole('button',{name:'Próxima →',exact:true}).click();await second;await state.page.getByText('40 resultados · página 2',{exact:true}).waitFor();
   await navigate(state.page,'Financeiro');await navigate(state.page,'Biblioteca');await state.page.getByText('40 resultados · página 2',{exact:true}).waitFor();assert.equal(await state.page.getByRole('button',{name:'Lista',exact:true}).getAttribute('aria-pressed'),'true');
   const searched=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&url.searchParams.get('q')==='faixa-final';});await state.page.getByLabel('Buscar no acervo',{exact:true}).fill('faixa-final');await searched;await state.page.getByText('10 resultados · página 1',{exact:true}).waitFor();
   await navigate(state.page,'Categorias');await state.page.getByRole('region',{name:'Detalhes da área'}).getByRole('heading',{name:food.label,exact:true}).waitFor();await navigate(state.page,'Biblioteca');assert.equal(await state.page.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'faixa-final');await state.page.getByText('10 resultados · página 1',{exact:true}).waitFor();
   const clearing=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&!url.searchParams.get('curationDomainId')&&!url.searchParams.get('q');});await state.page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await clearing;await state.page.getByText('42 resultados · página 1',{exact:true}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Remover área',exact:true}).count(),0);assert.equal(state.sources(),state.sourceBefore);assert.equal(fixture.calls.length,0);assert.deepEqual(state.server.externalAttempts,[]);
   await state.page.screenshot({path:join(output,'domain-library-navigation.png'),fullPage:true});
  }finally{await writeFile(join(output,'domain-http-calls.json'),JSON.stringify(state.server.calls,null,2));await state.close();}
 });
 assert.deepEqual(failures,[]);
 const report={passed:true,checks,mode:'synthetic_saved_sources_real_API_and_workspace',realProviderCalls:0,newReelsProcessed:0,sourceAnalysesChanged:false,limitations:['Synthetic source categories prove routing and UI behavior, not real-corpus semantic accuracy.','Automatic domain execution stays subject to server policy and independent operational authorization.']};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,failures},null,2));throw error;}
finally{await browser.close();}
