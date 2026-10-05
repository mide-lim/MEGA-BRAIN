// Standard Cloud Billing export; queries are bounded and never run on page visits.
export function billingQuery({project,dataset='megabrain_billing',table,start,end}){
 if(!/^[a-z][a-z0-9-]{4,29}$/.test(project)||!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(dataset)||!/^gcp_billing_export_v1_[A-Za-z0-9_]+$/.test(table??''))throw Error('Destino Billing inválido.');
 const a=Date.parse(start),b=Date.parse(end);if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>32*86400000)throw Error('Período Billing inválido.');
 return {query:`SELECT project.id AS project_id, currency, SUM(cost) AS usage_cost, SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c),0)) AS credits_applied, MAX(usage_end_time) AS usage_through, MAX(export_time) AS exported_at FROM \`${project}.${dataset}.${table}\` WHERE usage_start_time >= @start AND usage_start_time < @end AND _PARTITIONTIME >= TIMESTAMP_SUB(@start, INTERVAL 2 DAY) GROUP BY project.id,currency`,useLegacySql:false,maximumBytesBilled:'104857600',timeoutMs:20000,location:'US',parameterMode:'NAMED',queryParameters:[{name:'start',parameterType:{type:'TIMESTAMP'},parameterValue:{value:start+'T00:00:00Z'}},{name:'end',parameterType:{type:'TIMESTAMP'},parameterValue:{value:end+'T00:00:00Z'}}]};
}
export function summarizeBilling(rows,project){
 if(!Array.isArray(rows)||!rows.length)throw Error('Exportação ainda sem dados; preservar snapshot anterior.');
 const cents=n=>Math.round(Number(n)*100);if(rows.some(r=>r.currency!=='BRL'||!Number.isFinite(Number(r.usage_cost))||!Number.isFinite(Number(r.credits_applied))))throw Error('Moeda ou custo inválido.');
 const own=rows.filter(r=>r.project_id===project);if(!own.length)throw Error('Projeto ausente; não substituir por zero.');
 return {project_usage_cents:own.reduce((n,r)=>n+cents(r.usage_cost),0),account_usage_cents:rows.reduce((n,r)=>n+cents(r.usage_cost),0),account_net_cents:rows.reduce((n,r)=>n+cents(Number(r.usage_cost)+Number(r.credits_applied)),0),usage_through:rows.map(r=>r.usage_through).sort().at(-1),exported_at:rows.map(r=>r.exported_at).sort().at(-1)};
}
