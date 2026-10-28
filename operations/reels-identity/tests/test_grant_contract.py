"""Behavioral misuse cases for the synthetic contract; no provider SDK or media."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("grant_spec_offline", ROOT / "grant_spec.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
ContractDenied = module.ContractDenied


class GrantContractTests(unittest.TestCase):
    def setUp(self):
        self.grant = json.loads((ROOT / "fixtures/synthetic-grant.v1.json").read_text())
        self.now = datetime(2030, 1, 1, 0, 1, tzinfo=timezone.utc)
        self.observed = deepcopy(self.grant["bindings"])
        self.ledger = module.SimulationLedger()

    def context(self):
        return dict(observed_bindings=self.observed, now=self.now,
                    gross_ceiling="0.01", currency="USD")

    def reserve(self, grant=None):
        return self.ledger.reserve(self.grant if grant is None else grant, **self.context())

    def test_valid_synthetic_reservation_does_not_enable_live_authority(self):
        digest = self.reserve()
        self.assertEqual(self.ledger.records[digest]["status"], "RESERVED")
        self.assertEqual(self.ledger.records[digest]["calls"], 0)
        for value in (self.grant, {"authorized": True}, None):
            with self.assertRaisesRegex(ContractDenied, "DENIED"):
                module.require_live_grant(value)
        self.assertEqual(module.LIVE_AUTHORITY, "DENIED")

    def test_real_looking_issuer_or_signature_is_rejected(self):
        for field, value in (("issuer", "https://issuer.invalid"),
                             ("signer", "real-signer"), ("signature", "opaque-signature"),
                             ("status", "AUTHORIZED")):
            changed = deepcopy(self.grant); changed["authority"][field] = value
            with self.subTest(field=field), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_task_environment_authorization_cannot_be_added(self):
        for field in ("authorized", "task", "env", "budget_override"):
            changed = deepcopy(self.grant); changed[field] = True
            with self.subTest(field=field), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_expired_not_yet_valid_and_naive_clock_are_rejected(self):
        for clock in (self.now.replace(tzinfo=None), self.now - timedelta(minutes=2),
                      self.now + timedelta(minutes=4)):
            with self.subTest(clock=clock), self.assertRaises(ContractDenied):
                self.ledger.reserve(self.grant, **dict(self.context(), now=clock))

    def test_invalid_timestamp_and_reversed_validity_fail_closed(self):
        for start, end in (("bad", self.grant["expires_at"]),
                           ("2030-01-01T00:06:00Z", self.grant["expires_at"]),
                           ("2030-01-01T00:00:00", self.grant["expires_at"])):
            changed = deepcopy(self.grant); changed["not_before"], changed["expires_at"] = start, end
            with self.subTest(start=start), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_unverified_or_replaced_media_is_rejected(self):
        for field, value in (("digest_verified", False), ("sha256", "b" * 64),
                             ("id", "synthetic-other")):
            changed = deepcopy(self.grant); changed["bindings"]["media"][field] = value
            with self.subTest(field=field), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_target_all_artifacts_and_roots_are_bound(self):
        paths = [
            ("target", "project"), ("target", "service_account"),
            ("target", "model"), ("target", "location"),
            ("artifacts", "worker", "version"), ("artifacts", "worker", "sha256"),
            ("artifacts", "prompt", "version"), ("artifacts", "prompt", "sha256"),
            ("artifacts", "schema", "version"), ("artifacts", "schema", "sha256"),
            ("filesystem", "runtime_identity"),
        ]
        for root in ("media_root", "result_root", "ledger_root"):
            paths += [("filesystem", root, field) for field in
                      ("root_id", "filesystem_id", "object_id", "owner", "mode")]
        for path in paths:
            changed = deepcopy(self.grant); node = changed["bindings"]
            for key in path[:-1]: node = node[key]
            node[path[-1]] = "synthetic:changed"
            with self.subTest(path=path), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_more_than_one_call_and_extra_nested_fields_are_rejected(self):
        for count in (0, 2, True, "1"):
            changed = deepcopy(self.grant); changed["limits"]["max_calls"] = count
            with self.subTest(count=count), self.assertRaises(ContractDenied):
                self.reserve(changed)
        changed = deepcopy(self.grant); changed["limits"]["net_budget"] = "0.00"
        with self.assertRaises(ContractDenied): self.reserve(changed)

    def test_money_rejects_float_nonfinite_zero_negative_and_excess(self):
        for value in (0.01, "NaN", "Infinity", "0", "-0.01", "0.01000001", "1e-2"):
            changed = deepcopy(self.grant); changed["limits"]["gross_budget"] = value
            with self.subTest(value=value), self.assertRaises(ContractDenied):
                self.reserve(changed)

    def test_no_currency_conversion_or_credit_discount(self):
        changed = deepcopy(self.grant); changed["limits"]["currency"] = "BRL"
        with self.assertRaises(ContractDenied): self.reserve(changed)
        with self.assertRaises(ContractDenied):
            self.ledger.reserve(self.grant, **dict(self.context(), gross_ceiling="0.009"))

    def test_io_and_persistence_cannot_precede_reservation(self):
        for action in (lambda: self.ledger.dispatch_simulated("a" * 64, now=self.now),
                       lambda: self.ledger.receive_simulated("a" * 64, result_sha256="b" * 64),
                       lambda: self.ledger.persist_simulated("a" * 64, succeeded=True)):
            with self.assertRaises(ContractDenied): action()
        self.assertEqual(self.ledger.events, [])

    def test_dispatch_consumes_call_and_becomes_unknown_before_response(self):
        digest = self.reserve(); self.ledger.dispatch_simulated(digest, now=self.now)
        self.assertEqual([e["event"] for e in self.ledger.events],
                         ["RESERVE_BEFORE_IO", "SIMULATED_IO_STARTED_UNKNOWN"])
        self.assertEqual(self.ledger.records[digest]["calls"], 1)
        self.assertEqual(self.ledger.records[digest]["status"], "UNKNOWN")
        with self.assertRaises(ContractDenied):
            self.ledger.dispatch_simulated(digest, now=self.now)

    def test_expiry_is_rechecked_at_dispatch(self):
        digest = self.reserve()
        with self.assertRaises(ContractDenied):
            self.ledger.dispatch_simulated(digest, now=self.now + timedelta(minutes=4))
        self.assertEqual(self.ledger.records[digest]["calls"], 0)

    def test_clock_rollback_before_reservation_cannot_dispatch(self):
        digest = self.reserve()
        with self.assertRaises(ContractDenied):
            self.ledger.dispatch_simulated(digest, now=self.now - timedelta(seconds=1))
        self.assertEqual(self.ledger.records[digest]["calls"], 0)

    def test_unknown_blocks_alias_new_version_model_and_fresh_grant(self):
        digest = self.reserve(); self.ledger.dispatch_simulated(digest, now=self.now)
        changed = deepcopy(self.grant)
        changed["grant_id"] = "synthetic-new-grant"
        changed["bindings"]["media"]["id"] = "synthetic-alias"
        changed["bindings"]["target"]["model"] = "synthetic-other-model"
        changed["bindings"]["artifacts"]["worker"]["version"] = "synthetic-v2"
        observations = dict(self.context(), observed_bindings=changed["bindings"])
        with self.assertRaisesRegex(ContractDenied, "cannot be repeated"):
            self.ledger.reserve(changed, **observations)

    def test_one_grant_cannot_be_reused_for_different_media(self):
        self.reserve(); changed = deepcopy(self.grant)
        changed["bindings"]["media"]["sha256"] = "b" * 64
        with self.assertRaises(ContractDenied):
            self.ledger.reserve(changed, **dict(self.context(), observed_bindings=changed["bindings"]))

    def test_reserved_but_unsent_content_is_still_not_released(self):
        self.reserve()
        with self.assertRaises(ContractDenied): self.reserve()

    def test_response_requires_started_call_and_valid_result_digest(self):
        digest = self.reserve()
        with self.assertRaises(ContractDenied):
            self.ledger.receive_simulated(digest, result_sha256="b" * 64)
        self.ledger.dispatch_simulated(digest, now=self.now)
        with self.assertRaises(ContractDenied):
            self.ledger.receive_simulated(digest, result_sha256="bad")
        self.assertEqual(self.ledger.records[digest]["status"], "UNKNOWN")

    def test_persistence_failure_retains_result_and_full_reservation(self):
        digest = self.reserve(); self.ledger.dispatch_simulated(digest, now=self.now)
        self.ledger.receive_simulated(digest, result_sha256="b" * 64)
        self.ledger.persist_simulated(digest, succeeded=False)
        record = self.ledger.records[digest]
        self.assertEqual(record["status"], "PERSISTENCE_UNCERTAIN")
        self.assertEqual(record["result_sha256"], "b" * 64)
        self.assertEqual(record["gross_reserved"], "0.01000000")
        with self.assertRaises(ContractDenied): self.reserve()

    def test_success_does_not_authorize_another_call(self):
        digest = self.reserve(); self.ledger.dispatch_simulated(digest, now=self.now)
        self.ledger.receive_simulated(digest, result_sha256="b" * 64)
        self.ledger.persist_simulated(digest, succeeded=True)
        self.assertEqual(self.ledger.records[digest]["status"], "PERSISTED")
        with self.assertRaises(ContractDenied): self.reserve()

    def test_manual_reconcile_records_evidence_without_refund_or_rearm(self):
        digest = self.reserve(); self.ledger.dispatch_simulated(digest, now=self.now)
        self.ledger.reconcile_simulated(digest, evidence_sha256="c" * 64)
        record = self.ledger.records[digest]
        self.assertEqual(record["status"], "UNKNOWN")
        self.assertEqual(record["reconciliations"], ["c" * 64])
        self.assertEqual(record["gross_reserved"], self.grant["limits"]["gross_budget"])
        with self.assertRaises(ContractDenied): self.reserve()

    def test_returned_snapshots_and_inputs_cannot_mutate_ledger(self):
        digest = self.reserve()
        self.grant["bindings"]["media"]["sha256"] = "b" * 64
        records = self.ledger.records; records[digest]["status"] = "PERSISTED"
        events = self.ledger.events; events.clear()
        self.assertEqual(self.ledger.records[digest]["status"], "RESERVED")
        self.assertEqual(len(self.ledger.events), 1)

    def test_distinct_media_needs_distinct_valid_grant(self):
        self.reserve(); changed = deepcopy(self.grant)
        changed["grant_id"] = "synthetic-two"
        changed["bindings"]["media"]["sha256"] = "b" * 64
        second = self.ledger.reserve(changed, **dict(self.context(), observed_bindings=changed["bindings"]))
        self.assertEqual(second, "b" * 64)
        self.assertEqual(len(self.ledger.records), 2)


if __name__ == "__main__":
    unittest.main()
