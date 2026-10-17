import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {startReelsFixtureServer} from './reels-server.mjs';
const output=process.env.MEGABRAIN_REELS_OPERATIONS_QA_OUTPUT??join(tmpdir(),'megabrain-reels-operations-qa');
await mkdir(output,{recursive:true});
const server=await startReelsFixtureServer({operational:true}),checks=[],errors=[];
let browser,page;
const responseFor=(path,method='GET')=>{const wait=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);wait.catch(()=>{});return wait;};
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'qa_session',value:'local',url:server.origin}]);
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===server.origin)return route.continue();errors.push('Unexpected external browser request');return route.abort();});
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.clock.install();await page.goto(server.origin);
 await page.getByLabel('Selecionar Entrada 000',{exact:true}).check();const planned=responseFor('/api/reels/preview','POST');await page.getByRole('button',{name:'Prévia do lote',exact:true}).click();await planned;
 const dialog=page.getByRole('dialog',{name:'Prévia de admissão'}),accepted=responseFor('/api/reels/commands','POST');await dialog.getByRole('button',{name:'Solicitar início ao servidor',exact:true}).click();const acceptedResponse=await accepted;assert.equal(acceptedResponse.status(),200);const receipt=await acceptedResponse.json();
 assert.equal(receipt.operation.status,'pending');assert.deepEqual(receipt.operation.accepted,[]);assert.equal((await server.repository.raw('QaReg_000')).status,'registered');
 await dialog.getByRole('button',{name:'Fechar painel',exact:true}).click();await page.getByText('Última operação persistida',{exact:true}).waitFor();
 const recovery=responseFor('/api/reels/commands','POST');await page.getByRole('button',{name:'Retomar admissão',exact:true}).click();const recovered=await recovery;assert.equal(recovered.status(),200);const recoveredData=await recovered.json();assert.equal(recoveredData.operation.id,receipt.operation.id);assert.notEqual(recoveredData.recovery.id,receipt.operation.id);assert.equal([...server.tasks.values()].filter(task=>task.httpRequest.url.endsWith('/tasks/control')).length,2);checks.push('explicit_control_recovery_preserves_original_selection_and_operation');
 assert.equal(await server.pumpControls(),2);const status=responseFor('/api/reels/commands/'+receipt.operation.id);await page.clock.fastForward(3001);const completed=await (await status).json();assert.equal(completed.operation.status,'completed');assert.deepEqual(completed.operation.accepted,['QaReg_000']);await page.getByText('Admissão: 1 de 1 itens conferidos.',{exact:true}).waitFor();
 const stageTask=[...server.tasks.values()].find(task=>task.httpRequest.url.endsWith('/tasks/run'));assert.ok(stageTask);assert.equal((await server.repository.raw('QaReg_000')).reels_v2.status,'queued');checks.push('real_web_command_durable_acceptance_controller_progress_and_stage_outbox');
 const inventory=responseFor('/api/reels/items');await page.getByRole('button',{name:'Acervo completo',exact:true}).click();await inventory;
 const search=responseFor('/api/reels/items');await page.getByLabel('Buscar no acervo').fill('Operação salva para conferir');await page.clock.fastForward(501);await search;
 await page.getByRole('button',{name:/Operação salva para conferir/}).click();const detail=page.getByRole('dialog',{name:'Operação salva para conferir',exact:true});await detail.getByRole('button',{name:'Detalhes',exact:true}).click();
 const collect=detail.getByRole('button',{name:'Consultar operação externa já registrada',exact:true});await collect.waitFor();assert.equal(await collect.isEnabled(),true);await detail.getByText('Vínculo verificado',{exact:true}).waitFor();assert.equal(await detail.getByRole('button',{name:'Solicitar retomada ao servidor',exact:true}).count(),0);
 const submitted=responseFor('/api/reels/reconciliations','POST');await collect.click();const reconciled=await submitted;assert.equal(reconciled.status(),200);const result=await reconciled.json();assert.equal(result.reconciliation.executionStatus,'waiting');
 await detail.getByRole('status').filter({hasText:'Conciliação registrada.'}).waitFor();const pollTasks=[...server.tasks.values()].filter(task=>JSON.parse(Buffer.from(task.httpRequest.body,'base64').toString()).poll===true);assert.equal(pollTasks.length,1);assert.ok(pollTasks[0].httpRequest.url.includes('transcription'));checks.push('verified_saved_operation_collects_same_LRO_through_worker_outbox_without_resubmission');
 const replay=await context.request.post(server.origin+'/api/reels/reconciliations',{headers:{Origin:server.origin},data:server.calls.filter(call=>call.path==='/api/reels/reconciliations'&&call.method==='POST').at(-1).body});assert.equal(replay.status(),200);assert.equal([...server.tasks.values()].filter(task=>JSON.parse(Buffer.from(task.httpRequest.body,'base64').toString()).poll===true).length,1);checks.push('reconciliation_receipt_replay_no_duplicate_delivery');
 await detail.getByRole('button',{name:'Fechar painel',exact:true}).click();await page.getByRole('navigation').getByRole('button',{name:/Atividade/}).click();await page.getByText('Comando de conciliação concluído; consulte o percurso da execução.',{exact:true}).waitFor();checks.push('reconciliation_visible_in_real_activity_component');
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(server.origin+'/api/reels/reconciliations/'+result.reconciliation.executionId)).status(),401);await anonymous.close();assert.equal((await context.request.post(server.origin+'/api/reels/reconciliations',{headers:{Origin:'https://invalid.invalid'},data:{}})).status(),403);assert.deepEqual(server.externalAttempts,[]);assert.deepEqual(errors,[]);checks.push('authentication_origin_no_external_fetch_no_provider_adapter');
 await page.screenshot({path:join(output,'operations-activity.png'),fullPage:true});
 const report={passed:true,checks,mode:'synthetic_data_real_web_API_services_dispatcher_control_and_reconciliation',providerCalls:0,realReelsProcessed:0,productionMutations:0,limitations:['Synthetic task transport; real Google IAM/queue delivery and provider processing require a separately authorized pilot.','Stage delivery is retained as outbox in browser QA; full synthetic worker chain is covered by service integration tests.']};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,errors},null,2));throw error;}
finally{await browser?.close();await server.close();}
