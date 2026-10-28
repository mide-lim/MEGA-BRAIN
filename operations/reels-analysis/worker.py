"""Isolated offline synthetic contract worker. No network/provider SDK imports."""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import uuid
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
OUTPUTS = ROOT / "outputs"
SENTINEL = b"SYNTHETIC TEST BYTES."
STATES = ("pending", "processing", "completed", "failed", "needs_review", "uncertain")


class ContractError(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def schema(name):
    return parse_json((ROOT / "contracts" / name).read_text())


def validate(name, value):
    ensure_finite(value)
    validator = Draft202012Validator(schema(name), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(value), key=lambda e: str(list(e.path)))
    if errors:
        err = errors[0]
        raise ContractError(f"{name} {list(err.path)}: {err.message}")


def safe_file(base, ref):
    """Reject absolute paths, traversal, symlinks and nonregular fixture files."""
    if not isinstance(ref, str) or not ref:
        raise ContractError("empty fixture reference")
    rel = Path(ref)
    if rel.is_absolute() or ".." in rel.parts or "\\" in ref or ":" in ref:
        raise ContractError("fixture path escape")
    base = base.absolute()
    current = base
    if current.is_symlink():
        raise ContractError("symlink base")
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise ContractError("symlink fixture")
    resolved = current.resolve(strict=True)
    if not resolved.is_relative_to(base.resolve()) or not resolved.is_file():
        raise ContractError("fixture outside allowed root")
    return resolved


def read_regular(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ContractError("nonregular source")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def validate_payload(payload, duration):
    validate("model-payload.v1.schema.json", payload)
    quality = payload["quality"]
    if payload["A"]["primary_category"] == "other_uncertain":
        if not quality["review_required"] or not quality["review_reasons"]:
            raise ContractError("other_uncertain requires reason and review")
    if quality["review_required"] and not quality["review_reasons"]:
        raise ContractError("review_required requires review reasons")
    ev = payload["B"]["evidence"]
    ids = [e["evidence_id"] for e in ev]
    if len(ids) != len(set(ids)):
        raise ContractError("duplicate evidence ID")
    for item in ev:
        stamp = item.get("timestamp")
        if stamp is not None:
            start, end = stamp["start_seconds"], stamp["end_seconds"]
            if start is not None and end is not None and start > end:
                raise ContractError("timestamp start exceeds end")
            if duration is not None and any(v is not None and v > duration for v in (start, end)):
                raise ContractError("timestamp exceeds duration")
    refs = list(payload["A"]["entities"])
    for key in ("insights", "audio", "visual", "screen_text", "connections"):
        refs.extend(payload["B"][key])
    for item in refs:
        if not item["evidence_ids"] or not set(item["evidence_ids"]).issubset(ids):
            raise ContractError("claim/entity requires known evidence IDs")
    # Taxonomy is unapproved; all results remain reviewable in this release.
    if not quality["review_required"]:
        raise ContractError("draft taxonomy requires review")


class Provider:
    """Future interface. No real implementation can be enabled by task JSON."""
    def execute(self, task, payload_bytes):
        raise PermissionError("real provider unavailable: offline-only implementation")


class MockProvider(Provider):
    def execute(self, task, payload_bytes):
        mode = task["provider_mode"]
        if mode != "mock":
            raise PermissionError("real provider permanently denied in this module")
        scenario = task["mock_scenario"]
        if scenario == "authorization_failure":
            raise PermissionError("simulated authorization denial before execution")
        if scenario == "provider_failure":
            raise RuntimeError("simulated mock provider failure; zero external calls")
        if scenario == "timeout":
            raise TimeoutError("simulated ambiguous timeout; do not replay")
        if scenario == "missing_result":
            return None
        return parse_json(payload_bytes)



def metadata_reference(task, *, verify=False):
    ref = task.get("source_metadata_reference")
    if ref is None:
        return None
    if verify:
        path = safe_file(FIXTURES, ref["ref"])
        data = read_regular(path)
        if sha(data) != ref["expected_sha256"]:
            raise ContractError("synthetic metadata fixture hash mismatch")
        value = parse_json(data)
        if not isinstance(value, dict) or value.get("synthetic") is not True:
            raise ContractError("only explicitly synthetic metadata fixtures are accepted")
    return {"kind": "synthetic_metadata_fixture", "ref": "fixtures/" + ref["ref"],
            "sha256": ref["expected_sha256"]}


def check_task(task):
    if not isinstance(task, dict) or task.get("provider_mode") != "mock":
        raise PermissionError("offline worker denies every real provider")
    validate("analysis-task.v1.schema.json", task)
    metadata = metadata_reference(task, verify=True)
    source = safe_file(FIXTURES, task["source"]["ref"])
    raw = read_regular(source)
    if not raw.startswith(SENTINEL):
        raise ContractError("only explicit synthetic test bytes accepted; media forbidden")
    digest = sha(raw)
    if digest != task["source"]["expected_sha256"]:
        raise ContractError("source hash mismatch")
    payload_file = safe_file(FIXTURES, task["payload_fixture"])
    payload_bytes = read_regular(payload_file)
    files = ["contracts/analysis.v1.schema.json", "contracts/model-payload.v1.schema.json",
             "contracts/analysis-task.v1.schema.json", "prompts/multimodal.v1.txt",
             "taxonomy.draft.v1.json", "worker.py"]
    hashes = {f: sha((ROOT / f).read_bytes()) for f in files}
    bundle = sha(canonical({"reel_id": task["reel_id"], "source_sha256": digest,
                            "versions": task["versions"], "files": hashes,
                            "source_metadata_reference": metadata}))
    return raw, digest, payload_bytes, bundle, hashes


def ensure_dir(path):
    """Only writes within this module's outputs, with no symlink components."""
    if OUTPUTS.is_symlink():
        raise ContractError("symlink output root")
    path = path.absolute()
    if not path.is_relative_to(OUTPUTS.absolute()):
        raise ContractError("output path escape")
    current = ROOT
    for part in path.relative_to(ROOT).parts:
        current = current / part
        if current.is_symlink():
            raise ContractError("symlink output component")
        current.mkdir(exist_ok=True)
    return path


def write_json(path, data):
    if path.exists():
        raise ContractError("refuse overwrite immutable artifact")
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(canonical(data) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    # Link is atomic and fails if target exists. Never replace an original result.
    os.link(temp, path)
    temp.unlink()



def ensure_finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ContractError("non-finite number is not valid interoperable JSON")
    if isinstance(value, dict):
        for item in value.values():
            ensure_finite(item)
    elif isinstance(value, list):
        for item in value:
            ensure_finite(item)


def parse_json(raw):
    def reject_constant(value):
        raise ContractError(f"non-standard JSON constant denied: {value}")
    value = json.loads(raw, parse_constant=reject_constant)
    ensure_finite(value)
    return value



def publish_input_integrity(own, task, digest, bundle):
    names = ("task.json", "bundle.json", "00-pending.json", "01-processing.json")
    receipt = {
        "receipt_version": "input-integrity.v1", "run_id": own.name,
        "source_sha256": digest, "bundle_sha256": bundle, "reel_id": task["reel_id"],
        "files_sha256": {name: sha(read_regular(own / name)) for name in names}}
    write_json(own / "input-integrity.json", receipt)


def verify_input_integrity(own):
    path = own / "input-integrity.json"
    if not path.exists():
        raise ContractError("uncommitted processing input: no automatic replay or reconstruction")
    receipt = parse_json(read_regular(path))
    expected_keys = {"receipt_version", "run_id", "source_sha256", "bundle_sha256",
                     "reel_id", "files_sha256"}
    if not isinstance(receipt, dict) or set(receipt) != expected_keys:
        raise ContractError("invalid input-integrity receipt shape")
    if receipt["receipt_version"] != "input-integrity.v1" or receipt["run_id"] != own.name:
        raise ContractError("invalid input-integrity receipt identity")
    names = ("task.json", "bundle.json", "00-pending.json", "01-processing.json")
    if not isinstance(receipt["files_sha256"], dict) or set(receipt["files_sha256"]) != set(names):
        raise ContractError("input-integrity artifact set mismatch")
    for name in names:
        path = own / name
        if not path.exists() or receipt["files_sha256"][name] != sha(read_regular(path)):
            raise ContractError(f"input artifact integrity mismatch: {name}")
    saved = parse_json(read_regular(own / "task.json"))
    validate("analysis-task.v1.schema.json", saved)
    saved_bundle = parse_json(read_regular(own / "bundle.json"))
    if saved["source"]["expected_sha256"] != receipt["source_sha256"]:
        raise ContractError("input source identity mismatch")
    if saved["reel_id"] != receipt["reel_id"]:
        raise ContractError("input reel identity mismatch")
    if saved_bundle.get("source_metadata_reference") != metadata_reference(saved):
        raise ContractError("input metadata reference mismatch")
    if saved_bundle["synthetic_fixture_sha256"] != receipt["source_sha256"]:
        raise ContractError("input bundle source mismatch")
    if saved_bundle["bundle_sha256"] != receipt["bundle_sha256"] or own.parent.parent.name != receipt["bundle_sha256"]:
        raise ContractError("input bundle identity mismatch")
    calculated = sha(canonical({"reel_id": saved["reel_id"],
                               "source_sha256": receipt["source_sha256"],
                               "versions": saved["versions"], "files": saved_bundle["files"],
                               "source_metadata_reference": metadata_reference(saved)}))
    if calculated != receipt["bundle_sha256"]:
        raise ContractError("input bundle configuration hash mismatch")
    for name, state in (("00-pending.json", "pending"), ("01-processing.json", "processing")):
        value = parse_json(read_regular(own / name))
        validate_result(value, saved, receipt["source_sha256"], receipt["bundle_sha256"],
                        saved["source"]["duration_seconds"])
        if value["analysis_state"] != state or value["technical_envelope"]["run_id"] != own.name:
            raise ContractError("input transition mismatch")
    return saved


def artifact_files(own):
    names = ["result.json", "task.json", "bundle.json", "input-integrity.json"]
    for optional in ("synthetic-source.copy.txt", "synthetic-source.copy.tmp"):
        if (own / optional).exists():
            names.append(optional)
    return names


def publish_result(own, result):
    """Commit receipt last; an unsealed result is never eligible for cache."""
    write_json(own / "result.json", result)
    receipt = {
        "receipt_version": "artifact-integrity.v1",
        "run_id": own.name,
        "analysis_state": result["analysis_state"],
        "publisher_executor_identity": result["technical_envelope"]["executor_identity"],
        "files_sha256": {name: sha(read_regular(own / name)) for name in artifact_files(own)}}
    write_json(own / "artifact-integrity.json", receipt)


def verify_artifacts(own):
    verify_input_integrity(own)
    receipt_path = own / "artifact-integrity.json"
    if not receipt_path.exists():
        raise ContractError("unsealed result: missing integrity receipt; no automatic replay")
    receipt = parse_json(read_regular(receipt_path))
    if set(receipt) != {"receipt_version", "run_id", "analysis_state",
                        "publisher_executor_identity", "files_sha256"}:
        raise ContractError("invalid integrity receipt shape")
    if receipt["receipt_version"] != "artifact-integrity.v1" or receipt["run_id"] != own.name:
        raise ContractError("invalid integrity receipt identity")
    if not isinstance(receipt["files_sha256"], dict):
        raise ContractError("invalid integrity receipt hashes")
    names = artifact_files(own)
    if set(receipt["files_sha256"]) != set(names):
        raise ContractError("integrity receipt artifact set mismatch")
    for name in names:
        expected = receipt["files_sha256"][name]
        if expected != sha(read_regular(own / name)):
            raise ContractError(f"cached artifact integrity mismatch: {name}")
    result = parse_json(read_regular(own / "result.json"))
    if result["analysis_state"] != receipt["analysis_state"]:
        raise ContractError("receipt/result state mismatch")
    if result["technical_envelope"]["executor_identity"] != receipt["publisher_executor_identity"]:
        raise ContractError("receipt/result executor mismatch")
    return result


def envelope(task, digest, bundle, run_id, executor_id, state, payload=None, error=None):
    versions = copy.deepcopy(task["versions"])
    versions["bundle_sha256"] = bundle
    value = {
        "schema_version": "analysis.v1",
        "identity": {"reel_id": task["reel_id"], "source_sha256": digest,
                     "source_kind": "synthetic_bytes_not_video",
                     "source_metadata_reference": metadata_reference(task)},
        "analysis_state": state, "model_payload": payload,
        "technical_envelope": {
            "provider_mode": "mock", "requested_model": task["requested_model"],
            "used_model": "offline-fixture-mock.v1", "versions": versions,
            "processing_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "run_id": run_id, "executor_identity": executor_id,
            "implementation_identity": "codex-native/developer",
            "input_state_revision": 9, "tokens": None,
            "cost": {"kind": "unknown", "amount": None, "currency": None,
                     "reason": "No provider invoked; no measured billing record."},
            "multimodal_validated": False, "provider_calls": 0,
            "synthetic_fixture_sha256": digest, "result_error": error,
            "download_state": "not_managed"}}
    validate("analysis.v1.schema.json", value)
    return value


def validate_result(value, task, digest, bundle, duration):
    validate("analysis.v1.schema.json", value)
    if value["identity"]["reel_id"] != task["reel_id"] or value["identity"]["source_sha256"] != digest:
        raise ContractError("result identity/hash mismatch")
    if value["identity"]["source_metadata_reference"] != metadata_reference(task):
        raise ContractError("result metadata reference mismatch")
    if task["source"]["expected_sha256"] != digest:
        raise ContractError("task/result source identity mismatch")
    technical = value["technical_envelope"]
    if technical["versions"]["bundle_sha256"] != bundle:
        raise ContractError("cached bundle mismatch")
    if technical["synthetic_fixture_sha256"] != digest:
        raise ContractError("cached source provenance mismatch")
    for key, version in task["versions"].items():
        if technical["versions"][key] != version:
            raise ContractError("cached version mismatch")
    if technical["requested_model"] != task["requested_model"]:
        raise ContractError("cached requested model mismatch")
    if value["model_payload"] is not None:
        validate_payload(value["model_payload"], duration)


def run(task, *, executor_id):
    if not isinstance(executor_id, str) or not executor_id.strip():
        raise ContractError("explicit executor identity required")
    raw, digest, payload_bytes, bundle, hashes = check_task(task)
    year = str(dt.datetime.now(dt.timezone.utc).year)
    bucket = ensure_dir(OUTPUTS / year / task["versions"]["schema"] / task["reel_id"] / bundle)
    lock_dir = ensure_dir(OUTPUTS / "locks")
    source_lock = sha(canonical({"reel_id": task["reel_id"], "source_sha256": digest}))
    lock_path = lock_dir / (source_lock + ".lock")
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # A new JSON version/model flag cannot authorize replay of ambiguous work.
        for previous in sorted(OUTPUTS.glob(f"*/analysis.v1/{task['reel_id']}/*/runs/*")):
            current = ROOT
            for part in previous.relative_to(ROOT).parts:
                current = current / part
                if current.is_symlink():
                    raise ContractError("symlink cached artifact ancestor")
            terminal = previous / "result.json"
            processing = previous / "01-processing.json"
            # Integrity precedes every source/version filter, including missing task.
            if terminal.exists():
                value = verify_artifacts(previous)
                saved = verify_input_integrity(previous)
            elif processing.exists() or (previous / "input-integrity.json").exists():
                saved = verify_input_integrity(previous)
                value = None
            else:
                continue  # No processing marker: no mock execution began.
            old_digest = saved["source"]["expected_sha256"]
            old_bundle = previous.parent.parent.name
            if value is not None:
                validate_result(value, saved, old_digest, old_bundle, saved["source"]["duration_seconds"])
            if old_digest != digest:
                continue
            if old_bundle == bundle:
                continue
            if value is None:
                raise ContractError("unresolved interrupted processing for same source; no replay across versions")
            if value["analysis_state"] == "uncertain":
                raise ContractError("unresolved uncertain run for same source; JSON rerun cannot authorize replay")
        # Search every year: a calendar boundary never repeats an uncertain run.
        prior = []
        for candidate in sorted(OUTPUTS.glob(f"*/{task['versions']['schema']}/{task['reel_id']}/{bundle}/runs/*")):
            current = ROOT
            for part in candidate.relative_to(ROOT).parts:
                current = current / part
                if current.is_symlink():
                    raise ContractError("symlink cached artifact ancestor")
            prior.append(candidate)
        for existing in prior:
            result_path = existing / "result.json"
            if result_path.is_symlink():
                raise ContractError("symlink result")
            if result_path.exists():
                result = verify_artifacts(existing)
                validate_result(result, task, digest, bundle, task["source"]["duration_seconds"])
                state = result["analysis_state"]
                if state in ("completed", "needs_review", "uncertain", "failed"):
                    return {"cached": True, "result_path": str(result_path), "result": result}
            elif (existing / "01-processing.json").exists():
                # A crash after processing began is ambiguous, never auto-retried.
                run_id = existing.name
                result = envelope(task, digest, bundle, run_id, executor_id, "uncertain",
                                  error="interrupted processing found; manual investigation required")
                publish_result(existing, result)
                return {"cached": True, "result_path": str(result_path), "result": result}
        runs = ensure_dir(bucket / "runs")
        run_id = str(uuid.uuid4())
        own = runs / run_id
        own.mkdir(mode=0o700)
        write_json(own / "00-pending.json", envelope(task, digest, bundle, run_id, executor_id, "pending"))
        write_json(own / "task.json", task)
        write_json(own / "bundle.json", {"files": hashes, "bundle_sha256": bundle,
                                        "synthetic_fixture_sha256": digest,
                                        "payload_fixture_sha256": sha(payload_bytes),
                                        "source_metadata_reference": metadata_reference(task)})
        write_json(own / "01-processing.json", envelope(task, digest, bundle, run_id, executor_id, "processing"))
        publish_input_integrity(own, task, digest, bundle)
        try:
            # Own local test-byte copy. Partial copies are retained for diagnosis.
            partial = own / "synthetic-source.copy.tmp"
            with partial.open("xb") as stream:
                if task["mock_scenario"] == "copy_interrupted":
                    stream.write(raw[:12])
                    raise OSError("simulated interrupted local fixture copy")
                stream.write(raw if task["mock_scenario"] != "copy_hash_mismatch" else b"corrupt")
            if sha(read_regular(partial)) != digest:
                raise ContractError("copied fixture hash mismatch")
            os.link(partial, own / "synthetic-source.copy.txt")
            partial.unlink()
            payload = MockProvider().execute(task, payload_bytes)
            if payload is None:
                raise ContractError("mock returned no result")
            validate_payload(payload, task["source"]["duration_seconds"])
            state = "needs_review" if payload["quality"]["review_required"] else "completed"
            result = envelope(task, digest, bundle, run_id, executor_id, state, payload)
        except TimeoutError as exc:
            result = envelope(task, digest, bundle, run_id, executor_id, "uncertain", error=str(exc))
        except (ContractError, PermissionError, RuntimeError, OSError, ValueError) as exc:
            result = envelope(task, digest, bundle, run_id, executor_id, "failed", error=str(exc))
        validate_result(result, task, digest, bundle, task["source"]["duration_seconds"])
        publish_result(own, result)
        return {"cached": False, "result_path": str(own / "result.json"), "result": result}


def main():
    parser = argparse.ArgumentParser(description="Offline synthetic mock only; never executes inference.")
    parser.add_argument("command", choices=["validate", "run"])
    parser.add_argument("task", help="Explicit local JSON task; source references remain confined to fixtures.")
    parser.add_argument("--executor-id", required=True, help="Actual native executor identity; no inferred developer attribution.")
    args = parser.parse_args()
    try:
        task = parse_json(Path(args.task).read_text())
        if args.command == "validate":
            _, digest, _, bundle, _ = check_task(task)
            print(json.dumps({"valid": True, "source_sha256": digest, "bundle_sha256": bundle,
                              "provider_calls": 0, "real_execution_authorized": False}))
        else:
            print(json.dumps(run(task, executor_id=args.executor_id), ensure_ascii=False))
    except (ContractError, PermissionError, FileNotFoundError, json.JSONDecodeError) as exc:
        parser.exit(2, f"Rejected: {exc}\n")


if __name__ == "__main__":
    main()
