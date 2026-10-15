import {attentionFixtures} from './attention-fixtures.mjs';
import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {chromium} from 'playwright';import {startFixtureServer} from './server.mjs';import {video as fixtureVideo}from './fixture.mjs';
const output=process.env.MEGABRAIN_QA_OUTPUT??join(tmpdir(),'megabrain-frontend-qa-results');await mkdir(output,{recursive:true});
const server=await startFixtureServer();let browser;const failures=[],checks=[];const record=async(name,action)=>{await action();checks.push(name);};
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():((failures.push('Unexpected external request')),route.abort()));
 const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
 await page.goto(server.origin);await record('dashboard_and_read_only_APIs',async()=>{await page.getByRole('heading',{name:'Visão geral'}).waitFor();await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await page.getByRole('heading',{name:'Model Distillation (destilação de modelos)',exact:true}).waitFor();});
 await record('details_and_original_name',async()=>{await page.getByRole('button').filter({has:page.getByRole('heading',{name:'Model Distillation (destilação de modelos)',exact:true})}).click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('Model Distillation (destilação de modelos)'));});
 await record('keywords_and_original_transcript',async()=>{await page.getByRole('button',{name:'Palavras-chave',exact:true}).click();assert.ok((await page.getByRole('dialog').innerText()).includes('#model_distillation'));await page.getByRole('button',{name:'Transcrição de áudio',exact:true}).click();assert.ok((await page.getByRole('dialog').innerText()).includes('Model distillation trains a smaller model.'));});
 await record('literal_evidence',async()=>{await page.getByRole('button',{name:'Conhecimento consolidado',exact:true}).click();await page.getByText('Aplicações e evidências',{exact:true}).click();await page.getByText('Consultar fontes',{exact:true}).click();assert.ok((await page.locator('blockquote').innerText()).includes('Model distillation trains a smaller model.'));});
 await record('synthetic_video_playback',async()=>{await page.getByRole('button',{name:'Vídeo original',exact:true}).click();await page.getByRole('button',{name:'Carregar vídeo privado',exact:true}).click();const video=page.locator('.video-preview.full video');await video.evaluate(v=>v.play());await page.waitForFunction(()=>{const v=document.querySelector('.video-preview.full video');return v&&v.readyState>=2&&v.currentTime>0&&!v.error;});});
 await page.getByRole('button',{name:'Fechar detalhes do Reel'}).click();
 await record('book_and_dual_language_search',async()=>{await page.getByRole('button',{name:'Livro de conhecimento',exact:true}).click();const search=page.getByLabel('Buscar no livro');for(const term of ['distillation','destilação']){await search.fill(term);await page.getByText('Model Distillation (destilação de modelos)',{exact:true}).first().waitFor();}await search.fill('');});
 await record('category_navigation',async()=>{await page.getByRole('button',{name:'Categorias',exact:true}).click();await page.getByRole('button').filter({has:page.getByText('Tecnologia',{exact:true})}).click();await page.getByRole('heading',{name:'Model Distillation (destilação de modelos)',exact:true}).waitFor();});
 await record('complete_library_and_refresh_over40',async()=>{
  const rows=Array.from({length:282},(_,i)=>{const v=structuredClone(fixtureVideo);v.id='Sync_'+i;if(i!==0&&i<218){v.analysis=null;v.transcript='';v.status=i<=25?'needs_attention':'pending';}return v;});
  rows[281].analysis.title='Resultado da última página';rows[281].analysis.knowledge.fields[0].name='Resultado da última página';
  server.setLibraryVideos(rows);
  const syncPage=await context.newPage();await syncPage.clock.install();await syncPage.goto(server.origin);
  const stat=label=>syncPage.locator('.dashboard-stats div').filter({has:syncPage.getByText(label,{exact:true})}).locator('b');
  await stat('Vídeos cadastrados').filter({hasText:/^282$/}).waitFor();
  assert.equal(await stat('Análises disponíveis').innerText(),'65');assert.equal(await stat('Itens para conferir').innerText(),'25');
  await syncPage.getByRole('button',{name:'Livro de conhecimento',exact:true}).click();await syncPage.getByLabel('Buscar no livro').fill('Resultado da última página');
  await syncPage.getByText('Resultado da última página',{exact:true}).first().waitFor();
  await syncPage.getByRole('button',{name:'Início',exact:true}).click();
  server.setLibraryFailure(40);await syncPage.getByRole('button',{name:'Atualizar',exact:true}).click();
  await syncPage.getByRole('alert').filter({hasText:'Synthetic later-page failure'}).waitFor();assert.equal(await stat('Vídeos cadastrados').innerText(),'282');assert.equal(await stat('Análises disponíveis').innerText(),'65');
  server.setLibraryFailure(null);rows.push({...structuredClone(fixtureVideo),id:'Sync_new'});server.setLibraryVideos(rows);
  await syncPage.clock.fastForward(60001);await stat('Vídeos cadastrados').filter({hasText:/^283$/}).waitFor();assert.equal(await stat('Análises disponíveis').innerText(),'66');
  await syncPage.screenshot({path:join(output,'frontend-full-library.png'),fullPage:true});await syncPage.close();server.setLibraryVideos([fixtureVideo]);
 });

 await record('automatic_registration_stage_changes_and_live_curated_details',async()=>{
  const id='Live_target',registered='Live_new_01';
  let target={id,status:'pending',analysis:null,transcript:'',media_verified:false};
  const rows=()=>[fixtureVideo,target,{id:registered,status:'pending',analysis:null,transcript:'',media_verified:false}];
  server.setLibraryVideos([fixtureVideo,target]);
  const live=await context.newPage();await live.clock.install();await live.goto(server.origin);
  await live.locator('.dashboard-stats div').filter({has:live.getByText('Vídeos cadastrados',{exact:true})}).locator('b').filter({hasText:/^2$/}).waitFor();
  await live.getByRole('button',{name:'Biblioteca',exact:true}).click();await live.getByText('Adicionar Reels',{exact:true}).click();await live.getByLabel('Até 100 links, um por linha').fill('https://www.instagram.com/reel/'+registered+'/');
  const hold=server.holdNextLibrary();await live.clock.fastForward(60001);await hold.started;
  const imported=live.waitForResponse(r=>r.url().endsWith('/api/import'));
  await live.getByRole('button',{name:'Cadastrar links',exact:true}).click();await imported;hold.release();
  await live.getByRole('heading',{name:registered,exact:true}).waitFor();
  await live.getByRole('button').filter({has:live.getByRole('heading',{name:id,exact:true})}).click();
  await live.getByRole('dialog').waitFor();
  const fullReads=()=>server.calls.filter(x=>x.path==='/api/library'&&!x.query?.includes('ids=')).length;
  const before=fullReads();
  target={...target,status:'downloaded',media_verified:true};server.setLibraryVideos(rows());await live.clock.fastForward(15001);
  await live.getByRole('dialog').getByText(/Transcrevendo áudio/).waitFor();
  target={...target,status:'transcribed',transcript_status:'recognized',transcript:'Transcrição final preservada.'};server.setLibraryVideos(rows());await live.clock.fastForward(15001);
  await live.getByRole('dialog').getByText(/Analisando vídeo/).waitFor();
  const curated=structuredClone(fixtureVideo);target={...curated,id,status:'analyzed',analysis_quality_status:'accepted',analysis_generation:'456',transcript:'Transcrição final preservada.'};
  target.analysis.title='Resultado curado automático';target.analysis.summary='Conhecimento final disponível automaticamente.';target.analysis.knowledge.keywords[0].term='Atualizacao';
  server.setLibraryVideos(rows());await live.clock.fastForward(15001);
  await live.getByRole('dialog').getByRole('heading',{name:'Resultado curado automático',exact:true}).waitFor();
  assert.equal(fullReads(),before,'Fast ticks must not reload the complete corpus');
  assert.ok((await live.getByRole('dialog').innerText()).includes('Conhecimento final disponível automaticamente.'));
  await live.getByRole('button',{name:'Palavras-chave',exact:true}).click();assert.ok((await live.getByRole('dialog').innerText()).includes('#atualizacao'));
  await live.getByRole('button',{name:'Transcrição de áudio',exact:true}).click();assert.ok((await live.getByRole('dialog').innerText()).includes('Transcrição final preservada.'));
  await live.screenshot({path:join(output,'frontend-live-curated-result.png'),fullPage:true});await live.close();server.setLibraryVideos([fixtureVideo]);
 });


 await record('late_playback_permission_recovers_without_manual_refresh',async()=>{
  const row={...structuredClone(fixtureVideo),id:'Late_ready'};server.setLibraryVideos([row]);server.setPlaybackReady(false);
  const late=await context.newPage();await late.clock.install();await late.goto(server.origin);await late.getByRole('button',{name:'Biblioteca',exact:true}).click();
  await late.getByRole('button').filter({has:late.getByRole('heading',{name:row.analysis.title,exact:true})}).click();
  await late.getByRole('button',{name:'Vídeo original',exact:true}).click();await late.getByRole('button',{name:'Carregar vídeo privado',exact:true}).click();
  await late.getByText('Reprodução ainda não liberada',{exact:true}).waitFor();server.setPlaybackReady(true);
  await late.clock.fastForward(15001);await late.getByRole('button',{name:'Carregar vídeo privado',exact:true}).waitFor();
  await late.getByRole('button',{name:'Carregar vídeo privado',exact:true}).click();await late.locator('.video-preview.full video').waitFor();
  await late.close();server.setPlaybackReady(true);server.setLibraryVideos([fixtureVideo]);
 });

 await record('attention_inventory_count_filters_and_safe_text',async()=>{
  const f=attentionFixtures();server.setLibraryVideos(f.videos);server.setProgress(f.items);
  const attention=await context.newPage();await attention.goto(server.origin);
  const stat=label=>attention.locator('.dashboard-stats div').filter({has:attention.getByText(label,{exact:true})}).locator('b');
  await stat('Vídeos cadastrados').filter({hasText:/^262$/}).waitFor();assert.equal(await stat('Análises disponíveis').innerText(),'207');assert.equal(await stat('Itens para conferir').innerText(),'61');
  await attention.getByRole('button',{name:'Conferir itens',exact:true}).click();await attention.getByText('61 resultados entre 262 vídeos cadastrados',{exact:true}).waitFor();
  for(const [reason,count,action]of [['source_metadata_failed',51,'Conferir a fonte e o diagnóstico; manter bloqueado.'],['schema_rejected',2,'Conferir o diagnóstico e os dados preservados; manter bloqueado, sem nova inferência.'],['analysis_unconfirmed',1,'Conferir a operação e eventuais respostas salvas; manter bloqueado, sem nova inferência.'],['candidate',1,'Conferir o candidato e preservar a análise publicada; não gerar outra resposta.'],['knowledge_review',6,'Conferir a extração preservada; não solicitar nova análise paga.']]){
   await attention.getByLabel('Filtrar motivo para conferir').selectOption(reason);await attention.getByText(`${count} resultados entre 262 vídeos cadastrados`,{exact:true}).waitFor();
   assert.ok((await attention.locator('.processing-indicator').first().innerText()).includes(action));
  }
  await attention.getByLabel('Filtrar motivo para conferir').selectOption('source_metadata_failed');assert.ok((await attention.locator('.processing-indicator').first().innerText()).includes('Isso não comprova que o Reel seja privado ou tenha sido excluído.'));
  assert.ok(!(await attention.locator('body').innerText()).includes('PRIVATE-DIAGNOSTIC'));assert.ok(!(await attention.locator('body').innerText()).includes('token=secret'));
  assert.equal(await attention.getByRole('button',{name:/tentar novamente|reprocessar|retry/i}).count(),0);
  await attention.screenshot({path:join(output,'frontend-attention-source.png'),fullPage:true});
  await attention.getByLabel('Filtrar motivo para conferir').selectOption('knowledge_review');await attention.getByRole('button').filter({has:attention.getByRole('heading',{name:'Model Distillation (destilação de modelos)',exact:true})}).first().click();
  assert.ok((await attention.getByRole('dialog').innerText()).includes('Conferir a extração preservada; não solicitar nova análise paga.'));assert.ok((await attention.getByRole('dialog').innerText()).includes('Explica o conceito de destilação de modelos, segundo o autor.'));
  await attention.screenshot({path:join(output,'frontend-attention-published.png'),fullPage:true});await attention.close();
  server.setProgress(null);server.setLibraryVideos([fixtureVideo]);
 });
 await record('attention_active_saved_response_and_malformed_details',async()=>{
  const malformed=structuredClone(fixtureVideo);malformed.id='Malformed_1';malformed.analysis.knowledge.fields=null;
  const rows=[malformed,{id:'Saved_1',status:'needs_attention',media_verified:true,transcript:'Preservada',analysis_key:'results/instagram/Saved_1/job_saved/analysis.json'},{id:'Active_1',status:'needs_attention',media_verified:true,transcript:'Preservada'},{id:'Blocked_1',status:'needs_attention',media_verified:false}];
  server.setLibraryVideos(rows);server.setProgress([{id:'Saved_1',stage:'analysis',status:'completed',version:'saved'},{id:'Active_1',stage:'analysis',status:'started',version:'active'},{id:'Blocked_1',stage:'upload',status:'reserved',version:'blocked'}]);
  const details=await context.newPage();await details.goto(server.origin);await details.getByRole('button',{name:'Conferir itens',exact:true}).click();await details.getByText('4 resultados entre 4 vídeos cadastrados',{exact:true}).waitFor();
  await details.getByRole('button').filter({has:details.getByRole('heading',{name:'Saved_1',exact:true})}).click();assert.ok((await details.getByRole('dialog').innerText()).includes('comprovar o encerramento antes de reconciliar, sem nova inferência'));await details.getByRole('button',{name:'Fechar detalhes do Reel'}).click();
  await details.getByRole('button').filter({has:details.getByRole('heading',{name:'Active_1',exact:true})}).click();assert.ok((await details.getByRole('dialog').innerText()).includes('Aguardar a operação; não repetir o processamento.'));await details.getByRole('button',{name:'Fechar detalhes do Reel'}).click();
  await details.getByRole('button').filter({has:details.getByRole('heading',{name:'Model Distillation (destilação de modelos)',exact:true})}).click();assert.ok((await details.getByRole('dialog').innerText()).includes('A estrutura de conhecimento está incompleta.'));
  await details.screenshot({path:join(output,'frontend-attention-malformed.png'),fullPage:true});await details.close();server.setProgress(null);server.setLibraryVideos([fixtureVideo]);
 });
 assert.deepEqual(failures,[]);assert.ok(server.calls.some(x=>x.path.startsWith('/api/media/')));assert.ok(server.calls.every(x=>x.method==='GET'||x.method==='POST'&&x.path==='/api/import'));
 await page.screenshot({path:join(output,'frontend-check.png'),fullPage:true});const report={passed:true,checks,mode:'synthetic_fixture_actual_components',google_calls:0,production_data_modified:false,credentials_loaded:false,http_calls:server.calls.length,limitations:['This does not validate production Google login or a real Instagram video.','Anonymous-route security is independently checked by existing image smoke tests.']};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.message,checks,failures}));throw error;}
finally{await browser?.close();await server.close();}
