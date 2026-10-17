import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeContextualCalibrationFixture} from './reels-contextual-calibration-fixture.mjs';
import {calibrateContextualPolicy,prepareContextualCategoryPlan,wilsonPrecisionInterval} from '../lib/reels-contextual-calibration.mjs';
import {projectContextualPublication} from '../lib/reels-contextual-projection.mjs';
const frango='recipe-ingredient-frango-any-v1';
const result=input=>calibrateContextualPolicy(input).rules.find(r=>r.ruleId===frango);
const rejects=(input,code)=>assert.throws(()=>prepareContextualCategoryPlan(input),e=>e.code===code);
function replaceSource(input,index,change){
 const r=input.records[index],source=JSON.parse(r.sourceJson);change(source);
 r.sourceJson=JSON.stringify(source);r.sourceSnapshotHash=createHash('sha256').update(r.sourceJson).digest('hex');
 for(const a of input.annotations.filter(a=>a.reelId===source.item.id))a.sourceSnapshotHash=r.sourceSnapshotHash;
}
test('finite saved cohort reports abstentions and honest small-sample uncertainty; never certifies unseen sources',()=>{
 const input=makeContextualCalibrationFixture(),before=JSON.stringify(input),{calibration,plan}=prepareContextualCategoryPlan(input),r=calibration.rules.find(r=>r.ruleId===frango);
 assert.equal(r.status,'calibrated');assert.deepEqual(r.memberIds,['QaCal_001','QaCal_002','QaCal_003','QaCal_004']);
 for(const m of [r.train,r.holdout]){assert.equal(m.tp,2);assert.equal(m.fp,0);assert.equal(m.tn,0);assert.equal(m.abstainNegative,2);assert.equal(m.precision,1);assert.equal(m.recall,1);assert.equal(m.coverage,0.5);assert.ok(m.precisionInterval95.lower<0.5);}
 assert.equal(calibration.generalizationAllowed,false);assert.equal(plan.approvedForApply,false);assert.equal(plan.processingStarted,false);
 assert.equal(plan.groups.length,2);assert.equal(plan.affectedIds.length,8);assert.equal(JSON.stringify(input),before);
 assert.deepEqual(prepareContextualCategoryPlan(input),{calibration,plan});
 assert.equal(wilsonPrecisionInterval(0,0),null);
 assert.equal(JSON.stringify(plan).includes('Ingredientes:'),false);
 for(const group of plan.groups){assert.equal(group.rule.generalizationAllowed,false);assert.equal(group.members.length,4);assert.ok(group.members.every(m=>m.categoryIds.includes('receitas')&&m.categoryIds.includes(group.categoryId)));}
});
test('source corruption, displaced annotations and self-authored labels fail closed',()=>{
 const bad=makeContextualCalibrationFixture();bad.records[0].sourceJson+=' ';rejects(bad,'CALIBRATION_SOURCE_HASH_MISMATCH');
 const moved=makeContextualCalibrationFixture();moved.annotations[0].sourceSnapshotHash=moved.records[1].sourceSnapshotHash;rejects(moved,'CALIBRATION_ANNOTATION_SOURCE_MISMATCH');
 const self=makeContextualCalibrationFixture();self.annotations[0].annotator.identity='/root/alignment_backend';rejects(self,'CALIBRATION_SELF_ANNOTATION_OR_LEAKAGE');
 const version=makeContextualCalibrationFixture();version.catalog[0].updateTime='2026-10-17T22:44:00.000Z';rejects(version,'CALIBRATION_SOURCE_VERSION_MISMATCH');
});
test('holdout cannot leak into train or be annotated after seeing predictions',()=>{
 const overlap=makeContextualCalibrationFixture();overlap.splitManifest.holdoutIds.push(overlap.splitManifest.trainIds[0]);rejects(overlap,'CALIBRATION_HOLDOUT_LEAKAGE');
 const seen=makeContextualCalibrationFixture();seen.annotations[0].annotator.predictionsSeen=true;rejects(seen,'CALIBRATION_SELF_ANNOTATION_OR_LEAKAGE');
 const time=makeContextualCalibrationFixture();time.annotations[0].reviewedAt='2026-10-17T22:40:00.000Z';rejects(time,'CALIBRATION_ANNOTATION_INVALID');
});
test('independently labeled false positive prevents automatic finite admission',()=>{
 const input=makeContextualCalibrationFixture();input.annotations.find(a=>a.ruleId===frango&&a.reelId==='QaCal_001').label='negative';
 const {calibration,plan}=prepareContextualCategoryPlan(input),r=calibration.rules.find(r=>r.ruleId===frango);
 assert.equal(r.train.fp,1);assert.ok(r.reasonCodes.includes('FALSE_POSITIVE_OBSERVED'));assert.notEqual(r.status,'calibrated');assert.ok(!plan.groups.some(g=>g.calibrationRuleId===frango));
});
test('unknown labels and missing reviewed members are withheld rather than silently negative',()=>{
 const input=makeContextualCalibrationFixture();input.annotations.find(a=>a.ruleId===frango&&a.reelId==='QaCal_001').label='unknown';
 const r=result(input);assert.equal(r.train.unknownPositivePrediction,1);assert.ok(r.reasonCodes.includes('POSITIVE_PREDICTION_REQUIRES_ADJUDICATION'));assert.equal(r.train.fp,0);assert.ok(!r.memberIds.includes('QaCal_001'));
 const unlabeled=makeContextualCalibrationFixture();unlabeled.annotations=unlabeled.annotations.filter(a=>a.ruleId!==frango||a.reelId!=='QaCal_001');assert.equal(result(unlabeled).train.unlabeled,1);
});
test('literal anchor identity and original quotation are mandatory even for independent labels',()=>{
 const input=makeContextualCalibrationFixture();input.annotations[0].anchors[0].sourceIdentity='different-capture';rejects(input,'CALIBRATION_ANNOTATION_ANCHOR_MISMATCH');
 const q=makeContextualCalibrationFixture();q.annotations[0].anchors[0].excerpt='invented original';rejects(q,'CALIBRATION_ANNOTATION_ANCHOR_MISMATCH');
});
test('manual edits and every matching disabled rule protect the editorial tree',()=>{
 const manual=makeContextualCalibrationFixture();manual.catalog[0].manual=true;assert.ok(!result(manual).memberIds.includes('QaCal_001'));
 const input=makeContextualCalibrationFixture();input.taxonomy.data.rules=[{id:'enabled-first',kind:'calibrated_ingredient_any',parentCategoryId:'receitas',valueId:'frango',enabled:true},{id:'disabled-second',kind:'calibrated_ingredient_any',parentCategoryId:'receitas',valueId:'frango',enabled:false}];
 const out=prepareContextualCategoryPlan(input);assert.ok(out.plan.suppressed.some(s=>s.ruleId===frango&&s.reason==='RULE_SUPPRESSED'));
 const parent=makeContextualCalibrationFixture();parent.taxonomy.data.nodes.find(n=>n.id==='receitas').manual=true;assert.equal(prepareContextualCategoryPlan(parent).plan.groups.length,0);
 const pending=makeContextualCalibrationFixture();pending.taxonomy.data.pendingOperationId='active';rejects(pending,'CALIBRATION_TAXONOMY_PRECONDITION_INVALID');
});
test('source-bound proof survives category-only metadata and invalidates changed source identity/content',()=>{
 const source=JSON.parse(makeContextualCalibrationFixture().records[0].sourceJson),entry=projectContextualPublication(source);
 const categoryOnly=projectContextualPublication({...source,item:{...source.item,categoryIds:['receitas','ctx_example']}});
 assert.equal(entry.sourceProofHash,categoryOnly.sourceProofHash);assert.notEqual(entry.fingerprint,categoryOnly.fingerprint);
 const changed=structuredClone(source);changed.video.source_caption.capture_id='new-capture';
 assert.notEqual(entry.sourceProofHash,projectContextualPublication(changed).sourceProofHash);
 const body=structuredClone(source);body.video.analysis.knowledge.fields[0].value='Peixe';assert.notEqual(entry.sourceProofHash,projectContextualPublication(body).sourceProofHash);
});
test('accepted inventory without evaluated source remains unknown and never contributes members',()=>{
 const input=makeContextualCalibrationFixture();input.catalog.push({...input.catalog[0],id:'QaCal_099'});
 const {calibration,plan}=prepareContextualCategoryPlan(input);assert.equal(calibration.corpus.inventoryCount,9);assert.equal(calibration.corpus.evaluatedCount,8);assert.equal(calibration.unknownCount,1);assert.ok(!plan.affectedIds.includes('QaCal_099'));
});
test('a recipe-looking typed source outside the approved recipe parent is not silently moved',()=>{
 const input=makeContextualCalibrationFixture();for(const c of input.catalog)c.categoryIds=['tecnologia'];
 const {plan}=prepareContextualCategoryPlan(input);assert.equal(plan.groups.length,0);
});

test('finite rerun retains the same group identities and member IDs without adding a second group per rule',()=>{
 const input=makeContextualCalibrationFixture(),first=prepareContextualCategoryPlan(input);
 for(const g of first.plan.groups){input.taxonomy.data.nodes.push({id:g.categoryId,name:g.label,parentId:g.parentCategoryId,manual:false});input.taxonomy.data.rules.push(g.rule);}
 input.taxonomy.data.revision++;
 const next=prepareContextualCategoryPlan(input);
 assert.deepEqual(next.plan.groups.map(g=>g.categoryId),first.plan.groups.map(g=>g.categoryId));
 assert.ok(next.plan.groups.every(g=>g.nodeAction==='retain'));
 assert.deepEqual(next.plan.affectedIds,first.plan.affectedIds);
});
