import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';
import {makeSemanticFixture} from '../tests/reels-semantic-fixture.mjs';

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
 await record('failed_tree_and_failed_curator_reads_are_isolated_from_manual_tools',async()=>{
  const state=await start();
  try{
   state.server.failNext('/api/reels/categories','Árvore sintética indisponível.');
   state.server.failNext('/api/reels/curation/semantic','Curadoria sintética indisponível.');
   await navigate(state.page,'Categorias');
   await state.page.getByText('Árvore sintética indisponível.',{exact:false}).waitFor();await state.page.getByText('Curadoria sintética indisponível.',{exact:false}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Organizar acervo salvo',exact:true}).isDisabled(),true,'Failed admission read cannot enable provider execution');
   await createContext(state,'Contexto sem depender da consulta');
   await state.page.getByLabel('Buscar na árvore',{exact:true}).waitFor();
   const overview=await read(state,'/curation/semantic');assert.ok(overview.groups.some(group=>group.name==='Contexto sem depender da consulta'));assert.equal(state.fixture.calls.length,0);
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
 await record('domain_navigation_filters_before_pagination_and_preserves_search_and_area_on_return',async()=>{
  const fixture=makeSemanticFixture(),template=fixture.documents.find(row=>row.path==='videos/QaFull_single'),taxonomy=fixture.documents.find(row=>row.path==='settings/reels_v2_taxonomy');
  fixture.documents=fixture.documents.filter(row=>!row.path.startsWith('videos/')&&!row.path.startsWith('reels_legacy_content/'));
  taxonomy.data.nodes.push({id:'group-technology',name:'Tecnologia',parentId:null},{id:'inteligencia-artificial',name:'Inteligência artificial',parentId:'group-technology'});
  const expected=[];
  for(let index=0;index<40;index++){
   const id='QaDomain_'+String(index).padStart(3,'0'),data=structuredClone(template.data);data.id=id;data.title='Preparo de teste '+String(index).padStart(3,'0');data.analysis={...data.analysis,title:data.title};data.analysis_key='analysis/'+id+'.json';data.source_caption.capture_id='caption-'+id;
   fixture.documents.push({path:'videos/'+id,data,updateTime:template.updateTime});expected.push(id);
  }
  const tech=structuredClone(template.data);tech.id='QaDomain_tech';tech.title='Tecnologia fora do domínio';tech.category_ids=['inteligencia-artificial'];tech.analysis={...tech.analysis,title:tech.title};tech.analysis_key='analysis/'+tech.id+'.json';fixture.documents.push({path:'videos/'+tech.id,data:tech,updateTime:template.updateTime});
  const other=structuredClone(template.data);other.id='QaDomain_other';other.title='Destino ainda não definido';other.category_ids=[];other.analysis_key='analysis/'+other.id+'.json';fixture.documents.push({path:'videos/'+other.id,data:other,updateTime:template.updateTime});
  const state=await start(fixture);
  try{
   const overview=await read(state,'/curation/semantic/domains'),food=overview.domains.find(domain=>domain.id==='food');assert.ok(food);assert.equal(food.inventoryCount,40);assert.equal(overview.destinationPending.count,1);
   await navigate(state.page,'Categorias');await state.page.getByRole('button',{name:'Ver área '+food.label,exact:true}).click();const detail=state.page.getByRole('region',{name:'Detalhes da área'});await detail.getByRole('heading',{name:food.label,exact:true}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Segmentar por evidências',exact:true}).count(),0,'Removed legacy action must not advertise a known409 route');
   await detail.getByRole('button',{name:'Explorar área na Biblioteca →',exact:true}).click();await state.page.getByText('Área:',{exact:false}).waitFor();
   const first=await read(state,'/items?workspace=library&curationDomainId=food&limit=25');assert.equal(first.total,40);assert.equal(first.items.length,25);assert.ok(first.nextCursor);
   const next=await read(state,'/items?workspace=library&curationDomainId=food&limit=25&cursor='+encodeURIComponent(first.nextCursor));assert.deepEqual([...first.items,...next.items].map(item=>item.id).sort(),expected);assert.equal(Boolean(next.nextCursor),false);
   const paged=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&url.searchParams.get('limit')==='25';});
   await state.page.getByLabel('Por página',{exact:true}).selectOption('25');await paged;await state.page.getByText('40 resultados · página 1',{exact:true}).waitFor();await state.page.getByRole('button',{name:'Lista',exact:true}).click();
   const second=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&!!url.searchParams.get('cursor');});
   await state.page.getByRole('button',{name:'Próxima →',exact:true}).click();await second;await state.page.getByText('40 resultados · página 2',{exact:true}).waitFor();
   await navigate(state.page,'Financeiro');await navigate(state.page,'Biblioteca');await state.page.getByText('40 resultados · página 2',{exact:true}).waitFor();assert.equal(await state.page.getByRole('button',{name:'Lista',exact:true}).getAttribute('aria-pressed'),'true');
   const searched=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&url.searchParams.get('curationDomainId')==='food'&&url.searchParams.get('q')==='Preparo de teste 03';});await state.page.getByLabel('Buscar no acervo',{exact:true}).fill('Preparo de teste 03');await searched;await state.page.getByText('10 resultados · página 1',{exact:true}).waitFor();
   await navigate(state.page,'Categorias');await state.page.getByRole('region',{name:'Detalhes da área'}).getByRole('heading',{name:food.label,exact:true}).waitFor();await navigate(state.page,'Biblioteca');assert.equal(await state.page.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'Preparo de teste 03');await state.page.getByText('10 resultados · página 1',{exact:true}).waitFor();
   const clearing=state.page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/reels/items'&&!url.searchParams.get('curationDomainId')&&!url.searchParams.get('q');});await state.page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await clearing;await state.page.getByText('42 resultados · página 1',{exact:true}).waitFor();
   assert.equal(await state.page.getByRole('button',{name:'Remover área',exact:true}).count(),0);assert.equal(state.sources(),state.sourceBefore);assert.equal(fixture.calls.length,0);assert.deepEqual(state.server.externalAttempts,[]);
   await state.page.screenshot({path:join(output,'domain-library-navigation.png'),fullPage:true});
  }finally{await writeFile(join(output,'domain-http-calls.json'),JSON.stringify(state.server.calls,null,2));await state.close();}
 });
 assert.deepEqual(failures,[]);
 const report={passed:true,checks,mode:'synthetic_saved_sources_real_API_and_workspace',realProviderCalls:0,newReelsProcessed:0,sourceAnalysesChanged:false,limitations:['Synthetic source categories prove routing and UI behavior, not real-corpus semantic accuracy.','Automatic domain execution stays subject to server policy and independent operational authorization.']};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,failures},null,2));throw error;}
finally{await browser.close();}
