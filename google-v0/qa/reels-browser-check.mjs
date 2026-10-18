import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';
import {prepareContextualCategoryPlan} from '../lib/reels-contextual-calibration.mjs';
import {calibrationReportView} from '../lib/reels-curation-calibration.mjs';
import {makeContextualCalibrationFixture} from '../tests/reels-contextual-calibration-fixture.mjs';
import {makeFullCatalogueFixture} from '../tests/reels-contextual-catalogue-fixture.mjs';
import {contextualHash} from '../lib/reels-contextual-projection.mjs';

const output=process.env.MEGABRAIN_REELS_QA_OUTPUT??join(tmpdir(),'megabrain-reels-qa-results');
await mkdir(output,{recursive:true});
const server=await startReelsFixtureServer(),checks=[],failures=[];
let browser,page;
const record=async(name,action)=>{await action();checks.push(name);};
const responseFor=(page,path,predicate=()=>true)=>{const pending=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname===path&&predicate(url,response);});pending.catch(()=>{});return pending;};
const postFor=(page,path)=>responseFor(page,path,(_,response)=>response.request().method()==='POST');
async function navigate(page,label){await page.getByRole('navigation').getByRole('button',{name:new RegExp(label)}).click();await page.getByRole('heading',{name:label,exact:true,level:1}).waitFor();}
async function search(page,term){const response=responseFor(page,'/api/reels/items',url=>(url.searchParams.get('q')??'')===term);await page.getByLabel('Buscar no acervo').fill(term);await response;}
async function closeDialog(page){await page.getByRole('dialog').getByRole('button',{name:'Fechar painel',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});}
async function preview(page,button,total,eligible,type='start'){
 const response=responseFor(page,'/api/reels/preview');await page.getByRole('button',{name:button,exact:true}).click();const data=await (await response).json();
 assert.equal(data.total,total);assert.equal(data.eligible,eligible);const dialog=page.getByRole('dialog',{name:'Prévia de admissão'});await dialog.getByText('elegíveis',{exact:true}).waitFor();
 const denied=postFor(page,'/api/reels/commands');await dialog.getByRole('button',{name:type==='retry'?'Solicitar retomada ao servidor':'Solicitar início ao servidor',exact:true}).click();assert.equal((await denied).status(),423);await dialog.getByRole('alert').filter({hasText:'PROCESSING_DISABLED'}).waitFor();await closeDialog(page);assert.equal(server.calls.filter(x=>x.path==='/api/reels/preview').at(-1).body.type,type);return data;
}
try {
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'qa_session',value:'local',url:server.origin}]);
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===server.origin)return route.continue();failures.push('Unexpected external browser request: '+route.request().url());return route.abort();});
 context.on('page',p=>{p.on('pageerror',error=>failures.push(error.message));p.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource: the server responded with a status of (423|503)\b/.test(message.text()))failures.push(message.text());});});
 page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(server.origin);
 await record('all_seven_workspaces_navigation_and_dated_counts',async()=>{
  await page.locator('.stat').filter({hasText:'Conteúdos a processar'}).getByText('72',{exact:true}).waitFor();await page.locator('.stat').filter({hasText:'Acervo completo'}).getByText('79',{exact:true}).waitFor();await page.locator('.catalog .pagination').filter({hasText:'72 resultados'}).waitFor();assert.ok(server.calls.some(x=>x.path==='/api/reels/items'&&new URLSearchParams(x.query).get('workspace')==='ready'));assert.equal(await page.getByRole('button',{name:/Modelo publicado/}).count(),0);
  const names=await page.getByRole('navigation').getByRole('button').allTextContents();assert.equal(names.length,7);
  for(const [i,label]of ['Todos os Reels','Filas','Categorias','Biblioteca','Precisa de atenção','Financeiro','Atividade'].entries()){assert.ok(names[i].includes(label));await navigate(page,label);}
  await page.getByText('Publicação sintética preservada.',{exact:true}).waitFor();await navigate(page,'Todos os Reels');
  assert.ok((await page.locator('body').innerText()).includes('Processamento desligado'));
  await page.screenshot({path:join(output,'reels-all-desktop.png'),fullPage:true});
 });
 await record('server_filters_pagination_cross_page_batch_and_all_eligible_denied423',async()=>{
  await search(page,'Entrada');await page.locator('.pagination').filter({hasText:'72 resultados'}).waitFor();
  const limitResponse=responseFor(page,'/api/reels/items',url=>url.searchParams.get('limit')==='25');await page.getByLabel('Por página').selectOption('25');await limitResponse;
  await page.getByLabel('Selecionar Entrada 000',{exact:true}).check();await preview(page,'Prévia do lote',1,1);
  const next=responseFor(page,'/api/reels/items',url=>!!url.searchParams.get('cursor'));await page.getByRole('button',{name:'Próxima →',exact:true}).click();await next;
  await page.getByLabel('Selecionar Entrada 025',{exact:true}).check();const batch=await preview(page,'Prévia do lote',2,2);assert.deepEqual(batch.ids,['QaReg_000','QaReg_025']);
  const all=await preview(page,'Todos os elegíveis deste filtro',72,72);assert.equal(all.ids.length,72);assert.ok(all.ids.includes('QaReg_071'));
  const last=server.calls.filter(x=>x.path==='/api/reels/preview').at(-1);assert.equal(last.body.selection.all,true);assert.equal(last.body.selection.filters.q,'Entrada');assert.equal(last.body.selection.filters.cursor,undefined);
  const reset=responseFor(page,'/api/reels/items',url=>!url.searchParams.get('q')&&!url.searchParams.get('cursor'));await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await reset;
  const inventory=responseFor(page,'/api/reels/items',url=>url.searchParams.get('workspace')==='all');await page.getByRole('button',{name:'Acervo completo',exact:true}).click();await inventory;
  const filtered=responseFor(page,'/api/reels/items',url=>url.searchParams.get('status')==='failed');await page.getByLabel('Estado',{exact:true}).selectOption('failed');await filtered;await page.getByRole('button',{name:/Falha confirmada/}).waitFor();
  assert.equal(await page.locator('.catalog tbody tr').count(),1);await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();
 });
 await record('published_knowledge_caption_transcript_candidate_and_private_vertical_video',async()=>{
  await navigate(page,'Biblioteca');await page.locator('.library-card').filter({hasText:'Modelo publicado'}).waitFor();
  const noLanguage=responseFor(page,'/api/reels/items',url=>url.searchParams.get('language')==='en');await page.getByLabel('Idioma',{exact:true}).fill('en');await noLanguage;await page.getByText('Nenhum registro nesta seleção',{exact:true}).waitFor();
  const language=responseFor(page,'/api/reels/items',url=>url.searchParams.get('language')==='pt');await page.getByLabel('Idioma',{exact:true}).fill('pt');await language;
  const tagged=responseFor(page,'/api/reels/items',url=>url.searchParams.get('tag')==='publicado');await page.getByLabel('Tag',{exact:true}).fill('publicado');await tagged;
  const card=page.locator('.library-card').filter({has:page.getByRole('heading',{name:'Modelo publicado',exact:true})});await card.click();
  const dialog=page.getByRole('dialog',{name:'Modelo publicado',exact:true});await dialog.getByText('Explicação consolidada e publicada.',{exact:true}).waitFor();
  assert.ok((await dialog.innerText()).includes('Local não informado.'));assert.ok((await dialog.innerText()).includes('Candidato separado sem substituir publicação.'));assert.ok(!(await dialog.innerText()).includes('Legenda original preservada de QaPub_tech'));
  await dialog.getByText('Fontes e evidências',{exact:true}).click();await dialog.locator('blockquote').getByText('Trecho de teste preservado.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Legenda',exact:true}).click();await dialog.getByText('Legenda original preservada de QaPub_tech',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Transcrição',exact:true}).click();await dialog.getByText('Transcrição preservada de QaPub_tech',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Análise visual',exact:true}).click();await dialog.getByText('Quadro sintético vertical.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Carregar vídeo privado',exact:true}).click();const video=dialog.locator('video');await video.evaluate(element=>element.play());
  await page.waitForFunction(()=>{const video=document.querySelector('dialog video');return video&&video.readyState>=2&&video.currentTime>0&&!video.error;});
  const box=await dialog.locator('.video-preview').boundingBox();assert.ok(Math.abs(box.width/box.height-9/16)<0.03);
  await dialog.getByRole('button',{name:'Visão geral',exact:true}).click();const denied=postFor(page,'/api/reels/commands');await dialog.getByRole('button',{name:'Solicitar complemento ao servidor',exact:true}).click();assert.equal((await denied).status(),423);await dialog.getByRole('alert').filter({hasText:'PROCESSING_DISABLED'}).waitFor();
  await page.screenshot({path:join(output,'reels-knowledge-desktop.png'),fullPage:true});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await card.evaluate(element=>document.activeElement===element),true);
  await page.locator('.library-card').filter({has:page.getByRole('heading',{name:'Receita publicada',exact:true})}).click();const recipe=page.getByRole('dialog',{name:'Receita publicada',exact:true});await recipe.getByText('300 g de frango',{exact:true}).waitFor();await recipe.getByText('Doure na frigideira por 8 minutos.',{exact:true}).waitFor();await recipe.getByText('8 minutos',{exact:true}).waitFor();await recipe.getByText('2 porções',{exact:true}).waitFor();
  const complete=recipe.getByText('1 colher de chá dos temperos: páprica defumada e cominho.\nFinalize o preparo: cubra com papel-alumínio e asse por uma hora. Retire o papel e doure. <script>alert(1)</script>\n300g de frango. Air fryer é somente uma referência; não é usada neste preparo.',{exact:true});assert.equal(await complete.isVisible(),false);await recipe.getByText('Texto completo da legenda original',{exact:true}).click();await complete.waitFor();assert.equal(await complete.locator('script').count(),0);
  const ingredient=recipe.locator('.knowledge-field').filter({has:page.getByRole('heading',{name:'Páprica defumada',exact:true})});
  await ingredient.getByText('Quantidade não consolidada; consulte as fontes abaixo.',{exact:true}).waitFor();assert.ok(!(await ingredient.innerText()).includes('Não especificado'));
  const originalField=ingredient.locator('pre');assert.equal(await originalField.isVisible(),false);await ingredient.getByText('Valor estruturado original',{exact:true}).click();
  const original=JSON.parse(await originalField.innerText());assert.equal(original.kind,'ingredient');assert.equal(original.value,'Não especificado');
  await ingredient.getByText('Valor estruturado original',{exact:true}).click();assert.equal(await originalField.isVisible(),false);
  const savedFood=(await server.store.get('videos/QaPub_food')).data;assert.equal(savedFood.analysis.knowledge.fields.find(f=>f.name==='Páprica defumada').value,'Não especificado');assert.ok(savedFood.source_caption.text.includes('1 colher de chá dos temperos:'));
  await page.screenshot({path:join(output,'reels-quantity-saved-source.png'),fullPage:true});
  const insight=recipe.locator('.knowledge-field').filter({hasText:'Afirmação do autor'});await insight.getByText('O autor orienta dourar o frango na frigideira.',{exact:true}).waitFor();await insight.getByText('Aplicação possível: Usar a sequência descrita como referência de preparo.',{exact:true}).waitFor();
  const quote=insight.getByText('Use 300 g de frango. Doure na frigideira por 8 minutos. Rende 2 porções.',{exact:true});assert.equal(await quote.isVisible(),false);await insight.getByText('Fontes e evidências da ideia',{exact:true}).click();await quote.waitFor();await insight.getByText('Transcrição · 0s–14s',{exact:true}).waitFor();await recipe.getByText('Interpretação da análise',{exact:true}).waitFor();
  const unknown=recipe.locator('.knowledge-field').filter({hasText:'Ideia registrada'});await unknown.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await unknown.locator('img').count(),0);await unknown.getByText('Fontes e evidências da ideia',{exact:true}).click();await unknown.getByText('Fonte registrada',{exact:true}).waitFor();await unknown.getByText('<b>Trecho preservado como texto.</b>',{exact:true}).waitFor();assert.equal(await unknown.locator('b').count(),0);
  assert.doesNotMatch(await recipe.innerText(),/\b(?:claim|application|classification|start_seconds|end_seconds):|author_claim/);
  await page.screenshot({path:join(output,'reels-recipe-knowledge-desktop.png'),fullPage:true});await closeDialog(page);
 });
 await record('library_tree_parent_descendants_expand_selection_context_and_back_navigation',async()=>{
  await page.setViewportSize({width:1440,height:620});const tree=page.locator('.library-navigation');const before=server.calls.filter(x=>x.path==='/api/reels/items').length;
  await tree.getByRole('button',{name:'Expandir Tecnologia',exact:true}).click();await tree.getByRole('button',{name:'Recolher Tecnologia',exact:true}).waitFor();assert.equal(server.calls.filter(x=>x.path==='/api/reels/items').length,before,'Expanding a branch must not select or refetch contents');
  const parent=responseFor(page,'/api/reels/items',url=>url.searchParams.get('category')==='cat_tech');await tree.locator('.tree-name').filter({hasText:'Tecnologia'}).click();await parent;await page.locator('.library-card').filter({hasText:'Modelo publicado'}).waitFor();assert.equal(await page.locator('.library-card').count(),1);
  const child=responseFor(page,'/api/reels/items',url=>url.searchParams.get('category')==='cat_models');await tree.locator('.tree-name').filter({hasText:'Modelos'}).click();await child;await search(page,'Modelo');await page.getByLabel('Buscar categoria na Biblioteca').fill('modelos');await tree.locator('.tree-name').filter({hasText:'Tecnologia'}).waitFor();assert.equal(await tree.locator('.tree-name').filter({hasText:'Receitas'}).count(),0);
  // A one-row fixture has no scroll range. Real additional published records
  // exercise overflow and restoration without altering product CSS or weakening the assertion.
  const template=(await server.store.get('videos/QaPub_tech')).data,navigationIds=Array.from({length:20},(_,i)=>'QaNav_'+String(i).padStart(3,'0'));
  for(const [i,id]of navigationIds.entries())await server.store.create('videos/'+id,{...structuredClone(template),id,title:'Modelo navegação '+i,source_url:'https://www.instagram.com/reel/'+id+'/'});
  const populated=responseFor(page,'/api/reels/items',url=>url.searchParams.get('category')==='cat_models'&&url.searchParams.get('q')==='Modelo');await page.getByRole('button',{name:'↻ Atualizar',exact:true}).click();await populated;await page.locator('.catalog .pagination').filter({hasText:'21 resultados'}).waitFor();
  await page.getByRole('button',{name:'Lista',exact:true}).click();await page.locator('.catalog tbody tr').first().waitFor();assert.equal(await page.locator('.catalog tbody tr').count(),21);await page.evaluate(()=>window.scrollTo(0,120));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));const scroll=await page.evaluate(()=>window.scrollY);assert.ok(scroll>0);
  await navigate(page,'Financeiro');await navigate(page,'Biblioteca');await page.locator('.catalog tbody tr').first().waitFor();assert.equal(await page.locator('.catalog tbody tr').count(),21);assert.equal(await page.getByLabel('Buscar no acervo').inputValue(),'Modelo');assert.equal(await page.getByLabel('Buscar categoria na Biblioteca').inputValue(),'modelos');await tree.locator('.tree-name[aria-pressed=true]').filter({hasText:'Modelos'}).waitFor();assert.equal(await page.getByRole('button',{name:'Lista',exact:true}).getAttribute('aria-pressed'),'true');await page.waitForFunction(value=>Math.abs(window.scrollY-value)<3,scroll);
  await page.screenshot({path:join(output,'reels-library-tree-desktop.png'),fullPage:true});for(const id of navigationIds){server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_index/contextual_'+id);}await page.getByRole('button',{name:'Grade',exact:true}).click();await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await page.getByLabel('Buscar categoria na Biblioteca').fill('');await page.setViewportSize({width:1440,height:1000});
 });

 await record('two_curations_saved_publications_real_api_context_filters_and_unknown_units',async()=>{
  const writeCount=server.calls.filter(x=>['/api/reels/commands','/api/reels/categories'].includes(x.path)&&x.method==='POST').length;
  const curate=await context.newPage();await curate.goto(server.origin);await navigate(curate,'Filas');
  const quality=curate.getByRole('region',{name:'Curadoria até o acervo',exact:true});
  const result=responseFor(curate,'/api/reels/quality',url=>url.searchParams.get('q')==='Receita publicada');
  await quality.getByLabel('Buscar Reel na curadoria',{exact:true}).fill('Receita publicada');const qualityData=await (await result).json();
  assert.equal(qualityData.matched,1);assert.equal(qualityData.items[0].reelId,'QaPub_food');assert.equal(qualityData.items[0].publication.qualityPolicyVersion,'historical_baseline');
  await quality.getByText('Publicação histórica · regra anterior',{exact:true}).waitFor();
  await quality.getByRole('button',{name:/Receita publicada/}).click();
  const detail=curate.getByRole('dialog',{name:'Receita publicada',exact:true}),proof=detail.getByRole('region',{name:'Contexto desta publicação',exact:true});
  const chicken=proof.locator('.contextual-attribute-list article').filter({has:curate.getByText('Frango',{exact:true})}).filter({has:curate.getByText('300g de frango',{exact:true})});
  await chicken.getByText('Elemento de apoio',{exact:false}).waitFor();await chicken.getByText('Por que este elemento aparece',{exact:true}).click();await chicken.getByText('300g de frango',{exact:true}).waitFor();await closeDialog(curate);
  await navigate(curate,'Categorias');await curate.getByRole('region',{name:'Curadoria do acervo',exact:true}).getByRole('heading',{name:'Contextos, elementos e recorrências',exact:true}).waitFor();
  await navigate(curate,'Filas');assert.equal(await quality.getByLabel('Buscar Reel na curadoria',{exact:true}).inputValue(),'Receita publicada');
  await navigate(curate,'Categorias');const contextPanel=curate.getByRole('region',{name:'Curadoria do acervo',exact:true});
  const library=responseFor(curate,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&(url.searchParams.get('facets')||'').includes('"value":"frango"'));
  await contextPanel.locator('.contextual-elements button').filter({has:curate.getByText('Frango',{exact:true})}).click();const filtered=await (await library).json();
  assert.equal(filtered.total,1);await curate.locator('.library-card').filter({hasText:'Receita publicada'}).waitFor();assert.equal(await curate.locator('.library-card').count(),1);
  const facetDetails=curate.locator('.contextual-library-filters');assert.equal(await facetDetails.getByLabel('Elemento 1',{exact:true}).inputValue(),'frango');
  const sameUnit=responseFor(curate,'/api/reels/items',url=>(url.searchParams.get('facets')||'').includes('SAME_UNIT'));
  await facetDetails.getByLabel('Relação 1',{exact:true}).selectOption('SAME_UNIT');const unproven=await (await sameUnit).json();assert.equal(unproven.total,0,'Missing unit proof must not satisfy SAME_UNIT');
  await curate.getByText('Nenhum registro nesta seleção',{exact:true}).waitFor();
  const any=responseFor(curate,'/api/reels/items',url=>(url.searchParams.get('facets')||'').includes('"quantifier":"ANY"'));await facetDetails.getByLabel('Relação 1',{exact:true}).selectOption('ANY');assert.equal((await (await any).json()).total,1);
  await navigate(curate,'Financeiro');await navigate(curate,'Biblioteca');await curate.locator('.library-card').filter({hasText:'Receita publicada'}).waitFor();assert.equal(await facetDetails.getByLabel('Elemento 1',{exact:true}).inputValue(),'frango');
  const clear=responseFor(curate,'/api/reels/items',url=>!url.searchParams.get('facets'));await facetDetails.getByRole('button',{name:'Limpar elementos',exact:true}).click();await clear;if(await facetDetails.getAttribute('open')===null)await facetDetails.locator('summary').first().click();
  const mentions=responseFor(curate,'/api/reels/contextual',url=>url.searchParams.get('facetMode')==='mentioned');await facetDetails.getByLabel('Papel dos elementos',{exact:true}).selectOption('mentioned');const mentionsData=await (await mentions).json();
  const fryer=mentionsData.facets.find(f=>f.dimensionId==='tool'&&f.valueId==='air-fryer');assert.ok(fryer,'Saved literal reference must be available as a mention');assert.equal(fryer.supportCount,0);assert.equal(fryer.mentionedCount,1);
  assert.equal(server.calls.filter(x=>['/api/reels/commands','/api/reels/categories'].includes(x.path)&&x.method==='POST').length,writeCount,'Read-only curation must not issue commands or write taxonomy');
  await curate.screenshot({path:join(output,'reels-two-curations-contextual.png'),fullPage:true});await curate.close();
 });


 await record('contextual_same_dimension_or_preserves_options_and_source_age_metadata',async()=>{
  const template=structuredClone((await server.store.get('videos/QaPub_food')).data),id='QaPub_fish',oldSource='2020-01-02T03:04:05.000Z';
  const fish={...template,id,title:'Receita de peixe publicada',analysis_key:'qa/'+id+'/published.json',source_url:'https://www.instagram.com/reel/'+id+'/',source_caption:{capture_id:'qa-fish-caption',source:'instagram',text:'300g de peixe.'}};
  fish.analysis={...template.analysis,title:fish.title,summary:'Receita de peixe salva para a navegação.',source_consolidation:{sources:[{source:'caption',capture_id:'qa-fish-caption',text:'300g de peixe.'}]},knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Peixe',value:'300g',role:'supporting',polarity:'positive',evidence:[{source:'caption',excerpt:'300g de peixe',start_seconds:0,end_seconds:0}]}]}};
  await server.store.create('videos/'+id,fish);await server.seedSavedContributions([id]);
  const orPage=await context.newPage();
  try {
   await orPage.goto(server.origin);await navigate(orPage,'Biblioteca');await orPage.locator('.library-card').filter({hasText:'Receita de peixe publicada'}).waitFor();
   const filters=orPage.locator('.contextual-library-filters');await filters.locator('summary').first().click();
   await filters.getByLabel('Dimensão 1',{exact:true}).selectOption('ingredient');
   const chicken=responseFor(orPage,'/api/reels/items',url=>(url.searchParams.get('facets')||'').includes('"value":"frango"'));
   await filters.getByLabel('Elemento 1',{exact:true}).selectOption('frango');assert.equal((await (await chicken).json()).total,1);
   await filters.getByRole('button',{name:'+ Cruzar outro elemento',exact:true}).click();await filters.getByLabel('Dimensão 2',{exact:true}).selectOption('ingredient');
   await filters.getByLabel('Elemento 2',{exact:true}).locator('option[value="peixe"]').waitFor({state:'attached'});
   assert.equal(await filters.getByLabel('Relação 2',{exact:true}).inputValue(),'ANY','A new row in an existing dimension must inherit its group relation');
   const union=responseFor(orPage,'/api/reels/items',url=>{const values=JSON.parse(url.searchParams.get('facets')||'[]').filter(f=>f.dimension==='ingredient'&&f.quantifier==='ANY').map(f=>f.value);return values.includes('frango')&&values.includes('peixe');});
   await filters.getByLabel('Elemento 2',{exact:true}).selectOption('peixe');assert.equal((await (await union).json()).total,2);
   await orPage.locator('.library-card').filter({hasText:'Receita publicada'}).waitFor();await orPage.locator('.library-card').filter({hasText:'Receita de peixe publicada'}).waitFor();
   for(const relation of ['ALL','SAME_UNIT','ANY']){
    const grouped=responseFor(orPage,'/api/reels/items',url=>{const facets=JSON.parse(url.searchParams.get('facets')||'[]');return facets.length===2&&facets.every(f=>f.dimension==='ingredient'&&f.quantifier===relation);});
    await filters.getByLabel('Relação 1',{exact:true}).selectOption(relation);const response=await grouped;assert.equal(response.status(),200);assert.equal((await response.json()).total,relation==='ANY'?2:0);
    assert.equal(await filters.getByLabel('Relação 2',{exact:true}).inputValue(),relation,'Changing relation updates every value in the same dimension');
   }

   // Explicit synthetic metadata injection checks presentation only. Backend
   // tests separately prove sourceStale/dataAsOf originate from a failed refresh.
   server.staleNext('/api/reels/contextual',oldSource,2);
   const staleFilters=responseFor(orPage,'/api/reels/contextual',(_,r)=>r.status()===200);
   await orPage.getByRole('button',{name:'↻ Atualizar',exact:true}).click();await staleFilters;
   await filters.locator('.curation-source[data-source-asof="'+oldSource+'"]').getByRole('status').filter({hasText:'Leitura anterior preservada'}).waitFor();
   const detailPath='/api/reels/contextual/QaPub_food';server.staleNext(detailPath,oldSource);await orPage.locator('.library-card').filter({hasText:'Receita publicada'}).click();
   const detail=orPage.getByRole('dialog',{name:'Receita publicada',exact:true}).getByRole('region',{name:'Contexto desta publicação',exact:true});
   await detail.locator('.curation-source[data-source-asof="'+oldSource+'"]').getByRole('status').filter({hasText:'Leitura anterior preservada'}).waitFor();await closeDialog(orPage);
   server.staleNext('/api/reels/contextual',oldSource);await navigate(orPage,'Categorias');
   await orPage.getByRole('region',{name:'Curadoria do acervo',exact:true}).locator('.curation-source[data-source-asof="'+oldSource+'"]').getByRole('status').filter({hasText:'Leitura anterior preservada'}).waitFor();
  } finally {await orPage.close();server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_index/contextual_'+id);}
 });


 await record('contextual_browse_preserves_creator_query_and_explicit_empty_scope',async()=>{
  const source=structuredClone((await server.store.get('videos/QaPub_food')).data),id='QaPub_bia';
  await server.store.create('videos/'+id,{...source,id,title:'Preparo da Bia',creator:'Criadora Bia',analysis_key:'qa/'+id+'/published.json',source_url:'https://www.instagram.com/reel/'+id+'/'});await server.seedSavedContributions([id]);
  const scope=await context.newPage();
  try {
   await scope.goto(server.origin);await navigate(scope,'Biblioteca');await search(scope,'Modelo');await scope.locator('.library-card').filter({hasText:'Modelo publicado'}).waitFor();
   await navigate(scope,'Categorias');const curator=scope.getByRole('region',{name:'Curadoria do acervo',exact:true});
   const creator=responseFor(scope,'/api/reels/contextual',url=>url.searchParams.get('q')==='Criadora Bia');
   await curator.getByLabel('Buscar publicações neste recorte',{exact:true}).fill('Criadora Bia');const creatorData=await (await creator).json();assert.equal(creatorData.total,1);assert.equal(creatorData.facets.find(f=>f.dimensionId==='ingredient'&&f.valueId==='frango').supportCount,1);
   const library=responseFor(scope,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&url.searchParams.get('q')==='Criadora Bia'&&(url.searchParams.get('facets')||'').includes('"value":"frango"'));
   await curator.locator('.contextual-elements button').filter({has:scope.getByText('Frango',{exact:true})}).click();const sameScope=await (await library).json();assert.equal(sameScope.total,1);assert.deepEqual(sameScope.items.map(i=>i.id),[id]);assert.equal(await scope.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'Criadora Bia');await scope.locator('.library-card').filter({hasText:'Preparo da Bia'}).waitFor();assert.equal(await scope.locator('.library-card').count(),1);
   await navigate(scope,'Categorias');assert.equal(await curator.getByLabel('Buscar publicações neste recorte',{exact:true}).inputValue(),'Criadora Bia');
   const clear=responseFor(scope,'/api/reels/contextual',url=>!url.searchParams.get('q'));await curator.getByLabel('Buscar publicações neste recorte',{exact:true}).fill('');const allContext=await (await clear).json();assert.equal(allContext.facets.find(f=>f.dimensionId==='ingredient'&&f.valueId==='frango').supportCount,2);
   const allChicken=responseFor(scope,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&!url.searchParams.get('q')&&(url.searchParams.get('facets')||'').includes('"value":"frango"'));
   await curator.locator('.contextual-elements button').filter({has:scope.getByText('Frango',{exact:true})}).click();const cleared=await (await allChicken).json();assert.equal(cleared.total,2);assert.deepEqual(cleared.items.map(i=>i.id).sort(),['QaPub_food',id].sort());assert.equal(await scope.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'');
   await scope.locator('.library-card').filter({hasText:'Preparo da Bia'}).waitFor();await scope.locator('.library-card').filter({hasText:'Receita publicada'}).waitFor();
  } finally {await scope.close();server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_index/contextual_'+id);}
 });




 await record('full_catalogue_formats_ingredient_filters_and_incremental_source_replacement',async()=>{
  // All source records, independent reviews, event projections and UI checks
  // below run in GitHub Actions only. No accepted-publication provider is called.
  const fixture=makeFullCatalogueFixture(),sources=fixture.records.map(record=>JSON.parse(record.sourceJson)),ids=sources.map(source=>source.item.id),cataloguePage=await context.newPage();
  for(const source of sources){assert.equal((await server.store.create('videos/'+source.item.id,source.video)).created,true);if(source.legacy)assert.equal((await server.store.create('reels_legacy_content/'+source.item.id,source.legacy)).created,true);}
  for(const review of fixture.formatReviews)await server.store.create('reels_index/contextual_review_'+review.reelId,{kind:'contextual_review',reelId:review.reelId,reviewHash:contextualHash(review),review});
  await server.seedSavedContributions(ids);
  const beforeCommands=server.calls.filter(call=>call.path==='/api/reels/commands'&&call.method==='POST').length;
  const contributionCount=()=>[...server.store.docs.values()].filter(record=>record.data?.kind==='contextual_contribution'&&record.data.status==='active').length;
  try {
   const catalogueResponse=responseFor(cataloguePage,'/api/reels/curation/catalogue');await cataloguePage.goto(server.origin);await navigate(cataloguePage,'Categorias');const catalogue=await (await catalogueResponse).json();
   assert.equal(catalogue.processingStarted,false);assert.equal(catalogue.projectionCoverage.inventoryCount,7);assert.equal(catalogue.projectionCoverage.evaluatedCount,7);assert.equal(catalogue.projectionCoverage.missingCount,0);
   assert.deepEqual(catalogue.formats.find(format=>format.value==='single_recipe').matchingIds,['QaFull_single']);assert.deepEqual(catalogue.formats.find(format=>format.value==='recipe_collection').matchingIds,['QaFull_many']);assert.ok(catalogue.projectionCoverage.unknownContextCount>=1);assert.ok(catalogue.projectionCoverage.formatUnknownCount>=1);
   const panel=cataloguePage.getByRole('region',{name:'Catálogo do acervo publicado',exact:true});await panel.getByText('Fontes avaliadas pelo catálogo',{exact:true}).waitFor();
   server.store.docs.delete('reels_index/contextual_QaFull_unknown');
   const missingRead=responseFor(cataloguePage,'/api/reels/curation/catalogue');await cataloguePage.getByRole('button',{name:'↻ Atualizar',exact:true}).click();const missing=await (await missingRead).json();assert.equal(missing.projectionCoverage.inventoryCount,7);assert.equal(missing.projectionCoverage.evaluatedCount,6);assert.equal(missing.projectionCoverage.missingCount,1);assert.equal(await server.store.get('reels_index/contextual_QaFull_unknown'),null,'Catalogue GET must disclose missing data, never rebuild it as a write side effect');
   await server.seedSavedContributions(['QaFull_unknown']);const restoredRead=responseFor(cataloguePage,'/api/reels/curation/catalogue');await cataloguePage.getByRole('button',{name:'↻ Atualizar',exact:true}).click();const restored=await (await restoredRead).json();assert.equal(restored.projectionCoverage.evaluatedCount,7);assert.equal(restored.projectionCoverage.missingCount,0);
await panel.getByText('Desconhecido não significa erro de processamento.',{exact:false}).waitFor();assert.equal(await panel.getByText('em ao menos um preparo',{exact:false}).count(),0);
   const single=responseFor(cataloguePage,'/api/reels/items',url=>url.searchParams.get('category')==='ctx_format_single_recipe');await panel.getByRole('button',{name:'Explorar formato Receita única',exact:true}).click();assert.deepEqual((await (await single).json()).items.map(item=>item.id),['QaFull_single']);
   const tree=cataloguePage.locator('.library-navigation');await tree.locator('.tree-name[aria-pressed=true]').filter({hasText:'Receita única'}).waitFor();await tree.locator('.tree-name').filter({hasText:'Várias receitas'}).waitFor();assert.equal(await tree.locator('.tree-name').filter({hasText:/Receitas com (Frango|Ovo)/}).count(),0);
   const ingredient=cataloguePage.getByRole('button',{name:'Filtrar ingrediente Frango',exact:true});const chicken=responseFor(cataloguePage,'/api/reels/items',url=>url.searchParams.get('category')==='ctx_format_single_recipe'&&(url.searchParams.get('facets')||'').includes('"value":"frango"'));await ingredient.click();assert.deepEqual((await (await chicken).json()).items.map(item=>item.id),['QaFull_single']);assert.equal(await ingredient.getAttribute('aria-pressed'),'true');
   await search(cataloguePage,'QaFull_single');await cataloguePage.locator('.library-card').filter({hasText:'QaFull_single'}).waitFor();
   const beforeToggle=server.calls.filter(call=>call.path==='/api/reels/items').length;await tree.getByRole('button',{name:'Recolher Receitas',exact:true}).click();await tree.locator('button[aria-label="Expandir Receitas"]:not([disabled])').click();assert.equal(server.calls.filter(call=>call.path==='/api/reels/items').length,beforeToggle);
   await navigate(cataloguePage,'Financeiro');await navigate(cataloguePage,'Biblioteca');await cataloguePage.locator('.library-card').filter({hasText:'QaFull_single'}).waitFor();assert.equal(await cataloguePage.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'QaFull_single');assert.equal(await ingredient.getAttribute('aria-pressed'),'true');await tree.locator('.tree-name[aria-pressed=true]').filter({hasText:'Receita única'}).waitFor();
   await navigate(cataloguePage,'Categorias');const many=responseFor(cataloguePage,'/api/reels/items',url=>url.searchParams.get('category')==='ctx_format_recipe_collection'&&!url.searchParams.get('q'));await panel.getByRole('button',{name:'Explorar formato Várias receitas',exact:true}).click();assert.deepEqual((await (await many).json()).items.map(item=>item.id),['QaFull_many']);
   await tree.locator('.tree-name[aria-pressed=true]').filter({hasText:'Várias receitas'}).waitFor();assert.equal(await cataloguePage.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'');
   const filters=cataloguePage.locator('.contextual-library-filters');await filters.locator('summary').first().click();await filters.getByLabel('Dimensão 1',{exact:true}).selectOption('ingredient');await filters.getByLabel('Relação 1',{exact:true}).selectOption('SAME_UNIT');await filters.getByLabel('Elemento 1',{exact:true}).selectOption('frango');await filters.getByRole('button',{name:'+ Cruzar outro elemento',exact:true}).click();await filters.getByLabel('Dimensão 2',{exact:true}).selectOption('tool');
   const crossed=responseFor(cataloguePage,'/api/reels/items',url=>{const facets=JSON.parse(url.searchParams.get('facets')||'[]');return url.searchParams.get('category')==='ctx_format_recipe_collection'&&facets.some(f=>f.value==='frango')&&facets.some(f=>f.value==='forno')&&facets.every(f=>f.quantifier==='SAME_UNIT');});
   await filters.getByLabel('Elemento 2',{exact:true}).selectOption('forno');assert.equal((await (await crossed).json()).total,0,'A collection must not combine chicken from one preparation with an oven from another');
   const derivedBefore=await server.store.get('reels_index/contextual_QaFull_single');await server.store.patch('reels_index/contextual_QaFull_single',{obsoleteFixtureMarker:true},{updateTime:derivedBefore.updateTime});
   const documentPath='videos/QaFull_single',source=await server.store.get(documentPath),changed=JSON.parse(JSON.stringify(source.data).replaceAll('Frango','Peixe').replaceAll('frango','peixe'));changed.analysis_generation='8';await server.store.patch(documentPath,changed,{updateTime:source.updateTime});
   await server.seedSavedContributions(['QaFull_single'],{type:'sourceCorrected'});const contributionPath='reels_index/contextual_QaFull_single',current=await server.store.get(contributionPath),uniqueBefore=contributionCount();assert.equal(Object.hasOwn(current.data,'obsoleteFixtureMarker'),false,'Derived CAS must replace the complete old contribution');const rejected=await server.store.compareAndReplaceDerived({path:contributionPath,replacement:current.data,checks:[{path:documentPath,updateTime:source.updateTime},{path:contributionPath,updateTime:current.updateTime}]});assert.equal(rejected.applied,false);assert.deepEqual(await server.store.get(contributionPath),current);await server.seedSavedContributions(['QaFull_single'],{type:'sourceCorrected'});assert.equal((await server.store.get(contributionPath)).updateTime,current.updateTime,'Repeating the same source event must not write or inflate a contribution');assert.equal(contributionCount(),uniqueBefore);
   await navigate(cataloguePage,'Categorias');const refresh=responseFor(cataloguePage,'/api/reels/curation/catalogue');await cataloguePage.getByRole('button',{name:'↻ Atualizar',exact:true}).click();const replaced=await (await refresh).json();assert.equal(replaced.projectionCoverage.inventoryCount,7);assert.equal(replaced.projectionCoverage.evaluatedCount,7);assert.equal(replaced.projectionCoverage.missingCount,0);assert.equal(replaced.formats.find(format=>format.value==='single_recipe').count,0,'An old review cannot certify a changed source');assert.deepEqual(replaced.formats.find(format=>format.value==='recipe_collection').matchingIds,['QaFull_many']);assert.ok(replaced.ingredients.some(ingredient=>ingredient.valueId==='peixe'&&ingredient.supportCount>=1));
   assert.equal(server.calls.filter(call=>call.path==='/api/reels/commands'&&call.method==='POST').length,beforeCommands);assert.deepEqual(server.externalAttempts,[]);await cataloguePage.screenshot({path:join(output,'reels-full-catalogue-formats.png'),fullPage:true});
  } finally {
   await cataloguePage.close();for(const id of ids){server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_legacy_content/'+id);server.store.docs.delete('reels_index/contextual_'+id);server.store.docs.delete('reels_index/contextual_review_'+id);}
  }
 });

 await record('calibration_without_an_audit_does_not_claim_automatic_categories',async()=>{
  const noAudit=await context.newPage(),read=responseFor(noAudit,'/api/reels/curation/calibration');
  try {
   await noAudit.goto(server.origin);await navigate(noAudit,'Categorias');await noAudit.getByText('Avaliação inicial de agrupamentos',{exact:true}).click();const data=await (await read).json();assert.equal(data.available,false);assert.equal(data.processingStarted,false);
   const panel=noAudit.getByRole('region',{name:'Calibração de agrupamentos',exact:true});await panel.getByText('A calibração ainda não está disponível. Isso não invalida as publicações preservadas.',{exact:true}).waitFor();assert.equal(await panel.getByText('Calibrado neste acervo',{exact:true}).count(),0);
  } finally {await noAudit.close();}
 });


 await record('finite_calibration_real_api_shows_audited_denominators_members_and_limits',async()=>{
  // This helper creates independently annotated synthetic saved sources. Both
  // preparation and the browser journey execute only inside GitHub Actions.
  const input=makeContextualCalibrationFixture(),{calibration,plan}=prepareContextualCategoryPlan(input),path='settings/reels_v2_contextual_calibration',taxonomyPath='settings/reels_v2_taxonomy',beforeTaxonomy=(await server.store.get(taxonomyPath)).data;
  const sources=input.records.map(r=>JSON.parse(r.sourceJson)),ids=sources.map(source=>source.item.id),calibrationPage=await context.newPage();
  for(const source of sources)assert.equal((await server.store.create('videos/'+source.item.id,source.video)).created,true);
  await server.seedSavedContributions(ids);
  const taxonomyRecord=await server.store.get(taxonomyPath);await server.store.patch(taxonomyPath,{nodes:[...beforeTaxonomy.nodes,...input.taxonomy.data.nodes.filter(node=>!beforeTaxonomy.nodes.some(existing=>existing.id===node.id))]},{updateTime:taxonomyRecord.updateTime});
  await server.store.create(path,{schemaVersion:1,planHash:plan.planHash,sourceHash:plan.sourceCorpusHash,report:calibrationReportView(calibration,plan)});
  const beforeCommands=server.calls.filter(c=>c.path==='/api/reels/commands'&&c.method==='POST').length;
  try {
   const read=responseFor(calibrationPage,'/api/reels/curation/calibration');await calibrationPage.goto(server.origin);await navigate(calibrationPage,'Categorias');await calibrationPage.getByText('Avaliação inicial de agrupamentos',{exact:true}).click();const data=await (await read).json();
   assert.equal(data.available,true);assert.equal(data.processingStarted,false);assert.equal(data.evaluatedCount,input.records.length);assert.equal(data.inventoryCount,input.catalog.length);assert.equal(data.unknownCount,input.catalog.length-input.records.length);
   assert.ok(data.groups.some(group=>group.state==='calibrated'));assert.ok(data.groups.some(group=>group.state==='insufficient'));assert.ok(data.groups.every(group=>!group.appliedCategoryId),'A calibrated plan must not appear already applied');
   const panel=calibrationPage.getByRole('region',{name:'Calibração de agrupamentos',exact:true});await panel.getByText('Calibrado neste acervo',{exact:true}).first().waitFor();await panel.getByText('Evidências insuficientes',{exact:true}).first().waitFor();assert.equal(await panel.getByRole('button',{name:'Abrir grupo na Biblioteca →',exact:true}).count(),0);
   const group=data.groups.find(group=>group.state==='calibrated'&&group.members.length>0),card=panel.locator('.contextual-patterns>article[data-group-id="'+group.id+'"]');await card.getByText(group.reason||'As fontes e os membros deste recorte atenderam aos critérios versionados da avaliação.',{exact:true}).waitFor();assert.equal(await card.getByText('Critério ainda não informado.',{exact:true}).count(),0);await card.getByText('Publicações e métricas deste agrupamento',{exact:true}).click();
   await card.getByRole('region',{name:'Conferência independente',exact:true}).getByText(String(group.metrics.holdout.total),{exact:true}).first().waitFor();assert.equal(new Set(group.members.map(m=>m.id)).size,group.members.length);
   const member=group.members[0],browse=responseFor(calibrationPage,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&url.searchParams.get('q')===member.id);
   await card.getByRole('button',{name:member.title||'Ver Reel '+member.id,exact:true}).click();const memberData=await (await browse).json();assert.equal(memberData.items.some(item=>item.id===member.id),true);

   // Ingredient calibration is retained as historical evidence. Current recipe
   // format navigation is exercised by the full-catalogue journey below.
   for(const source of sources)assert.deepEqual((await server.store.get('videos/'+source.item.id)).data,source.video,'Historical calibration browsing must preserve every raw publication');
   assert.equal(server.calls.filter(c=>c.path==='/api/reels/commands'&&c.method==='POST').length,beforeCommands);assert.deepEqual(server.externalAttempts,[]);
  } finally {
   await calibrationPage.close();server.store.docs.delete(path);for(const id of ids){server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_index/contextual_'+id);}
   const current=await server.store.get(taxonomyPath);await server.store.patch(taxonomyPath,beforeTaxonomy,{updateTime:current.updateTime});
  }
 });

 await record('saved_quality_is_on_demand_read_only_and_does_not_recertify_history',async()=>{
  const qualityPage=await context.newPage(),before=server.calls.filter(c=>c.path==='/api/reels/quality/saved').length,template=structuredClone((await server.store.get('videos/QaPub_tech')).data);
  const ids=Array.from({length:26},(_,i)=>'QaSaved_'+String(i).padStart(3,'0'));
  for(const id of ids)await server.store.create('videos/'+id,{...structuredClone(template),id,title:'Publicação para conferência '+id,source_url:'https://www.instagram.com/reel/'+id+'/',analysis_key:'qa/'+id+'/published.json'});
  const commandCount=server.calls.filter(c=>c.path==='/api/reels/commands'&&c.method==='POST').length,foodBefore=structuredClone((await server.store.get('videos/QaPub_food')).data);
  try {
   await qualityPage.goto(server.origin);await navigate(qualityPage,'Filas');await qualityPage.getByRole('region',{name:'Curadoria até o acervo',exact:true}).getByRole('heading',{name:'Resultados e diagnósticos por Reel',exact:true}).waitFor();
   assert.equal(server.calls.filter(c=>c.path==='/api/reels/quality/saved').length,before,'Saved-source diagnostics must not load before the user opens them');
   const saved=qualityPage.locator('.saved-quality'),first=responseFor(qualityPage,'/api/reels/quality/saved',url=>url.searchParams.get('limit')==='25'&&!url.searchParams.get('cursor'));
   await saved.locator('summary').first().click();const firstData=await (await first).json();assert.equal(firstData.processingStarted,false);assert.equal(firstData.semanticQualityMeasured,false);assert.equal(firstData.items.length,25);assert.ok(firstData.nextCursor);
   assert.ok(firstData.items.every(item=>item.historical===true&&!['QaUnknown','QaFail_01'].includes(item.reelId)));
   await saved.getByText('A qualidade semântica universal não foi medida.',{exact:false}).waitFor();assert.equal(await saved.locator('tbody tr').count(),25);
   const next=responseFor(qualityPage,'/api/reels/quality/saved',url=>!!url.searchParams.get('cursor'));await saved.getByRole('button',{name:'Próxima da conferência →',exact:true}).click();const nextData=await (await next).json();assert.ok(nextData.items.length>0&&nextData.items.length<=25);assert.equal(nextData.items.some(item=>firstData.items.some(prior=>prior.reelId===item.reelId)),false);
   const food=responseFor(qualityPage,'/api/reels/quality/saved',url=>url.searchParams.get('q')==='QaPub_food'&&!url.searchParams.get('cursor'));await saved.getByLabel('Buscar diagnóstico salvo',{exact:true}).fill('QaPub_food');const foodData=await (await food).json();assert.deepEqual(foodData.items.map(item=>item.reelId),['QaPub_food']);assert.equal(foodData.items[0].historical,true);
   assert.ok(['supported','present_unverified','unknown','inconclusive','invalid','not_recorded','not_applicable'].includes(foodData.items[0].state));await saved.getByText('Publicação histórica preservada',{exact:true}).waitFor();assert.equal(await saved.locator('tbody tr').count(),1);
   assert.equal(server.calls.filter(c=>c.path==='/api/reels/commands'&&c.method==='POST').length,commandCount);assert.deepEqual(server.externalAttempts,[]);assert.deepEqual((await server.store.get('videos/QaPub_food')).data,foodBefore,'Offline diagnostics must preserve the published record');assert.equal(await saved.getByRole('alert').count(),0);
   await qualityPage.screenshot({path:join(output,'reels-saved-quality-on-demand.png'),fullPage:true});
  } finally {await qualityPage.close();for(const id of ids){server.store.docs.delete('videos/'+id);server.store.docs.delete('reels_index/contextual_'+id);}}
 });

 await record('discovery_first_preview_global_scope_and_preserved_legacy_evidence_gaps',async()=>{
  await navigate(page,'Categorias');await page.locator('.tree-name').filter({hasText:'Tecnologia'}).click();await page.getByText('Regras de segmentação anteriores',{exact:true}).click();await page.getByRole('button',{name:'Avaliar recorrências',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Avaliar recorrências',exact:true});
  const response=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Calcular prévia de impacto',exact:true}).click();const planned=await response;assert.equal(planned.status(),200);const data=await planned.json();assert.equal(data.preview.action,'discover');
  const body=server.calls.filter(x=>x.path==='/api/reels/categories').at(-1).body;assert.equal(body.id,undefined);assert.equal(body.backfillCursor,undefined);assert.ok(data.preview.coverage.missing>0);
  const saved=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Confirmar alteração persistente',exact:true}).click();assert.equal((await saved).status(),200);await dialog.getByRole('status').filter({hasText:'Alteração persistida.'}).waitFor();await closeDialog(page);
  await page.getByText('Regras de segmentação anteriores',{exact:true}).waitFor();await page.getByText('Publicações que precisam de complemento para segmentar',{exact:true}).waitFor();await page.screenshot({path:join(output,'reels-categories-discovery-desktop.png'),fullPage:true});
 });
 await record('category_descendant_browse_and_broad_reclassification_preview_token',async()=>{
  await navigate(page,'Categorias');await page.locator('.tree-name').filter({hasText:'Tecnologia'}).click();
  const browse=responseFor(page,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&url.searchParams.get('category')==='cat_tech');await page.getByRole('button',{name:'Explorar na Biblioteca ↗',exact:true}).click();await browse;
  await page.locator('.library-card').filter({hasText:'Modelo publicado'}).waitFor();assert.equal(await page.locator('.library-card').count(),1);await page.locator('.library-navigation .tree-name[aria-pressed=true]').filter({hasText:'Tecnologia'}).waitFor();assert.equal(await page.getByLabel('Etapa / fila',{exact:true}).count(),0);
  await navigate(page,'Categorias');await page.getByRole('button',{name:'Organizar conteúdos',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Organizar conteúdos',exact:true});
  await dialog.getByLabel('Conteúdos do ramo',{exact:true}).selectOption('');await dialog.getByLabel('Organizar Modelo publicado',{exact:true}).check();await dialog.getByLabel('Organizar Receita publicada',{exact:true}).check();await dialog.getByLabel('Categoria de destino',{exact:true}).selectOption('cat_models');
  const previewResponse=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Calcular prévia de impacto',exact:true}).click();const planned=await (await previewResponse).json();assert.equal(planned.preview.affected,2);
  const mutation=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Confirmar alteração persistente',exact:true}).click();const result=await mutation;assert.equal(result.status(),200);assert.equal((await result.json()).affected,2);await dialog.getByRole('status').filter({hasText:'Alteração persistida.'}).waitFor();
  const writes=server.calls.filter(x=>x.path==='/api/reels/categories'&&x.method==='POST');assert.equal(writes.at(-2).body.idempotencyKey,writes.at(-1).body.idempotencyKey);await closeDialog(page);
  await page.locator('.tree-name').filter({hasText:'Tecnologia'}).click();await page.getByRole('button',{name:'Segmentar por evidências',exact:true}).click();const segment=page.getByRole('dialog',{name:'Segmentar por evidências',exact:true});
  const confidence=segment.getByLabel('Confiança mínima (0,5 a 1)');assert.equal(await confidence.inputValue(),'0.8');assert.equal(await confidence.getAttribute('min'),'0.5');const segmentPreview=postFor(page,'/api/reels/categories');await segment.getByRole('button',{name:'Calcular prévia de impacto',exact:true}).click();assert.equal((await segmentPreview).status(),200);await segment.getByRole('heading',{name:'Impacto calculado no servidor',exact:true}).waitFor();await closeDialog(page);
 });
 await record('queue_capacity_desired_effective_persisted_receipt_and_stage_filter',async()=>{
  await navigate(page,'Filas');const analysis=page.locator('.queue-card').filter({has:page.getByRole('heading',{name:'Análise',exact:true})});
  await analysis.getByRole('button',{name:'Capacidade',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Ajustar capacidade · Análise e publicação',exact:true});await dialog.getByLabel('Concorrência desejada').fill('11');
  const changed=postFor(page,'/api/reels/commands');await dialog.getByRole('button',{name:'Ajustar capacidade no servidor',exact:true}).click();const result=await changed;assert.equal(result.status(),200);const {operation}=await result.json();assert.equal(operation.status,'completed');await closeDialog(page);
  await analysis.getByText('Última capacidade observada: 2 · Desejada: 11',{exact:true}).waitFor();await page.getByText('Última operação persistida',{exact:true}).waitFor();
  await page.reload();await page.getByText(operation.id,{exact:true}).waitFor();assert.ok(server.calls.some(x=>x.path==='/api/reels/commands/'+operation.id));
  await navigate(page,'Filas');const stage=responseFor(page,'/api/reels/items',url=>url.searchParams.get('stage')==='analysis');await page.locator('.queue-card').filter({has:page.getByRole('heading',{name:'Análise',exact:true})}).locator('.queue-title').click();await stage;await page.getByRole('button',{name:/Análise aguardando externo/}).waitFor();assert.equal(await page.getByLabel('Etapa / fila',{exact:true}).inputValue(),'analysis');
 });
 await record('attention_uncertainty_and_safe_retry_server_denial',async()=>{
  await navigate(page,'Precisa de atenção');await page.getByRole('button',{name:'Resultados inconclusivos',exact:true}).click();const worker=responseFor(page,'/api/reels/items',url=>url.searchParams.get('worker')==='qa-worker');await page.getByLabel('Worker',{exact:true}).fill('qa-worker');await worker;
  const destination=responseFor(page,'/api/reels/items',url=>url.searchParams.get('destination')==='reconcile');await page.getByLabel('Destino',{exact:true}).fill('reconcile');await destination;
  const occurrence=page.locator('tbody tr').filter({hasText:'Resultado incerto'});await occurrence.getByText('Resultado a conferir',{exact:true}).waitFor();await occurrence.getByText('Conferir resultado salvo',{exact:false}).waitFor();assert.ok(!(await occurrence.innerText()).includes('RECONCILIATION_REQUIRED'));await occurrence.getByText('Detalhes da ocorrência',{exact:true}).click();assert.ok((await occurrence.innerText()).includes('RECONCILIATION_REQUIRED'));await occurrence.getByText('Detalhes da ocorrência',{exact:true}).click();
  await page.getByRole('button',{name:/Resultado incerto/}).click();const dialog=page.getByRole('dialog',{name:'Resultado incerto',exact:true});const detailOccurrence=dialog.locator('.detail-video .notice.warning');await detailOccurrence.getByRole('heading',{name:'Resultado a conferir',exact:true}).waitFor();await detailOccurrence.getByText('Conferir resultado salvo',{exact:true}).waitFor();assert.ok(!/RECONCILIATION_REQUIRED|reconcile/.test(await detailOccurrence.innerText()));await detailOccurrence.getByText('Detalhes da ocorrência',{exact:true}).click();const originalError=JSON.parse(await detailOccurrence.locator('pre').innerText());assert.equal(originalError.code,'RECONCILIATION_REQUIRED');assert.equal(originalError.destination,'reconcile');assert.equal(originalError.uncertain,true);await detailOccurrence.getByText('Detalhes da ocorrência',{exact:true}).click();await page.screenshot({path:join(output,'reels-attention-detail-readable.png'),fullPage:true});await dialog.getByRole('button',{name:'Detalhes',exact:true}).click();
  const retry=dialog.getByRole('button',{name:'Solicitar retomada ao servidor',exact:true});assert.equal(await retry.count(),0);await dialog.getByText('Concilie a conclusão externa antes de repetir. A API preserva a incerteza.',{exact:true}).waitFor();await closeDialog(page);
  const reset=responseFor(page,'/api/reels/items',url=>!url.searchParams.get('destination')&&!url.searchParams.get('worker'));await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await reset;
  const confirmedItems=responseFor(page,'/api/reels/items',url=>url.searchParams.get('attentionKind')==='confirmed');await page.getByRole('button',{name:'Falhas confirmadas',exact:true}).click();await confirmedItems;await page.getByRole('button',{name:/Falha confirmada/}).click();const confirmed=page.getByRole('dialog',{name:'Falha confirmada',exact:true});await confirmed.getByRole('button',{name:'Detalhes',exact:true}).click();const denied=postFor(page,'/api/reels/commands');await confirmed.getByRole('button',{name:'Solicitar retomada ao servidor',exact:true}).click();assert.equal((await denied).status(),423);await confirmed.getByRole('alert').filter({hasText:'PROCESSING_DISABLED'}).waitFor();await closeDialog(page);
 });
 await record('attention_batch_and_all_retry_exclude_uncertain_paid_result',async()=>{
  await page.getByLabel('Selecionar Falha confirmada',{exact:true}).check();await preview(page,'Prévia do lote',1,1,'retry');
  const all=await preview(page,'Todos os elegíveis deste filtro',1,1,'retry');assert.deepEqual(all.ids,['QaFail_01']);assert.equal(all.ids.includes('QaUnknown'),false);assert.equal(all.excluded.some(x=>x.id==='QaUnknown'),false);
 });
 await record('finance_coverage_unknown_costs_and_optional_reference_persistence',async()=>{
  await navigate(page,'Financeiro');await page.getByRole('heading',{name:'Operação',exact:true}).waitFor();const finance=page.locator('.finance-panel');const coverage=finance.getByRole('region',{name:'Cobertura: Estimativas',exact:true});await coverage.getByText('Custos e uso registrados nas execuções',{exact:false}).waitFor();const visible=await finance.innerText();assert.ok(!/\[object Object\]|rawResult|records=|billingConfirmed=false/.test(visible));await coverage.getByText('Detalhes da cobertura · Estimativas',{exact:true}).click();assert.ok((await coverage.innerText()).includes('reels-v2-executions.rawResult.finance'));await coverage.getByText('Detalhes da cobertura · Estimativas',{exact:true}).click();assert.ok((await page.locator('.finance-panel').innerText()).includes('Desconhecido'));
  await page.getByRole('button',{name:'Editar referência diária',exact:true}).click();await page.getByLabel('Valor diário (vazio remove a referência)').fill('0');const saved=postFor(page,'/api/reels/finance');await page.getByRole('button',{name:'Salvar referência',exact:true}).click();assert.equal((await saved).status(),200);await page.getByRole('status').filter({hasText:'Referência informativa atualizada.'}).waitFor();assert.equal((await server.store.get('settings/reels_v2_finance')).data.budget.amount,0);
  await page.screenshot({path:join(output,'reels-finance-desktop.png'),fullPage:true});
 });
 await record('activity_pause_keeps_cursor_reconnect_deduplicates_and_filters',async()=>{
  const activity=await context.newPage();await activity.clock.install();await activity.goto(server.origin);await navigate(activity,'Atividade');await activity.getByText('Publicação sintética preservada.',{exact:true}).waitFor();const event=activity.locator('.activity-list li').filter({hasText:'Publicação sintética preservada.'});assert.ok(!(await event.innerText()).includes('a'.repeat(64)));assert.ok(!(await event.innerText()).includes('00000000000000000001_qa'));await event.getByText('Informação',{exact:true}).waitFor();await event.getByText('Detalhes do evento',{exact:true}).click();assert.ok((await event.innerText()).includes('a'.repeat(64)));assert.ok((await event.innerText()).includes('00000000000000000001_qa'));await event.getByText('Detalhes do evento',{exact:true}).click();await activity.screenshot({path:join(output,'reels-activity-readable.png'),fullPage:true});const before=server.calls.filter(x=>x.path==='/api/reels/events').length;
  await activity.getByLabel('Atualização ao vivo').uncheck();await server.appendEvent();await activity.clock.fastForward(10001);assert.equal(server.calls.filter(x=>x.path==='/api/reels/events').length,before);await activity.getByText('Publicação sintética preservada.',{exact:true}).waitFor();
  const incremental=responseFor(activity,'/api/reels/events',url=>!!url.searchParams.get('cursor'));await activity.getByLabel('Atualização ao vivo').check();await activity.clock.fastForward(5001);await incremental;await activity.getByText('Evento incremental após pausa.',{exact:true}).waitFor();
  const update=responseFor(activity,'/api/reels/events');await activity.getByRole('button',{name:'Atualizar agora',exact:true}).click();await update;assert.equal(await activity.getByText('Evento incremental após pausa.',{exact:true}).count(),1);
  const filtered=responseFor(activity,'/api/reels/events',url=>url.searchParams.get('reelId')==='QaPub_tech');await activity.getByLabel('Reel',{exact:true}).fill('QaPub_tech');await filtered;await activity.getByText('Publicação sintética preservada.',{exact:true}).waitFor();await activity.close();
 });
 await record('registration_does_not_admit_and_repeat_is_idempotent',async()=>{
  await page.getByRole('button',{name:'+ Cadastrar Reels',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Cadastrar Reels',exact:true});
  for(const expected of [1,0]){await dialog.getByLabel('Links dos Reels').fill('https://www.instagram.com/reel/QaNew_001/');const registered=postFor(page,'/api/reels/register');await dialog.getByRole('button',{name:'Cadastrar links',exact:true}).click();const data=await (await registered).json();assert.equal(data.created,expected);assert.equal(data.automaticProcessingStarted,false);await dialog.getByRole('status').filter({hasText:expected+' cadastrados'}).waitFor();}
  assert.equal((await server.store.get('videos/QaNew_001')).data.status,'registered');await closeDialog(page);
 });
 await record('loading_empty_errors_stale_preservation_and_old_response_isolation',async()=>{
  await navigate(page,'Todos os Reels');
  // The capacity journey reloads the app, whose intended initial scope is ready.
  // This scenario searches both registered and published records explicitly.
  const inventory=responseFor(page,'/api/reels/items',url=>url.searchParams.get('workspace')==='all');await page.getByRole('button',{name:'Acervo completo',exact:true}).click();await inventory;
  await search(page,'Entrada 000');await page.getByRole('button',{name:/Entrada 000/}).waitFor();
  const held=server.holdNext(url=>url.pathname==='/api/reels/items'&&url.searchParams.get('q')==='Modelo');await page.getByLabel('Buscar no acervo').fill('Modelo');await held.started;
  await page.locator('.catalog .initial-loading').waitFor();assert.equal(await page.getByText('Atualizando dados…',{exact:true}).count(),0);assert.equal(await page.locator('.catalog tbody tr').count(),0);
  await search(page,'Receita');await page.getByRole('button',{name:/Receita publicada/}).waitFor();held.release();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.getByRole('button',{name:/Modelo publicado/}).count(),0);
  await search(page,'SemResultadoQa');await page.getByText('Nenhum registro nesta seleção',{exact:true}).waitFor();await search(page,'Receita');await page.getByRole('button',{name:/Receita publicada/}).waitFor();
  server.failNext('/api/reels/items');const failed=responseFor(page,'/api/reels/items',(_,r)=>r.status()===503);await page.getByRole('button',{name:'↻ Atualizar',exact:true}).click();await failed;await page.locator('.catalog .resource-warning').getByText('Última leitura preservada · atualização indisponível',{exact:false}).waitFor();assert.equal(await page.locator('.catalog').getByRole('alert').count(),0);assert.equal(await page.locator('.catalog tbody tr').count(),1);
  const recovered=responseFor(page,'/api/reels/items',(_,r)=>r.status()===200);await page.locator('.catalog').getByRole('button',{name:'Tentar novamente',exact:true}).click();await recovered;
 });
 await record('background_refresh_keeps_rows_focus_scroll_and_layout_without_banners',async()=>{
  const ready=responseFor(page,'/api/reels/items',url=>url.searchParams.get('workspace')==='ready');await page.getByRole('button',{name:'A processar',exact:true}).click();await ready;
  await search(page,'Entrada 001');await page.getByRole('button',{name:/Entrada 001/}).waitFor();await page.getByLabel('Buscar no acervo').focus();const top=await page.locator('.catalog table').evaluate(el=>el.getBoundingClientRect().top),scroll=await page.evaluate(()=>window.scrollY);
  const held=server.holdNext(url=>url.pathname==='/api/reels/items'&&url.searchParams.get('q')==='Entrada 001');const response=responseFor(page,'/api/reels/items',url=>url.searchParams.get('q')==='Entrada 001');await page.getByRole('button',{name:'↻ Atualizar',exact:true}).evaluate(el=>el.click());await held.started;
  assert.equal(await page.getByText('Atualizando dados…',{exact:true}).count(),0);assert.equal(await page.locator('.catalog .initial-loading').count(),0);await page.getByRole('button',{name:/Entrada 001/}).waitFor();assert.equal(await page.getByLabel('Buscar no acervo').evaluate(el=>document.activeElement===el),true);assert.equal(await page.evaluate(()=>window.scrollY),scroll);assert.equal(await page.locator('.catalog table').evaluate(el=>el.getBoundingClientRect().top),top);
  held.release();await response;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));assert.equal(await page.locator('.catalog table').evaluate(el=>el.getBoundingClientRect().top),top);assert.equal(await page.getByLabel('Buscar no acervo').inputValue(),'Entrada 001');await page.screenshot({path:join(output,'reels-background-refresh-stable.png'),fullPage:true});
 });
 await record('successful_response_with_stale_cache_is_labeled_as_historical',async()=>{
  server.staleNext('/api/reels/items');const response=responseFor(page,'/api/reels/items',(_,r)=>r.status()===200);await page.getByRole('button',{name:'↻ Atualizar',exact:true}).click();assert.equal((await (await response).json()).cache.stale,true);
  await page.locator('.catalog .resource-warning').filter({hasText:'Última leitura preservada'}).waitFor();
 });
 await record('mobile_navigation_dialog_keyboard_and_no_horizontal_page_overflow',async()=>{
  const mobile=await context.newPage();await mobile.setViewportSize({width:390,height:844});await mobile.goto(server.origin);await navigate(mobile,'Biblioteca');await mobile.locator('.library-card').filter({hasText:'Modelo publicado'}).click();
  const dialog=mobile.getByRole('dialog',{name:'Modelo publicado',exact:true});await dialog.getByText('Explicação consolidada e publicada.',{exact:true}).waitFor();await mobile.keyboard.press('Tab');assert.equal(await mobile.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);await mobile.screenshot({path:join(output,'reels-knowledge-mobile.png'),fullPage:true});await mobile.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await navigate(mobile,'Categorias');assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);await mobile.screenshot({path:join(output,'reels-categories-mobile.png'),fullPage:true});await mobile.close();
 });
 await record('preserved_knowledge_history_and_finance_are_read_only_separate_views',async()=>{
  const old={schemaVersion:1,reelId:'QaPub_tech',status:'legacy_preserved',originalStatus:'analyzed',historical:true,executable:false,provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{primary_category:'Tecnologia',summary:'Resumo antigo preservado',quality_flags:['Aviso preservado: detalhes incompletos'],human_verified:false,claims:[null,{claim:{text:'Ponto legado estruturado'},evidence_quote:{text:'Evidência legada'},status:{label:'supported'}}],useful_value:['Aplicação preservada'],candidate_relations:[null,{topic:{text:'Ferramenta'},reason:{text:'Referência antiga'}}]},transcript:'TRANSCRICAO_ANTIGA'};
  await server.store.create('reels_legacy_content/QaPub_tech',old);
  const id='f'.repeat(64);await server.store.create('reels_historical_activity/'+id,{id,kind:'execution',reelId:'QaPub_tech',stage:'analysis',sourceStatus:'waiting',historical:true,executable:false,createdAt:'2026-10-15T10:00:00Z',provenance:[{path:'PRIVATE_PROVENANCE'}]});
  await server.store.create('reels_historical_finance/'+id,{id,kind:'reservation',historical:true,executable:false,amount:null,currency:'BRL',day:null});
  await navigate(page,'Biblioteca');await page.locator('.library-card').filter({hasText:'Modelo publicado'}).click();const dialog=page.getByRole('dialog',{name:'Modelo publicado',exact:true});await dialog.getByText('Explicação consolidada e publicada.',{exact:true}).waitFor();await dialog.getByText('Consultar análise antiga preservada',{exact:true}).click();await dialog.getByText('Resumo antigo preservado',{exact:true}).waitFor();await dialog.getByRole('region',{name:'Qualidade registrada na origem',exact:true}).getByText('Não verificado por pessoa na origem',{exact:true}).waitFor();await dialog.getByText('Aviso preservado: detalhes incompletos',{exact:true}).waitFor();await dialog.getByText('Ponto legado estruturado',{exact:false}).waitFor();await dialog.getByRole('button',{name:'Detalhes',exact:true}).click();await dialog.getByRole('heading',{name:'Histórico preservado',exact:true}).waitFor();await dialog.getByText('Aguardando · histórico',{exact:true}).waitFor();await closeDialog(page);
  await navigate(page,'Atividade');await page.getByRole('button',{name:'Histórico preservado',exact:true}).click();await page.getByText('Aguardando · histórico',{exact:true}).waitFor();assert.equal(await page.getByLabel('Atualização ao vivo').count(),0);const historical=page.locator('.activity-list li').filter({hasText:'Aguardando · histórico'});assert.ok(!(await historical.innerText()).includes(id));await historical.getByText('Detalhes do evento',{exact:true}).click();assert.ok((await historical.innerText()).includes(id));assert.ok((await historical.innerText()).includes('2026-10-15T10:00:00.000Z'));await historical.getByText('waiting',{exact:true}).waitFor();await historical.getByText('Detalhes do evento',{exact:true}).click();await page.screenshot({path:join(output,'reels-preserved-history.png'),fullPage:true});
  await navigate(page,'Financeiro');await page.getByRole('heading',{name:'Financeiro preservado do acervo',exact:true}).waitFor();await page.getByText('Reserva antiga',{exact:true}).waitFor();await page.getByText('Sem data comprovada',{exact:true}).waitFor();
  assert.equal([...server.store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,2);
 });
 await record('idle_and_hidden_refresh_queries_only_the_visible_workspace',async()=>{
  const idle=await context.newPage();await idle.clock.install();const categoryReads=()=>server.calls.filter(x=>x.path==='/api/reels/categories'&&x.method==='GET').length,beforeCategories=categoryReads();await idle.goto(server.origin);await idle.getByLabel('Selecionar Entrada 000',{exact:true}).waitFor();assert.equal(categoryReads(),beforeCategories,'Entry must not load editorial taxonomy');
  await navigate(idle,'Financeiro');await idle.getByRole('heading',{name:'Operação',exact:true}).waitFor();const idlePoll=responseFor(idle,'/api/reels/summary');await idle.clock.fastForward(60001);await idlePoll;assert.equal(categoryReads(),beforeCategories,'Financial polling must not load categories');
  await idle.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));const before=server.calls.filter(x=>x.path==='/api/reels/summary').length;await idle.clock.fastForward(60001);assert.equal(server.calls.filter(x=>x.path==='/api/reels/summary').length,before,'Hidden pages must not poll workspace data');await idle.close();
 });
 await record('real_api_auth_origin_processing_gate_and_no_external_calls',async()=>{
  const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(server.origin+'/api/reels/summary')).status(),401);await anonymous.close();
  assert.equal((await context.request.post(server.origin+'/api/reels/register',{headers:{Origin:'https://not-allowed.invalid'},data:{links:'https://www.instagram.com/reel/QaNever_001/'}})).status(),403);
  assert.equal(await server.store.get('videos/QaNever_001'),null);assert.equal([...server.store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,2);
  assert.ok(server.calls.filter(x=>x.path==='/api/reels/commands'&&['start','retry','complement'].includes(x.body?.type)).every(x=>x.status===423));assert.ok(server.store.reads.filter(x=>x.collection==='videos').every(x=>Array.isArray(x.select)&&!x.select.includes('transcript')&&!x.select.includes('analysis')));
  assert.deepEqual(server.calls.filter(x=>x.path==='/api/reels/items'&&x.status===400),[],'Filter changes must never send a cursor from a different query.');assert.deepEqual(server.externalAttempts,[]);assert.deepEqual(failures,[]);
 });
 const report={passed:true,checks,mode:'synthetic_database_real_workspace_and_reels_API',external_calls:0,providers_called:0,reels_processed:0,production_data_modified:false,credentials_loaded:false,http_calls:server.calls.length,limitations:['QA session is injected; Google login, Next production routing and real Google storage are not validated by this harness.','Synthetic fixture media validates browser decoding only.','Compilation, broad service tests and independent review remain separate gates.']};
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,failures},null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));throw error;}
finally {await browser?.close();await server.close();}
