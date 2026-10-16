import test from 'node:test';import assert from 'node:assert/strict';
import {buildMigrationManifest,rehearseMigration,migrationHash,migrationCandidateHash,verifyManifest,restoreMigrationBackup,planWriterCutover,planMigrationRollback}from '../lib/reels-migration.mjs';
const sha='a'.repeat(64);
const success={id:'Reel_001',status:'analyzed',analysis_key:'analysis/1',analysis_generation:'8',analysis_sha256:sha,analysis_quality_status:'accepted',analysis:{summary:'Preservar integralmente'},transcript:'Fala original',source_caption:{text:'Legenda'},video_key:'video/1',video_generation:'9'};
const failure={id:'Reel_002',status:'failed',failure_confirmed:true,source_url:'https://www.instagram.com/reel/Reel_002/',error:'Falha confirmada',history:[{stage:'upload'}]};
const input=()=>({source:'fixture-local',sourceRevision:'v1',videos:[success,failure,{...failure,id:'Reel_003'}],executionEvidence:[{video_id:'Reel_002',status:'failed',terminal_confirmed:true},{video_id:'Reel_003',status:'failed',terminal_confirmed:true}],ledgerEvidence:[{video_id:'Reel_003',status:'uncertain',paid_result_uncertain:true}],artifactInventory:[{bucket:'fixture-media',key:'analysis/1',generation:'8',size:8,sha256:sha,sourceVerified:true},{bucket:'fixture-media',key:'video/1',generation:'9',size:9,sha256:sha,sourceVerified:true}],evidenceComplete:true});
test('rehearsal preserves original bytes and validated successes, resets confirmed failure only in copy and retains uncertain paid state',()=>{const i=input(),before=migrationHash(i),r=rehearseMigration(i);assert.equal(migrationHash(i),before);assert.deepEqual(r.proof.counts,{preserve_success:1,reset_confirmed_error:1,retain_reconciliation:1});assert.deepEqual(r.copy[0],success);assert.equal(r.copy[1].status,'registered');assert.equal(r.copy[1].history,undefined);assert.deepEqual(r.copy[2],i.videos[2]);assert.deepEqual(restoreMigrationBackup(r.backup),i.videos);assert.equal(r.proof.repeatable,true);});
test('failed video is not terminal proof: missing ledger evidence, active jobs, external operation and timeouts retain originals',()=>{for(const change of [{evidenceComplete:false},{executionEvidence:[]},{executionEvidence:[{video_id:'Reel_002',status:'running'}]},{executionEvidence:[{video_id:'Reel_002',status:'failed',terminal_confirmed:true,operation_name:'stt/pending'}]},{executionEvidence:[{video_id:'Reel_002',status:'failed',terminal_confirmed:true,paid_result_uncertain:true}]}]){const m=buildMigrationManifest({...input(),...change});assert.equal(m.entries.find(x=>x.id==='Reel_002').disposition,'retain_reconciliation');}});
test('generation/hash mismatch, changed source, tampered manifesto/backup and duplicate IDs are rejected or retained',()=>{const i=input();i.artifactInventory[0].generation='wrong';assert.equal(buildMigrationManifest(i).entries[0].disposition,'retain_reconciliation');const r=rehearseMigration(input());assert.throws(()=>verifyManifest(r.manifest,[{...success,transcript:'mutated'},failure,input().videos[2]]),/Origem/);const tampered=structuredClone(r.manifest);tampered.entries[1].target.status='completed';assert.throws(()=>verifyManifest(tampered,input().videos),/alterado/);r.backup.videos[0].transcript='bad';assert.throws(()=>restoreMigrationBackup(r.backup),/corrompido/);assert.throws(()=>buildMigrationManifest({...input(),videos:[failure,failure]}),/duplicada/);});
test('cutover requires verified backup and exactly one writer, rollback preserves writes after cutover and new registrations',()=>{const r=rehearseMigration(input());assert.throws(()=>planWriterCutover({activeWriters:['a','b'],sourceWriter:'a',targetWriter:'b',manifestHash:r.manifest.hash,backupVerified:true}));const c=planWriterCutover({activeWriters:['a'],sourceWriter:'a',targetWriter:'b',manifestHash:r.manifest.hash,backupVerified:true});assert.equal(c.executed,false);const current=structuredClone(r.copy);current[1].newField='postcutover';current.push({id:'Reel_004',status:'registered'});const p=planMigrationRollback({backup:r.backup,migratedAtCutover:r.copy,currentTarget:current});assert.equal(p.records.find(x=>x.id==='Reel_002').newField,'postcutover');assert.equal(p.records.find(x=>x.id==='Reel_001').transcript,success.transcript);assert.deepEqual(p.preservedPostCutoverIds,['Reel_002','Reel_004']);assert.equal(p.executed,false);});
test('more than three thousand source IDs produce repeatable per-ID manifests',()=>{const i={source:'fixture',sourceRevision:'1',videos:Array.from({length:3107},(_,n)=>({id:'Reel_'+String(n).padStart(5,'0'),status:'registered'}))};const a=rehearseMigration(i),b=rehearseMigration({...i,videos:[...i.videos].reverse()});assert.equal(a.manifest.hash,b.manifest.hash);assert.equal(a.proof.counts.retain_reconciliation,3107);});

test('camelCase external operations and new active execution phases cannot reset',()=>{
 for(const data of [{status:'failed',operationName:'stt/pending',external_terminal_confirmed:false},...['submitting','collecting','applying'].map(status=>({status}))]){
  const m=buildMigrationManifest({...input(),executionEvidence:[{reelId:failure.id,terminal_confirmed:true,...data}]});assert.equal(m.entries.find(e=>e.id===failure.id).disposition,'retain_reconciliation');
 }
 const m=buildMigrationManifest({...input(),executionEvidence:[{reelId:failure.id,status:'failed',terminal_confirmed:true,operationName:'stt/done',external_terminal_confirmed:true}]});assert.equal(m.entries.find(e=>e.id===failure.id).disposition,'reset_confirmed_error');
});
test('manifest binds verified artifact checksum even without checksum in original record',()=>{
 const i=input();delete i.videos[0].analysis_sha256;const a=buildMigrationManifest(i);i.artifactInventory[0].sha256='b'.repeat(64);const b=buildMigrationManifest(i);assert.notEqual(a.hash,b.hash);assert.equal(b.entries[0].artifacts.find(x=>x.kind==='analysis').proofs[0].sha256,'b'.repeat(64));
 i.artifactInventory.push({...i.artifactInventory[0],sha256:'c'.repeat(64)});assert.equal(buildMigrationManifest(i).entries[0].disposition,'retain_reconciliation');
});
test('nested v2 uncertainty and undecided saved candidates cannot reset or replace a publication',()=>{
 for(const extra of [{reels_v2:{error:{uncertain:true}}},{reels_v2:{uncertain:true}},{analysis_candidate:{summary:'Resultado salvo'}},{candidate_analysis_key:'results/candidate',candidate_analysis_generation:'12'},{reels_v2:{candidate:{state:'review_required'}}}]){
  const v={...failure,...extra},i={...input(),videos:[v]},m=buildMigrationManifest(i);
  assert.equal(m.entries[0].disposition,'retain_reconciliation');assert.deepEqual(m.entries[0].target,v);
 }
 const v={...success,analysis_candidate:{summary:'Novo candidato sem decisão'}};
 const m=buildMigrationManifest({...input(),videos:[v]});assert.equal(m.entries[0].disposition,'retain_reconciliation');assert.deepEqual(m.entries[0].target.analysis,success.analysis);assert.equal(m.entries[0].target.analysis_key,success.analysis_key);
});
test('candidate decision needs terminal confirmation, evidence hash and the exact saved candidate hash',()=>{
 const v={...failure,analysis_candidate:{summary:'Candidato rejeitado'}};
 const decision={terminal_confirmed:true,state:'rejected',evidence_hash:sha,candidate_hash:migrationCandidateHash(v)};
 const resolved={...v,candidate_terminal_decision:decision};assert.equal(buildMigrationManifest({...input(),videos:[resolved]}).entries[0].disposition,'reset_confirmed_error');
 for(const change of [{terminal_confirmed:false},{state:'review_required'},{evidence_hash:null},{candidate_hash:'b'.repeat(64)}])assert.equal(buildMigrationManifest({...input(),videos:[{...resolved,candidate_terminal_decision:{...decision,...change}}]}).entries[0].disposition,'retain_reconciliation');
 const changed={...resolved,analysis_candidate:{summary:'Outro resultado'}};assert.equal(buildMigrationManifest({...input(),videos:[changed]}).entries[0].disposition,'retain_reconciliation');
});
test('uncertain error inside execution evidence cannot reset confirmed-looking failed record',()=>{
 const i={...input(),executionEvidence:[{video_id:failure.id,status:'failed',terminal_confirmed:true,error:{uncertain:true}}]};assert.equal(buildMigrationManifest(i).entries.find(e=>e.id===failure.id).disposition,'retain_reconciliation');
});
test('artifact proof requires bucket, generation, measured size and checksum with an unambiguous identity',()=>{
 for(const field of ['bucket','generation','size','sha256','sourceVerified']){const i=input();delete i.artifactInventory[0][field];assert.equal(buildMigrationManifest(i).entries[0].disposition,'retain_reconciliation');}
 for(const change of [{bucket:'another-bucket'},{size:10}]){const i=input();i.artifactInventory.push({...i.artifactInventory[0],...change});assert.equal(buildMigrationManifest(i).entries[0].disposition,'retain_reconciliation');}
 const i=input();i.videos[0].analysis_bucket='different-source';assert.equal(buildMigrationManifest(i).entries[0].disposition,'retain_reconciliation');
});
test('accepted or superseded candidates without the exact published generation cannot be reset as old failures',()=>{
 for(const state of ['accepted','superseded']){
  const v={...failure,candidate_analysis_key:'results/saved-candidate.json',candidate_analysis_generation:'13',analysis_candidate:{summary:'Resultado aceito salvo, ainda não publicado'}};
  v.candidate_terminal_decision={terminal_confirmed:true,state,evidence_hash:sha,candidate_hash:migrationCandidateHash(v)};
  const m=buildMigrationManifest({...input(),videos:[v]});assert.equal(m.entries[0].disposition,'retain_reconciliation');assert.deepEqual(m.entries[0].target,v);
 }
 const v={...success,candidate_analysis_key:success.analysis_key,candidate_analysis_generation:success.analysis_generation};v.candidate_terminal_decision={terminal_confirmed:true,state:'accepted',evidence_hash:sha,candidate_hash:migrationCandidateHash(v)};
 assert.equal(buildMigrationManifest({...input(),videos:[v]}).entries[0].disposition,'preserve_success');
});
test('saved unpublished analysis survives failed status and confirmed-looking error evidence without a quality decision',()=>{
 for(const quality of [undefined,'review_required','rejected']){
  const v={...failure,analysis_key:'results/saved.json',analysis_generation:'14',analysis:{summary:'Resultado pago salvo'}};if(quality!==undefined)v.analysis_quality_status=quality;
  const m=buildMigrationManifest({...input(),videos:[v],artifactInventory:[{bucket:'fixture-media',key:v.analysis_key,generation:'14',size:23,sha256:sha,sourceVerified:true}]});
  assert.equal(m.entries[0].disposition,'retain_reconciliation');assert.deepEqual(m.entries[0].target,v);
 }
});
