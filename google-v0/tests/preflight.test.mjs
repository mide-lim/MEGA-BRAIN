import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPilot} from '../lib/preflight.mjs';
const now = Date.parse('2026-10-03T16:00:00Z');
const configuration = () => ({environment:'google-v0',project_id:'isolated-v0',production_project_id:'megabrain-stt',concurrency:4,automatic_processing:false,
  required_services:['storage.googleapis.com'],credit:{verified:true,remaining_brl:1500,expires_at:'2026-11-23T00:00:00Z',covered_services:['storage.googleapis.com']},
  budget:{pilot_allocation_brl:1500,reserve_brl:250,spent_brl:0,reserved_brl:100,known_other_account_spend_brl:0,expiry_margin_hours:72}});
test('missing credit coverage and production project prevent activation', () => {
  const c=configuration();c.project_id='megabrain-stt';c.credit.verified=false;c.credit.covered_services=[];
  assert.equal(assessPilot(c,{now}).ready,false);
});
test('reserve includes in-flight work and account-wide spend', () => {
  const c=configuration();c.budget.known_other_account_spend_brl=200;
  assert.equal(assessPilot(c,{now,nextCostBrl:950}).ready,true);
  assert.equal(assessPilot(c,{now,nextCostBrl:951}).ready,false);
});
test('expiry margin and unavailable balance fail closed', () => {
  const c=configuration();c.credit.expires_at='2026-10-05T00:00:00Z';assert.equal(assessPilot(c,{now}).ready,false);
  c.credit.expires_at='2026-11-23T00:00:00Z';c.credit.remaining_brl=null;assert.equal(assessPilot(c,{now}).ready,false);
});
test('configured pilot allocation caps spend even with more credit', () => {
  const c=configuration();c.credit.remaining_brl=10000;c.budget.spent_brl=1100;
  assert.equal(assessPilot(c,{now,nextCostBrl:51}).ready,false);
});
