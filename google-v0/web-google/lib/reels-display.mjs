// Presentation only. Raw values remain available in the UI's expandable details.
import {date,executionStatuses,text} from './reels-client.mjs';
const own=(map,key)=>typeof key==='string'&&Object.hasOwn(map,key)?map[key]:null;
const issueLabels={RECONCILIATION_REQUIRED:'Resultado a conferir'};
const destinations={reconcile:'Conferir resultado salvo',retry:'Conferir possibilidade de retomada'};
export const occurrenceLabel=error=>own(issueLabels,error?.code)||text(error?.message??error?.code);
export const destinationLabel=value=>own(destinations,value)||(value?'Destino a conferir':'Destino não informado');
const historicalStatuses={...executionStatuses,analyzed:'Analisado',pending:'Pendente',processing:'Em processamento',cancelled:'Cancelado',canceled:'Cancelado',paused:'Pausado',unknown:'Estado não informado'};
export const historicalStatusLabel=value=>own(historicalStatuses,value)||(value?'Estado registrado na origem':'Estado não informado');
const levels={info:'Informação',warning:'Verificação',error:'Erro'};
export const eventLevelLabel=value=>own(levels,value)||'Evento';
const eventTypes={published:'Resultado publicado',completed:'Etapa concluída',failed:'Falha registrada',queued:'Encaminhado à fila',started:'Etapa iniciada',uncertain:'Resultado a conferir',reconciliation_required:'Resultado a conferir'};
export const eventMessage=event=>typeof event?.message==='string'&&event.message.trim()?event.message:own(eventTypes,event?.type)||'Evento registrado';
const sources={'reels-v2-executions':'Registros da operação atual','reels-v2-executions.rawResult.finance':'Custos e uso registrados nas execuções'};
const labels={operational:'Operação',estimates:'Estimativas',measured:'Uso medido',billing:'Faturamento'};
const count=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value.toLocaleString('pt-BR'):null;
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('/'):'Data não informada';
function coverageLag(observedAt,referenceAt){
 const observed=typeof observedAt==='string'?Date.parse(observedAt):NaN,reference=typeof referenceAt==='string'?Date.parse(referenceAt):NaN;
 if(!Number.isFinite(observed)||!Number.isFinite(reference))return 'Atraso: desconhecido; datas de observação insuficientes.';
 const minutes=Math.floor((reference-observed)/60000);
 if(minutes<0)return 'Atraso: datas da fonte e da leitura divergem; confira a observação.';
 if(minutes<1)return 'Atraso da observação: menos de um minuto em relação à leitura.';
 return 'Atraso da observação: '+(minutes>=1440?Math.floor(minutes/1440)+' dia(s)':minutes>=60?Math.floor(minutes/60)+' hora(s)':minutes+' minuto(s)')+' em relação à leitura.';
}
export function financeCoverageRows(coverage,referenceAt){
 if(!coverage||typeof coverage!=='object'||Array.isArray(coverage))return [];
 return Object.entries(coverage).map(([kind,value])=>{
  const row={kind,label:own(labels,kind)||'Cobertura adicional',lines:[],raw:value};
  if(value===null||value===undefined){row.lines.push('Cobertura não informada.');return row;}
  if(typeof value==='string'){row.lines.push(value||'Cobertura não informada.');return row;}
  if(typeof value!=='object'||Array.isArray(value)){row.lines.push('Formato de cobertura antigo; consulte os detalhes.');return row;}
  if(value.from||value.to)row.lines.push('Período: '+day(value.from)+' a '+day(value.to)+'.');
  row.lines.push('Fonte: '+(own(sources,value.source)||(value.source?'Outra fonte registrada; consulte os detalhes.':'Não informada.')));
  row.lines.push('Observado em: '+date(value.observedAt)+'.');
  if(count(value.records)!==null)row.lines.push(count(value.records)+' registros com '+(kind==='estimates'?'estimativa':kind==='measured'?'uso medido':'dados')+'.');
  if(count(value.unavailableRecords)!==null)row.lines.push(count(value.unavailableRecords)+' registros sem medição disponível; custo desconhecido.');
  if(kind==='measured')row.lines.push('Última medição: '+date(value.lastMeasurementAt)+'.');
  if(typeof value.currency==='string'&&value.currency)row.lines.push('Moeda original: '+value.currency+'.');
  if(kind==='estimates')row.lines.push('Estimativa; não representa uso medido nem fatura.');
  if(kind==='measured')row.lines.push('Uso medido valorizado por preços de referência; não é fatura.');
  if(value.billingConfirmed===false)row.lines.push('Faturamento não confirmado.');
  if(kind==='billing'&&value.billingConfirmed!==false)row.lines.push(value.billingConfirmed===true?'Faturamento confirmado na fonte registrada.':'Confirmação de faturamento não informada nesta cobertura.');
  row.lines.push(coverageLag(value.observedAt,referenceAt));
  return row;
 });
}
