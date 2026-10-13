import test from 'node:test';import assert from 'node:assert/strict';
import {newLedger} from '../lib/financial-ledger.mjs';
import {creditObservationChanges,recordCreditObservation} from '../lib/credit-observation.mjs';
const now=Date.parse('2026-10-03T18:00:00Z'),account='billingAccounts/ABCDEF-123456-ABC123';
const input={schema_version:1,source:'google_console_credit',billing_account:account,currency:'BRL',credit_id:'fixture',observed_at:new Date(now-60000).toISOString(),expires_at:'2026-11-23T00:00:00Z',remaining_cents:172411,pending_account_cents:300};
test('credit reconciliation deducts pending account costs and newer local settlements without enabling work',async()=>{
  const state={...newLedger(),jobs:{job_one:{status:'completed',actual_cents:100,updated_at:new Date(now).toISOString()}}};
  let patch;const store={get:async()=>({data:state,updateTime:'version1'}),patch:async(path,changes,options)=>{assert.equal(path,'settings/financial');assert.equal(options.updateTime,'version1');patch=changes;}};
  await recordCreditObservation(store,input,{account,now});
  assert.equal(patch.remaining_credit_cents,172011);assert.equal(patch.coverage_verified,undefined);assert.equal(patch.enabled_stages,undefined);assert.equal(patch.paused,undefined);
  for(const change of [{billing_account:'billingAccounts/123456-ABCDEF-654321'},{observed_at:new Date(now-86400001).toISOString()},{observed_at:new Date(now+1).toISOString()},{source:'bigquery_query_time'},{currency:'USD'},{remaining_cents:.1}])assert.throws(()=>creditObservationChanges(state,{...input,...change},{account,now}));
  assert.throws(()=>creditObservationChanges({...state,balance_observed_at:input.observed_at},input,{account,now}));
});

test('accepts original observation up to 24h without changing timestamp or enabling a wider runtime policy',()=>{
 const observation={...input,observed_at:new Date(now-86400000).toISOString()};
 const changes=creditObservationChanges(newLedger(),observation,{account,now});assert.equal(changes.balance_observed_at,observation.observed_at);assert.equal(changes.balance_max_age_seconds,undefined);assert.equal(changes.paused,undefined);
 assert.throws(()=>creditObservationChanges(newLedger(),{...observation,observed_at:new Date(now-86400001).toISOString()},{account,now}));
});
