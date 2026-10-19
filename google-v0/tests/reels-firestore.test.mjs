import test from 'node:test';import assert from 'node:assert/strict';import {Firestore,encodeFields}from '../lib/firestore.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
const prefix='projects/test-project/databases/(default)/documents/';
const stoppedCapacityInput=(stage='acquisition')=>({executionId:'a'.repeat(64),reelId:'Reel_001',stage,executionVersion:'job-v1',stopVersion:'stop-v1',videoVersion:'video-v1',control:{updateTime:'control-v1',data:{active:['a'.repeat(64),'b'.repeat(64)],paused:true,desiredConcurrency:1}},observedAt:'2026-10-19T01:00:00.000Z'});
function stoppedCapacityApi({mutateRows=rows=>rows,commitError,stage='acquisition'}={}){
 const calls=[],input=stoppedCapacityInput(stage);return {calls,input,project:'test-project',request:async(url,options)=>{
  calls.push({url,options});if(url.endsWith(':beginTransaction'))return {transaction:'bounded-capacity-transaction'};
  if(url.endsWith(':rollback'))return {};
  if(url.endsWith(':batchGet'))return mutateRows([['reels_executions/'+input.executionId,'job-v1'],['execution_stops/'+input.executionId,'stop-v1'],['videos/Reel_001','video-v1'],['reels_controls/'+stage,'control-v1']].map(([path,updateTime])=>({found:{name:prefix+path,updateTime,fields:{}}})));
  if(commitError)throw commitError;return {writeResults:[{updateTime:'control-v2'}]};
 }};
}
test('stopped acquisition slot release verifies every proof atomically and writes only capacity fields',async()=>{
 const api=stoppedCapacityApi(),db=new Firestore(api),{calls,input}=api;
 assert.deepEqual(await db.releaseStoppedPhysicalCapacity(input),{released:true});assert.equal(calls.length,3);assert.equal(calls[2].url,'https://firestore.googleapis.com/v1/'+prefix.slice(0,-1)+':commit');
 assert.deepEqual(calls[0].options.json,{options:{readWrite:{}}});assert.deepEqual(calls[1].options.json,{transaction:'bounded-capacity-transaction',documents:['reels_executions/'+input.executionId,'execution_stops/'+input.executionId,'videos/Reel_001','reels_controls/acquisition'].map(path=>prefix+path),mask:{fieldPaths:['id']}});
 assert.equal(calls[2].options.json.transaction,'bounded-capacity-transaction');const writes=calls[2].options.json.writes;assert.equal(writes.length,1);
 assert.deepEqual(writes[0],{update:{name:prefix+'reels_controls/acquisition',fields:encodeFields({active:['b'.repeat(64)],observedAt:input.observedAt})},updateMask:{fieldPaths:['active','observedAt']},currentDocument:{updateTime:'control-v1'}});
 assert.deepEqual(input.control.data.active,['a'.repeat(64),'b'.repeat(64)]);assert.equal(input.control.data.paused,true);
});
test('stopped capacity commit rejects a stale proof without blind write retries',async()=>{
 const api=stoppedCapacityApi({commitError:Object.assign(Error('changed version'),{status:412})}),db=new Firestore(api);
 assert.deepEqual(await db.releaseStoppedPhysicalCapacity(api.input),{released:false});assert.equal(api.calls.filter(c=>c.url.endsWith(':commit')).length,1);assert.ok(api.calls.at(-1).url.endsWith(':rollback'));
});
test('stopped capacity commit keeps ambiguous acknowledgement explicit without retrying',async()=>{
 const api=stoppedCapacityApi({commitError:Error('response lost')}),db=new Firestore(api);
 await assert.rejects(()=>db.releaseStoppedPhysicalCapacity(api.input),/response lost/);assert.equal(api.calls.filter(c=>c.url.endsWith(':commit')).length,1);assert.ok(api.calls.at(-1).url.endsWith(':rollback'));
});
for(const row of [0,1,2,3])test('transaction version change prevents any capacity write: proof '+row,async()=>{
 const api=stoppedCapacityApi({mutateRows:rows=>{rows[row].found.updateTime='changed';return rows;}}),db=new Firestore(api);
 assert.deepEqual(await db.releaseStoppedPhysicalCapacity(api.input),{released:false});assert.equal(api.calls.filter(c=>c.url.endsWith(':commit')).length,0);assert.ok(api.calls.at(-1).url.endsWith(':rollback'));
});
for(const kind of ['missing','duplicate','foreignProject','foreignPath','incomplete'])test('capacity transaction fails closed on '+kind+' proof response',async()=>{
 const api=stoppedCapacityApi({mutateRows:rows=>{
  if(kind==='missing')rows[0]={missing:rows[0].found.name};if(kind==='duplicate')rows[1]=rows[0];if(kind==='foreignProject')rows[0].found.name=rows[0].found.name.replace('test-project','foreign');if(kind==='foreignPath')rows[0].found.name=prefix+'videos/Other_001';if(kind==='incomplete')rows.pop();return rows;
 }}),db=new Firestore(api);
 if(kind==='missing')assert.deepEqual(await db.releaseStoppedPhysicalCapacity(api.input),{released:false});else await assert.rejects(()=>db.releaseStoppedPhysicalCapacity(api.input));
 assert.equal(api.calls.filter(c=>c.url.endsWith(':commit')).length,0);assert.ok(api.calls.at(-1).url.endsWith(':rollback'));
});
for(const field of ['executionId','reelId','stage','executionVersion','stopVersion','videoVersion','control','observedAt'])test('stopped capacity commit requires bounded identity and all proof versions: '+field,async()=>{
 let calls=0;const db=new Firestore({project:'test-project',request:async()=>{calls++;}}),input=stoppedCapacityInput();input[field]=null;
 await assert.rejects(()=>db.releaseStoppedPhysicalCapacity(input),/Prova de capacidade/);assert.equal(calls,0);
});
test('analysis local occupancy uses the same bounded transaction without mutating remote state',async()=>{
 const api=stoppedCapacityApi({stage:'analysis'}),db=new Firestore(api);assert.deepEqual(await db.releaseStoppedPhysicalCapacity(api.input),{released:true});
 assert.ok(api.calls[1].options.json.documents.includes(prefix+'reels_controls/analysis'));const writes=api.calls[2].options.json.writes;assert.equal(writes.length,1);assert.equal(writes[0].update.name,prefix+'reels_controls/analysis');assert.deepEqual(writes[0].updateMask.fieldPaths,['active','observedAt']);
});
test('a paid STT long-running operation is excluded from physical release primitive',async()=>{
 const api=stoppedCapacityApi({stage:'transcription'}),db=new Firestore(api);await assert.rejects(()=>db.releaseStoppedPhysicalCapacity(api.input),/Prova de capacidade/);assert.equal(api.calls.length,0);
});

test('import archive queries use projected fields in permitted inert collections through Firestore codec',async()=>{
 const calls=[],id='a'.repeat(64),db=new Firestore({project:'test-project',request:async(url,options)=>{calls.push(options.json.structuredQuery);const collection=options.json.structuredQuery.from[0].collectionId;return collection==='reels_historical_activity'?[{document:{name:prefix+collection+'/'+id,fields:encodeFields({id,kind:'execution',reelId:'Reel_001',stage:'analysis',sourceStatus:'waiting',historical:true,executable:false})}}]:[];}}),repository=new ReelsRepository({store:db});
 const result=await repository.historicalActivity({reelId:'Reel_001'});assert.equal(result.items[0].executable,false);assert.equal(result.items[0].sourceStatus,'waiting');assert.equal(calls[0].where.fieldFilter.field.fieldPath,'reelId');assert.ok(calls[0].select.fields.every(f=>!f.fieldPath.includes('provenance')&&!f.fieldPath.includes('raw')));
 await repository.historicalFinance();assert.equal(calls[1].from[0].collectionId,'reels_historical_finance');assert.ok(calls[1].select.fields.some(f=>f.fieldPath==='amount'));
});

test('stage plan accepts real Reel identities at its explicit map boundary only',()=>{
 const plan=Object.fromEntries([['0reel01','acquisition'],['_reel01','analysis'],['__proto__','transcription']]);const encoded=encodeFields({stagePlan:plan});assert.equal(encoded.stagePlan.mapValue.fields['0reel01'].stringValue,'acquisition');assert.equal(Object.hasOwn(encoded.stagePlan.mapValue.fields,'__proto__'),true);
 assert.throws(()=>encodeFields({other:plan}),/schema/);assert.throws(()=>encodeFields({stagePlan:{Reel_001:'budget'}}),/Plano/);
});
test('query sends leaf projection and stable name cursor, checks project and collection',async()=>{const calls=[];let response=[{document:{name:prefix+'videos/Reel_001',fields:encodeFields({id:'Reel_001',analysis:{title:'Title'}}),updateTime:'v1'}}];const db=new Firestore({project:'test-project',request:async(url,options)=>{calls.push({url,options});return response;}});const p=await db.query('videos',{select:['id','analysis.title'],limit:1});assert.deepEqual(p.records[0].data,{id:'Reel_001',analysis:{title:'Title'}});await db.query('videos',{select:['id','analysis.title'],limit:1,cursor:p.nextCursor});const q=calls[1].options.json.structuredQuery;assert.equal(q.startAt.before,false);assert.equal(q.startAt.values[0].referenceValue,prefix+'videos/Reel_001');assert.deepEqual(q.select.fields,[{fieldPath:'id'},{fieldPath:'analysis.title'}]);await assert.rejects(()=>db.query('reels_events',{cursor:p.nextCursor}),/Cursor/);response=[{document:{name:prefix+'jobs/Reel_001',fields:{}}}];await assert.rejects(()=>db.query('videos'),/coleção/);response=[{document:{name:'projects/other/databases/(default)/documents/videos/Reel_001'}}];await assert.rejects(()=>db.query('videos'),/projeto/);});
test('query validates field paths and operators; namespaced records preserve existing APIs',async()=>{const calls=[];const db=new Firestore({project:'test-project',request:async(url,options)=>{calls.push({url,options});return options?.json?.writes?{writeResults:options.json.writes.map(()=>({updateTime:'v2'}))}:options?.json?.structuredQuery?[]:{fields:options?.json?.fields??{},updateTime:'v1'};}});await assert.rejects(()=>db.query('videos',{select:['analysis;evil']}));await assert.rejects(()=>db.query('videos',{filters:[{field:'id',op:'unsafe',value:'x'}]}));await assert.rejects(()=>db.query('videos',{limit:2000}));await db.query('reels_events',{filters:[{field:'stage',op:'eq',value:'analysis'}]});assert.equal(calls[0].options.json.structuredQuery.where.fieldFilter.op,'EQUAL');for(const c of ['reels_commands','reels_command_items','reels_executions','reels_events','reels_controls'])assert.equal((await db.create(c+'/abc',{id:'abc'})).created,true);await assert.rejects(()=>db.commit([{path:'videos/abc',data:{status:'x'}}]),/precondição/);await db.commit([{path:'videos/abc',data:{status:'registered'},create:true},{path:'reels_controls/analysis',data:{paused:true},updateTime:'v1'}]);const writes=calls.at(-1).options.json.writes;assert.deepEqual(writes[0].currentDocument,{exists:false});assert.deepEqual(writes[1].currentDocument,{updateTime:'v1'});});
test('query exposes a consumption cursor even for a short final page',async()=>{const db=new Firestore({project:'test-project',request:async()=>[{document:{name:prefix+'reels_events/00001_hash',fields:encodeFields({at:'date'})}}]});const p=await db.query('reels_events',{limit:50});assert.equal(p.nextCursor,null);assert.equal(typeof p.lastCursor,'string');});
test('detail trajectory uses metadata projection and a valid collection cursor through the real codec',async()=>{
 const queries=[],stages=['acquisition','transcription','analysis'];
 const db=new Firestore({project:'test-project',request:async(url,options)=>{
  const query=options?.json?.structuredQuery;if(!query)return {fields:encodeFields({id:'Reel_001',status:'completed'}),updateTime:'v1'};
  queries.push(query);if(query.startAt)return [];
  return stages.map((stage,i)=>({document:{name:prefix+'reels_executions/'+(i===2?'qa_completed':'record_'+i),fields:encodeFields({id:i===2?'qa_completed':'record_'+i,reelId:'Reel_001',stage,worker:'reels-'+stage,attempt:1,status:'completed',createdAt:'2026-10-16T10:0'+i+':00Z',startedAt:'2026-10-16T10:0'+i+':01Z',completedAt:'2026-10-16T10:0'+i+':10Z'})}}));
 }});
 const detail=await new ReelsRepository({store:db}).detail('Reel_001');assert.deepEqual(detail.executions.map(e=>e.stage),stages);assert.equal(detail.executions[2].id,'qa_completed');
 const q=queries[0];assert.equal(q.from[0].collectionId,'reels_executions');assert.equal(q.limit,100);assert.equal(q.where.fieldFilter.field.fieldPath,'reelId');assert.equal(q.where.fieldFilter.value.stringValue,'Reel_001');assert.ok(q.select.fields.every(f=>!f.fieldPath.startsWith('rawResult')&&!f.fieldPath.includes('transcript')));assert.ok(q.select.fields.some(f=>f.fieldPath==='worker'));
 await db.query('reels_executions',{select:['id','reelId'],filters:[{field:'reelId',op:'eq',value:'Reel_001'}],orderBy:[{field:'__name__',direction:'ASCENDING'}],limit:100,cursor:detail.executionsHistory.cursor});assert.equal(queries[1].startAt.before,false);assert.equal(queries[1].startAt.values[0].referenceValue,prefix+'reels_executions/qa_completed');
});
