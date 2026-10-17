import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsService} from '../lib/reels-service.mjs';
import {publicationAvailable} from '../lib/reels-model.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
const legacy=(id,extra={})=>({schemaVersion:1,reelId:id,status:'legacy_preserved',originalStatus:'analyzed',historical:true,executable:false,provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64),path:'PRIVATE_BACKUP_PATH'},analysis:{primary_category:'Receitas',summary:'Conhecimento antigo preservado',topics:['frango'],claims:[{claim:'Uma preparação',evidence_quote:'Uma frigideira',status:'supported'}],useful_value:['Preparar em uma panela'],quality_flags:['Detalhes parciais na análise antiga'],human_verified:false,paperclip_issue:'PRIVATE_ISSUE',candidate_relations:[]},transcript:'TRANSCRIPT_DETAIL_ONLY',...extra});
const historical=(id,extra={})=>({id:id.toString(16).padStart(64,'0'),kind:'execution',reelId:'Reel_00001',stage:'analysis',sourceStatus:'waiting',historical:true,executable:false,createdAt:'2026-10-16T10:00:00Z',provenance:[{path:'PRIVATE_BACKUP_PATH'}],rawResult:'PRIVATE_RESULT',...extra});
test('3005 copy records, lightweight legacy joins, full detail only and stable categories',async()=>{
 const docs={};for(let n=0;n<3005;n++){const id='Reel_'+String(n).padStart(5,'0');docs['videos/'+id]={id,status:'registered',import_hold:{active:true},created_at:'2026-10-16T00:00:00Z'};}
 docs['reels_legacy_content/Reel_00001']=legacy('Reel_00001');
 docs['reels_legacy_content/Reel_00002']=legacy('Reel_00002',{originalStatus:'needs_attention'});
 const store=memoryReelsStore(docs),repository=new ReelsRepository({store});const ids=[];let cursor;do{const p=await repository.list({limit:100,cursor});ids.push(...p.items.map(i=>i.id));cursor=p.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,3005);const library=await repository.list({workspace:'library'});assert.equal(library.total,1);assert.equal(library.items[0].publication.source,'legacy_preserved');assert.deepEqual(library.items[0].categoryIds,['receitas']);assert.equal(library.items[0].status,'completed');assert.equal((await repository.categories()).nodes.find(n=>n.id==='group-alimentacao').count,1);
 const selects=store.reads.filter(r=>r.collection==='reels_legacy_content');assert.ok(selects.length>0);assert.ok(selects.every(r=>!r.select.includes('analysis')&&!r.select.includes('transcript')&&!r.select.includes('analysis.claims')));assert.ok(!JSON.stringify(library).includes('TRANSCRIPT_DETAIL_ONLY'));
 const detail=await repository.detail('Reel_00001');assert.equal(detail.transcript.text,'TRANSCRIPT_DETAIL_ONLY');assert.equal(detail.analysis.legacy.claims[0].evidence_quote,'Uma frigideira');assert.equal(detail.analysis.insights[0],'Preparar em uma panela');assert.deepEqual(detail.analysis.legacy.qualityFlags,['Detalhes parciais na análise antiga']);assert.equal(detail.analysis.legacy.humanVerified,false);assert.ok(!JSON.stringify(detail).includes('PRIVATE_'));assert.equal(publicationAvailable(docs['videos/Reel_00001']),false);
 assert.equal((await repository.select({all:true})).eligible,0);assert.ok((await repository.select({all:true})).excluded.every(e=>e.reason==='migration_hold'));
});
test('current Google result wins and uncertainty is never hidden by old preserved knowledge',async()=>{
 const current={id:'Reel_00001',status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'Atual',categories:['Hardware']}};
 const store=memoryReelsStore({'videos/Reel_00001':current,'reels_legacy_content/Reel_00001':legacy('Reel_00001')}),repository=new ReelsRepository({store});
 const d=await repository.detail(current.id);assert.equal(d.analysis.summary,'Atual');assert.equal(d.preservedAnalysis.source,'legacy_preserved');assert.deepEqual(d.categoryIds,['hardware-setup']);
 store.docs.get('videos/Reel_00001').data={id:current.id,status:'uncertain',error:{uncertain:true}};await repository.refresh(current.id);const preserved=await repository.detail(current.id);assert.equal(preserved.status,'uncertain');assert.equal(preserved.error.uncertain,true);assert.equal(preserved.publication.source,'legacy_preserved');assert.equal((await repository.list({workspace:'library'})).total,1);
});
test('all processing command paths enforce migration hold even with processing enabled',async()=>{
 const docs={'videos/Reel_00001':{id:'Reel_00001',status:'registered',import_hold:{active:true}},'videos/Reel_00002':{id:'Reel_00002',status:'failed',failure_confirmed:true,import_hold:{active:true}},'videos/Reel_00003':{id:'Reel_00003',status:'analyzed',analysis_key:'a',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{},import_hold:{active:true}}};
 const store=memoryReelsStore(docs),service=new ReelsService({repository:new ReelsRepository({store}),processingEnabled:true,onCommandQueued:async()=>({status:'sent'}),onQueued:()=>assert.fail('held Reel cannot dispatch a stage')});
 for(const [n,type]of ['start','retry','complement'].entries()){
  const result=await service.command({type,idempotencyKey:'held-command-'+n,selection:{ids:['Reel_00001','Reel_00002','Reel_00003']}});
  assert.equal(result.operation.status,'pending');assert.deepEqual(result.operation.accepted,[]);
  const drained=await service.drain({operationId:result.operation.id});assert.equal(drained.operation.status,'completed');assert.deepEqual(drained.operation.accepted,[]);
 }
 assert.equal([...store.docs.keys()].some(k=>k.startsWith('reels_executions/')),false);
 for(const [path,data]of Object.entries(docs))assert.deepEqual((await store.get(path)).data,data);
});
test('history is paged, filtered, inert and detached rows do not reappear in Reel details',async()=>{
 const docs={};for(let n=0;n<103;n++){const row=historical(n);docs['reels_historical_activity/'+row.id]=row;}const detached=historical(104,{reason:'NEW_REGISTERED_COPY_HISTORY_DETACHED'});docs['reels_historical_activity/'+detached.id]=detached;
 const store=memoryReelsStore(docs),repository=new ReelsRepository({store});const first=await repository.historicalActivity({limit:50});assert.equal(first.items.length,50);assert.equal(first.hasMore,true);assert.equal((await repository.historicalActivity({limit:100,cursor:first.nextCursor})).items.length,54);assert.ok(!JSON.stringify(first).includes('PRIVATE_'));assert.equal(first.executable,false);
 const linked=await repository.historicalActivity({limit:100,reelId:'Reel_00001',cursor:first.nextCursor});assert.equal(linked.items.length,53);assert.ok(linked.items.every(r=>!r.detached));assert.deepEqual((await repository.historicalActivity({sourceStatus:'failed'})).items,[]);assert.ok(store.reads.every(r=>r.select&&!r.select.includes('rawResult')&&!r.select.includes('provenance')));
});
test('historical finance separates kinds and original currencies; unknown amounts/dates remain unknown',async()=>{
 const docs={};for(const [n,kind,amount,currency,day]of [[0,'accounting',2,'BRL',null],[1,'reservation',4,'BRL',null],[2,'unknown',null,null,null],[3,'provider_usage',0.25,'USD','2026-10-16']]){const row={...historical(n),kind,amount,currency,day};docs['reels_historical_finance/'+row.id]=row;}
 const store=memoryReelsStore(docs),repository=new ReelsRepository({store});const finance=await repository.historicalFinance();assert.equal(finance.groups.length,4);assert.equal(finance.groups.find(g=>g.kind==='unknown').amount,null);assert.equal(finance.coverage.withoutDate,3);assert.equal(finance.coverage.billingConfirmed,false);assert.ok(!JSON.stringify(finance).includes('PRIVATE_'));
 const api=reelsAPI({repository,authorize:()=>false,sameOrigin:()=>true});for(const path of ['historical-activity','historical-finance'])assert.equal((await api(new Request('https://reels.test/api/reels/'+path))).status,401);
 const authorized=reelsAPI({repository,authorize:()=>true,sameOrigin:()=>true});assert.equal((await authorized(new Request('https://reels.test/api/reels/historical-finance'))).status,200);assert.equal((await authorized(new Request('https://reels.test/api/reels/historical-activity',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status,404);
});

 test('transcript-only legacy source stays consultable without entering library or categories',async()=>{
  const id='Reel_00001',store=memoryReelsStore({['videos/'+id]:{id,status:'uncertain',import_hold:{active:true}},['reels_legacy_content/'+id]:legacy(id,{analysis:null,originalStatus:'no_speech'})}),repository=new ReelsRepository({store});
  const detail=await repository.detail(id);assert.equal(detail.transcript.text,'TRANSCRIPT_DETAIL_ONLY');assert.equal(detail.transcript.source,'legacy_preserved');assert.equal(detail.publication.available,false);assert.equal((await repository.list({workspace:'library'})).total,0);assert.equal((await repository.categories()).total,0);
 });

 test('exact official display names retain their existing destinations without inventing free-label categories',async()=>{
  const docs={};for(const [n,name]of ['Exercício físico','Design digital','Assunto livre sem classificação'].entries()){const id='Reel_0000'+n,old=legacy(id);old.analysis.primary_category=name;docs['videos/'+id]={id,status:'uncertain',import_hold:{active:true}};docs['reels_legacy_content/'+id]=old;}
  const repository=new ReelsRepository({store:memoryReelsStore(docs)});assert.deepEqual((await repository.detail('Reel_00000')).categoryIds,['exercicio-fisico']);assert.deepEqual((await repository.detail('Reel_00001')).categoryIds,['design-digital']);assert.deepEqual((await repository.detail('Reel_00002')).categoryIds,['a-organizar']);assert.equal((await repository.categories()).nodes.filter(n=>n.parentId===null).length,3);
 });

 test('legacy quality alerts retain historical verification and omit unrelated private fields',async()=>{
  for(const human of [true,false,null]){const id='Reel_00001',old=legacy(id);old.analysis.quality_flags=['Detalhes incompletos',{code:'PARTIAL_DETAIL',severity:'warning',description:'Informação parcial na origem',rawResult:'PRIVATE_DIAGNOSTIC',path:'PRIVATE_BACKUP_PATH'}];old.analysis.human_verified=human;const repository=new ReelsRepository({store:memoryReelsStore({['videos/'+id]:{id,status:'uncertain',import_hold:{active:true}},['reels_legacy_content/'+id]:old})});const detail=await repository.detail(id);assert.deepEqual(detail.analysis.legacy.qualityFlags,['Detalhes incompletos',{code:'PARTIAL_DETAIL',severity:'warning',description:'Informação parcial na origem'}]);assert.equal(detail.analysis.legacy.humanVerified,human);assert.equal(detail.publication.qualityStatus,'legacy_preserved');assert.ok(!JSON.stringify(detail).includes('PRIVATE_'));}
 });
