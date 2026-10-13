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
 assert.deepEqual(failures,[]);assert.ok(server.calls.some(x=>x.path.startsWith('/api/media/')));assert.ok(server.calls.every(x=>x.method==='GET'));
 await page.screenshot({path:join(output,'frontend-check.png'),fullPage:true});const report={passed:true,checks,mode:'synthetic_fixture_actual_components',google_calls:0,production_data_modified:false,credentials_loaded:false,http_calls:server.calls.length,limitations:['This does not validate production Google login or a real Instagram video.','Anonymous-route security is independently checked by existing image smoke tests.']};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.message,checks,failures}));throw error;}
finally{await browser?.close();await server.close();}
