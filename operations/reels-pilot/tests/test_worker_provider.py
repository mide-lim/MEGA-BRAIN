"""Synthetic end-to-end proof: no real media, credentials or provider calls."""
import base64
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("pilot_worker", HERE / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
provider = worker.provider
approval = worker.approval
Ledger = worker.Ledger
from common import canonical, sha, parse_json, ContractError
from cloud_adapter import Response


class FakeProvider:
    is_simulated_transport = True
    def __init__(self, response=None, error=False):
        self.calls = 0
        self.error = error
        self.response = response or Response(
            200, (worker.LIVE / "fixtures/response.json").read_bytes(),
            {"content-type": "application/json"})
    def send(self, url, body, token):
        self.calls += 1
        if self.calls != 1 or token != "SYNTHETIC-NO-GOOGLE-CREDENTIAL":
            raise AssertionError("unexpected fake transport repeat or credential")
        if self.error:
            raise TimeoutError("synthetic timeout")
        return self.response


class WorkerProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="reels-worker-test-")
        self.root = Path(self.tmp.name)
        for name in ("media", "results", "ledger"):
            (self.root / name).mkdir(mode=0o700)
        self.private = self.root / "control.key"
        self.public = self.root / "control.pub"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519",
                        "-out", str(self.private)], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        self.private.chmod(0o600)
        subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(self.private),
                        "-pubout", "-out", str(self.public)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.public.chmod(0o644)
        ledgerpath = self.root / "ledger/attempts.sqlite3"
        Ledger(ledgerpath, create=True)
        info = ledgerpath.stat()
        self.policy = {
            "policy_version": worker.POLICY_VERSION,
            "target": {"project": "synthetic-project", "service_account": "synthetic-account",
                       "model": "gemini-3.8-flash", "location": "global"},
            "roots": {name + "_root": worker.root_binding(self.root / name)
                      for name in ("media", "ledger")},
            "public_key": str(self.public), "ledger_path": str(ledgerpath),
            "ledger_identity": [info.st_dev, info.st_ino, info.st_uid],
            "adc_path": "/synthetic-unused-adc", "gross_ceiling": "3.00000000",
            "currency": "USD", "runtime_identity": "uid:%d/gid:%d" % (os.getuid(), os.getgid()),
            "version_pins": worker.version_pins(), "input_state_revision": 21}
        self.policy["roots"]["result_root"] = worker.root_binding(self.root / "results")
        self.task = parse_json((worker.LIVE / "examples/stored-video.preparation.json").read_bytes())
        self.task["reel_id"] = "synthetic-worker"
        self.task["cloud"]["project_id"] = "synthetic-project"
        self.data = b"SYNTHETIC TEST BYTES. Not a video and never sent to Google."
        metadata = canonical({"id": self.task["reel_id"], "synthetic": True})
        rel = "media/reels/" + self.task["reel_id"]
        directory = self.root / "media" / rel
        directory.mkdir(parents=True)
        (directory / "video.mp4").write_bytes(self.data)
        (directory / "metadata.json").write_bytes(metadata)
        self.task["source"].update(
            relative_video_path=rel + "/video.mp4", relative_metadata_path=rel + "/metadata.json",
            source_video_sha256=sha(self.data), metadata_sha256=sha(metadata),
            declared_bytes=len(self.data), declared_duration_seconds=10)
        self.manifest = {"manifest_version": "reels-pilot-run.v1", "task": self.task,
                         "request_sha256": sha(provider.request_bytes(self.task, self.data))}
        fixture = parse_json((HERE.parent / "reels-identity/fixtures/synthetic-grant.v1.json").read_bytes())
        now = dt.datetime.now(dt.timezone.utc)
        self.grant = copy.deepcopy(fixture)
        self.grant.update(mode="ONE_CALL_REAL_AUTHORIZATION", grant_id="pilot-synthetic-worker",
                          bindings=worker.observed_bindings(self.policy, self.task),
                          issued_at=(now-dt.timedelta(seconds=2)).isoformat(),
                          not_before=(now-dt.timedelta(seconds=1)).isoformat(),
                          expires_at=(now+dt.timedelta(minutes=5)).isoformat(),
                          request_sha256=self.manifest["request_sha256"],
                          manifest_sha256=sha(approval.canonical(self.manifest)))
        self.grant["authority"] = {
            "status": "APPROVED", "issuer": "megabrain-human-control-v1", "signer": "ed25519",
            "approval_id": "synthetic-worker-test", "approver": "synthetic-test-not-owner",
            "approved_at": (now-dt.timedelta(seconds=3)).isoformat()}
        self.grant["limits"]["gross_budget"] = "3.00000000"
        self.envelope = self.sign(self.grant)

    def tearDown(self):
        self.tmp.cleanup()

    def sign(self, grant):
        record = {"decision": "APPROVE_SINGLE_REEL",
                  "approved_grant_sha256": sha(canonical(grant)),
                  "approval_id": grant["authority"]["approval_id"],
                  "approved_by": grant["authority"]["approver"],
                  "approved_at": grant["authority"]["approved_at"],
                  "media_read_authorized": True, "media_transmit_authorized": True,
                  "inference_authorized": True}
        path = self.root / "synthetic-approval.json"
        path.write_bytes(canonical(record)); path.chmod(0o600)
        return approval.sign_human_approval(grant, approval_record=path, private_key=self.private)

    def pipeline(self, response=None, error=False, hook=None):
        fake = FakeProvider(response, error)
        return worker.Pipeline(self.policy, synthetic=True, transport=fake, writer_hook=hook), fake

    def test_full_chain_and_restart_preserve_exact_result(self):
        pipeline, fake = self.pipeline()
        out = pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(out["state"], "PERSISTED")
        self.assertEqual(fake.calls, 1)
        path = self.root / "results" / out["artifact_prefix"] / "analysis.v1.json"
        before = path.read_bytes()
        again, fake2 = self.pipeline()
        recovered = again.recover(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(recovered, out); self.assertEqual(fake2.calls, 0)
        self.assertEqual(before, path.read_bytes())
        self.assertEqual((self.root / "results/synthetic-worker/analysis.v1.json").read_bytes(), before)

    def test_forged_grant_denied_before_source_or_network(self):
        pipeline, fake = self.pipeline()
        envelope = copy.deepcopy(self.envelope); envelope["grant"]["limits"]["gross_budget"] = "0.01"
        with mock.patch.object(pipeline, "_source", side_effect=AssertionError("source read")):
            with self.assertRaises(approval.ApprovalDenied):
                pipeline.run(self.manifest, envelope, executor_id="synthetic-executor")
        self.assertEqual(fake.calls, 0)

    def test_real_route_cannot_accept_fake_transport(self):
        with self.assertRaises(ContractError):
            worker.Pipeline(self.policy, transport=FakeProvider())

    def test_synthetic_route_cannot_accept_live_transport(self):
        with self.assertRaises(ContractError):
            worker.Pipeline(self.policy, synthetic=True, transport=provider.DirectTransport())

    def test_request_divergence_blocks_before_reservation(self):
        pipeline, fake = self.pipeline()
        with mock.patch.object(provider, "request_bytes", return_value=b"changed"):
            with self.assertRaises(ContractError):
                pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        with self.assertRaises(worker.LedgerDenied):
            pipeline.ledger.get(sha(self.data))
        self.assertEqual(fake.calls, 0)

    def test_timeout_stays_unknown_and_never_calls_again(self):
        pipeline, fake = self.pipeline(error=True)
        self.assertEqual(pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")["state"], "UNKNOWN")
        again, fake2 = self.pipeline()
        self.assertEqual(again.run(self.manifest, self.envelope, executor_id="synthetic-executor")["state"], "UNKNOWN")
        self.assertEqual(fake.calls, 1); self.assertEqual(fake2.calls, 0)

    def test_write_failure_recovers_from_durable_response_without_provider(self):
        def hook(event, path, data):
            if event == "before_write" and path.name == "provenance.json":
                raise OSError("synthetic disk fault")
        pipeline, fake = self.pipeline(hook=hook)
        with self.assertRaises(OSError):
            pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(pipeline.ledger.get(sha(self.data))["state"], "PERSISTENCE_UNCERTAIN")
        again, fake2 = self.pipeline()
        self.assertEqual(again.recover(self.manifest, self.envelope, executor_id="synthetic-executor")["state"], "PERSISTED")
        self.assertEqual(fake.calls, 1); self.assertEqual(fake2.calls, 0)

    def test_changed_source_denied_without_provider(self):
        pipeline, fake = self.pipeline()
        (self.root / "media" / self.task["source"]["relative_video_path"]).write_bytes(self.data+b"changed")
        with self.assertRaises(ContractError):
            pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(fake.calls, 0)

    def test_changed_root_denied(self):
        self.policy["roots"]["result_root"]["object_id"] = "999999999"
        with self.assertRaises(ContractError):
            self.pipeline()

    def test_changed_code_pin_denied(self):
        self.policy["version_pins"]["reels-pilot/provider.py"] = "0"*64
        with self.assertRaises(ContractError):
            self.pipeline()

    def test_deleted_ledger_not_recreated(self):
        Path(self.policy["ledger_path"]).unlink()
        with self.assertRaises(worker.LedgerDenied):
            self.pipeline()

    def test_failed_response_saved_and_no_retry(self):
        pipeline, fake = self.pipeline(Response(429, b'{"error":{"code":429}}', {"content-type":"application/json"}))
        result = pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(result["analysis_state"], "uncertain")
        again, fake2 = self.pipeline()
        again.recover(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(fake.calls, 1); self.assertEqual(fake2.calls, 0)

    def test_payload_has_documented_static_shape_without_sampling(self):
        body = parse_json(provider.request_bytes(self.task, self.data))
        config = body["generationConfig"]
        self.assertEqual(config["thinkingConfig"], {"thinkingLevel": "LOW"})
        self.assertEqual(config["maxOutputTokens"], 4096)
        self.assertFalse({"temperature","topP","topK","candidateCount","frequencyPenalty","presencePenalty"} & set(config))
        media = body["contents"][0]["parts"][0]
        self.assertEqual(media["mediaProcessing"], "STATIC")
        self.assertEqual(media["videoMetadata"], {"fps": 1})
        self.assertEqual(media["inlineData"]["mimeType"], "video/mp4")
        self.assertEqual(base64.b64decode(media["inlineData"]["data"]), self.data)
        self.assertEqual(body["contents"][0]["parts"][1]["text"],
                         (worker.LIVE/"prompts/stored-multimodal.v1.txt").read_text())

    def test_parser_rejects_incomplete_or_malformed_provider_results(self):
        base = parse_json((worker.LIVE/"fixtures/response.json").read_bytes())
        variants = []
        for reason in ["MAX_TOKENS", "SAFETY", "OTHER"]:
            x=copy.deepcopy(base); x["candidates"][0]["finishReason"]=reason; variants.append(x)
        x=copy.deepcopy(base); x["candidates"]=[]; variants.append(x)
        x=copy.deepcopy(base); x["candidates"]*=2; variants.append(x)
        x=copy.deepcopy(base); x["candidates"][0]["content"]["parts"]=[{"functionCall":{"name":"tool"}}]; variants.append(x)
        x=copy.deepcopy(base); x["candidates"][0]["content"]["parts"]=[{"text":"{}"}]; variants.append(x)
        x=copy.deepcopy(base); x["usageMetadata"]["promptTokenCount"]=-1; variants.append(x)
        x=copy.deepcopy(base); x["promptFeedback"]={"blockReason":"SAFETY"}; variants.append(x)
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(ContractError):
                    provider.parse_response(Response(200,canonical(value),{"content-type":"application/json"}),duration=10,synthetic=True)

    def test_parser_separates_thinking_from_answer(self):
        value = parse_json((worker.LIVE/"fixtures/response.json").read_bytes())
        value["candidates"][0]["content"]["parts"].insert(0,{"text":"private thought","thought":True,"thoughtSignature":"opaque"})
        _, payload = provider.parse_response(Response(200,canonical(value),{"content-type":"application/json"}),duration=10,synthetic=True)
        self.assertEqual(payload["A"]["primary_category"], "other_uncertain")

    def test_parser_requires_json_content_type(self):
        with self.assertRaises(ContractError):
            provider.parse_response(Response(200,b'{}',{"content-type":"text/html"}),duration=10)

    def test_usage_preserves_details_and_rejects_bools(self):
        value={"promptTokenCount":100,"candidatesTokenCount":10,"thoughtsTokenCount":5,"totalTokenCount":115,
               "promptTokensDetails":[{"modality":"VIDEO","tokenCount":80}]}
        self.assertEqual(provider.validate_usage(value),value)
        with self.assertRaises(ContractError):
            provider.validate_usage({"promptTokenCount":True})

    def test_transport_rejects_alternate_endpoint_before_tls(self):
        transport=provider.DirectTransport()
        with mock.patch.object(provider.http.client,"HTTPSConnection", side_effect=AssertionError("TLS")):
            with self.assertRaises(ContractError):
                transport.send("https://example.invalid",b"{}", "synthetic")

    def test_truncated_response_rejected(self):
        with self.assertRaises(ContractError):
            provider.parse_response(Response(200,b'{}',{"content-type":"application/json"},True),duration=10)

    def test_unexpected_real_model_version_rejected(self):
        value=parse_json((worker.LIVE/"fixtures/response.json").read_bytes())
        with self.assertRaises(ContractError):
            provider.parse_response(Response(200,canonical(value),{"content-type":"application/json"}),duration=10)

    def test_pilot_schema_preserves_full_original_payload(self):
        old = parse_json((worker.LIVE / "contracts/analysis.stored-video.v1.schema.json").read_bytes())
        new = parse_json((HERE / "contracts/analysis.pilot.v1.schema.json").read_bytes())
        self.assertEqual(old["properties"]["model_payload"], new["properties"]["model_payload"])
        self.assertEqual(old["allOf"], new["allOf"])
        old.pop("$id"); new.pop("$id")
        for value in (old, new):
            props = value["properties"]["technical_envelope"]["properties"]
            props.pop("implementation_identity"); props.pop("input_state_revision")
        self.assertEqual(old, new)

    def test_whole_request_deadline_interrupts_slow_connection(self):
        import time
        class SlowConnection:
            sock = None
            def connect(self): time.sleep(0.2)
            def close(self): pass
        transport = provider.DirectTransport()
        with mock.patch.object(provider.http.client, "HTTPSConnection", return_value=SlowConnection()):
            with mock.patch.object(provider, "DEADLINE_SECONDS", 0.02):
                with self.assertRaises(TimeoutError):
                    transport.send(worker.endpoint(self.task), b"{}", "synthetic")
        with self.assertRaises(ContractError):
            transport.send(worker.endpoint(self.task), b"{}", "synthetic")

    def test_auth_session_ignores_environment_proxy_and_netrc(self):
        import types
        from cloud_adapter import GoogleOfficialTokenSource
        class Session:
            def __init__(self): self.trust_env = True; self.mounts = []; self.closed = False
            def mount(self, scheme, adapter): self.mounts.append((scheme, adapter))
            def close(self): self.closed = True
        session = Session()
        modules = {name: types.ModuleType(name) for name in (
            "google", "google.auth", "google.auth.impersonated_credentials",
            "google.oauth2", "google.oauth2.credentials", "google.auth.transport",
            "google.auth.transport.requests", "requests", "requests.adapters")}
        modules["google"].auth = modules["google.auth"]
        modules["google.auth"].impersonated_credentials = modules["google.auth.impersonated_credentials"]
        modules["google.auth"].load_credentials_from_dict = object()
        modules["google.auth.impersonated_credentials"].Credentials = type("Impersonated", (), {})
        modules["google.oauth2"].credentials = modules["google.oauth2.credentials"]
        modules["google.oauth2.credentials"].Credentials = type("Human", (), {})
        modules["google.auth.transport.requests"].Request = lambda session: types.SimpleNamespace(session=session)
        modules["requests"].Session = lambda: session
        modules["requests.adapters"].HTTPAdapter = lambda **kw: kw
        source = GoogleOfficialTokenSource(
            "synthetic-account@synthetic-project" + ".iam." + "gserviceaccount.com",
            "synthetic-project", "/synthetic-unused-adc")
        def check(*args):
            self.assertIs(args[-1].session, session)
            self.assertFalse(session.trust_env)
            return "SYNTHETIC-TOKEN-NOT-A-CREDENTIAL"
        with mock.patch.dict(sys.modules, modules), mock.patch.object(source, "read_approved_profile", return_value={}):
            with mock.patch.object(source, "refresh_validated_profile", side_effect=check):
                self.assertEqual(source.token(), "SYNTHETIC-TOKEN-NOT-A-CREDENTIAL")
        self.assertTrue(session.closed)
        self.assertEqual(session.mounts, [("https://", {"max_retries": 0}), ("http://", {"max_retries": 0})])

    def test_signed_full_manifest_blocks_nonrequest_mutations_before_source(self):
        mutations = [lambda t: t["versions"].update(rerun="changed"),
                     lambda t: t.update(task_id="changed"),
                     lambda t: t["source"].update(metadata_sha256="f"*64),
                     lambda t: t["source"].update(declared_duration_seconds=11)]
        for mutate in mutations:
            changed = copy.deepcopy(self.manifest); mutate(changed["task"])
            pipeline, fake = self.pipeline()
            with mock.patch.object(pipeline, "_source", side_effect=AssertionError("source read")):
                with self.assertRaises(approval.ApprovalDenied):
                    pipeline.run(changed, self.envelope, executor_id="synthetic-executor")
            self.assertEqual(fake.calls, 0)

    def test_partial_written_version_is_preserved_and_recovered_to_new_uuid(self):
        def hook(event, path, data):
            if event == "after_write" and path.name == "analysis.v1.json":
                path.write_bytes(b"{partial")
                raise OSError("synthetic interrupted remote write")
        pipeline, fake = self.pipeline(hook=hook)
        with self.assertRaises(OSError):
            pipeline.run(self.manifest, self.envelope, executor_id="original-executor")
        record = pipeline.ledger.get(sha(self.data))
        original = self.root/"results"/self.task["reel_id"]/"versions"/sha(self.data)/record["run_id"]/"analysis.v1.json"
        self.assertEqual(original.read_bytes(),b"{partial")
        again, fake2 = self.pipeline()
        result = again.recover(self.manifest,self.envelope,executor_id="recovery-executor")
        self.assertEqual(result["state"],"PERSISTED")
        self.assertNotEqual(Path(result["artifact_prefix"]).name,record["run_id"])
        self.assertEqual(original.read_bytes(),b"{partial")
        saved=parse_json((self.root/"results"/result["artifact_prefix"]/"analysis.v1.json").read_bytes())
        self.assertEqual(saved["technical_envelope"]["executor_identity"],"original-executor")
        self.assertEqual(fake.calls,1); self.assertEqual(fake2.calls,0)

    def test_http_connection_close_body_survives_and_quota_header_is_explicit(self):
        import io
        import http.client
        payload = b'{"ok":true}'
        class FakeSocket:
            def __init__(self): self.sent = bytearray()
            def settimeout(self, timeout): pass
            def sendall(self, data): self.sent.extend(data)
            def makefile(self, *args):
                return io.BytesIO(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 11\r\n\r\n"+payload)
            def close(self): pass
        sock = FakeSocket()
        connection = http.client.HTTPConnection("aiplatform.googleapis.com")
        connection.connect = lambda: setattr(connection,"sock",sock)
        with mock.patch.object(provider.http.client,"HTTPSConnection",return_value=connection):
            response=provider.DirectTransport().send(worker.endpoint(self.task),b"{}","synthetic")
        self.assertEqual(response.status,200); self.assertEqual(response.body,payload)
        self.assertIn(b"x-goog-user-project: synthetic-project",bytes(sock.sent))
        self.assertIsNone(connection.sock)

    def test_auth_runs_only_after_durable_unknown_and_reverifies_grant(self):
        pipeline, fake = self.pipeline()
        def synthetic_auth():
            self.assertEqual(pipeline.ledger.get(sha(self.data))["state"], "UNKNOWN")
            self.envelope["grant"]["limits"]["gross_budget"] = "1.0"
            return "SYNTHETIC-NO-GOOGLE-CREDENTIAL"
        pipeline.auth = synthetic_auth
        result = pipeline.run(self.manifest, self.envelope, executor_id="synthetic-executor")
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(fake.calls, 0)

    def test_cli_real_policy_is_fixed(self):
        self.assertEqual(str(worker.POLICY_PATH),"/etc/megabrain/reels-pilot/policy.json")


if __name__ == "__main__":
    unittest.main()
