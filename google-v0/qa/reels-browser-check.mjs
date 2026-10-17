import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';

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
  await page.locator('.stat').filter({hasText:'Reels cadastrados'}).getByText('79',{exact:true}).waitFor();
  const names=await page.getByRole('navigation').getByRole('button').allTextContents();assert.equal(names.length,7);
  for(const [i,label]of ['Todos os Reels','Filas','Categorias','Biblioteca','Precisa de atenção','Financeiro','Atividade'].entries()){assert.ok(names[i].includes(label));await navigate(page,label);}
  await page.getByText('Publicação sintética preservada.',{exact:true}).waitFor();await navigate(page,'Todos os Reels');
  assert.ok((await page.locator('body').innerText()).includes('Processamento não autorizado nesta entrega.'));
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
  await page.locator('.library-card').filter({has:page.getByRole('heading',{name:'Receita publicada',exact:true})}).click();const recipe=page.getByRole('dialog',{name:'Receita publicada',exact:true});await recipe.getByText('300 g de frango',{exact:true}).waitFor();await recipe.getByText('Doure na frigideira por 8 minutos.',{exact:true}).waitFor();await recipe.getByText('8 minutos',{exact:true}).waitFor();await recipe.getByText('2 porções',{exact:true}).waitFor();await page.screenshot({path:join(output,'reels-recipe-knowledge-desktop.png'),fullPage:true});await closeDialog(page);
 });
 await record('discovery_first_preview_global_scope_and_preserved_legacy_evidence_gaps',async()=>{
  await navigate(page,'Categorias');await page.locator('.tree-name').filter({hasText:'Tecnologia'}).click();await page.getByRole('button',{name:'Avaliar recorrências',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Avaliar recorrências',exact:true});
  const response=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Calcular prévia de impacto',exact:true}).click();const planned=await response;assert.equal(planned.status(),200);const data=await planned.json();assert.equal(data.preview.action,'discover');
  const body=server.calls.filter(x=>x.path==='/api/reels/categories').at(-1).body;assert.equal(body.id,undefined);assert.equal(body.backfillCursor,undefined);assert.ok(data.preview.coverage.missing>0);
  const saved=postFor(page,'/api/reels/categories');await dialog.getByRole('button',{name:'Confirmar alteração persistente',exact:true}).click();assert.equal((await saved).status(),200);await dialog.getByRole('status').filter({hasText:'Alteração persistida.'}).waitFor();await closeDialog(page);
  await page.getByText('Publicações que precisam de complemento para segmentar',{exact:true}).waitFor();await page.screenshot({path:join(output,'reels-categories-discovery-desktop.png'),fullPage:true});
 });
 await record('category_descendant_browse_and_broad_reclassification_preview_token',async()=>{
  await navigate(page,'Categorias');await page.locator('.tree-name').filter({hasText:'Tecnologia'}).click();
  const browse=responseFor(page,'/api/reels/items',url=>url.searchParams.get('workspace')==='library'&&url.searchParams.get('category')==='cat_tech');await page.getByRole('button',{name:'Explorar na Biblioteca ↗',exact:true}).click();await browse;
  await page.locator('.library-card').filter({hasText:'Modelo publicado'}).waitFor();assert.equal(await page.locator('.library-card').count(),1);assert.equal(await page.getByLabel('Categoria',{exact:true}).inputValue(),'cat_tech');
  await navigate(page,'Categorias');await page.getByRole('button',{name:'Reclassificar por IDs',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Reclassificar Reels',exact:true});
  await dialog.getByLabel('IDs dos Reels publicados').fill('QaPub_tech\nQaPub_food');await dialog.getByLabel('IDs das categorias de destino').fill('cat_models');
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
  await analysis.getByText('Capacidade 2 efetiva / 11 desejada',{exact:true}).waitFor();await page.getByText('Última operação persistida',{exact:true}).waitFor();
  await page.reload();await page.getByText(operation.id,{exact:true}).waitFor();assert.ok(server.calls.some(x=>x.path==='/api/reels/commands/'+operation.id));
  await navigate(page,'Filas');const stage=responseFor(page,'/api/reels/items',url=>url.searchParams.get('stage')==='analysis');await page.locator('.queue-card').filter({has:page.getByRole('heading',{name:'Análise',exact:true})}).locator('.queue-title').click();await stage;await page.getByRole('button',{name:/Análise aguardando externo/}).waitFor();assert.equal(await page.getByLabel('Etapa / fila',{exact:true}).inputValue(),'analysis');
 });
 await record('attention_uncertainty_and_safe_retry_server_denial',async()=>{
  await navigate(page,'Precisa de atenção');const worker=responseFor(page,'/api/reels/items',url=>url.searchParams.get('worker')==='qa-worker');await page.getByLabel('Worker',{exact:true}).fill('qa-worker');await worker;
  const destination=responseFor(page,'/api/reels/items',url=>url.searchParams.get('destination')==='reconcile');await page.getByLabel('Destino',{exact:true}).fill('reconcile');await destination;
  await page.getByRole('button',{name:/Resultado incerto/}).click();const dialog=page.getByRole('dialog',{name:'Resultado incerto',exact:true});await dialog.getByRole('button',{name:'Detalhes',exact:true}).click();
  const retry=dialog.getByRole('button',{name:'Solicitar retomada ao servidor',exact:true});assert.equal(await retry.isDisabled(),true);await dialog.getByText('Concilie a conclusão externa antes de repetir. A API preserva a incerteza.',{exact:true}).waitFor();await closeDialog(page);
  const reset=responseFor(page,'/api/reels/items',url=>!url.searchParams.get('destination')&&!url.searchParams.get('worker'));await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await reset;
  await page.getByRole('button',{name:/Falha confirmada/}).click();const confirmed=page.getByRole('dialog',{name:'Falha confirmada',exact:true});await confirmed.getByRole('button',{name:'Detalhes',exact:true}).click();const denied=postFor(page,'/api/reels/commands');await confirmed.getByRole('button',{name:'Solicitar retomada ao servidor',exact:true}).click();assert.equal((await denied).status(),423);await confirmed.getByRole('alert').filter({hasText:'PROCESSING_DISABLED'}).waitFor();await closeDialog(page);
 });
 await record('attention_batch_and_all_retry_exclude_uncertain_paid_result',async()=>{
  await page.getByLabel('Selecionar Falha confirmada',{exact:true}).check();await preview(page,'Prévia do lote',1,1,'retry');
  const all=await preview(page,'Todos os elegíveis deste filtro',2,1,'retry');assert.equal(all.excluded.find(x=>x.id==='QaUnknown').reason,'requires_reconciliation');
 });
 await record('finance_coverage_unknown_costs_and_optional_reference_persistence',async()=>{
  await navigate(page,'Financeiro');await page.getByText('Operação:',{exact:false}).waitFor();assert.ok(!(await page.locator('.finance-panel').innerText()).includes('[object Object]'));assert.ok((await page.locator('.finance-panel').innerText()).includes('Desconhecido'));
  await page.getByRole('button',{name:'Editar referência diária',exact:true}).click();await page.getByLabel('Valor diário (vazio remove a referência)').fill('0');const saved=postFor(page,'/api/reels/finance');await page.getByRole('button',{name:'Salvar referência',exact:true}).click();assert.equal((await saved).status(),200);await page.getByRole('status').filter({hasText:'Referência informativa atualizada.'}).waitFor();assert.equal((await server.store.get('settings/reels_v2_finance')).data.budget.amount,0);
  await page.screenshot({path:join(output,'reels-finance-desktop.png'),fullPage:true});
 });
 await record('activity_pause_keeps_cursor_reconnect_deduplicates_and_filters',async()=>{
  const activity=await context.newPage();await activity.clock.install();await activity.goto(server.origin);await navigate(activity,'Atividade');await activity.getByText('Publicação sintética preservada.',{exact:true}).waitFor();const before=server.calls.filter(x=>x.path==='/api/reels/events').length;
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
  await navigate(page,'Todos os Reels');await search(page,'Entrada 000');await page.getByRole('button',{name:/Entrada 000/}).waitFor();
  const held=server.holdNext(url=>url.pathname==='/api/reels/items'&&url.searchParams.get('q')==='Modelo');await page.getByLabel('Buscar no acervo').fill('Modelo');await held.started;
  await page.locator('.catalog').getByRole('status').filter({hasText:'Atualizando dados…'}).waitFor();assert.equal(await page.locator('.catalog tbody tr').count(),0);
  await search(page,'Receita');await page.getByRole('button',{name:/Receita publicada/}).waitFor();held.release();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.getByRole('button',{name:/Modelo publicado/}).count(),0);
  await search(page,'SemResultadoQa');await page.getByText('Nenhum registro nesta seleção',{exact:true}).waitFor();await search(page,'Receita');await page.getByRole('button',{name:/Receita publicada/}).waitFor();
  server.failNext('/api/reels/items');const failed=responseFor(page,'/api/reels/items',(_,r)=>r.status()===503);await page.getByRole('button',{name:'↻ Atualizar',exact:true}).click();await failed;await page.locator('.catalog').getByRole('alert').filter({hasText:'Leitura sintética indisponível.'}).waitFor();await page.getByText('A última leitura está preservada e pode estar desatualizada.',{exact:true}).waitFor();assert.equal(await page.locator('.catalog tbody tr').count(),1);
  const recovered=responseFor(page,'/api/reels/items',(_,r)=>r.status()===200);await page.locator('.catalog').getByRole('button',{name:'Tentar novamente',exact:true}).click();await recovered;
 });
 await record('successful_response_with_stale_cache_is_labeled_as_historical',async()=>{
  server.staleNext('/api/reels/items');const response=responseFor(page,'/api/reels/items',(_,r)=>r.status()===200);await page.getByRole('button',{name:'↻ Atualizar',exact:true}).click();assert.equal((await (await response).json()).cache.stale,true);
  await page.locator('.catalog').getByRole('status').filter({hasText:'A última leitura está preservada e pode estar desatualizada.'}).waitFor();
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
  await navigate(page,'Biblioteca');await page.locator('.library-card').filter({hasText:'Modelo publicado'}).click();const dialog=page.getByRole('dialog',{name:'Modelo publicado',exact:true});await dialog.getByText('Explicação consolidada e publicada.',{exact:true}).waitFor();await dialog.getByText('Consultar análise antiga preservada',{exact:true}).click();await dialog.getByText('Resumo antigo preservado',{exact:true}).waitFor();await dialog.getByRole('region',{name:'Qualidade registrada na origem',exact:true}).getByText('Não verificado por pessoa na origem',{exact:true}).waitFor();await dialog.getByText('Aviso preservado: detalhes incompletos',{exact:true}).waitFor();await dialog.getByText('Ponto legado estruturado',{exact:false}).waitFor();await dialog.getByRole('button',{name:'Detalhes',exact:true}).click();await dialog.getByRole('heading',{name:'Histórico preservado',exact:true}).waitFor();await dialog.getByText('waiting · histórico',{exact:true}).waitFor();await closeDialog(page);
  await navigate(page,'Atividade');await page.getByRole('button',{name:'Histórico preservado',exact:true}).click();await page.getByText('waiting · histórico',{exact:true}).waitFor();assert.equal(await page.getByLabel('Atualização ao vivo').count(),0);await page.screenshot({path:join(output,'reels-preserved-history.png'),fullPage:true});
  await navigate(page,'Financeiro');await page.getByRole('heading',{name:'Financeiro preservado do acervo',exact:true}).waitFor();await page.getByText('Reserva antiga',{exact:true}).waitFor();await page.getByText('Sem data comprovada',{exact:true}).waitFor();
  assert.equal([...server.store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,1);
 });
 await record('real_api_auth_origin_processing_gate_and_no_external_calls',async()=>{
  const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(server.origin+'/api/reels/summary')).status(),401);await anonymous.close();
  assert.equal((await context.request.post(server.origin+'/api/reels/register',{headers:{Origin:'https://not-allowed.invalid'},data:{links:'https://www.instagram.com/reel/QaNever_001/'}})).status(),403);
  assert.equal(await server.store.get('videos/QaNever_001'),null);assert.equal([...server.store.docs.keys()].filter(path=>path.startsWith('reels_executions/')).length,1);
  assert.ok(server.calls.filter(x=>x.path==='/api/reels/commands'&&['start','retry','complement'].includes(x.body?.type)).every(x=>x.status===423));assert.ok(server.store.reads.filter(x=>x.collection==='videos').every(x=>Array.isArray(x.select)&&!x.select.includes('transcript')&&!x.select.includes('analysis')));
  assert.deepEqual(server.calls.filter(x=>x.path==='/api/reels/items'&&x.status===400),[],'Filter changes must never send a cursor from a different query.');assert.deepEqual(server.externalAttempts,[]);assert.deepEqual(failures,[]);
 });
 const report={passed:true,checks,mode:'synthetic_database_real_workspace_and_reels_API',external_calls:0,providers_called:0,reels_processed:0,production_data_modified:false,credentials_loaded:false,http_calls:server.calls.length,limitations:['QA session is injected; Google login, Next production routing and real Google storage are not validated by this harness.','Synthetic fixture media validates browser decoding only.','Compilation, broad service tests and independent review remain separate gates.']};
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,failures},null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));throw error;}
finally {await browser?.close();await server.close();}
