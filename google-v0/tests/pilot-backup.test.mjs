import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {exportPilotBackup,verifyPilotBackup,restorePilotBackupLocally} from '../lib/pilot-backup.mjs';
test('pilot backup restores independent media and documents and rejects corrupted bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'megabrain-backup-'));
 try{
  const bytes=Buffer.from('fixture-video-with-audio'),digest=createHash('sha256').update(bytes).digest('hex');
  const docs=[{path:'settings/automation',data:{enabled:false},updateTime:'1'},{path:'settings/financial',data:{paused:true,jobs:{}},updateTime:'2'},{path:'videos/Reel_123',data:{id:'Reel_123',transcript:'Texto',analysis:{title:'Tema'}},updateTime:'3'}];
  let listCount=0;
  const store={list:async collection=>({records:docs.filter(d=>d.path.startsWith(collection+'/')).map(d=>({...d,data:++listCount>3?Object.fromEntries(Object.entries(d.data).reverse()):d.data})),nextPageToken:null})};
  const catalog=[{bucket:'megabrain-v0-1017370021431-media',name:'originals/instagram/Reel_123/original.mp4',generation:'1',bytes:bytes.length,sha256:digest}];
  const objects={list:async()=>catalog,read:async(_key,{generation})=>{assert.equal(generation,'1');return bytes;}};
  await assert.rejects(exportPilotBackup({store,objects,directory:join(root,'blocked'),queuePaused:false}));
  await exportPilotBackup({store,objects,directory:join(root,'backup'),queuePaused:true});
  const result=await restorePilotBackupLocally({source:join(root,'backup'),destination:join(root,'restored')});
  assert.equal(result.google_import_performed,false);assert.equal(result.object_count,1);
  const verified=await verifyPilotBackup(join(root,'restored'));assert.equal(verified.records.find(d=>d.path==='videos/Reel_123').data.transcript,'Texto');
  await assert.rejects(restorePilotBackupLocally({source:join(root,'backup'),destination:join(root,'restored')}));
  await writeFile(join(root,'restored','objects',verified.manifest.objects[0].file),'corrupt');
  await assert.rejects(verifyPilotBackup(join(root,'restored')),/corrompida/);
 }finally{await rm(root,{recursive:true,force:true});}
});
