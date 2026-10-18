import test from 'node:test';
import assert from 'node:assert/strict';
import {googleOperations,createMediaInspectionReceipt,readAnalysisContextCatalogue} from '../lib/google-operations.mjs';
import {qualityDigest,qualitySourceManifest} from '../lib/reels-quality-gate.mjs';
import {sha256} from '../lib/storage.mjs';
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
