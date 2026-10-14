# Automatic library and processing updates

Video registration persists the source immediately in Google Firestore before the import response. A successful import requests a fresh complete snapshot, including when an older snapshot is still in flight. It does not authorize processing, expand batch membership or change a paused queue.

A visible site checks safe processing metadata every15 seconds through the existing authenticated financial/control reads. The progress response contains only video ID, stage, status and an opaque version; no financial entries, execution IDs or provider diagnostics. The version covers the retained stage history so completed/revised work is detected without inferring timestamps.

Between complete discovery snapshots (once a minute), only changed videos are fetched. Targeted reads accept at most40 unique valid IDs, use the same public projection as library pages and bound database concurrency to8. Both endpoints remain authenticated and no-store. The browser serializes requests; there is no extra Codex monitor, Google model call, service or database write.

Full traversal starts after a progression snapshot and checks progression again afterward. This catches a result completed while later pages were loading. Import/manual refresh requests queue one fresh traversal after an older request; a failed refresh never publishes a partial corpus or partial update batch. Failed versions remain eligible for the next tick. Returning to a visible tab refreshes automatically. Closing the component stops delivery and aborts the read.

Cards and open details show queued, download, transcription, analysis and attention states. Curated result, original transcript, keywords and book/category views update together from the video record. Candidates retained for review never replace the previously curated analysis. Playback preparation waits for a completed analyzed record and reacts to readiness/revision changes; a successful synchronization also clears obsolete playback errors when permission arrives later. It retains all existing server media permissions and budget checks.

A financial/progression outage does not hide the library: the complete read can still publish available video records while displaying a synchronization warning. Fast ticks do not replace old data on failure. Updates are polling-based, normally within15 seconds plus request latency for processing changes; external registrations and edits without a stage transition are discovered within a minute plus latency. This is not an instantaneous push subscription.

## Validation

Unit/API tests cover in-flight registration, completion during pagination, targeted update failure/retry, authentication, safe projection, concurrency and financial outages. Conventional Playwright QA uses actual components and synthetic data: it registers a new link while an older automatic snapshot is held, observes live transcription/analysis transitions, and verifies curated details/keywords/transcript without reopening or manual refresh. It also proves fast ticks did not reload the full corpus. No production login, model inference or real Instagram media is used by this fixture.

Publication requires independent human review and the existing deployment workflow. Worker processing, corpus, cost controls, source verdicts and the paused200-video batch remain unchanged. Older clients can continue their existing full-minute refresh; load the new application version once after deployment to receive the faster progression interface.
