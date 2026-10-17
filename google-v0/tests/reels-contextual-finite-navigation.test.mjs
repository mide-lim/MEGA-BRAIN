import test from 'node:test';
import assert from 'node:assert/strict';
import {makeContextualCalibrationFixture} from './reels-contextual-calibration-fixture.mjs';
import {withFiniteContextualProofs,prepareContextualCategoryPlan} from '../lib/reels-contextual-calibration.mjs';
import {projectReel,categoryNavigation} from '../lib/reels-model.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
function fixture(cacheTtlMs=0){
 const input=makeContextualCalibrationFixture(),{plan}=prepareContextualCategoryPlan(input),docs=new Map(input.records.map(r=>{const s=JSON.parse(r.sourceJson);return ['videos/'+s.video.id,s.video];})),taxonomy=structuredClone(input.taxonomy.data),reads=[];
 const assignments=new Map();
 for(const group of plan.groups){
  taxonomy.nodes.push({id:group.categoryId,parentId:group.parentCategoryId,name:group.label,manual:false,calibrationPlanHash:plan.planHash});
  taxonomy.rules.push({...group.rule,calibrationPlanHash:plan.planHash,members:group.members.map(({id,sourceIdentity,publicationProofHash})=>({id,sourceIdentity,publicationProofHash}))});
  for(const m of group.members){
   const a=assignments.get(m.id)??{reelId:m.id,categoryIds:[...m.priorCategoryIds],ruleIds:[],manual:false,revision:8,calibrationPlanHash:plan.planHash};
   a.categoryIds=[...new Set([...a.categoryIds,group.categoryId])];a.ruleIds.push(group.rule.id);assignments.set(m.id,a);
  }
 }
 taxonomy.assignments=[...assignments.values()];taxonomy.revision=8;
 docs.set('settings/reels_v2_taxonomy',taxonomy);
 const store={get:async path=>{reads.push(path);return docs.has(path)?{path,data:structuredClone(docs.get(path)),updateTime:input.taxonomy.updateTime}:null;},query:async(collection,{select,filters=[]}={})=>{
  const rows=[...docs].filter(([p])=>p.startsWith(collection+'/')).filter(([,v])=>filters.every(f=>v[f.field]===f.value));
  return {records:rows.map(([path,value])=>{if(!select)return {path,data:structuredClone(value)};const data={};for(const field of select){let x=value;const parts=field.split('.');for(const p of parts)x=x?.[p];if(x===undefined)continue;let out=data;for(const p of parts.slice(0,-1))out=out[p]??={};out[parts.at(-1)]=structuredClone(x);}return {path,data};}),nextCursor:null};
 },create:async()=>{throw Error('Read-only navigation must not write');},set:async()=>{throw Error('Read-only navigation must not write');}};
 return {input,plan,docs,taxonomy,reads,repository:new ReelsRepository({store,cacheTtlMs})};
}
test('real Library and tree show exact audited finite members without changing saved sources',async()=>{
 const f=fixture(),before=JSON.stringify([...f.docs].filter(([p])=>p.startsWith('videos/')));
 for(const group of f.plan.groups){
  const page=await f.repository.list({workspace:'library',category:group.categoryId,limit:100});
  assert.equal(page.total,group.members.length);assert.deepEqual(page.items.map(x=>x.id).sort(),group.members.map(m=>m.id).sort());
  assert.equal((await f.repository.categories()).nodes.find(n=>n.id===group.categoryId).count,group.members.length);
  assert.equal((await f.repository.detail(group.members[0].id)).categoryIds.includes(group.categoryId),true);
  assert.equal((await f.repository.refresh(group.members[0].id)).categoryIds.includes(group.categoryId),true);
  assert.equal(JSON.stringify(page).includes('contextualSourceProof'),false);
 }
 assert.equal(JSON.stringify([...f.docs].filter(([p])=>p.startsWith('videos/'))),before);
});
test('same ID with a new analysis generation or edited embedded source does not inherit audited membership',async()=>{
 const f=fixture(),group=f.plan.groups.find(g=>g.rule.valueId==='frango'),id=group.members[0].id;
 f.docs.get('videos/'+id).analysis_generation='999';
 assert.equal((await f.repository.list({workspace:'library',category:group.categoryId})).total,3);
 f.docs.get('videos/'+id).analysis_generation=JSON.parse(f.input.records[0].sourceJson).video.analysis_generation;
 f.docs.get('videos/'+id).analysis.knowledge.fields[0].value='Peixe';
 assert.equal((await f.repository.list({workspace:'library',category:group.categoryId})).items.some(x=>x.id===id),false);
});
test('manual moves, suppression, pending operation and changed rule binding fail closed for finite projection',async()=>{
 for(const mutate of [
  (f,g)=>{f.taxonomy.rules.find(r=>r.id===g.id).enabled=false;},
  (f,g)=>{f.taxonomy.suppressed=[g.categoryId];},
  f=>{f.taxonomy.pendingOperationId='pending';},
  (f,g)=>{f.taxonomy.assignments.find(a=>a.reelId===g.members[0].id).calibrationPlanHash='f'.repeat(64);},
  (f,g)=>{f.docs.get('videos/'+g.members[0].id).taxonomy_override={manual:true,revision:99};f.docs.get('videos/'+g.members[0].id).category_ids=['tecnologia'];}
 ]){
  const f=fixture(),g=f.plan.groups[0];mutate(f,g);
  const result=await f.repository.list({workspace:'library',category:g.categoryId});
  assert.equal(result.items.some(i=>i.id===g.members[0].id),false);
 }
});
test('unseen matching publication gets no group and its source body is never loaded',async()=>{
 const f=fixture(),g=f.plan.groups[0],original=structuredClone(f.docs.get('videos/'+g.members[0].id)),extra={...original,id:'QaCal_new',analysis_key:'analysis/unseen.json'};
 f.docs.set('videos/'+extra.id,extra);
 const page=await f.repository.list({workspace:'library',category:g.categoryId});
 assert.equal(page.total,g.members.length);assert.equal(f.reads.includes('videos/'+extra.id),false);
});
test('raw category pointer cannot bypass disabled finite rule, while explicit human assignment wins',async()=>{
 const f=fixture(),g=f.plan.groups[0],id=g.members[0].id;
 f.docs.get('videos/'+id).category_ids=['receitas',g.categoryId];f.taxonomy.rules.find(r=>r.id===g.id).enabled=false;
 assert.equal((await f.repository.list({workspace:'library',category:g.categoryId})).total,0);
 f.taxonomy.assignments.push({reelId:id,categoryIds:[g.categoryId],manual:true,revision:99});
 const human=await f.repository.list({workspace:'library',category:g.categoryId});assert.deepEqual(human.items.map(i=>i.id),[id]);
});

test('a stale projected item never overrules a fresh manual source edit or withdrawn publication',async()=>{
 const f=fixture(),group=f.plan.groups[0],id=group.members[0].id,video=structuredClone(f.docs.get('videos/'+id)),stale=projectReel(video);
 assert.equal(stale.publication.available,true);assert.notEqual(stale.categoryOverride?.manual,true);
 const baseline=await withFiniteContextualProofs([stale],f.taxonomy,{loadSource:async()=>({video})});
 assert.ok(categoryNavigation(baseline,f.taxonomy).items[0].categoryIds.includes(group.categoryId));
 const freshManual={...video,taxonomy_override:{manual:true,revision:99}};
 const afterEdit=await withFiniteContextualProofs([stale],f.taxonomy,{loadSource:async()=>({video:freshManual})});
 assert.equal(afterEdit[0].contextualSourceProof,undefined);
 assert.equal(categoryNavigation(afterEdit,f.taxonomy).items[0].categoryIds.includes(group.categoryId),false);
 const withdrawn={...video,analysis_generation:null,analysis_quality_status:'review_required',publication:{available:false}};
 const afterWithdrawal=await withFiniteContextualProofs([stale],f.taxonomy,{loadSource:async()=>({video:withdrawn})});
 assert.equal(afterWithdrawal[0].contextualSourceProof,undefined);
 assert.equal(categoryNavigation(afterWithdrawal,f.taxonomy).items[0].categoryIds.includes(group.categoryId),false);
});

test('warm inventory cache cannot retain finite members after fresh raw or taxonomy edits without explicit refresh',async()=>{
 for(const mutate of [
  (f,g)=>{f.docs.get('videos/'+g.members[0].id).taxonomy_override={manual:true,revision:99};},
  (f,g)=>{f.taxonomy.rules.find(r=>r.id===g.id).enabled=false;},
  (f,g)=>{f.taxonomy.suppressed=[g.categoryId];},
  (f,g)=>{f.taxonomy.assignments.push({reelId:g.members[0].id,categoryIds:['tecnologia'],manual:true,revision:99});}
 ]){
  const f=fixture(60000),g=f.plan.groups[0],first=await f.repository.list({workspace:'library',category:g.categoryId});
  assert.equal(first.total,g.members.length);const cached=f.repository.snapshot;
  mutate(f,g);
  const current=await f.repository.list({workspace:'library',category:g.categoryId});
  assert.equal(current.items.some(i=>i.id===g.members[0].id),false);
  assert.equal(f.repository.snapshot,cached,'inventory cache remains warm; only finite source proofs refreshed');
  const tree=await f.repository.categories();
  assert.equal(tree.nodes.find(n=>n.id===g.categoryId).count,current.total);
  assert.equal((await f.repository.list({workspace:'library'})).total,8);
 }
});
