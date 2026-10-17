import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBackupLinkManifest,verifyBackupLinkManifest,assertImportJson} from '../lib/reels-backup-links.mjs';

const hash='a'.repeat(64),id='demoReel01';
function input(){return {googleSnapshot:{bucket:'google-demo',records:[{path:'videos/'+id,data:{id,video_key:'originals/'+id+'/video.mp4',video_generation:'17'}}],objectInventory:[{name:'originals/'+id+'/video.mp4',generation:'17',size:'42'}]},legacySnapshot:{videos:[{id,video_key:'original/'+id+'.mp4'}]},physicalCopyReceipt:{objects:[{bucket:'google-demo',key:'originals/'+id+'/video.mp4',generation:'17',size:42,sha256:hash,sourceVerified:true,restoreVerified:true}]},humanBackupAssertion:'Backups existentes confirmados pelo proprietário.'};}
test('current verified Google media does not assert equality with legacy bytes',()=>{
 const source=input(),before=structuredClone(source),m=buildBackupLinkManifest(source);
 assert.equal(m.entries[0].currentGoogle.status,'current_google_media_verified');
 assert.equal(m.entries[0].currentGoogle.legacyBytesEqualityProven,false);
 assert.equal(m.entries[0].legacyReference.status,'backup_reference_unlocated');
 assert.equal(m.entries[0].legacyReference.humanBackupConfirmed,true);
 assert.equal(m.entries[0].legacyReference.missing,false);
 assert.equal(m.entries[0].processingEligible,false);assert.deepEqual(source,before);
 assert.equal(verifyBackupLinkManifest(m,source),true);
});
test('unlocated legacy reference is retained even when Google contains a different key',()=>{
 const s=input();s.googleSnapshot.records=[];const m=buildBackupLinkManifest(s);
 assert.equal(m.entries[0].currentGoogle,null);assert.equal(m.counts.legacyReferencesUnlocated,1);
 assert.equal(m.entries[0].legacyReference.deleted,false);
});
test('same Reel ID does not invent Google generation or proof',()=>{
 const s=input();delete s.googleSnapshot.records[0].data.video_generation;
 const m=buildBackupLinkManifest(s);assert.equal(m.entries[0].currentGoogle.status,'current_google_reference_unverified');
});
test('receipt generation, size, restore proof and namespace are mandatory',()=>{
 for(const mutate of [s=>s.physicalCopyReceipt.objects[0].generation='18',s=>s.physicalCopyReceipt.objects[0].size=43,s=>s.physicalCopyReceipt.objects[0].restoreVerified=false,s=>s.physicalCopyReceipt.objects[0].bucket='other']){
  const s=input();mutate(s);assert.throws(()=>buildBackupLinkManifest(s));
 }
});
test('conflicting inventory checksum cannot be covered by a receipt flag',()=>{
 const s=input();s.googleSnapshot.objectInventory[0].sha256='b'.repeat(64);assert.throws(()=>buildBackupLinkManifest(s));
});
test('strong alias requires full origin evidence and equal bytes',()=>{
 const s=input(),target=s.physicalCopyReceipt.objects[0];
 s.originAliases=[{reelId:id,source:{bucket:'legacy-demo',key:s.legacySnapshot.videos[0].video_key,generation:'4',size:42,sha256:hash},target:{...target},sourceVerified:true,evidenceHash:'c'.repeat(64)}];
 const m=buildBackupLinkManifest(s);assert.equal(m.counts.originAliasesBytesVerified,1);assert.equal(m.entries[0].legacyReference.status,'origin_alias_bytes_verified');
 s.originAliases[0].source.sha256='b'.repeat(64);assert.throws(()=>buildBackupLinkManifest(s));
});
test('a claimed alias without source verification never closes the link',()=>{
 const s=input();s.originAliases=[{reelId:id,source:{bucket:'r2',key:'old',generation:'1',size:42,sha256:hash},target:{...s.physicalCopyReceipt.objects[0]},sourceVerified:false,evidenceHash:hash}];assert.throws(()=>buildBackupLinkManifest(s));
});
test('duplicate IDs and duplicate physical identities fail closed',()=>{
 for(const mutate of [s=>s.legacySnapshot.videos.push({...s.legacySnapshot.videos[0]}),s=>s.physicalCopyReceipt.objects.push({...s.physicalCopyReceipt.objects[0]})]){const s=input();mutate(s);assert.throws(()=>buildBackupLinkManifest(s));}
});
test('tampering or source changes invalidate a manifest',()=>{
 const s=input(),m=buildBackupLinkManifest(s);m.entries[0].legacyReference.missing=true;assert.throws(()=>verifyBackupLinkManifest(m));
 const pristine=buildBackupLinkManifest(s);s.legacySnapshot.videos[0].video_key='other';assert.throws(()=>verifyBackupLinkManifest(pristine,s));
});
test('non-JSON inputs never invoke a runtime adapter or accessor',()=>{
 let invoked=false;const s=input();s.provider=()=>{invoked=true;};assert.throws(()=>buildBackupLinkManifest(s));
 const getter={};Object.defineProperty(getter,'data',{get(){invoked=true;return 1;}});assert.throws(()=>assertImportJson(getter));assert.equal(invoked,false);
});
