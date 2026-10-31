"""Root-protected synthetic control fixtures; no productive ledger or network."""
import copy
import datetime as dt
import io
import os
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recurrence as r
import test_recurrence as fixtures
from test_worker_provider import FakeProvider, canonical, sha, worker


class ReservedReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.h = fixtures.RecurrenceTests('test_01_unsigned_batch_zero_provider')
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        self.q, self.f = self.h.q, self.h.f
        self.bid, self.mid = self.h.batch['batch_id'], self.f.task['reel_id']
        self.source = sha(self.f.data)
        self.stamp = r.now()
        old = copy.deepcopy(self.f.grant)
        for k in ('issued_at', 'not_before', 'expires_at'):
            old[k] = (r.approval._instant(old[k])-dt.timedelta(minutes=10)).isoformat()
        old['authority']['approved_at'] = (self.stamp-dt.timedelta(minutes=11)).isoformat()
        envelope = self.f.sign(old)
        pipeline = worker.Pipeline(self.f.policy, synthetic=True, transport=FakeProvider())
        checked = pipeline._verify(self.f.manifest, envelope, self.stamp-dt.timedelta(minutes=9))
        reserved = self.stamp-dt.timedelta(minutes=1)
        with mock.patch('ledger._now', return_value=reserved.isoformat()):
            self.q.ledger.reserve(checked, run_id='00000000-0000-4000-8000-000000000071')
        with self.q.ledger._transaction() as db:
            db.execute('INSERT INTO recurrence_slot VALUES(1,?,?)', (self.bid, self.mid))
            db.execute("UPDATE recurrence_members SET state='RUNNING',envelope_json=?,run_manifest_sha256=?,grant_id=?",
                       (canonical(envelope).decode(), sha(canonical(self.f.manifest)), old['grant_id']))
            # Retain a real campaign allocation row, without needing unrelated campaign authority.
            db.execute('INSERT INTO recurrence_campaign_allocations VALUES(?,?,?,?,?,?,1)',
                       ('synthetic-campaign', self.bid, self.mid, self.source, old['grant_id'], '3'))
            attempt = dict(db.execute('SELECT * FROM attempts').fetchone())
            member = dict(db.execute('SELECT * FROM recurrence_members').fetchone())
            events = [dict(x) for x in db.execute('SELECT sequence,event,at,details FROM events')]
            allocations = [dict(x) for x in db.execute('SELECT * FROM recurrence_campaign_allocations')]
        stopped = {'state': 'STOPPED', 'error_type': 'LedgerDenied', 'retry_allowed': False}
        finished = (reserved+dt.timedelta(seconds=1)).isoformat()
        self.evidence = {
            'worker-result.json': {'result': stopped, 'exit': 1, 'automatic_retry': False,
                'timed_out': False, 'finished_at': finished, 'worker_pid': 2147483647},
            'worker.stdout': stopped,
            'run-started.json': {'grant_id': old['grant_id'], 'retry': False, 'started_at': old['not_before']},
            'signed-control.json': {'grant_id': old['grant_id'], 'expires_at': old['expires_at'],
                'grant_signature_verified': True, 'token_bytes_read': False, 'new_generateContent_POSTs': 0,
                'token_expires_at': old['expires_at'], 'policy_sha256': 'a'*64},
            'token-cleanup.json': {'encrypted_envelope_removed': True, 'private_key_removed': True, 'token_copy_removed': True},
            'IAM-cleanup.json': {'SDK_cleanup_verified': True, 'creator_removed': True,
                'inference_binding_removed': True, 'other_bindings_preserved': True,
                'member_id': self.mid, 'operation_id': 'synthetic-operation', 'checked_at': finished}}
        self.base = self.h.control/self.bid
        self.path = self.base/(self.mid+'.reconcile.json')
        self.proof = {'decision': 'RECONCILE_EXPIRED_BEFORE_DISPATCH', 'batch_id': self.bid,
            'member_id': self.mid, 'source_sha256': self.source, 'grant_id': old['grant_id'],
            'run_id': attempt['run_id'], 'expected_member_state': 'RUNNING', 'expected_attempt_state': 'RESERVED',
            'ledger_identity': self.f.policy['ledger_identity'], 'batch_manifest_sha256': self.h.digest,
            'run_manifest_sha256': member['run_manifest_sha256'], 'request_sha256': attempt['request_sha256'],
            'attempt_sha256': sha(canonical(attempt)), 'member_before': member, 'events': events,
            'allocations': allocations, 'approved_at': self.stamp.isoformat(),
            'expires_at': (self.stamp+dt.timedelta(minutes=5)).isoformat(), 'approved_by': 'synthetic-root-auditor',
            'process_audit': {'complete': True, 'no_active_consumers': True, 'exclusive_operator_maintenance': True,
                'worker_pid': 2147483647, 'checked_at': finished}, 'evidence': {}}
        self.args = {k:self.proof[k] for k in ('source_sha256', 'grant_id', 'run_id', 'expected_member_state', 'expected_attempt_state')}
        self.write()

    def write(self):
        for name, value in self.evidence.items():
            p = self.base/(self.mid+'.reconcile-evidence')/name
            self.h.write_receipt(p, value)
            self.proof['evidence'][name] = sha(p.read_bytes())
        self.h.write_receipt(self.path, self.proof)

    def reconcile(self, **changes):
        return self.q.reconcile_no_dispatch(self.bid, self.mid, **dict(self.args, **changes))

    def snapshot(self):
        with self.q.ledger._transaction() as db:
            return tuple(tuple(tuple(x) for x in db.execute('SELECT * FROM '+table)) for table in
                ('attempts', 'events', 'recurrence_members', 'recurrence_slot', 'pilot_slot', 'recurrence_campaign_allocations'))

    def denied_unchanged(self):
        before = self.snapshot()
        with self.assertRaises(Exception): self.reconcile()
        self.assertEqual(before, self.snapshot())

    def test_permitted_control_preserves_attempt_accounting_history(self):
        before = self.snapshot()
        out = self.reconcile()
        after = self.snapshot()
        self.assertEqual(out['kind'], 'NO_DISPATCH_RECONCILED')
        self.assertEqual((out['state'], out['provider_calls']), ('BLOCKED', 0))
        self.assertEqual(before[0], after[0]); self.assertEqual(before[5], after[5])
        self.assertEqual(before[1], after[1][:1]); self.assertEqual(len(after[1]), 2)
        self.assertEqual(after[3:5], ((), ()))
        self.assertEqual(self.q.status(self.bid)[0]['persisted'], 0)
        self.assertEqual(self.q.status(self.bid)[0]['cleanup'], 1)

    def test_exact_repeat_no_writes_even_expired(self):
        out = self.reconcile(); before = self.snapshot()
        modified = self.q.ledger.path.stat().st_mtime_ns
        with mock.patch.object(r, 'now', return_value=self.stamp+dt.timedelta(days=1)):
            self.assertEqual(out, self.reconcile())
        self.assertEqual(before, self.snapshot())
        self.assertEqual(modified, self.q.ledger.path.stat().st_mtime_ns)

    def test_explicit_wrong_selectors(self):
        for k, v in [('source_sha256', 'f'*64), ('grant_id', 'pilot-wrong'), ('run_id', 'wrong'),
                     ('expected_member_state', 'BLOCKED'), ('expected_attempt_state', 'UNKNOWN')]:
            before = self.snapshot()
            with self.subTest(k=k), self.assertRaises(Exception): self.reconcile(**{k:v})
            self.assertEqual(before, self.snapshot())
        for bid, mid in [('wrong', self.mid), (self.bid, 'wrong')]:
            with self.assertRaises(Exception): self.q.reconcile_no_dispatch(bid, mid, **self.args)

    def test_wrong_proof_identity_bindings_and_states(self):
        original = copy.deepcopy(self.proof)
        for key in ('batch_id', 'member_id', 'source_sha256', 'grant_id', 'run_id', 'expected_member_state',
                    'expected_attempt_state', 'batch_manifest_sha256', 'run_manifest_sha256', 'request_sha256', 'attempt_sha256'):
            self.proof = copy.deepcopy(original); self.proof[key] = 'wrong'; self.write()
            with self.subTest(key=key): self.denied_unchanged()

    def test_calls_sent_uncertain_response_refs_or_timestamps(self):
        for column, value in [('calls', 1), ('state', 'UNKNOWN'), ('started_at', self.stamp.isoformat()),
                ('received_at', self.stamp.isoformat()), ('persisted_at', self.stamp.isoformat()),
                ('response', b'uncertain'), ('response_sha256', 'f'*64), ('refs_json', '{}'), ('problem', 'unknown')]:
            with self.q.ledger._transaction() as db:
                old = db.execute('SELECT '+column+' FROM attempts').fetchone()[0]
                db.execute('UPDATE attempts SET '+column+'=?', (value,))
            with self.subTest(column=column): self.denied_unchanged()
            with self.q.ledger._transaction() as db: db.execute('UPDATE attempts SET '+column+'=?', (old,))

    def test_nonexpired_reservation_refused_even_with_rebound_snapshot(self):
        with self.q.ledger._transaction() as db:
            db.execute('UPDATE attempts SET reserved_at=expires_at')
            self.proof['attempt_sha256'] = sha(canonical(dict(db.execute('SELECT * FROM attempts').fetchone())))
        self.write(); self.denied_unchanged()

    def test_unknown_or_changed_event_refused(self):
        with self.q.ledger._transaction() as db:
            db.execute("INSERT INTO events(source_sha256,event,at,details) VALUES(?,'UNRECOGNIZED',?,'{}')", (self.source, self.stamp.isoformat()))
        self.denied_unchanged()

    def test_exact_event_snapshot_and_reserve_order(self):
        original = copy.deepcopy(self.proof)
        for key, value in [('sequence', 999), ('details', '{"unknown":true}'), ('at', '2000-01-01T00:00:00Z'), ('event', 'IO_STARTED_UNKNOWN')]:
            self.proof = copy.deepcopy(original); self.proof['events'][0][key] = value; self.write()
            with self.subTest(key=key): self.denied_unchanged()

    def test_evidence_hash_missing_or_changed(self):
        self.proof['evidence']['worker.stdout'] = '0'*64
        self.h.write_receipt(self.path, self.proof); self.denied_unchanged()
        self.write()
        (self.base/(self.mid+'.reconcile-evidence')/'worker-result.json').unlink()
        self.denied_unchanged()

    def test_insufficient_no_send_exit_cleanup_evidence(self):
        original = copy.deepcopy(self.evidence)
        cases = [('worker-result.json', 'exit', 0), ('worker-result.json', 'timed_out', True),
                 ('worker-result.json', 'automatic_retry', True), ('worker-result.json', 'finished_at', '2000-01-01T00:00:00Z'),
                 ('worker.stdout', 'state', 'UNKNOWN'), ('run-started.json', 'grant_id', 'wrong'),
                 ('signed-control.json', 'token_bytes_read', True), ('signed-control.json', 'new_generateContent_POSTs', True),
                 ('signed-control.json', 'grant_signature_verified', False), ('token-cleanup.json', 'private_key_removed', False),
                 ('IAM-cleanup.json', 'other_bindings_preserved', False), ('IAM-cleanup.json', 'member_id', 'wrong')]
        for name, key, value in cases:
            self.evidence = copy.deepcopy(original); self.evidence[name][key] = value; self.write()
            with self.subTest(name=name, key=key): self.denied_unchanged()

    def test_root_protection_symlink_writable_and_unprotected_boolean(self):
        self.path.chmod(0o666); self.denied_unchanged(); self.path.chmod(0o640)
        self.path.unlink(); self.path.symlink_to(self.h.receipt); self.denied_unchanged()

    def test_active_unverifiable_or_stale_worker(self):
        for key in ('complete', 'no_active_consumers', 'exclusive_operator_maintenance'):
            self.proof['process_audit'][key] = False; self.write(); self.denied_unchanged()
            self.proof['process_audit'][key] = True
        self.evidence['worker-result.json']['worker_pid'] = os.getpid()
        self.proof['process_audit']['worker_pid'] = os.getpid(); self.write(); self.denied_unchanged()

    def test_expired_control_and_stale_audit(self):
        with mock.patch.object(r, 'now', return_value=self.stamp+dt.timedelta(minutes=6)):
            self.denied_unchanged()
        self.proof['process_audit']['checked_at'] = '2000-01-01T00:00:00Z'; self.write(); self.denied_unchanged()

    def test_slots_changed_refused(self):
        with self.q.ledger._transaction() as db: db.execute("UPDATE recurrence_slot SET member_id='other'")
        self.denied_unchanged()
        with self.q.ledger._transaction() as db:
            db.execute('UPDATE recurrence_slot SET member_id=?', (self.mid,)); db.execute('DELETE FROM pilot_slot')
        self.denied_unchanged()

    def test_allocation_change_refused(self):
        with self.q.ledger._transaction() as db: db.execute("UPDATE recurrence_campaign_allocations SET gross_USD='2'")
        self.denied_unchanged()

    def test_concurrent_transaction_refused(self):
        before = self.snapshot()
        with self.q.ledger._transaction():
            with self.assertRaises(sqlite3.OperationalError): self.reconcile()
        self.assertEqual(before, self.snapshot())

    def test_atomic_rollback_after_event_and_member_update(self):
        with self.q.ledger._transaction() as db:
            db.execute("CREATE TRIGGER synthetic_failure BEFORE DELETE ON pilot_slot BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
        self.denied_unchanged()

    def test_receipt_race_refused(self):
        real = r.protected
        def changing(path):
            answer = real(path)
            if Path(path) == self.path:
                changed = copy.deepcopy(self.proof); changed['approved_by'] = 'changed'
                self.h.write_receipt(self.path, changed)
            return answer
        with mock.patch.object(r, 'protected', side_effect=changing): self.denied_unchanged()

    def test_repeat_changed_proof_or_later_state_refused(self):
        self.reconcile()
        self.proof['approved_by'] = 'changed'; self.write(); self.denied_unchanged()
        self.proof['approved_by'] = 'synthetic-root-auditor'; self.write()
        with self.q.ledger._transaction() as db: db.execute("UPDATE recurrence_members SET review=1")
        self.denied_unchanged()

    def test_later_event_invalidates_marker_and_barrier(self):
        self.reconcile()
        with self.q.ledger._transaction() as db:
            db.execute("INSERT INTO events(source_sha256,event,at,details) VALUES(?,'LATER',?,'{}')", (self.source, self.stamp.isoformat()))
        self.denied_unchanged()

    def test_arbitrary_marker_does_not_bypass_barrier(self):
        with self.q.ledger._transaction() as db:
            db.execute("INSERT INTO events(source_sha256,event,at,details) VALUES(?,'NO_DISPATCH_RECONCILED',?,'{}')", (self.source, self.stamp.isoformat()))
            with self.assertRaises(Exception): self.q._no_dispatch_proof(db, self.source)
        self.denied_unchanged()

    def test_original_source_never_rearmed(self):
        self.reconcile()
        with self.q.ledger._transaction() as db:
            with self.assertRaises(Exception): self.q._prior(db, self.h.batch['members'][0])
        fake = FakeProvider()
        with self.assertRaises(Exception): self.q.run_one(self.bid, self.f.envelope, executor_id='no-rearm', transport=fake)
        self.assertEqual(fake.calls, 0)
        pipeline = worker.Pipeline(self.f.policy, synthetic=True, transport=FakeProvider())
        checked = pipeline._verify(self.f.manifest, self.f.envelope, r.now())
        with self.assertRaises(Exception): self.q.ledger.reserve(checked)

    def test_next_eligible_runs_only_after_proper_control(self):
        task = copy.deepcopy(self.f.task); task['reel_id'] = 'synthetic-next'
        data = self.f.data+b' next'; metadata = canonical({'id': task['reel_id'], 'synthetic': True})
        directory = self.f.root/'media/media/reels/synthetic-next'; directory.mkdir(parents=True)
        (directory/'video.mp4').write_bytes(data); (directory/'metadata.json').write_bytes(metadata)
        task['source'].update(relative_video_path='media/reels/synthetic-next/video.mp4',
            relative_metadata_path='media/reels/synthetic-next/metadata.json', source_video_sha256=sha(data),
            metadata_sha256=sha(metadata), declared_bytes=len(data))
        manifest = {'manifest_version': 'reels-pilot-run.v2', 'task': task, 'request_sha256': sha(worker.provider.request_bytes(task, data))}
        batch = copy.deepcopy(self.h.batch); batch['batch_id'] = 'synthetic-next-batch'; batch['members'][0]['manifest'] = manifest
        self.h.history_receipt(batch)
        with self.assertRaises(Exception): self.q.prepare(batch)
        self.reconcile()
        digest = self.q.prepare(batch)
        receipt = self.h.write_receipt(self.h.control/'next-approval.json', dict(self.h.approval(), batch_id=batch['batch_id'], manifest_sha256=digest))
        self.q.authorize(batch['batch_id'], receipt)
        grant = copy.deepcopy(self.f.grant)
        grant.update(grant_id='pilot-synthetic-next', bindings=worker.observed_bindings(self.f.policy, task),
            manifest_sha256=sha(canonical(manifest)), request_sha256=manifest['request_sha256'])
        fake = FakeProvider()
        result = self.q.run_one(batch['batch_id'], self.f.sign(grant), executor_id='synthetic', transport=fake)
        self.assertEqual((result['state'], fake.calls), ('PERSISTED', 1))
        self.assertEqual(self.snapshot()[5], tuple(tuple(x.values()) for x in self.proof['allocations']))
        self.assertEqual(self.reconcile()['kind'], 'NO_DISPATCH_RECONCILED')

    def test_cli_explicit_command_and_missing_selector_fail_closed(self):
        argv = ['recurrence', 'reconcile-no-dispatch', self.bid, '--member-id', self.mid]
        for key, value in self.args.items(): argv += ['--'+key.replace('_', '-'), value]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(r.worker, 'load_policy', return_value=self.f.policy), \
             mock.patch.object(r, 'Queue', return_value=self.q), mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(r.main(), 0)
            self.assertIn('NO_DISPATCH_RECONCILED', out.getvalue())
        with mock.patch.object(sys, 'argv', argv[:-2]), mock.patch.object(r.worker, 'load_policy', return_value=self.f.policy), \
             mock.patch.object(r, 'Queue', return_value=self.q), mock.patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(r.main(), 1)


if __name__ == '__main__':
    unittest.main()
