// Exercise the scheduling/classification boundaries from the actual patched image.
// No server bootstrap, database connection, credential, network or model is used.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] || '/app';
const heartbeat = fs.readFileSync(path.join(root, 'server/dist/services/heartbeat.js'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'server/dist/services/recovery/service.js'), 'utf8');
function extractFunction(source, signature, closing) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function anchor missing');
  const end = source.indexOf(closing, start);
  assert.ok(end >= 0, 'function end missing');
  return source.slice(start, end + closing.length);
}
const scheduler = extractFunction(heartbeat, 'async function scheduleBoundedRetryForRun(', '\n    }\n');
let schedulingReached = 0;
const parseObject = value => value && typeof value === 'object' ? value : {};
const sandbox = {
  parseObject,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON: 'transient_failure',
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON: 'transient_failure_retry',
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS: 2,
  WORKSPACE_BUSY_RETRY_REASON: 'workspace_busy',
  AI_CONNECTION_BUSY_RETRY_REASON: 'ai_connection_busy',
  MAX_TURN_CONTINUATION_RETRY_REASON: 'max_turn',
  executionFailureRetryCount() { schedulingReached++; throw new Error('UPSTREAM_SCHEDULER_REACHED'); },
};
const schedule = vm.runInNewContext('(' + scheduler + ')', sandbox);
const pilot = {adapterType: 'codex_local', adapterConfig: {command: '/usr/local/bin/codex-pilot'}};
(async () => {
  for (const errorCode of ['pilot_admission_rejected', 'adapter_failed', 'timeout', 'provider_quota']) {
    const result = await schedule({id: 'synthetic-run', errorCode}, pilot);
    assert.equal(result.outcome, 'not_scheduled');
    assert.equal(result.errorCode, 'pilot_manual_authorization_required');
  }
  assert.equal(schedulingReached, 0, 'pilot entered the scheduling path');
  await assert.rejects(schedule({}, {adapterType: 'codex_local', adapterConfig: {command: '/usr/local/bin/codex'}}), /UPSTREAM_SCHEDULER_REACHED/);
  assert.equal(schedulingReached, 1, 'non-pilot behavior was changed');

  const start = heartbeat.indexOf('const pilotAdmissionRejected =');
  const end = heartbeat.indexOf('let logSummary', start);
  assert.ok(start >= 0 && end > start);
  const classification = heartbeat.slice(start, end);
  for (const [agent, exitCode, message, expected] of [
    [pilot, 78, 'Pilot: Task Packet preflight rejected the execution', 'pilot_admission_rejected'],
    [pilot, 1, 'provider unavailable', 'adapter_failed'],
    [pilot, 78, 'application exit', 'adapter_failed'],
    [{adapterType:'codex_local', adapterConfig:{command:'/usr/local/bin/codex'}}, 78, 'Pilot: fixture', 'adapter_failed'],
  ]) {
    const code = vm.runInNewContext(classification + '; runErrorCode', {
      agent, parseObject, adapterResult:{exitCode,errorMessage:message},
      outcome:'failed', latestRun:null, recordedResponsibleUserDenialCode:null,
    });
    assert.equal(code, expected);
  }
  const setStart = recovery.indexOf('const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set(');
  const setEnd = recovery.indexOf(']);', setStart);
  assert.ok(setStart >= 0 && setEnd > setStart);
  const strings = recovery.slice(setStart, setEnd).match(/"[^"]+"/g).map(s => JSON.parse(s));
  const classify = extractFunction(recovery, 'export function classifyContinuationFailure(', '\n}\n').replace('export ', '');
  const classifyFailure = vm.runInNewContext('(' + classify + ')', {
    readNonEmptyString: v => typeof v === 'string' && v.trim() ? v.trim() : null,
    CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE:'fixture_waiting',
    NON_RETRYABLE_CONTINUATION_ERROR_CODES:new Set(strings),
    TRANSIENT_INFRA_CONTINUATION_ERROR_CODES:new Set(['adapter_failed']),
    CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS:2,
    CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS:30000,
  });
  const terminal = classifyFailure({errorCode:'pilot_admission_rejected'});
  assert.equal(terminal.kind, 'non_retryable');
  assert.equal(terminal.maxAttempts, 0);
  assert.equal(classifyFailure({errorCode:'adapter_failed'}).kind, 'transient_infra');
  console.log('PASS: patched-image scheduler, admission classification and recovery boundaries; no model invoked');
})().catch(error => {console.error(error);process.exitCode=1;});
