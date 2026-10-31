# Reels analysis contracts and offline CI

This package prepares structured analysis of one stored Reel while keeping real processing disabled. It contains two isolated modules:

| Module | Purpose | What its tests execute |
| --- | --- | --- |
| [reels-analysis](../../operations/reels-analysis/worker.py) | Offline A+B contract, taxonomy and fixture worker | Synthetic bytes and deterministic fixture payloads |
| [reels-analysis-live](../../operations/reels-analysis-live/worker.py) | Separately gated Cloud adapter and versioned persistence preparation | Injected synthetic transports and a fake-file reader with a stubbed probe |
| [reels-analysis-ci](../../operations/reels-analysis-ci/run_ci.py) | Public-file checks and isolated test orchestration | Both suites in separate temporary working copies |

No source media, private metadata, credentials, runtime state, billing data, audit evidence or operational receipts are included. The examples use synthetic identifiers and a placeholder project. Repository tests do not authorize a real call, read an archive, obtain credentials, create a service, change IAM or publish a result.

## Local checks

Use Linux with Python 3.14 and the dependencies in the [offline hash lock](../../operations/reels-analysis-ci/requirements.offline.lock.txt):

~~~sh
python -m pip install --require-hashes --only-binary=:all: --no-deps --index-url https://pypi.org/simple -r operations/reels-analysis-ci/requirements.offline.lock.txt
python -m pip check
python operations/reels-analysis-ci/run_ci.py
python scripts/check_links.py
python scripts/check_task_packets.py
~~~

The runner creates disposable copies, prepares their output directories and launches the 36-test offline suite and the 41-test adapter-preparation suite in separate Python processes. This prevents the two modules named worker and common from sharing an import cache. The integration also runs 14 boundary/auth-profile unit tests and five negative guard probes. FIFO regressions run in subprocesses with short timeouts. The source checkout receives no fixture results or journals.

The CI workflow uses Ubuntu 24.04, Python 3.14.10 and immutable Action commits recorded in [toolchain.json](../../operations/reels-analysis-ci/toolchain.json). It installs only five hash-locked validation dependencies from PyPI. It does **not** install google-auth, requests or a model SDK. The separate full lock inside the prepared module is a reviewed bundle snapshot, not the CI installation input.

Dependency and interpreter downloads happen before the test phase. The test phase runs in a new network namespace and also inherits a Python guard that rejects network sockets, Google authentication imports, credential-file reads, non-Python child processes and child flags that would disable the guard. Failed namespace setup fails CI. Local runs use the Python guard; a local success alone does not establish OS-level network isolation. Python audit hooks are defense in depth, not a sandbox for hostile code or a boundary against a privileged host writer. Run only reviewed code locally; the CI network namespace contains the test process tree independently of Python imports.

The new workflow has read-only repository permission, no OIDC token permission, no secrets, no deployment environment and no credential persistence. It handles push and pull_request events limited to these operations, this documentation and its own file. Existing workflows remain unchanged; the existing documentation workflow also runs on repository pushes and pull requests.

## Contract and classification

A model payload contains only A, B and quality. The program generates schema_version, identity and technical_envelope.

| Requested concept | Field |
| --- | --- |
| Main category | A.primary_category |
| Secondary topics | A.topics |
| Retrieval terms | A.keywords |
| Named referents | A.entities |
| Language, content type, summary | A.language, A.content_type, A.summary |
| Key insights | B.insights |
| Audio and visual observations | B.audio, B.visual |
| Visible screen text | B.screen_text |
| Cross-modal connections | B.connections |
| Evidence and optional transcript | B.evidence, B.full_transcript |
| Uncertainty and review | quality.uncertainties, review_required, review_reasons |

The proposed taxonomy has eight categories: technology, culture_reading, travel_outdoors, home_building, business_branding, food_cooking, practical_skills and other_uncertain. It remains a draft. Categories are broad groups, topics are subjects and entities are named referents. other_uncertain requires a reason and review; the draft taxonomy currently makes every valid result require review.

Claims reference existing evidence IDs. Evidence declares a modality and one of observed, author_claim, inference or unverified. An author's statement is not converted into a verified fact. Timestamps may be absent or null; known times must be finite, nonnegative, ordered and within a known duration. Missing modalities must remain explicit limitations.

The offline variant identifies its source as synthetic_bytes_not_video and computes a hash of the test bytes. It does not label that hash source_video_sha256. Metadata references are program-generated and null when absent; the offline worker accepts only explicitly synthetic metadata fixtures.

The prepared stored-video variant uses schema_version analysis.v1 plus contract_variant stored_video.v1. A future real result would carry a source_video_sha256 computed from the approved stored video and a reference/hash for its original metadata. Mock results keep that field null and use synthetic_fixture_sha256 instead. The model never supplies technical identity, costs, tokens or hashes.

Source snapshot revision constants identify the reviewed contract baseline, not a connection to private operational state. Public implementation labels are generic. [source-provenance.json](../../operations/reels-analysis-ci/source-provenance.json) records source and adapted hashes and every sanitization applied to imported files.

## Offline examples

~~~sh
cd operations/reels-analysis
python worker.py validate examples/offline-task.json --executor-id simulation/operator
python worker.py run examples/offline-task.json --executor-id simulation/operator
~~~

~~~sh
cd operations/reels-analysis-live
python worker.py prepare examples/stored-video.preparation.json --executor-id simulation/operator
python worker.py mock examples/stored-video.preparation.json --executor-id simulation/operator
~~~

The preparation command validates declarations without opening the declared video. A declared hash or duration is not a fresh observation. The mock command reads only its explicit synthetic fixture. The CLI has no live command. Creating or changing task JSON, an environment variable or a budget field cannot issue a live grant.

## Prepared request and authorization boundary

The prepared adapter has an exact model/location/API allowlist and no fallback. Its single request contains a video with embedded audio, static processing at one frame per second, low media resolution, low thinking, structured JSON and a local maximum of 4096 output tokens. Original captions are **not** added to the prompt or claimed to have been interpreted.

The full strict JSON Schema and A+B semantics are checked locally. A restricted responseSchema subset is used in the prepared Cloud request. No response schema, low setting or output-token count proves a financial ceiling.

Current local guards are 180 seconds, 50,000,000 media bytes, 68,000,000 bytes for the complete encoded request and 4,000,000 captured response bytes. They are conservative implementation guards, not claims about exact provider inline limits or accepted codecs. A response beyond the capture limit is explicitly partial and uncertain.

The installed external authority always denies real execution and spending. The future stored-file reader remains behind that authority. It requires a non-null metadata hash, matching metadata.id and video.file, an MP4-compatible format group, a video stream and an audio stream. When supplied, metadata size, hash, duration, dimensions, container and codecs must match the authorized observations. Reader tests use fake bytes and a stubbed subprocess; they run no real media probe.

Official authentication is lazy and excluded from offline CI. The prepared inference transport performs one HTTPS POST, with no redirect, retry, model fallback or token-refresh resend after an HTTP response. The public integration prepares a strict impersonated-ADC profile. An approved ADC path, project and target service account must come from the external grant, never task JSON or environment overrides. Strict JSON shape and target checks precede the official loader; the loader receives the same validated object. Exact impersonated-credential and human OAuth source types, signer target, default endpoints, no delegation chain and a requested lifetime no greater than 3600 seconds are checked before refresh.

The bounded auth request allows at most one POST to the canonical OAuth token endpoint and one POST to the exact target IAM generateAccessToken endpoint. A cached human access token may skip the OAuth step. Duplicate, out-of-order, metadata, STS, alternate port/path and redirect requests are denied. A failed endpoint remains reserved and cannot be retried. These two possible authentication steps are separate from the single inference POST; they do not activate a second model request.

This preparation uses official google-auth 2.62.0 APIs and explicitly validates pinned private attributes such as the source credential reference; compatibility must be independently checked before real use or dependency updates. Human ADC retains a refresh credential until revoked; it is not a short-lived target access token. The target request uses the SDK default lifetime of at most 3600 seconds; this code does not claim a 900-second CLI setting or a measured live expiry. Tests here use synthetic loader/type/request stubs, not real ADC or Google requests. Authentication, entitlement and real inference remain untested by these suites. The operational source snapshots are unchanged by this public integration delta.

The [activation proposal](IAM-ACTIVATION-PROPOSAL.md) describes remaining human and operational gates. It does not grant access or enable the prepared path.

## Persistence and proposed storage mapping

The coordinator runs on Linux with a local journal. The target writer uses exclusive versioned files, flush/fsync, directory synchronization, readback hashes and manifest-last publication. It does not assume that a hardlink or rename across a remote mount is atomic.

~~~text
APPROVED_MEDIA_ROOT/media/reels/REEL_ID/video.mp4
APPROVED_MEDIA_ROOT/media/reels/REEL_ID/metadata.json

APPROVED_ARTIFACT_ROOT/REEL_ID/versions/SOURCE_SHA/RUN_ID/
    raw-response.bin
    response-meta.json
    analysis.v1.json
    manifest.json

LOCAL_JOURNAL/REEL_ID/RUN_ID/
    input/...
    attempt/...
    finish/...
~~~

Original video and metadata stay untouched. A future logical analysis.v1.json pointer outside the immutable version directory requires a separate acceptance/publication step; this code does not publish it.

Roots must exist and match approved device/inode identity before a real write. The writer checks root identity before I/O and immediately before a request. Lost or replaced roots do not silently become local fallback directories. FIFO and other nonregular files are rejected without blocking the shared process.

The journal seals input before reserving a single transport attempt. Raw captured response bytes are saved before normalization. Cache validation checks seals before trusting source/version fields and reconciles both journal-to-artifacts and artifacts-to-journal. Missing records, corruption, incomplete publication or an uncertain source block resending, including after a version change. There is no automatic replay operation.

Readback and local checksums do not prove Windows ACL isolation, physical-disk persistence after power loss, an atomic transaction with a remote provider or resistance to a host writer that can forge/delete all records. A storage failure after a request can leave billing uncertain; preserve the raw capture, partial files and reservation.

A future SQLite FTS5 index is derived and rebuildable from accepted JSON and references to original metadata. It may index the A+B fields; author and date come from metadata references, not model inference. No database or index is deployed here.

## Future one-call procedure

1. Obtain separately reviewed human authority for one stored ID/hash, media transmission, exact project/model/location, expiry and a numeric gross budget. The installed authority remains denied.
2. Confirm dated provider limits, codec support, entitlement, quota, price, credit coverage and applicable retention. A catalogue listing or promotional balance is not an execution grant.
3. Validate the approved runtime, media root, artifact root and local journal. Review any unresolved attempt; never remove evidence to make a retry possible.
4. Only after a valid external grant, read/probe/hash the approved source and check metadata coherence. No historical metadata timestamp becomes a fresh observation.
5. Reserve the single attempt, send once and preserve the captured raw response before validating JSON. Stop on timeout, ambiguous HTTP failure or persistence failure; do not retry or switch providers.
6. Validate A+B and quality, publish only an immutable version with manifest/readback, then obtain independent review and human acceptance before any logical pointer publication or expansion.

This integration neither changes legacy product workflows nor invokes a launcher, creates a task authorization, deploys infrastructure or resumes a queue. CI success is evidence for offline code behavior only.

Public format references: [video understanding](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding), [structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output), [official auth transport](https://github.com/googleapis/google-auth-library-python/blob/main/google/auth/transport/requests.py).

## Executor preparation metrics proposal

The pilot executor measures the normal CLI entry-to-send boundary, including policy/input loading, construction, authority, history/prior checks, claim/reserve/begin_dispatch, token setup and final verification. The executor frame is emitted on stderr; stdout remains the result JSON. Nonempty stderr is not itself failure: evaluate exit code and outcome. Control, recovery, blocked and incomplete frames are not successful preparation samples.

The reviewed optimization covers 16 I/O operations without removing authorization or A+B validation, UNKNOWN handling or global-slot protection. Cached immutable work does not replace fresh final identity/hash/root verification before dispatch. External API setup and token acquisition inside the CLI count toward executor preparation; coordination and shared setup outside it must be measured separately, not hidden.

The public pilot inventory in `operations/reels-analysis-ci/pilot-public-files.json` records the required test count for the current source. The operator-only diagnostic and its 17 tests remain private. An explicit protected exclusive-sample receipt can admit the original first member of the fourth registered group while all other dispatches remain stopped; it preserves campaign allocations, one-attempt limits, signed grants and the normal instrumented `run-one` route. Tests use synthetic identities and a fake provider. Offline validation does not establish AC-013: that still requires an authorized real call with complete executor preparation below 60000 ms, valid persisted output and completed cleanup.
