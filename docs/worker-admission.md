# Durable worker admission

MEG-77 adds the private OIDC-authenticated `/tasks/admit` route. It uses the
existing Cloud Tasks queue and service identity, with no new scheduler or
infrastructure. Disabled by default: the worker configuration must explicitly
set `admission_enabled: true` after independent review and publication.

An operator initializes `settings/admission` with `schema_version: 1`, the
existing `batch_id`, a unique `run_id` (16–64 letters, digits, `_` or `-`),
`enabled: true`, and `intents: {}`. Preserve this document across worker restarts.
Then dispatch a single authenticated admission task containing `batchId`,
`runId`, and `tick: 0`. Never reset intents to retry an uncertain paid stage.

Before admission changes, the controller creates its deterministic successor
for 60 seconds later. Concurrent delivery and process restart reuse the same
successor name. Metadata dispatch may be retried by Cloud Tasks; provider
execution remains guarded by the unchanged create-only stage claim and ledger.
Only pending videos with no previous execution, media, or Instagram verdict
are admitted. CAS intents count toward the four slots before financial leases
exist. Completed analyses, explicitly isolated timeouts, and claims blocked
before payment free admission capacity; their identities remain in history.

The controller rechecks automation and financial controls. Financial/system
pause, stale credit, insufficient reserve, uncertain dispatch, disabled
controls, and the 10,000-tick limit stop continuation. Admission never resumes
these controls or repeats an uncertain inference. After reconciliation an
operator explicitly seeds a new tick. Finished batches stop without polling.

Unknown upload dispatch is held for review: the outbox is not recreated. A
crash after an intent but before outbox creation is recovered by the next tick.
A crash during an outbox write needs operator reconciliation. Existing videos
already partway through the old local coordinator require explicit operational
handoff; the controller does not infer which paid stage to replay.

One admission request shares the existing four-dispatch queue, briefly using a
worker slot. This implementation targets the bounded 262-video batch only.
The controller reconciles playback authorization only for accepted, persisted
analyses; it preserves all existing transfer/request limits and counters.
Rejected candidates are not allowed. The successor is installed before publication
so an interrupted whitelist write can be retried without repeating inference.
Source failures free capacity only after operator full conservative accounting
and a recorded Instagram verdict hold; the source is never retried automatically.
The existing result publication and quality gates remain unchanged. It does not claim to auto-resolve Instagram
errors, provider timeouts, or accounting uncertainty.
