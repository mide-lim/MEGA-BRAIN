# Measured provider usage

MEG-85 adds `usage_cost` to the existing immutable analysis and transcription
artifacts. No additional inference, storage object or provider request is made.
The raw response stays intact. An observation is separate from the BRL financial
ledger: `actual_cents` remains the existing conservative settlement, and no
reserve, budget, credit timestamp or concurrency changes through measurement.

For the currently configured global Gemini 3.5 Flash-Lite standard requests,
the estimate uses `usageMetadata`: prompt tokens minus cached tokens, discounted
cached tokens, and candidate plus reasoning tokens. Unknown traffic/model,
missing counters or inconsistent usage is explicitly `unavailable`, with no
price value. It is never interpreted as a zero charge.

Chirp 3 in `us` uses `totalBilledDuration` from the synchronous response or the
single-file batch response. If both global and file totals exist they must agree
and are counted once. Conflicting totals, multiple files or missing duration stay
unavailable. The video duration is never substituted for billed audio. A response
with no recognized speech can still have nonzero billed duration.

Rates checked 14 October 2026: Gemini global standard USD0.30 per million input
(non-cached), USD0.03 cached input, USD2.50 candidate/reasoning output; Speech v2
standard USD0.016 per minute. Estimates round each operation up to a micro-USD.
The version is `google-list-2026-10-14`. These are list-price estimates of recorded
usage, not invoices or BRL costs. They exclude infrastructure, storage, transfer,
taxes, currency conversion and promotional credits. Failed requests or unknown
responses are not assigned a price by this measurement.

Sources: [Google model pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)
and [Speech pricing](https://cloud.google.com/speech-to-text/pricing).

## Offline report

`node google-v0/scripts/summarize-usage.mjs input.json output.json` reads a local
array of envelopes: `{stage, artifact, audio_uri?}`. Stages are `analysis` or
`transcription`. `artifact` is the saved provider artifact. For a batch transcript,
`audio_uri` identifies the exact single file. Existing `usage_cost` observations
can be aggregated; legacy artifacts with raw provider usage can be measured.
The output identifies observed coverage and unavailable entries by index. The
command has no network or credential access and refuses to overwrite the input
or any existing output file.

## Holding terminal source failures for owner verdict

An independent opt-in `auto_hold_terminal_sources: true` setting is default
false. This setting is not activated by deployment or by usage measurement.
It applies only to uploads in the current 262-member batch, after the reservation
has started. Eligible diagnoses are download tool exit 1/code 1 with no HTTP
status, at metadata (`unknown`, `unavailable`, `http_404`, `format_unavailable`)
or format selection (`format_unavailable`). An unknown metadata cause remains
unknown; it is not evidence that the source is private, deleted or invalid.

The worker confirms that no video/transcript/analysis is present and that the
original storage object does not exist. Permission, network or timeout errors
in that check are not absence. It then preserves the uncertain upload claim,
records `analyses/ig_error_<id>` for owner verdict, appends diagnostic history
without overwriting the owner's verdict, and writes an immutable source-hold
audit. Only after these proofs exist does it account the full reserved upload
maximum, mark the financial entry conservatively settled, and free that source's
active slot. This accounting is not a claim about actual billing. The failed
source is not automatically downloaded or inferred again. Other candidates can
advance through the existing admission controller.

Authentication, HTTP403/429, login, recognized network/timeout/local IO, transfer
failures, missing proofs and accounting failures still pause globally. A pause
already raised by another operation is never cleared. Even an accounting commit
with a lost receipt triggers a global pause; it cannot double-charge or retry
inference. Worker replies for held sources do not enqueue transcription or
analysis. Activation requires independent review and an operator decision; it
does not authorize source retry or corpus/budget expansion.

## Remaining scale work

This phase supplies auditable per-operation observations. It does not make the
262-video runtime support 3,005 videos or switch its fixed BRL settlements to
these estimates. The distributed financial/capacity records and configurable
batch admission remain separate implementation work before corpus expansion.
Book consolidation and result ordering timestamps remain deferred.
