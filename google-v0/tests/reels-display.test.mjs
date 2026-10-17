import test from 'node:test';
import assert from 'node:assert/strict';
import {occurrenceLabel,destinationLabel,historicalStatusLabel,eventLevelLabel,eventMessage,financeCoverageRows} from '../web-google/lib/reels-display.mjs';
test('presentation labels preserve original occurrence and unknown identities',()=>{
 const error={code:'RECONCILIATION_REQUIRED',destination:'reconcile',message:'RECONCILIATION_REQUIRED',uncertain:true};const original=structuredClone(error);
 assert.equal(occurrenceLabel(error),'Resultado a conferir');assert.equal(destinationLabel(error.destination),'Conferir resultado salvo');assert.deepEqual(error,original);
 assert.equal(occurrenceLabel({message:'Mensagem antiga preservada'}),'Mensagem antiga preservada');
 for(const key of ['__proto__','constructor','NEW_STATE']){assert.equal(historicalStatusLabel(key),'Estado registrado na origem');assert.equal(destinationLabel(key),'Destino a conferir');assert.equal(eventLevelLabel(key),'Evento');assert.equal(eventMessage({type:key}),'Evento registrado');}
 assert.equal(historicalStatusLabel('waiting'),'Aguardando');assert.equal(historicalStatusLabel('analyzed'),'Analisado');assert.equal(eventMessage({message:'Mensagem original',type:'published'}),'Mensagem original');assert.equal(occurrenceLabel(null),'Não informado');
});
test('coverage keeps dates, currency and billing uncertainty separate without inventing zero',()=>{
 const coverage={estimates:{from:'2026-10-12',to:'2026-10-17',observedAt:'2026-10-17T10:00:00Z',source:'reels-v2-executions.rawResult.finance',records:2,currency:'BRL'},measured:{records:null,unavailableRecords:3,lastMeasurementAt:'2026-10-16T10:00:00Z',currency:'USD',billingConfirmed:false},billing:null};const copy=structuredClone(coverage),rows=financeCoverageRows(coverage,'2026-10-19T10:00:00Z');
 assert.deepEqual(coverage,copy);assert.deepEqual(rows.map(r=>r.raw),Object.values(copy));
 const estimates=rows[0].lines.join(' '),measured=rows[1].lines.join(' ');
 assert.match(estimates,/12\/10\/2026 a 17\/10\/2026/);assert.match(estimates,/2 dia\(s\)/);assert.match(estimates,/BRL/);assert.match(estimates,/não representa uso medido nem fatura/);assert.match(estimates,/Custos e uso registrados/);assert.doesNotMatch(estimates,/rawResult|records=|de=/);
 assert.match(measured,/3 registros sem medição disponível; custo desconhecido/);assert.match(measured,/Última medição: 16\/10\/2026/);assert.match(measured,/USD/);assert.match(measured,/Faturamento não confirmado/);assert.match(measured,/Atraso: desconhecido/);assert.doesNotMatch(measured,/0 registros|billingConfirmed/);assert.deepEqual(rows[2].lines,['Cobertura não informada.']);
});
test('missing and legacy coverage remains safe and original fields remain inspectable',()=>{
 for(const value of [null,undefined,'Cobertura antiga',false,[]])assert.deepEqual(financeCoverageRows(value),[]);
 const coverage={operational:'Texto antigo preservado',estimates:0,measured:{records:'7',observedAt:'invalid',source:'provider-new',unexpected:{key:'original'}},billing:{records:0,billingConfirmed:true}};
 const rows=financeCoverageRows(coverage);assert.equal(rows[0].lines[0],coverage.operational);assert.match(rows[1].lines[0],/Formato de cobertura antigo/);assert.match(rows[2].lines.join(' '),/Observado em: Não informado/);assert.doesNotMatch(rows[2].lines.join(' '),/7 registros|0 registros/);assert.deepEqual(rows[2].raw,coverage.measured);assert.match(rows[3].lines.join(' '),/0 registros com dados/);assert.match(rows[3].lines.join(' '),/Faturamento confirmado/);
});
