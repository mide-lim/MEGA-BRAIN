"""Synthetic campaign proof. No imported TestCase aliases or live authority."""
import copy
import io
from contextlib import contextmanager
import datetime as dt
from pathlib import Path
import sys
import sqlite3
import threading
import unittest
from unittest import mock

import test_recurrence as fixtures
from test_worker_provider import FakeProvider, canonical, sha
import recurrence as r


class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.RecurrenceTests('test_01_unsigned_batch_zero_provider')
        self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.q = self.case.q; self.f = self.case.f
        self.groups = []
        for g in range(5):
            batch = copy.deepcopy(self.case.batch)
            batch.update(batch_id='campaign-batch-%d' % g, members=[], max_calls=3, max_gross_USD='9')
            if g == 3:
                batch['batch_id'] = 'sample-batch-3'
            for i in range(3):
                member = copy.deepcopy(self.case.batch['members'][0])
                task = member['manifest']['task']; rid = 'sample-3-0' if (g, i) == (3, 0) else 'campaign-%d-%d' % (g, i)
                task['reel_id'] = rid
                data = self.f.data + rid.encode(); metadata = canonical({'id': rid, 'synthetic': True})
                rel = 'media/reels/' + rid; directory = self.f.root/'media'/rel
                directory.mkdir(parents=True)
                (directory/'video.mp4').write_bytes(data); (directory/'metadata.json').write_bytes(metadata)
                task['source'].update(relative_video_path=rel+'/video.mp4', relative_metadata_path=rel+'/metadata.json',
                                      source_video_sha256=sha(data), metadata_sha256=sha(metadata), declared_bytes=len(data))
                member['manifest']['request_sha256'] = sha(r.worker.provider.request_bytes(task, data))
                batch['members'].append(member)
            self.groups.append({'planned': batch, 'effective': copy.deepcopy(batch), 'blocked': []})
        self.manifest = {'campaign_id': 'synthetic-campaign', 'parent_approval_id': self.f.grant['authority']['approval_id'],
                         'groups': self.groups, 'currency': 'USD', 'max_calls': 15, 'max_gross_USD': '45',
                         'wip': 1, 'retries': 0, 'fallback': False}

    def register(self, prepared_groups=5):
        digest = self.q.register_campaign(self.manifest)
        value = self.case.approval()
        value.pop('batch_id'); value.update(decision='APPROVE_REELS_CAMPAIGN', campaign_id='synthetic-campaign',
                                          manifest_sha256=digest, max_calls=self.manifest['max_calls'],
                                          max_gross_USD=self.manifest['max_gross_USD'])
        self.parent = value
        self.parent_path = self.case.write_receipt(self.case.control/'synthetic-campaign/campaign-approval.json', value)
        self.q.authorize_campaign('synthetic-campaign')
        for group in self.groups[:prepared_groups]:
            batch = group['effective']
            if batch is None:
                continue
            self.case.history_receipt(batch); digest = self.q.prepare(batch)
            child = self.case.approval(); child.update(batch_id=batch['batch_id'], manifest_sha256=digest,
                                                     max_calls=batch['max_calls'], max_gross_USD=batch['max_gross_USD'])
            self.case.write_receipt(self.case.control/(batch['batch_id']+'.json'), child)
            self.q.authorize(batch['batch_id'], self.case.control/(batch['batch_id']+'.json'))

    def envelope(self, g=0, i=0, sample=False):
        member = self.groups[g]['effective']['members'][i]; manifest = member['manifest']; task = manifest['task']
        grant = copy.deepcopy(self.f.grant)
        grant.update(grant_id='pilot-sample' if task['reel_id'] == 'sample-3-0' else 'pilot-'+task['reel_id'], manifest_sha256=sha(canonical(manifest)),
                     request_sha256=manifest['request_sha256'], bindings=r.worker.observed_bindings(self.f.policy, task))
        if sample:
            grant['authority']['approval_id'] = 'synthetic-exclusive-sample'
        return self.f.sign(grant)

    def execute(self, g=0, i=0, fake=None, hook=None):
        return self.q.run_one(self.groups[g]['effective']['batch_id'], self.envelope(g, i), executor_id='synthetic',
                              transport=fake or FakeProvider(), writer_hook=hook)

    def close(self, g, i):
        batch = self.groups[g]['effective']; member = batch['members'][i]; rid = member['manifest']['task']['reel_id']
        with self.q.ledger._transaction() as db:
            row = dict(db.execute('SELECT * FROM recurrence_members WHERE member_id=?', (rid,)).fetchone())
        value = {'decision': 'CLOSE_REELS_MEMBER', 'batch_id': batch['batch_id'], 'member_id': rid,
                 'grant_id': row['grant_id'], 'source_sha256': row['source_sha256'],
                 'worker_result_sha256': sha(row['result_json'].encode()), 'cleaned_at': r.now().isoformat(),
                 'token_copy_removed': True, 'temporary_bindings_removed': True, 'other_bindings_preserved': True}
        path = self.case.write_receipt(self.case.control/(rid+'.cleanup.json'), value)
        self.q.cleanup(batch['batch_id'], rid, path, executor_id='cleanup', transport=FakeProvider())

    def status(self):
        return self.q.campaign_status('synthetic-campaign')

    def test_01_five_finite_immutable_registration(self):
        self.register(); self.assertEqual(self.status()['reserved_calls'], 0)
        self.assertEqual(self.q.register_campaign(self.manifest), sha(canonical(self.manifest)))
        changed = copy.deepcopy(self.manifest); changed['groups'].reverse()
        with self.assertRaises(Exception): self.q.register_campaign(changed)
        changed = copy.deepcopy(self.manifest); changed['groups'].append(changed['groups'][0])
        with self.assertRaises(Exception): self.q.register_campaign(changed)

    def test_02_fifteen_signed_calls_and_no_sixteenth(self):
        self.register()
        for g in range(5):
            for i in range(3):
                fake = FakeProvider(); self.assertEqual(self.execute(g, i, fake)['state'], 'PERSISTED')
                self.assertEqual(fake.calls, 1); self.close(g, i)
        self.assertEqual(self.status()['reserved_calls'], 15)
        self.assertEqual(r.money(self.status()['reserved_gross_USD'], 45), r.money('45', 45))
        with self.assertRaises(Exception): self.execute(4, 2)
        self.assertIsNone(self.q.next(self.groups[4]['effective']['batch_id']))
        with self.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_members WHERE persisted=1 AND cleanup=1').fetchone()[0], 15)
            self.assertEqual(db.execute('SELECT COUNT(DISTINCT source_sha256) FROM attempts').fetchone()[0], 15)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 0)
        # This is a distinct, already prepared synthetic candidate, not a replay.
        candidate = self.case.batch['members'][0]['manifest']['task']['reel_id']
        self.assertNotIn(candidate, {m['manifest']['task']['reel_id'] for g in self.groups for m in g['planned']['members']})
        fake = FakeProvider()
        with self.assertRaisesRegex(r.ContractError, 'unregistered/sixth'):
            self.case.authorize()
        with self.assertRaisesRegex(r.ContractError, 'no authorized next member'):
            self.q.run_one(self.case.batch['batch_id'], self.f.envelope, executor_id='sixteenth', transport=fake)
        self.assertEqual(fake.calls, 0)
        self.q = r.Queue(self.f.policy, synthetic=True)
        self.assert_parent_cannot_reset()
        self.assertEqual(self.status()['reserved_calls'], 15)
        self.assertEqual(self.status()['reserved_gross_USD'], '45')

    def test_03_small_call_ceiling(self):
        self.manifest['max_calls'] = 1; self.register(); self.execute(); self.close(0, 0)
        fake = FakeProvider()
        with self.assertRaisesRegex(Exception, 'capacity'): self.execute(0, 1, fake)
        self.assertEqual(fake.calls, 0); self.assertEqual(self.status()['reserved_calls'], 1)

    def test_04_small_money_ceiling(self):
        self.manifest['max_gross_USD'] = '5'; self.register(); self.execute(); self.close(0, 0)
        with self.assertRaisesRegex(Exception, 'capacity'): self.execute(0, 1)
        self.assertEqual(self.status()['reserved_calls'], 1)

    def test_05_order_and_cleanup_barrier(self):
        self.register(); fake = FakeProvider()
        with self.assertRaisesRegex(Exception, 'barrier'): self.execute(1, 0, fake)
        self.assertEqual(fake.calls, 0)
        self.execute()
        with self.assertRaises(Exception): self.execute(0, 1)
        self.assertEqual(self.status()['reserved_calls'], 1)

    def test_06_interrupted_claim_restart_no_refund_no_send(self):
        self.register(); fake = FakeProvider()
        with mock.patch.object(r.worker.Pipeline, 'run', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): self.execute(fake=fake)
        self.q = r.Queue(self.f.policy, synthetic=True)
        rid = self.groups[0]['effective']['members'][0]['manifest']['task']['reel_id']
        self.assertEqual(self.q.recover('campaign-batch-0', rid, executor_id='restart', transport=fake)['state'], 'BLOCKED')
        self.assertEqual(self.status()['reserved_calls'], 1)
        with self.assertRaises(Exception): self.execute(fake=fake)
        self.assertEqual(fake.calls, 0)

    def test_07_unknown_no_refund(self):
        self.register(); self.assertEqual(self.execute(fake=FakeProvider(error=True))['state'], 'UNKNOWN')
        self.assertEqual(self.status()['reserved_calls'], 1)
        with self.assertRaises(Exception): self.execute(1, 0)

    def test_08_recovery_without_authority_no_extra_reservation(self):
        self.register(); out = self.execute(); self.parent_path.unlink(); fake = FakeProvider()
        rid = self.groups[0]['effective']['members'][0]['manifest']['task']['reel_id']
        self.assertEqual(self.q.recover('campaign-batch-0', rid, executor_id='restart', transport=fake), out)
        self.assertEqual(fake.calls, 0); self.assertEqual(self.status()['reserved_calls'], 1)

    def test_09_same_parent_and_sixth_denied(self):
        self.register()
        path = self.case.control/'campaign-batch-0.json'
        child = r.protected(path)[0]; child['approval_id'] = 'fictitious'
        self.case.write_receipt(path, child)
        with self.assertRaises(Exception): self.q.authorize('campaign-batch-0', path)
        # Existing independent batch cannot borrow the now-known campaign parent.
        with self.assertRaisesRegex(Exception, 'unregistered/sixth'): self.case.authorize()

    def test_10_source_metadata_subset_mutation_denied(self):
        for key in ('source_video_sha256', 'metadata_sha256'):
            bad = copy.deepcopy(self.manifest)
            bad['groups'][1]['planned']['members'][0]['manifest']['task']['source'][key] = bad['groups'][0]['planned']['members'][0]['manifest']['task']['source'][key]
            with self.assertRaises(Exception): self.q.register_campaign(bad)
        self.register()
        changed = copy.deepcopy(self.groups[0]['effective']); changed['members'].reverse()
        with self.assertRaises(Exception): self.q.prepare(changed)

    def test_11_blocked_empty_group_requires_root_skip(self):
        group = self.groups[0]; group['blocked'] = [m['manifest']['task']['reel_id'] for m in group['planned']['members']]
        group['effective'] = None; self.register()
        with self.assertRaises(Exception): self.execute(1, 0)
        value = {'decision': 'SKIP_TECHNICALLY_BLOCKED_REELS_GROUP', 'campaign_id': 'synthetic-campaign',
                 'manifest_sha256': sha(canonical(self.manifest)), 'batch_id': 'campaign-batch-0', 'blocked': group['blocked']}
        self.case.write_receipt(self.case.control/'synthetic-campaign/campaign-batch-0.skip.json', value)
        self.assertEqual(self.execute(1, 0)['state'], 'PERSISTED')
        with self.assertRaises(Exception): self.q.prepare(group['planned'])
        self.assertEqual(len(self.status()['manifest']['groups'][0]['planned']['members']), 3)

    def test_12_partial_effective_inventory_cannot_expand(self):
        group = self.groups[0]; group['blocked'] = [group['planned']['members'][2]['manifest']['task']['reel_id']]
        group['effective']['members'].pop(); group['effective'].update(max_calls=2, max_gross_USD='6')
        self.register(); self.assertEqual(len(self.q.status('campaign-batch-0')), 2)
        with self.assertRaises(Exception): self.q.prepare(group['planned'])

    def test_13_atomic_wip_competing_claim(self):
        self.register(); envelope = self.envelope(); fake = FakeProvider()
        def interrupt(pipeline, manifest, signed, **kwargs):
            other = r.Queue(self.f.policy, synthetic=True)
            with self.assertRaises(Exception):
                other.run_one('campaign-batch-0', envelope, executor_id='competitor', transport=fake)
            raise KeyboardInterrupt
        with mock.patch.object(r.worker.Pipeline, 'run', interrupt):
            with self.assertRaises(KeyboardInterrupt): self.execute(fake=fake)
        self.assertEqual(self.status()['reserved_calls'], 1); self.assertEqual(fake.calls, 0)

    def test_14_parent_privacy_expiry_and_mutation_fail_closed(self):
        self.register(); value = copy.deepcopy(self.parent); value['rights_and_global_privacy_accepted'] = False
        self.case.write_receipt(self.parent_path, value); fake = FakeProvider()
        with self.assertRaises(Exception): self.execute(fake=fake)
        self.assertEqual(fake.calls, 0); self.assertEqual(self.status()['reserved_calls'], 0)


    def assert_parent_cannot_reset(self):
        # All new slot/member/source/metadata identities: only the parent is reused.
        changed = copy.deepcopy(self.manifest)
        changed['campaign_id'] = 'new-campaign-same-parent'
        for group in changed['groups']:
            for batch in (group['planned'], group['effective']):
                batch['batch_id'] = 'new-' + batch['batch_id']
                for member in batch['members']:
                    task = member['manifest']['task']
                    task['reel_id'] = 'new-' + task['reel_id']
                    task['source']['relative_video_path'] = 'media/reels/' + task['reel_id'] + '/video.mp4'
                    task['source']['relative_metadata_path'] = 'media/reels/' + task['reel_id'] + '/metadata.json'
                    for key in ('source_video_sha256', 'metadata_sha256'):
                        task['source'][key] = sha(('new-' + task['source'][key]).encode())
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'recurrence_campaigns.parent_approval_id'):
            self.q.register_campaign(changed)
        with self.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_campaigns').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_campaign_slots').fetchone()[0], 5)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_campaign_planned').fetchone()[0], 15)

    def test_15_zero_reservation_status_positive_validation_unchanged(self):
        self.register()
        status = self.status()
        self.assertEqual(status['reservations'], [])
        self.assertEqual(status['reserved_calls'], 0)
        self.assertEqual(status['reserved_gross_USD'], '0')
        for invalid in ('0', '-1', 'NaN', 'Infinity'):
            with self.subTest(invalid=invalid), self.assertRaises(r.approval.ApprovalDenied):
                r.money(invalid, 45)

    def test_16_simultaneous_connections_single_claim_allocation_post(self):
        self.register(); envelope = self.envelope()
        barrier = threading.Barrier(2, timeout=10)
        loser_done = threading.Event()
        verify_lock = threading.RLock()
        local = threading.local()
        results, denied = [], []
        captured = []
        class Claimed(BaseException):
            pass
        fakes = [FakeProvider(), FakeProvider()]
        verify = r._GuardedPipeline._verify
        run = r.worker.Pipeline.run
        transaction = r.worker.Ledger._transaction
        @contextmanager
        def preflight_transaction(ledger):
            # Only preflight is serialized; actual claim transactions race.
            if not getattr(local, 'ready', False):
                with verify_lock, transaction(ledger) as db:
                    yield db
            else:
                with transaction(ledger) as db:
                    yield db
        def synchronized_verify(pipeline, *args, **kwargs):
            if not getattr(local, 'ready', False):
                # Avoid unrelated read-phase write-lock contention. Both real
                # verifications finish before either actual claim transaction.
                with verify_lock:
                    value = verify(pipeline, *args, **kwargs)
                local.ready = True
                barrier.wait()
                return value
            return verify(pipeline, *args, **kwargs)
        def held_run(pipeline, *args, **kwargs):
            if not loser_done.wait(10):
                raise AssertionError('competitor did not finish within bound')
            captured.append((pipeline, args, kwargs))
            # Existing auth deadline uses main-thread-only SIGALRM. Defer the
            # real Pipeline POST to main, retaining the actual durable claim.
            raise Claimed

        # Construct each Queue before racing; each transaction opens its own
        # actual SQLite connection (no connection or SQL mocks).
        queues = [r.Queue(self.f.policy, synthetic=True) for _ in range(2)]
        def contender(index):
            try:
                results.append(queues[index].run_one('campaign-batch-0', envelope,
                               executor_id='thread-%d' % index, transport=fakes[index]))
            except Claimed:
                pass
            except Exception as exc:
                denied.append(exc)
                loser_done.set()
        threads = [threading.Thread(target=contender, args=(i,), daemon=True) for i in range(2)]
        with mock.patch.object(r._GuardedPipeline, '_verify', synchronized_verify), \
             mock.patch.object(r.worker.Ledger, '_transaction', preflight_transaction), \
             mock.patch.object(r.worker.Pipeline, 'run', held_run):
            for thread in threads: thread.start()
            for thread in threads: thread.join(15)
            self.assertTrue(all(not thread.is_alive() for thread in threads), 'bounded thread completion')
        self.assertEqual(len(denied), 1, repr(denied))
        self.assertIsInstance(denied[0], (r.ContractError, sqlite3.OperationalError))
        self.assertRegex(str(denied[0]), 'concurrent claim|database is locked')
        self.assertEqual(len(captured), 1)
        pipeline, args, kwargs = captured[0]
        result = run(pipeline, *args, **kwargs)
        results.append(self.q._save('campaign-batch-0', args[0]['task']['reel_id'], result))
        self.assertEqual([result['state'] for result in results], ['PERSISTED'])
        self.assertEqual(sorted(fake.calls for fake in fakes), [0, 1])
        self.assertEqual(self.status()['reserved_calls'], 1)
        self.assertEqual(self.status()['reserved_gross_USD'], '3')
        with self.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_members WHERE grant_id IS NOT NULL').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0], 1)

    def test_17_unchanged_protected_parent_expires_at_admission(self):
        self.register(); envelope = self.envelope(); fake = FakeProvider()
        value, digest = r.protected(self.parent_path)
        self.assertEqual(value, self.parent)
        expired_at = r.approval._instant(value['expires_at'])
        # Advance only the clock: protected bytes and pinned digest are intact.
        with mock.patch.object(r, 'now', return_value=expired_at):
            with self.assertRaisesRegex(r.ContractError, '^campaign expiry$'):
                self.q.next('campaign-batch-0')
        self.assertEqual(r.protected(self.parent_path), (value, digest))
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.status()['reserved_calls'], 0)
        self.assertEqual(self.q.status('campaign-batch-0')[0]['state'], 'AUTHORIZED')

    def test_18_parent_unique_new_disjoint_campaign_no_budget_reset(self):
        self.register()
        self.assert_parent_cannot_reset()
        self.assertEqual(self.status()['reserved_calls'], 0)

    def test_19_campaign_prepare_defers_source_but_retains_history_and_prior(self):
        self.q.register_campaign(self.manifest)
        batch = self.groups[0]['effective']
        with mock.patch.object(r.worker.Pipeline, '_source', side_effect=AssertionError('eager media read')) as source, \
             mock.patch.object(r.worker.provider, 'request_bytes', side_effect=AssertionError('eager request body')) as request:
            self.case.history_receipt(batch, complete=False)
            with self.assertRaisesRegex(r.ContractError, 'complete history attestation'):
                self.q.prepare(batch)
            self.case.history_receipt(batch)
            history = self.f.root/'results/history-campaign.json'
            history.write_bytes(canonical({'prior': batch['members'][2]['manifest']['task']['source']['metadata_sha256']}))
            with self.assertRaisesRegex(r.ContractError, 'history collision'):
                self.q.prepare(batch)
            history.unlink()
            with mock.patch.object(self.q, '_prior', side_effect=r.ContractError('prior sentinel')) as prior:
                with self.assertRaisesRegex(r.ContractError, '^prior sentinel$'):
                    self.q.prepare(batch)
                prior.assert_called_once()
            with mock.patch.object(self.q, '_history', wraps=self.q._history) as scan, \
                 mock.patch.object(self.q, '_prior', wraps=self.q._prior) as prior:
                self.assertEqual(self.q.prepare(batch), sha(canonical(batch)))
                self.assertEqual(scan.call_args_list, [mock.call(m) for m in batch['members']])
                self.assertEqual(prior.call_count, 3)
            source.assert_not_called(); request.assert_not_called()
        self.assertEqual([m['state'] for m in self.q.status(batch['batch_id'])], ['PENDING'] * 3)
        self.assertEqual(self.status()['reserved_calls'], 0)
        with self.q.ledger._transaction() as db:
            self.assertIsNone(db.execute('SELECT receipt_path FROM recurrence_batches WHERE batch_id=?',
                                         (batch['batch_id'],)).fetchone()[0])

    def test_20_unregistered_batch_keeps_eager_source_and_request_guards(self):
        batch = self.groups[0]['effective']  # Campaign-shaped JSON alone cannot defer admission.
        self.case.history_receipt(batch)
        with mock.patch.object(r.worker.Pipeline, '_source', side_effect=r.ContractError('source sentinel')) as source:
            with self.assertRaisesRegex(r.ContractError, '^source sentinel$'):
                self.q.prepare(batch)
            source.assert_called_once_with(batch['members'][0]['manifest']['task'])
        bad = copy.deepcopy(batch)
        bad['members'][0]['manifest']['request_sha256'] = '0' * 64
        self.case.history_receipt(bad)
        with self.assertRaisesRegex(r.ContractError, '^inventory request differs$'):
            self.q.prepare(bad)
        self.case.history_receipt(batch)
        with mock.patch.object(r.worker.Pipeline, '_source', autospec=True,
                               side_effect=r.worker.Pipeline._source) as source:
            self.assertEqual(self.q.prepare(batch), sha(canonical(batch)))
            self.assertEqual(source.call_count, 3)
        self.assertEqual([m['state'] for m in self.q.status(batch['batch_id'])], ['PENDING'] * 3)

    def test_21_campaign_source_failure_zero_post_holds_claim_without_retry(self):
        import json
        self.register(); fake = FakeProvider()
        batch = self.groups[0]['effective']; task = batch['members'][0]['manifest']['task']
        video = self.f.root/'media'/task['source']['relative_video_path']
        original = video.read_bytes()
        video.write_bytes(b'NOT SYNTHETIC MEDIA')
        with self.assertRaisesRegex(r.ContractError, 'only explicit synthetic fixture'):
            self.execute(fake=fake)
        self.assertEqual(fake.calls, 0)
        self.assertEqual([m['state'] for m in self.q.status(batch['batch_id'])],
                         ['BLOCKED', 'AUTHORIZED', 'AUTHORIZED'])
        self.assertEqual(self.status()['reserved_calls'], 1)
        self.assertEqual(self.status()['reserved_gross_USD'], '3')
        with self.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 1)
            self.assertEqual(tuple(db.execute('SELECT batch_id,member_id FROM recurrence_slot').fetchone()),
                             (batch['batch_id'], task['reel_id']))
            row = db.execute('SELECT persisted,cleanup,result_json FROM recurrence_members WHERE member_id=?',
                             (task['reel_id'],)).fetchone()
            self.assertEqual((row['persisted'], row['cleanup']), (0, 0))
            self.assertIsNotNone(row['result_json'])
            self.assertLess(len(row['result_json']), 512)
            self.assertEqual(json.loads(row['result_json']),
                             {'state': 'BLOCKED', 'kind': 'exception_control',
                              'phase': 'pipeline_run', 'exception_type': 'ContractError',
                              'provider_io': 'NOT_STARTED', 'provider_calls': 0,
                              'retry_allowed': False})
        video.write_bytes(original)
        self.q = r.Queue(self.f.policy, synthetic=True)
        with self.assertRaisesRegex(r.ContractError, 'never replay running'):
            self.execute(fake=fake)
        self.assertEqual(self.q.recover(batch['batch_id'], task['reel_id'], executor_id='restart', transport=fake),
                         {'state': 'BLOCKED', 'retry_allowed': False})
        with self.assertRaisesRegex(r.ContractError, 'no authorized next member'):
            self.execute(fake=fake)
        self.assertIsNone(self.q.next(batch['batch_id']))
        self.assertEqual(self.q.status(batch['batch_id'])[0]['state'], 'BLOCKED')
        self.assertEqual(self.status()['reserved_calls'], 1)
        self.assertEqual(fake.calls, 0)


    def sample_setup(self, history=True):
        # Group04 really is unprepared, and group03 retains two AUTHORIZED rows.
        self.register(prepared_groups=3)
        if history:
            for g in range(2):
                for i in range(3):
                    self.execute(g, i); self.close(g, i)
            self.execute(2, 0); self.close(2, 0)
        self.parent_path.unlink()  # Archived/unavailable, never renewed.
        self.sample_batch = self.groups[3]['effective']
        self.bid = self.sample_batch['batch_id']; self.mid = 'sample-3-0'
        self.case.history_receipt(self.sample_batch)
        self.q.prepare(self.sample_batch)
        run = self.sample_batch['members'][0]['manifest']; src = run['task']['source']
        self.sample = dict(self.case.approval(), decision='APPROVE_REELS_EXCLUSIVE_SAMPLE',
            batch_id=self.bid, manifest_sha256=sha(canonical(self.sample_batch)),
            approval_id='synthetic-exclusive-sample', campaign_id=self.manifest['campaign_id'],
            campaign_manifest_sha256=sha(canonical(self.manifest)), member_id=self.mid,
            run_manifest_sha256=sha(canonical(run)), source_sha256=src['source_video_sha256'],
            metadata_sha256=src['metadata_sha256'], request_sha256=run['request_sha256'])
        self.sample_path = self.case.control/self.bid/'sample-approval.json'
        self.case.write_receipt(self.sample_path, self.sample)

    def admit_sample(self):
        self.q.authorize_sample(self.bid, self.mid)

    def sample_run(self, fake=None, envelope=None):
        return self.q.run_one(self.bid, envelope or self.envelope(3, 0, sample=True),
                             executor_id='synthetic-sample', transport=fake or FakeProvider())

    def test_22_exclusive_original_group04_once_preserves_stopped_group03(self):
        self.sample_setup()
        original = copy.deepcopy(self.status())
        with self.q.ledger._transaction() as db:
            earlier = [dict(x) for x in db.execute('SELECT * FROM recurrence_members WHERE batch_id=?', ('campaign-batch-2',))]
        self.assertEqual([x['state'] for x in earlier[1:]], ['AUTHORIZED', 'AUTHORIZED'])
        self.admit_sample()
        self.assertEqual([x['state'] for x in self.q.status(self.bid)], ['AUTHORIZED', 'PENDING', 'PENDING'])
        self.assertEqual(self.q.next(self.bid), {'member_id': self.mid, 'state': 'AUTHORIZED'})
        fake = FakeProvider(); self.assertEqual(self.sample_run(fake)['state'], 'PERSISTED')
        self.assertEqual(fake.calls, 1)
        self.assertIsNone(self.q.next(self.bid))
        self.close(3, 0)
        self.assertIsNone(self.q.next(self.bid))
        self.assertEqual(self.status()['manifest'], original['manifest'])
        self.assertEqual([x for x in self.status()['reservations'] if x['member_id'] != self.mid], original['reservations'])
        self.assertEqual(self.status()['reserved_calls'], original['reserved_calls'] + 1)
        self.assertEqual(self.status()['reserved_gross_USD'], '24')
        with self.q.ledger._transaction() as db:
            self.assertEqual(earlier, [dict(x) for x in db.execute('SELECT * FROM recurrence_members WHERE batch_id=?', ('campaign-batch-2',))])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 0)
        with self.assertRaises(Exception): self.sample_run(fake)
        with self.assertRaises(Exception): self.admit_sample()
        self.assertEqual(fake.calls, 1)
        # Expired approval does not re-enable siblings or the old campaign.
        with mock.patch.object(r, 'now', return_value=r.approval._instant(self.sample['expires_at'])):
            with self.assertRaises(Exception): self.q.next(self.bid)
            with self.assertRaises(Exception): self.q.next('campaign-batch-2')

    def test_23_sample_refuses_siblings_earlier_broad_authority_and_new_campaign(self):
        self.sample_setup(history=False); self.admit_sample(); fake = FakeProvider()
        for g, i in ((3, 1), (2, 0), (0, 0)):
            with self.subTest(g=g, i=i), self.assertRaises(Exception):
                self.q._authority(self.groups[g]['effective']['batch_id'],
                                  self.groups[g]['effective']['members'][i]['manifest'], self.envelope(g, i, sample=True))
        with self.assertRaises(Exception): self.execute(2, 0, fake)
        with self.assertRaises(Exception): self.q.next('campaign-batch-2')
        with self.assertRaises(Exception): self.q.authorize(self.bid, self.sample_path)
        with self.assertRaises(Exception): self.q.authorize('campaign-batch-2', self.case.control/'campaign-batch-2.json')
        self.case.write_receipt(self.parent_path, self.parent)
        with self.assertRaises(Exception): self.q.authorize_campaign('synthetic-campaign')
        self.assert_parent_cannot_reset()
        self.assertEqual(fake.calls, 0)

    def test_24_sample_receipt_exact_shape_fingerprints_expiry_and_selector(self):
        self.sample_setup(history=False)
        for key, value in [('campaign_id', 'fake-campaign'), ('batch_id', 'other-batch'),
                ('campaign_manifest_sha256', 'f'*64), ('manifest_sha256', 'f'*64),
                ('member_id', 'campaign-3-1'), ('source_sha256', 'f'*64), ('metadata_sha256', 'f'*64),
                ('run_manifest_sha256', 'f'*64), ('request_sha256', 'f'*64),
                ('expires_at', '2000-01-01T00:00:00Z'), ('rights_and_global_privacy_accepted', False),
                ('max_calls', 2), ('max_gross_USD', '3.01'), ('approval_id', self.manifest['parent_approval_id'])]:
            self.case.write_receipt(self.sample_path, dict(self.sample, **{key: value}))
            with self.subTest(key=key), self.assertRaises(Exception): self.admit_sample()
        self.case.write_receipt(self.sample_path, self.sample)
        with self.assertRaises(Exception): self.q.authorize_sample(self.bid, 'campaign-3-1')
        self.admit_sample()
        self.case.write_receipt(self.sample_path, dict(self.sample, approved_by='changed'))
        fake = FakeProvider()
        with self.assertRaises(Exception): self.q.next(self.bid)
        with self.assertRaises(Exception): self.sample_run(fake)
        with self.assertRaises(Exception): self.q.next('campaign-batch-0')
        self.assertEqual(fake.calls, 0)

    def test_25_sample_concurrent_slot_capacity_uncertainty_and_no_retry(self):
        self.sample_setup(history=False)
        with self.q.ledger._transaction() as db:
            db.execute('INSERT INTO recurrence_slot VALUES(1,?,?)', ('campaign-batch-2', 'campaign-2-0'))
        with self.assertRaisesRegex(Exception, 'WIP1'): self.admit_sample()
        with self.q.ledger._transaction() as db: db.execute('DELETE FROM recurrence_slot')
        self.admit_sample(); fake = FakeProvider(error=True)
        self.assertEqual(self.sample_run(fake)['state'], 'UNKNOWN')
        self.assertEqual(fake.calls, 1)
        with self.assertRaises(Exception): self.sample_run(fake)
        with self.assertRaises(Exception): self.admit_sample()
        self.assertEqual(self.status()['reserved_calls'], 1)
        self.assertEqual(fake.calls, 1)

    def test_26_sample_original_total_ceiling_and_signed_grant_checks(self):
        self.manifest['max_calls'] = 1
        self.register(prepared_groups=3); self.execute(); self.close(0, 0)
        # Prepare a fresh original slot, without a usable parent.
        self.parent_path.unlink()
        batch = self.groups[3]['effective']; self.case.history_receipt(batch); self.q.prepare(batch)
        run = batch['members'][0]['manifest']; src = run['task']['source']
        value = dict(self.case.approval(), decision='APPROVE_REELS_EXCLUSIVE_SAMPLE',
            approval_id='synthetic-exclusive-sample', batch_id=batch['batch_id'], manifest_sha256=sha(canonical(batch)),
            campaign_id=self.manifest['campaign_id'], campaign_manifest_sha256=sha(canonical(self.manifest)),
            member_id='sample-3-0', run_manifest_sha256=sha(canonical(run)), source_sha256=src['source_video_sha256'],
            metadata_sha256=src['metadata_sha256'], request_sha256=run['request_sha256'])
        self.case.write_receipt(self.case.control/batch['batch_id']/'sample-approval.json', value)
        self.q.authorize_sample(batch['batch_id'], 'sample-3-0'); fake = FakeProvider()
        with self.assertRaises(Exception):
            self.q.run_one(batch['batch_id'], self.envelope(3, 0), executor_id='wrong-authority', transport=fake)
        with self.assertRaisesRegex(Exception, 'capacity'):
            self.q.run_one(batch['batch_id'], self.envelope(3, 0, sample=True), executor_id='ceiling', transport=fake)
        self.assertEqual(fake.calls, 0); self.assertEqual(self.status()['reserved_calls'], 1)

    def test_27_sample_normal_main_run_one_and_no_implicit_next(self):
        self.sample_setup(history=False)
        fake = FakeProvider(); real_queue = self.q
        self.case.write_receipt(self.case.control/self.bid/(self.mid+'.grant.json'), self.envelope(3, 0, sample=True))
        pipeline = self.q._pipeline
        def synthetic_pipeline(batch_id, **kwargs):
            return pipeline(batch_id, transport=fake)
        with mock.patch.object(r.worker, 'load_policy', return_value=self.f.policy), \
             mock.patch.object(r, 'Queue', return_value=real_queue), \
             mock.patch.object(self.q, '_pipeline', side_effect=synthetic_pipeline), \
             mock.patch.object(sys, 'argv', ['recurrence.py', 'authorize-sample', self.bid, '--member-id', self.mid]), \
             mock.patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(r.main(), 0)
        with mock.patch.object(r.worker, 'load_policy', return_value=self.f.policy), \
             mock.patch.object(r, 'Queue', return_value=real_queue), \
             mock.patch.object(self.q, '_pipeline', side_effect=synthetic_pipeline), \
             mock.patch.object(sys, 'argv', ['recurrence.py', 'run-one', self.bid, '--executor-id', 'cli-synthetic']), \
             mock.patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(r.main(), 0)
            self.assertEqual(r.main(), 1)
        self.assertEqual(fake.calls, 1)


class CampaignSchemaTests(unittest.TestCase):
    """These structural checks also run where signed-fixture crypto is absent."""
    def test_additive_schema_idempotent_and_unique_reservations(self):
        import sqlite3
        with sqlite3.connect(':memory:') as db:
            for _ in range(2):
                for sql in r.SCHEMA_SQL:
                    db.execute(sql)
            db.execute('INSERT INTO recurrence_campaign_allocations VALUES(?,?,?,?,?,?,1)',
                       ('campaign', 'batch', 'member', 'source', 'grant', '3'))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('INSERT INTO recurrence_campaign_allocations VALUES(?,?,?,?,?,?,1)',
                           ('other', 'batch2', 'other-member', 'source', 'other-grant', '3'))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_campaign_allocations').fetchone()[0], 1)

    def test_legacy_batch_limit_still_three(self):
        bad = {'batch_id': 'four', 'members': [{}, {}, {}, {}], 'currency': 'USD',
               'max_calls': 4, 'max_gross_USD': '12', 'wip': 1, 'retries': 0, 'fallback': False}
        with self.assertRaisesRegex(r.ContractError, 'finite members'):
            r.validate_batch(bad, {'currency': 'USD'})


if __name__ == '__main__':
    if '--time-check' in sys.argv:
        stamp = dt.datetime.now(dt.timezone.utc)
        print('LIVE_UTC=' + stamp.isoformat())
        print('CONTRACT_EXPIRES_UTC=2026-10-30T18:22:36.245680+00:00')
        print('BEFORE_EXPIRY=' + str(stamp < dt.datetime.fromisoformat('2026-10-30T18:22:36.245680+00:00')))
        # Conservative coordinator-session timestamp from read-only run-context
        # identifier; this is not an invented task-start monotonic timestamp.
        elapsed = (stamp - dt.datetime.fromisoformat('2026-10-30T15:22:56+00:00')).total_seconds()
        print('SECONDS_SINCE_COORDINATOR_SESSION_ID_TIMESTAMP=' + str(elapsed))
        print('WITHIN_600_SECONDS_OF_THAT_TIMESTAMP=' + str(0 <= elapsed < 600))
    else:
        unittest.main()
