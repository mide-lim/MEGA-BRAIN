"""Shared transaction engine: synthetic mock now; separately gated stored-video future."""
import argparse
import copy
import datetime as dt
import fcntl
import os
import stat
from pathlib import Path
import uuid
from common import ROOT, ContractError, canonical, parse_json, sha, validate, ensure_finite
from semantic_payload import validate_payload
from storage import FileStore, confined, read_bytes
from cloud_adapter import (Response, AuthFailure, build_request, endpoint,
                           SingleHTTPTransport, GoogleOfficialTokenSource)
import authorization

MAX_MEDIA_BYTES = 50_000_000  # Local pilot guard, NOT asserted Google inline API limit.
MAX_DURATION_SECONDS = 180
MAX_REQUEST_JSON_BYTES = 68_000_000  # Local bound including base64, prompt and schema.

class UncertainBlocked(ContractError):
    pass

class PersistenceUncertain(RuntimeError):
    pass

def check_task(task):
    validate("stored-video-task.v1.schema.json", task)
    reel = task["reel_id"]
    expected_video = f"media/reels/{reel}/video.mp4"
    expected_metadata = f"media/reels/{reel}/metadata.json"
    if task["source"]["relative_video_path"] != expected_video:
        raise ContractError("ID/video reference mismatch")
    if task["source"]["relative_metadata_path"] != expected_metadata:
        raise ContractError("ID/metadata reference mismatch")
    endpoint(task)
    return task

def prepare(task):
    check_task(task)
    return {"prepared": True, "source_opened": False, "provider_calls": 0,
            "model_availability_verified": False,
            "declared_source_sha256_only": task["source"]["source_video_sha256"],
            "authorization": authorization.current_status(),
            "blockers": ["Separate reviewed real-media/inference authorization absent.",
                         "Current gross budget and real-call allowance are zero.",
                         "Candidate/SKU/pricing/quota and approved media item gates remain external.",
                         "Windows/SSHFS persistence not validated by Linux fixture tests."]}

def check_media(task, data, duration, synthetic):
    ensure_finite(duration)
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise ContractError("media duration outside local 180-second pilot limit")
    if not 0 < len(data) <= MAX_MEDIA_BYTES:
        raise ContractError("media bytes outside local 50MB pilot limit")
    if len(data) != task["source"]["declared_bytes"]:
        raise ContractError("actual/declared media size mismatch")
    if abs(duration - task["source"]["declared_duration_seconds"]) > 0.01:
        raise ContractError("actual/declared media duration mismatch")
    digest = sha(data)
    if digest != task["source"]["source_video_sha256"]:
        raise ContractError("source hash mismatch")
    if synthetic and not data.startswith(b"SYNTHETIC TEST BYTES."):
        raise ContractError("mock accepts only explicit synthetic bytes")
    return digest

def file_versions():
    names = ["worker.py", "common.py", "storage.py", "cloud_adapter.py", "authorization.py",
             "semantic_payload.py", "contracts/stored-video-task.v1.schema.json",
             "contracts/analysis.stored-video.v1.schema.json", "contracts/model-payload.v1.schema.json",
             "prompts/stored-multimodal.v1.txt", "taxonomy.draft.v1.json", "requirements.lock.txt"]
    return {name: sha((ROOT / name).read_bytes()) for name in names}

def normalized_task(task):
    value = copy.deepcopy(task)
    value.pop("task_id")
    return value

def bundle_value(task, identity):
    basis = {"task": normalized_task(task), "media_identity": identity, "files": file_versions()}
    return {"basis": basis, "bundle_sha256": sha(canonical(basis))}

def make_result(task, identity, bundle, run_id, executor_id, synthetic, state,
                payload=None, error=None, response_data=None, raw=None):
    usage = None
    model = None
    if isinstance(response_data, dict):
        usage = response_data.get("usageMetadata")
        if usage is not None and not isinstance(usage, dict):
            usage = None
        model = response_data.get("modelVersion")
        if not isinstance(model, str):
            model = None
    result = {
        "schema_version": "analysis.v1", "contract_variant": "stored_video.v1",
        "identity": {"reel_id": task["reel_id"],
                     "source_kind": identity["source_kind"],
                     "source_video_sha256": None if synthetic else identity["sha256"],
                     "synthetic_fixture_sha256": identity["sha256"] if synthetic else None,
                     "source_metadata_reference": None if synthetic else identity["metadata_reference"]},
        "analysis_state": state, "model_payload": payload,
        "technical_envelope": {
            "provider_mode": "mock" if synthetic else "google_cloud",
            "requested_model": task["cloud"]["model"], "used_model": model,
            "project_id": task["cloud"]["project_id"], "location": "global", "api_version": "v1beta1",
            "processing_utc": dt.datetime.now(dt.timezone.utc).isoformat(), "run_id": run_id,
            "executor_identity": executor_id, "implementation_identity": "codex-native/developer",
            "input_state_revision": 11, "versions": task["versions"],
            "bundle_sha256": bundle, "provider_request_attempts": 1,
            "real_inference_attempts": 0 if synthetic else 1,
            "raw_response_sha256": sha(raw) if raw is not None else None,
            "usage_metadata": usage,
            "cost": {"kind": "unknown", "gross_amount": None, "currency": "USD",
                     "reason": "No billing measurement; mock usage is synthetic when provider_mode=mock."},
            "multimodal_validated": False, "download_state": "not_managed", "error": error}}
    validate("analysis.stored-video.v1.schema.json", result)
    return result

def normalize_response(response, duration):
    if response.truncated:
        raise ContractError("captured response exceeded local byte cap; raw capture is partial")
    if response.status != 200:
        raise ContractError("provider HTTP status " + str(response.status))
    outer = parse_json(response.body)
    candidates = outer.get("candidates") if isinstance(outer, dict) else None
    if not isinstance(candidates, list) or len(candidates) != 1:
        raise ContractError("exactly one response candidate required")
    candidate = candidates[0]
    if candidate.get("finishReason") != "STOP":
        raise ContractError("provider completion not STOP")
    parts = candidate.get("content", {}).get("parts")
    if not isinstance(parts, list) or not parts or any(set(p) != {"text"} for p in parts):
        raise ContractError("non-text/tool response forbidden")
    text = "".join(p["text"] for p in parts if isinstance(p.get("text"), str))
    payload = parse_json(text)
    validate_payload(payload, duration)
    return outer, payload

class Worker:
    def __init__(self, artifact_root=None, coordination_root=None, artifact_hook=None, artifact_identity=None):
        # Program configuration only; no output root comes from task JSON.
        self.artifacts = FileStore(artifact_root or ROOT / "outputs/artifacts", artifact_hook, artifact_identity)
        self.journal = FileStore(coordination_root or ROOT / "outputs/local-journal")
        for store in (self.artifacts, self.journal):
            if store.expected_identity is None:
                observed = store.root.stat()
                store.expected_identity = {"device": observed.st_dev, "inode": observed.st_ino}

    def _input(self, prefix):
        seal = self.journal.verify(prefix + "/input")
        if set(seal["files_sha256"]) != {"task.json", "identity.json", "bundle.json"}:
            raise ContractError("journal input artifact set")
        task = parse_json(self.journal.get(prefix + "/input/task.json"))
        identity = parse_json(self.journal.get(prefix + "/input/identity.json"))
        bundle = parse_json(self.journal.get(prefix + "/input/bundle.json"))
        check_task(task)
        if identity["sha256"] != task["source"]["source_video_sha256"]:
            raise ContractError("journal source identity mismatch")
        if identity["byte_count"] != task["source"]["declared_bytes"] or identity["duration"] != task["source"]["declared_duration_seconds"]:
            raise ContractError("journal media bounds mismatch")
        if bundle["basis"]["task"] != normalized_task(task) or bundle["basis"]["media_identity"] != identity:
            raise ContractError("journal bundle input mismatch")
        if sha(canonical(bundle["basis"])) != bundle["bundle_sha256"]:
            raise ContractError("journal bundle digest mismatch")
        expected = {"run_id": Path(prefix).name, "source_sha256": identity["sha256"],
                    "bundle_sha256": bundle["bundle_sha256"]}
        if seal["metadata"] != expected:
            raise ContractError("journal seal identity mismatch")
        return task, identity, bundle

    def _cached(self, prefix, saved_task, identity, bundle):
        # A committed send intent is mandatory even if response is already present.
        attempt = self.journal.verify(prefix + "/attempt")
        if attempt["metadata"] != {"run_id": Path(prefix).name}:
            raise ContractError("attempt metadata mismatch")
        if set(attempt["files_sha256"]) != {"intent.json"}:
            raise ContractError("attempt artifact set")
        intent = parse_json(self.journal.get(prefix + "/attempt/intent.json"))
        if intent != {"run_id": Path(prefix).name, "bundle_sha256": bundle["bundle_sha256"],
                       "maximum_inference_requests": 1, "attempt_reserved": True}:
            raise ContractError("attempt intent mismatch")
        finish = self.journal.verify(prefix + "/finish")
        if finish["metadata"] != {"run_id": Path(prefix).name}:
            raise ContractError("finish metadata mismatch")
        if set(finish["files_sha256"]) != {"reference.json"}:
            raise ContractError("finish artifact set")
        ref = parse_json(self.journal.get(prefix + "/finish/reference.json"))
        expected_prefix = f"{saved_task['reel_id']}/versions/{identity['sha256']}/{Path(prefix).name}"
        if ref["artifact_prefix"] != expected_prefix or ref["bundle_sha256"] != bundle["bundle_sha256"]:
            raise ContractError("output reference mismatch")
        manifest_bytes = self.artifacts.get(expected_prefix + "/manifest.json")
        if sha(manifest_bytes) != ref["manifest_sha256"]:
            raise ContractError("artifact manifest changed")
        manifest = self.artifacts.verify(expected_prefix)
        names = set(manifest["files_sha256"])
        if names not in ({"analysis.v1.json", "raw-response.bin", "response-meta.json"},
                          {"analysis.v1.json", "transport-error.json"}):
            raise ContractError("result artifact set")
        result = parse_json(self.artifacts.get(expected_prefix + "/analysis.v1.json"))
        validate("analysis.stored-video.v1.schema.json", result)
        technical = result["technical_envelope"]
        if result["identity"]["reel_id"] != saved_task["reel_id"] or technical["run_id"] != Path(prefix).name:
            raise ContractError("result run/reel identity mismatch")
        synthetic = identity["source_kind"] == "synthetic_bytes_not_video"
        digest_field = "synthetic_fixture_sha256" if synthetic else "source_video_sha256"
        if result["identity"][digest_field] != identity["sha256"] or technical["bundle_sha256"] != bundle["bundle_sha256"]:
            raise ContractError("result source/bundle identity mismatch")
        if result["identity"]["source_metadata_reference"] != (None if synthetic else identity["metadata_reference"]):
            raise ContractError("result metadata reference mismatch")
        if technical["versions"] != saved_task["versions"] or technical["requested_model"] != saved_task["cloud"]["model"]:
            raise ContractError("result versions/model mismatch")
        if result["analysis_state"] != ref["analysis_state"] or manifest["metadata"] != {
                "run_id": Path(prefix).name, "analysis_state": ref["analysis_state"],
                "bundle_sha256": bundle["bundle_sha256"]}:
            raise ContractError("result state/manifest mismatch")
        if "raw-response.bin" in names:
            if technical["raw_response_sha256"] != sha(self.artifacts.get(expected_prefix + "/raw-response.bin")):
                raise ContractError("raw response hash mismatch")
        elif technical["raw_response_sha256"] is not None:
            raise ContractError("unexpected raw response hash")
        if result["model_payload"] is not None:
            validate_payload(result["model_payload"], identity["duration"])
        return {"cached": True, "result": result, "artifact_prefix": expected_prefix}


    def _reconcile_artifacts(self, task):
        self.artifacts.assert_identity()
        self.journal.assert_identity()
        reel = task["reel_id"]
        root = confined(self.artifacts.root, reel)
        if not root.exists():
            return
        if root.is_symlink():
            raise ContractError("symlink artifact reel")
        versions = confined(self.artifacts.root, reel + "/versions")
        if not versions.exists():
            raise UncertainBlocked("artifact reel without version directory; no resend")
        for source in sorted(versions.iterdir()):
            if source.is_symlink() or not source.is_dir():
                raise ContractError("unexpected artifact source entry")
            for run in sorted(source.iterdir()):
                if run.is_symlink() or not run.is_dir():
                    raise ContractError("unexpected artifact run entry")
                prefix = reel + "/" + run.name
                # Reverse consistency is required: artifacts alone must never permit resend.
                try:
                    saved, old_identity, old_bundle = self._input(prefix)
                    prior = self._cached(prefix, saved, old_identity, old_bundle)
                except (OSError, ContractError) as exc:
                    raise UncertainBlocked("orphaned/inconsistent artifact version; no automatic resend") from exc
                expected = f"{reel}/versions/{old_identity['sha256']}/{run.name}"
                if str(run.relative_to(self.artifacts.root)) != expected:
                    raise ContractError("artifact source/run identity mismatch")

    def _lookup(self, task, identity, bundle):
        reel_root = confined(self.journal.root, task["reel_id"])
        if not reel_root.exists():
            return None
        cached = None
        for run in sorted(reel_root.iterdir()):
            if run.is_symlink() or not run.is_dir():
                raise ContractError("unexpected journal entry")
            prefix = task["reel_id"] + "/" + run.name
            # Verify seals BEFORE trusting source/version fields or skipping any run.
            saved_task, old_identity, old_bundle = self._input(prefix)
            finish_path = confined(self.journal.root, prefix + "/finish/manifest.json")
            if finish_path.exists():
                prior = self._cached(prefix, saved_task, old_identity, old_bundle)
            else:
                raise UncertainBlocked("unfinished journal; manual investigation, never automatic resend")
            if old_identity["sha256"] != identity["sha256"]:
                continue
            if prior["result"]["analysis_state"] == "uncertain":
                raise UncertainBlocked("uncertain source blocks all versions/reruns")
            if old_bundle["bundle_sha256"] == bundle["bundle_sha256"]:
                cached = prior
        return cached

    def transaction(self, task, data, duration, transport, executor_id, *, synthetic,
                    token="MOCK-NO-CREDENTIAL", metadata_reference=None, live_grant=None):
        if synthetic:
            if getattr(transport, "is_simulated_transport", False) is not True:
                raise authorization.AuthorizationDenied("mock requires an explicitly simulated transport")
        else:
            authorization.verify_live_grant(live_grant, task)
        check_task(task)
        if not isinstance(executor_id, str) or not executor_id.strip():
            raise ContractError("explicit executor identity required")
        digest = check_media(task, data, duration, synthetic)
        body = canonical(build_request(task, data))
        if len(body) > MAX_REQUEST_JSON_BYTES:
            raise ContractError("encoded JSON request exceeds local 68MB bound")
        identity = {"source_kind": "synthetic_bytes_not_video" if synthetic else "stored_video",
                    "sha256": digest, "duration": duration, "byte_count": len(data),
                    "metadata_reference": None if synthetic else metadata_reference}
        bundle = bundle_value(task, identity)
        locks = self.journal.root / "locks"
        locks.mkdir(exist_ok=True)
        lockpath = confined(self.journal.root, "locks/" + task["reel_id"] + ".lock")
        fd = os.open(lockpath, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) |
                     getattr(os, "O_NONBLOCK", 0), 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ContractError("nonregular journal lock")
        except BaseException:
            os.close(fd)
            raise
        with os.fdopen(fd, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.artifacts.assert_identity()
            self.journal.assert_identity()
            self._reconcile_artifacts(task)
            cached = self._lookup(task, identity, bundle)
            if cached:
                return cached
            run_id = str(uuid.uuid4())
            prefix = task["reel_id"] + "/" + run_id
            inp = prefix + "/input"
            self.journal.put_json(inp + "/task.json", task)
            self.journal.put_json(inp + "/identity.json", identity)
            self.journal.put_json(inp + "/bundle.json", bundle)
            self.journal.manifest(inp, ["task.json", "identity.json", "bundle.json"],
                                  {"run_id": run_id, "source_sha256": digest,
                                   "bundle_sha256": bundle["bundle_sha256"]})
            attempt = prefix + "/attempt"
            self.journal.put_json(attempt + "/intent.json", {
                "run_id": run_id, "bundle_sha256": bundle["bundle_sha256"],
                "maximum_inference_requests": 1, "attempt_reserved": True})
            self.journal.manifest(attempt, ["intent.json"], {"run_id": run_id})
            artifact_prefix = f"{task['reel_id']}/versions/{digest}/{run_id}"
            raw = None
            response_data = None
            payload = None
            error = None
            names = []
            # Last pre-send guard: no known destination/journal loss can precede spend.
            self.artifacts.assert_identity()
            self.journal.assert_identity()
            try:
                response = transport.send(endpoint(task), body, token)
            except AuthFailure:
                state, error = "failed", "authentication failure; no automatic resend"
            except Exception:
                state, error = "uncertain", "transport failure/timeout after reserved attempt; no resend"
            else:
                raw = response.body
                # Persist captured raw bytes before JSON parsing/normalization.
                try:
                    self.artifacts.put(artifact_prefix + "/raw-response.bin", raw)
                    self.artifacts.put_json(artifact_prefix + "/response-meta.json",
                                            {"http_status": response.status,
                                             "headers": response.headers,
                                             "truncated": response.truncated,
                                             "synthetic_transport": synthetic})
                    names += ["raw-response.bin", "response-meta.json"]
                except Exception as exc:
                    raise PersistenceUncertain("raw response persistence failed; attempt remains blocked") from exc
                try:
                    response_data, payload = normalize_response(response, duration)
                    state = "needs_review" if payload["quality"]["review_required"] else "completed"
                except Exception:
                    state = "uncertain" if response.truncated or response.status in (408, 429) or response.status >= 500 else "failed"
                    error = "response rejected; inspect preserved raw response; never automatic resend"
                    payload = None
            if raw is None:
                self.artifacts.put_json(artifact_prefix + "/transport-error.json",
                                        {"error": error, "attempt_reserved": True,
                                         "synthetic_transport": synthetic})
                names += ["transport-error.json"]
            result = make_result(task, identity, bundle["bundle_sha256"], run_id, executor_id,
                                 synthetic, state, payload, error, response_data, raw)
            self.artifacts.put_json(artifact_prefix + "/analysis.v1.json", result)
            names += ["analysis.v1.json"]
            self.artifacts.manifest(artifact_prefix, names, {
                "run_id": run_id, "analysis_state": state, "bundle_sha256": bundle["bundle_sha256"]})
            ref = {"artifact_prefix": artifact_prefix,
                   "manifest_sha256": sha(self.artifacts.get(artifact_prefix + "/manifest.json")),
                   "analysis_state": state, "bundle_sha256": bundle["bundle_sha256"]}
            self.journal.put_json(prefix + "/finish/reference.json", ref)
            self.journal.manifest(prefix + "/finish", ["reference.json"], {"run_id": run_id})
            verified = self._cached(prefix, task, identity, bundle)
            verified["cached"] = False
            return verified

class FixtureTransport:
    is_simulated_transport = True
    def __init__(self, response=None):
        self.response = response or Response(200, (ROOT / "fixtures/response.json").read_bytes())
        self.calls = 0
    def send(self, url, body, token):
        self.calls += 1
        if self.calls > 1:
            raise AssertionError("mock duplicate send")
        return self.response

def run_mock(task, *, executor_id, fixture_ref="fake-media.txt", transport=None, worker=None):
    check_task(task)
    path = confined(ROOT / "fixtures", fixture_ref)
    data = read_bytes(path)
    return (worker or Worker()).transaction(task, data, task["source"]["declared_duration_seconds"],
                                           transport or FixtureTransport(), executor_id, synthetic=True)

def validate_mp4_bytes(data):
    """Bounded structural admission, not a decoder or vendor codec-support proof."""
    if not 0 < len(data) <= MAX_MEDIA_BYTES:
        raise ContractError("MP4 bytes outside local guard")
    compatible = {b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6",
                  b"mp41", b"mp42", b"avc1"}
    containers = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf"}
    count = 0

    def boxes(start, end, depth=0):
        nonlocal count
        if depth > 16:
            raise ContractError("MP4 box nesting exceeds local guard")
        result = []
        while start < end:
            count += 1
            if count > 4096 or end - start < 8:
                raise ContractError("MP4 box count/header invalid")
            size = int.from_bytes(data[start:start + 4], "big")
            kind = data[start + 4:start + 8]
            header = 8
            if size == 1:
                if end - start < 16:
                    raise ContractError("truncated MP4 extended box header")
                size = int.from_bytes(data[start + 8:start + 16], "big")
                header = 16
            elif size == 0:
                # ISO BMFF permits a final box extending to EOF, not a child
                # escaping its parent. Limit this form to the final media data.
                if depth or kind != b"mdat":
                    raise ContractError("unsupported MP4 zero-sized box")
                size = end - start
            if size < header or size > end - start:
                raise ContractError("MP4 box bounds/truncation")
            payload, stop = start + header, start + size
            if kind == b"uuid" and size < header + 16:
                raise ContractError("truncated MP4 UUID box")
            if kind in containers:
                if payload == stop:
                    raise ContractError("empty MP4 container box")
                children = boxes(payload, stop, depth + 1)
                if kind == b"moov":
                    child_types = [child[0] for child in children]
                    if child_types.count(b"mvhd") != 1 or b"trak" not in child_types:
                        raise ContractError("MP4 moov requires movie header and track boxes")
            result.append((kind, payload, stop))
            start = stop
        return result

    top = boxes(0, len(data))
    types = [kind for kind, _, _ in top]
    if types.count(b"ftyp") != 1 or types.count(b"moov") != 1 or b"mdat" not in types:
        raise ContractError("MP4 requires one ftyp, one moov and media data")
    if types.index(b"ftyp") > types.index(b"moov") or types.index(b"ftyp") > types.index(b"mdat"):
        raise ContractError("MP4 ftyp must precede movie/media boxes")
    # This narrow pilot does not admit fragmented movies or unrelated formats.
    if any(kind not in {b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"uuid"}
           for kind in types):
        raise ContractError("unsupported MP4 top-level box")
    for kind, start, end in top:
        if kind == b"mdat" and start == end:
            raise ContractError("empty MP4 media data")
        if kind == b"ftyp":
            length = end - start
            if length < 8 or length > 1024 or (length - 8) % 4:
                raise ContractError("malformed MP4 ftyp brands")
            brands = {data[start:start + 4]}
            brands.update(data[pos:pos + 4] for pos in range(start + 8, end, 4))
            if b"qt  " in brands or not brands.intersection(compatible):
                raise ContractError("MP4-compatible brand required; QuickTime/unknown denied")


MEDIA_DIAGNOSTIC_PATH = "/etc/megabrain/reels-pilot/media-diagnostic.v1.json"
DIAGNOSTIC_MAX_SECONDS = 86400  # Local maximum remaining lifetime: 24 hours.


def load_media_diagnostic():
    """Root-installed exact-file diagnostic, never dispatch or spending authority.

    Strict v1 keys: version (integer 1), mode (single_diagnostic), campaign_id,
    owner_request_sha256, expires_at (UTC Z), task_id, reel_id,
    source_video_sha256, metadata_sha256, cloud (exact task object), and
    expected_probe (list of video/audio projections; see diagnostic_projection).
    Campaign/owner references are audit bindings, not substitutes for the signed
    grant and campaign queue. Install only after source inspection and preflight.
    No task/environment/metadata-supplied pathname is accepted.
    """
    if not hasattr(os, "O_PATH"):
        raise ContractError("secure diagnostic directory traversal unavailable")
    descriptors = []
    try:
        directory = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for name in (None, "etc", "megabrain", "reels-pilot"):
            if name is not None:
                directory = os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=directory)
                descriptors.append(directory)
            observed = os.fstat(directory)
            if (not stat.S_ISDIR(observed.st_mode) or observed.st_uid != 0
                    or observed.st_mode & 0o022):
                raise ContractError("untrusted diagnostic parent")
        name = Path(MEDIA_DIAGNOSTIC_PATH).name
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0
                    or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o640
                    or not 0 < before.st_size <= 16384):
                raise ContractError("untrusted diagnostic file")
            data, version = StoredMediaReader._snapshot(stream, 16384)
            after = os.fstat(stream.fileno())
            linked = os.stat(name, dir_fd=directory, follow_symlinks=False)
            def identity(value):
                return (StoredMediaReader._version(value), value.st_uid, value.st_gid, value.st_nlink)
            if (identity(before) != identity(after) or identity(after) != identity(linked)
                    or version != StoredMediaReader._version(before)):
                raise ContractError("diagnostic changed during load")
        return parse_json(data)
    except (OSError, ValueError) as exc:
        raise ContractError("missing/invalid/untrusted VP9 diagnostic record") from exc
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def diagnostic_projection(streams):
    """Narrow local VP9/AAC projection; not a claim of API codec support."""
    if not isinstance(streams, list) or len(streams) != 2:
        raise ContractError("diagnostic requires exactly one VP9 video and one AAC audio")
    fields = {
        "video": {"codec_type", "codec_name", "profile", "codec_tag_string", "pix_fmt",
                  "width", "height", "avg_frame_rate"},
        "audio": {"codec_type", "codec_name", "profile", "codec_tag_string", "sample_rate", "channels"},
    }
    projection = []
    for kind in ("video", "audio"):
        matches = [s for s in streams if isinstance(s, dict) and s.get("codec_type") == kind]
        if len(matches) != 1 or not fields[kind].issubset(matches[0]):
            raise ContractError("invalid diagnostic stream projection")
        item = {key: matches[0][key] for key in fields[kind]}
        if kind == "video":
            if (item["codec_name"], item["profile"], item["codec_tag_string"], item["pix_fmt"]) != (
                    "vp9", "Profile 0", "vp09", "yuv420p"):
                raise ContractError("unsupported diagnostic VP9 profile/tag/pixel format")
            for key in ("width", "height"):
                if type(item[key]) is not int or not 1 <= item[key] <= 4096:
                    raise ContractError("diagnostic dimensions outside local bound")
            from fractions import Fraction
            import re
            rate = item["avg_frame_rate"]
            if not isinstance(rate, str) or not re.fullmatch(r"[0-9]{1,9}/[0-9]{1,9}", rate):
                raise ContractError("invalid diagnostic frame rate")
            numerator, denominator = map(int, rate.split("/"))
            if not denominator or not 0 < Fraction(numerator, denominator) <= 120:
                raise ContractError("diagnostic frame rate outside local bound")
        else:
            if (item["codec_name"], item["codec_tag_string"]) != ("aac", "mp4a") or item["profile"] not in ("LC", "HE-AAC"):
                raise ContractError("unsupported diagnostic AAC profile/tag")
            if item["sample_rate"] not in ("8000", "11025", "12000", "16000", "22050", "24000", "32000", "44100", "48000"):
                raise ContractError("unsupported diagnostic sample rate")
            if type(item["channels"]) is not int or not 1 <= item["channels"] <= 2:
                raise ContractError("unsupported diagnostic channels")
        projection.append(item)
    return projection


def check_media_diagnostic(task, streams):
    import re
    try:
        record = load_media_diagnostic()
        keys = {"version", "mode", "campaign_id", "owner_request_sha256", "expires_at",
                "task_id", "reel_id", "source_video_sha256", "metadata_sha256", "cloud", "expected_probe"}
        if not isinstance(record, dict) or set(record) != keys:
            raise ContractError("invalid diagnostic keys")
        if type(record["version"]) is not int or record["version"] != 1 or record["mode"] != "single_diagnostic":
            raise ContractError("invalid diagnostic version/mode")
        for key in ("campaign_id", "task_id", "reel_id"):
            if not isinstance(record[key], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", record[key]):
                raise ContractError("invalid diagnostic identifier")
        for key in ("owner_request_sha256", "source_video_sha256", "metadata_sha256"):
            if not isinstance(record[key], str) or not re.fullmatch(r"[0-9a-f]{64}", record[key]):
                raise ContractError("invalid diagnostic digest")
        expiry = record["expires_at"]
        if not isinstance(expiry, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", expiry):
            raise ContractError("diagnostic expiry must be UTC Z")
        remaining = (dt.datetime.strptime(expiry, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
                     - dt.datetime.now(dt.timezone.utc)).total_seconds()
        if not 0 < remaining <= DIAGNOSTIC_MAX_SECONDS:
            raise ContractError("expired/unbounded diagnostic")
        for key in ("task_id", "reel_id", "cloud"):
            if record[key] != task[key]:
                raise ContractError("diagnostic task/cloud mismatch")
        for key in ("source_video_sha256", "metadata_sha256"):
            if record[key] != task["source"][key]:
                raise ContractError("diagnostic source/metadata mismatch")
        expected = record["expected_probe"]
        projection = diagnostic_projection(streams)
        if expected != diagnostic_projection(expected) or canonical(expected) != canonical(projection):
            raise ContractError("diagnostic exact probe mismatch")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise ContractError("VP9 compatibility unspecified; exact protected single diagnostic required (not API rejection)") from exc


class StoredMediaReader:
    """Prepared reader; exercised only on fake fixtures with subprocess stub."""
    def __init__(self, root, expected_identity):
        self.root = Path(root)
        self.guard = FileStore(root, expected_identity=expected_identity)

    @staticmethod
    def _version(observed):
        # Reads may update atime; only content/identity-relevant changes block.
        return (observed.st_dev, observed.st_ino, observed.st_mode, observed.st_size,
                observed.st_mtime_ns, observed.st_ctime_ns)

    @staticmethod
    def _snapshot(stream, limit):
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ContractError("stored file outside local byte/regular-file guard")
        stream.seek(0)
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if (StoredMediaReader._version(before) != StoredMediaReader._version(after)
                or len(data) != before.st_size or len(data) > limit):
            raise ContractError("stored file changed during bounded read")
        return data, StoredMediaReader._version(after)

    @classmethod
    def _bounded_read(cls, path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            return cls._snapshot(stream, limit)[0]

    def read(self, task):
        import subprocess
        check_task(task)
        expected_metadata = task["source"]["metadata_sha256"]
        if expected_metadata is None:
            raise ContractError("future stored-video read requires non-null metadata_sha256")
        self.guard.assert_identity()
        video = confined(self.root, task["source"]["relative_video_path"])
        metadata_path = confined(self.root, task["source"]["relative_metadata_path"])
        if not 0 < video.stat().st_size <= MAX_MEDIA_BYTES:
            raise ContractError("stored video outside local 50MB guard")
        if metadata_path.stat().st_size > 2_000_000:
            raise ContractError("metadata exceeds local 2MB parse guard")
        metadata_bytes = self._bounded_read(metadata_path, 2_000_000)
        metadata_digest = sha(metadata_bytes)
        if expected_metadata != metadata_digest:
            raise ContractError("stored metadata hash mismatch")
        metadata = parse_json(metadata_bytes)
        if not isinstance(metadata, dict) or metadata.get("id") != task["reel_id"]:
            raise ContractError("metadata Reel ID mismatch")
        declared = metadata.get("video")
        if not isinstance(declared, dict) or declared.get("file") != "video.mp4":
            raise ContractError("metadata video.file mismatch")
        self.guard.assert_identity()
        # No shell or retry. Real execution can reach here only after external grant.
        fd = os.open(video, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            data, before = self._snapshot(stream, MAX_MEDIA_BYTES)
            validate_mp4_bytes(data)
            # Pin ffprobe to the same open file, not a replaceable pathname.
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries",
                 "format=duration,format_name:stream=codec_type,codec_name,width,height",
                 "-show_entries", "stream=profile,codec_tag_string,pix_fmt,avg_frame_rate,sample_rate,channels",
                 "-of", "json", f"/proc/self/fd/{fd}"],
                pass_fds=(fd,), check=True, capture_output=True, timeout=15)
            after_data, after = self._snapshot(stream, MAX_MEDIA_BYTES)
            self.guard.assert_identity()
            if before != after or data != after_data or self._version(video.stat()) != after:
                raise ContractError("stored video substituted during probe")
        if self._bounded_read(metadata_path, 2_000_000) != metadata_bytes:
            raise ContractError("stored metadata substituted during probe")
        info = parse_json(probe.stdout)
        try:
            duration = float(info["format"]["duration"])
            format_names = set(info["format"]["format_name"].split(","))
            streams = info["streams"]
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ContractError("invalid media probe result") from exc
        ensure_finite(duration)
        if "mp4" not in format_names:
            raise ContractError("probe container is not MP4-compatible group")
        if not isinstance(streams, list) or any(not isinstance(item, dict) for item in streams):
            raise ContractError("invalid stream list")
        videos = [item for item in streams if item.get("codec_type") == "video"]
        audios = [item for item in streams if item.get("codec_type") == "audio"]
        if not videos or not audios:
            raise ContractError("stored video must contain both video and audio streams")
        diagnostic = any(item.get("codec_name") == "vp9" for item in videos)
        for item in videos:
            if item.get("codec_name") not in ("h264", "vp9"):
                raise ContractError("video codec outside evidenced local H264/AAC gate")
        if any(item.get("codec_name") != "aac" for item in audios):
            raise ContractError("audio codec outside evidenced local H264/AAC gate")
        primary_video, primary_audio = videos[0], audios[0]
        for dimension in ("width", "height"):
            observed = primary_video.get(dimension)
            if isinstance(observed, bool) or not isinstance(observed, int) or observed <= 0:
                raise ContractError("probe video dimensions unavailable/invalid")
        self.guard.assert_identity()
        digest = check_media(task, data, duration, False)
        # These are consistency checks, not declarations of Google codec support.
        numeric = {"size_bytes": len(data), "duration_seconds": duration,
                   "width": primary_video["width"], "height": primary_video["height"]}
        for key, observed in numeric.items():
            if key not in declared:
                continue
            value = declared[key]
            ensure_finite(value)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ContractError("invalid metadata numeric field: " + key)
            if key == "duration_seconds":
                if abs(value - observed) > 0.01:
                    raise ContractError("metadata duration divergence")
            elif value != observed:
                raise ContractError("metadata numeric divergence: " + key)
        if "sha256" in declared and declared["sha256"] != digest:
            raise ContractError("metadata video SHA divergence")
        if "container" in declared and declared["container"] not in ("mp4", "mov"):
            raise ContractError("metadata container divergence")
        for key in ("mime_type", "mime", "mimeType"):
            if key in declared and declared[key] != "video/mp4":
                raise ContractError("metadata MIME divergence: " + key)
        if "has_audio" in declared and declared["has_audio"] is not True:
            raise ContractError("metadata has_audio divergence")
        for key, stream in (("video_codec", primary_video), ("audio_codec", primary_audio)):
            if key in declared:
                value = declared[key]
                codec = stream.get("codec_name")
                if not isinstance(value, str) or not isinstance(codec, str) or value.lower() != codec.lower():
                    raise ContractError("metadata/probe codec divergence: " + key)
        if diagnostic:
            # All physical hash/size/duration, metadata and pinned-FD gates above
            # precede this MEDIA READ exception. No new dispatch path exists.
            check_media_diagnostic(task, streams)
        return data, duration, {"relative_path": task["source"]["relative_metadata_path"],
                                "sha256": metadata_digest}

def execute_live(task, *, executor_id):
    """Prepared future path. CURRENT require_live_grant ALWAYS raises before any access."""
    check_task(task)
    grant = authorization.require_live_grant(task)
    if task["cloud"]["project_id"] != grant.approved_project:
        raise AuthFailure("task project does not match externally approved project")
    # No caller JSON can construct/replace the installed external grant above.
    token_source = GoogleOfficialTokenSource(
        grant.approved_service_account, grant.approved_project, grant.approved_adc_path)
    data, duration, metadata = StoredMediaReader(grant.approved_media_root, grant.approved_media_identity).read(task)
    token = token_source.token()
    worker = Worker(artifact_root=grant.approved_artifact_root,
                    coordination_root=ROOT / "outputs/local-live-journal",
                    artifact_identity=grant.approved_artifact_identity)
    return worker.transaction(task, data, duration, SingleHTTPTransport(), executor_id,
                              synthetic=False, token=token, metadata_reference=metadata, live_grant=grant)

def main():
    parser = argparse.ArgumentParser(description="Sprint2B preparation/mock only. Real execution denied.")
    parser.add_argument("command", choices=["prepare", "mock"])
    parser.add_argument("task")
    parser.add_argument("--executor-id", required=True)
    args = parser.parse_args()
    try:
        task = parse_json(Path(args.task).read_bytes())
        value = prepare(task) if args.command == "prepare" else run_mock(task, executor_id=args.executor_id)
        print(canonical(value).decode())
    except (ContractError, PermissionError, UncertainBlocked, PersistenceUncertain, OSError) as exc:
        parser.exit(2, "Blocked: " + str(exc) + "\n")

if __name__ == "__main__":
    main()
