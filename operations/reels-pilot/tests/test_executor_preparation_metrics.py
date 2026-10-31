"""TASK062 deterministic synthetic integration; never operational performance proof."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from contextvars import copy_context
import io
import json
import sys
import unittest
from unittest import mock

import test_worker_provider as fixtures
import test_recurrence as queue_fixtures
import preparation_metrics as m

worker = fixtures.worker


class FaultyContext:
    """Delegate real ContextVar operations, failing before or after mutation."""
    def __init__(self, real, method, after):
        self.real, self.method, self.after = real, method, after
        self.calls = []

    def invoke(self, method, *args):
        self.calls.append(method)
        if method == self.method and not self.after:
            raise RuntimeError('context bookkeeping')
        result = getattr(self.real, method)(*args)
        if method == self.method:
            raise RuntimeError('context bookkeeping')
        return result

    def get(self):
        return self.invoke('get')

    def set(self, value):
        return self.invoke('set', value)

    def reset(self, token):
        return self.invoke('reset', token)


class ExecutorPreparationTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.WorkerProviderTests('test_full_chain_and_restart_preserve_exact_result')
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.stderr = io.StringIO()
        self.capture = redirect_stderr(self.stderr)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def frames(self):
        return [json.loads(line)['preparation_observation']
                for line in self.stderr.getvalue().splitlines()]

    def execute(self, pipeline):
        return pipeline.run(self.f.manifest, self.f.envelope, executor_id='private-executor')

    def test_api_automatic_scope_recovery_and_reset(self):
        p, fake = self.f.pipeline()
        result = self.execute(p)
        self.assertEqual(result['state'], 'PERSISTED')
        again = self.execute(p)
        self.assertEqual(result, again)
        first, second = self.frames()
        self.assertEqual(first['entry_point'], 'Pipeline.run')
        self.assertEqual(first['coverage'], 'NEW_COMPLETE')
        self.assertTrue(first['synthetic'])
        self.assertEqual(first['api_setup_coverage'], 'outside_scope')
        self.assertEqual(second['coverage'], 'recovery')
        self.assertFalse(second['boundary_reached'])
        self.assertIsNone(second['executor_prepare_ms'])
        self.assertEqual(fake.calls, 1)
        self.assertIsNone(m.current())
        self.assertIsNone(m._OPERATION.get())
        for secret in (str(self.f.root), 'private-executor', self.f.grant['grant_id'], 'SYNTHETIC-NO-GOOGLE-CREDENTIAL'):
            self.assertNotIn(secret, self.stderr.getvalue())

    def test_exact_boundary_includes_every_control_excludes_send_persist_report(self):
        p, fake = self.f.pipeline()
        now = [0]
        trace = []
        def wrap(obj, name, label, amount=1):
            original = getattr(obj, name)
            def call(*args, **kwargs):
                trace.append(label)
                now[0] += amount * 1000000
                return original(*args, **kwargs)
            return mock.patch.object(obj, name, side_effect=call, autospec=True)
        emit = m._emit
        def slow_emit(report):
            now[0] += 1000000000
            emit(report)
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(m, 'monotonic_ns', side_effect=lambda: now[0]))
            for obj, name, label in ((worker, 'check_manifest', 'manifest'),
                                     (worker, 'validate_policy', 'policy'),
                                     (p, '_verify', 'verify'), (p, '_source', 'source'),
                                     (worker.provider, 'request_bytes', 'request'),
                                     (p.store, 'assert_identity', 'identity'),
                                     (worker.Ledger, 'reserve', 'reserve'),
                                     (worker.Ledger, 'begin_dispatch', 'dispatch'),
                                     (worker.provider, 'bounded_auth_token', 'token'),
                                     (worker, 'endpoint', 'endpoint')):
                stack.enter_context(wrap(obj, name, label))
            stack.enter_context(wrap(fake, 'send', 'send', 100))
            stack.enter_context(wrap(p, '_persist', 'persist', 200))
            stack.enter_context(mock.patch.object(m, '_emit', side_effect=slow_emit))
            self.execute(p)
        report, = self.frames()
        # The trace oracle is independent of the metric collector and counts actual calls.
        boundary = trace.index('endpoint') + 1
        self.assertEqual(trace[:boundary], ['manifest', 'policy', 'verify', 'source', 'request',
                                          'verify', 'identity', 'reserve', 'dispatch', 'token',
                                          'verify', 'endpoint'])
        self.assertEqual(trace[boundary:boundary + 2], ['send', 'persist'])
        # FileStore deliberately reasserts identity during persistence, after freeze.
        self.assertTrue(all(label == 'identity' for label in trace[boundary + 2:]))
        self.assertEqual(report['executor_prepare_ms'], 12)
        self.assertEqual(report['partial_elapsed_ms'], 312 + len(trace[boundary + 2:]))
        self.assertEqual(fake.calls, 1)

    def test_worker_cli_setup_included_and_single_nested_observation(self):
        now = [0]
        p, fake = self.f.pipeline()
        manifest = self.f.root / 'cli-manifest.json'
        grant = self.f.root / 'cli-grant.json'
        manifest.write_bytes(fixtures.canonical(self.f.manifest))
        grant.write_bytes(fixtures.canonical(self.f.envelope))
        def policy():
            now[0] += 5000000
            return self.f.policy
        def construct(value):
            now[0] += 7000000
            return p
        original = worker.read_bytes
        def read(path):
            now[0] += 3000000
            return original(path)
        stdout = io.StringIO()
        with mock.patch.object(m, 'monotonic_ns', side_effect=lambda: now[0]), \
             mock.patch.object(worker, 'load_policy', side_effect=policy), \
             mock.patch.object(worker, 'Pipeline', side_effect=construct), \
             mock.patch.object(worker, 'read_bytes', side_effect=read), \
             mock.patch.object(sys, 'argv', ['worker', 'run', str(manifest), str(grant), '--executor-id', 'offline']), \
             redirect_stdout(stdout):
            self.assertEqual(worker.main(), 0)
        report, = self.frames()
        self.assertEqual(report['entry_point'], 'worker.main')
        self.assertGreaterEqual(report['executor_prepare_ms'], 18)
        self.assertEqual(report['api_setup_coverage'], 'included')
        self.assertEqual(json.loads(stdout.getvalue())['state'], 'PERSISTED')
        self.assertEqual(fake.calls, 1)

    def test_recurrence_cli_bootstrap_and_caught_rejection(self):
        r = queue_fixtures.r
        stdout = io.StringIO()
        with mock.patch.object(r.worker, 'load_policy', return_value=self.f.policy), \
             mock.patch.object(r, 'Queue') as queue, \
             mock.patch.object(sys, 'argv', ['recurrence', 'bootstrap']), redirect_stdout(stdout):
            self.assertEqual(r.main(), 0)
            queue.assert_called_once_with(self.f.policy, bootstrap=True)
        first, = self.frames()
        self.assertEqual(first['coverage'], 'control')
        self.assertFalse(first['boundary_reached'])
        with mock.patch.object(worker, 'load_policy', side_effect=ValueError('secret-path')), \
             mock.patch.object(sys, 'argv', ['worker', 'run', 'unused', 'unused', '--executor-id', 'offline']), \
             redirect_stdout(stdout):
            self.assertEqual(worker.main(), 1)
        self.assertEqual(self.frames()[-1]['coverage'], 'rejected')
        self.assertNotIn('secret-path', self.stderr.getvalue())

    def test_rejection_preserves_exception_identity_and_zero_calls(self):
        p, fake = self.f.pipeline()
        error = ValueError('private-message')
        with mock.patch.object(p, '_source', side_effect=error):
            with self.assertRaises(ValueError) as caught:
                self.execute(p)
        self.assertIs(caught.exception, error)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.frames()[0]['coverage'], 'rejected')
        with self.assertRaises(worker.LedgerDenied):
            p.ledger.get(fixtures.sha(self.f.data))

    def test_endpoint_failure_unknown_without_boundary_or_retry(self):
        p, fake = self.f.pipeline()
        with mock.patch.object(worker, 'endpoint', side_effect=ValueError('endpoint')):
            out = self.execute(p)
        self.assertEqual(out['state'], 'UNKNOWN')
        self.assertFalse(out['retry_allowed'])
        self.assertEqual(fake.calls, 0)
        report, = self.frames()
        self.assertEqual(report['result_state'], 'UNKNOWN')
        self.assertFalse(report['boundary_reached'])
        self.assertEqual(report['coverage'], 'partial')
        self.assertEqual(self.execute(p), out)
        self.assertEqual(fake.calls, 0)

    def test_provider_timeout_unknown_boundary_reached(self):
        p, fake = self.f.pipeline(error=True)
        self.assertEqual(self.execute(p)['state'], 'UNKNOWN')
        report, = self.frames()
        self.assertTrue(report['boundary_reached'])
        self.assertEqual(report['result_state'], 'UNKNOWN')
        self.assertEqual(p.ledger.get(fixtures.sha(self.f.data))['state'], 'UNKNOWN')
        self.assertEqual(fake.calls, 1)

    def test_interruption_before_boundary_preserves_identity(self):
        p, fake = self.f.pipeline()
        error = KeyboardInterrupt('private-interrupt')
        with mock.patch.object(p, '_source', side_effect=error):
            with self.assertRaises(KeyboardInterrupt) as caught:
                self.execute(p)
        self.assertIs(caught.exception, error)
        self.assertEqual(fake.calls, 0)
        report, = self.frames()
        self.assertEqual(report['coverage'], 'interrupted')
        self.assertFalse(report['boundary_reached'])
        self.assertIsNone(m.current())

    def test_interruption_after_boundary_keeps_unknown(self):
        p, fake = self.f.pipeline()
        error = KeyboardInterrupt()
        with mock.patch.object(fake, 'send', side_effect=error) as send:
            with self.assertRaises(KeyboardInterrupt) as caught:
                self.execute(p)
        self.assertIs(caught.exception, error)
        send.assert_called_once()
        self.assertEqual(p.ledger.get(fixtures.sha(self.f.data))['state'], 'UNKNOWN')
        report, = self.frames()
        self.assertEqual(report['coverage'], 'interrupted')
        self.assertTrue(report['boundary_reached'])

    def test_persistence_failure_then_recovery_no_transport(self):
        error = OSError('private-path')
        def hook(event, path, data):
            if event == 'before_write' and path.name == 'provenance.json':
                raise error
        p, fake = self.f.pipeline(hook=hook)
        with self.assertRaises(OSError) as caught:
            self.execute(p)
        self.assertIs(caught.exception, error)
        self.assertEqual(p.ledger.get(fixtures.sha(self.f.data))['state'], 'PERSISTENCE_UNCERTAIN')
        again, fake2 = self.f.pipeline()
        out = again.recover(self.f.manifest, self.f.envelope, executor_id='offline')
        self.assertEqual(out['state'], 'PERSISTED')
        failed, recovery = self.frames()
        self.assertEqual(failed['status'], 'raised')
        self.assertTrue(failed['boundary_reached'])
        self.assertEqual(recovery['coverage'], 'recovery')
        self.assertEqual((fake.calls, fake2.calls), (1, 0))

    def test_metrics_failures_do_not_replace_functional_exception(self):
        for target in ('__init__', 'count', 'span', 'snapshot', 'clock', 'emit'):
            with self.subTest(target=target):
                p, fake = self.f.pipeline()
                error = LookupError('body-error')
                def body(task):
                    m.count('entries')
                    with m.span('history'):
                        raise error
                patch = (mock.patch.object(m, 'monotonic_ns', side_effect=RuntimeError('clock')) if target == 'clock' else
                         mock.patch.object(m, '_emit', side_effect=RuntimeError('emit')) if target == 'emit' else
                         mock.patch.object(m.Metrics, target, side_effect=RuntimeError('collector')))
                with patch, mock.patch.object(p, '_source', side_effect=body):
                    with self.assertRaises(LookupError) as caught:
                        self.execute(p)
                self.assertIs(caught.exception, error)
                self.assertEqual(fake.calls, 0)
                self.assertIsNone(m.current())

    def test_metrics_failures_preserve_success_exactly_once(self):
        for target in ('__init__', 'count', 'span', 'snapshot', 'clock', 'emit'):
            with self.subTest(target=target):
                f = fixtures.WorkerProviderTests('test_full_chain_and_restart_preserve_exact_result')
                f.setUp()
                try:
                    p, fake = f.pipeline()
                    original = p._source
                    def source(task):
                        m.count('entries')
                        return original(task)
                    patch = (mock.patch.object(m, 'monotonic_ns', side_effect=RuntimeError('clock')) if target == 'clock' else
                             mock.patch.object(m, '_emit', side_effect=RuntimeError('emit')) if target == 'emit' else
                             mock.patch.object(m.Metrics, target, side_effect=RuntimeError('collector')))
                    with patch, mock.patch.object(p, '_source', side_effect=source):
                        result = p.run(f.manifest, f.envelope, executor_id='offline')
                    self.assertEqual(result['state'], 'PERSISTED')
                    self.assertEqual(p.ledger.get(fixtures.sha(f.data))['state'], 'PERSISTED')
                    self.assertEqual(fake.calls, 1)
                    self.assertIsNone(m.current())
                finally:
                    f.tearDown()

    def test_exit_bookkeeping_failure_never_masks_body(self):
        p, fake = self.f.pipeline()
        error = RuntimeError('functional')
        @contextmanager
        def broken_span(label):
            try:
                yield
            finally:
                raise ValueError('bookkeeping')
        with mock.patch.object(m.Metrics, 'span', side_effect=broken_span), \
             mock.patch.object(p, '_source', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                self.execute(p)
        self.assertIs(caught.exception, error)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(self.frames()[0]['coverage'], 'unavailable')

    def test_two_items_and_sixteen_copied_contexts(self):
        @m.operational('Pipeline.run')
        def item():
            with ThreadPoolExecutor(max_workers=16) as pool:
                contexts = [copy_context() for _ in range(16)]
                futures = [pool.submit(ctx.run, m.count, 'entries') for ctx in contexts]
                for future in futures:
                    future.result()
        item(); item()
        first, second = self.frames()
        self.assertEqual(first['counters'], {'entries': 16})
        self.assertEqual(second['counters'], {'entries': 16})
        self.assertIsNone(m.current())

    def test_seeded_caller_is_mirror_not_snapshot_with_nested_copied_io(self):
        for workers in (1, 16):
            with self.subTest(workers=workers):
                caller = m.Metrics()
                caller.count('entries', 7)
                calls = []
                @m.operational('Pipeline.recover', kind='recovery')
                def nested():
                    calls.append('nested')
                    with m.span('history'):
                        with ThreadPoolExecutor(max_workers=workers) as pool:
                            contexts = [copy_context() for _ in range(workers)]
                            futures = [pool.submit(ctx.run, m.count, 'entries') for ctx in contexts]
                            for future in futures:
                                future.result()
                @m.operational('Pipeline.run')
                def item():
                    calls.append('outer')
                    nested()
                start = len(self.frames())
                with caller.activate():
                    item(); item()
                    self.assertIs(m.current(), caller)
                    self.assertIsNone(m._OPERATION.get())
                reports = self.frames()[start:]
                self.assertEqual(len(reports), 2)
                self.assertEqual([r['counters'] for r in reports], [{'entries': workers}] * 2)
                self.assertEqual([r['spans']['history']['count'] for r in reports], [1, 1])
                self.assertEqual(caller.snapshot()['counters'], {'entries': 7 + workers * 2})
                self.assertEqual(caller.snapshot()['spans']['history']['count'], 2)
                self.assertEqual(calls, ['outer', 'nested', 'outer', 'nested'])
                self.assertIsNone(m.current())

    def test_optional_mirror_failure_cannot_mask_body_or_own_snapshot(self):
        caller = m.Metrics()
        calls = []
        error = KeyboardInterrupt('original')
        @m.operational('Pipeline.run')
        def item(fail=False):
            calls.append('body')
            m.count('entries')
            with m.span('history'):
                if fail:
                    raise error
                return {'state': 'UNKNOWN'}
        with caller.activate(), \
             mock.patch.object(caller, 'count', side_effect=ValueError('mirror')), \
             mock.patch.object(caller, 'span', side_effect=ValueError('mirror')):
            self.assertEqual(item(), {'state': 'UNKNOWN'})
            with self.assertRaises(KeyboardInterrupt) as caught:
                item(True)
            self.assertIs(caught.exception, error)
            self.assertIs(m.current(), caller)
        self.assertEqual(calls, ['body', 'body'])
        self.assertEqual([r['counters'] for r in self.frames()], [{'entries': 1}] * 2)
        self.assertTrue(all(r['coverage'] == 'unavailable' for r in self.frames()))

    def exercise_context_fault(self, names, method, after, error=None):
        real_active, real_operation = m._ACTIVE, m._OPERATION
        caller = m.Metrics()
        calls = []
        result = {'state': 'UNKNOWN'}
        @m.operational('Pipeline.run')
        def item():
            calls.append('body')
            m.count('entries')
            with m.span('history'):
                if error is not None:
                    raise error
                return result
        start = len(self.frames())
        with caller.activate():
            with ExitStack() as stack:
                wrappers = []
                for name in names:
                    wrapper = FaultyContext(getattr(m, name), method, after)
                    wrappers.append(wrapper)
                    stack.enter_context(mock.patch.object(m, name, wrapper))
                if error is None:
                    self.assertIs(item(), result)
                else:
                    with self.assertRaises(type(error)) as caught:
                        item()
                    self.assertIs(caught.exception, error)
            self.assertIs(real_active.get(), caller)
            self.assertIsNone(real_operation.get())
            # A following item must be fresh, not a leaked nested operation.
            if error is None:
                self.assertIs(item(), result)
            else:
                with self.assertRaises(type(error)):
                    item()
        self.assertEqual(calls, ['body', 'body'])
        first, following = self.frames()[start:]
        self.assertEqual(first['coverage'], 'unavailable')
        self.assertEqual(following['counters'], {'entries': 1})
        self.assertIsNone(real_active.get())
        self.assertIsNone(real_operation.get())
        if method == 'reset':
            for wrapper in wrappers:
                self.assertIn('reset', wrapper.calls)
                self.assertIn('set', wrapper.calls)

    def test_context_reset_before_and_after_preserves_result_and_exception(self):
        for names in (('_ACTIVE',), ('_OPERATION',), ('_ACTIVE', '_OPERATION')):
            for after in (False, True):
                for error in (None, ValueError('original'), KeyboardInterrupt('original')):
                    with self.subTest(names=names, after=after, error=type(error)):
                        self.exercise_context_fault(names, 'reset', after, error)

    def test_context_lookup_and_setup_are_observational(self):
        for name in ('_ACTIVE', '_OPERATION'):
            for method in ('get', 'set'):
                for after in (False, True):
                    for error in (None, ValueError('original'), KeyboardInterrupt('original')):
                        with self.subTest(name=name, method=method, after=after, error=type(error)):
                            self.exercise_context_fault((name,), method, after, error)

    def test_failed_restore_is_best_effort_and_other_context_still_cleans(self):
        for error in (None, ValueError('original'), KeyboardInterrupt('original')):
            with self.subTest(error=type(error)):
                def isolated():
                    real_active, real_operation = m._ACTIVE, m._OPERATION
                    wrapper = FaultyContext(real_active, 'reset', False)
                    sets = []
                    def set_once(value):
                        sets.append(value)
                        if len(sets) > 1:
                            raise RuntimeError('restore unavailable')
                        return real_active.set(value)
                    calls = []
                    result = {'state': 'UNKNOWN'}
                    @m.operational('Pipeline.run')
                    def item():
                        calls.append('body')
                        m.count('entries')
                        if error is not None:
                            raise error
                        return result
                    with mock.patch.object(wrapper, 'set', side_effect=set_once), \
                         mock.patch.object(m, '_ACTIVE', wrapper):
                        if error is None:
                            self.assertIs(item(), result)
                        else:
                            with self.assertRaises(type(error)) as caught:
                                item()
                            self.assertIs(caught.exception, error)
                    self.assertEqual(calls, ['body'])
                    self.assertEqual(len(sets), 2)
                    self.assertIsNone(real_operation.get())
                    self.assertEqual(self.frames()[-1]['coverage'], 'unavailable')
                    # No restoration claim when reset AND fallback set fail.
                    self.assertIsNotNone(real_active.get())
                copy_context().run(isolated)
                self.assertIsNone(m.current())
                self.assertIsNone(m._OPERATION.get())

    def test_reset_failure_preserves_pipeline_ledger_and_transport(self):
        for name in ('_ACTIVE', '_OPERATION'):
            for after in (False, True):
                for unknown in (False, True):
                    with self.subTest(name=name, after=after, unknown=unknown):
                        f = fixtures.WorkerProviderTests('test_full_chain_and_restart_preserve_exact_result')
                        f.setUp()
                        try:
                            p, fake = f.pipeline(error=unknown)
                            wrapper = FaultyContext(getattr(m, name), 'reset', after)
                            with mock.patch.object(m, name, wrapper):
                                result = p.run(f.manifest, f.envelope, executor_id='offline')
                            state = 'UNKNOWN' if unknown else 'PERSISTED'
                            self.assertEqual(result['state'], state)
                            self.assertEqual(p.ledger.get(fixtures.sha(f.data))['state'], state)
                            self.assertEqual(fake.calls, 1)
                            self.assertEqual(self.frames()[-1]['coverage'], 'unavailable')
                            self.assertIsNone(m.current())
                            self.assertIsNone(m._OPERATION.get())
                        finally:
                            f.tearDown()

    def test_queue_api_nested_scope_and_slot_preserved(self):
        f = queue_fixtures.RecurrenceTests('test_01_unsigned_batch_zero_provider')
        f.setUp()
        try:
            f.authorize()
            result, fake = f.execute()
            report, = self.frames()
            self.assertEqual(report['entry_point'], 'Queue.run_one')
            self.assertEqual(report['coverage'], 'NEW_COMPLETE')
            self.assertIn('coordination', report['spans'])
            self.assertEqual(result['state'], 'PERSISTED')
            self.assertEqual(fake.calls, 1)
            recovered = f.q.recover('synthetic-batch', f.f.task['reel_id'], executor_id='offline',
                                    transport=fixtures.FakeProvider())
            self.assertEqual(recovered, result)
            self.assertEqual(self.frames()[-1]['entry_point'], 'Queue.recover')
            self.assertEqual(self.frames()[-1]['coverage'], 'recovery')
        finally:
            f.doCleanups()


class ClassificationCliTests(unittest.TestCase):
    def test_real_cleanup_cli_keeps_control_over_nested_recovery(self):
        import test_recurrence

        f = test_recurrence.RecurrenceTests('test_07_signed_pipeline_success_restart_cleanup_no_acceptance')
        self.addCleanup(f.doCleanups)
        f.setUp()
        f.authorize()
        result, initial_fake = f.execute()
        self.assertEqual(result['state'], 'PERSISTED')
        self.assertEqual(initial_fake.calls, 1)
        batch_id, member_id = 'synthetic-batch', f.f.task['reel_id']
        receipt = f.cleanup_receipt()
        cli_receipt = f.control / batch_id / (member_id + '.cleanup.json')
        f.write_receipt(cli_receipt, json.loads(receipt.read_bytes()))
        receipt_bytes = cli_receipt.read_bytes()
        with f.q.ledger._transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 1)
        pipeline_factory = f.q._pipeline
        cleanup_fakes = []

        def synthetic_pipeline(batch_id, *, transport=None, writer_hook=None):
            if transport is None:
                transport = fixtures.FakeProvider()
                cleanup_fakes.append(transport)
            return pipeline_factory(batch_id, transport=transport, writer_hook=writer_hook)

        r = test_recurrence.r
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(r.worker, 'load_policy', return_value=f.f.policy), \
             mock.patch.object(r, 'Queue', return_value=f.q) as queue_factory, \
             mock.patch.object(f.q, '_pipeline', side_effect=synthetic_pipeline), \
             mock.patch.object(worker.Pipeline, '_source', side_effect=AssertionError('source read')) as source, \
             mock.patch.object(worker.provider, 'bounded_auth_token', side_effect=AssertionError('new auth')) as auth, \
             mock.patch.object(sys, 'argv', ['recurrence', 'cleanup', batch_id, '--member-id', member_id,
                                             '--executor-id', 'offline-cleanup']), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(r.main(), 0)
        queue_factory.assert_called_once_with(f.f.policy)
        source.assert_not_called()
        auth.assert_not_called()
        self.assertEqual(len(cleanup_fakes), 1)
        self.assertEqual(cleanup_fakes[0].calls, 0)
        status = f.q.status(batch_id)
        self.assertEqual((status[0]['persisted'], status[0]['cleanup'], status[0]['review'], status[0]['state']),
                         (1, 1, 1, 'NEEDS_REVIEW'))
        self.assertEqual(stdout.getvalue(), fixtures.canonical(status).decode() + '\n')
        self.assertEqual(cli_receipt.read_bytes(), receipt_bytes)
        with f.q.ledger._transaction() as db:
            row = db.execute('SELECT * FROM recurrence_members').fetchone()
            self.assertEqual(row['cleanup_path'], str(cli_receipt))
            self.assertEqual(row['cleanup_sha256'], fixtures.sha(receipt_bytes))
            self.assertEqual(json.loads(row['result_json']), result)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM recurrence_slot').fetchone()[0], 0)
        self.assertIsNone(f.q.next(batch_id))
        report, = [json.loads(line)['preparation_observation'] for line in stderr.getvalue().splitlines()]
        self.assertEqual(report['entry_point'], 'recurrence.main')
        self.assertEqual(report['kind'], 'control')
        self.assertEqual(report['coverage'], 'control')
        self.assertFalse(report['boundary_reached'])
        self.assertIsNone(report['executor_prepare_ms'])
        self.assertTrue(report['synthetic'])
        self.assertIsNone(m.current())
        self.assertIsNone(m._OPERATION.get())

    def test_explicit_worker_cli_recover_stays_recovery_without_send(self):
        f = fixtures.WorkerProviderTests('test_full_chain_and_restart_preserve_exact_result')
        self.addCleanup(f.tearDown)
        f.setUp()
        pipeline, initial_fake = f.pipeline()
        result = pipeline.run(f.manifest, f.envelope, executor_id='offline-setup')
        self.assertEqual(result['state'], 'PERSISTED')
        self.assertEqual(initial_fake.calls, 1)
        recovered_pipeline, fake = f.pipeline()
        manifest, grant = f.root / 'cli-manifest.json', f.root / 'cli-grant.json'
        manifest.write_bytes(fixtures.canonical(f.manifest))
        grant.write_bytes(fixtures.canonical(f.envelope))
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(worker, 'load_policy', return_value=f.policy), \
             mock.patch.object(worker, 'Pipeline', return_value=recovered_pipeline), \
             mock.patch.object(recovered_pipeline, '_source', side_effect=AssertionError('source read')) as source, \
             mock.patch.object(worker.provider, 'bounded_auth_token', side_effect=AssertionError('new auth')) as auth, \
             mock.patch.object(sys, 'argv', ['worker', 'recover', str(manifest), str(grant),
                                             '--executor-id', 'offline-recovery']), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(worker.main(), 0)
        source.assert_not_called()
        auth.assert_not_called()
        self.assertEqual(fake.calls, 0)
        self.assertEqual(stdout.getvalue(), fixtures.canonical(result).decode() + '\n')
        report, = [json.loads(line)['preparation_observation'] for line in stderr.getvalue().splitlines()]
        self.assertEqual(report['entry_point'], 'worker.main')
        self.assertEqual(report['kind'], 'recovery')
        self.assertEqual(report['coverage'], 'recovery')
        self.assertFalse(report['boundary_reached'])
        self.assertIsNone(report['executor_prepare_ms'])
        self.assertIsNone(m.current())
        self.assertIsNone(m._OPERATION.get())
