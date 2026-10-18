import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsCatalogueRuntime} from '../lib/reels-contextual-catalogue-runtime.mjs';
import {reelsAPI} from '../lib/reels-api.mjs';
import {publicationAvailable} from '../lib/reels-model.mjs';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Central GitHub Actions required.');
const [storeFlag,storePath,planFlag,planPath,outFlag,out]=process.argv.slice(2);
assert.equal(storeFlag,'--store');assert.equal(planFlag,'--plan');assert.equal(outFlag,'--output');
const input=JSON.parse(await readFile(storePath,'utf8')),plan=JSON.parse(await readFile(planPath,'utf8'));
const store=memoryReelsStore();
for(const r of input.records)store.docs.set(r.path,{data:r.data,updateTime:r.updateTime});
const repository=new ReelsRepository({store,cacheTtlMs:0}),runtime=new ReelsCatalogueRuntime({repository});
const api=reelsAPI({repository,authorize:async()=>true,sameOrigin:async()=>true,processingEnabled:false});
const before=JSON.stringify([...store.docs]);
async function get(path){const r=await api(new Request('https://ci.megabrain.test/api/reels/'+path));assert.equal(r.status,200,await r.clone().text());return r.json();}
const catalogue=await get('curation/catalogue');assert.equal(catalogue.projectionCoverage.inventoryCount,499);assert.equal(catalogue.projectionCoverage.evaluatedCount,499);assert.equal(catalogue.projectionCoverage.missingCount,0);
const expected=plan.contributionWrites.map(w=>w.data),groups=[];
for(const value of ['single_recipe','recipe_collection']){
 const ids=expected.filter(c=>c.entry.format.value===value&&c.entry.format.state==='supported'&&!c.entry.curation.manual).map(c=>c.reelId).sort();
 const result=await get('items?workspace=library&category=ctx_format_'+value+'&limit=100');
 assert.deepEqual(result.items.map(x=>x.id).sort(),ids);assert.equal(result.total,ids.length);
 groups.push({value,count:ids.length,ids});
}
const categories=await get('categories');for(const group of groups)assert.equal(categories.nodes.find(n=>n.id==='ctx_format_'+group.value).count,group.count);
const library=await get('items?workspace=library&limit=100');assert.equal(library.total,499);assert.equal(JSON.stringify([...store.docs]),before,'GET must not mutate or prepare the catalogue.');
const overlaps=input.records.filter(r=>r.path.startsWith('videos/')&&publicationAvailable(r.data)&&store.docs.has('reels_legacy_content/'+r.data.id));assert.equal(overlaps.length,41);
const target=overlaps.find(r=>groups.some(g=>g.ids.includes(r.data.id)))??overlaps[0];assert.ok(target);
let record=await store.get('reels_legacy_content/'+target.data.id);await store.patch('reels_legacy_content/'+target.data.id,{transcript:(record.data.transcript??'')+' Synthetic unused-backup revision.'},{updateTime:record.updateTime});
const unchanged=await get('curation/catalogue');assert.equal(unchanged.projectionCoverage.evaluatedCount,499);for(const g of groups)assert.equal(unchanged.formats.find(f=>f.value===g.value).count,g.count);
record=await store.get(target.path);await store.patch(target.path,{analysis_generation:String(BigInt(record.data.analysis_generation)+1n)},{updateTime:record.updateTime});
const stale=await get('curation/catalogue');assert.equal(stale.projectionCoverage.evaluatedCount,498);assert.equal(stale.projectionCoverage.missingCount,1);
const eventResult=await runtime.project(target.data.id,{type:'sourceCorrected'});assert.equal(eventResult.committed,true);
const restored=await get('curation/catalogue');assert.equal(restored.projectionCoverage.evaluatedCount,499);assert.equal(restored.projectionCoverage.missingCount,0);
const contribution=(await store.get('reels_index/contextual_'+target.data.id)).data;assert.notEqual(contribution.entry.format.state,'supported','Old source format review must not certify changed publication.');
const replay=await runtime.project(target.data.id,{type:'sourceCorrected'});assert.equal(replay.action,'noop');assert.equal([...store.docs.values()].filter(r=>r.data.kind==='contextual_contribution').length,499);
await writeFile(out,JSON.stringify({schemaVersion:1,kind:'ci_saved_corpus_real_api_rehearsal_not_production',sourceCommit:process.env.GITHUB_SHA,initialInventory:499,initialEvaluated:499,initialMissing:0,groups,libraryTotal:499,unusedLegacyOverlap:41,unusedLegacyChangeRetains499:true,primarySourceChangeInvalidatesExactlyOne:true,eventRestores499WithoutProvider:true,oldReviewRevokedOnSourceChange:true,idempotentReplay:true,GETWrites:0,providers:0,newRealReels:0,onlyRunnerTemporaryStateChanged:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({runtimeSavedInventoryVerified:499,overlapProtected:41,groups:groups.map(g=>({value:g.value,count:g.count})),providers:0}));
