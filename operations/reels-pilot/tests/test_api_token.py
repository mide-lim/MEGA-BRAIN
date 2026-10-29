"""Deterministic dummy bearer tests; filesystem exceptions confined to fixtures."""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

import test_worker_provider as fixtures

worker = fixtures.worker
api = worker.api_token
NOW = dt.datetime(2026, 10, 29, 2, 0, tzinfo=dt.timezone.utc)


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


class ApiTokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dummy-api-token-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "token.json"
        self.target = {"service_account": "synthetic-account", "project": "synthetic-project"}
        self.d = dict(mode="api_impersonated_token", token_file=str(self.path),
                      target_service_account=self.target["service_account"],
                      quota_project=self.target["project"], operation_id="operation-1",
                      nonce="fresh-nonce-1", grant_reference="pilot-synthetic-worker",
                      issued_at="2026-10-29T01:59:59Z", expires_at="2026-10-29T02:10:00Z")
        self.payload = {k: self.d[k] for k in api.BINDINGS}
        self.payload.update(purpose="api-token-v1", access_token="DUMMY-NOT-A-CREDENTIAL")
        self.write()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(api.dt, "datetime", Clock).start()
        # Only stat results for this exact inode and fixture ancestry are altered.
        # Real open/read/no-follow/hash/link/size checks remain in force.
        original_fstat, original_stat = api.os.fstat, api.os.stat
        ancestors = {original_stat(p).st_ino for p in self.path.parents}
        self.inode = original_stat(self.path).st_ino
        self.overrides = {}
        def adjusted(info):
            values = list(info)
            if info.st_ino == self.inode:
                values[0] = stat.S_IFREG | 0o640
                values[4], values[5] = 0, 987
                for key, value in self.overrides.items():
                    values[{"mode": 0, "nlink": 3, "uid": 4, "gid": 5, "size": 6}[key]] = value
            elif info.st_ino in ancestors:
                values[0] &= ~0o022
                values[4] = 0
            return os.stat_result(values)
        mock.patch.object(api.os, "fstat", side_effect=lambda fd: adjusted(original_fstat(fd))).start()
        mock.patch.object(api.os, "stat", side_effect=lambda *a, **kw: adjusted(original_stat(*a, **kw))).start()

    def write(self, raw=None):
        raw = json.dumps(self.payload).encode() if raw is None else raw
        self.path.write_bytes(raw)
        s = self.path.stat()
        self.d["file_identity"] = dict(device=s.st_dev, inode=s.st_ino, uid=0, gid=987,
                                       mode="0640", size=len(raw), sha256=hashlib.sha256(raw).hexdigest())

    def source(self):
        return api.TemporaryTokenSource(self.d, self.target)

    def test_lazy_single_read_and_reuse_denied(self):
        with mock.patch.object(api.os, "read", wraps=api.os.read) as read:
            source = self.source()
            read.assert_not_called()
            self.assertEqual(source.token(), self.payload["access_token"])
            calls = read.call_count
            with self.assertRaises(api.ApiTokenDenied):
                source.token()
            self.assertEqual(read.call_count, calls)

    def test_expiry_lifetime_future_and_deadline_skew(self):
        for issued, expires in [("01:59:59", "02:02:29"), ("01:59:59", "02:15:00"),
                                ("02:00:31", "02:10:00"), ("02:10:00", "02:09:00")]:
            with self.subTest(issued=issued, expires=expires):
                self.d.update(issued_at="2026-10-29T"+issued+"Z", expires_at="2026-10-29T"+expires+"Z")
                with self.assertRaises(api.ApiTokenDenied):
                    self.source()
        self.d.update(issued_at="2026-10-29T01:59:59Z", expires_at="2026-10-29T02:02:30Z")
        self.source()

    def test_descriptor_target_project_and_strict_shape(self):
        for key, value in [("target_service_account", "wrong"), ("quota_project", "wrong"),
                           ("mode", "adc"), ("nonce", "bad nonce"), ("issued_at", "2026-10-29"),
                           ("unexpected", True), ("operation_id", "")]:
            changed = copy.deepcopy(self.d); changed[key] = value
            with self.subTest(key=key), self.assertRaises(api.ApiTokenDenied):
                api.TemporaryTokenSource(changed, self.target)

    def test_payload_all_bindings_must_match(self):
        for key in api.BINDINGS | {"purpose"}:
            with self.subTest(key=key):
                original = self.payload[key]; self.payload[key] = "wrong"
                self.write()
                with self.assertRaises(api.ApiTokenDenied):
                    self.source().token()
                self.payload[key] = original

    def test_missing_tampered_and_consumed_failure(self):
        source = self.source()
        self.path.write_bytes(b"X" * self.d["file_identity"]["size"])
        with self.assertRaises(api.ApiTokenDenied):
            source.token()
        self.write()
        with self.assertRaises(api.ApiTokenDenied):
            source.token()
        self.path.unlink()
        with self.assertRaises(api.ApiTokenDenied):
            self.source()

    def test_file_uid_gid_mode_links_size_and_identity(self):
        for key, value in [("uid", 1), ("gid", 1), ("mode", stat.S_IFREG | 0o660),
                           ("mode", stat.S_IFIFO | 0o640), ("nlink", 2), ("size", api.MAX_FILE+1)]:
            self.overrides = {key: value}
            with self.subTest(key=key, value=value), self.assertRaises(api.ApiTokenDenied):
                self.source()
        self.overrides = {}
        for key in ("device", "inode", "size"):
            changed = copy.deepcopy(self.d); changed["file_identity"][key] += 1
            with self.subTest(key=key), self.assertRaises(api.ApiTokenDenied):
                api.TemporaryTokenSource(changed, self.target)

    def test_symlinks_and_untrusted_ancestors(self):
        link = self.path.parent / "link.json"; link.symlink_to(self.path)
        self.d["token_file"] = str(link)
        with self.assertRaises(api.ApiTokenDenied):
            self.source()
        self.d["token_file"] = str(self.path)
        for mode, uid in [(stat.S_IFDIR | 0o777, 0), (stat.S_IFDIR | 0o755, 1), (stat.S_IFREG | 0o644, 0)]:
            values = list(self.path.parent.stat()); values[0], values[4] = mode, uid
            with self.assertRaises(api.ApiTokenDenied):
                api._directory(os.stat_result(values))
        linkdir = self.path.parent / "linkdir"; linkdir.symlink_to(self.path.parent, target_is_directory=True)
        self.d["token_file"] = str(linkdir / self.path.name)
        with self.assertRaises(api.ApiTokenDenied):
            self.source()

    def test_duplicate_json_unknown_keys_and_invalid_encoding(self):
        valid = json.dumps(self.payload)
        for raw in [(valid[:-1]+',"purpose":"api-token-v1"}').encode(), b'\xff', b'[]',
                    (valid[:-1]+',"extra":0}').encode(), b'{"x":NaN}', b'{'*1100]:
            with self.subTest(raw=raw[:30]):
                self.write(raw)
                with self.assertRaises(api.ApiTokenDenied):
                    self.source().token()

    def test_token_ascii_whitespace_and_bounds(self):
        for token in ["", "x\ny", "x y", "\x7f", "é", "x"*(api.MAX_TOKEN+1), 123, True]:
            with self.subTest(token_type=type(token), length=len(str(token))):
                self.payload["access_token"] = token; self.write()
                with self.assertRaises(api.ApiTokenDenied):
                    self.source().token()
        self.payload["access_token"] = "x"*api.MAX_TOKEN; self.write()
        self.assertEqual(len(self.source().token()), api.MAX_TOKEN)

    def test_descriptor_identity_types_paths_and_file_bound(self):
        for key, value in [("uid", False), ("gid", 0), ("mode", "640"), ("size", api.MAX_FILE+1),
                           ("size", 0), ("sha256", "F"*64), ("device", True)]:
            changed = copy.deepcopy(self.d); changed["file_identity"][key] = value
            with self.subTest(key=key), self.assertRaises(api.ApiTokenDenied):
                api.TemporaryTokenSource(changed, self.target)
        for path in ["relative.json", str(self.path.parent)+"/../token.json", "/", "//token.json"]:
            changed = copy.deepcopy(self.d); changed["token_file"] = path
            with self.subTest(path=path), self.assertRaises(api.ApiTokenDenied):
                api.TemporaryTokenSource(changed, self.target)

    def fixture(self):
        # Focused unit seam: OpenSSL is absent in this offline image. Existing
        # unchanged approval tests/CI own real signature verification. Here the
        # verifier returns a capability only for the exact unit-test envelope
        # and observed bindings, so worker binding/order checks still execute.
        f = fixtures.WorkerProviderTests()
        root = Path(self.tmp.name)
        for name in ("media", "results", "ledger"):
            (root / name).mkdir(mode=0o700)
        f.root = root
        ledgerpath = root / "ledger/attempts.sqlite3"
        worker.Ledger(ledgerpath, create=True)
        s = ledgerpath.stat()
        f.policy = dict(policy_version=worker.POLICY_VERSION,
                        target=dict(self.target, model="gemini-3.8-flash", location="global"),
                        roots={name+"_root": worker.root_binding(root / directory)
                               for name, directory in [("media", "media"), ("result", "results"), ("ledger", "ledger")]},
                        public_key=str(root / "unused-unit-test.pub"), ledger_path=str(ledgerpath),
                        ledger_identity=[s.st_dev, s.st_ino, s.st_uid], adc_path="/synthetic-unused-adc",
                        gross_ceiling="3.00000000", currency="USD",
                        runtime_identity="uid:%d/gid:%d" % (os.getuid(), os.getgid()),
                        version_pins=worker.version_pins(), input_state_revision=21)
        f.policy["target"] = {"project": self.target["project"], "service_account": self.target["service_account"],
                              "model": "gemini-3.8-flash", "location": "global"}
        f.task = worker.parse_json((worker.LIVE / "examples/stored-video.preparation.json").read_bytes())
        f.task["cloud"]["project_id"] = self.target["project"]
        f.data = b"SYNTHETIC TEST BYTES. Not real media."
        metadata = b'{"synthetic":true}'
        relative_directory = Path("media/reels") / f.task["reel_id"]
        directory = root / "media" / relative_directory
        directory.mkdir(parents=True)
        (directory / "video.mp4").write_bytes(f.data)
        (directory / "metadata.json").write_bytes(metadata)
        f.task["source"].update(relative_video_path=str(relative_directory / "video.mp4"),
                                relative_metadata_path=str(relative_directory / "metadata.json"),
                                source_video_sha256=worker.sha(f.data), metadata_sha256=worker.sha(metadata),
                                declared_bytes=len(f.data), declared_duration_seconds=10)
        f.manifest = {"manifest_version": "reels-pilot-run.v1", "task": f.task,
                      "request_sha256": worker.sha(worker.provider.request_bytes(f.task, f.data))}
        f.grant = worker.parse_json((worker.HERE.parent / "reels-identity/fixtures/synthetic-grant.v1.json").read_bytes())
        f.grant.update(grant_id=self.d["grant_reference"], bindings=worker.observed_bindings(f.policy, f.task),
                       issued_at=(NOW-dt.timedelta(seconds=2)).isoformat(),
                       not_before=(NOW-dt.timedelta(seconds=1)).isoformat(),
                       expires_at=(NOW+dt.timedelta(minutes=5)).isoformat(),
                       request_sha256=f.manifest["request_sha256"],
                       manifest_sha256=worker.sha(worker.approval.canonical(f.manifest)))
        signed = []
        def unit_envelope(grant):
            envelope = {"grant": copy.deepcopy(grant), "signature": "UNIT-SEAM-NOT-A-SIGNATURE"}
            signed.append(copy.deepcopy(envelope))
            return envelope
        def verified(envelope, **kw):
            if envelope not in signed or envelope["grant"]["bindings"] != kw["observed_bindings"]:
                raise worker.approval.ApprovalDenied("unit verifier rejected")
            return worker.approval.VerifiedGrant(worker.approval.canonical(envelope["grant"]), worker.approval._VERIFIED)
        mock.patch.object(worker.approval, "verify_grant", side_effect=verified).start()
        f.sign = unit_envelope
        return f

    def test_root_policy_selection_adc_compatibility_no_env_fallback(self):
        f = self.fixture()
        worker.validate_policy(f.policy, real=False)
        with mock.patch.dict(os.environ, {"AUTH_MODE": "api_impersonated_token", "GOOGLE_APPLICATION_CREDENTIALS": str(self.path)}):
            with mock.patch.object(worker, "GoogleOfficialTokenSource") as adc:
                worker.token_source(f.policy); adc.assert_called_once_with("synthetic-account", "synthetic-project", "/synthetic-unused-adc")
        f.policy["authentication"] = self.d
        self.assertIsInstance(worker.token_source(f.policy), api.TemporaryTokenSource)
        f.policy["authentication"] = None
        with self.assertRaises(ValueError):
            worker.validate_policy(f.policy, real=False)
        f.policy.pop("authentication"); f.policy["auth"] = self.d
        with self.assertRaises(ValueError):
            worker.validate_policy(f.policy, real=False)

    def test_complete_signed_binding_and_version_pin(self):
        f = self.fixture()
        self.assertIn("reels-pilot/api_token.py", worker.version_pins())
        old = worker.observed_bindings(f.policy, f.task)["artifacts"]["worker"]["sha256"]
        self.assertEqual(old, worker.sha(worker.canonical(f.policy["version_pins"])))
        f.policy["authentication"] = copy.deepcopy(self.d)
        binding = worker.observed_bindings(f.policy, f.task)
        f.grant["bindings"] = binding; envelope = f.sign(f.grant)
        pipeline, _ = f.pipeline()
        pipeline._verify(f.manifest, envelope, NOW)
        for key in self.d:
            pipeline.policy["authentication"] = copy.deepcopy(self.d)
            pipeline.policy["authentication"][key] = "tampered"
            with self.subTest(key=key), self.assertRaises(worker.approval.ApprovalDenied):
                pipeline._verify(f.manifest, envelope, NOW)
        f.policy["version_pins"]["reels-pilot/api_token.py"] = "0"*64
        with self.assertRaises(ValueError):
            f.pipeline()

    def test_verified_grant_reference_must_equal_descriptor(self):
        f = self.fixture(); f.policy["authentication"] = copy.deepcopy(self.d)
        f.policy["authentication"]["grant_reference"] = "different-grant"
        f.grant["bindings"] = worker.observed_bindings(f.policy, f.task)
        envelope = f.sign(f.grant); pipeline, _ = f.pipeline()
        with self.assertRaises(worker.approval.ApprovalDenied):
            pipeline._verify(f.manifest, envelope, NOW)

    def test_no_read_before_grant_then_durable_unknown_no_replay(self):
        f = self.fixture(); f.policy["authentication"] = self.d
        f.grant["bindings"] = worker.observed_bindings(f.policy, f.task)
        envelope = f.sign(f.grant); pipeline, fake = f.pipeline()
        source = self.source()
        def auth():
            self.assertEqual(pipeline.ledger.get(worker.sha(f.data))["state"], "UNKNOWN")
            self.assertEqual(source.token(), "DUMMY-NOT-A-CREDENTIAL")
            return "SYNTHETIC-NO-GOOGLE-CREDENTIAL"
        pipeline.auth = auth
        bad = copy.deepcopy(envelope); bad["grant"]["grant_id"] = "forged"
        with mock.patch.object(api.os, "read", wraps=api.os.read) as read:
            with self.assertRaises(worker.approval.ApprovalDenied):
                pipeline.run(f.manifest, bad, executor_id="dummy-test")
            read.assert_not_called()
            result = pipeline.run(f.manifest, envelope, executor_id="dummy-test")
            self.assertEqual(result["state"], "PERSISTED")
            self.assertGreater(read.call_count, 0)
            calls = read.call_count
            pipeline.run(f.manifest, envelope, executor_id="dummy-test")
            self.assertEqual(read.call_count, calls)
        self.assertEqual(fake.calls, 1)

    def test_real_transport_and_auth_injection_still_forbidden(self):
        f = self.fixture(); f.policy["authentication"] = self.d
        # Only bypass unrelated root/runtime validation to reach injection guard.
        with mock.patch.object(worker, "validate_policy"):
            for kwargs in [{"auth": lambda: "dummy"}, {"transport": fixtures.FakeProvider()}]:
                with self.subTest(kwargs=tuple(kwargs)), self.assertRaises(worker.ContractError):
                    worker.Pipeline(f.policy, **kwargs)

    def test_expiry_rechecked_at_lazy_read(self):
        source = self.source()
        later = NOW + dt.timedelta(seconds=500)
        with mock.patch.object(Clock, "now", return_value=later):
            with mock.patch.object(api.os, "read", side_effect=AssertionError("expired bytes read")):
                with self.assertRaises(api.ApiTokenDenied):
                    source.token()

    def test_saved_response_recovery_after_expiry_and_deletion_without_io(self):
        f = self.fixture(); f.policy["authentication"] = copy.deepcopy(self.d)
        f.grant["bindings"] = worker.observed_bindings(f.policy, f.task)
        envelope = f.sign(f.grant)
        pipeline, _ = f.pipeline()
        verified = pipeline._verify(f.manifest, envelope, NOW)
        digest = verified.source_sha256
        with mock.patch("ledger._now", return_value=NOW.isoformat()):
            pipeline.ledger.reserve(verified)
        self.path.unlink()
        later = NOW + dt.timedelta(minutes=20)
        validate_policy = worker.validate_policy
        unit_verify = worker.approval.verify_grant.side_effect
        stamps = []
        def historical_verify(value, **kw):
            stamps.append(kw["now"])
            self.assertEqual(kw["now"], NOW)
            return unit_verify(value, **kw)
        # Keep all policy checks except the real UID/root deployment gate;
        # this fixture uses the documented unit verifier, not real signatures.
        with mock.patch.object(Clock, "now", return_value=later), \
                mock.patch.object(worker, "validate_policy", side_effect=lambda p, **kw: validate_policy(p, real=False)), \
                mock.patch.object(worker.approval, "verify_grant", side_effect=historical_verify), \
                mock.patch.object(worker, "token_source", side_effect=AssertionError("recovery authentication")) as auth, \
                mock.patch.object(worker.provider, "DirectTransport", side_effect=AssertionError("recovery provider")) as transport, \
                mock.patch.object(worker.Pipeline, "_source", side_effect=AssertionError("recovery media")) as media:
            restarted = worker.Pipeline(f.policy)
            for state in ("RESERVED", "UNKNOWN"):
                for method in (restarted.run, restarted.recover):
                    result = method(f.manifest, envelope, executor_id="offline-recovery")
                    self.assertEqual(result["state"], state)
                    self.assertFalse(result["retry_allowed"])
                if state == "RESERVED":
                    pipeline.ledger.begin_dispatch(digest, now=NOW)
            raw = b"offline captured provider failure"
            capture = dict(http_status=503, body_base64=fixtures.base64.b64encode(raw).decode("ascii"),
                           headers={}, truncated=False, received_at=NOW.isoformat(), executor_id="offline-original")
            pipeline.ledger.receive(digest, worker.canonical(capture))
            pipeline.ledger.mark_persistence_uncertain(digest, "offline interrupted persistence")
            recovered = restarted.recover(f.manifest, envelope, executor_id="offline-recovery")
            self.assertEqual(recovered["state"], "PERSISTED")
            self.assertEqual(recovered["analysis_state"], "uncertain")
            self.assertEqual(restarted.store.get(recovered["artifact_prefix"] + "/raw-response.bin"), raw)
            self.assertEqual(restarted.run(f.manifest, envelope, executor_id="offline-recovery"), recovered)
            bad = copy.deepcopy(envelope); bad["grant"]["grant_id"] = "forged"
            with self.assertRaises(worker.approval.ApprovalDenied):
                restarted.recover(f.manifest, bad, executor_id="offline-recovery")
            auth.assert_not_called(); transport.assert_not_called(); media.assert_not_called()
        self.assertTrue(stamps)

    def test_new_dispatch_auth_preflight_after_grant_before_media(self):
        f = self.fixture(); f.policy["authentication"] = copy.deepcopy(self.d)
        f.grant["bindings"] = worker.observed_bindings(f.policy, f.task)
        envelope = f.sign(f.grant)
        validate_policy = worker.validate_policy
        with mock.patch.object(worker, "validate_policy", side_effect=lambda p, **kw: validate_policy(p, real=False)), \
                mock.patch.object(worker.Pipeline, "_source", side_effect=AssertionError("premature media")) as media, \
                mock.patch.object(worker.provider, "DirectTransport", side_effect=AssertionError("premature provider")) as transport, \
                mock.patch.object(api.os, "read", side_effect=AssertionError("premature token read")) as read:
            pipeline = worker.Pipeline(f.policy)
            with mock.patch.object(worker, "token_source", wraps=worker.token_source) as source:
                bad = copy.deepcopy(envelope); bad["grant"]["grant_id"] = "forged"
                with self.assertRaises(worker.approval.ApprovalDenied):
                    pipeline.run(f.manifest, bad, executor_id="offline-new")
                source.assert_not_called()
                with mock.patch.object(Clock, "now", return_value=NOW + dt.timedelta(minutes=20)):
                    with self.assertRaises(api.ApiTokenDenied):
                        pipeline.run(f.manifest, envelope, executor_id="offline-new")
                self.path.unlink()
                with self.assertRaises(api.ApiTokenDenied):
                    pipeline.run(f.manifest, envelope, executor_id="offline-new")
                self.assertEqual(source.call_count, 2)
            with self.assertRaises(worker.LedgerDenied):
                pipeline.ledger.get(worker.sha(f.data))
            media.assert_not_called(); transport.assert_not_called(); read.assert_not_called()


class DirectorySearchOnlyTests(unittest.TestCase):
    def test_nonroot_readonly_consumption_through_root_group_search_only_parent(self):
        """Real DAC traversal; no stat/owner mocks on the nonroot path."""
        def flags_only(reason):
            # Restricted sandboxes still prove both directory opens use O_PATH;
            # the unchanged security cases above remain part of this driver.
            fixture = ApiTokenTests()
            try:
                fixture.setUp()
                original_open = api.os.open
                with mock.patch.object(api.os, "open", wraps=original_open) as opened:
                    self.assertEqual(fixture.source().token(), "DUMMY-NOT-A-CREDENTIAL")
                directories = [call for call in opened.call_args_list
                               if call.args[1] & os.O_DIRECTORY]
                self.assertTrue(any(call.args[0] == "/" for call in directories))
                self.assertTrue(any("dir_fd" in call.kwargs for call in directories))
                for call in directories:
                    self.assertEqual(call.args[1], os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            finally:
                fixture.doCleanups()
            print("DIRECTORY_REGRESSION_FLAGS_ONLY: " + reason, flush=True)

        if os.geteuid() != 0 or not hasattr(os, "fork"):
            flags_only("nonroot identity switch unavailable; no real UID proof")
            return
        # Use the usual runtime temporary location, including when source is
        # read-only. Only test objects receive ownership/mode setup.
        with tempfile.TemporaryDirectory(prefix="dummy-search-only-") as root:
            os.chmod(root, 0o755)
            parent = Path(root) / "search-only"
            parent.mkdir()
            os.chown(parent, 0, 987)
            os.chmod(parent, 0o710)
            path = parent / "token.json"
            target = {"service_account": "synthetic-account", "project": "synthetic-project"}
            descriptor = dict(mode="api_impersonated_token", token_file=str(path),
                              target_service_account=target["service_account"],
                              quota_project=target["project"], operation_id="operation-1",
                              nonce="fresh-nonce-1", grant_reference="pilot-synthetic-worker",
                              issued_at="2026-10-29T01:59:59Z", expires_at="2026-10-29T02:10:00Z")
            payload = {key: descriptor[key] for key in api.BINDINGS}
            payload.update(purpose="api-token-v1", access_token="DUMMY-NOT-A-CREDENTIAL")
            raw = json.dumps(payload, sort_keys=True).encode()
            path.write_bytes(raw)
            os.chown(path, 0, 987)
            os.chmod(path, 0o640)
            info = path.stat()
            descriptor["file_identity"] = dict(device=info.st_dev, inode=info.st_ino,
                                               uid=0, gid=987, mode="0640", size=len(raw),
                                               sha256=hashlib.sha256(raw).hexdigest())
            # Anchor only the root open to the pinned private fixture FD,
            # excluding temporary ancestry such as world-writable /tmp. All
            # subsequent opens/stat/read and DAC checks are real, without mocks.
            anchor_fd = os.open(parent.parent, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.addCleanup(os.close, anchor_fd)
            descriptor["token_file"] = "/" + parent.name + "/token.json"
            original_open = os.open
            def anchored_open(name, flags, *args, **kwargs):
                if name == "/":
                    self.assertEqual(flags, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
                    return os.dup(anchor_fd)
                return original_open(name, flags, *args, **kwargs)
            read_end, write_end = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_end)
                try:
                    try:
                        os.setgroups([])
                        os.setgid(987)
                        os.setuid(65534)
                    except PermissionError:
                        os.write(write_end, b"SETUID_UNAVAILABLE")
                        os._exit(0)
                    self.assertEqual((os.getuid(), os.geteuid(), os.getgid()), (65534, 65534, 987))
                    self.assertEqual(os.getgroups(), [])
                    directory = os.stat(parent.name, dir_fd=anchor_fd, follow_symlinks=False)
                    self.assertEqual((directory.st_uid, directory.st_gid,
                                      stat.S_IMODE(directory.st_mode)), (0, 987, 0o710))
                    # Demonstrate the old flags actually fail for this identity.
                    with self.assertRaises(PermissionError):
                        fd = os.open(parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=anchor_fd)
                        os.close(fd)
                    with mock.patch.object(api.dt, "datetime", Clock), mock.patch.object(api.os, "open", side_effect=anchored_open):
                        source = api.TemporaryTokenSource(descriptor, target)
                        self.assertEqual(source.token(), payload["access_token"])
                        with self.assertRaises(api.ApiTokenDenied):
                            source.token()
                    with self.assertRaises(PermissionError):
                        fd = os.open(parent.name + "/token.json", os.O_WRONLY | os.O_NOFOLLOW, dir_fd=anchor_fd)
                        os.close(fd)
                    os.write(write_end, b"DIRECTORY_REGRESSION_REAL_UID_PASS uid=65534 gid=987 parent=0:987/0710 leaf=0:987/0640 root_open=pinned_fixture_seam old_flags=EACCES consume=OK reuse=DENIED write=DENIED")
                    os._exit(0)
                except BaseException as exc:
                    os.write(write_end, (type(exc).__name__ + ": " + str(exc)).encode()[:4096])
                    os._exit(1)
            os.close(write_end)
            try:
                result = os.read(read_end, 8192).decode()
            finally:
                os.close(read_end)
                _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0, result)
            if result == "SETUID_UNAVAILABLE":
                flags_only("sandbox denied setuid; no real UID proof")
            else:
                self.assertTrue(result.startswith("DIRECTORY_REGRESSION_REAL_UID_PASS"), result)
                self.assertEqual(path.read_bytes(), raw)
                print(result, flush=True)
