"""Externally approved one-call A+B pipeline. CLI reads only a fixed root policy.

The legacy preparation task is retained as a declaration, not as authority.
No task field, environment variable or simulation flag can authorize live I/O.
"""
import argparse
import base64
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
LIVE = HERE.parent / "reels-analysis-live"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LIVE))
from common import ContractError, canonical, parse_json, sha, validate
from jsonschema import Draft202012Validator, FormatChecker
from storage import FileStore, confined, read_bytes
from cloud_adapter import endpoint, Response, GoogleOfficialTokenSource
import provider
import governance
import approval
import api_token
from ledger import Ledger, LedgerDenied

_spec = importlib.util.spec_from_file_location("legacy_transaction", LIVE / "worker.py")
legacy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(legacy)

POLICY_PATH = Path("/etc/megabrain/reels-pilot/policy.json")
POLICY_VERSION = "one-call-pilot-1"
ROOT_NAMES = ("media_root", "result_root", "ledger_root")
POLICY_KEYS = {"policy_version", "target", "roots", "public_key", "ledger_path",
               "adc_path", "ledger_identity", "gross_ceiling", "currency", "runtime_identity",
               "version_pins", "input_state_revision"}
_DIGEST = __import__("re").compile(r"[0-9a-f]{64}")


def root_owned(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute():
        raise ContractError("absolute trusted path required")
    for item in [path] + list(path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ContractError("trusted code/policy/key ancestor writable or non-root owned")
    if directory != path.is_dir():
        raise ContractError("trusted path type")


def root_binding(path):
    path = Path(path).absolute()
    info = path.stat()
    return {"root_id": str(path), "filesystem_id": str(info.st_dev),
            "object_id": str(info.st_ino), "owner": "uid:" + str(info.st_uid),
            "mode": format(stat.S_IMODE(info.st_mode), "04o")}


def version_pins():
    names = [
        "reels-pilot/worker.py", "reels-pilot/recurrence.py", "reels-pilot/provider.py", "reels-pilot/governance.py", "reels-pilot/approval.py",
        "reels-pilot/ledger.py", "reels-pilot/api_token.py", "reels-pilot/contracts/grant.v1.schema.json",
        "reels-pilot/contracts/analysis.pilot.v1.schema.json",
        "reels-analysis-live/worker.py", "reels-analysis-live/common.py",
        "reels-analysis-live/storage.py", "reels-analysis-live/cloud_adapter.py",
        "reels-analysis-live/semantic_payload.py", "reels-analysis-live/authorization.py",
        "reels-analysis-live/contracts/stored-video-task.v1.schema.json",
        "reels-analysis-live/contracts/analysis.stored-video.v1.schema.json",
        "reels-analysis-live/contracts/model-payload.v1.schema.json",
        "reels-analysis-live/prompts/stored-multimodal.v1.txt",
        "reels-analysis-live/taxonomy.draft.v1.json",
        "reels-analysis-live/requirements.lock.txt",
    ]
    return {name: sha((HERE.parent / name).read_bytes()) for name in names}


def load_policy():
    root_owned(POLICY_PATH)
    if POLICY_PATH.stat().st_size > 100000:
        raise ContractError("policy size")
    value = parse_json(read_bytes(POLICY_PATH))
    validate_policy(value, real=True)
    return value


def validate_policy(policy, *, real):
    if not isinstance(policy, dict) or set(policy) not in (POLICY_KEYS, POLICY_KEYS | {"authentication"}):
        raise ContractError("trusted policy shape")
    if policy["policy_version"] != POLICY_VERSION:
        raise ContractError("trusted policy version")
    if policy["runtime_identity"] != "uid:%d/gid:%d" % (os.getuid(), os.getgid()):
        raise ContractError("runtime identity differs from policy")
    if real and os.getuid() == 0:
        raise ContractError("live worker must not run as signer/root")
    if policy["target"].get("model") != "gemini-3.8-flash" or policy["target"].get("location") != "global":
        raise ContractError("installed model/location allowlist")
    if set(policy["target"]) != {"project", "service_account", "model", "location"}:
        raise ContractError("target shape")
    if set(policy["roots"]) != set(ROOT_NAMES):
        raise ContractError("approved roots")
    for key in ROOT_NAMES:
        binding = policy["roots"][key]
        if not isinstance(binding, dict) or set(binding) != {"root_id", "filesystem_id", "object_id", "owner", "mode"}:
            raise ContractError("root identity shape")
        path = Path(binding["root_id"])
        if not path.is_absolute() or path.is_symlink() or root_binding(path) != binding:
            raise ContractError("approved root unavailable or replaced")
        FileStore(path, expected_identity={"device": int(binding["filesystem_id"]),
                                          "inode": int(binding["object_id"])})
    ledger = Path(policy["ledger_path"])
    if ledger.parent != Path(policy["roots"]["ledger_root"]["root_id"]) or ledger.name != "attempts.sqlite3":
        raise ContractError("ledger must be fixed inside approved root")
    if policy["currency"] not in ("USD", "BRL"):
        raise ContractError("currency")
    if real:
        root_owned(policy["public_key"])
        for name in policy["version_pins"]:
            root_owned(HERE.parent / name)
    if policy["version_pins"] != version_pins():
        raise ContractError("installed code differs from root policy pins")
    if type(policy["input_state_revision"]) is not int or policy["input_state_revision"] < 20:
        raise ContractError("state revision")
    if "authentication" in policy:
        api_token.validate_descriptor(policy["authentication"], policy["target"])


def observed_bindings(policy, task):
    target = policy["target"]
    if task["cloud"] != {"project_id": target["project"], "model": target["model"],
                         "location": target["location"], "api_version": "v1beta1"}:
        raise ContractError("task target differs from root policy")
    pins = policy["version_pins"]
    worker_binding = ({"version_pins": pins, "authentication": policy["authentication"]}
                      if "authentication" in policy else pins)
    return {"media": {"id": task["reel_id"], "sha256": task["source"]["source_video_sha256"],
                      "digest_verified": True},
            "target": copy.deepcopy(target),
            "artifacts": {
                "worker": {"version": "reels-pilot.v1", "sha256": sha(canonical(worker_binding))},
                "prompt": {"version": "stored-multimodal.v1",
                           "sha256": pins["reels-analysis-live/prompts/stored-multimodal.v1.txt"]},
                "schema": {"version": "analysis.v1/stored_video.v1",
                           "sha256": pins["reels-pilot/contracts/analysis.pilot.v1.schema.json"]}},
            "filesystem": dict(copy.deepcopy(policy["roots"]),
                               runtime_identity=policy["runtime_identity"]),
            "policy_version": POLICY_VERSION}


def check_manifest(value):
    if not isinstance(value, dict) or set(value) != {"manifest_version", "task", "request_sha256"}:
        raise ContractError("run manifest shape")
    if value["manifest_version"] not in ("reels-pilot-run.v1", "reels-pilot-run.v2") or not _DIGEST.fullmatch(str(value["request_sha256"])):
        raise ContractError("run manifest version/request hash")
    legacy.check_task(value["task"])
    return value


def token_source(policy):
    target = policy["target"]
    if "authentication" in policy:
        return api_token.TemporaryTokenSource(policy["authentication"], target)
    return GoogleOfficialTokenSource(target["service_account"], target["project"], policy["adc_path"])


class Pipeline:
    def __init__(self, policy, *, synthetic=False, transport=None, auth=None, writer_hook=None):
        validate_policy(policy, real=not synthetic)
        self.policy = copy.deepcopy(policy)
        self.synthetic = synthetic
        if synthetic:
            if transport is None or getattr(transport, "is_simulated_transport", False) is not True:
                raise ContractError("synthetic pipeline requires fake provider")
            self.transport = transport
            self.auth = lambda: "SYNTHETIC-NO-GOOGLE-CREDENTIAL"
        else:
            if transport is not None or auth is not None:
                raise ContractError("real transport/auth injection forbidden")
            # Recovery must not construct authentication or provider clients.
            self.transport = None
            self.auth = None
        self.ledger = Ledger(policy["ledger_path"], expected_identity=policy["ledger_identity"])
        binding = policy["roots"]["result_root"]
        self.store = FileStore(binding["root_id"], hook=writer_hook,
                               expected_identity={"device": int(binding["filesystem_id"]),
                                                  "inode": int(binding["object_id"])})

    def _verify(self, manifest, envelope, now, *, recovery_record=None):
        task = manifest["task"]
        bindings = observed_bindings(self.policy, task)
        if recovery_record is not None:
            # Historical code/auth pins are evidence, not permission for new IO.
            bindings["artifacts"] = recovery_record["grant"]["bindings"]["artifacts"]
        verified = approval.verify_grant(
            envelope, trusted_public_key=Path(self.policy["public_key"]),
            observed_bindings=bindings, now=now,
            gross_ceiling=self.policy["gross_ceiling"], currency=self.policy["currency"],
            request_sha256=manifest["request_sha256"],
            manifest_sha256=sha(approval.canonical(manifest)))
        if (recovery_record is None and "authentication" in self.policy and
                self.policy["authentication"]["grant_reference"] != verified.grant_id):
            raise approval.ApprovalDenied("authentication grant reference differs")
        return verified

    def _source(self, task):
        binding = self.policy["roots"]["media_root"]
        if self.synthetic:
            root = Path(binding["root_id"])
            video = confined(root, task["source"]["relative_video_path"])
            meta = confined(root, task["source"]["relative_metadata_path"])
            data = read_bytes(video)
            if not data.startswith(b"SYNTHETIC TEST BYTES."):
                raise ContractError("only explicit synthetic fixture in rehearsal")
            if sha(read_bytes(meta)) != task["source"]["metadata_sha256"]:
                raise ContractError("synthetic metadata mismatch")
            duration = task["source"]["declared_duration_seconds"]
            legacy.check_media(task, data, duration, True)
            return data, duration, None
        if task["source"]["declared_bytes"] > provider.MAX_MEDIA_BYTES:
            raise ContractError("pilot media byte limit")
        # Existing reader confines paths, validates real SHA/metadata and bounded ffprobe.
        reader = legacy.StoredMediaReader(binding["root_id"], {
            "device": int(binding["filesystem_id"]), "inode": int(binding["object_id"])})
        return reader.read(task)

    def run(self, manifest, envelope, *, executor_id):
        check_manifest(manifest)
        if not isinstance(executor_id, str) or not executor_id.strip() or len(executor_id) > 200:
            raise ContractError("explicit bounded executor identity required")
        validate_policy(self.policy, real=not self.synthetic)
        self._select_attempt(envelope)
        digest = manifest["task"]["source"]["source_video_sha256"]
        try:
            self.ledger.get(digest)
        except LedgerDenied as exc:
            if str(exc) != "reservation required":
                raise
        else:
            return self.recover(manifest, envelope, executor_id=executor_id)
        now = dt.datetime.now(dt.timezone.utc)
        verified = self._verify(manifest, envelope, now)  # Before any media read/probe.
        if not self.synthetic:
            # NEW dispatch only: fail closed before media/reservation, but keep
            # the one-use token byte read after the durable UNKNOWN transition.
            self.auth = token_source(self.policy).token
            self.transport = provider.DirectTransport()
        data, duration, metadata = self._source(manifest["task"])
        body = provider.request_bytes(manifest["task"], data)
        if sha(body) != manifest["request_sha256"]:
            raise ContractError("actual request differs from signed grant")
        verified = self._verify(manifest, envelope, dt.datetime.now(dt.timezone.utc))
        run_id = str(uuid.uuid4())
        self.store.assert_identity()
        self.ledger.reserve(verified, run_id=run_id)  # Atomic reservation before all network.
        self.ledger.begin_dispatch(digest, now=dt.datetime.now(dt.timezone.utc))
        try:
            token = provider.bounded_auth_token(self.auth)
            self._verify(manifest, envelope, dt.datetime.now(dt.timezone.utc))
            response = self.transport.send(endpoint(manifest["task"]), body, token)
        except Exception:
            # UNKNOWN was committed before any network, including OAuth/IAM.
            # No retry, no fallback, no automatic refund, no lease-based rearm.
            return {"state": "UNKNOWN", "source_sha256": digest, "retry_allowed": False}
        capture = {"http_status": response.status,
                   "body_base64": base64.b64encode(response.body).decode("ascii"),
                   "headers": response.headers, "truncated": response.truncated,
                   "received_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "executor_id": executor_id}
        self.ledger.receive(digest, canonical(capture))
        return self._persist(manifest, envelope, executor_id=executor_id)

    def recover(self, manifest, envelope, *, executor_id):
        """Persistence-only recovery. This method never reads source or calls auth/provider."""
        check_manifest(manifest)
        validate_policy(self.policy, real=not self.synthetic)
        self._select_attempt(envelope)
        digest = manifest["task"]["source"]["source_video_sha256"]
        record = self.ledger.get(digest)
        if record is None:
            raise ContractError("no durable attempt to recover")
        stamp = dt.datetime.fromisoformat(record["reserved_at"].replace("Z", "+00:00"))
        self._verify(manifest, envelope, stamp, recovery_record=record)
        if record["grant"] != envelope["grant"]:
            raise ContractError("recovery requires exact durable grant")
        if record["request_sha256"] != manifest["request_sha256"] or record["grant_id"] != envelope["grant"]["grant_id"]:
            raise ContractError("recovery identity differs from durable record")
        if record["state"] in ("RESERVED", "UNKNOWN"):
            return {"state": record["state"], "source_sha256": digest, "retry_allowed": False}
        return self._persist(manifest, envelope, executor_id=executor_id)

    def _select_attempt(self, envelope):
        grant = envelope.get("grant", {})
        self.ledger = self.ledger.select(grant.get("grant_id") if "successor" in grant else None)

    def _put_exact(self, relative, data):
        path = confined(self.store.root, relative)
        if path.exists():
            if self.store.get(relative) != data:
                raise ContractError("existing immutable result differs")
        else:
            self.store.put(relative, data)

    def _latest(self, reel_id, data):
        # Convenience copy only; immutable verified version+manifest is authoritative.
        directory = confined(self.store.root, reel_id)
        self.store.assert_identity()
        fd, temporary = tempfile.mkstemp(prefix=".analysis-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            target = confined(self.store.root, reel_id + "/analysis.v1.json")
            os.replace(temporary, target)
            self.store._directory_sync(directory)
            self.store.assert_identity()
            if read_bytes(target) != data:
                raise ContractError("latest result readback differs")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _persist(self, manifest, envelope, *, executor_id):
        task = manifest["task"]
        digest = task["source"]["source_video_sha256"]
        record = self.ledger.get(digest)
        capture = parse_json(self.ledger.recover_response(digest))
        if record["state"] == "PERSISTED":
            refs = record["refs"]
            prefix = refs["artifact_prefix"]
            self.store.verify(prefix)
            if sha(self.store.get(prefix + "/manifest.json")) != refs["manifest_sha256"]:
                raise ContractError("durable persistence references differ")
            return {"state": "PERSISTED", "analysis_state": refs["analysis_state"],
                    "artifact_prefix": prefix, "source_sha256": digest, "retry_allowed": False}
        raw = base64.b64decode(capture["body_base64"], validate=True)
        separate = manifest["manifest_version"] == "reels-pilot-run.v2"
        response = Response(capture["http_status"], raw, capture["headers"], capture["truncated"])
        outer = payload = None
        error = None
        try:
            outer, payload = provider.parse_response(
                response, duration=task["source"]["declared_duration_seconds"], synthetic=self.synthetic,
                governance_separate=separate)
            state = "needs_review"  # Draft taxonomy is deliberately not silently approved.
        except Exception:
            state = "uncertain" if response.truncated or response.status in (408, 429) or response.status >= 500 else "failed"
            error = "Provider response rejected; inspect preserved response; no automatic resend."
        identity = {"source_kind": "synthetic_bytes_not_video" if self.synthetic else "stored_video",
                    "sha256": digest, "duration": task["source"]["declared_duration_seconds"],
                    "byte_count": task["source"]["declared_bytes"],
                    "metadata_reference": None if self.synthetic else {
                        "relative_path": task["source"]["relative_metadata_path"],
                        "sha256": task["source"]["metadata_sha256"]}}
        bundle = sha(canonical({"manifest": manifest, "pins": self.policy["version_pins"]}))
        def render(artifact_run_id):
            result = legacy.make_result(task, identity, bundle, artifact_run_id,
                                        capture["executor_id"], self.synthetic,
                                        state, payload, error, outer, raw)
            result["technical_envelope"]["processing_utc"] = capture["received_at"]
            result["technical_envelope"]["input_state_revision"] = self.policy["input_state_revision"]
            result["technical_envelope"]["implementation_identity"] = "reels-pilot.v1"
            Draft202012Validator(parse_json((HERE / "contracts/analysis.pilot.v1.schema.json").read_bytes()),
                                 format_checker=FormatChecker()).validate(result)
            prefix = task["reel_id"] + "/versions/" + digest + "/" + artifact_run_id
            provenance = {"provenance_version": "reels-pilot.v1", "source_sha256": digest,
                          "metadata_sha256": task["source"]["metadata_sha256"],
                          "request_sha256": manifest["request_sha256"],
                          "grant_id": envelope["grant"]["grant_id"],
                          "grant_envelope_sha256": sha(canonical(envelope)),
                          "manifest_sha256": sha(approval.canonical(manifest)),
                          "attempt_run_id": record["run_id"], "artifact_run_id": artifact_run_id,
                          "policy_version": POLICY_VERSION, "version_pins": self.policy["version_pins"],
                          "usage_metadata": outer.get("usageMetadata") if outer else None,
                          "gross_cost": None, "currency": self.policy["currency"],
                          "cost_status": "unmeasured; token metadata is not a billing receipt",
                          "synthetic": self.synthetic, "retry_allowed": False}
            files = {"analysis.v1.json": canonical(result) + b"\n",
                     "provenance.json": canonical(provenance) + b"\n", "raw-response.bin": raw,
                     "response-meta.json": canonical({k: v for k, v in capture.items() if k != "body_base64"}) + b"\n"}
            if separate and payload is not None:
                files["governance.v1.json"] = canonical(governance.evaluate(
                    payload, task["source"]["declared_duration_seconds"])) + b"\n"
                files["presentation.pt-BR.json"] = canonical(governance.build_presentation(
                    payload, sha(canonical(payload)))) + b"\n"
            metadata = {"run_id": artifact_run_id, "analysis_state": state, "bundle_sha256": bundle}
            return prefix, files, metadata
        artifact_run_id = record["persistence_run_id"]
        prefix, files, metadata = render(artifact_run_id)
        try:
            partial = any(confined(self.store.root, prefix + "/" + name).exists()
                          and self.store.get(prefix + "/" + name) != data
                          for name, data in files.items())
            committed = confined(self.store.root, prefix + "/manifest.json")
            if committed.exists():
                try:
                    seal = self.store.verify(prefix)
                    partial = partial or seal["metadata"] != metadata or seal["files_sha256"] != {name: sha(data) for name, data in files.items()}
                except Exception:
                    partial = True
            if partial:
                artifact_run_id = self.ledger.begin_persistence_recovery(
                    digest, previous_run_id=artifact_run_id,
                    reason="Immutable partial/corrupt version preserved; write new recovery version without provider")
                prefix, files, metadata = render(artifact_run_id)
                committed = confined(self.store.root, prefix + "/manifest.json")
            for name, data in files.items():
                self._put_exact(prefix + "/" + name, data)
            if committed.exists():
                seal = self.store.verify(prefix)
                if seal["metadata"] != metadata or seal["files_sha256"] != {name: sha(data) for name, data in files.items()}:
                    raise ContractError("committed result differs")
            else:
                self.store.manifest(prefix, list(files), metadata)
            self._latest(task["reel_id"], files["analysis.v1.json"])
            refs = {"artifact_prefix": prefix,
                    "manifest_sha256": sha(self.store.get(prefix + "/manifest.json")),
                    "analysis_state": state}
            if record["state"] == "PERSISTED":
                if record["refs"] != refs:
                    raise ContractError("durable persistence references differ")
            else:
                self.ledger.mark_persisted(digest, refs, persistence_run_id=artifact_run_id)
        except Exception as exc:
            if record["state"] != "PERSISTED":
                self.ledger.mark_persistence_uncertain(digest, type(exc).__name__)
            raise
        return {"state": "PERSISTED", "analysis_state": state, "artifact_prefix": prefix,
                "source_sha256": digest, "retry_allowed": False}


def main():
    parser = argparse.ArgumentParser(description="Externally signed one-call Reels pilot; fixed root policy.")
    parser.add_argument("command", choices=("run", "recover"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("grant", type=Path)
    parser.add_argument("--executor-id", required=True)
    args = parser.parse_args()
    try:
        policy = load_policy()
        if args.manifest.stat().st_size > 100000 or args.grant.stat().st_size > 100000:
            raise ContractError("manifest/grant size")
        manifest = parse_json(read_bytes(args.manifest))
        envelope = parse_json(read_bytes(args.grant))
        pipeline = Pipeline(policy)
        result = getattr(pipeline, args.command)(manifest, envelope, executor_id=args.executor_id)
        print(canonical(result).decode())
    except Exception as exc:
        # No credential, media, provider text or private path dump in CLI errors.
        print(canonical({"status": "STOPPED", "error_type": type(exc).__name__,
                         "retry_allowed": False}).decode())
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
