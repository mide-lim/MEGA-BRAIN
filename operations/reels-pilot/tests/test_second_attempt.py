"""Offline successor gates. Unit capability seam is NOT signature verification.

Manual activation (Root only, AFTER independent review and green full CI):
1. Preserve a backup/evidence digest of the SAME existing attempts.sqlite3 and
   all original attempts/events/persistence_recovery_runs. Never create/reset a
   ledger, substitute a media SHA, refund the first USD3, or edit old rows.
2. Inspect original PERSISTED/calls=1, intact complete HTTP400 capture, failed
   artifact refs and empty global pilot_slot. Match parent grant/run/response
   hash against the operator's original evidence. UNKNOWN/uncertain means STOP.
3. Install reviewed pinned code/schema through the existing Root process; retain
   the ledger inode, roots, source identity, project/SA/model/global/v1beta1.
   Refresh policy.version_pins with worker.version_pins(). No agent installation.
4. Prepare exact manifest/request digest and DISTINCT grant/approval. Add signed
   successor={decision: AUTHORIZE_ONE_SUCCESSOR_AFTER_KNOWN_HTTP400,
   parent_grant_id: original grant, parent_run_id: original attempt UUID,
   parent_response_sha256: SHA256 of ledger capture bytes,
   approval_id: current authority.approval_id}. limits: max_calls=1,
   gross_budget='3', currency='USD'. Human approval pins FULL canonical grant.
   Use existing external Root signer and a fresh grant-bound token descriptor
   where applicable; never reuse the first approval/token. Pin current artifacts.
5. Existing worker CLI: python3 operations/reels-pilot/worker.py run MANIFEST GRANT
   --executor-id OPERATOR. The signed successor selects the second namespace;
   reserve and additive tables are committed in the SAME DB. Global slot stays
   shared; UNKNOWN is durable before auth or provider. No retry or third attempt.
6. Inspect both rows: two distinct grants/runs, calls <=1 each, USD6 gross total;
   all original rows/events/recovery rows/raw bytes/refs unchanged. Preserve both
   immutable artifact versions. On UNKNOWN STOP without resend/refund. On saved
   response use the same CLI with recover and the EXACT corresponding envelope
   and manifest (even after token expiry/deletion). Legacy envelope selects first;
   successor envelope selects second. Recovery does not read media/auth/provider.

The unit tests below exercise same-DB transitions without cryptography. Signed
pipeline tests use the unchanged real synthetic signer; missing openssl is a hard
fixture failure, NOT a skip or simulated signature success.
"""
import base64
import copy
import datetime as dt
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest import mock

import test_approval_ledger as fixtures
import test_api_token as tokens
import test_worker_provider as integration
import approval
from ledger import Ledger, LedgerDenied


class SecondAttemptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / 'attempts.sqlite3'
        self.ledger = Ledger(self.path, create=True)
        self.now = dt.datetime.now(dt.timezone.utc)
        self.first = fixtures.fixture_grant(self.root, self.now)
        self.first['limits']['gross_budget'] = '3'
        self.digest = self.first['bindings']['media']['sha256']
        self.ledger.reserve(self.capability(self.first))
        self.ledger.begin_dispatch(self.digest, now=self.now)
        capture = {'http_status': 400, 'body_base64': base64.b64encode(b'{"error":{"code":400}}').decode(),
                   'truncated': False, 'headers': {'content-type': 'application/json'}}
        self.ledger.receive(self.digest, approval.canonical(capture))
        self.ledger.mark_persisted(self.digest, {'analysis_state': 'failed'})
        self.before = self.snapshot()
        parent = self.ledger.get(self.digest)
        self.second = copy.deepcopy(self.first)
        self.second['grant_id'] = 'pilot-' + uuid.uuid4().hex
        self.second['authority']['approval_id'] = uuid.uuid4().hex
        self.second['successor'] = {'decision': 'AUTHORIZE_ONE_SUCCESSOR_AFTER_KNOWN_HTTP400',
            'parent_grant_id': parent['grant_id'], 'parent_run_id': parent['run_id'],
            'parent_response_sha256': parent['response_sha256'],
            'approval_id': self.second['authority']['approval_id']}

    def tearDown(self):
        self.tmp.cleanup()

    def capability(self, grant):
        # Deliberately bypass only cryptography for ledger unit coverage.
        return approval.VerifiedGrant(approval.canonical(approval.validate_document(grant)), approval._VERIFIED)

    def snapshot(self):
        with sqlite3.connect(self.path) as db:
            return [db.execute('SELECT * FROM ' + table).fetchall()
                    for table in ('attempts', 'events', 'persistence_recovery_runs')]

    def selected(self, grant=None):
        return self.ledger.select((grant or self.second)['grant_id'])

    def test_two_calls_six_dollars_immutable_parent(self):
        second = self.selected()
        second.reserve(self.capability(self.second))
        second.begin_dispatch(self.digest, now=self.now)
        self.assertEqual(Ledger(self.path, attempt_grant_id=self.second['grant_id']).get(self.digest)['state'], 'UNKNOWN')
        second.receive(self.digest, b'synthetic second response')
        second.mark_persisted(self.digest, {'analysis_state': 'needs_review'})
        first_row, second_row = self.ledger.get(self.digest), second.get(self.digest)
        self.assertEqual(first_row['calls'] + second_row['calls'], 2)
        self.assertEqual(Decimal(first_row['gross_reserved']) + Decimal(second_row['gross_reserved']), Decimal('6'))
        self.assertNotEqual(first_row['run_id'], second_row['run_id'])
        self.assertNotEqual(first_row['grant_id'], second_row['grant_id'])
        self.assertEqual(self.snapshot(), self.before)

    def test_all_parent_proof_tampering_denied(self):
        for key, value in [('parent_grant_id', 'pilot-wrong'), ('parent_run_id', str(uuid.uuid4())),
                           ('parent_response_sha256', 'f'*64), ('approval_id', 'wrong')]:
            changed = copy.deepcopy(self.second); changed['successor'][key] = value
            with self.subTest(key=key), self.assertRaises((LedgerDenied, approval.ApprovalDenied)):
                self.selected(changed).reserve(self.capability(changed))
        self.assertEqual(self.snapshot(), self.before)

    def test_wrong_media_target_and_reused_approval_denied(self):
        for mutate in [lambda g: g['bindings']['media'].update(id='alias'),
                       lambda g: g['bindings']['target'].update(project='other'),
                       lambda g: (g['authority'].update(approval_id=self.first['authority']['approval_id']),
                                  g['successor'].update(approval_id=self.first['authority']['approval_id']))]:
            changed = copy.deepcopy(self.second); mutate(changed)
            with self.assertRaises(LedgerDenied):
                self.selected(changed).reserve(self.capability(changed))

    def test_unknown_uncertain_and_non400_parent_denied(self):
        for state in ['UNKNOWN', 'RESERVED', 'PERSISTENCE_UNCERTAIN', 'RESULT_RECEIVED_NOT_PERSISTED']:
            with sqlite3.connect(self.path) as db:
                db.execute('UPDATE attempts SET state=?', (state,))
            with self.subTest(state=state), self.assertRaises(LedgerDenied):
                self.selected().reserve(self.capability(self.second))
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE attempts SET state='PERSISTED',response=?", (b'corrupt',))
        with self.assertRaises(LedgerDenied):
            self.selected().reserve(self.capability(self.second))
        for status in (200, 403):
            with self.subTest(http_status=status):
                capture = approval.canonical({
                    'http_status': status,
                    'body_base64': base64.b64encode(b'{"error":{"code":400}}').decode(),
                    'truncated': False, 'headers': {'content-type': 'application/json'}})
                capture_sha = integration.sha(capture)
                changed = copy.deepcopy(self.second)
                changed['successor']['parent_response_sha256'] = capture_sha
                with sqlite3.connect(self.path) as db:
                    db.execute("UPDATE attempts SET state='PERSISTED',response=?,response_sha256=?",
                               (capture, capture_sha))
                parent = self.ledger.get(self.digest)
                raw = self.ledger.recover_response(self.digest)
                self.assertEqual(parent['response_sha256'], integration.sha(raw))
                self.assertEqual(json.loads(raw)['http_status'], status)
                snapshot = self.snapshot()
                with self.assertRaisesRegex(LedgerDenied, 'integrity checked complete known HTTP400 required'):
                    self.selected(changed).reserve(self.capability(changed))
                self.assertEqual(self.snapshot(), snapshot)

    def test_explicit_selector_and_proof_required(self):
        with self.assertRaises(LedgerDenied):
            self.ledger.reserve(self.capability(self.second))
        changed = copy.deepcopy(self.second); changed.pop('successor')
        with self.assertRaises(LedgerDenied):
            self.selected().reserve(self.capability(changed))
        with self.assertRaises(approval.ApprovalDenied):
            changed = copy.deepcopy(self.second); changed['limits']['gross_budget'] = '2'
            self.capability(changed)

    def test_second_unknown_no_replay_sibling_third_denied(self):
        second = self.selected(); second.reserve(self.capability(self.second))
        second.begin_dispatch(self.digest, now=self.now)
        with self.assertRaises(LedgerDenied): second.begin_dispatch(self.digest, now=self.now)
        with self.assertRaises(LedgerDenied): second.reserve(self.capability(self.second))
        sibling = copy.deepcopy(self.second); sibling['grant_id'] = 'pilot-sibling'
        with self.assertRaises(LedgerDenied): self.selected(sibling).get(self.digest)
        with self.assertRaises(LedgerDenied): self.selected(sibling).reserve(self.capability(sibling))
        second.receive(self.digest, b'synthetic response'); second.mark_persisted(self.digest, {'ok': True})
        with self.assertRaises(LedgerDenied): self.selected(sibling).reserve(self.capability(sibling))
        third = copy.deepcopy(sibling)
        third['successor']['parent_grant_id'] = self.second['grant_id']
        with self.assertRaises(LedgerDenied): self.selected(third).reserve(self.capability(third))
        self.assertEqual(self.snapshot(), self.before)

    def test_global_transaction_excludes_concurrent_sibling(self):
        # Deterministic interleaving: hold actual DB writer lock, no new workers.
        with sqlite3.connect(self.path, isolation_level=None) as db:
            db.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError):
                self.selected().reserve(self.capability(self.second))
            db.rollback()
        self.selected().reserve(self.capability(self.second))
        with self.assertRaises(LedgerDenied): self.selected().reserve(self.capability(self.second))

    def test_independent_recovery_versions(self):
        second = self.selected(); second.reserve(self.capability(self.second))
        second.begin_dispatch(self.digest, now=self.now); second.receive(self.digest, b'synthetic response')
        previous = second.get(self.digest)['run_id']
        fresh = second.begin_persistence_recovery(self.digest, previous_run_id=previous, reason='synthetic partial')
        second.mark_persisted(self.digest, {'artifact': fresh}, persistence_run_id=fresh)
        self.assertEqual(second.recover_response(self.digest), b'synthetic response')
        self.assertEqual(self.snapshot(), self.before)


class SignedSecondPipelineTests(unittest.TestCase):
    setUp = integration.WorkerProviderTests.setUp
    tearDown = integration.WorkerProviderTests.tearDown
    sign = integration.WorkerProviderTests.sign
    pipeline = integration.WorkerProviderTests.pipeline

    def prepare_second(self):
        first, fake = self.pipeline(integration.Response(400, b'{"error":{"code":400}}', {'content-type':'application/json'}))
        out = first.run(self.manifest, self.envelope, executor_id='synthetic-first')
        before = first.ledger.get(integration.sha(self.data))
        grant = copy.deepcopy(self.grant)
        grant['grant_id'] = 'pilot-synthetic-second'
        grant['authority']['approval_id'] = 'synthetic-second-approval'
        grant['successor'] = {'decision':'AUTHORIZE_ONE_SUCCESSOR_AFTER_KNOWN_HTTP400',
            'parent_grant_id':before['grant_id'], 'parent_run_id':before['run_id'],
            'parent_response_sha256':before['response_sha256'], 'approval_id':grant['authority']['approval_id']}
        return out, before, self.sign(grant), fake

    def test_signed_two_versions_and_expired_deleted_token_zero_io_recovery(self):
        out, before, envelope, fake = self.prepare_second()
        first_policy, first_envelope = copy.deepcopy(self.policy), copy.deepcopy(self.envelope)
        def legacy_snapshot():
            with sqlite3.connect(first_policy['ledger_path']) as db:
                return [db.execute('SELECT * FROM ' + table).fetchall()
                        for table in ('attempts', 'events', 'persistence_recovery_runs')]
        original = legacy_snapshot()
        now = dt.datetime.now(dt.timezone.utc)
        token_fixture = tokens.ApiTokenTests()
        self.addCleanup(token_fixture.doCleanups)
        token_fixture.setUp()
        with mock.patch.object(tokens.Clock, 'now', return_value=now):
            token_fixture.d.update(
                issued_at=(now-dt.timedelta(seconds=1)).isoformat(),
                expires_at=(now+dt.timedelta(minutes=10)).isoformat(),
                target_service_account=first_policy['target']['service_account'],
                quota_project=first_policy['target']['project'],
                grant_reference=envelope['grant']['grant_id'])
            token_fixture.payload = {key: token_fixture.d[key] for key in tokens.api.BINDINGS}
            token_fixture.payload.update(purpose='api-token-v1', access_token='DUMMY-NOT-A-CREDENTIAL')
            token_fixture.write()
            self.assertTrue(token_fixture.path.is_file())
            second_policy = copy.deepcopy(first_policy)
            second_policy['authentication'] = copy.deepcopy(token_fixture.d)
            grant = copy.deepcopy(envelope['grant'])
            grant['bindings'] = integration.worker.observed_bindings(second_policy, self.task)
            envelope = self.sign(grant)
            fake2 = integration.FakeProvider()
            second = integration.worker.Pipeline(second_policy, synthetic=True, transport=fake2)
            source = token_fixture.source()
            digest = integration.sha(self.data)
            def consume_token():
                self.assertEqual(second.ledger.get(digest)['state'], 'UNKNOWN')
                self.assertEqual(source.token(), token_fixture.payload['access_token'])
                return 'SYNTHETIC-NO-GOOGLE-CREDENTIAL'
            second.auth = mock.Mock(side_effect=consume_token)
            with mock.patch.object(tokens.api.os, 'read', wraps=tokens.api.os.read) as read:
                out2 = second.run(self.manifest, envelope, executor_id='synthetic-second')
                self.assertGreater(read.call_count, 0)
            second.auth.assert_called_once_with()
            with self.assertRaises(tokens.api.ApiTokenDenied):
                source.token()
            self.assertNotEqual(out['artifact_prefix'], out2['artifact_prefix'])
            self.assertEqual((fake.calls, fake2.calls), (1, 1))
            self.assertEqual(legacy_snapshot(), original)
            token_fixture.path.unlink()
            self.assertFalse(token_fixture.path.exists())
        future = now + dt.timedelta(hours=2)
        self.assertGreater(future, dt.datetime.fromisoformat(token_fixture.d['expires_at']))
        fake3, fake4 = integration.FakeProvider(), integration.FakeProvider()
        with mock.patch.object(tokens.Clock, 'now', return_value=future), \
                mock.patch.object(integration.worker, 'token_source', side_effect=AssertionError('token source')) as token_source, \
                mock.patch.object(integration.provider, 'DirectTransport', side_effect=AssertionError('provider')) as transport, \
                mock.patch.object(integration.worker.Pipeline, '_source', side_effect=AssertionError('media')) as media, \
                mock.patch.object(tokens.api.TemporaryTokenSource, 'token', side_effect=AssertionError('token read')) as read:
            again = integration.worker.Pipeline(first_policy, synthetic=True, transport=fake3)
            restarted_second = integration.worker.Pipeline(second_policy, synthetic=True, transport=fake4)
            again.auth = mock.Mock(side_effect=AssertionError('first auth'))
            restarted_second.auth = mock.Mock(side_effect=AssertionError('second auth'))
            self.assertEqual(again.recover(self.manifest, first_envelope, executor_id='recover'), out)
            self.assertEqual(restarted_second.recover(self.manifest, envelope, executor_id='recover'), out2)
            again.auth.assert_not_called(); restarted_second.auth.assert_not_called()
            token_source.assert_not_called(); transport.assert_not_called()
            media.assert_not_called(); read.assert_not_called()
        self.assertEqual((fake3.calls, fake4.calls), (0, 0))
        self.assertEqual((fake.calls, fake2.calls), (1, 1))
        self.assertEqual(again.ledger.select().get(integration.sha(self.data)), before)
        self.assertEqual(legacy_snapshot(), original)

    def test_signed_parent_tamper_before_provider(self):
        _, _, envelope, _ = self.prepare_second()
        envelope['grant']['successor']['parent_response_sha256'] = 'f'*64
        pipeline, fake = self.pipeline()
        with self.assertRaises(approval.ApprovalDenied):
            pipeline.run(self.manifest, envelope, executor_id='synthetic')
        self.assertEqual(fake.calls, 0)

    def test_second_timeout_restart_no_provider(self):
        _, _, envelope, _ = self.prepare_second()
        second, fake = self.pipeline(error=True)
        self.assertEqual(second.run(self.manifest, envelope, executor_id='synthetic')['state'], 'UNKNOWN')
        again, fake2 = self.pipeline()
        self.assertEqual(again.run(self.manifest, envelope, executor_id='synthetic')['state'], 'UNKNOWN')
        self.assertEqual((fake.calls, fake2.calls), (1, 0))


if __name__ == '__main__':
    unittest.main()
