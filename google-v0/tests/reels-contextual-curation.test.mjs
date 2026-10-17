import test from 'node:test';
import assert from 'node:assert/strict';
import {projectContextualPublication,coverageStates,contextualRuleHash} from '../lib/reels-contextual-projection.mjs';
import {parseContextualQuery,filterContextualEntries,buildContextualIndex} from '../lib/reels-contextual-index.mjs';
import {ReelsContextualCurator} from '../lib/reels-contextual-curation.mjs';
import {matchesReel} from '../lib/reels-model.mjs';
import {qualityCandidateHash,qualityDigest,qualitySourceManifest,verifyPublicationQualityReceipt} from '../lib/reels-quality-gate.mjs';

const quote={source:'caption',excerpt:'300g de frango e uma frigideira.',start_seconds:0,end_seconds:0};
function native(id='RecipeA1'){
 const video={id,analysis_key:'analysis/'+id,analysis_generation:'12',analysis_quality_status:'accepted',duration_seconds:8,source_caption:{capture_id:'caption-'+id,text:quote.excerpt},analysis:{title:'Receita de frango',summary:'Preparo mostrado.',knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Frango',value:'300g',evidence:[quote]},{kind:'tool',name:'Frigideira',value:'Frigideira',evidence:[quote]}]}}};
 const item={id,title:'Receita de frango',updatedAt:'2026-10-17T12:00:00Z',categoryIds:['receitas'],publication:{available:true,revision:'12'},categoryOverride:null};
 return {video,item};
}
function preserved(id='LegacyA1'){
 const legacy={schemaVersion:1,reelId:id,status:'legacy_preserved',historical:true,executable:false,originalStatus:'analyzed',provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{summary:'Receita com frango preservada.',useful_value:['Preparação'],topics:['frango'],claims:[{claim:'Uma receita.',evidence_quote:'frango'}],candidate_relations:[]}};
 return {legacy,video:{id,analysis:{knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Frango',value:'Frango',evidence:[quote]}]}}},item:{id,title:'Análise antiga',categoryIds:['receitas'],publication:{available:true,source:'legacy_preserved'}}};
}
function collection(project=true){
 const f=native('ListAA1');f.video.transcript='Frango na frigideira. Peixe no forno.';f.video.transcript_words=[{word:'Frango',start_seconds:0,end_seconds:0.5},{word:'na',start_seconds:0.5,end_seconds:0.8},{word:'frigideira',start_seconds:0.8,end_seconds:1.5},{word:'Peixe',start_seconds:3,end_seconds:3.5},{word:'no',start_seconds:3.5,end_seconds:3.8},{word:'forno',start_seconds:3.8,end_seconds:4.5}];
 f.video.source_caption={capture_id:'caption-list',text:'Frango na frigideira. Peixe no forno.'};
 f.video.analysis.taxonomySignals={version:1,parentCategoryId:'receitas',complete:true,confidence:0.95,units:[{id:'u1',kind:'recipe',title:'Frango na frigideira',evidence:[{source:'transcript',excerpt:'Frango na frigideira.',start_seconds:0,end_seconds:2}]},{id:'u2',kind:'recipe',title:'Peixe no forno',evidence:[{source:'transcript',excerpt:'Peixe no forno.',start_seconds:3,end_seconds:5}]}]};
 f.video.analysis.knowledge.fields=[{kind:'ingredient',name:'Frango',value:'Frango',unitIds:['u1'],evidence:[{source:'caption',excerpt:'Frango na frigideira.'}]},{kind:'tool',name:'Forno',value:'Forno',unitIds:['u2'],evidence:[{source:'caption',excerpt:'Peixe no forno.'}]}];return project?projectContextualPublication(f):f;
}
test('published native typed inclusion preserves source and does not fabricate independent recipes',()=>{
 const f=native(),before=structuredClone(f),entry=projectContextualPublication(f);
 assert.deepEqual(f,before);assert.equal(entry.sourceIdentity.kind,'native');assert.equal(entry.sourceIdentity.qualityPolicyVersion,'historical_baseline');
 assert.equal(entry.independentUnitCount,null);assert.equal(entry.format.state,'not_recorded');assert.deepEqual(entry.attributes.map(a=>[a.dimensionId,a.valueId,a.role,a.state]),[['ingredient','frango','supporting','supported'],['tool','frigideira','supporting','supported']]);
 assert.deepEqual(entry.attributes[0].unitIds,[]);assert.ok(entry.attributes[0].evidence[0].id);assert.equal(entry.ruleHash,contextualRuleHash);
});
test('legacy accepted content is included without promoting candidate knowledge or keyword topics',()=>{
 const f=preserved(),entry=projectContextualPublication(f);
 assert.equal(entry.sourceIdentity.kind,'legacy_preserved');assert.equal(entry.sourceIdentity.analysisKey,undefined);assert.equal(entry.context.state,'unknown');assert.equal(entry.attributes.length,0);assert.equal(entry.legacyEvidence.claims,1);assert.ok(entry.coverage.every(x=>x.state==='unknown'||x.state==='not_recorded'));
 const unaccepted=native('NoPub111');unaccepted.video.analysis_quality_status='review_required';assert.equal(projectContextualPublication(unaccepted),null);
 assert.equal(projectContextualPublication({video:{id:'Unknown1',status:'uncertain'},item:{id:'Unknown1',publication:{available:false}}}),null);
});
test('a source quote must bind the typed controlled term; title and keywords never create facets',()=>{
 const f=native();f.video.analysis.knowledge.keywords=[{term:'frango',evidence:[quote]}];f.video.analysis.knowledge.fields=[];
 assert.equal(projectContextualPublication(f).attributes.length,0);
 f.video.analysis.knowledge.fields=[{kind:'ingredient',name:'Frango',value:'300g',evidence:[{...quote,excerpt:'texto inexistente'}]}];
 assert.equal(projectContextualPublication(f).attributes[0].state,'invalid');
 f.video.source_caption.text='Arroz e água.';f.video.analysis.knowledge.fields[0].evidence=[{...quote,excerpt:'Arroz e água.'}];
 assert.equal(projectContextualPublication(f).attributes[0].state,'present_unverified');
});
test('negative or merely mentioned fields never count as supported central inclusion',()=>{
 const f=native();f.video.analysis.knowledge.fields[0].role='mentioned';f.video.analysis.knowledge.fields[1].polarity='negated';const entry=projectContextualPublication(f);
 assert.equal(filterContextualEntries([entry],{dimension:'ingredient',value:'frango'}).length,0);
 assert.equal(filterContextualEntries([entry],{dimension:'ingredient',value:'frango',facetMode:'mentioned'}).length,1);
 assert.equal(filterContextualEntries([entry],{dimension:'tool',value:'frigideira',facetMode:'mentioned'}).length,0);
 const index=buildContextualIndex([entry]);assert.equal(index.facets.find(f=>f.valueId==='frango').supportCount,0);assert.equal(index.facets.find(f=>f.valueId==='frango').mentionedCount,1);
 assert.equal(index.facets.find(f=>f.valueId==='frigideira').negativeCount,1);
});
test('ANY is not ALL and cross-attribute SAME_UNIT is a real intersection',()=>{
 const entry=collection();assert.equal(entry.independentUnitCount,2);assert.equal(entry.format.value,'recipe_collection');
 const any=[{dimension:'ingredient',value:'frango',quantifier:'ANY'},{dimension:'tool',value:'forno',quantifier:'ANY'}];
 assert.equal(filterContextualEntries([entry],{facets:JSON.stringify(any)}).length,1);
 assert.equal(filterContextualEntries([entry],{facets:[{...any[0],quantifier:'ALL'}]}).length,0);
 assert.equal(filterContextualEntries([entry],{facets:[{...any[0],quantifier:'SAME_UNIT'},any[1]]}).length,0);
 const linked=collection(false);linked.video.analysis.knowledge.fields[1]={kind:'tool',name:'Frigideira',value:'Frigideira',unitIds:['u1'],evidence:[{source:'caption',excerpt:'Frango na frigideira.'}]};
 const changed=projectContextualPublication(linked);
 assert.equal(filterContextualEntries([changed],{facets:[{...any[0],quantifier:'SAME_UNIT'},{dimension:'tool',value:'frigideira',quantifier:'ANY'}]}).length,1);
});
test('same dimension alternatives are OR, dimensions are AND; unknown units fail closed for ALL/SAME_UNIT',()=>{
 const entry=projectContextualPublication(native());
 assert.equal(filterContextualEntries([entry],{facets:[{dimension:'ingredient',value:'peixe'},{dimension:'ingredient',value:'frango'}]}).length,1);
 assert.equal(filterContextualEntries([entry],{facets:[{dimension:'ingredient',value:'frango'},{dimension:'tool',value:'forno'}]}).length,0);
 for(const quantifier of ['ALL','SAME_UNIT'])assert.equal(filterContextualEntries([entry],{dimension:'ingredient',value:'frango',quantifier}).length,0);
 assert.throws(()=>parseContextualQuery({facets:'x'.repeat(4097)}),/inválido/);
 assert.throws(()=>parseContextualQuery({facets:Array.from({length:9},()=>({dimension:'ingredient',value:'frango'}))}),/inválido/);
 assert.throws(()=>parseContextualQuery({facets:[{dimension:'ingredient',value:'frango',quantifier:'ALL'},{dimension:'ingredient',value:'ovo',quantifier:'ANY'}]}),/inválido/);
});
test('facet coverage and recurrence volume deduplicate Reels and never enable threshold-only auto creation',()=>{
 const a=projectContextualPublication(native('RecipeA1')),b=projectContextualPublication(native('RecipeA2')),c=projectContextualPublication(preserved()),index=buildContextualIndex([a,a,b,c]);
 assert.equal(index.total,3);assert.equal(index.coverage.denominator,3);assert.equal(index.nodes.reduce((n,x)=>n+x.count,0),3);
 assert.deepEqual(Object.keys(index.coverage.states).sort(),[...coverageStates].sort());assert.equal(index.coverage.states.unknown,1);
 const f=index.facets.find(f=>f.valueId==='frango');assert.equal(f.volumeCount,2);assert.equal(f.supportCount,2);assert.equal(f.coverage.denominator,3);
 assert.equal(index.patterns.find(p=>p.valueId==='frango').supportCount,2);assert.ok(index.patterns.every(p=>p.automaticCreationEnabled===false&&p.promotionThreshold===null));
 assert.equal(filterContextualEntries([a],{category:'group-alimentacao'},[{id:'receitas',parentId:'group-alimentacao'}]).length,1);
});
test('read-only cache includes preserved sources, skips unpublished IDs and invalidates changed proof/source metadata',async()=>{
 let now=1000,calls=0;const f=native(),old=preserved(),all=[f.item,old.item,{id:'Unknown1',publication:{available:false}}],data=new Map([[f.item.id,f.video]]),legacy=new Map([[old.item.id,old.legacy]]);
 const repository={items:async()=>all,raw:async id=>{assert.notEqual(id,'Unknown1');calls++;return data.get(id);},store:{get:async path=>{assert.ok(path.startsWith('reels_legacy_content/'));calls++;return {data:legacy.get(path.split('/')[1])};}},categories:async()=>({nodes:[{id:'receitas',parentId:'group-alimentacao'}]}),observation:()=>({observedAt:new Date(now).toISOString()})};
 const curator=new ReelsContextualCurator({repository,clock:()=>now,readConcurrency:1,cacheTtlMs:60000});
 const first=await curator.overview();assert.equal(first.total,2);assert.equal(first.acceptedInventory,2);assert.equal(calls,2);assert.equal(first.processingStarted,false);
 assert.deepEqual((await curator.matchingIds({dimension:'ingredient',value:'frango'})).ids,[f.item.id]);assert.equal(calls,2);
 f.item.updatedAt='2026-10-17T12:01:00Z';f.video.source_caption.text='Arroz e água.';const second=await curator.overview();assert.equal(calls,4);assert.notEqual(first.versionHash,second.versionHash);
 now+=60001;await curator.overview();assert.equal(calls,6);
 assert.equal((await curator.detail(old.item.id)).sourceIdentity.kind,'legacy_preserved');assert.equal(await curator.detail('Unknown1'),null);
});

function v2Fixture(){
 const f=native('V2Recipe1');
 f.video.analysis.knowledge.fields=[];
 f.video.analysis.contextualSignals={version:2,primaryContext:{categoryId:'receitas',purpose:'Preparar frango',evidenceRefs:['e1']},units:[],attributes:[{dimension:'ingredient',valueId:'frango',scope:'video',unitIds:[],role:'central',polarity:'positive',state:'supported',evidenceRefs:['e1']}],evidence:[{id:'e1',sourceKind:'caption',sourceIdentity:f.video.source_caption.capture_id,excerpt:quote.excerpt,verificationLevel:'semantic_support_reviewed',verifiedBy:'MODEL_SELF_ASSERTION'}]};
 return f;
}
function serverReceipt(video,reviewed=['e1']){
 const body={createdBy:'server:gate_v2',policyVersion:'gate_v2',verdict:'accepted',reelId:video.id,analysisKey:video.analysis_key,analysisGeneration:video.analysis_generation,candidateContentHash:qualityCandidateHash(video.analysis),sourceManifest:qualitySourceManifest(video),sourceManifestHash:qualityDigest(qualitySourceManifest(video)),checks:[{code:'SERVER_ACCEPTED_FIXTURE',state:'supported'}],gaps:[],contextualEvidence:video.analysis.contextualSignals.evidence.map(e=>({id:e.id,state:'supported',verificationLevel:reviewed.includes(e.id)?'semantic_support_reviewed':'literal_anchor_verified',...(reviewed.includes(e.id)?{reviewReceiptId:'independent-source-review-'+e.id}:{})}))};
 const receipt={id:'quality_'+qualityDigest(body),...body};video.publication={qualityReceipt:{receiptId:receipt.id,receiptHash:qualityDigest(receipt)}};return receipt;
}
test('canonical v2 model claims cannot certify their own state/central role or evade receipt/source binding',()=>{
 const f=v2Fixture(),unverified=projectContextualPublication(f);
 assert.equal(unverified.attributes[0].state,'present_unverified');assert.equal(unverified.attributes[0].role,'unknown');assert.equal(unverified.sourceIdentity.qualityPolicyVersion,'historical_baseline');
 const receipt=serverReceipt(f.video),verification=verifyPublicationQualityReceipt({video:f.video,receipt}),verified=projectContextualPublication({...f,qualityVerification:verification});
 assert.equal(verification.trusted,true);assert.deepEqual(verification.verifiedEvidenceIds,['e1']);assert.equal(verified.attributes[0].state,'present_unverified');assert.equal(verified.attributes[0].role,'unknown');assert.equal(verified.attributes[0].dimension,'ingredient');assert.equal(verified.attributes[0].polarity,'positive');assert.equal(verified.sourceIdentity.qualityPolicyVersion,'gate_v2');
 const tampered=structuredClone(f);tampered.video.analysis.contextualSignals.evidence[0].sourceIdentity='other-capture';
 const rejected=verifyPublicationQualityReceipt({video:tampered.video,receipt});assert.equal(rejected.trusted,false);
 const invalid=projectContextualPublication({...tampered,qualityVerification:rejected});assert.equal(invalid.attributes[0].state,'invalid');
});
test('a valid accepted receipt with only literal anchor does not prove v2 semantic central role',()=>{
 const f=v2Fixture(),receipt=serverReceipt(f.video,[]),verification=verifyPublicationQualityReceipt({video:f.video,receipt});
 assert.equal(verification.trusted,true);assert.deepEqual(verification.verifiedEvidenceIds,[]);assert.deepEqual(verification.literalEvidenceIds,['e1']);
 const e=projectContextualPublication({...f,qualityVerification:verification});assert.equal(e.attributes[0].state,'present_unverified');assert.equal(e.attributes[0].role,'unknown');assert.equal(filterContextualEntries([e],{dimension:'ingredient',value:'frango'}).length,0);
});
test('v2 source reviews and temporal anchors do not certify complete unit propositions before ALL/SAME_UNIT',()=>{
 const f=v2Fixture();f.video.transcript='Frango na frigideira.';f.video.transcript_key='transcript/V2Recipe1';f.video.transcript_generation='3';
 f.video.transcript_words=[{word:'Frango',start_seconds:0,end_seconds:0.5},{word:'na',start_seconds:0.5,end_seconds:0.8},{word:'frigideira',start_seconds:0.8,end_seconds:1.5}];
 const signal=f.video.analysis.contextualSignals;signal.evidence.push({id:'unit1',sourceKind:'transcript',sourceIdentity:'transcript/V2Recipe1@3',excerpt:f.video.transcript,timeRange:{startSeconds:0,endSeconds:2},verificationLevel:'source_present'});
 signal.units=[{unitId:'recipe1',type:'recipe',completeness:'complete',evidenceRefs:['unit1']}];signal.attributes[0].scope='unit';signal.attributes[0].unitIds=['recipe1'];
 const receipt=serverReceipt(f.video,['e1','unit1']),verification=verifyPublicationQualityReceipt({video:f.video,receipt}),e=projectContextualPublication({...f,qualityVerification:verification});
 assert.equal(e.independentUnitCount,null);assert.equal(e.format.value,null);assert.equal(filterContextualEntries([e],{dimension:'ingredient',value:'frango',quantifier:'ALL'}).length,0);assert.equal(filterContextualEntries([e],{dimension:'ingredient',value:'frango',quantifier:'SAME_UNIT'}).length,0);
 const missingWords=structuredClone(f);delete missingWords.video.transcript_words;
 const without=projectContextualPublication({...missingWords,qualityVerification:verification});assert.equal(without.independentUnitCount,null);assert.equal(without.attributes[0].state,'unknown');assert.equal(filterContextualEntries([without],{dimension:'ingredient',value:'frango',quantifier:'ALL'}).length,0);
});
test('materialization verifies canonical v2 using only the publication-linked server receipt',async()=>{
 const f=v2Fixture(),receipt=serverReceipt(f.video),reads=[];
 const repository={items:async()=>[f.item],raw:async()=>f.video,store:{get:async path=>{reads.push(path);assert.equal(path,'reels_quality_receipts/'+receipt.id);return {data:receipt};}},categories:async()=>({nodes:[]})};
 const curator=new ReelsContextualCurator({repository});const d=await curator.detail(f.item.id);
 assert.equal(d.contextualSignals.receiptTrusted,true);assert.equal(d.attributes[0].role,'unknown');assert.deepEqual(reads,['reels_quality_receipts/'+receipt.id]);
});

test('unsupported unit references, oversized excerpts and unreviewed baseline central claims stay conservative',()=>{
 const f=native();f.video.analysis.knowledge.fields[0].role='central';
 let entry=projectContextualPublication(f);assert.equal(entry.attributes[0].role,'supporting');assert.equal(entry.attributes[0].claimedRole,'central');
 f.video.analysis.knowledge.fields[0].unitIds=['unknown-unit'];entry=projectContextualPublication(f);
 assert.equal(entry.attributes[0].state,'unknown');assert.deepEqual(entry.attributes[0].unitIds,[]);
 const long=native();long.video.source_caption.text='Frango '+'.'.repeat(2100);long.video.analysis.knowledge.fields[0].evidence=[{source:'caption',excerpt:long.video.source_caption.text}];
 assert.equal(projectContextualPublication(long).attributes[0].state,'invalid');
});

test('a saved typed value outside the controlled vocabulary is unknown, not absent',()=>{
 const f=native();f.video.analysis.knowledge.fields=[{kind:'ingredient',name:'Banana',value:'Uma banana',evidence:[quote]}];
 const entry=projectContextualPublication(f),coverage=entry.coverage.find(c=>c.dimensionId==='ingredient');
 assert.equal(entry.attributes.length,0);assert.equal(coverage.state,'unknown');assert.equal(coverage.reason,'CONTROLLED_VALUE_NOT_MAPPED');
});

test('raw baseline unit IDs cannot reassign a quote from a different independently proved recipe',()=>{
 const raw=collection(false);raw.video.analysis.knowledge.fields[1].unitIds=['u1'];
 const entry=projectContextualPublication(raw),tool=entry.attributes.find(a=>a.dimensionId==='tool');
 assert.equal(entry.independentUnitCount,2);assert.equal(tool.state,'unknown');assert.equal(tool.unitLink.reason,'DECLARED_UNIT_EVIDENCE_MISMATCH');assert.deepEqual(tool.unitIds,[]);
 const joined=[{dimension:'ingredient',value:'frango',quantifier:'SAME_UNIT'},{dimension:'tool',value:'forno',quantifier:'ANY'}];
 assert.equal(filterContextualEntries([entry],{facets:joined}).length,0);
 const timed=collection(false);timed.video.analysis.knowledge.fields[1].unitIds=['u1'];timed.video.analysis.knowledge.fields[1].evidence=[{source:'transcript',excerpt:'Peixe no forno.',start_seconds:0,end_seconds:2}];
 assert.deepEqual(projectContextualPublication(timed).attributes.find(a=>a.dimensionId==='tool').unitIds,[]);
});
test('real curator search preserves creator summary tag ID URL and category matches with facets',async()=>{
 const f=native();Object.assign(f.item,{creator:'@CozinhaEspecial',sourceUrl:'https://instagram.com/reel/RecipeA1',tags:['CrostaUnica'],publication:{...f.item.publication,summary:'Conhecimento consolidado sobre refeições'}});let calls=0;
 const repository={items:async()=>[f.item],raw:async()=>{calls++;return f.video;},store:{get:async()=>assert.fail('No additional source read needed')},categories:async()=>({nodes:[]})};
 const curator=new ReelsContextualCurator({repository}),facets=[{dimension:'ingredient',value:'frango',quantifier:'ANY'}];
 for(const q of ['CozinhaEspecial','consolidado','CrostaUnica','RecipeA1','instagram','receitas']){
  assert.equal(matchesReel(f.item,{q}),true);
  assert.deepEqual((await curator.matchingIds({q,facets})).ids,[f.item.id]);
  const overview=await curator.overview({q,facets});assert.equal(overview.total,1);assert.equal(overview.coverage.denominator,1);
 }
 assert.equal(calls,1);assert.equal(matchesReel(f.item,{q:'frigideira'}),false);
 assert.equal((await curator.overview({q:'frigideira',facets})).total,0);
 const detail=await curator.detail(f.item.id);assert.equal(Object.hasOwn(detail,'searchText'),false);
});
test('source staleness and original observation time survive fresh contextual materialization',async()=>{
 const f=native(),old='2026-10-16T10:00:00.000Z',now=Date.parse('2026-10-17T20:00:00.000Z');
 const repository={items:async()=>[f.item],raw:async()=>f.video,store:{get:async()=>null},categories:async()=>({nodes:[]}),observation:()=>({observedAt:old,cache:{stale:true}})};
 const curator=new ReelsContextualCurator({repository,clock:()=>now}),overview=await curator.overview(),detail=await curator.detail(f.item.id);
 for(const output of [overview,detail]){assert.equal(output.dataAsOf,old);assert.equal(output.sourceStale,true);assert.equal(output.observedAt,new Date(now).toISOString());assert.notEqual(output.observedAt,output.dataAsOf);}
});
test('source-evidence review cannot certify an unrelated value role context or complete-unit proposition',()=>{
 const f=v2Fixture(),s=f.video.analysis.contextualSignals;s.primaryContext={categoryId:'hardware-setup',purpose:'Computer repair',evidenceRefs:['e1']};s.attributes[0].valueId='carne-bovina';s.units=[{unitId:'inventedUnit',type:'recipe',completeness:'complete',evidenceRefs:['e1']}];
 const receipt=serverReceipt(f.video),verification=verifyPublicationQualityReceipt({video:f.video,receipt});assert.equal(verification.trusted,true);assert.deepEqual(verification.verifiedEvidenceIds,['e1']);
 const entry=projectContextualPublication({...f,qualityVerification:verification});assert.equal(entry.context.value,'recipe');assert.equal(entry.independentUnitCount,null);assert.equal(entry.attributes[0].state,'present_unverified');assert.equal(entry.attributes[0].role,'unknown');assert.equal(entry.attributes[0].claimedRole,'central');
 for(const facetMode of ['supported','mentioned'])assert.equal(filterContextualEntries([entry],{dimension:'ingredient',value:'carne-bovina',facetMode}).length,0);
});

test('a later stale catalogue refresh is disclosed even while the contextual cache remains valid',async()=>{
 const f=native();let stale=false,now=1000,rawReads=0;const original='2026-10-16T12:00:00.000Z';
 const repository={items:async()=>[f.item],raw:async()=>{rawReads++;return f.video;},store:{get:async()=>null},categories:async()=>({nodes:[]}),observation:()=>({observedAt:original,cache:{stale}})};
 const curator=new ReelsContextualCurator({repository,clock:()=>now}),first=await curator.overview();assert.equal(first.sourceStale,false);
 now+=1000;stale=true;const later=await curator.overview();assert.equal(later.sourceStale,true);assert.equal(later.dataAsOf,original);assert.equal(rawReads,1);
});

test('independent source anchors cannot be spliced to assign an ingredient to a different recipe',()=>{
 const raw=collection(false),ingredient=raw.video.analysis.knowledge.fields[0];
 ingredient.unitIds=['u2'];ingredient.evidence.push({source:'caption',excerpt:'Peixe no forno.'});
 const entry=projectContextualPublication(raw),projected=entry.attributes.find(a=>a.dimensionId==='ingredient');
 assert.equal(projected.state,'unknown');assert.deepEqual(projected.unitIds,[]);assert.equal(projected.unitLink.reason,'DECLARED_UNIT_EVIDENCE_MISMATCH');
 assert.equal(filterContextualEntries([entry],{facets:[{dimension:'ingredient',value:'frango',quantifier:'SAME_UNIT'},{dimension:'tool',value:'forno',quantifier:'ANY'}]}).length,0);
});
