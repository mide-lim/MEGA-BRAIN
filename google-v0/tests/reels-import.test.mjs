import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationHash} from '../lib/reels-migration.mjs';
import {createMigrationCopyBackup,buildMigrationCopyPlan} from '../lib/reels-migration-copy.mjs';
import {projectMigrationHistory} from '../lib/reels-migration-history.mjs';
import {buildBackupLinkManifest} from '../lib/reels-backup-links.mjs';
import {buildWebImportPackage,verifyWebImportPackage,materializeIntoCopy} from '../lib/reels-import.mjs';

function fixture(){
 const input={source:'synthetic-only',sourceRevision:'demo-rev',googleSnapshot:{records:[{path:'videos/demoGoogle',data:{id:'demoGoogle',status:'needs_attention',error:{uncertain:true}},updateTime:'2026-10-01T00:00:00Z'}],controls:[],objectInventory:[]},legacySnapshot:{videos:[{id:'demoLegacy',source_url:'https://www.instagram.com/reel/demoLegacy/',status:'analyzed',analysis:{title:'Saved legacy result',summary:'Preserve exact knowledge'},transcript:'Saved transcript'},{id:'demoPending',source_url:'https://www.instagram.com/reel/demoPending/',status:'pending',analysis:null,transcript:null}],histories:{automation_attempts:[{video_id:'demoLegacy',status:'uncertain',operation_name:'saved-external-operation'}]}},corpus:[{id:'demoLegacy',url:'https://www.instagram.com/reel/demoLegacy/',source_line:1},{id:'demoPending',url:'https://www.instagram.com/reel/demoPending/',source_line:2}]};
 const linkInputs={physicalCopyReceipt:{objects:[]},humanBackupAssertion:'Existing backups preserved'};
 const copyBackup=createMigrationCopyBackup(input),plan=buildMigrationCopyPlan(input),backupLinks=buildBackupLinkManifest({googleSnapshot:input.googleSnapshot,legacySnapshot:input.legacySnapshot,...linkInputs}),historyProjection=projectMigrationHistory({googleSnapshot:input.googleSnapshot,legacySnapshot:input.legacySnapshot,targetVideos:plan.targetCopy.videos});
 return {input,options:{copyBackup,backupLinks,linkInputs,historyProjection,sourceHashes:{sourceFile:'a'.repeat(64)}},targetCopy:{records:structuredClone(input.googleSnapshot.records)}};
}
test('package preserves Google, legacy knowledge and uncertain paid operations separately',()=>{
 const f=fixture(),before=structuredClone(f),pkg=buildWebImportPackage(f.options);
 assert.equal(pkg.counts.targetReels,3);assert.equal(pkg.counts.preservedGoogleReels,1);
 assert.equal(pkg.records.some(r=>r.path==='videos/demoGoogle'),false);
 const legacy=pkg.records.find(r=>r.path==='reels_legacy_content/demoLegacy');
 assert.deepEqual(legacy.data.analysis,f.input.legacySnapshot.videos[0].analysis);assert.equal(legacy.data.status,'legacy_preserved');assert.equal(legacy.data.executable,false);
 const retained=pkg.records.find(r=>r.path==='videos/demoLegacy');assert.equal(retained.data.status,'uncertain');assert.equal(retained.data.import_hold.active,true);
 const pending=pkg.records.find(r=>r.path==='videos/demoPending');assert.equal(pending.data.status,'registered');assert.equal(pending.data.import_hold.active,true);
 assert.equal(pkg.execution.applySupported,false);assert.deepEqual(f,before);
});
test('JSON copy materialization is repeatable and does not mutate its source',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options),before=structuredClone(f.targetCopy);
 const first=materializeIntoCopy({package:pkg,targetCopy:f.targetCopy,expectedSourceHashes:f.options.sourceHashes,...f.options});
 assert.deepEqual(f.targetCopy,before);assert.deepEqual(first.targetCopy.records[0],before.records[0]);
 assert.equal(first.receipt.googleRecordsPreserved,true);assert.equal(first.receipt.realMigrationApplied,false);
 const again=materializeIntoCopy({package:pkg,targetCopy:first.targetCopy,expectedSourceHashes:f.options.sourceHashes,...f.options});
 assert.equal(again.receipt.inserted,0);assert.equal(again.receipt.outputCopyHash,first.receipt.outputCopyHash);
});
test('changed Google data or updateTime refuses the entire copy',()=>{
 for(const mutate of [x=>x.records[0].data.status='registered',x=>x.records[0].updateTime='2026-10-02T00:00:00Z']){const f=fixture(),pkg=buildWebImportPackage(f.options);mutate(f.targetCopy);const before=structuredClone(f.targetCopy);assert.throws(()=>materializeIntoCopy({package:pkg,targetCopy:f.targetCopy,expectedSourceHashes:f.options.sourceHashes,...f.options}));assert.deepEqual(f.targetCopy,before);}
});
test('conflicting destination is not overwritten and no partial materialization leaks',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options);f.targetCopy.records.push({path:'reels_legacy_content/demoLegacy',data:{changed:true}});const before=structuredClone(f.targetCopy);
 assert.throws(()=>materializeIntoCopy({package:pkg,targetCopy:f.targetCopy,expectedSourceHashes:f.options.sourceHashes,...f.options}));assert.deepEqual(f.targetCopy,before);
});
test('tampered package remains rejected after recomputing its own seal',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options);pkg.records.push({path:'reels_commands/evil',data:{status:'queued'}});const {hash,...body}=pkg;pkg.hash=migrationHash(body);assert.throws(()=>verifyWebImportPackage(pkg,f.options));
});
test('source file hashes and a projection from another snapshot are rejected',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options);
 assert.throws(()=>materializeIntoCopy({package:pkg,targetCopy:f.targetCopy,expectedSourceHashes:{sourceFile:'b'.repeat(64)},...f.options}));
 const modified=structuredClone(f.options);modified.historyProjection.unlinkedHistory[0].sourceStatus='completed';assert.throws(()=>buildWebImportPackage(modified));
});
test('unlinked history and financial rows stay in inert namespaces only',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options),collections=new Set(pkg.records.map(r=>r.path.split('/')[0]));
 for(const forbidden of ['reels_events','reels_commands','reels_executions','jobs','settings','control_chunks','outbox'])assert.equal(collections.has(forbidden),false);
 assert.ok(collections.has('reels_historical_activity'));assert.ok(collections.has('reels_historical_coverage'));
});
test('legacy empty transcript is preserved instead of silently lost',()=>{
 const f=fixture();f.input.legacySnapshot.videos[0].transcript='';f.options.copyBackup=createMigrationCopyBackup(f.input);
 f.options.backupLinks=buildBackupLinkManifest({googleSnapshot:f.input.googleSnapshot,legacySnapshot:f.input.legacySnapshot,...f.options.linkInputs});
 f.options.historyProjection=projectMigrationHistory({googleSnapshot:f.input.googleSnapshot,legacySnapshot:f.input.legacySnapshot,targetVideos:buildMigrationCopyPlan(f.input).targetCopy.videos});
 const pkg=buildWebImportPackage(f.options);assert.equal(pkg.records.find(r=>r.path==='reels_legacy_content/demoLegacy').data.transcript,'');
});
test('duplicate copy paths and non-JSON runtime adapters fail closed',()=>{
 const f=fixture(),pkg=buildWebImportPackage(f.options);f.targetCopy.records.push(structuredClone(f.targetCopy.records[0]));assert.throws(()=>materializeIntoCopy({package:pkg,targetCopy:f.targetCopy,expectedSourceHashes:f.options.sourceHashes,...f.options}));
 assert.throws(()=>buildWebImportPackage({...f.options,store:{get(){throw Error('must not execute');}}}));
});
test('resealed backup links cannot invent verified media without original receipt inputs',()=>{
 const f=fixture();f.options.backupLinks.entries[0].currentGoogle={status:'current_google_media_verified',bucket:'invented',key:'invented.mp4',generation:'9',size:42,sha256:'b'.repeat(64)};
 const {hash,...body}=f.options.backupLinks;f.options.backupLinks.hash=migrationHash(body);
 assert.throws(()=>buildWebImportPackage(f.options));
});
test('original receipt inputs are mandatory and may not override source snapshots',()=>{
 const f=fixture();delete f.options.linkInputs;assert.throws(()=>buildWebImportPackage(f.options));
 const good=fixture();good.options.linkInputs.googleSnapshot={records:[]};assert.throws(()=>buildWebImportPackage(good.options));
});
