import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsCurationCalibration,calibrationReportView} from '../lib/reels-curation-calibration.mjs';
const H='a'.repeat(64),P='b'.repeat(64),identity={kind:'native',reelId:'reel01',analysisKey:'analysis/one.json',analysisGeneration:'12'};
function fixture(){
 const documents=new Map(),reads=[],rawReads=[],entries=[{id:'reel01',title:'Receita registrada',sourceIdentity:identity,sourceProofHash:P,proofContentHash:'c'.repeat(64)}];
 const items=[{id:'reel01',title:'Receita registrada',publication:{available:true,revision:'12'}},{id:'reel02',title:'Preservado',publication:{available:true,source:'legacy_preserved',revision:'legacy'}},{id:'uncertain01',publication:{available:false}},{id:'failed01',publication:{available:false}}];
 const repository={store:{async get(path){reads.push(path);return documents.get(path)??null;}},async items(){return items;},async raw(id){rawReads.push(id);return null;},observation(){return {observedAt:'2026-10-17T20:00:00Z',cache:{stale:false}};}};
 const contextual={async snapshotData(){return {entries,acceptedInventory:2,dataAsOf:'2026-10-17T20:00:00Z',sourceStale:false};}};
 return {service:new ReelsCurationCalibration({repository,contextual,clock:()=>0}),documents,reads,rawReads,entries,items};
}
test('missing calibration remains explicitly unavailable without invented metrics or writes',async()=>{
 const f=fixture(),r=await f.service.overview();assert.equal(r.available,false);assert.equal(r.evaluatedCount,null);assert.equal(r.unknownCount,2);assert.equal(r.processingStarted,false);assert.deepEqual(f.reads,['settings/reels_v2_contextual_calibration']);assert.equal(f.rawReads.length,0);
});
test('saved cohort proof stays valid after category-only metadata changes, source drift withholds applied group',async()=>{
 const f=fixture(),member={id:'reel01',sourceIdentity:identity,publicationProofHash:P};
 f.documents.set('settings/reels_v2_contextual_calibration',{data:{schemaVersion:1,planHash:H,sourceHash:H,report:{evaluatedCount:1,unknownCount:1,groups:[{id:'g',state:'calibrated',members:[member],appliedCategoryId:'ctx_group'}],limitations:[]}}});
 f.documents.set('settings/reels_v2_taxonomy',{data:{nodes:[{id:'ctx_group',manual:false,calibrationPlanHash:H}],assignments:[]}});
 let r=await f.service.overview();assert.equal(r.groups[0].appliedCategoryId,'ctx_group');assert.equal(r.groups[0].memberCount,1);
 f.entries[0].categoryIds=['receitas','ctx_group'];r=await f.service.overview();assert.equal(r.groups[0].appliedCategoryId,'ctx_group');
 f.entries[0].sourceProofHash='d'.repeat(64);r=await f.service.overview();assert.equal(r.groups[0].state,'insufficient');assert.equal(r.groups[0].appliedCategoryId,null);assert.equal(r.groups[0].memberCount,0);
});
test('manual reassignment invalidates finite applied membership without changing taxonomy',async()=>{
 const f=fixture();f.documents.set('settings/reels_v2_contextual_calibration',{data:{schemaVersion:1,planHash:H,sourceHash:H,report:{groups:[{state:'calibrated',members:[{id:'reel01',sourceIdentity:identity,publicationProofHash:P}]}]}}});
 f.documents.set('settings/reels_v2_taxonomy',{data:{nodes:[],assignments:[{reelId:'reel01',manual:true,categoryIds:['another']}]}});const r=await f.service.overview();assert.equal(r.groups[0].memberCount,0);assert.equal(r.groups[0].state,'insufficient');
});
test('quality consultation pages published IDs only and does not scan failed or uncertain execution data',async()=>{
 const f=fixture(),r=await f.service.savedQuality({limit:1});assert.equal(r.total,2);assert.equal(r.items.length,1);assert.equal(r.items[0].historical,true);assert.equal(r.items[0].state,'present_unverified');assert.deepEqual(f.rawReads,['reel01']);assert.equal(f.reads.length,0);
 const page=await f.service.savedQuality({limit:1,cursor:r.nextCursor});assert.equal(page.items[0].reelId,'reel02');assert.equal(page.nextCursor,null);assert.equal(page.semanticQualityMeasured,false);assert.equal(page.processingStarted,false);
 await assert.rejects(f.service.savedQuality({limit:1,q:'other',cursor:r.nextCursor}),e=>e.status===409);
 await assert.rejects(f.service.savedQuality({limit:26}),e=>e.status===400);
});
test('quality q and source filter before source reads; no report or source text is returned',async()=>{
 const f=fixture(),r=await f.service.savedQuality({q:'Preservado',source:'legacy_preserved'});assert.equal(r.total,1);assert.deepEqual(f.rawReads,['reel02']);assert.equal(r.items[0].reelId,'reel02');assert.equal('raw' in r.items[0],false);assert.equal('report' in r.items[0],false);
});
test('calibration view maps exact report metrics without turning unavailable measurements into zero',()=>{
 const r=calibrationReportView({version:'finite',corpus:{inventoryCount:499,evaluatedCount:8,unevaluatedCount:491},rules:[{ruleId:'r',label:'Receitas com Frango',status:'calibrated',members:[],train:{tp:2,fp:0,precision:1},holdout:{tp:2,fp:0,precision:1}}]});
 assert.equal(r.inventoryCount,499);assert.equal(r.evaluatedCount,8);assert.equal(r.unknownCount,491);assert.equal(r.groups[0].metrics.holdout.precision,1);assert.equal(r.groups[0].metrics.holdout.total,null);assert.equal(r.groups[0].appliedCategoryId,null);
});
