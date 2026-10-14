# Smaller Firestore control writes

The current financial and capacity documents contain growing maps. A stage
rewrites the complete map even when only one execution/object changed. Four
concurrent videos contend on those same documents. Confirmed failures were
Firestore HTTP429 RESOURCE_EXHAUSTED for write bandwidth/request rate, not
Gemini or Instagram. Fragmentation targets this write amplification; production
throughput improvement still requires comparison after reviewed publication.

## Storage and atomicity

`settings/financial.jobs` and `settings/capacity.claims` are divided into sixteen
deterministic `control_chunks` documents per map. Existing execution/object IDs
remain unchanged, including the legacy `media_pilot_delivery` financial hold.
The roots keep configuration, counters, batch leases and a count/digest manifest.
The persistence adapter reconstructs the original logical schema for both worker
and web. There is no new database, service or IAM permission.

An update sends only changed fragments plus compact root changes in one atomic
commit. Root and fragment versions are preconditions. Untouched fragments are
not written. The budget check and counters remain strongly coordinated: randomly
sharding the spend limit itself would allow simultaneous overspending. The
change reduces payload/index fanout, not every shared-counter contention.

Reads verify every fragment, hash, ownership, key placement and entry count,
and recheck root version around the read. Missing/corrupt fragments fail closed.
Financial/capacity validations, stage idempotence, uncertainty, leases, budgets
and source verdicts retain their original logical schema and semantics. Maps
cannot lose historical entries through the update adapter.

Definite version rejections retain the existing bounded recalculation. A
Firestore metadata PATCH/atomic commit rejected with HTTP429 and provider status
RESOURCE_EXHAUSTED can be recalculated twice, after 100 and 200 ms. This wraps
only metadata writes, never provider inference, object upload or create-only
execution claims. Network failure, malformed/lost successful receipt, 401/403
or unknown response is not retried. A successful commit must acknowledge every
write; a missing receipt is uncertainty requiring reconciliation.

## Reviewed migration

`node google-v0/scripts/plan-control-fragmentation.mjs input.json output.json`
only builds an offline plan. Input includes project and `{data, updateTime}`
snapshots for financial, capacity, automation and admission. Output refuses
existing files/input overwrite and preserves complete originals plus digests.
It contains 38 atomic writes: 32 create-only fragments, two create-only archives,
two root updates and two paused-control version guards. The request must remain
under 10 MB. No network, credential, deploy or data mutation is performed.

Before applying: review final commit and migration evidence independently;
publish both worker and web images; confirm queue PAUSED, financial paused,
automation/admission disabled, and no started upload/STT/analysis operations.
The legacy started `media_access` umbrella is preserved exactly; it is not an
active model request, not cancelled, and its maximum remains reserved. Reserved
unstarted and uncertain records also remain intact. Never drain by resetting
counters or declaring unknown calls completed.

All operational readers must understand the fragment manifest before cutover.
The old local snapshot/coordinator helpers read raw maps and are not compatible
with the migrated layout. Keep recurring Codex/coordinator runs disabled; update
and validate those helpers before migration. Any stale-version/create-only
failure rejects the entire cutover. An unknown response requires reading roots,
all fragments and archives to reconcile; never blindly resubmit.

After migration compare public counters, complete stage records, media policy
and paused states; exercise duplicate/restart checks and measure bytes/conflicts.
Recover only explicitly diagnosed unstarted or reconciled steps, then compare
four-lane throughput on similar videos. A rollback after new writes must merge
all fragment changes; restoring an old snapshot blindly loses accounting.
The 262-member admission ceiling and original R$1,200/R$250 controls remain.
This is not authorization to start the entire 3,005 corpus.

## Downloader comparison

An isolated anonymous VPS comparison used yt-dlp 2026.08.19 with and without
curl_cffi 0.15.0 on C0ClWSEvMID, Dcrix5ZxkTw, DCJ1vBfOFCY and DdfXOm5iOC_.
Both variants downloaded three of four; media/video/audio were verified. The
persistent failed ID failed with empty media response in both. Dcrix5ZxkTw had
failed earlier and now downloaded in both variants. Impersonation availability
was false/true as expected. This sample provides no success-rate improvement
from the optional dependency. Fixed engine order/cache effects prevent claiming
a speed benefit. VPS results do not prove Cloud Run behavior or source privacy.
No inference, production download replay or inventory mutation was made.
The optional package is not added to the production image on this evidence.

Current fixture tests show an approximately92% reduction for one map-entry
update. The private real550-job/851-claim snapshot produces about93.8% smaller
selected-map payloads, excluding common counters and commit envelopes. These
are byte measurements, not evidence of a production throughput multiplier.

Sources: [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices)
and [yt-dlp networking dependencies](https://github.com/yt-dlp/yt-dlp#dependencies).
The single-document maximum depends on workload/indexes; do not assume a fixed
universal one-write-per-second ceiling. This migration uses38writes, so it does
not rely on large batches or approach500operations.
