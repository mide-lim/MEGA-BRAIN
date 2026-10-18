import test from 'node:test';
import assert from 'node:assert/strict';
import {googleOperations,createMediaInspectionReceipt,readAnalysisContextCatalogue} from '../lib/google-operations.mjs';
import {qualityDigest,qualitySourceManifest,evaluateQualityGateV2} from '../lib/reels-quality-gate.mjs';
import {analysisCategoryOptions,analysisOutcome,buildAnalysisRequest} from '../lib/analysis.mjs';
import {categoryIds,categorySelectionSchema} from '../lib/category-taxonomy.mjs';
import {projectReel,categoryNavigation} from '../lib/reels-model.mjs';
import {sha256} from '../lib/storage.mjs';
import {loadLiveContextCatalogue} from '../lib/reels-semantic-curator.mjs';
function qualitySource(){
 const bytes=Buffer.from('verified-video'),audio=Buffer.from('verified-audio'),id='Reel_001',job='a'.repeat(64);
 const record={id,video_key:'originals/instagram/'+id+'/video.mp4',video_generation:'1',video_bytes:bytes.length,video_sha256:sha256(bytes),media_verified:true,audio_status:'present',duration_seconds:20,audio_key:'results/instagram/'+id+'/'+job+'/audio.flac',audio_generation:'2',audio_bytes:audio.length,audio_sha256:sha256(audio),audio_source_key:'originals/instagram/'+id+'/video.mp4',audio_source_generation:'1',transcript:'Frango no forno. Use 200 g de frango.',transcript_key:'results/instagram/'+id+'/'+job+'/transcription.json',transcript_generation:'3',source_caption:{text:'Frango no forno. Use 200 g de frango.',capture_id:'capture_fixture'}};
 record.media_inspection_receipt=createMediaInspectionReceipt({video:record,media:{hasVideo:true,hasAudio:true,audio_status:'present',duration_seconds:20},bytes});
 const m=qualitySourceManifest(record);record.transcription_receipt={operationIdentity:'synchronous:'+job,operationKind:'local_synchronous_submission',sourceAudioIdentity:m.audio,resultIdentity:m.transcript,rawResultIdentity:m.transcript,words:[{word:record.transcript,start_seconds:0,end_seconds:2}]};
 const proof={source:'caption',sourceIdentity:m.caption,excerpt:record.source_caption.text},report={title:'Frango no forno.',summary:'Use 200 g de frango.',categories:['receitas'],useful_information:[],visual_observations:[],limitations:[],transcript_quality:{assessment:'Fonte reconhecida sem acurácia medida.',uncertain_segments:[]},knowledge:{context:'recipe',fields:[{kind:'ingredient',name:'Ingrediente',value:'200 g de frango',evidence:[proof]}],keywords:[],missing_information:[]},qualityEvidenceV2:{version:2,title:[proof],summary:[proof]}};
 return {record,report,bytes,audio,job};
}

const catalogue=n=>({version:'semantic-curator-v1',state:'available',policyVersion:'policy-'+n,dataAsOf:'2026-10-18T00:00:00Z',groups:[{id:'group-'+n,name:'Group '+n}],noProviders:true,snapshotHash:String(n).repeat(64)});
test('live final worker reads each current catalogue immediately before submission and seals the exact snapshot',async()=>{
 const source=qualitySource(),requests=[],artifacts=[],events=[];let version=1;
 const api={project:'megabrain-v0-1017370021431',async request(url,options){events.push('provider');requests.push(options.json);return {candidates:[{finishReason:'MAX_TOKENS'}]};}};
 const storage={bucket:api.project+'-media',async metadata(){return null;},async writeImmutable(key,bytes){artifacts.push({key,data:JSON.parse(bytes)});return {generation:'10'};}};
 const ops=googleOperations({api,storage,tools:{},preset:{version:'fixture',system_instruction:'Analise',user_instruction:'Resuma'},config:{enabled:true,uploads_enabled:true,reels_quality_policy_version:'gate_v2',gemini_model:'gemini-test',reels_context_catalog_snapshot:catalogue(9)},executionAuthorization:async()=>events.push('authorized'),saveQualityReceipt:async r=>({id:r.id,receiptHash:qualityDigest(r)}),loadContextCatalog:async({videoId,record})=>{events.push('catalogue');assert.equal(videoId,source.record.id);assert.equal(record.id,videoId);return catalogue(version);}});
 for(version=1;version<=2;version++)await ops.analysis({video:source.record,executionId:source.job+version});
 assert.deepEqual(events,['authorized','catalogue','provider','authorized','catalogue','provider']);
 for(let i=0;i<2;i++){
  const snapshot=JSON.parse(requests[i].contents[0].parts[1].text).context_catalog_snapshot;
  assert.deepEqual(snapshot,catalogue(i+1));
  const saved=artifacts.filter(a=>a.key.endsWith('/analysis.json'))[i].data;
  assert.equal(saved.context_catalogue_receipt.snapshotHash,snapshot.snapshotHash);
  assert.deepEqual(saved.context_catalogue_snapshot,snapshot);
 }
});
test('unavailable reads are explicit and never use an old environment snapshot',async()=>{
 for(const loader of [null,async()=>{throw Error('offline');},async()=>null,async()=>({...catalogue(1),groups:Array(65).fill({})}),async()=>({...catalogue(1),groups:[{name:'x'.repeat(30000)}]})]){
  const r=await readAnalysisContextCatalogue(loader,{videoId:'DXVj0SkDesv'});
  assert.equal(r.state,'unavailable');assert.deepEqual(r.groups,[]);assert.match(r.snapshotHash,/^[a-f0-9]{64}$/);
 }
});
test('returned live catalogue is isolated and stale state is preserved',async()=>{
 const snapshot={...catalogue(1),state:'stale'},r=await readAnalysisContextCatalogue(async()=>snapshot,{});
 r.groups[0].name='changed';assert.equal(snapshot.groups[0].name,'Group 1');assert.equal(r.state,'stale');
});

function editorialRepository({nodes=[{id:'group-casa',name:'Casa e estilo',parentId:null},{id:'moda-acessorios',name:'Moda e acessórios',parentId:'group-casa'},{id:'manual_style',name:'Estilo pessoal',parentId:'moda-acessorios',manual:true}],revision=1,sourceStale=false,groups=[]}={}){
 const state={groups,sourceStale,inventory:{sourceVersions:new Map([['Reel_001',{video:'v1'}]])},taxonomySnapshot:{updateTime:'taxonomy-'+revision,data:{taxonomyVersion:'categories-v2',revision,nodes}},dataAsOf:'2026-10-18T00:00:00Z'};
 return {state,repository:{semanticCurator:{freshGroups:async()=>state,policy:async()=>({snapshot:{updateTime:'policy-1'}})}}};
}
test('live catalogue includes current editorial hierarchy separately and binds manual edits to snapshot',async()=>{
 const source=editorialRepository(),before=structuredClone(source.state),first=await loadLiveContextCatalogue(source.repository);
 assert.equal(first.state,'available');assert.deepEqual(first.groups,[]);assert.equal(first.editorial_taxonomy.authority,'editorial_reference_only');
 assert.equal(first.editorial_taxonomy.nodes[2].id,'manual_style');assert.equal(first.editorial_taxonomy.nodes[2].parentId,'moda-acessorios');assert.equal(first.editorial_taxonomy.nodes[2].manual,true);assert.equal(first.noProviders,true);
 const secondSource=editorialRepository({revision:2});secondSource.state.taxonomySnapshot.data.nodes[2].name='Aparência pessoal';
 const second=await loadLiveContextCatalogue(secondSource.repository);
 assert.notEqual(first.snapshotHash,second.snapshotHash);assert.equal(second.editorial_taxonomy.revision,2);assert.equal(second.editorial_taxonomy.nodes[2].name,'Aparência pessoal');
 assert.deepEqual(source.state,before); // A read cannot rewrite sources/editorial state.
});
test('editorial catalogue preserves semantic groups, stale status and existing size guards',async()=>{
 const group={id:'a'.repeat(64),status:'active',name:'Receita única',context:'recipe',kind:'format',parentId:'receitas',definition:'Uma receita.',members:[],revision:3,protected:true};
 const source=editorialRepository({sourceStale:true,groups:[group]}),snapshot=await loadLiveContextCatalogue(source.repository);
 assert.equal(snapshot.state,'stale');assert.equal(snapshot.complete,false);assert.equal(snapshot.groups[0].id,group.id);assert.equal(snapshot.groups[0].name,group.name);assert.equal(snapshot.groups[0].protected,true);
 const overflow=await loadLiveContextCatalogue(editorialRepository({nodes:Array.from({length:65},(_,i)=>({id:'manual_'+i,name:'Nó '+i}))}).repository);
 assert.equal(overflow.state,'unavailable');assert.equal(overflow.reason,'COMPACT_CATALOGUE_EDITORIAL_LIMIT');assert.deepEqual(overflow.groups,[]);
 const large=await loadLiveContextCatalogue(editorialRepository({nodes:[{id:'manual_large',name:'x'.repeat(30000)}]}).repository);
 assert.equal(large.state,'unavailable');assert.equal(large.reason,'COMPACT_CATALOGUE_BYTE_LIMIT');
 const semanticOverflow=await loadLiveContextCatalogue(editorialRepository({groups:Array.from({length:65},()=>group)}).repository);
 assert.equal(semanticOverflow.reason,'COMPACT_CATALOGUE_GROUP_LIMIT');
});


const sealCatalogue=body=>({...body,snapshotHash:qualityDigest(body)});
async function classificationCatalogue(){
 return loadLiveContextCatalogue(editorialRepository({nodes:[{id:'group-alimentacao',name:'Alimentação',parentId:null},{id:'receitas',name:'Receitas e preparo',parentId:'group-alimentacao'},{id:'manual_fixture_food',name:'Preparos caseiros',parentId:'receitas',manual:true}]}).repository);
}
const responseFor=report=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}]});
const categoryOutcome=(source,snapshot,categories)=>analysisOutcome(responseFor({...source.report,categories}),source.record,{requireKnowledge:true,qualityGateV2:{mediaInspection:source.record.media_inspection_receipt,transcriptionReceipt:source.record.transcription_receipt,trustedReviews:[]},contextCatalogSnapshot:snapshot});
test('sealed editorial destination reaches ordinary navigation without promoting semantic claims',async()=>{
 const snapshot=await classificationCatalogue(),source=qualitySource(),before=structuredClone(source.record);
 const request=buildAnalysisRequest({record:source.record,bucket:'megabrain-v0-test-media',preset:{version:'fixture',system_instruction:'Analise',user_instruction:'Resuma'},qualityGateV2Enabled:true,contextCatalogSnapshot:snapshot});
 const input=JSON.parse(request.contents[0].parts[1].text),schema=request.generationConfig.responseSchema.properties.categories;
 assert.ok(input.category_options.some(c=>c.id==='manual_fixture_food'));
 assert.ok(schema.anyOf[1].items.enum.includes('manual_fixture_food'));
 const outcome=categoryOutcome(source,snapshot,['manual_fixture_food']);
 assert.equal(outcome.accepted,true,JSON.stringify(outcome.quality?.checks));assert.deepEqual(outcome.report.categories,['manual_fixture_food']);
 // This is the exact existing publication metadata assignment, followed by GET projection.
 const video={...source.record,analysis:outcome.report,analysis_key:'results/fixture/accepted.json',analysis_generation:'10',analysis_quality_status:'accepted',categoryIds:[...outcome.report.categories]};
 const view=categoryNavigation([projectReel(video)],{taxonomyVersion:'categories-v2',revision:1,nodes:snapshot.editorial_taxonomy.nodes,assignments:[],rules:[]});
 assert.deepEqual(view.items[0].categoryIds,['manual_fixture_food']);assert.equal(view.items[0].publication.available,true);
 assert.equal(outcome.quality.contextualPropositions.primaryContext,null);
 const evidence={record:source.record,mediaInspection:source.record.media_inspection_receipt,transcriptionReceipt:source.record.transcription_receipt,contextCatalogSnapshot:snapshot};
 const unsupported=evaluateQualityGateV2({...evidence,report:{...outcome.report,title:'Afirmação inventada sem fonte.'}});
 assert.equal(unsupported.accepted,false);assert.ok(unsupported.checks.some(c=>c.fieldPath==='title'&&c.state!=='supported'));
 const forged=evaluateQualityGateV2({...evidence,report:outcome.report,contextCatalogSnapshot:{...snapshot,snapshotHash:'0'.repeat(64)}});
 assert.equal(forged.accepted,false);assert.ok(forged.checks.some(c=>c.code==='REPORT_CONTRACT_INVALID'));
 assert.deepEqual(source.record,before);
 assert.equal(categoryOutcome(source,snapshot,['a-organizar','manual_fixture_food']).accepted,false);
});
test('editorial allowlist rejects forged hashes, stale trees, malformed ancestry and unknown IDs',async()=>{
 const source=qualitySource(),snapshot=await classificationCatalogue();
 const change=fn=>{const body=structuredClone(snapshot);delete body.snapshotHash;fn(body);return sealCatalogue(body);};
 const invalid=[
  {...snapshot,snapshotHash:'0'.repeat(64)},
  change(s=>s.state='stale'),
  change(s=>s.complete=false),
  change(s=>s.editorial_taxonomy.nodes[2].parentId='missing_parent'),
  change(s=>s.editorial_taxonomy.nodes[0].parentId='manual_fixture_food'),
  change(s=>s.editorial_taxonomy.nodes.push({...s.editorial_taxonomy.nodes[2]})),
  change(s=>s.editorial_taxonomy.nodes[2].id='invalid/id'),
  change(s=>s.editorial_taxonomy.nodes[2].manual=false),
  change(s=>s.editorial_taxonomy.nodes=Array.from({length:65},(_,i)=>({id:'manual_'+i,name:'Node',parentId:null,manual:true})))
 ];
 for(const candidate of invalid){
  assert.equal(analysisCategoryOptions(candidate).some(c=>c.id==='manual_fixture_food'),false);
  assert.deepEqual(categoryOutcome(source,candidate,['manual_fixture_food']).reasons,['invalid_categories']);
 }
 assert.deepEqual(categoryOutcome(source,snapshot,['not_in_snapshot']).reasons,['invalid_categories']);
 assert.deepEqual(categoryOutcome(source,null,['manual_fixture_food']).reasons,['invalid_categories']);
 assert.equal(categoryOutcome(source,null,['receitas']).accepted,true);
 assert.deepEqual(categorySelectionSchema().anyOf[1].items.enum.sort(),categoryIds.filter(id=>!['a-organizar','tecnologia-geral'].includes(id)).sort());
});
test('saved response reconciliation uses only its sealed catalogue, never the current catalogue',async()=>{
 const source=qualitySource(),snapshot=await classificationCatalogue(),report={...source.report,categories:['manual_fixture_food']};let catalogueReads=0,providerCalls=0,saved;
 const api={project:'megabrain-v0-1017370021431',async request(){providerCalls++;throw Error('must not call provider');}};
 const storage={bucket:api.project+'-media',async metadata(){return {generation:'10'};},async read(){return JSON.stringify(saved);},async writeImmutable(){return {generation:'11'};}};
 const ops=googleOperations({api,storage,tools:{},preset:{version:'fixture',system_instruction:'Analise',user_instruction:'Resuma'},config:{enabled:true,uploads_enabled:true,reels_quality_policy_version:'gate_v2',gemini_model:'gemini-test'},executionAuthorization:async()=>{},saveQualityReceipt:async r=>({id:r.id,receiptHash:qualityDigest(r)}),loadContextCatalog:async()=>{catalogueReads++;throw Error('current catalogue is irrelevant');}});
 saved={preset_version:'fixture',model:'gemini-test',response:responseFor(report),context_catalogue_snapshot:snapshot,context_catalogue_receipt:{snapshotHash:snapshot.snapshotHash}};
 const accepted=await ops.restoreAnalysisResult({video:source.record,executionId:source.job});
 assert.equal(accepted.qualityGate.accepted,true,JSON.stringify(accepted.qualityGate.checks));assert.deepEqual(accepted.changes.analysis.categories,['manual_fixture_food']);
 saved={...saved,context_catalogue_receipt:{snapshotHash:'0'.repeat(64)}};
 const refused=await ops.restoreAnalysisResult({video:source.record,executionId:source.job});
 assert.equal(refused.qualityGate.accepted,false);assert.equal(refused.changes.analysis??null,null);
 saved={preset_version:'fixture',model:'gemini-test',response:responseFor(source.report)};
 const historical=await ops.restoreAnalysisResult({video:source.record,executionId:source.job});
 assert.equal(historical.qualityGate.accepted,true);assert.deepEqual(historical.changes.analysis.categories,['receitas']);
 assert.equal(catalogueReads,0);assert.equal(providerCalls,0);
});

