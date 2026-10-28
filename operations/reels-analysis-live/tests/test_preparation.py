import copy
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import worker as w
import storage
import authorization
from cloud_adapter import Response, SingleHTTPTransport, build_request, provider_schema
from common import ContractError, canonical, parse_json, sha, validate

class SimTransport:
    is_simulated_transport = True
    def __init__(self, response=None, error=None):
        self.response = response or Response(200, (ROOT / "fixtures/response.json").read_bytes())
        self.error = error
        self.calls = 0
        self.requests = []
    def send(self, url, body, token):
        self.calls += 1
        self.requests.append((url, parse_json(body), token))
        if self.error:
            raise self.error
        return self.response

class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tests-", dir=ROOT / "outputs")
        self.base = Path(self.temp.name)
        self.artifact_root = self.base / "artifacts"
        self.journal_root = self.base / "local-journal"
        self.engine = w.Worker(self.artifact_root, self.journal_root)
        self.task = parse_json((ROOT / "examples/stored-video.preparation.json").read_bytes())
        self.data = (ROOT / "fixtures/fake-media.txt").read_bytes()
        self.payload = parse_json((ROOT / "fixtures/model-payload.json").read_bytes())

    def tearDown(self):
        self.temp.cleanup()

    def run_mock(self, transport=None, engine=None, task=None):
        return w.run_mock(task or self.task, executor_id="/simulation/sprint2b-tests",
                          transport=transport or SimTransport(), worker=engine or self.engine)

    def result_file(self, receipt, name="analysis.v1.json"):
        return self.artifact_root / receipt["artifact_prefix"] / name

    def journal_prefix(self):
        return next((self.journal_root / self.task["reel_id"]).iterdir())

    def response(self, payload=None, status=200, finish="STOP"):
        return Response(status, canonical({"modelVersion": "offline-transport-mock.v1",
            "usageMetadata": {"synthetic": True},
            "candidates": [{"finishReason": finish, "content": {"parts": [
                {"text": json.dumps(payload or self.payload)}]}}]}))

    def test_prepare_does_not_open_media_or_auth(self):
        with patch.object(w.StoredMediaReader, "read", side_effect=AssertionError("no real media")), \
             patch.object(w.GoogleOfficialTokenSource, "token", side_effect=AssertionError("no auth")), \
             patch.object(SingleHTTPTransport, "send", side_effect=AssertionError("no network")):
            prepared = w.prepare(self.task)
        self.assertTrue(prepared["prepared"])
        self.assertFalse(prepared["source_opened"])
        self.assertEqual(prepared["authorization"]["gross_budget_usd"], 0)

    def test_installed_authority_denies_json_grants_and_zero_budget(self):
        with self.assertRaises(authorization.AuthorizationDenied):
            authorization.require_live_grant({"authorized": True, "budget": 999})
        with self.assertRaises(authorization.AuthorizationDenied):
            authorization.verify_live_grant(object(), self.task)
        for key in ("media_transmission", "inference", "google_spending"):
            task = copy.deepcopy(self.task)
            task["authorization_snapshot"][key] = True
            with self.assertRaises(ContractError):
                w.prepare(task)
        task = copy.deepcopy(self.task)
        task["budget"]["current_authorized_gross_amount"] = 0.5
        with self.assertRaises(ContractError):
            w.prepare(task)

    def test_media_local_bounds_duration_and_size(self):
        for duration in (181, 0, -1, float("nan"), float("inf")):
            task = copy.deepcopy(self.task)
            task["source"]["declared_duration_seconds"] = duration
            with self.assertRaises(ContractError):
                w.prepare(task)
        for amount in (50_000_001, 0, -1):
            task = copy.deepcopy(self.task)
            task["source"]["declared_bytes"] = amount
            with self.assertRaises(ContractError):
                w.prepare(task)
        task = copy.deepcopy(self.task)
        task["source"]["declared_bytes"] = 50_000_000
        task["source"]["declared_duration_seconds"] = 180
        self.assertTrue(w.prepare(task)["prepared"])  # Declaration only, no byte allocation/read.
        with self.assertRaises(ContractError):
            w.check_media(self.task, self.data, 181, True)

    def test_id_hash_and_actual_size_mismatch(self):
        for field, value in (("relative_video_path", "media/reels/other/video.mp4"),
                             ("relative_metadata_path", "../metadata.json"),
                             ("source_video_sha256", "0" * 64),
                             ("declared_bytes", len(self.data) + 1)):
            task = copy.deepcopy(self.task)
            task["source"][field] = value
            with self.assertRaises(ContractError):
                self.run_mock(task=task)
        self.assertFalse((self.journal_root / self.task["reel_id"]).exists())

    def test_allowlist_no_model_or_region_fallback(self):
        for key, value in (("model", "gemini-3.5-flash-lite"), ("location", "us-central1"),
                           ("api_version", "v1"), ("project_id", "evil/path")):
            task = copy.deepcopy(self.task)
            task["cloud"][key] = value
            with self.assertRaises(ContractError):
                w.prepare(task)

    def test_single_static_video_embedded_audio_low_structured_request(self):
        transport = SimTransport()
        receipt = self.run_mock(transport)
        self.assertEqual(transport.calls, 1)
        url, body, token = transport.requests[0]
        self.assertIn("/v1beta1/projects/", url)
        self.assertIn("/locations/global/", url)
        self.assertEqual(body["contents"][0]["role"], "user")
        parts = body["contents"][0]["parts"]
        self.assertEqual(len(parts), 2)
        self.assertEqual(parts[0]["mediaProcessing"], "STATIC")
        self.assertEqual(parts[0]["videoMetadata"]["fps"], 1)
        self.assertEqual(parts[0]["inlineData"]["mimeType"], "video/mp4")
        config = body["generationConfig"]
        self.assertEqual(config["mediaResolution"], "MEDIA_RESOLUTION_LOW")
        self.assertEqual(config["thinkingConfig"]["thinkingLevel"], "LOW")
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertIn("responseSchema", config)
        self.assertNotIn("tools", body)
        self.assertEqual(receipt["result"]["analysis_state"], "needs_review")

    def test_mock_honest_source_and_technical_envelope(self):
        result = self.run_mock()["result"]
        validate("analysis.stored-video.v1.schema.json", result)
        self.assertIsNone(result["identity"]["source_video_sha256"])
        self.assertEqual(result["identity"]["synthetic_fixture_sha256"], sha(self.data))
        self.assertIsNone(result["identity"]["source_metadata_reference"])
        tech = result["technical_envelope"]
        self.assertEqual(tech["real_inference_attempts"], 0)
        self.assertEqual(tech["provider_request_attempts"], 1)
        self.assertFalse(tech["multimodal_validated"])
        self.assertEqual(tech["executor_identity"], "/simulation/sprint2b-tests")
        self.assertIsNone(tech["cost"]["gross_amount"])

    def test_no_real_transport_in_mock_or_internal_unauthorized_mode(self):
        with self.assertRaises(authorization.AuthorizationDenied):
            self.run_mock(SingleHTTPTransport())
        with self.assertRaises(authorization.AuthorizationDenied):
            self.engine.transaction(self.task, self.data, 12, SimTransport(), "/simulation/tests",
                                    synthetic=False, live_grant={"approved": True})

    def test_duplicate_cache_and_concurrent_call_once(self):
        transports = [SimTransport(), SimTransport()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(self.run_mock, transports))
        self.assertEqual(sum(t.calls for t in transports), 1)
        self.assertEqual({r["cached"] for r in receipts}, {True, False})
        self.assertEqual(len({r["artifact_prefix"] for r in receipts}), 1)

    def test_timeout_uncertain_no_replay_even_new_versions(self):
        t = SimTransport(error=TimeoutError())
        first = self.run_mock(t)
        self.assertEqual(first["result"]["analysis_state"], "uncertain")
        self.task["versions"]["rerun"] = "new-version"
        second = SimTransport()
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(second)
        self.assertEqual(second.calls, 0)

    def test_http_auth_redirect_and_server_failures_never_resend(self):
        for status, expected in ((401, "failed"), (403, "failed"), (302, "failed"),
                                 (429, "uncertain"), (503, "uncertain")):
            task = copy.deepcopy(self.task)
            task["reel_id"] += "-" + str(status)
            task["source"]["relative_video_path"] = f"media/reels/{task['reel_id']}/video.mp4"
            task["source"]["relative_metadata_path"] = f"media/reels/{task['reel_id']}/metadata.json"
            t = SimTransport(Response(status, b'{"error":"synthetic"}'))
            r = self.run_mock(t, task=task)
            self.assertEqual(t.calls, 1)
            self.assertEqual(r["result"]["analysis_state"], expected)

    def test_mock_auth_failure_is_recorded_without_retry(self):
        t = SimTransport(error=w.AuthFailure())
        first = self.run_mock(t)
        self.assertEqual(first["result"]["analysis_state"], "failed")
        second = SimTransport()
        self.assertTrue(self.run_mock(second)["cached"])
        self.assertEqual(second.calls, 0)

    def test_invalid_json_category_evidence_and_timestamp_preserve_raw(self):
        cases = [Response(200, b"not-json")]
        for mutate in (
            lambda p: p["A"].update(primary_category="invalid"),
            lambda p: p["B"]["evidence"][0].update(timestamp={"start_seconds": 9, "end_seconds": 2}),
            lambda p: p["B"]["evidence"][0].update(timestamp={"start_seconds": 0, "end_seconds": 13}),
            lambda p: p["B"].update(insights=[{"text":"x", "evidence_ids":["missing"],
                                             "epistemic_status":"inference"}]),
            lambda p: p.update(technical_envelope={"cost":0})):
            payload = copy.deepcopy(self.payload)
            mutate(payload)
            cases.append(self.response(payload))
        for index, response in enumerate(cases):
            task = copy.deepcopy(self.task)
            task["reel_id"] += "-" + str(index)
            task["source"]["relative_video_path"] = f"media/reels/{task['reel_id']}/video.mp4"
            task["source"]["relative_metadata_path"] = f"media/reels/{task['reel_id']}/metadata.json"
            receipt = self.run_mock(SimTransport(response), task=task)
            self.assertEqual(receipt["result"]["analysis_state"], "failed")
            self.assertEqual(self.result_file(receipt, "raw-response.bin").read_bytes(), response.body)

    def test_missing_null_timestamp_valid_and_nonfinite_denied(self):
        for stamp in (None, {"start_seconds": None, "end_seconds": None},
                      {"start_seconds": 0, "end_seconds": 12}):
            payload = copy.deepcopy(self.payload)
            payload["B"]["evidence"][0]["timestamp"] = stamp
            w.validate_payload(payload, 12)
        payload["B"]["evidence"][0].pop("timestamp")
        w.validate_payload(payload, 12)
        for bad in (float("nan"), float("inf"), float("-inf")):
            payload["B"]["evidence"][0]["timestamp"] = {"start_seconds": bad, "end_seconds": bad}
            with self.assertRaises(ContractError):
                w.validate_payload(payload, None)
        for raw in ('{"x":NaN}', '{"x":1e999}', '{"x":1,"x":2}'):
            with self.assertRaises(ContractError):
                parse_json(raw)

    def test_schema_valid_result_and_raw_response_tamper_rejected(self):
        first = self.run_mock()
        path = self.result_file(first)
        original = path.read_bytes()
        value = parse_json(original)
        value["model_payload"]["A"]["summary"] = "Schema-valid changed summary"
        validate("analysis.stored-video.v1.schema.json", value)
        path.write_bytes(canonical(value))
        t = SimTransport()
        with self.assertRaises(ContractError):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)
        path.write_bytes(original)
        self.result_file(first, "raw-response.bin").write_bytes(b"changed raw")
        with self.assertRaises(ContractError):
            self.run_mock(SimTransport())

    def test_journal_filter_tamper_and_missing_task_block(self):
        first = self.run_mock(SimTransport(error=TimeoutError()))
        path = self.journal_prefix() / "input/task.json"
        original = path.read_bytes()
        saved = parse_json(original)
        saved["source"]["source_video_sha256"] = "0" * 64
        path.write_bytes(canonical(saved))
        self.task["versions"]["rerun"] = "another"
        with self.assertRaises(ContractError):
            self.run_mock()
        path.unlink()
        with self.assertRaises((ContractError, FileNotFoundError)):
            self.run_mock()

    def test_missing_attempt_or_manifest_never_replays(self):
        first = self.run_mock()
        (self.journal_prefix() / "attempt/manifest.json").unlink()
        t = SimTransport()
        with self.assertRaises((FileNotFoundError, ContractError)):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)

    def test_response_persistence_failure_blocks_next_version(self):
        def fail(event, path, data):
            if path.name == "raw-response.bin" and event == "after_write":
                raise OSError("simulated mount lost acknowledgment")
        engine = w.Worker(self.artifact_root, self.journal_root, fail)
        t = SimTransport()
        with self.assertRaises(w.PersistenceUncertain):
            self.run_mock(t, engine=engine)
        self.assertEqual(t.calls, 1)
        self.task["versions"]["rerun"] = "changed"
        t2 = SimTransport()
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(t2)
        self.assertEqual(t2.calls, 0)
        self.assertTrue(list(self.artifact_root.rglob("raw-response.bin")))

    def test_manifest_interruption_and_readback_corruption_preserved(self):
        def corrupt(event, path, data):
            if path.name == "manifest.json" and event == "after_write":
                path.write_bytes(b'{"partial":')
        engine = w.Worker(self.artifact_root, self.journal_root, corrupt)
        t = SimTransport()
        with self.assertRaises(storage.DurabilityError):
            self.run_mock(t, engine=engine)
        self.assertEqual(t.calls, 1)
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(SimTransport())
        self.assertTrue(list(self.artifact_root.rglob("analysis.v1.json")))

    def test_fsync_failure_never_treated_as_committed(self):
        def fail(event, path, data):
            if event == "before_fsync":
                raise OSError("simulated unsupported mount fsync")
        engine = w.Worker(self.artifact_root, self.journal_root, fail)
        with self.assertRaises(w.PersistenceUncertain):
            self.run_mock(SimTransport(), engine=engine)
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(SimTransport())

    def test_writer_no_overwrite_no_link_rename_and_path_escape(self):
        store = storage.FileStore(self.base / "store")
        with patch.object(storage.os, "link", side_effect=AssertionError("no hardlink")), \
             patch.object(storage.os, "rename", side_effect=AssertionError("no rename")), \
             patch.object(storage.os, "replace", side_effect=AssertionError("no replace")):
            store.put("version/result.bin", b"first")
            store.manifest("version", ["result.bin"], {"kind":"synthetic"})
        with self.assertRaises(FileExistsError):
            store.put("version/result.bin", b"replace")
        for name in ("../escape", "/absolute", "C:\\escape"):
            with self.assertRaises(ContractError):
                store.put(name, b"deny")
        outside = self.base / "outside"
        outside.mkdir()
        (store.root / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ContractError):
            store.put("link/escape", b"deny")
        self.assertEqual(list(outside.iterdir()), [])

    def test_original_canary_and_versioned_results_preserved(self):
        canary = self.base / "metadata-original.json"
        canary.write_bytes(b'{"original":true}')
        first = self.run_mock()
        original = self.result_file(first).read_bytes()
        self.task["versions"]["rerun"] = "v2"
        second = self.run_mock()
        self.assertNotEqual(first["artifact_prefix"], second["artifact_prefix"])
        self.assertEqual(self.result_file(first).read_bytes(), original)
        self.assertEqual(canary.read_bytes(), b'{"original":true}')

    def test_all_contracts_valid_and_cli_no_live_command(self):
        from jsonschema import Draft202012Validator
        for path in (ROOT / "contracts").glob("*.schema.json"):
            Draft202012Validator.check_schema(parse_json(path.read_bytes()))
        with patch.object(sys, "argv", ["worker.py", "live", "not-opened", "--executor-id", "simulation/executor"]):
            from contextlib import redirect_stderr
            with redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    w.main()
        self.assertEqual(error.exception.code, 2)

    def test_artifacts_without_journal_block_resend(self):
        first = self.run_mock()
        reel = self.journal_root / self.task["reel_id"]
        backup = self.base / "renamed-journal-reel"
        reel.rename(backup)  # Test-only simulate missing/renamed journal; artifacts remain.
        t = SimTransport()
        self.task["versions"]["rerun"] = "new-after-journal-loss"
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)
        self.assertTrue(self.result_file(first).exists())

    def test_artifacts_without_finish_manifest_block_resend(self):
        self.run_mock()
        (self.journal_prefix() / "finish/manifest.json").unlink()
        t = SimTransport()
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)

    def test_existing_root_identity_required_and_replacement_denied(self):
        missing = self.base / "not-mounted"
        with self.assertRaises(storage.DurabilityError):
            storage.FileStore(missing, expected_identity={"device":1, "inode":1})
        self.assertFalse(missing.exists())
        target = self.base / "approved-target"
        target.mkdir()
        observed = target.stat()
        store = storage.FileStore(target, expected_identity={"device":observed.st_dev, "inode":observed.st_ino})
        store.put("fixture.txt", b"synthetic")
        target.rename(self.base / "detached-target")
        target.mkdir()
        with self.assertRaises(storage.DurabilityError):
            store.put("must-not-write.txt", b"deny")
        self.assertFalse((target / "must-not-write.txt").exists())

    def test_raw_capture_written_before_parse_failure(self):
        seen = []
        def hook(event, path, data):
            if event == "after_readback":
                seen.append(path.name)
        engine = w.Worker(self.artifact_root, self.journal_root, hook)
        result = self.run_mock(SimTransport(Response(200, b"invalid-json")), engine=engine)
        self.assertEqual(result["result"]["analysis_state"], "failed")
        self.assertLess(seen.index("raw-response.bin"), seen.index("analysis.v1.json"))


    def test_destination_root_swap_blocks_before_transport(self):
        self.artifact_root.rename(self.base / "detached-artifact-root")
        self.artifact_root.mkdir()
        t = SimTransport()
        with self.assertRaises(storage.DurabilityError):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)
        self.assertEqual(list(self.artifact_root.iterdir()), [])

    def test_root_loss_after_attempt_commit_blocks_send(self):
        changed = []
        def hook(event, path, data):
            if event == "after_readback" and str(path).endswith("attempt/manifest.json") and not changed:
                self.artifact_root.rename(self.base / "target-removed-before-send")
                self.artifact_root.mkdir()
                changed.append(True)
        self.engine.journal.hook = hook
        t = SimTransport()
        with self.assertRaises(storage.DurabilityError):
            self.run_mock(t)
        self.assertEqual(t.calls, 0)

    def test_encoded_request_bound_precedes_attempt(self):
        t = SimTransport()
        with patch.object(w, "MAX_REQUEST_JSON_BYTES", 10):
            with self.assertRaises(ContractError):
                self.run_mock(t)
        self.assertEqual(t.calls, 0)
        self.assertFalse((self.journal_root / self.task["reel_id"]).exists())

    def test_interruption_after_attempt_blocks_all_versions(self):
        t = SimTransport(error=SystemExit("simulated process termination"))
        with self.assertRaises(SystemExit):
            self.run_mock(t)
        self.task["versions"]["rerun"] = "restart"
        t2 = SimTransport()
        with self.assertRaises(w.UncertainBlocked):
            self.run_mock(t2)
        self.assertEqual(t2.calls, 0)

    def test_auth_is_lazy_and_single_inference_transport_is_static_checked(self):
        import ast
        source = (ROOT / "cloud_adapter.py").read_text()
        tree = ast.parse(source)
        top_imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
        self.assertFalse(any("google.auth" in ast.get_source_segment(source, node) for node in top_imports))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "SingleHTTPTransport")
        method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "send")
        requests = [n for n in ast.walk(method) if isinstance(n, ast.Call) and
                    isinstance(n.func, ast.Attribute) and n.func.attr == "request"]
        self.assertEqual(len(requests), 1)
        self.assertFalse(any(isinstance(n, (ast.For, ast.While)) for n in ast.walk(method)))
        self.assertNotIn("AuthorizedSession", source)



    @unittest.skipUnless(hasattr(__import__("os"), "mkfifo"), "POSIX FIFO test")
    def test_fifo_read_is_rejected_without_blocking_subprocess(self):
        import os
        import subprocess
        fifo = self.base / "read.fifo"
        os.mkfifo(fifo)
        script = """import sys
from storage import read_bytes
from common import ContractError
try:
    read_bytes(sys.argv[1])
except ContractError:
    print("nonregular rejected")
else:
    raise AssertionError("FIFO accepted")
"""
        completed = subprocess.run([sys.executable, "-c", script, str(fifo)],
                                   cwd=ROOT, capture_output=True, timeout=3, check=True)
        self.assertIn(b"nonregular rejected", completed.stdout)

    @unittest.skipUnless(hasattr(__import__("os"), "mkfifo"), "POSIX FIFO test")
    def test_fifo_journal_lock_rejected_with_and_without_reader_subprocess(self):
        import os
        import subprocess
        locks = self.journal_root / "locks"
        locks.mkdir()
        fifo = locks / (self.task["reel_id"] + ".lock")
        os.mkfifo(fifo)
        script = """import sys
from pathlib import Path
import worker
from common import parse_json, ContractError
task = parse_json(Path("examples/stored-video.preparation.json").read_bytes())
engine = worker.Worker(Path(sys.argv[1]), Path(sys.argv[2]))
transport = worker.FixtureTransport()
try:
    worker.run_mock(task, executor_id="/simulation/fifo-subprocess",
                    worker=engine, transport=transport)
except (ContractError, OSError) as error:
    assert transport.calls == 0
    print(type(error).__name__ + ": rejected")
else:
    raise AssertionError("FIFO lock accepted")
"""
        args = [sys.executable, "-c", script, str(self.artifact_root), str(self.journal_root)]
        # No-reader case proves O_NONBLOCK prevents open() from hanging.
        first = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=3, check=True)
        self.assertIn(b"rejected", first.stdout)
        # Reader-present case makes open succeed, proving fstat rejects the FIFO fd.
        reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        try:
            second = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=3, check=True)
        finally:
            os.close(reader)
        self.assertIn(b"ContractError: rejected", second.stdout)


class StoredReaderFixtureTests(unittest.TestCase):
    """No ffprobe process, auth, network or historical media is used."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reader-tests-", dir=ROOT / "outputs")
        self.base = Path(self.temp.name)
        self.task = parse_json((ROOT / "examples/stored-video.preparation.json").read_bytes())
        self.data = (ROOT / "fixtures/fake-media.txt").read_bytes()
        source = self.base / f"media/reels/{self.task['reel_id']}"
        source.mkdir(parents=True)
        (source / "video.mp4").write_bytes(self.data)
        self.metadata_path = source / "metadata.json"
        self.metadata = {"id": self.task["reel_id"], "video": {
            "file":"video.mp4", "size_bytes":len(self.data), "sha256":sha(self.data),
            "duration_seconds":12, "width":640, "height":480, "container":"mp4",
            "video_codec":"h264", "audio_codec":"aac", "has_audio":True},
            "validation":{"hash_verified_at":"2000-01-01T00:00:00Z",
                          "media_probe_checked_at":"2000-01-01T00:00:00Z"}}
        self.probe = {"format":{"duration":"12.0","format_name":"mov,mp4,m4a,3gp,3g2,mj2"},
                      "streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":480},
                                 {"codec_type":"audio","codec_name":"aac"}]}
        self.write_metadata(self.metadata)
        stat = self.base.stat()
        self.reader = w.StoredMediaReader(self.base, {"device":stat.st_dev,"inode":stat.st_ino})

    def tearDown(self):
        self.temp.cleanup()

    def write_metadata(self, metadata):
        self.metadata_path.write_bytes(canonical(metadata))
        self.task["source"]["metadata_sha256"] = sha(self.metadata_path.read_bytes())

    def read_stubbed(self, probe=None):
        from types import SimpleNamespace
        import subprocess
        with patch.object(subprocess, "run",
                          return_value=SimpleNamespace(stdout=canonical(probe or self.probe))) as command:
            result = self.reader.read(self.task)
            self.assertEqual(command.call_count, 1)
            args, kwargs = command.call_args
            self.assertEqual(args[0][0], "ffprobe")
            self.assertIn("format=duration,format_name:stream=codec_type,codec_name,width,height", args[0])
            self.assertNotIn("shell", kwargs)
            self.assertEqual(kwargs["timeout"], 15)
            return result

    def test_reader_validates_only_fake_files_with_probe_stub(self):
        before = self.metadata_path.read_bytes()
        data, duration, reference = self.read_stubbed()
        self.assertEqual(data, self.data)
        self.assertEqual(duration, 12)
        self.assertEqual(reference["sha256"], self.task["source"]["metadata_sha256"])
        self.assertEqual(self.metadata_path.read_bytes(), before)
        self.assertTrue(data.startswith(b"SYNTHETIC TEST BYTES."))

    def test_missing_or_wrong_metadata_sha_denied_before_probe(self):
        import subprocess
        for value in (None, "0" * 64):
            self.task["source"]["metadata_sha256"] = value
            with patch.object(subprocess, "run", side_effect=AssertionError("must not probe")) as command:
                with self.assertRaises(ContractError):
                    self.reader.read(self.task)
                self.assertEqual(command.call_count, 0)

    def test_metadata_id_and_video_filename_mismatch_denied_before_probe(self):
        import subprocess
        for mutate in (lambda m:m.update(id="different-reel"),
                       lambda m:m["video"].update(file="different.mp4")):
            metadata = copy.deepcopy(self.metadata)
            mutate(metadata)
            self.write_metadata(metadata)
            with patch.object(subprocess, "run", side_effect=AssertionError("must not probe")):
                with self.assertRaises(ContractError):
                    self.reader.read(self.task)

    def test_no_video_no_audio_and_non_mp4_container_rejected(self):
        from types import SimpleNamespace
        import subprocess
        cases = []
        for missing in ("video", "audio"):
            probe = copy.deepcopy(self.probe)
            probe["streams"] = [s for s in probe["streams"] if s["codec_type"] != missing]
            cases.append(probe)
        probe = copy.deepcopy(self.probe)
        probe["format"]["format_name"] = "matroska,webm"
        cases.append(probe)
        for probe in cases:
            with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout=canonical(probe))):
                with self.assertRaises(ContractError):
                    self.reader.read(self.task)

    def test_optional_metadata_technical_fields_must_match_observation(self):
        from types import SimpleNamespace
        import subprocess
        for key, value in (("size_bytes",len(self.data)+1),("sha256","0"*64),
                           ("duration_seconds",13),("width",641),("height",481),
                           ("container","webm"),("video_codec","vp9"),
                           ("audio_codec","opus"),("has_audio",False)):
            metadata = copy.deepcopy(self.metadata)
            metadata["video"][key] = value
            self.write_metadata(metadata)
            with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout=canonical(self.probe))):
                with self.assertRaises(ContractError, msg=key):
                    self.reader.read(self.task)

    def test_probe_nonfinite_and_invalid_dimensions_rejected(self):
        from types import SimpleNamespace
        import subprocess
        cases = []
        for duration in ("nan","inf","181"):
            probe = copy.deepcopy(self.probe)
            probe["format"]["duration"] = duration
            cases.append(probe)
        probe = copy.deepcopy(self.probe)
        probe["streams"][0]["width"] = 0
        cases.append(probe)
        for probe in cases:
            with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout=canonical(probe))):
                with self.assertRaises(ContractError):
                    self.reader.read(self.task)

    def test_minimal_metadata_optional_fields_not_invented(self):
        self.write_metadata({"id":self.task["reel_id"],"video":{"file":"video.mp4"}})
        _, duration, reference = self.read_stubbed()
        self.assertEqual(duration, 12)
        self.assertEqual(set(reference), {"relative_path","sha256"})


if __name__ == "__main__":
    unittest.main()
