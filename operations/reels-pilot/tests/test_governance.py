"""Deterministic offline governance checks using synthetic payloads only.

GovernanceTests and PersistenceTests retain 13 unit/seam checks; the latter
explicitly uses a mocked ledger, not signature proof. SignedPipelineTests adds
real OpenSSL Ed25519, durable ledger and Pipeline integration by composition.
"""
import base64
import copy
import tempfile
import unittest
from unittest import mock
import test_worker_provider as integration
import governance

worker = integration.worker
provider = worker.provider
from common import ContractError, canonical, sha, parse_json
from cloud_adapter import Response


def payload_fixture():
    claim = {"text": "Uma demonstração sintética.", "evidence_ids": ["ev_test"],
             "epistemic_status": "author_claim"}
    return {"A": {"primary_category": "technology", "category_reason": "Exemplo de tecnologia.",
                  "topics": ["Tecnologia"], "keywords": ["teste"],
                  "entities": [{"name": "Test Name", "type": "product", "evidence_ids": ["ev_test"]}],
                  "language": "pt", "content_type": "demonstration", "summary": "Um teste sintético."},
            "B": {"insights": [copy.deepcopy(claim)], "audio": [dict(claim, epistemic_status="observed")],
                  "visual": [copy.deepcopy(claim)], "screen_text": [copy.deepcopy(claim)],
                  "connections": [dict(claim, epistemic_status="inference")],
                  "evidence": [{"evidence_id": "ev_test", "modality": "mixed",
                                "description": "Evidência sintética.", "epistemic_status": "observed",
                                "timestamp": {"start_seconds": 0, "end_seconds": 2}}],
                  "full_transcript": None},
            "quality": {"review_required": False, "review_reasons": [], "uncertainties": [],
                        "limitations": ["Não é um vídeo real."]}}


def response_for(payload):
    return Response(200, canonical({"modelVersion": "gemini-3.8-flash",
                    "candidates": [{"finishReason": "STOP", "content": {"role": "model",
                                    "parts": [{"text": canonical(payload).decode()}]}}]}),
                    {"content-type": "application/json"})


class GovernanceTests(unittest.TestCase):
    def test_model_false_valid_but_never_promoted(self):
        p = payload_fixture(); governance.validate_content(p, 10)
        gate = governance.evaluate(p, 10)
        self.assertEqual(gate["state"], "NEEDS_REVIEW")
        self.assertEqual(gate["taxonomy_status"], "draft")
        self.assertTrue(gate["human_review_mandatory"])
        for key in ("indexing_allowed", "publishing_allowed", "epistemic_claims_verified"):
            self.assertIs(gate[key], False)
        self.assertEqual(gate["model_quality"], p["quality"])

    def test_legacy_parse_false_rejected(self):
        with self.assertRaises(ContractError):
            provider.parse_response(response_for(payload_fixture()), duration=10)

    def test_new_parse_false_accepted_exact(self):
        p = payload_fixture()
        _, actual = provider.parse_response(response_for(p), duration=10, governance_separate=True)
        self.assertEqual(actual, p)

    def test_ids_refs_times_and_schema_rejected(self):
        mutations = [lambda p: p["B"]["evidence"].append(copy.deepcopy(p["B"]["evidence"][0])),
                     lambda p: p["B"]["evidence"][0].update(evidence_id=""),
                     lambda p: p["B"]["insights"][0].update(evidence_ids=["missing"]),
                     lambda p: p["B"]["insights"][0].update(evidence_ids=[]),
                     lambda p: p["B"]["evidence"][0]["timestamp"].update(end_seconds=11),
                     lambda p: p["B"]["evidence"][0]["timestamp"].update(start_seconds=3),
                     lambda p: p["B"]["evidence"][0]["timestamp"].update(start_seconds=-1),
                     lambda p: p["A"].update(primary_category="tecnologia"),
                     lambda p: p.update(extra=True)]
        for mutate in mutations:
            p = payload_fixture(); mutate(p)
            with self.subTest(mutate=mutate), self.assertRaises(ContractError):
                governance.validate_content(p, 10)

    def test_true_without_reasons_and_other_uncertain_rejected(self):
        p = payload_fixture(); p["quality"]["review_required"] = True
        with self.assertRaises(ContractError): governance.validate_content(p, 10)
        p["quality"]["review_reasons"] = ["Revisar conteúdo."]
        governance.validate_content(p, 10)
        p = payload_fixture(); p["A"]["primary_category"] = "other_uncertain"
        with self.assertRaises(ContractError): governance.validate_content(p, 10)

    def test_input_and_quality_immutable(self):
        p = payload_fixture(); before = canonical(p)
        gate = governance.evaluate(p, 10)
        gate["model_quality"]["limitations"].append("different")
        view = governance.build_presentation(p, sha(before), {"/A/summary": "Resumo em português."})
        view["fields"]["/B/insights/0/text"]["evidence_ids"].append("different")
        self.assertEqual(canonical(p), before)

    def test_translation_pointer_type_and_protected_fields(self):
        p = payload_fixture(); digest = sha(canonical(p))
        for mapping in (["bad"], {"/A/summary": 1}, {"/A/summary": ""},
                        {"/missing": "x"}, {"/A/entities/0/name": "x"},
                        {"/A/primary_category": "x"}, {"/B/audio/0/text": "x"},
                        {"/B/screen_text/0/text": "x"}, {"/B/evidence/0/evidence_id": "x"}):
            with self.subTest(mapping=mapping), self.assertRaises(ContractError):
                governance.build_presentation(p, digest, mapping)
        with self.assertRaises(ContractError): governance.build_presentation(p, "0" * 64)

    def test_presentation_hash_evidence_and_language_review(self):
        p = payload_fixture(); p["A"]["summary"] = "An English synthetic summary."
        view = governance.build_presentation(p, sha(canonical(p)))
        self.assertTrue(view["presentation_review_required"])
        self.assertEqual(view["locale"], "pt-BR")
        self.assertEqual(view["fields"]["/A/summary"]["text"], p["A"]["summary"])
        self.assertEqual(view["fields"]["/B/insights/0/text"]["evidence_ids"], ["ev_test"])
        translated = governance.build_presentation(p, sha(canonical(p)), {"/A/summary": "Um resumo sintético."})
        self.assertEqual(translated["fields"]["/A/summary"]["text"], "Um resumo sintético.")
        self.assertNotIn("/B/screen_text/0/text", translated["fields"])

    def test_prompt_ptbr_and_enum_immutability(self):
        prompt = (worker.LIVE / "prompts/stored-multimodal.v1.txt").read_text()
        for text in ("Brazilian Portuguese (pt-BR)", "screen_text", "quotations", "enum values"):
            self.assertIn(text, prompt)
        governance.validate_content(payload_fixture(), 10)
        self.assertIn("reels-pilot/governance.py", worker.version_pins())


class PersistenceTests(unittest.TestCase):
    """Exercise real parser/render/FileStore, explicit in-memory ledger seam.

    This does not assert cryptographic or real ledger integration approval.
    """
    def setUp(self):
        output = worker.HERE / "outputs"; output.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.tmp.cleanup)
        self.task = parse_json((worker.LIVE / "examples/stored-video.preparation.json").read_bytes())
        self.task["source"]["declared_duration_seconds"] = 10
        self.manifest = {"manifest_version": "reels-pilot-run.v2", "task": self.task,
                         "request_sha256": "a" * 64}
        self.envelope = {"grant": {"grant_id": "pilot-synthetic"}}
        self.p = payload_fixture(); self.response = response_for(self.p)
        self.record = {"state": "RESULT_RECEIVED_NOT_PERSISTED", "run_id": "synthetic-run",
                       "persistence_run_id": "00000000-0000-4000-8000-000000000022"}
        self.pipeline = object.__new__(worker.Pipeline)
        self.pipeline.synthetic = True
        self.pipeline.policy = {"version_pins": worker.version_pins(), "input_state_revision": 90,
                                "currency": "USD"}
        self.pipeline.store = worker.FileStore(self.tmp.name)
        self.pipeline.ledger = mock.Mock()
        self.pipeline.ledger.get.side_effect = lambda digest: self.record
        self.pipeline.ledger.recover_response.return_value = canonical({
            "http_status": 200, "body_base64": base64.b64encode(self.response.body).decode(),
            "headers": self.response.headers, "truncated": False,
            "executor_id": "synthetic", "received_at": "2026-10-29T17:00:00+00:00"})
        def persisted(digest, refs, persistence_run_id):
            self.record.update(state="PERSISTED", refs=refs)
        self.pipeline.ledger.mark_persisted.side_effect = persisted

    def persist(self):
        return self.pipeline._persist(self.manifest, self.envelope, executor_id="synthetic")

    def test_exact_manifest_allowlist(self):
        for version in ("reels-pilot-run.v1", "reels-pilot-run.v2"):
            value = dict(self.manifest, manifest_version=version)
            self.assertEqual(worker.check_manifest(value), value)
        for version in ("reels-pilot-run.v3", "reels-pilot-run.v2 ", None, 2):
            with self.assertRaises(ContractError):
                worker.check_manifest(dict(self.manifest, manifest_version=version))
        with self.assertRaises(ContractError):
            worker.check_manifest(dict(self.manifest, governance_separate=True))

    def test_verify_binds_full_manifest_digest_not_just_request(self):
        # Capture arguments to the unchanged signature verifier. NOT a signed test.
        with mock.patch.object(worker.approval, "verify_grant") as verify:
            self.pipeline.policy.update(target={"project": "x", "service_account": "x", "model": "x", "location": "x"},
                                        public_key="/unused", gross_ceiling="3")
            with mock.patch.object(worker, "observed_bindings", return_value={}):
                self.pipeline._verify(self.manifest, self.envelope, worker.dt.datetime(2026, 10, 29))
                v2_hash = verify.call_args.kwargs["manifest_sha256"]
                self.manifest["manifest_version"] = "reels-pilot-run.v1"
                self.pipeline._verify(self.manifest, self.envelope, worker.dt.datetime(2026, 10, 29))
                self.assertNotEqual(v2_hash, verify.call_args.kwargs["manifest_sha256"])
                self.assertEqual(verify.call_args.kwargs["manifest_sha256"], sha(worker.approval.canonical(self.manifest)))

    def test_v2_persists_raw_exact_quality_and_immutable_existing_version(self):
        out = self.persist(); self.assertEqual(out["analysis_state"], "needs_review")
        prefix = out["artifact_prefix"]; seal = self.pipeline.store.verify(prefix)
        before = {name: self.pipeline.store.get(prefix + "/" + name) for name in seal["files_sha256"]}
        result = parse_json(before["analysis.v1.json"])
        self.assertEqual(result["model_payload"], self.p)
        self.assertIs(result["technical_envelope"]["multimodal_validated"], False)
        self.assertEqual(before["raw-response.bin"], self.response.body)
        gate = parse_json(before["governance.v1.json"])
        self.assertEqual(gate["model_quality"], self.p["quality"])
        self.assertFalse(gate["publishing_allowed"])
        self.assertEqual(parse_json(before["presentation.pt-BR.json"])["source_sha256"], sha(canonical(self.p)))
        with mock.patch.object(provider, "parse_response", side_effect=AssertionError("reparse")):
            self.assertEqual(self.persist(), out)
        self.assertEqual(before, {name: self.pipeline.store.get(prefix + "/" + name) for name in before})

    def test_v1_false_failed_no_sidecars_and_no_reparse(self):
        self.manifest["manifest_version"] = "reels-pilot-run.v1"
        out = self.persist(); self.assertEqual(out["analysis_state"], "failed")
        seal = self.pipeline.store.verify(out["artifact_prefix"])
        self.assertNotIn("governance.v1.json", seal["files_sha256"])
        self.assertNotIn("presentation.pt-BR.json", seal["files_sha256"])
        with mock.patch.object(provider, "parse_response", side_effect=AssertionError("reparse")):
            self.assertEqual(self.persist(), out)


class SignedPipelineTests(unittest.TestCase):
    """Real Ed25519/ledger integration; composed fixture, no inherited tests.

    Only provider transport/media are synthetic. Neither signature verification
    nor ledger operations are mocked in these tests.
    """
    def setUp(self):
        self.fixture = integration.WorkerProviderTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def authorize_v2(self):
        fixture = self.fixture
        fixture.manifest["manifest_version"] = "reels-pilot-run.v2"
        fixture.grant["manifest_sha256"] = sha(worker.approval.canonical(fixture.manifest))
        fixture.envelope = fixture.sign(fixture.grant)

    def test_signed_v2_false_quality_persists_and_restart_needs_no_dependencies(self):
        fixture = self.fixture
        self.authorize_v2()
        payload = payload_fixture()
        response = response_for(payload)
        pipeline, fake = fixture.pipeline(response)
        out = pipeline.run(fixture.manifest, fixture.envelope, executor_id="synthetic-gov023")
        self.assertEqual(out["state"], "PERSISTED")
        self.assertEqual(out["analysis_state"], "needs_review")
        self.assertFalse(out["retry_allowed"])
        self.assertEqual(fake.calls, 1)
        self.assertEqual(pipeline.ledger.get(sha(fixture.data))["state"], "PERSISTED")
        prefix = out["artifact_prefix"]
        seal = pipeline.store.verify(prefix)
        before = {name: pipeline.store.get(prefix + "/" + name)
                  for name in (*seal["files_sha256"], "manifest.json")}
        saved = parse_json(before["analysis.v1.json"])
        self.assertEqual(saved["model_payload"], payload)
        self.assertEqual(saved["model_payload"]["quality"], payload["quality"])
        self.assertIs(saved["model_payload"]["quality"]["review_required"], False)
        self.assertIs(saved["technical_envelope"]["multimodal_validated"], False)
        self.assertEqual(before["raw-response.bin"], response.body)
        gate = parse_json(before["governance.v1.json"])
        self.assertEqual(gate, governance.evaluate(payload, 10))
        self.assertEqual(gate["state"], "NEEDS_REVIEW")
        self.assertTrue(gate["human_review_mandatory"])
        self.assertFalse(gate["indexing_allowed"])
        self.assertFalse(gate["publishing_allowed"])
        presentation = parse_json(before["presentation.pt-BR.json"])
        self.assertEqual(presentation["source_sha256"], sha(canonical(payload)))
        self.assertEqual(presentation, governance.build_presentation(payload, sha(canonical(payload))))
        provenance = parse_json(before["provenance.json"])
        self.assertEqual(provenance["manifest_sha256"], sha(worker.approval.canonical(fixture.manifest)))

        # Remove only this fixture's synthetic sources, then restart with all
        # source/auth/provider access forbidden. Real verification/ledger stay live.
        for field in ("relative_video_path", "relative_metadata_path"):
            (fixture.root / "media" / fixture.task["source"][field]).unlink()
        restarted, fake2 = fixture.pipeline(error=True)
        with mock.patch.object(restarted, "_source", side_effect=AssertionError("source unavailable")), \
             mock.patch.object(restarted, "auth", side_effect=AssertionError("auth unavailable")), \
             mock.patch.object(fake2, "send", side_effect=AssertionError("provider unavailable")):
            recovered = restarted.recover(fixture.manifest, fixture.envelope,
                                          executor_id="synthetic-gov023-restart")
        self.assertEqual(recovered, out)
        self.assertEqual(fake.calls, 1)
        self.assertEqual(fake2.calls, 0)
        self.assertEqual(before, {name: restarted.store.get(prefix + "/" + name) for name in before})
        self.assertEqual(restarted.store.verify(prefix), seal)
        self.assertEqual((fixture.root / "results" / fixture.task["reel_id"] /
                          "analysis.v1.json").read_bytes(), before["analysis.v1.json"])

    def test_signed_v1_to_v2_tampering_denied_before_media_and_dispatch(self):
        fixture = self.fixture
        original_request = fixture.manifest["request_sha256"]
        original_envelope = copy.deepcopy(fixture.envelope)
        fixture.manifest["manifest_version"] = "reels-pilot-run.v2"
        self.assertEqual(fixture.manifest["request_sha256"], original_request)
        # Stale valid v1 signature cannot authorize a v2 full manifest. Updating
        # the grant digest without re-signing must also fail actual Ed25519.
        forged_envelope = copy.deepcopy(original_envelope)
        forged_envelope["grant"]["manifest_sha256"] = sha(worker.approval.canonical(fixture.manifest))
        for label, envelope in (("full-manifest binding", original_envelope),
                                ("forged unsigned grant", forged_envelope)):
            with self.subTest(case=label):
                pipeline, fake = fixture.pipeline(response_for(payload_fixture()))
                with mock.patch.object(pipeline, "_source", side_effect=AssertionError("media read")), \
                     mock.patch.object(pipeline, "auth", side_effect=AssertionError("auth called")):
                    with self.assertRaises(worker.approval.ApprovalDenied):
                        pipeline.run(fixture.manifest, envelope, executor_id="synthetic-gov023")
                self.assertEqual(fake.calls, 0)
                with self.assertRaisesRegex(worker.LedgerDenied, "reservation required"):
                    pipeline.ledger.get(sha(fixture.data))
                self.assertEqual(list((fixture.root / "results").iterdir()), [])
        # A legitimate intentional version change requires fixture.sign, not a
        # signature bypass. The same request now succeeds under the v2 grant.
        self.authorize_v2()
        pipeline, fake = fixture.pipeline(response_for(payload_fixture()))
        out = pipeline.run(fixture.manifest, fixture.envelope, executor_id="synthetic-gov023")
        self.assertEqual(out["state"], "PERSISTED")
        self.assertEqual(out["analysis_state"], "needs_review")
        self.assertEqual(fake.calls, 1)


if __name__ == "__main__":
    unittest.main()
