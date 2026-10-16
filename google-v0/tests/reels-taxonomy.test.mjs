import test from 'node:test';import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
function memory(videos=[]){const docs=new Map(videos.map(v=>['videos/'+v.id,{data:structuredClone(v),updateTime:'1'}]));let version=1;const store={docs,get:async p=>structuredClone(docs.get(p)??null),create:async(p,d)=>{if(docs.has(p))return {created:false};const r={data:structuredClone(d),updateTime:String(++version)};docs.set(p,r);return {created:true,...structuredClone(r)};},patch:async(p,d,{updateTime}={})=>{const old=docs.get(p);if(old?.updateTime!==updateTime)throw Object.assign(Error('conflict'),{status:412});const r={data:{...old.data,...structuredClone(d)},updateTime:String(++version)};docs.set(p,r);return structuredClone(r);},list:async(c,{pageSize=100,pageToken}={})=>{const rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b)),n=Number(pageToken??0);return {records:rows.slice(n,n+pageSize).map(([path,r])=>({path,...structuredClone(r)})),nextPageToken:n+pageSize<rows.length?String(n+pageSize):null};},query:async(c,{limit=500,cursor,select,filters=[]}={})=>{let rows=[...docs].filter(([p])=>p.startsWith(c+'/')).sort(([a],[b])=>a.localeCompare(b));for(const f of filters)rows=rows.filter(([,v])=>v.data[f.field]===f.value);const n=Number(cursor??0);return {records:rows.slice(n,n+limit).map(([path,r])=>({path,...structuredClone(r)})),nextCursor:n+limit<rows.length?String(n+limit):null};}};return store;}
const clock=()=>Date.parse('2026-10-16T03:30:00Z');
const reel=(id='Reel_001',extra={})=>({id,status:'registered',created_at:'2026-10-16T03:00:00Z',...extra});
const pub=(id='Reel_001',extra={})=>reel(id,{status:'analyzed',analysis_key:'saved',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{summary:'original',evidence:{categories:[]}},...extra});
import {ReelsTaxonomy,recipeRecurrence} from '../lib/reels-taxonomy.mjs';
import {hash} from '../lib/reels-runtime.mjs';
test('taxonomy retains legacy categories on first mutation and rejects cycles/dedup',async()=>{const store=memory([pub('Reel_001',{categoryIds:['legacy'],analysis:{summary:'saved',categoryDefinitions:[{id:'legacy',name:'Legado'}]}})]),repository=new ReelsRepository({store,clock}),taxonomy=new ReelsTaxonomy({repository,clock});await taxonomy.mutate({idempotencyKey:'create-child-1',action:'create',revision:0,name:'Filha',parentId:'legacy'});let state=(await store.get('settings/reels_v2_taxonomy')).data;assert.ok(state.nodes.some(n=>n.id==='legacy'));const child=state.nodes.find(n=>n.id!=='legacy').id;await assert.rejects(()=>taxonomy.mutate({idempotencyKey:'move-cycle-123',action:'move',revision:1,id:'legacy',parentId:child}),e=>e.code==='CATEGORY_CYCLE');await assert.rejects(()=>taxonomy.mutate({idempotencyKey:'create-duplicate',action:'create',revision:1,name:'Filha',parentId:'legacy'}),e=>e.code==='DUPLICATE_CATEGORY');});
test('broad reclassification requires exact preview and revision; replay repairs partial assignment',async()=>{const store=memory([pub('Reel_001'),pub('Reel_002')]),repository=new ReelsRepository({store,clock}),taxonomy=new ReelsTaxonomy({repository,clock});await store.create('settings/reels_v2_taxonomy',{revision:1,nodes:[{id:'category',name:'Categoria',parentId:null}],assignments:[],rules:[],appliedCommands:[]});const input={idempotencyKey:'reclassify-123',action:'reclassify',revision:1,reelIds:['Reel_001','Reel_001','Reel_002'],categoryIds:['category','category']};await assert.rejects(()=>taxonomy.mutate(input),e=>e.code==='PREVIEW_REQUIRED');const preview=await taxonomy.mutate({...input,preview:true});assert.equal(preview.preview.affected,2);const patch=store.patch;let lost=true;store.patch=async(p,d,o)=>{const r=await patch(p,d,o);if(p==='videos/Reel_001'&&lost){lost=false;throw Error('lost');}return r;};const confirmed={...input,confirmed:true,previewToken:preview.previewToken};await assert.rejects(()=>taxonomy.mutate(confirmed),/lost/);await taxonomy.mutate(confirmed);assert.deepEqual((await store.get('videos/Reel_002')).data.categoryIds,['category']);assert.equal((await store.get('settings/reels_v2_taxonomy')).data.revision,2);});
test('server segment uses versioned evidence and unique Reel support, preserves manual override',async()=>{const proof={categoryId:'science',source:'transcript:segment-1',confidence:0.9},videos=[pub('Reel_001',{analysis:{evidence:{categories:[proof,proof]}}}),pub('Reel_002',{analysis:{evidence:{categories:[proof]}}}),pub('Reel_003',{analysis:{evidence:{categories:[proof]}},taxonomy_override:{manual:true,revision:1}})],store=memory(videos),repository=new ReelsRepository({store,clock}),taxonomy=new ReelsTaxonomy({repository,clock});await store.create('settings/reels_v2_taxonomy',{revision:1,nodes:[{id:'science',name:'Ciência',parentId:null}],assignments:[],rules:[],appliedCommands:[]});const input={idempotencyKey:'segment-12345',action:'segment',revision:1,id:'science',minSupport:2,minRatio:0.8};const preview=await taxonomy.mutate({...input,preview:true});assert.deepEqual(preview.preview.ids,['Reel_001','Reel_002']);await taxonomy.mutate({...input,previewToken:preview.previewToken,confirmed:true});assert.equal((await store.get('videos/Reel_003')).data.categoryIds,undefined);const state=(await store.get('settings/reels_v2_taxonomy')).data;assert.equal(state.rules.length,1);assert.equal(state.rules[0].version,1);assert.equal(state.nodes[0].evidenceCount,2);});

function supportedRecipe(id,count=1,extra={}){
 const units=Array.from({length:count},(_,i)=>({id:'preparation_'+i,kind:'recipe',title:['Sopa completa','Arroz completo','Bolo completo'][i],evidence:[{source:'transcript',start_seconds:i*20,end_seconds:i*20+['Prepare a sopa do início ao fim.','Prepare também o arroz completo.','Faça separadamente o bolo completo.'][i].split(' ').length,excerpt:['Prepare a sopa do início ao fim.','Prepare também o arroz completo.','Faça separadamente o bolo completo.'][i]}]}));
 const transcript_words=units.flatMap(u=>u.evidence.flatMap(e=>e.excerpt.split(' ').map((word,i)=>({word,start_seconds:e.start_seconds+i,end_seconds:e.start_seconds+i+1}))));
 return pub(id,{categoryIds:['recipes'],duration_seconds:90,transcript:units.flatMap(u=>u.evidence.map(e=>e.excerpt)).join(' '),transcript_words,analysis:{summary:'Fonte preservada',taxonomySignals:{version:1,parentCategoryId:'recipes',complete:true,confidence:0.95,units}},...extra});
}
async function discoverySetup(videos,{indexed=true}={}){
 const store=memory(videos),repository=new ReelsRepository({store,clock}),taxonomy=new ReelsTaxonomy({repository,clock});
 await store.create('settings/reels_v2_taxonomy',{revision:0,nodes:[{id:'recipes',name:'Receitas',parentId:null},{id:'other',name:'Outro',parentId:null}],assignments:[],rules:[],appliedCommands:[]});
 if(indexed)for(const video of videos)await taxonomy.indexPublication(video,video.id,0.8);
 return {store,repository,taxonomy};
}
test('structured recurrence creates stable sibling formats from unique published Reel support',async()=>{
 const videos=[...Array.from({length:3},(_,i)=>supportedRecipe('Single_'+i)),...Array.from({length:3},(_,i)=>supportedRecipe('Collection_'+i,2)),supportedRecipe('Manual_01',2,{taxonomy_override:{manual:true,revision:0}})];
 const {store,taxonomy}=await discoverySetup(videos),input={automatic:true,sourceReelId:'Manual_01',sourceExecutionId:hash('publication-one')};
 const first=await taxonomy.discover(input);assert.equal(first.proposals.length,2);assert.equal(first.coverage.manual,1);
 const state=(await store.get('settings/reels_v2_taxonomy')).data,children=state.nodes.filter(n=>n.parentId==='recipes');
 assert.deepEqual(children.map(n=>n.name).sort(),['Lista de receitas','Receita única']);assert.equal(state.rules.length,2);
 assert.ok(state.rules.every(r=>r.version===1&&r.support.length===3));
 for(const rule of state.rules)for(const evidence of rule.evidence){const saved=await store.get('reels_index/taxonomy_proof_'+evidence.proofHash);assert.equal(saved.data.reelId,evidence.reelId);assert.equal(saved.data.analysisKey,'saved');assert.equal(saved.data.analysisGeneration,'1');}
 assert.deepEqual((await store.get('videos/Manual_01')).data.categoryIds,['recipes']);
 assert.equal((await taxonomy.discover(input)).duplicate,true);
 await taxonomy.discover({automatic:true,sourceReelId:'Manual_01',sourceExecutionId:hash('publication-two')});
 assert.deepEqual((await store.get('settings/reels_v2_taxonomy')).data.nodes.filter(n=>n.parentId==='recipes').map(n=>n.id).sort(),children.map(n=>n.id).sort());
});
test('discovery reports legacy coverage and requests complement without inventing a format',async()=>{
 const videos=Array.from({length:3},(_,i)=>pub('Legacy_'+i,{categoryIds:['recipes'],transcript:'Três receitas, ingredientes, colher e passos não provam preparações independentes.',analysis:{summary:'Receita única ou lista?',keywords:['recipe','receitas'],evidence:{categories:[{categoryId:'recipes',source:'transcript',confidence:1}]}}}));
 const {store,taxonomy}=await discoverySetup(videos);const result=await taxonomy.discover({automatic:true,sourceReelId:'Legacy_0',sourceExecutionId:hash('legacy')});
 assert.equal(result.coverage.missing,3);assert.equal(result.coverage.complementRequired.length,3);assert.deepEqual(result.proposals,[]);
 assert.equal((await store.get('settings/reels_v2_taxonomy')).data.nodes.length,2);
});
test('recipe units require literal independent evidence, not ingredients, steps or repeated citations',()=>{
 const good=supportedRecipe('Proof_01',2);assert.equal(recipeRecurrence(good).value,'recipe_collection');
 const variants=[
  v=>{v.analysis.taxonomySignals.units[1].kind='ingredient';},
  v=>{v.analysis.taxonomySignals.units[1].kind='procedure';},
  v=>{v.analysis.taxonomySignals.complete=false;},
  v=>{v.analysis.taxonomySignals.units[1].id='preparation_0';},
  v=>{v.analysis.taxonomySignals.units[1].title='Sopa completa';},
  v=>{v.analysis.taxonomySignals.units[1].evidence[0].excerpt='Texto ausente da fonte';},
  v=>{v.analysis.taxonomySignals.units[1].evidence[0].start_seconds=10;},
  v=>{v.analysis.taxonomySignals.units[1].evidence[0].end_seconds=100;},
  v=>{v.analysis.taxonomySignals.units[1].evidence[0].excerpt=v.analysis.taxonomySignals.units[0].evidence[0].excerpt;},
  v=>{v.analysis.taxonomySignals.confidence='0.95';}
 ];
 for(const change of variants){const raw=structuredClone(good);change(raw);assert.equal(recipeRecurrence(raw).state,'invalid');}
});
test('subthreshold volume and duplicate units do not inflate support or create categories',async()=>{
 const {store,taxonomy}=await discoverySetup([supportedRecipe('Below_01'),supportedRecipe('Below_02')]);
 const result=await taxonomy.discover({automatic:true,sourceReelId:'Below_01',sourceExecutionId:hash('below')});assert.equal(result.coverage.supported,2);assert.deepEqual(result.proposals,[]);assert.equal((await store.get('settings/reels_v2_taxonomy')).data.rules.length,0);
});
test('manual discovery requires fixed preview and cannot enable automatic policy through mutate',async()=>{
 const {taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('Review_'+i)));
 const input={action:'discover',automatic:true,sourceExecutionId:hash('browser'),idempotencyKey:'discover-review-123',revision:0,id:'recipes'};
 await assert.rejects(()=>taxonomy.mutate(input),e=>e.code==='PREVIEW_REQUIRED');
 const preview=await taxonomy.mutate({...input,preview:true});assert.equal(preview.preview.proposals.length,1);
 const applied=await taxonomy.mutate({...input,confirmed:true,previewToken:preview.previewToken});assert.equal(applied.affected,3);
});
test('manual move suppresses the recurrence rule instead of recreating its former category',async()=>{
 const {store,taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('Moved_'+i)));
 await taxonomy.discover({automatic:true,sourceReelId:'Moved_0',sourceExecutionId:hash('before-move')});
 let state=(await store.get('settings/reels_v2_taxonomy')).data;const child=state.nodes.find(n=>n.parentId==='recipes');
 const input={action:'move',idempotencyKey:'manual-move-format',revision:state.revision,id:child.id,parentId:'other'};
 const preview=await taxonomy.mutate({...input,preview:true});await taxonomy.mutate({...input,confirmed:true,previewToken:preview.previewToken});
 const result=await taxonomy.discover({automatic:true,sourceReelId:'Moved_0',sourceExecutionId:hash('after-move')});assert.equal(result.suppressed.length,1);
 state=(await store.get('settings/reels_v2_taxonomy')).data;assert.equal(state.nodes.filter(n=>n.id===child.id).length,1);assert.equal(state.nodes.find(n=>n.id===child.id).parentId,'other');assert.equal(state.rules[0].enabled,false);
});
test('automatic assignment outbox preserves a manual override installed after planning',async()=>{
 const {store,taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('Race_'+i)));
 const patch=store.patch;let injected=false;store.patch=async(p,d,o)=>{const result=await patch(p,d,o);if(p==='settings/reels_v2_taxonomy'&&d.discovery&&!injected){injected=true;const raw=await store.get('videos/Race_0');await patch('videos/Race_0',{categoryIds:['other'],taxonomy_override:{manual:true,revision:0}},{updateTime:raw.updateTime});}return result;};
 await taxonomy.discover({automatic:true,sourceReelId:'Race_0',sourceExecutionId:hash('manual-race')});assert.deepEqual((await store.get('videos/Race_0')).data.categoryIds,['other']);
});
test('coverage reads do not start discovery or write settings',async()=>{
 const store=memory([supportedRecipe('Read_001')]),taxonomy=new ReelsTaxonomy({repository:new ReelsRepository({store,clock}),clock});
 assert.equal((await taxonomy.coverage()).status,'not_evaluated');assert.equal(await store.get('settings/reels_v2_taxonomy'),null);
});
test('automatic publication reads only its own raw proof and progressively matures the compact index',async()=>{
 const videos=Array.from({length:3},(_,i)=>supportedRecipe('Index_'+i)),{store,repository,taxonomy}=await discoverySetup(videos,{indexed:false});
 const raw=repository.raw.bind(repository);let calls=0;repository.raw=async id=>{calls++;return raw(id);};
 for(let i=0;i<3;i++){calls=0;await taxonomy.discover({automatic:true,sourceReelId:'Index_'+i,sourceExecutionId:hash('index-'+i)});assert.equal(calls,1);}
 const state=(await store.get('settings/reels_v2_taxonomy')).data;assert.equal(state.rules.length,1);assert.equal(state.rules[0].support.length,3);
});
test('manual legacy backfill is explicit, bounded and resumable without models',async()=>{
 const {repository,taxonomy}=await discoverySetup(Array.from({length:4},(_,i)=>supportedRecipe('Batch_'+i)),{indexed:false});
 const raw=repository.raw.bind(repository);let calls=0;repository.raw=async id=>{calls++;return raw(id);};
 const first=await taxonomy.mutate({action:'discover',idempotencyKey:'backfill-page-one',revision:0,backfillLimit:2});
 assert.equal(calls,2);assert.equal(first.coverage.pendingBackfill,2);assert.equal(first.coverage.nextBackfillCursor,'Batch_1');
 const next={action:'discover',idempotencyKey:'backfill-page-two',revision:1,backfillLimit:2,backfillCursor:first.coverage.nextBackfillCursor};
 calls=0;const preview=await taxonomy.mutate({...next,preview:true});assert.equal(calls,2);assert.equal(preview.preview.proposals[0].support,4);
 const applied=await taxonomy.mutate({...next,confirmed:true,previewToken:preview.previewToken});assert.equal(applied.coverage.pendingBackfill,0);assert.equal(applied.coverage.totalPublished,4);
});
test('publication callbacks keep receipts and automatic assignment payloads outside the settings document',async()=>{
 const {store,taxonomy}=await discoverySetup([supportedRecipe('Scale_001')]);
 for(let i=0;i<12;i++)await taxonomy.discover({automatic:true,sourceReelId:'Scale_001',sourceExecutionId:hash('receipt-'+i)});
 const state=(await store.get('settings/reels_v2_taxonomy')).data;assert.deepEqual(state.assignments,[]);assert.deepEqual(state.appliedCommands,[]);
 assert.equal([...store.docs.values()].filter(r=>r.data.kind==='taxonomy_discovery').length,12);
});
test('lost assignment acknowledgement resumes the durable index outbox without another raw scan',async()=>{
 const {store,repository,taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('Recover_'+i)));
 const patch=store.patch;let lost=true;store.patch=async(p,d,o)=>{const saved=await patch(p,d,o);if(p==='videos/Recover_0'&&d.categoryIds&&lost){lost=false;throw Error('assignment acknowledgement lost');}return saved;};
 const input={automatic:true,sourceReelId:'Recover_0',sourceExecutionId:hash('recover-outbox')};
 await assert.rejects(()=>taxonomy.discover(input),/acknowledgement/);
 repository.raw=async()=>{throw Error('unexpected raw scan');};assert.equal((await taxonomy.discover(input)).duplicate,true);
 const child=(await store.get('settings/reels_v2_taxonomy')).data.nodes.find(n=>n.parentId==='recipes');
 assert.ok((await store.get('videos/Recover_2')).data.categoryIds.includes(child.id));
});
test('manual reclassification updates the index before another publication counts its support',async()=>{
 const {store,taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('Sync_'+i)));
 await taxonomy.mutate({action:'reclassify',idempotencyKey:'sync-manual-index',revision:0,reelIds:['Sync_0'],categoryIds:['other']});
 const indexed=(await store.get('reels_index/taxonomy_Sync_0')).data;assert.equal(indexed.manual,true);assert.deepEqual(indexed.categoryIds,['other']);
 const result=await taxonomy.discover({automatic:true,sourceReelId:'Sync_1',sourceExecutionId:hash('sync-after-manual')});
 assert.equal(result.coverage.manual,1);assert.equal(result.coverage.supported,2);assert.deepEqual(result.proposals,[]);
});
test('recipe temporal evidence must match contiguous provider words at the claimed time',()=>{
 const missing=supportedRecipe('Time_001');delete missing.transcript_words;assert.equal(recipeRecurrence(missing).reason,'TEMPORAL_PROOF_UNAVAILABLE');
 const shifted=supportedRecipe('Time_002',2);shifted.analysis.taxonomySignals.units[1].evidence[0].start_seconds=50;shifted.analysis.taxonomySignals.units[1].evidence[0].end_seconds=60;assert.equal(recipeRecurrence(shifted).reason,'TEMPORAL_PROOF_INVALID');
 const reordered=supportedRecipe('Time_003');reordered.transcript_words[1].word='palavra diferente';assert.equal(recipeRecurrence(reordered).reason,'TEMPORAL_PROOF_INVALID');
});
test('a complement replaces its previous automatic format rather than keeping exclusive siblings',async()=>{
 const videos=[...Array.from({length:3},(_,i)=>supportedRecipe('OldList_'+i,2)),...Array.from({length:3},(_,i)=>supportedRecipe('OldSingle_'+i))],{store,taxonomy}=await discoverySetup(videos);
 await taxonomy.discover({automatic:true,sourceReelId:'OldList_0',sourceExecutionId:hash('formats-before')});
 const state=(await store.get('settings/reels_v2_taxonomy')).data,list=state.rules.find(r=>r.value==='recipe_collection').categoryId,single=state.rules.find(r=>r.value==='single_recipe').categoryId;
 const previous=await store.get('videos/OldList_0');await store.patch('videos/OldList_0',supportedRecipe('OldList_0',1,{categoryIds:previous.data.categoryIds,taxonomy_override:previous.data.taxonomy_override,analysis_generation:'2'}),{updateTime:previous.updateTime});
 await taxonomy.discover({automatic:true,sourceReelId:'OldList_0',sourceExecutionId:hash('formats-after')});
 const categories=(await store.get('videos/OldList_0')).data.categoryIds;assert.ok(categories.includes(single));assert.ok(!categories.includes(list));
 const refreshed=(await store.get('settings/reels_v2_taxonomy')).data;assert.equal(refreshed.rules.find(r=>r.value==='recipe_collection').support.length,2);assert.equal(refreshed.nodes.find(n=>n.id===list).evidenceCount,2);
});
test('manual bulk classification stores bounded outbox documents instead of a multi-megabyte root array',async()=>{
 const videos=Array.from({length:3005},(_,i)=>pub('Bulk_'+String(i).padStart(5,'0'))),{store,taxonomy}=await discoverySetup(videos,{indexed:false});
 const snapshot=await store.get('settings/reels_v2_taxonomy'),categories=Array.from({length:10},(_,i)=>({id:'category_'+i+'x'.repeat(90),name:'Categoria '+i,parentId:null}));
 await store.patch('settings/reels_v2_taxonomy',{nodes:categories},{updateTime:snapshot.updateTime});
 const patch=store.patch;store.patch=async(p,d,o)=>{if(p==='settings/reels_v2_taxonomy')assert.ok(Buffer.byteLength(JSON.stringify(d))<1048576);return patch(p,d,o);};
 const input={action:'reclassify',idempotencyKey:'bulk-classification-3005',revision:0,reelIds:videos.map(v=>v.id),categoryIds:categories.map(n=>n.id)},preview=await taxonomy.mutate({...input,preview:true});
 await taxonomy.mutate({...input,confirmed:true,previewToken:preview.previewToken});
 const state=(await store.get('settings/reels_v2_taxonomy')).data;assert.deepEqual(state.assignments,[]);assert.deepEqual(state.appliedCommands,[]);assert.equal([...store.docs.values()].filter(r=>r.data.kind==='taxonomy_manual_assignment').length,3005);
 assert.deepEqual((await store.get('videos/Bulk_03004')).data.categoryIds,categories.map(n=>n.id));
});
test('merge during discovery recovers pending targets and cannot publish a removed category',async()=>{
 const {store,taxonomy}=await discoverySetup(Array.from({length:3},(_,i)=>supportedRecipe('MergeRace_'+i)));
 const patch=store.patch;let merged=false;store.patch=async(p,d,o)=>{const saved=await patch(p,d,o);if(p==='settings/reels_v2_taxonomy'&&d.discovery&&!merged){merged=true;const child=d.nodes.find(n=>n.parentId==='recipes');
  const input={action:'merge',idempotencyKey:'merge-concurrent-child',revision:d.revision,id:child.id,targetId:'other'},preview=await taxonomy.mutate({...input,preview:true});await taxonomy.mutate({...input,confirmed:true,previewToken:preview.previewToken});}return saved;};
 await taxonomy.discover({automatic:true,sourceReelId:'MergeRace_0',sourceExecutionId:hash('merge-concurrent-publication')});
 const state=(await store.get('settings/reels_v2_taxonomy')).data,ids=new Set(state.nodes.map(n=>n.id));
 for(let i=0;i<3;i++){const video=(await store.get('videos/MergeRace_'+i)).data;assert.ok(video.categoryIds.every(id=>ids.has(id)));assert.ok(video.categoryIds.includes('other'));assert.equal(video.taxonomy_override.manual,true);}
});
test('a transient unrelated taxonomy lock keeps the automatic outbox pending for retry',async()=>{
 const {store,taxonomy}=await discoverySetup([supportedRecipe('Locked_01')]),operationId=hash('pending-assignment');
 const snapshot=await store.get('settings/reels_v2_taxonomy');await store.patch('settings/reels_v2_taxonomy',{pendingOperationId:'another-operation'},{updateTime:snapshot.updateTime});
 const assignment={operationId,reelId:'Locked_01',categoryIds:['recipes'],manual:false,revision:1,analysisKey:'saved',analysisGeneration:'1'};
 const indexed=await store.get('reels_index/taxonomy_Locked_01');await store.patch('reels_index/taxonomy_Locked_01',{assignment},{updateTime:indexed.updateTime});
 await assert.rejects(()=>taxonomy.applyDiscoveredAssignments([assignment]),e=>e.code==='TAXONOMY_BUSY'&&e.status===503);
 assert.equal((await store.get('reels_index/taxonomy_Locked_01')).data.assignment.operationId,operationId);
});

