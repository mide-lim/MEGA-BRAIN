import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("offline_worker", MODULE / "worker.py")
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-", dir=MODULE / "outputs")
        self.root = Path(self.temp.name)
        for dirname in ("contracts", "fixtures", "prompts"):
            shutil.copytree(MODULE / dirname, self.root / dirname)
        for filename in ("worker.py", "taxonomy.draft.v1.json"):
            shutil.copy2(MODULE / filename, self.root / filename)
        (self.root / "outputs").mkdir()
        original_run = w.run
        def simulated_run(task):
            return original_run(task, executor_id="/simulation/offline-tests")
        self.patches = [patch.object(w, "run", new=simulated_run), patch.object(w, "ROOT", self.root),
                        patch.object(w, "FIXTURES", self.root / "fixtures"),
                        patch.object(w, "OUTPUTS", self.root / "outputs")]
        for p in self.patches:
            p.start()
        self.task = json.loads((MODULE / "examples/offline-task.json").read_text())
        self.payload = json.loads((self.root / "fixtures/model-payload.json").read_text())

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def payload_file(self, payload):
        (self.root / "fixtures/model-payload.json").write_text(json.dumps(payload))

    def test_schema_documents_valid(self):
        for filename in ("analysis.v1.schema.json", "analysis-task.v1.schema.json",
                         "model-payload.v1.schema.json"):
            w.Draft202012Validator.check_schema(w.schema(filename))

    def test_success_is_honest_mock_needs_review(self):
        receipt = w.run(self.task)
        r = receipt["result"]
        self.assertEqual(r["analysis_state"], "needs_review")
        tech = r["technical_envelope"]
        self.assertEqual(tech["provider_mode"], "mock")
        self.assertEqual(tech["provider_calls"], 0)
        self.assertFalse(tech["multimodal_validated"])
        self.assertIsNone(tech["tokens"])
        self.assertIsNone(tech["cost"]["amount"])
        self.assertEqual(tech["used_model"], "offline-fixture-mock.v1")
        self.assertNotEqual(tech["requested_model"], tech["used_model"])
        self.assertEqual(r["identity"]["source_sha256"],
                         hashlib.sha256((self.root / "fixtures/synthetic-source.txt").read_bytes()).hexdigest())
        self.assertEqual(tech["download_state"], "not_managed")

    def test_invalid_task_category_and_unknown_property(self):
        bad = copy.deepcopy(self.task)
        bad["operation"] = "plan_synthetic"
        with self.assertRaises(w.ContractError):
            w.check_task(bad)
        self.payload["A"]["primary_category"] = "made_up"
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)
        self.payload["A"]["primary_category"] = "other_uncertain"
        self.payload["extra"] = "forbidden"
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)

    def test_model_cannot_supply_technical_metadata(self):
        for key in ("technical_envelope", "identity", "cost", "provider_mode", "tokens"):
            bad = copy.deepcopy(self.payload)
            bad[key] = {"invented": True}
            with self.assertRaises(w.ContractError):
                w.validate_payload(bad, None)

    def test_other_category_requires_review_reason(self):
        self.payload["quality"]["review_required"] = False
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)
        self.payload["quality"]["review_required"] = True
        self.payload["quality"]["review_reasons"] = []
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)

    def test_optional_null_and_partial_timestamp_valid(self):
        ev = self.payload["B"]["evidence"][0]
        for stamp in ("absent", None, {"start_seconds": None, "end_seconds": None},
                      {"start_seconds": None, "end_seconds": 5},
                      {"start_seconds": 0, "end_seconds": 10}):
            if stamp == "absent":
                ev.pop("timestamp", None)
            else:
                ev["timestamp"] = stamp
            w.validate_payload(self.payload, 10)

    def test_timestamp_range_duration_order(self):
        ev = self.payload["B"]["evidence"][0]
        for stamp in ({"start_seconds": -1, "end_seconds": 2},
                      {"start_seconds": 3, "end_seconds": 2},
                      {"start_seconds": 0, "end_seconds": 11},
                      {"start_seconds": 12, "end_seconds": None}):
            ev["timestamp"] = stamp
            with self.assertRaises(w.ContractError):
                w.validate_payload(self.payload, 10)

    def test_evidence_ids_epistemic_and_distinct_entities(self):
        self.payload["B"]["audio"] = [{"text": "An author's assertion.",
                                      "evidence_ids": ["missing"], "epistemic_status": "author_claim"}]
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)
        self.payload["B"]["audio"][0]["evidence_ids"] = ["fixture-1"]
        w.validate_payload(self.payload, None)
        self.payload["B"]["audio"][0]["epistemic_status"] = "verified_fact"
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)
        self.payload["B"]["audio"] = []
        self.payload["A"]["entities"] = ["a topic is not an entity object"]
        with self.assertRaises(w.ContractError):
            w.validate_payload(self.payload, None)

    def test_wrong_source_hash_rejected_before_output(self):
        self.task["source"]["expected_sha256"] = "0" * 64
        with self.assertRaises(w.ContractError):
            w.run(self.task)
        self.assertEqual(list((self.root / "outputs").iterdir()), [])

    def test_real_media_bytes_rejected(self):
        (self.root / "fixtures/synthetic-source.txt").write_bytes(b"\x00\x00ftypisomreal-video-like")
        self.task["source"]["expected_sha256"] = w.sha((self.root / "fixtures/synthetic-source.txt").read_bytes())
        with self.assertRaises(w.ContractError):
            w.run(self.task)

    def test_real_provider_always_denied_even_forged_authorization(self):
        for mode in ("google", "gemini", "openai-codex", "subscription"):
            bad = copy.deepcopy(self.task)
            bad["provider_mode"] = mode
            bad["authorizations"] = {k: True for k in bad["authorizations"]}
            with self.assertRaises(PermissionError):
                w.run(bad)
        with self.assertRaises(PermissionError):
            w.Provider().execute(self.task, b"{}")
        bad = copy.deepcopy(self.task)
        bad["authorizations"]["google"] = True
        with self.assertRaises(w.ContractError):
            w.check_task(bad)

    def test_missing_result_and_provider_auth_failures(self):
        for scenario in ("missing_result", "provider_failure", "authorization_failure"):
            t = copy.deepcopy(self.task)
            t["mock_scenario"] = scenario
            t["versions"]["rerun"] = scenario
            r = w.run(t)
            self.assertEqual(r["result"]["analysis_state"], "failed")
            self.assertIsNone(r["result"]["model_payload"])
            self.assertEqual(r["result"]["technical_envelope"]["provider_calls"], 0)

    def test_timeout_uncertain_never_replayed(self):
        self.task["mock_scenario"] = "timeout"
        first = w.run(self.task)
        self.assertEqual(first["result"]["analysis_state"], "uncertain")
        self.task["mock_scenario"] = "success"  # Cannot evade uncertainty by changing a JSON flag.
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not call")):
            second = w.run(self.task)
        self.assertTrue(second["cached"])
        self.assertEqual(first["result_path"], second["result_path"])
        self.task["versions"]["rerun"] = "forged-rerun"
        with self.assertRaises(w.ContractError):
            w.run(self.task)

    def test_duplicate_cache_no_provider_and_original_preserved(self):
        first = w.run(self.task)
        before = Path(first["result_path"]).read_bytes()
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not call")):
            second = w.run(self.task)
        self.assertTrue(second["cached"])
        self.assertEqual(first["result_path"], second["result_path"])
        self.assertEqual(before, Path(first["result_path"]).read_bytes())

    def test_changed_source_and_rerun_preserve_original(self):
        first = w.run(self.task)
        original = Path(first["result_path"]).read_bytes()
        src = self.root / "fixtures/synthetic-source.txt"
        src.write_bytes(src.read_bytes() + b"synthetic revision two\n")
        self.task["source"]["expected_sha256"] = w.sha(src.read_bytes())
        second = w.run(self.task)
        self.task["versions"]["rerun"] = "manual-v2"
        third = w.run(self.task)
        self.assertEqual(len({first["result_path"], second["result_path"], third["result_path"]}), 3)
        self.assertEqual(original, Path(first["result_path"]).read_bytes())

    def test_interrupted_and_hash_bad_copy_preserved(self):
        for scenario in ("copy_interrupted", "copy_hash_mismatch"):
            self.task["mock_scenario"] = scenario
            self.task["versions"]["rerun"] = scenario
            r = w.run(self.task)
            self.assertEqual(r["result"]["analysis_state"], "failed")
            partial = Path(r["result_path"]).parent / "synthetic-source.copy.tmp"
            self.assertTrue(partial.exists())
            self.assertNotEqual(w.sha(partial.read_bytes()), self.task["source"]["expected_sha256"])
            with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not replay")):
                self.assertTrue(w.run(self.task)["cached"])

    def test_interrupted_processing_becomes_uncertain_no_replay(self):
        first = w.run(self.task)
        result_path = Path(first["result_path"])
        result_path.unlink()  # Test-only simulated crash before terminal publication.
        (result_path.parent / "artifact-integrity.json").unlink()
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not call")):
            second = w.run(self.task)
        self.assertEqual(second["result"]["analysis_state"], "uncertain")
        self.assertTrue(second["cached"])

    def test_corrupt_cached_identity_hash_and_technical_rejected(self):
        first = w.run(self.task)
        path = Path(first["result_path"])
        original = first["result"]
        mutations = [
            lambda r: r["identity"].update(reel_id="wrong"),
            lambda r: r["identity"].update(source_sha256="0" * 64),
            lambda r: r["technical_envelope"].update(provider_mode="google"),
            lambda r: r["technical_envelope"].update(synthetic_fixture_sha256="0" * 64),
            lambda r: r["technical_envelope"]["versions"].update(bundle_sha256="0" * 64)]
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            path.write_text(json.dumps(value))  # Deliberate test-only corruption.
            with self.assertRaises(w.ContractError):
                w.run(self.task)
        path.write_text(json.dumps(original))

    def test_symlink_and_traversal_source_rejected(self):
        escaped = self.root / "queue-canary.txt"
        escaped.write_text("must remain untouched")
        (self.root / "fixtures/link.txt").symlink_to(escaped)
        for ref in ("../queue-canary.txt", str(escaped), "link.txt", "C:\\video.mp4"):
            bad = copy.deepcopy(self.task)
            bad["source"]["ref"] = ref
            with self.assertRaises(w.ContractError):
                w.run(bad)
        self.assertEqual(escaped.read_text(), "must remain untouched")

    def test_symlink_output_and_payload_rejected(self):
        outside = self.root / "external-simulated-queue"
        outside.mkdir()
        (self.root / "outputs" / str(w.dt.datetime.now(w.dt.timezone.utc).year)).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(w.ContractError):
            w.run(self.task)
        self.assertEqual(list(outside.iterdir()), [])
        (self.root / "outputs" / str(w.dt.datetime.now(w.dt.timezone.utc).year)).unlink()
        (self.root / "fixtures/payload-link.json").symlink_to(self.root / "fixtures/model-payload.json")
        self.task["payload_fixture"] = "payload-link.json"
        with self.assertRaises(w.ContractError):
            w.run(self.task)

    def test_queue_isolation_canary_and_no_network_imports(self):
        canary = self.root / "simulated-queue.json"
        canary.write_bytes(b'{"download_state":"completed","real_queue":false}')
        before = canary.read_bytes()
        w.run(self.task)
        self.assertEqual(canary.read_bytes(), before)
        source = (MODULE / "worker.py").read_text()
        import ast
        tree = ast.parse(source)
        imported = []
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                imported.extend(a.name for a in n.names)
            elif isinstance(n, ast.ImportFrom):
                imported.append(n.module or "")
        for forbidden in ("requests", "httpx", "urllib", "socket", "google", "subprocess"):
            self.assertFalse(any(i == forbidden or i.startswith(forbidden + ".") for i in imported))

    def test_atomic_no_overwrite_and_terminal_schema(self):
        path = self.root / "outputs/immutable.json"
        w.write_json(path, {"first": 1})
        with self.assertRaises(w.ContractError):
            w.write_json(path, {"second": 2})
        self.assertEqual(json.loads(path.read_text()), {"first": 1})
        r = w.run(self.task)["result"]
        r["analysis_state"] = "completed"
        r["model_payload"] = None
        with self.assertRaises(w.ContractError):
            w.validate("analysis.v1.schema.json", r)

    def test_concurrent_duplicate_publishes_once(self):
        from concurrent.futures import ThreadPoolExecutor
        calls = []
        original = w.MockProvider.execute
        def execute(provider, task, payload):
            calls.append(task["task_id"])
            return original(provider, task, payload)
        with patch.object(w.MockProvider, "execute", new=execute):
            with ThreadPoolExecutor(max_workers=2) as pool:
                receipts = list(pool.map(w.run, [copy.deepcopy(self.task), copy.deepcopy(self.task)]))
        self.assertEqual(len(calls), 1)
        self.assertEqual({r["cached"] for r in receipts}, {True, False})
        self.assertEqual(len({r["result_path"] for r in receipts}), 1)

    def test_positive_budget_wrong_versions_and_payload_metadata_fail(self):
        bad = copy.deepcopy(self.task)
        bad["budget"]["max_amount"] = 1
        with self.assertRaises(w.ContractError):
            w.check_task(bad)
        bad = copy.deepcopy(self.task)
        bad["versions"]["schema"] = "analysis.v2"
        with self.assertRaises(w.ContractError):
            w.check_task(bad)
        self.payload["technical_envelope"] = {"provider_mode": "google", "cost": 0}
        self.payload_file(self.payload)
        result = w.run(self.task)["result"]
        self.assertEqual(result["analysis_state"], "failed")
        self.assertIsNone(result["model_payload"])

    def test_cross_year_symlink_cache_is_rejected(self):
        previous = self.root / "outputs/1900"
        previous.symlink_to(self.root / "outputs" / str(w.dt.datetime.now(w.dt.timezone.utc).year), target_is_directory=True)
        first = w.run(self.task)
        with self.assertRaises(w.ContractError):
            w.run(self.task)

    def test_schema_valid_result_tamper_is_rejected_by_receipt(self):
        first = w.run(self.task)
        path = Path(first["result_path"])
        original = path.read_bytes()
        mutations = [
            lambda r: r["model_payload"]["A"].update(summary="Schema-valid malicious replacement."),
            lambda r: r["model_payload"]["B"]["evidence"][0].update(
                timestamp={"start_seconds": 1, "end_seconds": 2}),
            lambda r: r.update(analysis_state="completed"),
            lambda r: r["technical_envelope"].update(processing_utc="2026-01-01T00:00:00+00:00")]
        for mutate in mutations:
            value = json.loads(original)
            mutate(value)
            w.validate("analysis.v1.schema.json", value)  # Prove the tamper remains schema-valid.
            path.write_text(json.dumps(value))
            with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not replay")):
                with self.assertRaises(w.ContractError):
                    w.run(self.task)
            path.write_bytes(original)

    def test_bundle_and_task_tamper_receipt_missing_rejected(self):
        first = w.run(self.task)
        own = Path(first["result_path"]).parent
        for filename in ("bundle.json", "task.json"):
            path = own / filename
            original = path.read_bytes()
            value = json.loads(original)
            if filename == "bundle.json":
                value["files"]["worker.py"] = "0" * 64
            else:
                value["mock_scenario"] = "timeout"
            path.write_text(json.dumps(value))
            with self.assertRaises(w.ContractError):
                w.run(self.task)
            path.write_bytes(original)
        (own / "artifact-integrity.json").unlink()
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not replay")):
            with self.assertRaises(w.ContractError):
                w.run(self.task)

    def test_nonfinite_numbers_rejected_at_all_boundaries(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            bad = copy.deepcopy(self.task)
            bad["source"]["duration_seconds"] = value
            with self.assertRaises(w.ContractError):
                w.check_task(bad)
            payload = copy.deepcopy(self.payload)
            payload["B"]["evidence"][0]["timestamp"] = {"start_seconds": value, "end_seconds": value}
            for duration in (None, 10):
                with self.assertRaises(w.ContractError):
                    w.validate_payload(payload, duration)
            with self.assertRaises(ValueError):
                w.canonical({"bad": value})
        for raw in ('{"bad":NaN}', '{"bad":Infinity}', '{"bad":-Infinity}', '{"bad":1e999}'):
            with self.assertRaises(w.ContractError):
                w.parse_json(raw)

    def test_actual_executor_is_explicit_and_cli_requires_it(self):
        import contextlib
        import io
        import sys
        result = w.run(self.task)["result"]["technical_envelope"]
        self.assertEqual(result["executor_identity"], "/simulation/offline-tests")
        self.assertEqual(result["implementation_identity"], "codex-native/developer")
        with patch.object(sys, "argv", ["worker.py", "run", "examples/offline-task.json"]):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    w.main()
        self.assertEqual(error.exception.code, 2)


    def test_cross_version_uncertain_saved_source_hash_tamper_is_blocked(self):
        self.task["mock_scenario"] = "timeout"
        first = w.run(self.task)
        own = Path(first["result_path"]).parent
        saved = json.loads((own / "task.json").read_text())
        saved["source"]["expected_sha256"] = "0" * 64
        (own / "task.json").write_text(json.dumps(saved))
        self.task["mock_scenario"] = "success"
        self.task["versions"]["rerun"] = "different-version"
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not execute")):
            with self.assertRaises(w.ContractError):
                w.run(self.task)

    def test_cross_version_missing_saved_task_is_blocked(self):
        self.task["mock_scenario"] = "timeout"
        first = w.run(self.task)
        own = Path(first["result_path"]).parent
        (own / "task.json").unlink()
        self.task["mock_scenario"] = "success"
        self.task["versions"]["rerun"] = "different-version"
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not execute")):
            with self.assertRaises(w.ContractError):
                w.run(self.task)

    def test_interrupted_input_tamper_not_reconstructed_or_sealed(self):
        first = w.run(self.task)
        own = Path(first["result_path"]).parent
        (own / "result.json").unlink()
        (own / "artifact-integrity.json").unlink()
        saved = json.loads((own / "task.json").read_text())
        saved["source"]["expected_sha256"] = "0" * 64
        (own / "task.json").write_text(json.dumps(saved))
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not execute")):
            with self.assertRaises(w.ContractError):
                w.run(self.task)
        self.assertFalse((own / "result.json").exists())
        self.assertFalse((own / "artifact-integrity.json").exists())

    def test_interrupted_missing_processing_marker_is_blocked(self):
        first = w.run(self.task)
        own = Path(first["result_path"]).parent
        for name in ("result.json", "artifact-integrity.json", "01-processing.json"):
            (own / name).unlink()
        with patch.object(w.MockProvider, "execute", side_effect=AssertionError("must not execute")):
            with self.assertRaises(w.ContractError):
                w.run(self.task)


    def test_explicit_schema_version_and_null_metadata_reference(self):
        result = w.run(self.task)["result"]
        self.assertEqual(result["schema_version"], "analysis.v1")
        self.assertIsNone(result["identity"]["source_metadata_reference"])
        self.assertEqual(result["identity"]["source_kind"], "synthetic_bytes_not_video")
        self.assertNotIn("source_video_sha256", result["identity"])
        for key in ("schema_version", "source_metadata_reference"):
            bad = copy.deepcopy(self.payload)
            bad[key] = "invented by model"
            with self.assertRaises(w.ContractError):
                w.validate_payload(bad, None)

    def test_synthetic_metadata_reference_is_verified_and_program_generated(self):
        path = self.root / "fixtures/synthetic-metadata.json"
        digest = w.sha(path.read_bytes())
        self.task["source_metadata_reference"] = {
            "kind": "synthetic_metadata_fixture", "ref": "synthetic-metadata.json",
            "expected_sha256": digest}
        result = w.run(self.task)["result"]
        self.assertEqual(result["identity"]["source_metadata_reference"], {
            "kind": "synthetic_metadata_fixture", "ref": "fixtures/synthetic-metadata.json",
            "sha256": digest})
        self.assertNotIn("author", result["identity"]["source_metadata_reference"])
        self.assertTrue(w.run(self.task)["cached"])
        path.write_text('{"synthetic":true,"author":"changed"}')
        with self.assertRaises(w.ContractError):
            w.run(self.task)

    def test_real_or_escaping_metadata_reference_is_denied(self):
        self.task["source_metadata_reference"] = {
            "kind": "synthetic_metadata_fixture", "ref": "../outside.json",
            "expected_sha256": "0" * 64}
        with self.assertRaises(w.ContractError):
            w.run(self.task)
        path = self.root / "fixtures/synthetic-metadata.json"
        path.write_text('{"synthetic":false,"author":"must not treat as real metadata"}')
        self.task["source_metadata_reference"] = {
            "kind": "synthetic_metadata_fixture", "ref": "synthetic-metadata.json",
            "expected_sha256": w.sha(path.read_bytes())}
        with self.assertRaises(w.ContractError):
            w.run(self.task)
        self.task["source_metadata_reference"]["kind"] = "real_metadata"
        with self.assertRaises(w.ContractError):
            w.run(self.task)



if __name__ == "__main__":
    unittest.main()
