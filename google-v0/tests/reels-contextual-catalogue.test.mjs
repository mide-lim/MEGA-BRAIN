import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeFullCatalogueFixture} from './reels-contextual-catalogue-fixture.mjs';
import {projectContextualContribution,prepareContextualCatalogue,buildContextualCatalogue,catalogueMatchingIds,reconcileContextualContribution,ReelsContextualCatalogueProjector} from '../lib/reels-contextual-catalogue.mjs';
const fixture=()=>makeFullCatalogueFixture();
const sourceOf=(input,index=0)=>{const s=JSON.parse(input.records[index].sourceJson);return {...s,sourceVersions:s.sourceUpdateTime};};
const contributionOf=(input,index=0)=>projectContextualContribution({...sourceOf(input,index),observedAt:input.observedAt});
const event=(type='publicationAccepted')=>({id:'event-fixture-001',type,reelId:'QaFull_single'});
test('all accepted sources are evaluated, unknown and non-recipe rows remain distinct, formats are proved independent preparations',()=>{
 const input=fixture(),before=structuredClone(input),prepared=prepareContextualCatalogue(input),c=prepared.catalogue;
 assert.deepEqual(input,before);assert.equal(prepared.contributions.length,5);
 assert.deepEqual([c.projectionCoverage.inventoryCount,c.projectionCoverage.evaluatedCount,c.projectionCoverage.missingCount,c.projectionCoverage.unknownContextCount,c.projectionCoverage.formatUnknownCount,c.projectionCoverage.nonRecipeCount],[5,5,0,1,1,1]);
 assert.deepEqual(c.formats.map(f=>[f.value,f.label,f.count,f.matchingIds]),[['single_recipe','Receita única',1,['QaFull_single']],['recipe_collection','Várias receitas',1,['QaFull_many']]]);
 assert.equal(c.ingredients.find(f=>f.valueId==='frango').supportCount,2);assert.ok(c.ingredients.every(f=>!f.label.includes('preparo')));
 for(const row of Object.values(c.projectionCoverage.states)){assert.equal(row.denominator,5);assert.equal(Object.values(row.states).reduce((a,b)=>a+b,0),5);}
 assert.equal(c.incremental.enabled,false);assert.equal(c.processingStarted,false);
 assert.equal(JSON.stringify(prepared.contributions).includes('tempere o frango'),false,'contributions contain metadata refs, not captured transcript quotations');
 assert.ok(c.opportunities.every(o=>o.categoryCreationEnabled===false));
});
test('persisted metadata preserves ANY/ALL/SAME_UNIT and virtual-format intersections without keyword classification',()=>{
 const p=prepareContextualCatalogue(fixture()),rows=p.contributions.map(x=>x.data);
 assert.deepEqual(catalogueMatchingIds(rows,{category:'ctx_format_single_recipe',dimension:'ingredient',value:'frango'}),['QaFull_single']);
 assert.deepEqual(catalogueMatchingIds(rows,{category:'ctx_format_single_recipe',facets:[{dimension:'format',value:'recipe_collection'}]}),[]);
 assert.deepEqual(catalogueMatchingIds(rows,{category:'ctx_format_recipe_collection',facets:[{dimension:'ingredient',value:'frango',quantifier:'ALL'}]}),[]);
 assert.deepEqual(catalogueMatchingIds(rows,{category:'ctx_format_recipe_collection',facets:[{dimension:'ingredient',value:'frango',quantifier:'SAME_UNIT'},{dimension:'tool',value:'forno',quantifier:'ANY'}]}),[]);
 assert.equal(rows.find(c=>c.reelId==='QaFull_legacy').entry.context.state,'unknown');
});
test('a complete 499-source saved inventory reports every row without inventing formats from volume or words',()=>{
 const base=fixture(),sample=sourceOf(base,2),input={...base,catalog:[],records:[]};
 for(let n=0;n<499;n++){
  const source=structuredClone(sample),id='QaCorpus_'+String(n).padStart(4,'0');delete source.sourceVersions;
  source.video.id=id;source.item.id=id;source.video.analysis_key='analysis/'+id;source.video.source_caption.capture_id='capture-'+id;
  const sourceJson=JSON.stringify(source);input.records.push({sourceJson,sourceSnapshotHash:createHash('sha256').update(sourceJson).digest('hex')});
  input.catalog.push({id,publicationAvailable:true,categoryIds:['receitas'],manual:false,sourceIdentity:{kind:'native',analysisKey:source.video.analysis_key,analysisGeneration:source.video.analysis_generation}});
 }
 const result=prepareContextualCatalogue(input);assert.equal(result.contributions.length,499);assert.equal(result.catalogue.projectionCoverage.evaluatedCount,499);assert.equal(result.catalogue.projectionCoverage.missingCount,0);assert.equal(result.catalogue.projectionCoverage.formatUnknownCount,499);assert.ok(result.catalogue.formats.every(f=>f.count===0));
});
test('capture/identity corruption and duplicate inventory or contribution IDs fail closed',()=>{
 const bad=fixture();bad.records[0].sourceJson+=' ';assert.throws(()=>prepareContextualCatalogue(bad),e=>e.code==='CATALOGUE_CAPTURE_HASH_MISMATCH');
 const wrong=fixture();wrong.catalog[0].sourceIdentity.analysisGeneration='99';assert.throws(()=>prepareContextualCatalogue(wrong),e=>e.code==='CATALOGUE_CAPTURE_PUBLICATION_MISMATCH');
 const dup=fixture();dup.catalog.push(dup.catalog[0]);assert.throws(()=>prepareContextualCatalogue(dup),e=>e.code==='CATALOGUE_ACCEPTED_INVENTORY_INVALID');
 const input=fixture(),c=contributionOf(input);assert.throws(()=>buildContextualCatalogue([c,c],{inventoryIds:[c.reelId],observedAt:input.observedAt}),e=>e.code==='CATALOGUE_DUPLICATE_CONTRIBUTION');
 const corrupt=structuredClone(c);corrupt.entry.format.value='recipe_collection';assert.throws(()=>buildContextualCatalogue([corrupt],{inventoryIds:[c.reelId],observedAt:input.observedAt}),e=>e.code==='CATALOGUE_CONTRIBUTION_CORRUPT');
});
test('same publication replay is idempotent, saved source revision replaces one contribution and unrelated rows stay unchanged',()=>{
 const input=fixture(),source=sourceOf(input),previous=contributionOf(input),other=contributionOf(input,1),otherBefore=structuredClone(other);
 const unchanged=reconcileContextualContribution({event:event(),currentSource:source,previousContribution:previous,observedAt:'2026-10-18T00:25:00.000Z'});
 assert.equal(unchanged.action,'noop');
 source.video.source_caption.capture_id='new-capture';source.sourceVersions.video='2026-10-18T00:26:00.000Z';
 const next=reconcileContextualContribution({event:event('sourceCorrected'),currentSource:source,previousContribution:previous,observedAt:'2026-10-18T00:27:00.000Z'});
 assert.equal(next.action,'upsert');assert.notEqual(next.replacement.idempotencyKey,previous.idempotencyKey);assert.equal(next.expectedPreviousHash,previous.contentHash);
 const view=buildContextualCatalogue([next.replacement,other],{inventoryIds:[previous.reelId,other.reelId],observedAt:input.observedAt});
 assert.equal(view.projectionCoverage.evaluatedCount,2);assert.equal(view.formats.find(f=>f.value==='single_recipe').count,1);assert.deepEqual(other,otherBefore);
});
test('withdrawal only removes derived data when current saved publication is truly unavailable; stale acceptance cannot regress',()=>{
 const input=fixture(),source=sourceOf(input),previous=contributionOf(input);
 assert.equal(reconcileContextualContribution({event:event('publicationWithdrawn'),currentSource:source,previousContribution:previous,observedAt:input.observedAt}).reason,'PUBLICATION_STILL_ACCEPTED');
 assert.equal(reconcileContextualContribution({event:{...event(),sourceIdentity:{kind:'native',analysisKey:'old',analysisGeneration:'1'}},currentSource:source,previousContribution:previous,observedAt:input.observedAt}).reason,'STALE_PUBLICATION_EVENT');
 const gone=structuredClone(source);gone.video.analysis_generation=null;gone.item.publication.available=false;
 const removed=reconcileContextualContribution({event:event('publicationWithdrawn'),currentSource:gone,previousContribution:previous,observedAt:input.observedAt});
 assert.equal(removed.action,'remove');assert.equal(removed.replacement.status,'removed');assert.equal(removed.replacement.entry,undefined);assert.ok(removed.path.startsWith('reels_index/contextual_'));
 const contradictory=structuredClone(source);contradictory.item.publication.available=false;
 assert.throws(()=>reconcileContextualContribution({event:event('publicationWithdrawn'),currentSource:contradictory,previousContribution:previous,observedAt:input.observedAt}),e=>e.code==='CATALOGUE_ITEM_PUBLICATION_MISMATCH');
});
test('editorial suppression and manual protection change only derived membership and preserve source bytes',()=>{
 const input=fixture(),source=sourceOf(input),before=structuredClone(source),original=contributionOf(input);
 const manual=projectContextualContribution({...source,editorial:{manual:true,revision:9},observedAt:input.observedAt});
 assert.equal(buildContextualCatalogue([manual],{inventoryIds:[manual.reelId],observedAt:input.observedAt}).formats[0].count,0);
 const suppressed=projectContextualContribution({...source,editorial:{suppressedDimensions:['format','ingredient']},observedAt:input.observedAt});
 const report=buildContextualCatalogue([suppressed],{inventoryIds:[suppressed.reelId],observedAt:input.observedAt});
 assert.equal(report.formats[0].count,0);assert.deepEqual(report.ingredients,[]);assert.notEqual(suppressed.idempotencyKey,original.idempotencyKey);assert.deepEqual(source,before);
});
test('event handler passes exact source/editorial/previous CAS preconditions and never retries ambiguous writes',async()=>{
 const input=fixture(),source=sourceOf(input),previous=contributionOf(input);let writes=0,captured;
 const projector=new ReelsContextualCatalogueProjector({loadSource:async()=>source,loadContribution:async()=>null,commitCAS:async plan=>{writes++;captured=plan;return {applied:true,updateTime:'saved-version'};},clock:()=>Date.parse(input.observedAt)});
 const result=await projector.handle(event());assert.equal(result.committed,true);assert.equal(writes,1);assert.deepEqual(captured.expectedSourceVersions,source.sourceVersions);assert.ok(captured.expectedEditorialHash);assert.equal(captured.expectedContributionUpdateTime,null);assert.equal(captured.path,'reels_index/contextual_QaFull_single');
 const duplicate=new ReelsContextualCatalogueProjector({loadSource:async()=>source,loadContribution:async()=>({data:previous,updateTime:'version-1'}),commitCAS:async()=>{throw Error('duplicate must not write');},clock:()=>Date.parse(input.observedAt)});
 assert.equal((await duplicate.handle(event())).action,'noop');
 const ambiguous=new ReelsContextualCatalogueProjector({loadSource:async()=>source,loadContribution:async()=>null,commitCAS:async()=>{writes++;throw Error('ambiguous metadata acknowledgement');},clock:()=>Date.parse(input.observedAt)});
 await assert.rejects(ambiguous.handle(event()),/ambiguous/);assert.equal(writes,2);
});
test('a rejected CAS remains pending without changing provider/publication state',async()=>{
 const input=fixture(),source=sourceOf(input),before=structuredClone(source);let writes=0;
 const projector=new ReelsContextualCatalogueProjector({loadSource:async()=>source,loadContribution:async()=>null,commitCAS:async()=>{writes++;return {applied:false};},clock:()=>Date.parse(input.observedAt)});
 const result=await projector.handle(event());assert.equal(result.pending,true);assert.equal(result.committed,false);assert.equal(result.providerCalls,0);assert.equal(writes,1);assert.deepEqual(source,before);
});
