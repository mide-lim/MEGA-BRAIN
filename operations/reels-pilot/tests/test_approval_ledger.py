"""Security and durability tests use synthetic files, keys and provider bytes only."""
from copy import deepcopy
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from approval import (ApprovalDenied, canonical, load_json, sign_human_approval,
                      verify_grant)
from ledger import Ledger, LedgerDenied


def fixture_grant(root, now=None):
    now = now or datetime.now(timezone.utc)
    stamp = now.isoformat()
    pin = {"root_id": str(root), "filesystem_id": str(root.stat().st_dev),
           "object_id": str(root.stat().st_ino), "owner": "uid:0", "mode": "0700"}
    artifact = {"version": "synthetic-test-1", "sha256": "b" * 64}
    return {
        "contract_version": "1.0", "mode": "ONE_CALL_REAL_AUTHORIZATION",
        "grant_id": "pilot-" + uuid.uuid4().hex,
        "authority": {"status": "APPROVED", "issuer": "megabrain-human-control-v1",
                      "signer": "ed25519", "approval_id": uuid.uuid4().hex,
                      "approver": "synthetic-human-not-real", "approved_at": stamp},
        "issued_at": stamp, "not_before": stamp,
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
        "bindings": {
            "media": {"id": "synthetic_only", "sha256": "a" * 64, "digest_verified": True},
            "target": {"project": "synthetic-project", "service_account": "synthetic@example.invalid",
                       "model": "synthetic-model", "location": "global"},
            "artifacts": {"worker": deepcopy(artifact), "prompt": deepcopy(artifact), "schema": deepcopy(artifact)},
            "filesystem": {"media_root": deepcopy(pin), "result_root": deepcopy(pin),
                           "ledger_root": deepcopy(pin), "runtime_identity": "uid:0/gid:0"},
            "policy_version": "one-call-pilot-1"},
        "limits": {"max_calls": 1, "gross_budget": "0.50", "currency": "USD"},
        "persistence": {"reservation": "DURABLE_ATOMIC_BEFORE_IO",
                        "result": "DURABLE_ATOMIC_AFTER_RESPONSE",
                        "uncertain": "NO_RETRY_NO_AUTOMATIC_REFUND",
                        "reconcile": "MANUAL_EVIDENCE_ONLY_NO_REARM"},
        "request_sha256": "c" * 64, "manifest_sha256": "d" * 64}


def _contender(path, checked, start, output):
    start.wait()
    try:
        digest = Ledger(path).reserve(checked)
        output.put(("reserved", digest))
    except (LedgerDenied, sqlite3.OperationalError, sqlite3.IntegrityError):
        output.put(("denied", ""))


def _crash_boundary(path, checked, signal):
    ledger = Ledger(path)
    digest = ledger.reserve(checked)
    ledger.begin_dispatch(digest, now=datetime.now(timezone.utc))
    signal.send(digest)
    signal.recv()


@unittest.skipUnless(os.geteuid() == 0, "root-control synthetic tests require isolated root CI")
class ApprovalLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="reels-pilot-synthetic-")
        self.root = Path(self.tmp.name)
        os.chmod(self.root, 0o700)
        self.private = self.root / "synthetic-private.pem"
        self.public = self.root / "synthetic-public.pem"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519",
                        "-out", str(self.private)], check=True, capture_output=True)
        os.chmod(self.private, 0o600)
        subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(self.private), "-pubout",
                        "-out", str(self.public)], check=True, capture_output=True)
        os.chmod(self.public, 0o644)
        self.approval = self.root / "synthetic-approval.json"
        self.now = datetime.now(timezone.utc)
        self.grant = fixture_grant(self.root, self.now)
        self.path = self.root / "attempts.sqlite3"
        self.ledger = Ledger(self.path, create=True)

    def tearDown(self):
        self.tmp.cleanup()

    def sign(self, grant=None, approval_overrides=None):
        grant = grant or self.grant
        record = {"decision": "APPROVE_SINGLE_REEL",
                  "approved_grant_sha256": hashlib.sha256(canonical(grant)).hexdigest(),
                  "approval_id": grant["authority"]["approval_id"],
                  "approved_by": grant["authority"]["approver"],
                  "approved_at": grant["authority"]["approved_at"],
                  "media_read_authorized": True, "media_transmit_authorized": True,
                  "inference_authorized": True}
        record.update(approval_overrides or {})
        self.approval.write_bytes(canonical(record))
        os.chmod(self.approval, 0o600)
        return sign_human_approval(grant, approval_record=self.approval,
                                   private_key=self.private)

    def verified(self, grant=None, **kwargs):
        grant = grant or self.grant
        defaults = dict(trusted_public_key=self.public,
                        observed_bindings=grant["bindings"], now=self.now,
                        gross_ceiling="0.50", currency="USD",
                        request_sha256=grant["request_sha256"],
                        manifest_sha256=grant["manifest_sha256"])
        defaults.update(kwargs)
        return verify_grant(self.sign(grant), **defaults)

    def dispatch(self):
        digest = self.ledger.reserve(self.verified())
        self.ledger.begin_dispatch(digest, now=self.now)
        return digest

    def test_signed_exact_human_approval_verifies(self):
        checked = self.verified()
        self.assertEqual(checked.source_sha256, self.grant["bindings"]["media"]["sha256"])

    def test_worker_cannot_mint_grant_as_operational_uid(self):
        # The checkout itself may be root-private; copy only public module/schema.
        os.chmod(self.root, 0o755)
        module = Path(__file__).resolve().parents[1]
        (self.root / "approval.py").write_bytes((module / "approval.py").read_bytes())
        (self.root / "contracts").mkdir(mode=0o755)
        (self.root / "contracts/grant.v1.schema.json").write_bytes((module / "contracts/grant.v1.schema.json").read_bytes())
        os.chmod(self.root / "approval.py", 0o644)
        os.chmod(self.root / "contracts", 0o755)
        os.chmod(self.root / "contracts/grant.v1.schema.json", 0o644)
        code = ("import sys;sys.path.insert(0,sys.argv[1]);"
                "from approval import sign_human_approval,ApprovalDenied;"
                "\ntry: sign_human_approval({},approval_record='/not/read',private_key='/not/read')"
                "\nexcept ApprovalDenied: sys.exit(0)"
                "\nsys.exit(1)")
        result = subprocess.run([sys.executable, "-c", code, str(self.root)],
                                preexec_fn=lambda: (os.setgid(987), os.setuid(999)),
                                capture_output=True)
        os.chmod(self.root, 0o700)
        self.assertEqual(result.returncode, 0, result.stderr.decode()[:1000])

    def test_task_or_env_flag_is_not_grant(self):
        with self.assertRaises(ApprovalDenied):
            verify_grant({"allow": True}, trusted_public_key=self.public,
                         observed_bindings={}, now=self.now, gross_ceiling="0.50",
                         currency="USD", request_sha256="c" * 64, manifest_sha256="d" * 64)

    def test_unsigned_or_tampered_grant_rejected(self):
        envelope = self.sign()
        envelope["grant"]["limits"]["gross_budget"] = "0.49"
        with self.assertRaises(ApprovalDenied):
            verify_grant(envelope, trusted_public_key=self.public,
                         observed_bindings=self.grant["bindings"], now=self.now,
                         gross_ceiling="0.50", currency="USD", request_sha256="c" * 64, manifest_sha256="d" * 64)

    def test_changed_source_project_model_or_artifact_rejected(self):
        for group, field in [("media", "sha256"), ("target", "model"), ("target", "project"),
                             ("target", "service_account"), ("target", "location"),
                             ("artifacts", "worker"), ("filesystem", "ledger_root")]:
            observed = deepcopy(self.grant["bindings"])
            observed[group][field] = "changed"
            with self.subTest(field=field), self.assertRaises(ApprovalDenied):
                self.verified(observed_bindings=observed)

    def test_request_sha_is_independently_checked(self):
        with self.assertRaises(ApprovalDenied):
            self.verified(request_sha256="d" * 64)

    def test_full_manifest_digest_is_required_and_immutable(self):
        manifest = {"task_id": "synthetic-task", "versions": {"rerun": "1"},
                    "metadata_sha256": "e" * 64, "duration_seconds": 3.0}
        grant = deepcopy(self.grant)
        grant["manifest_sha256"] = hashlib.sha256(canonical(manifest)).hexdigest()
        self.verified(grant, manifest_sha256=grant["manifest_sha256"])
        for name in ["task_id", "versions", "metadata_sha256", "duration_seconds"]:
            altered = deepcopy(manifest)
            altered[name] = {"rerun": "2"} if name == "versions" else "changed"
            with self.subTest(name=name), self.assertRaises(ApprovalDenied):
                self.verified(grant, manifest_sha256=hashlib.sha256(canonical(altered)).hexdigest())
        missing = deepcopy(grant)
        missing.pop("manifest_sha256")
        with self.assertRaises(ApprovalDenied):
            self.sign(missing)

    def test_budget_currency_and_hard_ceiling_checked(self):
        for kwargs in [{"currency": "BRL"}, {"gross_ceiling": "0.49"}, {"gross_ceiling": 0.5}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ApprovalDenied):
                self.verified(**kwargs)

    def test_grant_expired_or_future_window_rejected(self):
        for now in [self.now - timedelta(seconds=1), self.now + timedelta(minutes=11)]:
            with self.subTest(now=now), self.assertRaises(ApprovalDenied):
                self.verified(now=now)

    def test_grant_session_longer_than_hour_rejected(self):
        grant = deepcopy(self.grant)
        grant["expires_at"] = (self.now + timedelta(hours=2)).isoformat()
        with self.assertRaises(ApprovalDenied):
            self.verified(grant)

    def test_zero_budget_and_multiple_calls_rejected(self):
        for key, value in [("gross_budget", "0"), ("max_calls", 2)]:
            grant = deepcopy(self.grant)
            grant["limits"][key] = value
            with self.subTest(key=key), self.assertRaises(ApprovalDenied):
                self.verified(grant)

    def test_human_approval_must_bind_whole_grant(self):
        for overrides in [{"approved_grant_sha256": "d" * 64}, {"decision": "ALLOW"},
                          {"inference_authorized": False}, {"media_read_authorized": 1},
                          {"media_transmit_authorized": False}]:
            with self.subTest(overrides=overrides), self.assertRaises(ApprovalDenied):
                self.sign(approval_overrides=overrides)

    def test_crypto_ignores_poisoned_path_and_openssl_environment(self):
        fake = self.root / "openssl"
        marker = self.root / "fake-executed"
        fake.write_text("#!/bin/sh\nprintf invoked > '" + str(marker) + "'\nexit 0\n")
        os.chmod(fake, 0o755)
        poison = self.root / "poison.cnf"
        poison.write_text("openssl_conf=initialization\n[initialization]\nproviders=bad\n[bad]\nmissing=missing_section\n")
        poisoned = {"PATH": str(self.root), "OPENSSL_CONF": str(poison),
                    "OPENSSL_MODULES": str(self.root), "OPENSSL_PROVIDERS": "untrusted",
                    "LD_PRELOAD": str(self.root / "untrusted.so"), "HOME": str(self.root),
                    "HTTP_PROXY": "http://invalid.invalid", "HTTPS_PROXY": "http://invalid.invalid"}
        with mock.patch.dict(os.environ, poisoned), mock.patch("approval.subprocess.run", wraps=subprocess.run) as runner:
            checked = self.verified()
        self.assertEqual(checked.source_sha256, self.grant["bindings"]["media"]["sha256"])
        self.assertFalse(marker.exists())
        for call in runner.call_args_list:
            self.assertEqual(call.args[0][0], "/usr/bin/openssl")
            self.assertEqual(call.kwargs["env"], {"PATH": "/usr/bin:/bin", "OPENSSL_CONF": "/dev/null",
                                                "HOME": "/nonexistent", "LANG": "C"})

    def test_crypto_requires_trusted_binary_metadata(self):
        from approval import trusted_file
        envelope = self.sign()
        def check(path, **kwargs):
            if str(path) == "/usr/bin/openssl":
                raise ApprovalDenied("synthetic unsafe binary metadata")
            return trusted_file(path, **kwargs)
        with mock.patch("approval.trusted_file", side_effect=check), self.assertRaises(ApprovalDenied):
            verify_grant(envelope, trusted_public_key=self.public,
                         observed_bindings=self.grant["bindings"], now=self.now,
                         gross_ceiling="0.50", currency="USD", request_sha256="c" * 64,
                         manifest_sha256="d" * 64)

    def test_wrong_asymmetric_key_type_rejected(self):
        private, public = self.root / "rsa-private.pem", self.root / "rsa-public.pem"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt",
                        "rsa_keygen_bits:1024", "-out", str(private)], check=True, capture_output=True)
        os.chmod(private, 0o600)
        subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(private), "-pubout",
                        "-out", str(public)], check=True, capture_output=True)
        os.chmod(public, 0o644)
        with self.assertRaises(ApprovalDenied):
            self.verified(trusted_public_key=public)
        self.sign()
        with self.assertRaises(ApprovalDenied):
            sign_human_approval(self.grant, approval_record=self.approval, private_key=private)

    def test_worker_writable_trust_key_rejected(self):
        os.chmod(self.public, 0o666)
        with self.assertRaises(ApprovalDenied):
            self.verified()

    def test_worker_writable_ancestor_rejected(self):
        os.chmod(self.root, 0o777)
        with self.assertRaises(ApprovalDenied):
            self.verified()
        os.chmod(self.root, 0o700)

    def test_symlink_trust_file_rejected(self):
        link = self.root / "linked-public.pem"
        link.symlink_to(self.public)
        with self.assertRaises(ApprovalDenied):
            self.verified(trusted_public_key=link)

    def test_synthetic2d_grant_and_duplicate_json_rejected(self):
        with self.assertRaises(ApprovalDenied):
            load_json(b'{"grant":1,"grant":2}')
        grant = deepcopy(self.grant)
        grant["mode"] = "SYNTHETIC_SIMULATION_ONLY"
        with self.assertRaises(ApprovalDenied):
            self.sign(grant)

    def test_ledger_requires_verified_capability(self):
        with self.assertRaises(ApprovalDenied):
            self.ledger.reserve(self.grant)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM attempts").fetchone())

    def test_failed_transactions_release_database_fds_and_write_lock(self):
        def ledger_descriptors():
            descriptors = []
            for entry in Path("/proc/self/fd").iterdir():
                try:
                    target = os.readlink(entry)
                except OSError:
                    continue
                if target == str(self.path) or target.startswith(str(self.path) + "-"):
                    descriptors.append(target)
            return descriptors
        before = ledger_descriptors()
        for number in range(5):
            with self.assertRaises(LedgerDenied):
                self.ledger.get("f" * 64)
        self.assertEqual(ledger_descriptors(), before)
        # A new independent connection can immediately obtain the write lock.
        with closing(sqlite3.connect(self.path, timeout=0, isolation_level=None)) as db:
            db.execute("BEGIN IMMEDIATE")
            db.rollback()
        self.assertEqual(ledger_descriptors(), before)

    def test_missing_or_replaced_ledger_never_reinitialized(self):
        with self.assertRaises(LedgerDenied):
            Ledger(self.root / "missing.sqlite3")
        info = self.path.stat()
        with self.assertRaises(LedgerDenied):
            Ledger(self.path, expected_identity=(info.st_dev, info.st_ino + 1, info.st_uid))

    def test_unknown_committed_before_external_boundary(self):
        digest = self.dispatch()
        row = Ledger(self.path).get(digest)
        self.assertEqual((row["state"], row["calls"]), ("UNKNOWN", 1))
        self.assertEqual(row["request_sha256"], "c" * 64)
        self.assertEqual(row["gross_reserved"], "0.50")

    def test_expired_between_reserve_and_dispatch_does_not_send(self):
        digest = self.ledger.reserve(self.verified())
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_dispatch(digest, now=self.now + timedelta(hours=1))
        self.assertEqual(self.ledger.get(digest)["calls"], 0)

    def test_no_second_dispatch_after_unknown_or_received(self):
        digest = self.dispatch()
        for receive in [False, True]:
            if receive:
                self.ledger.receive(digest, b'{"synthetic":true}')
            with self.assertRaises(LedgerDenied):
                self.ledger.begin_dispatch(digest, now=self.now)

    def test_alias_model_grant_and_version_cannot_rearm_same_source(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b'{"synthetic":true}')
        self.ledger.mark_persisted(digest, {"test_version": "synthetic"})
        altered = deepcopy(self.grant)
        altered["grant_id"] = "pilot-" + uuid.uuid4().hex
        altered["bindings"]["media"]["id"] = "other_alias"
        altered["bindings"]["target"]["model"] = "other_model"
        altered["bindings"]["artifacts"]["worker"]["version"] = "other_version"
        with self.assertRaises(LedgerDenied):
            self.ledger.reserve(self.verified(altered))

    def test_global_pilot_slot_blocks_other_source_while_unknown(self):
        self.dispatch()
        altered = deepcopy(self.grant)
        altered["grant_id"] = "pilot-" + uuid.uuid4().hex
        altered["bindings"]["media"]["sha256"] = "d" * 64
        with self.assertRaises(LedgerDenied):
            self.ledger.reserve(self.verified(altered))

    def test_raw_response_and_uncertain_persistence_survive_restart(self):
        digest = self.dispatch()
        raw = b'{"synthetic":"exact bytes"}\n'
        self.ledger.receive(digest, raw)
        self.ledger.mark_persistence_uncertain(digest, "synthetic writer failure")
        restarted = Ledger(self.path)
        self.assertEqual(restarted.recover_response(digest), raw)
        self.assertEqual(restarted.get(digest)["state"], "PERSISTENCE_UNCERTAIN")
        restarted.mark_persisted(digest, {"version_sha256": hashlib.sha256(raw).hexdigest()})
        self.assertEqual(restarted.get(digest)["state"], "PERSISTED")

    def test_failed_begin_write_never_permits_send(self):
        digest = self.ledger.reserve(self.verified())
        db = sqlite3.connect(self.path)
        db.execute("CREATE TRIGGER synthetic_fail BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END")
        db.commit()
        db.close()
        sent = False
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.begin_dispatch(digest, now=self.now)
            sent = True
        self.assertFalse(sent)
        self.assertEqual(Ledger(self.path).get(digest)["state"], "RESERVED")

    def test_failed_receive_write_keeps_unknown(self):
        digest = self.dispatch()
        db = sqlite3.connect(self.path)
        db.execute("CREATE TRIGGER synthetic_fail BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END")
        db.commit()
        db.close()
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.receive(digest, b"synthetic response")
        self.assertEqual(Ledger(self.path).get(digest)["state"], "UNKNOWN")

    def test_concurrent_processes_one_reservation_only(self):
        ctx = multiprocessing.get_context("fork")
        start, output = ctx.Barrier(2), ctx.Queue()
        checked = self.verified()
        processes = [ctx.Process(target=_contender, args=(self.path, checked, start, output)) for _ in range(2)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        outcomes = sorted(output.get(timeout=2)[0] for _ in processes)
        self.assertEqual(outcomes, ["denied", "reserved"])

    def test_process_kill_after_dispatch_recovers_unknown_without_retry(self):
        ctx = multiprocessing.get_context("fork")
        parent, child = ctx.Pipe()
        process = ctx.Process(target=_crash_boundary, args=(self.path, self.verified(), child))
        process.start()
        self.assertTrue(parent.poll(10))
        digest = parent.recv()
        process.terminate()
        process.join(10)
        restarted = Ledger(self.path)
        self.assertEqual((restarted.get(digest)["state"], restarted.get(digest)["calls"]), ("UNKNOWN", 1))
        with self.assertRaises(LedgerDenied):
            restarted.reserve(self.verified())
        with self.assertRaises(LedgerDenied):
            restarted.recover_response(digest)

    def test_partial_version_recovery_preserves_bytes_and_original_attempt(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b"synthetic durable provider response")
        before = self.ledger.get(digest)
        partial = self.root / "analysis.partial.json"
        partial.write_bytes(b'{"partial":')
        new_run = self.ledger.begin_persistence_recovery(digest,
            previous_run_id=before["persistence_run_id"], reason="synthetic incomplete version")
        self.assertNotEqual(new_run, before["run_id"])
        after = Ledger(self.path).get(digest)
        self.assertEqual(after["persistence_run_id"], new_run)
        self.assertEqual(after["run_id"], before["run_id"])
        for key in ["source_sha256", "grant_id", "request_sha256", "calls", "gross_reserved", "currency", "response_sha256"]:
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(partial.read_bytes(), b'{"partial":')
        self.assertEqual(self.ledger.recover_response(digest), b"synthetic durable provider response")
        self.ledger.mark_persisted(digest, {"artifact_run_id": new_run}, persistence_run_id=new_run)
        self.assertEqual(self.ledger.get(digest)["persistence_recoveries"][-1]["status"], "PERSISTED")
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_dispatch(digest, now=self.now)

    def test_partial_recovery_cas_rejects_stale_writer(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b"synthetic durable response")
        original = self.ledger.get(digest)["run_id"]
        latest = self.ledger.begin_persistence_recovery(digest,
            previous_run_id=original, reason="synthetic partial")
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_persistence_recovery(digest, previous_run_id=original, reason="stale")
        with self.assertRaises(LedgerDenied):
            self.ledger.mark_persisted(digest, {"artifact_run_id": original}, persistence_run_id=original)
        with self.assertRaises(LedgerDenied):
            self.ledger.mark_persisted(digest, {"artifact_run_id": latest})
        self.assertEqual(self.ledger.get(digest)["persistence_run_id"], latest)

    def test_partial_recovery_limit_three_retains_unknown_budget(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b"synthetic durable response")
        previous = self.ledger.get(digest)["run_id"]
        for number in range(3):
            previous = self.ledger.begin_persistence_recovery(digest,
                previous_run_id=previous, reason="synthetic interrupted local write")
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_persistence_recovery(digest, previous_run_id=previous, reason="fourth")
        after = Ledger(self.path).get(digest)
        self.assertEqual(len(after["persistence_recoveries"]), 3)
        self.assertEqual((after["calls"], after["gross_reserved"]), (1, "0.50"))
        self.assertEqual(after["persistence_recoveries"][0]["status"], "ABANDONED_PARTIAL")
        self.assertEqual(after["persistence_recoveries"][-1]["status"], "ACTIVE")

    def test_partial_recovery_requires_received_integrity_checked_response(self):
        digest = self.dispatch()
        original = self.ledger.get(digest)["run_id"]
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_persistence_recovery(digest, previous_run_id=original, reason="no response")
        self.ledger.receive(digest, b"synthetic response")
        db = sqlite3.connect(self.path)
        db.execute("UPDATE attempts SET response=? WHERE source_sha256=?", (b"corrupt", digest))
        db.commit()
        db.close()
        with self.assertRaises(LedgerDenied):
            self.ledger.begin_persistence_recovery(digest, previous_run_id=original, reason="corrupt response")

    def test_partial_recovery_write_failure_does_not_select_new_version(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b"synthetic response")
        original = self.ledger.get(digest)["run_id"]
        db = sqlite3.connect(self.path)
        db.execute("CREATE TRIGGER synthetic_fail BEFORE INSERT ON persistence_recovery_runs BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END")
        db.commit()
        db.close()
        with self.assertRaises(sqlite3.IntegrityError):
            self.ledger.begin_persistence_recovery(digest, previous_run_id=original, reason="synthetic")
        restarted = Ledger(self.path).get(digest)
        self.assertEqual(restarted["persistence_run_id"], original)
        self.assertEqual(restarted["persistence_recoveries"], [])
        self.assertEqual(restarted["state"], "RESULT_RECEIVED_NOT_PERSISTED")

    def test_corrupt_response_and_unsafe_ledger_fail_closed(self):
        digest = self.dispatch()
        self.ledger.receive(digest, b"synthetic")
        db = sqlite3.connect(self.path)
        db.execute("UPDATE attempts SET response=? WHERE source_sha256=?", (b"tampered", digest))
        db.commit()
        db.close()
        with self.assertRaises(LedgerDenied):
            self.ledger.recover_response(digest)
        os.chmod(self.path, 0o644)
        with self.assertRaises(LedgerDenied):
            Ledger(self.path)

    def test_result_cannot_persist_without_received_response(self):
        digest = self.dispatch()
        with self.assertRaises(LedgerDenied):
            self.ledger.mark_persisted(digest, {"fake": "reference"})

    def test_ledger_response_is_bounded(self):
        digest = self.dispatch()
        with self.assertRaises(LedgerDenied):
            self.ledger.receive(digest, b"x" * (8 * 1024 * 1024 + 1))
        self.assertEqual(self.ledger.get(digest)["state"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
