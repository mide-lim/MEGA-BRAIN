import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';
import {makeSemanticFixture,semanticEnvelope} from '../tests/reels-semantic-fixture.mjs';
import {semanticHash,semanticPolicyPath} from '../lib/reels-semantic-source.mjs';


function makeProofNavigationFixture(){
 const base=makeSemanticFixture(),template=base.documents.find(record=>record.path==='videos/QaFull_single'),documents=base.documents.filter(record=>!record.path.startsWith('videos/')&&!record.path.startsWith('reels_legacy_content/')&&record.path!==semanticPolicyPath),pins=[],calls=[];
 for(let index=0;index<25;index++){
  const id='QaProof_'+String(index).padStart(3,'0'),video=structuredClone(template.data);video.id=id;video.title='Prova salva '+id;video.analysis={...video.analysis,title:video.title};video.analysis_key='analysis/'+id+'.json';video.source_caption.capture_id='caption-'+id;
  documents.push({path:'videos/'+id,data:video,updateTime:template.updateTime});pins.push({id,sourceVersions:{video:template.updateTime}});
 }
 const policy={...base.policy,batchSize:8,maxCalls:9,maxSources:25,authorizationId:'fixture-proof-navigation25',authorizedCohortHash:semanticHash(pins)};
 documents.push({path:semanticPolicyPath,data:policy,updateTime:template.updateTime});
 const proof=source=>{const field=source.fields.find(field=>field.fieldPath==='caption');assert.ok(field);return {fieldPath:field.fieldPath,excerpt:field.text};};
 const provider={
  async infer(input){calls.push('extract');const prior=input.catalogue.groups.find(group=>group.key==='preparos-com-provas');return semanticEnvelope({version:1,profiles:input.sources.map(source=>({reelId:source.id,context:'recipe',state:'proposed',reason:'Synthetic saved-proof navigation fixture only.',units:[]})),groups:[{key:'preparos-com-provas',name:'Preparos com provas salvas',context:'recipe',kind:'segment',definition:'Preparo culinário descrito nas fontes salvas.',aliases:[],positiveCriteria:['Preparo desenvolvido no conteúdo.'],negativeCriteria:['Menção isolada sem preparo.'],...(prior?{existingGroupId:prior.id}:{}),members:input.sources.map(source=>({reelId:source.id,role:'central',unitIds:[],evidence:[proof(source)]})),negativeExamples:[]}]},input.model);},
  async consolidate(input){calls.push('consolidate');return semanticEnvelope({version:1,resolutions:input.groups.map(group=>({groupId:group.id,decision:'keep',mergeInto:'',reason:'One synthetic source-bound group.'}))},input.model);},
  async verify(input){calls.push('verify');const byId=new Map(input.sources.map(source=>[source.id,source]));return semanticEnvelope({version:1,members:input.members.map(member=>({groupId:member.groupId,reelId:member.reelId,verdict:'supported',reason:'Synthetic saved-proof contract fixture.',evidence:[proof(byId.get(member.reelId))]})),negativeExamples:[]},input.model);}
 };
 return {documents,provider,calls,policy};
}

const output=process.env.MEGABRAIN_REELS_SEMANTIC_QA_OUTPUT??join(tmpdir(),'megabrain-reels-semantic-qa');
await mkdir(output,{recursive:true});
const fixture=makeSemanticFixture({navigationGroups:true}),server=await startReelsFixtureServer({semanticFixture:fixture}),checks=[],failures=[];
const sourceSnapshot=()=>JSON.stringify([...server.store.docs].filter(([path])=>path.startsWith('videos/')||path.startsWith('reels_legacy_content/')).sort(([a],[b])=>a.localeCompare(b)));
const originalSources=sourceSnapshot(),semanticPath='/api/reels/curation/semantic';
let browser,page,context,jobId,manualId,proofJourneyCalls=0;
const record=async(name,action)=>{await action();checks.push(name);};
const responseFor=(path,predicate=()=>true)=>page.waitForResponse(response=>new URL(response.url()).pathname===path&&predicate(response));
const postFor=action=>responseFor(semanticPath,response=>response.request().method()==='POST'&&response.request().postDataJSON()?.action===action);
const semanticPosts=()=>server.calls.filter(call=>call.path===semanticPath&&call.method==='POST');
async function navigate(label){await page.getByRole('navigation').getByRole('button',{name:new RegExp(label)}).click();await page.getByRole('heading',{name:label,exact:true,level:1}).waitFor();}
async function read(path){const response=await context.request.get(server.origin+'/api/reels'+path);assert.equal(response.status(),200,path);return response.json();}
async function selectGroup(name){await page.getByRole('button',{name:'Ver contexto '+name,exact:true}).click();await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('heading',{name,exact:true}).waitFor();}
async function confirm(action,button='Confirmar alteração'){
 const response=postFor(action);await page.getByRole('dialog').getByRole('button',{name:button,exact:true}).click();const received=await response;
 assert.equal(received.status(),200,JSON.stringify(await received.json()));await page.getByRole('dialog').waitFor({state:'hidden'});return received.json();
}
async function libraryIds(){
 const call=[...server.calls].reverse().find(call=>call.path==='/api/reels/items'&&call.status===200&&new URLSearchParams(call.query).get('workspace')==='library');
 assert.ok(call,'Library must query real published API');return call.result.items.map(item=>item.id).sort();
}
try{
 browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'qa_session',value:'local',url:server.origin}]);
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===server.origin)return route.continue();failures.push('Unexpected external browser request');return route.abort();});
 context.on('page',p=>{p.on('pageerror',error=>failures.push(error.message));p.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource: the server responded with a status of (401|403|409|423|503)\b/.test(message.text()))failures.push(message.text());});});
 page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(server.origin);await navigate('Categorias');
 await record('saved_inventory_metadata_reads_do_not_infer_or_write',async()=>{
  const overview=await read('/curation/semantic');assert.equal(overview.inferenceOnGet,false);assert.equal(overview.coverage.published,fixture.expected.publishedCount);assert.equal(overview.coverage.evaluated,0);assert.equal(overview.coverage.pending,5);
  await page.getByRole('region',{name:'Curadoria semântica do acervo'}).getByRole('heading',{name:'Contextos que fazem sentido juntos',exact:true}).waitFor();
  assert.equal(await page.locator('details.contextual-source-explorer').evaluate(element=>element.open),false,'Documentary support is secondary, not a competing curator');
  await read('/curation/semantic');await read('/categories');await read('/items?workspace=library');
  assert.equal(fixture.calls.length,0);assert.equal(semanticPosts().length,0);assert.equal(sourceSnapshot(),originalSources);
 });
 await record('explicit_metadata_preview_then_single_create_pins_finite_saved_scope',async()=>{
  await page.getByRole('button',{name:'Organizar acervo salvo',exact:true}).click();const previewResponse=postFor('preview');
  await page.getByRole('dialog').getByRole('button',{name:'Conferir escopo da curadoria',exact:true}).click();const preview=await (await previewResponse).json();
  assert.equal(preview.inferenceStarted,false);assert.equal(preview.preview.selectedCount,5);assert.equal(preview.preview.maximumCalls,fixture.expected.maximumCalls);assert.equal(fixture.calls.length,0);
  await page.getByRole('dialog').getByText('5 publicações no escopo conferido · nenhuma inferência iniciada nesta prévia.',{exact:true}).waitFor();
  const created=await confirm('create','Iniciar curadoria do acervo');jobId=created.job.id;
  assert.equal(created.created,true);assert.equal(created.job.status,'prepared');assert.equal(semanticPosts().filter(call=>call.body.action==='create').length,1);assert.equal(server.semanticDeliveries.length,1);assert.equal(fixture.calls.length,0,'Create only queues durable work');
  assert.equal(semanticPosts().find(call=>call.body.action==='create').body.previewHash,preview.preview.previewHash);
  await page.getByRole('region',{name:'Curadoria em andamento'}).waitFor();assert.equal(await page.getByRole('button',{name:'Organizar acervo salvo',exact:true}).isDisabled(),true);
  const before=JSON.stringify([...server.store.docs].filter(([path])=>path.startsWith('reels_index/semantic_')));
  await read('/curation/semantic');await read('/curation/semantic/jobs/'+jobId);
  assert.equal(JSON.stringify([...server.store.docs].filter(([path])=>path.startsWith('reels_index/semantic_'))),before);assert.equal(fixture.calls.length,0);
 });
 await record('queued_job_finishes_without_browser_or_browser_advance_loop',async()=>{
  await page.close();page=null;await server.pumpSemantic();assert.equal(server.semanticDeliveries.length,0);
  const completed=await read('/curation/semantic/jobs/'+jobId);assert.equal(completed.job.status,'completed');assert.equal(completed.job.processed,5);
  assert.ok(fixture.calls.length>0&&fixture.calls.length<=fixture.expected.maximumCalls);
  for(const phase of ['extract','consolidate','verify'])assert.ok(fixture.calls.some(call=>call.phase===phase),'Actual synthetic wire must exercise '+phase);
  assert.equal(semanticPosts().filter(call=>call.body.action==='advance').length,0,'Browser must not run provider batches');
  page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(server.origin);await navigate('Categorias');
  const overview=await read('/curation/semantic');assert.equal(overview.coverage.evaluated,5);assert.equal(overview.coverage.pending,0);assert.ok(overview.coverage.unknown>=1);assert.equal(overview.groups.filter(group=>group.status==='active').length,0,'Uncalibrated fixture creates proposals, never automatic approval');
  assert.equal(await page.getByRole('region',{name:'Curadoria em andamento'}).count(),0);await page.getByRole('button',{name:'Ver contexto '+fixture.expected.groupName,exact:true}).waitFor();
 });
 await record('candidate_has_meaning_criteria_literal_evidence_and_source_versions',async()=>{
  await selectGroup(fixture.expected.groupName);const detail=page.getByRole('region',{name:'Detalhes do contexto semântico'});
  await detail.getByRole('heading',{name:'O que pertence a este contexto',exact:true}).waitFor();await detail.getByRole('heading',{name:'O que deve ficar de fora',exact:true}).waitFor();
  await detail.getByText('Um preparo culinário é o assunto desenvolvido.',{exact:true}).waitFor();
  const member=detail.locator('article').filter({has:page.getByRole('button',{name:'QaFull_single',exact:true})});
  await member.getByText('Por que este Reel pertence ao contexto',{exact:true}).click();await member.getByText('Frango na frigideira: tempere o frango, cozinhe na frigideira e sirva.',{exact:true}).waitFor();
  await member.getByText('Origem desta associação',{exact:true}).click();await member.getByText('Versões das fontes',{exact:true}).waitFor();await member.getByText('Prova da associação',{exact:true}).waitFor();
  const saved=await read('/curation/semantic/groups/'+fixture.expected.groupId);assert.deepEqual(saved.members.map(member=>member.id).sort(),fixture.expected.memberIds);
  assert.ok(saved.members.every(member=>member.sourceVersions?.video&&member.sourceProofHash&&member.evidence.length));
  assert.equal(saved.inferenceOnGet,false);await page.screenshot({path:join(output,'semantic-candidate-desktop.png'),fullPage:true});
 });
 const paidFixtureCalls=fixture.calls.length;
 await record('manual_approval_uses_same_library_tree_and_exact_source_bound_members',async()=>{
  await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('button',{name:'Aprovar proposta',exact:true}).click();await confirm('group_approve');
  const detail=page.getByRole('region',{name:'Detalhes do contexto semântico'});await detail.getByRole('button',{name:'Organizar publicações',exact:true}).waitFor();
  const approved=await read('/curation/semantic/groups/'+fixture.expected.groupId);assert.equal(approved.group.status,'active');assert.equal(approved.group.protected,true);
  // Start with a contradictory saved Library search. An explicit context browse
  // must replace that search rather than silently intersect old filters.
  await navigate('Biblioteca');const searched=responseFor('/api/reels/items',response=>new URL(response.url()).searchParams.get('q')==='QaFull_tech');
  await page.getByLabel('Buscar no acervo',{exact:true}).fill('QaFull_tech');await searched;await navigate('Categorias');await selectGroup(fixture.expected.groupName);
  const items=responseFor('/api/reels/items',response=>new URL(response.url()).searchParams.get('category')==='semantic_'+fixture.expected.groupId);
  await page.getByRole('button',{name:'Explorar contexto na Biblioteca →',exact:true}).click();await items;
  assert.equal(await page.getByLabel('Buscar no acervo',{exact:true}).inputValue(),'');assert.deepEqual(await libraryIds(),fixture.expected.memberIds);
  await page.locator('.library-navigation .tree-name').filter({hasText:fixture.expected.groupName}).waitFor();
  assert.equal(await page.locator('.library-navigation .tree-name').filter({hasText:fixture.expected.groupName}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Lista',exact:true}).click();const expanded=await page.locator('.library-navigation button[aria-expanded="true"]').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')));
  await navigate('Financeiro');await navigate('Biblioteca');assert.equal(await page.getByRole('button',{name:'Lista',exact:true}).getAttribute('aria-pressed'),'true');assert.deepEqual(await libraryIds(),fixture.expected.memberIds);
  assert.deepEqual(await page.locator('.library-navigation button[aria-expanded="true"]').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label'))),expanded);
  assert.equal(fixture.calls.length,paidFixtureCalls);
 });
 await record('quiet_refresh_preserves_search_selection_and_visible_content',async()=>{
  await navigate('Categorias');await selectGroup(fixture.expected.groupName);await page.getByLabel('Buscar contextos semânticos').fill('Preparos');
  const hold=server.holdNext(url=>url.pathname===semanticPath),refresh=responseFor(semanticPath,response=>response.request().method()==='GET');
  await page.getByRole('button',{name:'Atualizar curadoria',exact:true}).click();await hold.started;
  await page.getByLabel('Buscar contextos semânticos').focus();assert.equal(await page.getByLabel('Buscar contextos semânticos').inputValue(),'Preparos');
  assert.equal(await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('heading',{name:fixture.expected.groupName,exact:true}).count(),1);
  assert.equal(await page.getByText('Atualizando dados…',{exact:true}).count(),0);assert.equal(await page.getByText('Carregando conteúdo…',{exact:true}).count(),0);
  hold.release();await refresh;assert.equal(await page.getByLabel('Buscar contextos semânticos').evaluate(element=>document.activeElement===element),true);
  await navigate('Financeiro');await navigate('Categorias');assert.equal(await page.getByLabel('Buscar contextos semânticos').inputValue(),'Preparos');
  assert.equal(await page.getByRole('button',{name:'Ver contexto '+fixture.expected.groupName,exact:true}).getAttribute('aria-pressed'),'true');await page.getByLabel('Buscar contextos semânticos').fill('');
 });
 await record('approved_format_uses_canonical_tree_and_ingredient_is_member_filter_without_node',async()=>{
  await selectGroup('Receita única');await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('button',{name:'Aprovar proposta',exact:true}).click();await confirm('group_approve');
  const overview=await read('/curation/semantic'),format=overview.groups.find(group=>group.kind==='format'&&group.status==='active');
  assert.ok(format);assert.equal(format.filter.category,'ctx_format_single_recipe');const categories=await read('/categories'),formatNodes=categories.nodes.filter(node=>node.id==='ctx_format_single_recipe');
  assert.equal(formatNodes.length,1,'Semantic and documentary readers share one canonical format node');assert.equal(formatNodes[0].parentId,'receitas');assert.equal(formatNodes[0].count,1);
  let library=responseFor('/api/reels/items',response=>new URL(response.url()).searchParams.get('category')==='ctx_format_single_recipe');
  await page.getByRole('button',{name:'Explorar contexto na Biblioteca →',exact:true}).click();await library;assert.deepEqual(await libraryIds(),['QaFull_single']);
  await page.locator('.library-navigation .tree-name').filter({hasText:'Receita única'}).waitFor();assert.equal(await page.locator('.library-navigation .tree-name').filter({hasText:'Receita única'}).getAttribute('aria-pressed'),'true');
  await navigate('Categorias');await selectGroup('Frango');await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('button',{name:'Aprovar proposta',exact:true}).click();await confirm('group_approve');
  const approved=await read('/curation/semantic'),facet=approved.groups.find(group=>group.kind==='facet'&&group.status==='active');assert.ok(facet);assert.equal(facet.filter.semanticFacet,facet.id);assert.equal(facet.categoryId??null,null);
  const tree=await read('/categories');assert.equal(tree.nodes.some(node=>node.id==='semantic_'+facet.id||node.groupId===facet.id||node.name==='Frango'),false,'Ingredient is a contextual filter, never another branch');
  library=responseFor('/api/reels/items',response=>{const q=new URL(response.url()).searchParams;return q.get('semanticFacet')===facet.id&&!q.get('category');});
  await page.getByRole('button',{name:'Explorar contexto na Biblioteca →',exact:true}).click();await library;assert.deepEqual(await libraryIds(),fixture.expected.memberIds);
  await page.getByRole('button',{name:'Remover filtro da faceta',exact:true}).waitFor();await page.getByText('Faceta aprovada:',{exact:false}).filter({hasText:'Esta seleção não afirma que seja o tema principal.'}).waitFor();await navigate('Financeiro');await navigate('Biblioteca');
  assert.equal(await page.getByRole('button',{name:'Remover filtro da faceta',exact:true}).count(),1);assert.deepEqual(await libraryIds(),fixture.expected.memberIds);
  library=responseFor('/api/reels/items',response=>{const q=new URL(response.url()).searchParams;return q.get('workspace')==='library'&&!q.get('semanticFacet')&&!q.get('category');});
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await library;assert.equal((await libraryIds()).length,5,'Clear restores the full saved corpus');
  assert.equal(fixture.calls.length,paidFixtureCalls);await navigate('Categorias');await selectGroup(fixture.expected.groupName);
 });
 await record('manual_create_assign_rename_protect_merge_reject_use_real_cas_commands',async()=>{
  await page.getByRole('button',{name:'+ Criar contexto',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Nome do contexto',{exact:true}).fill('Preparo de casa');await dialog.getByLabel('O que pertence a este contexto',{exact:true}).fill('Seleção editorial de preparos culinários caseiros, preservando fontes salvas.');
  await dialog.getByLabel('Contexto acima',{exact:true}).selectOption(fixture.expected.groupId);const created=await confirm('group_create');manualId=created.group.id;assert.equal(created.group.status,'active');
  await selectGroup('Preparo de casa');await page.getByRole('button',{name:'Organizar publicações',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByLabel('Incluir QaFull_unknown',{exact:true}).check();await confirm('group_assign');
  const assignmentPost=semanticPosts().filter(call=>call.body.action==='group_assign').at(-1);assert.deepEqual(assignmentPost.body.addIds,['QaFull_unknown']);assert.deepEqual(assignmentPost.body.removeIds,[]);assert.equal(Object.hasOwn(assignmentPost.body,'reelIds'),false,'UI sends an explicit delta, not a page-sized replacement');
  const assigned=await read('/curation/semantic/groups/'+manualId);assert.deepEqual(assigned.members.map(member=>member.id),['QaFull_unknown']);
  const parentTree=await read('/categories'),parentNode=parentTree.nodes.find(node=>node.id==='semantic_'+fixture.expected.groupId),childNode=parentTree.nodes.find(node=>node.id==='semantic_'+manualId);
  assert.equal(childNode.parentId,parentNode.id,'Manual child must join the same navigable tree');assert.equal(parentNode.count,3,'Parent count is the unique union including child members');
  const parentItems=await read('/items?workspace=library&category='+parentNode.id);assert.deepEqual(parentItems.items.map(item=>item.id).sort(),[...fixture.expected.memberIds,'QaFull_unknown'].sort());
  await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('button',{name:'Renomear',exact:true}).click();await page.getByRole('dialog').getByLabel('Nome do contexto',{exact:true}).fill('Cozinha de casa editorial');await confirm('group_rename');
  await page.getByRole('region',{name:'Detalhes do contexto semântico'}).getByRole('heading',{name:'Cozinha de casa editorial',exact:true}).waitFor();
  await page.getByRole('button',{name:'Remover proteção',exact:true}).click();await confirm('group_protect');await page.getByRole('button',{name:'Proteger contexto',exact:true}).click();await confirm('group_protect');
  assert.equal((await read('/curation/semantic/groups/'+manualId)).group.protected,true);
  await page.getByRole('button',{name:'Unir a outro contexto',exact:true}).click();await page.getByRole('dialog').getByLabel('Unir no contexto',{exact:true}).selectOption(fixture.expected.groupId);await confirm('group_merge');
  assert.equal((await read('/curation/semantic/groups/'+manualId)).group.status,'rejected');const merged=await read('/curation/semantic/groups/'+fixture.expected.groupId);assert.deepEqual(merged.members.map(member=>member.id).sort(),[...fixture.expected.memberIds,'QaFull_unknown'].sort(),'Merge is a union, never a doubled count');
  await selectGroup(fixture.expected.groupName);await page.getByRole('button',{name:'Organizar publicações',exact:true}).click();dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Incluir QaFull_single',{exact:true}).isChecked(),true);assert.equal(await dialog.getByLabel('Incluir QaFull_many',{exact:true}).isChecked(),true);await dialog.getByLabel('Incluir QaFull_unknown',{exact:true}).uncheck();await confirm('group_assign');
  const removalPost=semanticPosts().filter(call=>call.body.action==='group_assign').at(-1);assert.deepEqual(removalPost.body.addIds,[]);assert.deepEqual(removalPost.body.removeIds,['QaFull_unknown']);assert.equal(Object.hasOwn(removalPost.body,'reelIds'),false);
  assert.deepEqual((await read('/curation/semantic/groups/'+fixture.expected.groupId)).members.map(member=>member.id).sort(),fixture.expected.memberIds,'Removing one member preserves the entire unchanged selection');
  await page.getByRole('button',{name:'Retirar contexto',exact:true}).click();await confirm('group_reject');assert.equal((await read('/curation/semantic/groups/'+fixture.expected.groupId)).group.status,'rejected');
  const tree=await read('/categories');assert.equal(tree.nodes.some(node=>node.id==='semantic_'+fixture.expected.groupId),false,'Rejected context leaves the shared tree');assert.equal(fixture.calls.length,paidFixtureCalls);
 });
 await record('mobile_editorial_interface_and_no_source_processing_or_external_calls',async()=>{
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'semantic-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);assert.ok(overflow<=2,'Semantic workspace must fit the mobile viewport');
  assert.equal(sourceSnapshot(),originalSources,'Semantic and manual organization cannot edit saved analyses');
  assert.equal(server.calls.filter(call=>call.path==='/api/reels/commands').length,0);assert.equal(semanticPosts().filter(call=>call.body.action==='create').length,1);assert.equal(semanticPosts().filter(call=>call.body.action==='advance').length,0);
  assert.equal(fixture.calls.length,paidFixtureCalls);assert.deepEqual(server.externalAttempts,[]);assert.deepEqual(failures,[]);
 });
 await record('member_after_twenty_loads_complete_saved_proof_on_demand_without_inference',async()=>{
  await page.close();page=null;
  const proofFixture=makeProofNavigationFixture(),proofServer=await startReelsFixtureServer({semanticFixture:proofFixture});let proofContext,proofPage;
  try{
   const preview=await proofServer.semantic.preview({all:true});assert.equal(preview.preview.selectedCount,25);
   const created=await proofServer.semantic.create({selection:{all:true},previewHash:preview.previewHash,idempotencyKey:'fixture-proof-navigation25-start'});await proofServer.pumpSemantic();assert.equal((await proofServer.semantic.job(created.job.id)).job.status,'completed');
   assert.equal(proofFixture.calls.length,9);const group=(await proofServer.semantic.overview()).groups[0];
   proofContext=await browser.newContext({viewport:{width:1440,height:1000}});await proofContext.addCookies([{name:'qa_session',value:'local',url:proofServer.origin}]);
   await proofContext.route('**/*',route=>{if(new URL(route.request().url()).origin===proofServer.origin)return route.continue();failures.push('Unexpected proof browser external request');return route.abort();});
   proofPage=await proofContext.newPage();proofPage.setDefaultTimeout(20000);proofPage.on('pageerror',error=>failures.push(error.message));await proofPage.goto(proofServer.origin);
   await proofPage.getByRole('navigation').getByRole('button',{name:/Categorias/}).click();await proofPage.getByRole('button',{name:'Ver contexto Preparos com provas salvas',exact:true}).click();
   const detail=proofPage.getByRole('region',{name:'Detalhes do contexto semântico'}),member=detail.locator('article').filter({has:proofPage.getByRole('button',{name:'Prova salva QaProof_024',exact:true})});
   await detail.getByText('Trechos de 20 de 25 Reels disponíveis nesta leitura. Carregue os demais individualmente quando precisar.',{exact:true}).waitFor();
   const button=member.getByRole('button',{name:'Carregar provas de Prova salva QaProof_024',exact:true});await button.waitFor();
   assert.equal(await member.getByText('A evidência deste membro não está disponível nesta leitura.',{exact:true}).count(),0);
   assert.equal(proofServer.calls.filter(call=>call.query.includes('memberId=')).length,0,'Unopened members must not all fetch their raw proofs');
   const result=proofPage.waitForResponse(response=>{const url=new URL(response.url());return url.pathname===semanticPath+'/groups/'+group.id&&url.searchParams.get('memberId')==='QaProof_024';});await button.click();
   const payload=await (await result).json();assert.equal(payload.inferenceOnGet,false);assert.equal(payload.proofDetails.hydratedMembers,1);assert.equal(payload.proofDetails.rawPreserved,true);assert.equal(payload.members.length,25);
   await member.getByText('Por que este Reel pertence ao contexto',{exact:true}).click();await member.getByText('Frango na frigideira: tempere o frango, cozinhe na frigideira e sirva.',{exact:true}).waitFor();
   assert.equal(proofFixture.calls.length,9,'Loading saved proof is a GET, never a new semantic call');assert.equal(proofServer.calls.filter(call=>call.query.includes('memberId=')).length,1);assert.equal(proofServer.calls.filter(call=>call.method==='POST').length,0);
   assert.deepEqual(proofServer.externalAttempts,[]);proofJourneyCalls=proofFixture.calls.length;await proofPage.screenshot({path:join(output,'semantic-member25-saved-proof.png'),fullPage:true});
  }catch(error){await proofPage?.screenshot({path:join(output,'semantic-member-proof-failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{await writeFile(join(output,'proof-http-calls.json'),JSON.stringify(proofServer.calls,null,2));await proofContext?.close();await proofServer.close();}
 });
 const report={passed:true,checks,mode:'synthetic_saved_sources_real_workspace_API_and_queue_runner',savedPublications:5,syntheticProviderCalls:fixture.calls.length,syntheticProofNavigationCalls:proofJourneyCalls,realProviderCalls:0,newReelsProcessed:0,sourceAnalysesChanged:false,browserAdvancePosts:0,createPosts:1,limitations:['Synthetic model envelopes validate product orchestration and source binding, not semantic accuracy on the real499.','Google authentication, actual queue transport and deployed provider IAM require independent acceptance.']};
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,failures},null,2));await writeFile(join(output,'http-calls.json'),JSON.stringify(server.calls,null,2));throw error;}
finally{await browser?.close();await server.close();}
