import test from 'node:test';import assert from 'node:assert/strict';
import {pipelineProgress}from '../lib/pipeline-progress.mjs';
test('public progression omits financial fields, execution IDs and unsupported entries',()=>{
 const result=pipelineProgress({private_job:{video_id:'Reel_123',stage:'analysis',status:'started',maximum_cents:250,provider:'secret',updated_at:'2026-10-14'},legacy:{video_id:'Reel_123',stage:'media_access',status:'started'},bad:{video_id:'../other',stage:'upload',status:'started'}});
 assert.equal(result.items.length,1);assert.equal(result.active,true);
 assert.deepEqual(Object.keys(result.items[0]).sort(),['id','stage','status','version']);
 assert.equal(result.items[0].version.length,64);
 for(const word of ['private_job','maximum_cents','secret'])assert.ok(!JSON.stringify(result).includes(word));
});
test('new revisions and stage transitions invalidate versions without rewriting output',()=>{
 const jobs={upload:{video_id:'Reel_123',stage:'upload',status:'completed'},analysis:{video_id:'Reel_123',stage:'analysis',status:'completed',updated_at:'2026-10-13'}};
 const previous=pipelineProgress(jobs);const next=pipelineProgress({...jobs,new_analysis:{video_id:'Reel_123',stage:'analysis',status:'reserved',updated_at:'2026-10-14'}});
 assert.equal(next.items[0].status,'reserved');assert.equal(next.active,true);assert.notEqual(previous.items[0].version,next.items[0].version);
 assert.equal(pipelineProgress(Object.fromEntries(Object.entries(jobs).reverse())).items[0].version,previous.items[0].version);
});

test('an unsettled earlier stage is not hidden by a completed historical analysis',()=>{
 const result=pipelineProgress({old:{video_id:'Reel_123',stage:'analysis',status:'completed'},current:{video_id:'Reel_123',stage:'upload',status:'started'}});assert.equal(result.items.length,1);assert.equal(result.items[0].stage,'upload');assert.equal(result.active,true);
});
test('only allowlisted reconciliation categories are public and change the version',()=>{
 const j={video_id:'Reel_123',stage:'upload',status:'completed'};const before=pipelineProgress({job:j});const after=pipelineProgress({job:{...j,manual_reconciliation:'terminal_metadata_estimate_accounted_user_verdict_pending',failure_diagnostic:'SECRET'}});
 assert.equal(after.items[0].reason_code,'source_metadata_failed');assert.notEqual(before.items[0].version,after.items[0].version);assert.ok(!JSON.stringify(after).includes('SECRET'));
 const schema=pipelineProgress({job:{...j,stage:'analysis',manual_reconciliation:'confirmed_schema400_full_estimate_accounted_analysis_pending'}});assert.equal(schema.items[0].reason_code,'schema_rejected');
 for(const value of ['SECRET','__proto__','constructor'])assert.equal(pipelineProgress({job:{...j,manual_reconciliation:value}}).items[0].reason_code,undefined);
});
