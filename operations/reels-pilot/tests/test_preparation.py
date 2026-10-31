"""Deterministic synthetic instrumentation tests; no media or provider access."""
import sys
from pathlib import Path
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preparation_metrics as m
import recurrence
import test_worker_provider as fixtures


class MetricsTests(unittest.TestCase):
    def test_exception_span_and_exact_clock(self):
        metrics = m.Metrics(clock=iter((10, 35)).__next__)
        with self.assertRaisesRegex(RuntimeError, 'private'):
            with metrics.span('history'):
                raise RuntimeError('private')
        self.assertEqual(metrics.snapshot(), {'spans': {'history': {
            'count': 1, 'duration_ns': 25, 'exceptions': 1}}, 'counters': {}})

    def test_label_negative_type_and_overflow(self):
        metrics = m.Metrics()
        for amount in (-1, True, 1.5, m.LIMIT + 1):
            with self.assertRaises(ValueError):
                metrics.count('entries', amount)
        with self.assertRaises(ValueError):
            metrics.count('/private/path')
        metrics.count('entries', m.LIMIT)
        with self.assertRaises(ValueError):
            metrics.count('entries')

    def test_clock_negative_and_overflow(self):
        for ticks in ((2, 1), (-1, 2), (0, m.LIMIT + 1)):
            with self.assertRaises(ValueError):
                with m.Metrics(clock=iter(ticks).__next__).span('media'):
                    pass

    def test_default_is_inert_and_context_restored(self):
        @m.measured('history')
        def value():
            m.count('entries')
            return 7
        self.assertIsNone(m.current())
        self.assertEqual(value(), 7)
        metrics = m.Metrics(clock=iter((1, 2)).__next__)
        with metrics.activate():
            self.assertEqual(value(), 7)
        self.assertIsNone(m.current())
        snapshot = metrics.snapshot(); snapshot['counters']['entries'] = 99
        self.assertEqual(metrics.counters['entries'], 1)

    def test_actual_history_reads_counts_and_repeated_fresh_scans(self):
        with __import__('tempfile').TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'media/reels').mkdir(parents=True)
            (root/'results').mkdir()
            history = root/'media/reels/history.json'
            history.write_bytes(b'{"synthetic":true}')
            class View:
                policy = {'roots': {'media_root': {'root_id': str(root)},
                                    'result_root': {'root_id': str(root/'results')}}}
            member = {'manifest': {'task': {'reel_id': 'synthetic', 'source': {
                'source_video_sha256': 'a'*64, 'metadata_sha256': 'b'*64}}}}
            metrics = m.Metrics()
            with metrics.activate():
                recurrence.Queue._history(View(), member)
                history.write_bytes(b'{"synthetic":false}')
                recurrence.Queue._history(View(), member)
            self.assertEqual(metrics.counters['history_reads'], 2)
            self.assertEqual(metrics.counters['history_bytes'], 37)
            self.assertEqual(metrics.spans['history']['count'], 2)
            self.assertEqual(metrics.counters['directories'], 4)

    def test_pipeline_actual_request_and_final_controls(self):
        fixture = fixtures.WorkerProviderTests()
        fixture.setUp()
        try:
            pipeline, fake = fixture.pipeline()
            metrics = m.Metrics()
            with metrics.activate():
                result = pipeline.run(fixture.manifest, fixture.envelope, executor_id='synthetic')
            self.assertEqual(result['state'], 'PERSISTED')
            self.assertEqual(fake.calls, 1)
            for label in ('preparation', 'media', 'request', 'final_controls'):
                self.assertEqual(metrics.spans[label]['count'], 1)
            self.assertIn('reels-pilot/preparation_metrics.py', fixtures.worker.version_pins())
        finally:
            fixture.tearDown()
