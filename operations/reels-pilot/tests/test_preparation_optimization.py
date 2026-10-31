"""Offline synthetic regression tests for fresh bounded preparation IO."""
import concurrent.futures
from contextvars import ContextVar, copy_context
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recurrence
import preparation_metrics as metrics
from common import ContractError, sha
from storage import FileStore


class OptimizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.media = self.root / 'media/reels'
        self.results = self.root / 'results'
        self.media.mkdir(parents=True)
        self.results.mkdir()
        self.view = type('View', (), {'policy': {'roots': {
            'media_root': {'root_id': str(self.root)},
            'result_root': {'root_id': str(self.results)}}}})()
        self.member = {'manifest': {'task': {'reel_id': 'target', 'source': {
            'source_video_sha256': 'a'*64, 'metadata_sha256': 'b'*64}}}}

    def scan(self):
        recurrence.Queue._history(self.view, self.member)

    def bundle(self, read_only=True):
        folder = self.results / 'bundle'
        folder.mkdir()
        data = {'analysis.v1.json': b'{"identity":{}}',
                'provenance.json': b'{"metadata_sha256":"synthetic"}', 'other': b'covered'}
        for name, raw in data.items():
            (folder / name).write_bytes(raw)
        manifest = {'manifest_version': 'readback.v1', 'metadata': {},
                    'files_sha256': {n: sha(v) for n, v in data.items()}}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        m = metrics.Metrics()
        return FileStore(self.results, read_only=read_only, metrics=m), folder, data, m

    def selected(self, store):
        return store.verify_selected('bundle', ('analysis.v1.json', 'provenance.json'))

    def test_complete_counts_context_and_fresh_call(self):
        for root in (self.media, self.results):
            for i in range(20):
                child = root / str(i)
                child.mkdir()
                (child / 'history.json').write_bytes(b'{}')
        m = metrics.Metrics(clock=iter((10, 20, 30, 50)).__next__)
        token_var = ContextVar('synthetic_context')
        token_var.set('preserved')
        load = recurrence.approval.load_json
        def checked(raw):
            self.assertEqual(token_var.get(), 'preserved')
            self.assertIs(metrics.current(), m)
            return load(raw)
        with mock.patch.object(recurrence.approval, 'load_json', side_effect=checked), m.activate():
            self.scan()
            self.scan()
        self.assertEqual(m.snapshot()['counters'], {'directories': 84, 'entries': 160,
                                                   'history_reads': 80, 'history_bytes': 160})
        self.assertEqual(m.spans['history'], {'count': 2, 'duration_ns': 30, 'exceptions': 0})
        (self.media / '0/history.json').write_text('{"deep":[{"collision":"target"}]}')
        with self.assertRaises(ContractError):
            self.scan()

    def test_global_bound_across_roots(self):
        for root in (self.media, self.results):
            (root / 'ordinary').touch()
        original = os.scandir
        class Many:
            def __init__(self, fd):
                with original(fd) as entries:
                    self.entry = next(entries)
            def __enter__(self):
                return iter([self.entry] * 10001)
            def __exit__(self, *args):
                pass
        with mock.patch.object(recurrence.os, 'scandir', Many):
            with self.assertRaisesRegex(ContractError, 'history scan bound'):
                self.scan()

    def test_symlink_rejected(self):
        (self.media / 'escape').symlink_to(self.results, target_is_directory=True)
        with self.assertRaisesRegex(ContractError, 'symlink'):
            self.scan()

    def test_directory_replaced_at_open(self):
        child = self.media / 'child'
        child.mkdir()
        original = os.open
        def replaced(path, flags, *args, **kwargs):
            if Path(path) == child:
                child.rename(self.media / 'old')
                child.mkdir()
            return original(path, flags, *args, **kwargs)
        with mock.patch.object(recurrence.os, 'open', side_effect=replaced):
            with self.assertRaisesRegex(ContractError, 'directory replaced'):
                self.scan()

    def test_file_replaced_at_open(self):
        history = self.media / 'history.json'
        history.write_bytes(b'{}')
        original = os.open
        def replaced(path, flags, *args, **kwargs):
            if path == 'history.json':
                history.rename(self.media / 'old')
                history.write_bytes(b'{}')
            return original(path, flags, *args, **kwargs)
        with mock.patch.object(recurrence.os, 'open', side_effect=replaced):
            with self.assertRaisesRegex(ContractError, 'file replaced'):
                self.scan()

    def test_malformed_history(self):
        (self.media / 'history.json').write_bytes(b'{')
        with self.assertRaises((ContractError, ValueError)):
            self.scan()

    def test_oversized_history(self):
        (self.media / 'analysis.json').write_bytes(b' ' * 1000001)
        with self.assertRaisesRegex(ContractError, 'history size'):
            self.scan()

    def test_failure_joins_workers_and_closes_fds(self):
        (self.media / 'history.json').write_bytes(b'{')
        barrier = threading.Barrier(2)
        original = os.scandir
        def together(fd):
            barrier.wait(timeout=5)
            return original(fd)
        before = set(os.listdir('/proc/self/fd'))
        threads = {t.ident for t in threading.enumerate()}
        with mock.patch.object(recurrence.os, 'scandir', side_effect=together):
            with self.assertRaises((ContractError, ValueError)):
                self.scan()
        self.assertEqual(set(os.listdir('/proc/self/fd')), before)
        self.assertEqual({t.ident for t in threading.enumerate()}, threads)

    def test_shared_counter_and_span_locking(self):
        m = metrics.Metrics()
        def job():
            self.assertIs(metrics.current(), m)
            for _ in range(1000):
                with metrics.span('prior'):
                    metrics.count('entries')
                m.snapshot()
        with m.activate(), concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(copy_context().run, job) for _ in range(8)]
            for future in futures:
                future.result()
        self.assertEqual(m.counters['entries'], 8000)
        self.assertEqual(m.spans['prior']['count'], 8000)
        self.assertIsNone(metrics.current())

    def test_verified_bytes_counts_and_default_semantics(self):
        store, folder, data, m = self.bundle()
        result = self.selected(store)
        self.assertEqual(result['selected'], {n: data[n] for n in ('analysis.v1.json', 'provenance.json')})
        self.assertEqual(result['manifest_raw'], (folder / 'manifest.json').read_bytes())
        self.assertEqual(result['manifest_sha256'], sha(result['manifest_raw']))
        self.assertEqual(m.counters['artifact_reads'], 4)
        self.assertEqual(m.counters['artifact_verifications'], 1)
        self.assertEqual(store.verify('bundle'), result['manifest'])

    def test_required_manifest_coverage(self):
        store, folder, data, m = self.bundle()
        manifest = json.loads((folder / 'manifest.json').read_bytes())
        del manifest['files_sha256']['provenance.json']
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ContractError, 'not covered'):
            self.selected(store)

    def test_unselected_corruption_and_fresh_second_call(self):
        store, folder, data, m = self.bundle()
        self.selected(store)
        (folder / 'other').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ContractError, 'artifact mismatch'):
            self.selected(store)
        self.assertEqual(m.counters['artifact_verifications'], 2)

    def test_pass_detects_change_after_earlier_read(self):
        store, folder, data, m = self.bundle(read_only=False)
        original = store.get
        def changed(relative, **kwargs):
            raw = original(relative, **kwargs)
            if relative.endswith('/other'):
                (folder / 'analysis.v1.json').write_bytes(b'changed')
            return raw
        with mock.patch.object(store, 'get', side_effect=changed):
            with self.assertRaisesRegex(ContractError, 'changed during verification'):
                self.selected(store)

    def test_manifest_path_escape_and_symlink(self):
        store, folder, data, m = self.bundle()
        (folder / 'other').unlink()
        (folder / 'other').symlink_to(folder / 'analysis.v1.json')
        with self.assertRaisesRegex(ContractError, 'symlink'):
            self.selected(store)
        (folder / 'other').unlink()
        manifest = json.loads((folder / 'manifest.json').read_bytes())
        manifest['files_sha256']['../escape'] = 'a'*64
        (folder / 'other').write_bytes(data['other'])
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ContractError, 'path escape'):
            self.selected(store)
