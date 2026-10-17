import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationHash} from '../lib/reels-migration.mjs';
import {createMigrationCopyBackup,restoreMigrationCopyBackup,buildMigrationCopyPlan,verifyMigrationCopyPlan,rehearseMigrationCopy} from '../lib/reels-migration-copy.mjs';
import {fragmentMarker,fragmentPath,fragmentSpec,splitControlMap} from '../lib/control-fragments.mjs';

const sha='a'.repeat(64),bucket='fixture-private-media';
const url=id=>'https://www.instagram.com/reel/'+id+'/';
function fixture(){
 const current={id:'Copy_0001',source_url:url('Copy_0001'),status:'analyzed',analysis:{summary:'Conhecimento atual preservado',categories:['Contexto sintético']},analysis_key:'results/current.json',analysis_generation:'12',analysis_quality_status:'accepted',transcript:'Transcrição atual',video_key:'originals/current.mp4',video_generation:'11',media_verified:true,source_caption:{text:'Legenda atual'}};
 return {source:'fixture-offline',sourceRevision:'fixture-data-digest-v1',googleSnapshot:{bucket,observedAt:'2026-01-10T12:00:00Z',records:[
  {path:'videos/Copy_0001',data:current,updateTime:'2026-01-10T11:00:00Z',typedSource:{name:'fixture/videos/Copy_0001',fields:{id:{stringValue:'Copy_0001'},counter:{integerValue:'9007199254740993'}},updateTime:'2026-01-10T11:00:00Z'}},
  {path:'reels_events/Event_001',data:{id:'Event_001',reelId:'Copy_0001',stage:'analysis',status:'completed',message:'Evento salvo'},updateTime:'2026-01-10T11:01:00Z',typedSource:{fields:{status:{stringValue:'completed'}}}},
  {path:'control_chunks/financial_jobs_00',data:{owner:'settings/financial',index:0,entries:{fixture_job:{video_id:'Copy_0001',status:'completed',stage:'analysis',terminal_confirmed:true}}},updateTime:'2026-01-10T11:02:00Z',typedSource:{fields:{index:{integerValue:'0'}}}},
  {path:'settings/reels_v2_taxonomy',data:{revision:7,nodes:[{id:'group_food',label:'Alimentação'}]},updateTime:'2026-01-10T11:03:00Z',typedSource:{fields:{revision:{integerValue:'7'}}}},
  {path:'reels_finance/Day_001',data:{day:'2026-01-10',estimatedUsd:1.25,billed:null,currency:'USD'},updateTime:'2026-01-10T11:04:00Z',typedSource:{fields:{estimatedUsd:{doubleValue:1.25},billed:{nullValue:null}}}}
 ],controls:{financial:{paused:true,control_fragments:{count:1,entry_count:1,digest:sha}},acquisition:{paused:true}},objectInventory:[{bucket,key:'originals/current.mp4',generation:'11',size:17,sha256:sha,sourceVerified:true},{bucket,key:'results/current.json',generation:'12',size:23,sha256:sha,sourceVerified:true}]},legacySnapshot:{observedAt:'2026-01-01T12:00:00Z',sourceHash:sha,videos:[{id:'Copy_0001',source_url:url('Copy_0001'),status:'analyzed',analysis:{summary:'Versão antiga preservada em arquivo'},transcript:'Transcrição antiga',updated_at:'2026-01-01T11:00:00Z'},{id:'Copy_0002',source_url:url('Copy_0002'),status:'analyzed',analysis:{summary:'Resultado legado ainda não conciliado'},video_key:'legacy/video.mp4',transcript:'Fala legada'}],histories:{analysis_jobs:[{id:'LegacyJob_01',status:'completed',error:null}],automation_attempts:[{video_id:'Copy_0002',started_at:'2026-01-01T10:00:00Z'}],stt_reservations:[{key:'legacy-reservation',seconds:42}],r2_operations:[{day:'2026-01-01',class:'A',count:3}]}},corpus:['Copy_0001','Copy_0002','Copy_0003'].map((id,i)=>({id,url:url(id),source_line:i+1}))};
}

test('complete copy rehearsal preserves current Google publication, raw typed records, all histories and controls',()=>{
 const input=fixture(),before=migrationHash(input),r=rehearseMigrationCopy(input),p=r.plan;
 assert.equal(migrationHash(input),before);assert.deepEqual(restoreMigrationCopyBackup(r.backup),input);
 assert.deepEqual(p.targetCopy.videos.find(v=>v.id==='Copy_0001'),input.googleSnapshot.records[0].data);
 assert.deepEqual(p.targetCopy.googleRecords,input.googleSnapshot.records);assert.deepEqual(p.targetCopy.controls,input.googleSnapshot.controls);
 assert.deepEqual(p.protectedArchive.legacySnapshot,input.legacySnapshot);assert.deepEqual(p.protectedArchive.sourceCorpus,input.corpus);
 assert.equal(p.counts.googleRecords,5);assert.equal(p.counts.targetVideos,3);assert.equal(p.counts.newRegisteredOnlyInCopy,1);assert.equal(p.counts.newRetainedOnlyInCopy,1);assert.equal(p.counts.legacyHistoryRows,4);
 assert.equal(r.proof.snapshotRestoredExactly,true);assert.equal(r.proof.repeatable,true);assert.equal(p.execution.migrationReady,false);assert.equal(p.execution.applySupported,false);
 assert.equal(p.execution.sourceWrites,0);assert.equal(p.execution.sourceDeletions,0);assert.equal(p.execution.processingEnabled,false);
 assert.equal(p.historyTransition.status,'preserved_not_imported_or_reprojected');assert.equal(p.historyTransition.financialProjectionRebuilt,false);assert.equal(p.historyTransition.legacyHistoryOperationallyLinked,false);
});
test('missing Google IDs with saved legacy results remain uncertain; only unprocessed IDs become registered in the copy',()=>{
 const input=fixture(),p=buildMigrationCopyPlan(input),v=p.targetCopy.videos.find(v=>v.id==='Copy_0002');
 assert.equal(v.status,'uncertain');assert.equal(v.error.uncertain,true);assert.equal(v.error.retryable,false);
 for(const field of ['analysis','transcript','video_key','history','executions'])assert.equal(Object.hasOwn(v,field),false);
 assert.deepEqual(p.targetCopy.videos.find(v=>v.id==='Copy_0003'),{id:'Copy_0003',source_url:url('Copy_0003'),status:'registered',stage:null});
 assert.equal(p.protectedArchive.excludedFromOperationalHistory,true);assert.equal(p.protectedArchive.legacySnapshot.videos[1].analysis.summary,input.legacySnapshot.videos[1].analysis.summary);
 const entry=p.entries.find(e=>e.id===v.id);assert.equal(entry.processingEligible,false);assert.ok(entry.blockers.includes('legacy_saved_content_requires_reconciliation'));
 assert.equal(input.legacySnapshot.videos[1].status,'analyzed');assert.equal(input.googleSnapshot.records.length,5);
});
test('conflicts are explicit hashes and never overwrite Google with an older or newer-looking legacy result',()=>{
 const input=fixture();input.legacySnapshot.videos[0].updated_at='2099-01-01T00:00:00Z';
 const p=buildMigrationCopyPlan(input),entry=p.entries.find(e=>e.id==='Copy_0001');
 assert.ok(entry.conflicts.some(c=>c.field==='analysis'));assert.ok(entry.conflicts.every(c=>c.chosen==='google'));
 assert.equal(entry.googleSource.dataHash,migrationHash(input.googleSnapshot.records[0].data));assert.equal(entry.legacySource.archiveOnly,true);
 assert.deepEqual(p.targetCopy.videos[0].analysis,input.googleSnapshot.records[0].data.analysis);assert.equal(p.protectedArchive.legacySnapshot.videos[0].updated_at,'2099-01-01T00:00:00Z');
});
test('uncertain v2 errors and saved candidates remain held with the valid published knowledge intact',()=>{
 for(const extra of [{reels_v2:{error:{uncertain:true}}},{candidate_analysis_key:'results/candidate.json',candidate_analysis_generation:'13'},{analysis_candidate:{summary:'Candidato não revisado'}}]){
  const input=fixture();Object.assign(input.googleSnapshot.records[0].data,extra);const p=buildMigrationCopyPlan(input),entry=p.entries.find(e=>e.id==='Copy_0001');
  assert.equal(entry.googleReconciliation.disposition,'retain_reconciliation');assert.ok(entry.blockers.includes('google_requires_reconciliation'));
  assert.deepEqual(p.targetCopy.videos[0],input.googleSnapshot.records[0].data);assert.equal(p.targetCopy.videos[0].analysis_key,'results/current.json');
 }
 const input=fixture();input.googleSnapshot.records.push({path:'reels_executions/Execution_01',data:{id:'Execution_01',reelId:'Copy_0001',status:'failed',error:{uncertain:true}},updateTime:'2026-01-10T11:00:00Z'});
 assert.equal(buildMigrationCopyPlan(input).entries[0].googleReconciliation.disposition,'retain_reconciliation');
});
test('metadata inventory never claims bytes were copied or restored, including supplied source proof flags',()=>{
 const input=fixture();let p=buildMigrationCopyPlan(input);
 assert.equal(p.artifacts.referenceCount,3);assert.equal(p.artifacts.providedSourceBytesProofs,2);assert.equal(p.artifacts.unverifiedReferences,1);
 assert.equal(p.artifacts.physicalCopiesPerformed,false);assert.equal(p.artifacts.physicalObjectBytesCopied,0);assert.equal(p.artifacts.physicalRestorationVerified,false);
 input.googleSnapshot.objectInventory.forEach(o=>{delete o.sourceVerified;});p=buildMigrationCopyPlan(input);
 assert.equal(p.artifacts.providedSourceBytesProofs,0);assert.ok(p.artifacts.references.every(r=>!r.sourceBytesProofProvided));
 assert.equal(rehearseMigrationCopy(input).proof.physicalRestorationVerified,false);
});
test('source artifact identity requires namespace, generation, size, checksum and nonconflicting provided proofs',()=>{
 for(const missing of ['bucket','generation','size','sha256','sourceVerified']){
  const input=fixture();delete input.googleSnapshot.objectInventory[0][missing];const ref=buildMigrationCopyPlan(input).artifacts.references.find(r=>r.key==='originals/current.mp4');assert.equal(ref.sourceBytesProofProvided,false);
 }
 const input=fixture();input.googleSnapshot.objectInventory.push({...input.googleSnapshot.objectInventory[0],size:18});
 assert.equal(buildMigrationCopyPlan(input).artifacts.references.find(r=>r.key==='originals/current.mp4').sourceBytesProofProvided,false);
 const noGeneration=fixture();delete noGeneration.googleSnapshot.records[0].data.video_generation;
 assert.equal(buildMigrationCopyPlan(noGeneration).artifacts.references.find(r=>r.key==='originals/current.mp4').reason,'missing_bucket_or_generation');
});
test('candidates, raw responses, diagnostics and orphan inventory records survive the backup without pretending to verify them',()=>{
 const input=fixture();input.googleSnapshot.records.push({path:'jobs/JobRaw_01',data:{video_id:'Copy_0001',status:'uncertain',result_artifact:{bucket,key:'results/raw.json',generation:'14'},download_diagnostic_key:'temporary/probe.json'},updateTime:'2026-01-10T11:00:00Z'});
 input.googleSnapshot.objectInventory.push({bucket,key:'results/orphan.json',generation:'15',size:7,sha256:sha});
 const r=rehearseMigrationCopy(input),refs=r.plan.artifacts.references;
 assert.ok(refs.some(x=>x.key==='results/raw.json'));assert.ok(refs.some(x=>x.key==='temporary/probe.json'&&x.generation===null));
 assert.equal(r.plan.artifacts.inventory.length,3);assert.deepEqual(restoreMigrationCopyBackup(r.backup).googleSnapshot,input.googleSnapshot);
 assert.equal(r.plan.entries[0].googleReconciliation.disposition,'retain_reconciliation');
});
test('tampering with raw typed fields, histories, controls or plan archives invalidates verification',()=>{
 const input=fixture(),backup=createMigrationCopyBackup(input);
 for(const mutate of [b=>{b.input.legacySnapshot.histories.stt_reservations[0].seconds=43;},b=>{b.input.googleSnapshot.records[0].typedSource.fields.counter.integerValue='1';},b=>{b.input.googleSnapshot.controls.financial.paused=false;}]){
  const changed=structuredClone(backup);mutate(changed);assert.throws(()=>restoreMigrationCopyBackup(changed),/corrompido/);
 }
 const p=buildMigrationCopyPlan(input),changed=structuredClone(p);changed.protectedArchive.legacySnapshot.videos[0].analysis.summary='Alterado';assert.throws(()=>verifyMigrationCopyPlan(changed,input),/corrompido/);
 input.corpus[0].source_line=99;assert.throws(()=>verifyMigrationCopyPlan(p,input),/diverge/);
});
test('restored snapshots and target copies do not share mutable references with originals or backups',()=>{
 const input=fixture(),before=migrationHash(input),backup=createMigrationCopyBackup(input),backupBefore=migrationHash(backup),restored=restoreMigrationCopyBackup(backup),p=buildMigrationCopyPlan(input);
 restored.legacySnapshot.histories.analysis_jobs[0].status='changed';p.targetCopy.googleRecords[0].typedSource.fields.counter.integerValue='2';p.protectedArchive.legacySnapshot.videos[1].transcript='changed';
 assert.equal(migrationHash(input),before);assert.equal(migrationHash(backup),backupBefore);
});
test('duplicate identities, ID/path conflicts and invalid source URLs fail rather than silently dropping rows',()=>{
 for(const mutate of [i=>i.corpus.push(i.corpus[0]),i=>i.legacySnapshot.videos.push(i.legacySnapshot.videos[0]),i=>i.googleSnapshot.records.push(i.googleSnapshot.records[0]),i=>{i.googleSnapshot.records[0].data.id='Wrong_001';},i=>{i.corpus[0].url=url('Wrong_001');},i=>{i.corpus[0].source_line=0;}]){
  const input=fixture();mutate(input);assert.throws(()=>buildMigrationCopyPlan(input));
 }
});
test('no runtime adapter, function, apply flag or malformed snapshot is accepted',()=>{
 for(const extra of [{store:{}},{provider:{}},{apply:true},{runtime:{execute(){}}}])assert.throws(()=>buildMigrationCopyPlan({...fixture(),...extra}));
 const callable=fixture();callable.googleSnapshot.controls.callback=()=>{};assert.throws(()=>createMigrationCopyBackup(callable),/JSON/);
 const bad=fixture();bad.legacySnapshot.histories.stt_reservations={};assert.throws(()=>buildMigrationCopyPlan(bad),/Histórico/);
 const circular=fixture();circular.googleSnapshot.controls.self=circular;assert.throws(()=>buildMigrationCopyPlan(circular),/circular/);
});
test('more than three thousand corpus IDs and Google-only IDs remain exactly once with repeatable copy plans',()=>{
 const input=fixture();input.corpus=Array.from({length:3107},(_,n)=>{const id='Bulk_'+String(n).padStart(5,'0');return {id,url:url(id),source_line:n+1};});
 input.legacySnapshot.videos=input.corpus.map(r=>({id:r.id,source_url:r.url,status:'pending'}));input.legacySnapshot.histories.automation_attempts.push({video_id:'Bulk_00000',started_at:'2026-01-01T00:00:00Z'});
 const r=rehearseMigrationCopy(input);assert.equal(r.plan.counts.targetVideos,3108);assert.equal(new Set(r.plan.targetCopy.videos.map(v=>v.id)).size,3108);
 assert.equal(r.plan.counts.googleOutsideCorpus,1);assert.equal(r.plan.counts.newRegisteredOnlyInCopy,3106);assert.equal(r.plan.counts.newRetainedOnlyInCopy,1);assert.equal(r.proof.repeatable,true);assert.equal(r.plan.counts.legacyHistoryRows,5);
 assert.ok(r.plan.entries.every(e=>e.processingEligible===false));assert.equal(r.plan.protectedArchive.legacySnapshot.videos.length,3107);
});
test('fragment roots, all sixteen chunks, counts and digests are audited without dropping incomplete snapshots',()=>{
 const input=fixture(),path='settings/financial',jobs={FixtureJob_01:{video_id:'Copy_0001',status:'completed'}},chunks=splitControlMap(path,jobs),spec=fragmentSpec(path);
 input.googleSnapshot.controls={};
 input.googleSnapshot.records=input.googleSnapshot.records.filter(r=>!r.path.startsWith('control_chunks/'));
 input.googleSnapshot.records.push({path,data:{jobs:{},paused:true,control_fragments:fragmentMarker(path,jobs)},updateTime:'2026-01-10T11:00:00Z'});
 chunks.forEach((entries,index)=>input.googleSnapshot.records.push({path:fragmentPath(spec,index),data:{schema_version:1,owner:path,index,entries},updateTime:'2026-01-10T11:00:00Z'}));
 let p=buildMigrationCopyPlan(input);assert.equal(p.coverage.fragmentAudits[0].verified,true);assert.equal(p.coverage.fragmentAudits[0].chunkCount,16);assert.equal(p.coverage.fragmentAudits[0].entryCount,1);
 input.googleSnapshot.records.pop();p=buildMigrationCopyPlan(input);assert.equal(p.coverage.providedFragmentProofsValid,false);assert.equal(p.coverage.fragmentAudits[0].verified,false);assert.equal(p.targetCopy.googleRecords.length,input.googleSnapshot.records.length);
 assert.deepEqual(restoreMigrationCopyBackup(createMigrationCopyBackup(input)),input);assert.equal(p.coverage.sourceCollectionCompletenessVerified,false);assert.ok(p.coverage.typedSourceMissing>0);
});
test('controls array retains exact raw wrappers and participates in uncertainty review using raw updateTime',()=>{
 const input=fixture();input.googleSnapshot.controls=[{path:'settings/financial',data:{jobs:{PendingJob_01:{video_id:'Copy_0001',status:'uncertain',paid_result_uncertain:true}},paused:true},typedSource:{name:'fixture/settings/financial',updateTime:'2026-01-10T11:05:00Z',fields:{paused:{booleanValue:true}}}}];
 const before=migrationHash(input),r=rehearseMigrationCopy(input);assert.equal(migrationHash(input),before);assert.deepEqual(r.plan.targetCopy.controls,input.googleSnapshot.controls);
 assert.equal(Object.hasOwn(r.plan.targetCopy.controls[0],'updateTime'),false);assert.deepEqual(restoreMigrationCopyBackup(r.backup).googleSnapshot.controls,input.googleSnapshot.controls);
 assert.equal(r.plan.entries[0].googleReconciliation.disposition,'retain_reconciliation');assert.equal(r.plan.counts.googleRecordsIncludingControls,6);assert.equal(r.proof.typedSourceCoverage.total,6);
 const conflicting=fixture();conflicting.googleSnapshot.controls=[{path:'videos/Copy_0001',data:{id:'Copy_0001',status:'failed'},typedSource:{updateTime:'2026-01-10T11:00:00Z'}}];assert.throws(()=>buildMigrationCopyPlan(conflicting),/diverge/);
});
test('controls object is explicitly normalized into evidence and cannot hide an uncertain ledger',()=>{
 for(const key of ['financial','settings/financial']){
  const input=fixture();input.googleSnapshot.controls={[key]:{paused:true,jobs:{UncertainJob_01:{video_id:'Copy_0001',status:'uncertain',paid_result_uncertain:true}}}};
  const p=buildMigrationCopyPlan(input);assert.equal(p.entries[0].googleReconciliation.disposition,'retain_reconciliation');assert.deepEqual(p.targetCopy.controls,input.googleSnapshot.controls);assert.ok(p.coverage.controlsWithoutUpdateTime.includes('settings/financial'));
 }
 const input=fixture();input.googleSnapshot.controls={'settings/financial':{data:{paused:true,jobs:{UncertainJob_01:{video_id:'Copy_0001',status:'uncertain'}}},typedSource:{updateTime:'2026-01-10T11:05:00Z'}}};
 assert.equal(buildMigrationCopyPlan(input).entries[0].googleReconciliation.disposition,'retain_reconciliation');assert.deepEqual(restoreMigrationCopyBackup(createMigrationCopyBackup(input)),input);
});
test('legacy-only paid results, empty transcripts, errors and uncertain history never become eligible clean registrations',()=>{
 for(const extra of [{status:'analyzed',analysis:{summary:'Resultado pago'}},{status:'pending',transcript:''},{status:'pending',video_key:'legacy/saved.mp4'},{status:'needs_attention'},{status:'pending',paid_result_uncertain:true}]){
  const input=fixture();input.legacySnapshot.videos=[{id:'Copy_0002',source_url:url('Copy_0002'),...extra}];const p=buildMigrationCopyPlan(input),entry=p.entries.find(e=>e.id==='Copy_0002');
  assert.equal(p.targetCopy.videos.find(v=>v.id==='Copy_0002').status,'uncertain');assert.equal(entry.disposition,'retain_legacy_reconciliation_in_copy');assert.equal(entry.processingEligible,false);
 }
 const input=fixture();input.legacySnapshot.videos=[{id:'Copy_0002',source_url:url('Copy_0002'),status:'pending'}];let p=buildMigrationCopyPlan(input);assert.equal(p.targetCopy.videos.find(v=>v.id==='Copy_0002').status,'uncertain');
 input.legacySnapshot.histories.automation_attempts=[];p=buildMigrationCopyPlan(input);assert.equal(p.targetCopy.videos.find(v=>v.id==='Copy_0002').status,'registered');
});
