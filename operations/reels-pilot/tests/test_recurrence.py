"""Offline queue tests. Actual Ed25519/Ledger/Pipeline, synthetic bytes only.

Root-owned synthetic receipts live under /opt; protected() is never patched.
"""
from contextlib import nullcontext
import copy
import datetime as dt
from itertools import repeat
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recurrence as r
import test_worker_provider as fixturemodule
from test_worker_provider import FakeProvider, worker, canonical, sha, Response


class RecurrenceTests(unittest.TestCase):
    def setUp(self):
        self.f = fixturemodule.WorkerProviderTests(methodName='test_full_chain_and_restart_preserve_exact_result')
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.f.manifest['manifest_version'] = 'reels-pilot-run.v2'
        self.f.grant['manifest_sha256'] = sha(canonical(self.f.manifest))
        self.f.envelope = self.f.sign(self.f.grant)
        self.control_tmp = tempfile.TemporaryDirectory(prefix='synthetic-recurrence-', dir='/etc')
        self.addCleanup(self.control_tmp.cleanup)
        self.control = Path(self.control_tmp.name)
        control_patch = mock.patch.object(r, 'CONTROL', self.control)
        control_patch.start(); self.addCleanup(control_patch.stop)
        self.schema = self.control/'schema-approval.json'
        self.schema_value = {'decision': 'APPLY_REELS_QUEUE_SCHEMA',
                             'ledger_identity': self.f.policy['ledger_identity'],
                             'schema_sha256': sha(canonical(r.SCHEMA_SQL)),
                             'version_pins_sha256': sha(canonical(self.f.policy['version_pins']))}
        self.write_receipt(self.schema, self.schema_value)
        self.q = r.Queue(self.f.policy, bootstrap=True, synthetic=True)
        self.batch = {'batch_id': 'synthetic-batch', 'members': [{
            'manifest': self.f.manifest, 'target': self.f.policy['target'],
            'max_calls': 1, 'max_gross_USD': '3', 'currency': 'USD'}],
            'currency': 'USD', 'max_calls': 1, 'max_gross_USD': '3',
            'wip': 1, 'retries': 0, 'fallback': False}
        self.history_receipt(self.batch)
        self.digest = self.q.prepare(self.batch)
        self.receipt = self.control/'batch.json'
        self.receipt.write_bytes(canonical(self.approval()))
        self.receipt.chmod(0o640)

    def write_receipt(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical(value)); path.chmod(0o640)
        return path

    def history_receipt(self, batch, **changes):
        value = {'decision': 'CONFIRM_REELS_HISTORY', 'batch_id': batch['batch_id'],
                 'manifest_sha256': sha(canonical(batch)),
                 'roots': {key: self.f.policy['roots'][key] for key in ('media_root', 'result_root')},
                 'checked_at': r.now().isoformat(), 'complete': True}
        value.update(changes)
        return self.write_receipt(self.control/batch['batch_id']/'history.json', value)

    def approval(self):
        return {'decision': 'APPROVE_REELS_BATCH', 'batch_id': 'synthetic-batch',
                'manifest_sha256': self.digest, 'approval_id': self.f.grant['authority']['approval_id'],
                'approved_by': self.f.grant['authority']['approver'],
                'approved_at': self.f.grant['authority']['approved_at'],
                'expires_at': (r.approval._instant(self.f.grant['expires_at'])+dt.timedelta(minutes=1)).isoformat(),
                'rights_and_global_privacy_accepted': True, 'max_calls': 1, 'max_gross_USD': '3'}

    def authorize(self):
        self.q.authorize('synthetic-batch', self.receipt)

    def run(self, result=None):
        # unittest.TestCase.run must not be replaced by a helper.
        return super().run(result)

    def execute(self, fake=None, hook=None):
        fake = fake or FakeProvider()
        result = self.q.run_one('synthetic-batch', self.f.envelope, executor_id='offline-fixture',
                                transport=fake, writer_hook=hook)
        return result, fake

    def cleanup_receipt(self, **changes):
        with self.q.ledger._transaction() as db:
            row = dict(db.execute('SELECT * FROM recurrence_members').fetchone())
        value = {'decision': 'CLOSE_REELS_MEMBER', 'batch_id': 'synthetic-batch',
                 'member_id': self.f.task['reel_id'], 'grant_id': self.f.grant['grant_id'],
                 'source_sha256': sha(self.f.data), 'worker_result_sha256': sha(row['result_json'].encode()),
                 'cleaned_at': r.now().isoformat(), 'token_copy_removed': True,
                 'temporary_bindings_removed': True, 'other_bindings_preserved': True}
        value.update(changes)
        path = self.control/'cleanup.json'; path.write_bytes(canonical(value)); path.chmod(0o640)
        return path

    def test_01_unsigned_batch_zero_provider(self):
        fake = FakeProvider()
        with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.q.status('synthetic-batch')[0]['state'], 'PENDING')

    def test_02_bad_tampered_expired_receipts(self):
        for key, value in [('decision', 'YES'), ('manifest_sha256', '0'*64),
                           ('expires_at', '2000-01-01T00:00:00Z'), ('max_calls', True),
                           ('rights_and_global_privacy_accepted', 1)]:
            bad = self.approval(); bad[key] = value
            self.receipt.write_bytes(canonical(bad))
            with self.subTest(key=key), self.assertRaises(Exception): self.authorize()
        self.receipt.write_bytes(canonical(self.approval())); self.authorize()
        self.receipt.write_bytes(canonical(dict(self.approval(), approved_by='tampered')))
        fake = FakeProvider()
        with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)

    def test_03_limits_strict_identity_and_finite(self):
        mutations = [lambda b: b.update(max_calls=True), lambda b: b.update(max_gross_USD='NaN'),
                     lambda b: b.update(max_gross_USD='10'), lambda b: b.update(wip=2),
                     lambda b: b.update(retries=1), lambda b: b.update(fallback=True),
                     lambda b: b['members'][0]['target'].update(model='other'),
                     lambda b: b['members'][0]['target'].update(project='other'),
                     lambda b: b['members'][0]['manifest']['task']['source'].update(declared_duration_seconds=True),
                     lambda b: b['members'][0].update(max_gross_USD='4')]
        for mutate in mutations:
            b = copy.deepcopy(self.batch); mutate(b)
            with self.assertRaises(Exception): self.q.prepare(b)

    def test_04_idempotent_and_no_expand(self):
        self.assertEqual(self.q.prepare(self.batch), self.digest)
        changed = copy.deepcopy(self.batch); changed['members'][0]['manifest']['task']['task_id'] = 'changed'
        with self.assertRaises(Exception): self.q.prepare(changed)

    def test_05_queue_dedup(self):
        b = copy.deepcopy(self.batch); b['batch_id'] = 'other-batch'
        with self.assertRaises(Exception): self.q.prepare(b)
        self.assertEqual(len(self.q.status('synthetic-batch')), 1)

    def test_06_windows_history(self):
        path = self.f.root/'results/history-windows.json'
        path.write_bytes(canonical({'prior': {'source_sha256': sha(self.f.data)}}))
        with self.assertRaises(Exception): self.q._history(self.batch['members'][0])
        path.write_bytes(canonical({'reel_id': self.f.task['reel_id']}))
        with self.assertRaises(Exception): self.q._history(self.batch['members'][0])

    def test_07_signed_pipeline_success_restart_cleanup_no_acceptance(self):
        self.authorize(); out, fake = self.execute()
        self.assertEqual(out['state'], 'PERSISTED'); self.assertEqual(out['analysis_state'], 'needs_review')
        self.assertEqual(fake.calls, 1); self.assertIsNone(self.q.next('synthetic-batch'))
        status = self.q.status('synthetic-batch')[0]
        self.assertEqual((status['persisted'], status['cleanup'], status['state']), (1, 0, 'PERSISTED'))
        again = r.Queue(self.f.policy, synthetic=True); fake2 = FakeProvider()
        with mock.patch.object(r.worker.Pipeline, '_source', side_effect=AssertionError('media read')):
            recovered = again.recover('synthetic-batch', self.f.task['reel_id'], executor_id='restart', transport=fake2)
        self.assertEqual(out, recovered); self.assertEqual(fake2.calls, 0)
        receipt = self.cleanup_receipt()
        again.cleanup('synthetic-batch', self.f.task['reel_id'], receipt, executor_id='cleanup', transport=FakeProvider())
        status = again.status('synthetic-batch')[0]
        self.assertEqual((status['cleanup'], status['review'], status['state']), (1, 1, 'NEEDS_REVIEW'))
        self.assertIsNone(again.next('synthetic-batch'))
        with self.assertRaises(Exception): self.execute(FakeProvider())

    def test_08_forged_cleanup_holds_slot(self):
        self.authorize(); self.execute()
        for changes in ({'token_copy_removed': False}, {'worker_result_sha256': 'f'*64},
                        {'source_sha256': 'f'*64}, {'cleaned_at': '2000-01-01T00:00:00Z'}):
            receipt = self.cleanup_receipt(**changes)
            with self.assertRaises(Exception):
                self.q.cleanup('synthetic-batch', self.f.task['reel_id'], receipt, executor_id='cleanup', transport=FakeProvider())
            self.assertIsNone(self.q.next('synthetic-batch'))
            self.assertEqual(self.q.status('synthetic-batch')[0]['cleanup'], 0)

    def test_09_unknown_restart_never_resend(self):
        self.authorize(); out, fake = self.execute(FakeProvider(error=True))
        self.assertEqual(out['state'], 'UNKNOWN')
        again = r.Queue(self.f.policy, synthetic=True); fake2 = FakeProvider()
        out = again.recover('synthetic-batch', self.f.task['reel_id'], executor_id='restart', transport=fake2)
        self.assertEqual(out['state'], 'BLOCKED')
        with self.assertRaises(Exception): self.execute(fake2)
        self.assertEqual(fake.calls, 1); self.assertEqual(fake2.calls, 0)
        self.assertIsNone(again.next('synthetic-batch'))
        with self.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT gross_reserved,calls FROM attempts').fetchone()[:], ('3.00000000', 1))

    def test_10_durable_response_interruption_persistence_only(self):
        self.authorize()
        def fault(event, path, data):
            if event == 'before_write' and path.name == 'provenance.json': raise OSError('offline disk fault')
        fake = FakeProvider()
        with self.assertRaises(OSError): self.execute(fake, fault)
        again = r.Queue(self.f.policy, synthetic=True); fake2 = FakeProvider()
        with mock.patch.object(r.worker.Pipeline, '_source', side_effect=AssertionError('media')):
            out = again.recover('synthetic-batch', self.f.task['reel_id'], executor_id='restart', transport=fake2)
        self.assertEqual(out['state'], 'PERSISTED'); self.assertEqual(fake.calls, 1); self.assertEqual(fake2.calls, 0)
        self.assertIsNone(again.next('synthetic-batch'))

    def test_11_wip_and_concurrent_claim(self):
        self.authorize()
        with self.q.ledger._transaction() as db:
            db.execute('INSERT INTO recurrence_slot VALUES(1,?,?)', ('other', 'other'))
        fake = FakeProvider()
        with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)
        with self.q.ledger._transaction():
            with self.assertRaises(sqlite3.OperationalError): self.q.status('synthetic-batch')

    def test_12_prior_both_tables_and_rows_untouched(self):
        self.authorize(); self.execute()
        with self.q.ledger._transaction() as db:
            before = [tuple(row) for row in db.execute('SELECT * FROM attempts')]
            events = [tuple(row) for row in db.execute('SELECT * FROM events')]
            with self.assertRaises(Exception): self.q._prior(db, self.batch['members'][0])
            # Clone empty second schema, then insert fixture prior row only there.
            sql = db.execute("SELECT sql FROM sqlite_master WHERE name='attempts'").fetchone()[0]
            db.execute(sql.replace('CREATE TABLE attempts', 'CREATE TABLE second_attempts'))
            db.execute('INSERT INTO second_attempts SELECT * FROM attempts')
            changed = copy.deepcopy(self.batch['members'][0])
            changed['manifest']['task']['source']['source_video_sha256'] = 'a'*64
            with self.assertRaises(Exception): self.q._prior(db, changed)
            self.assertEqual(before, [tuple(row) for row in db.execute('SELECT * FROM attempts')])
            self.assertEqual(events, [tuple(row) for row in db.execute('SELECT * FROM events')])

    def test_13_grant_batch_binding_and_budget(self):
        self.authorize()
        for mutation in [lambda g: g['authority'].update(approval_id='other'),
                         lambda g: g.update(expires_at=(r.now()+dt.timedelta(hours=1)).isoformat()),
                         lambda g: g['limits'].update(gross_budget='4.00000000')]:
            grant = copy.deepcopy(self.f.grant); mutation(grant)
            envelope = self.f.sign(grant); fake = FakeProvider()
            with self.assertRaises(Exception):
                self.q.run_one('synthetic-batch', envelope, executor_id='fixture', transport=fake)
            self.assertEqual(fake.calls, 0)

    def test_14_actual_protected_rejects_writable_ancestor_and_symlink(self):
        unsafe = self.f.root/'unsafe.json'; unsafe.write_bytes(canonical({})); unsafe.chmod(0o640)
        with self.assertRaises(Exception): r.protected(unsafe)
        link = self.control/'link.json'; link.symlink_to(self.receipt)
        with self.assertRaises(Exception): r.protected(link)
        self.assertEqual(r.protected(self.receipt)[0], self.approval())

    def test_15_no_real_transport_in_synthetic_or_real_hooks(self):
        with self.assertRaises(Exception): self.q._pipeline('synthetic-batch', transport=worker.provider.DirectTransport())
        self.q.synthetic = False
        with self.assertRaises(Exception): self.q._pipeline('synthetic-batch', transport=FakeProvider())

    def test_17_missing_worker_row_after_claim_never_rearms(self):
        self.authorize()
        fake = FakeProvider()
        with mock.patch.object(r.worker.Pipeline, 'run', side_effect=KeyboardInterrupt('offline interruption before reservation')):
            with self.assertRaises(KeyboardInterrupt): self.execute(fake)
        again = r.Queue(self.f.policy, synthetic=True)
        result = again.recover('synthetic-batch', self.f.task['reel_id'], executor_id='restart', transport=FakeProvider())
        self.assertEqual(result['state'], 'BLOCKED')
        with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)
        self.assertIsNone(again.next('synthetic-batch'))

    def test_18_receipt_rechecked_at_worker_boundary(self):
        self.authorize()
        fake = FakeProvider()
        original = worker.Pipeline._source
        def source_then_revoke(pipeline, task):
            result = original(pipeline, task)
            changed = self.approval(); changed['expires_at'] = '2000-01-01T00:00:00Z'
            self.receipt.write_bytes(canonical(changed))
            return result
        with mock.patch.object(r.worker.Pipeline, '_source', source_then_revoke):
            with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.q.status('synthetic-batch')[0]['state'], 'RUNNING')
        self.assertIsNone(self.q.next('synthetic-batch'))

    def test_19_database_identity_tamper_not_authority(self):
        self.authorize()
        with self.q.ledger._transaction() as db:
            db.execute("UPDATE recurrence_members SET source_sha256=?", ('f'*64,))
        fake = FakeProvider()
        with self.assertRaises(Exception): self.execute(fake)
        self.assertEqual(fake.calls, 0)

    def test_20_second_member_only_after_verified_cleanup(self):
        # Prepare a distinct source/ID using the same actual fixture composition.
        task = copy.deepcopy(self.f.task); task['reel_id'] = 'synthetic-second'
        data = self.f.data + b' second distinct synthetic source'
        metadata = canonical({'id': task['reel_id'], 'synthetic': True})
        directory = self.f.root/'media/media/reels/synthetic-second'; directory.mkdir(parents=True)
        (directory/'video.mp4').write_bytes(data); (directory/'metadata.json').write_bytes(metadata)
        task['source'].update(relative_video_path='media/reels/synthetic-second/video.mp4',
                              relative_metadata_path='media/reels/synthetic-second/metadata.json',
                              source_video_sha256=sha(data), metadata_sha256=sha(metadata), declared_bytes=len(data))
        manifest = {'manifest_version':'reels-pilot-run.v2', 'task':task,
                    'request_sha256':sha(worker.provider.request_bytes(task, data))}
        second_batch = copy.deepcopy(self.batch); second_batch['batch_id'] = 'second-batch'
        second_batch['members'][0]['manifest'] = manifest
        self.history_receipt(second_batch)
        digest = self.q.prepare(second_batch)
        receipt_value = dict(self.approval(), batch_id='second-batch', manifest_sha256=digest)
        receipt = self.control/'second-batch.json'; receipt.write_bytes(canonical(receipt_value)); receipt.chmod(0o640)
        self.q.authorize('second-batch', receipt)
        grant = copy.deepcopy(self.f.grant)
        grant.update(grant_id='pilot-synthetic-second', bindings=worker.observed_bindings(self.f.policy, task),
                     manifest_sha256=sha(canonical(manifest)), request_sha256=manifest['request_sha256'])
        envelope = self.f.sign(grant)
        self.authorize(); self.execute()
        fake = FakeProvider()
        with self.assertRaises(Exception):
            self.q.run_one('second-batch', envelope, executor_id='offline', transport=fake)
        self.assertEqual(fake.calls, 0)
        self.q.cleanup('synthetic-batch', self.f.task['reel_id'], self.cleanup_receipt(), executor_id='cleanup', transport=FakeProvider())
        self.assertEqual(self.q.next('second-batch')['member_id'], 'synthetic-second')
        result = self.q.run_one('second-batch', envelope, executor_id='offline', transport=fake)
        self.assertEqual(result['state'], 'PERSISTED'); self.assertEqual(fake.calls, 1)
        self.assertIsNone(self.q.next('second-batch'))

    def test_16_known_http_failure_closes_but_never_retries(self):
        self.authorize()
        out, fake = self.execute(FakeProvider(Response(400, b'{"error":{"code":400}}', {'content-type':'application/json'})))
        self.assertEqual(out['analysis_state'], 'failed')
        self.q.cleanup('synthetic-batch', self.f.task['reel_id'], self.cleanup_receipt(), executor_id='cleanup', transport=FakeProvider())
        self.assertEqual(self.q.status('synthetic-batch')[0]['state'], 'FAILED')
        self.assertEqual(fake.calls, 1)


    def test_21_history_missing_before_prepare_and_media(self):
        (self.control/self.batch['batch_id']/'history.json').unlink()
        with mock.patch.object(r.worker.Pipeline, '_source', side_effect=AssertionError('must not read media')) as source:
            with self.assertRaises(r.approval.ApprovalDenied): self.q.prepare(self.batch)
            source.assert_not_called()

    def test_22_history_missing_before_dispatch(self):
        self.authorize()
        (self.control/self.batch['batch_id']/'history.json').unlink()
        fake = FakeProvider()
        with self.assertRaises(r.approval.ApprovalDenied): self.execute(fake)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.q.status(self.batch['batch_id'])[0]['state'], 'AUTHORIZED')

    def test_23_history_exact_binding_and_freshness(self):
        for changes in ({'complete': False}, {'complete': 1}, {'decision': 'YES'},
                        {'batch_id': 'other'}, {'manifest_sha256': 'f'*64}, {'roots': {}},
                        {'checked_at': (r.now()-dt.timedelta(hours=25)).isoformat()},
                        {'checked_at': (r.now()+dt.timedelta(minutes=1)).isoformat()},
                        {'checked_at': '2026-01-01T00:00:00'}):
            with self.subTest(changes=changes):
                self.history_receipt(self.batch, **changes)
                with self.assertRaises(Exception): self.q.prepare(self.batch)

    def test_24_partial_result_directory_before_dispatch(self):
        self.authorize()
        (self.f.root/'results'/self.f.task['reel_id']).mkdir()
        fake = FakeProvider()
        with self.assertRaisesRegex(Exception, 'result directory collision'): self.execute(fake)
        self.assertEqual(fake.calls, 0)

    def test_25_live_history_rechecked_after_media_read(self):
        self.authorize(); fake = FakeProvider(); original = r.worker.Pipeline._source
        def add_history(pipeline, task):
            result = original(pipeline, task)
            (self.f.root/'results/history-new.json').write_bytes(canonical({'metadata': task['source']['metadata_sha256']}))
            return result
        with mock.patch.object(r.worker.Pipeline, '_source', add_history):
            with self.assertRaisesRegex(Exception, 'history collision'): self.execute(fake)
        self.assertEqual(fake.calls, 0)

    def test_26_scan_excludes_vault_backups_and_control(self):
        (self.f.root/'media/history-backup.json').write_bytes(canonical({'id': self.f.task['reel_id']}))
        self.q._history(self.batch['members'][0])
        self.authorize(); result, fake = self.execute()
        self.assertEqual(result['state'], 'PERSISTED'); self.assertEqual(fake.calls, 1)

    def historical_member(self):
        member = copy.deepcopy(self.batch['members'][0])
        member['manifest']['task']['reel_id'] = 'different-reel'
        member['manifest']['task']['source']['source_video_sha256'] = 'a'*64
        return member

    def test_27_metadata_only_collision_both_historical_tables(self):
        self.authorize(); self.execute()
        member = self.historical_member()
        with self.q.ledger._transaction() as db:
            before = [tuple(row) for row in db.execute('SELECT * FROM attempts')]
            with self.assertRaisesRegex(Exception, 'prior attempt/reservation collision'): self.q._prior(db, member)
            sql = db.execute("SELECT sql FROM sqlite_master WHERE name='attempts'").fetchone()[0]
            db.execute(sql.replace('CREATE TABLE attempts', 'CREATE TABLE second_attempts'))
            db.execute('INSERT INTO second_attempts SELECT * FROM attempts')
            # Prove second_attempts independently, without changing historical rows.
            db.execute('ALTER TABLE attempts RENAME TO fixture_attempts')
            with self.assertRaisesRegex(Exception, 'prior attempt/reservation collision'): self.q._prior(db, member)
            self.assertEqual(before, [tuple(row) for row in db.execute('SELECT * FROM second_attempts')])

    def test_28_missing_or_corrupt_historical_refs_block(self):
        self.authorize(); self.execute(); member = self.historical_member()
        member['manifest']['task']['source']['metadata_sha256'] = 'b'*64
        with self.q.ledger._transaction() as db:
            for refs in (None, '{}', '{"artifact_prefix":"missing","manifest_sha256":"bad"}'):
                db.execute('UPDATE attempts SET refs_json=?', (refs,))
                with self.assertRaises(Exception): self.q._prior(db, member)

    def test_29_bootstrap_requires_exact_root_receipt_and_is_additive(self):
        with self.q.ledger._transaction() as db:
            before = [tuple(row) for row in db.execute('SELECT * FROM attempts')]
        for key, value in (('decision', 'YES'), ('ledger_identity', {}),
                           ('schema_sha256', 'f'*64), ('version_pins_sha256', 'f'*64)):
            self.write_receipt(self.schema, dict(self.schema_value, **{key: value}))
            with self.assertRaises(Exception): r.Queue(self.f.policy, bootstrap=True, synthetic=True)
        self.schema.unlink()
        with self.assertRaises(r.approval.ApprovalDenied): r.Queue(self.f.policy, bootstrap=True, synthetic=True)
        self.write_receipt(self.schema, self.schema_value)
        again = r.Queue(self.f.policy, bootstrap=True, synthetic=True)
        self.assertEqual(again.status(self.batch['batch_id']), self.q.status(self.batch['batch_id']))
        with again.ledger._transaction() as db:
            self.assertEqual(before, [tuple(row) for row in db.execute('SELECT * FROM attempts')])

    def test_30_unrelated_verified_history_allowed_corruption_denied(self):
        self.authorize(); self.execute(); member = self.historical_member()
        member['manifest']['task']['source']['metadata_sha256'] = 'b'*64
        with self.q.ledger._transaction() as db:
            self.q._prior(db, member)
            refs = json.loads(db.execute('SELECT refs_json FROM attempts').fetchone()[0])
        path = self.f.root/'results'/refs['artifact_prefix']/'provenance.json'
        path.write_bytes(b'{}')
        with self.q.ledger._transaction() as db:
            with self.assertRaises(Exception): self.q._prior(db, member)

    def test_31_nested_inventory_symlinks_fail_before_dispatch(self):
        self.authorize()
        outside = self.f.root/'outside-inventory'
        outside.mkdir()
        target = outside/'ordinary.txt'; target.write_bytes(b'not history')
        for root in (self.f.root/'media/media/reels', self.f.root/'results'):
            nested = root/'nested/deeper'; nested.mkdir(parents=True)
            for name, destination in (('linked-directory', outside),
                                      ('ordinary.txt', target),
                                      ('dangling', outside/'missing')):
                with self.subTest(root=root, name=name):
                    link = nested/name; link.symlink_to(destination)
                    fake = FakeProvider()
                    try:
                        with self.assertRaisesRegex(r.ContractError, 'symlink in inventory'):
                            self.execute(fake)
                        self.assertEqual(fake.calls, 0)
                        self.assertEqual(self.q.status(self.batch['batch_id'])[0]['state'], 'AUTHORIZED')
                    finally:
                        link.unlink()

    def test_32_shared_scan_bound_counts_directories_and_both_roots(self):
        media = self.f.root/'media/media/reels'
        nested = media/'bound'; nested.mkdir()
        (nested/'ordinary.txt').write_bytes(b'fixture')
        with r.os.scandir(media) as entries:
            directory = next(entry for entry in entries if entry.name == 'bound')
        with r.os.scandir(nested) as entries:
            file = next(entries)
        # Repeat real cached DirEntries, without creating 20,001 fixture files.
        # One directory + 10,000 media files + 9,999 result files is allowed.
        for result_count in (9999, 10000):
            with self.subTest(result_count=result_count):
                scans = [nullcontext(iter([directory])),
                         nullcontext(repeat(file, 10000)),
                         nullcontext(repeat(file, result_count))]
                with mock.patch.object(r.os, 'scandir', side_effect=scans) as scan:
                    if result_count == 9999:
                        self.q._history(self.batch['members'][0])
                    else:
                        with self.assertRaisesRegex(r.ContractError, 'history scan bound'):
                            self.q._history(self.batch['members'][0])
                    self.assertEqual(scan.call_count, 3)

    def test_33_nested_history_strict_json_size_and_identity(self):
        nested = self.f.root/'results/nested/deeper'; nested.mkdir(parents=True)
        path = nested/'analysis-import.json'
        for raw, message in ((canonical({'prior': [self.f.task['source']['metadata_sha256']]}), 'history collision'),
                             (b' ' * 1000001, 'history size')):
            with self.subTest(message=message):
                path.write_bytes(raw)
                with self.assertRaisesRegex(r.ContractError, message):
                    self.q._history(self.batch['members'][0])
        for raw in (b'{"duplicate":1,"duplicate":2}', b'{"value":NaN}'):
            path.write_bytes(raw)
            with self.assertRaises(Exception): self.q._history(self.batch['members'][0])
        path.write_bytes(canonical({'prior': ['unrelated']}))
        self.q._history(self.batch['members'][0])

    def test_34_directory_replaced_by_symlink_is_not_followed(self):
        nested = self.f.root/'results/nested'; nested.mkdir()
        outside = self.f.root/'outside'; outside.mkdir()
        original_open = r.os.open
        def replace_before_open(path, flags, *args, **kwargs):
            if path == nested:
                nested.rmdir()
                nested.symlink_to(outside, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(r.os, 'open', side_effect=replace_before_open):
            with self.assertRaises(OSError): self.q._history(self.batch['members'][0])


if __name__ == '__main__':
    unittest.main()
