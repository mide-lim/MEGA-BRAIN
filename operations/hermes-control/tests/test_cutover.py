"""Self-contained state-machine regressions; never edit real cutover artifacts."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('cutover_under_test', REPO/'scripts/check_hermes_cutover.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = b'fixture old instructions\r\n'
        self.proposal = b'fixture proposed instructions\n'
        self.workflow = b'fixture original workflow\n'
        for name, data in zip(checker.PATHS, (
                self.old, self.old, self.proposal, self.workflow, self.workflow)):
            self.write(name, data)
        for name, value in [('ORIGINAL_AGENTS_SHA256', digest(self.old)),
                            ('ORIGINAL_WORKFLOW_SHA256', digest(self.workflow))]:
            patcher = patch.object(checker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.manifest = {
            'schema_version': 'megabrain.hermes-cutover.v1', 'status': checker.PENDING,
            'active_agents': {'path': checker.PATHS[0], 'sha256': digest(self.old)},
            'historical_agents': {'path': checker.PATHS[1], 'sha256': digest(self.old)},
            'agents_replacement': {'source': checker.PATHS[2], 'target': checker.PATHS[0],
                                   'sha256': digest(self.proposal)},
            'workflow_archive': {'source': checker.PATHS[3], 'target': checker.PATHS[4],
                                 'sha256': digest(self.workflow)}}
        self.save()

    def write(self, name, data):
        path = self.root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save(self):
        self.write('ops/hermes/cutover.json', json.dumps(self.manifest).encode())

    def apply_fixture(self):
        self.manifest['status'] = checker.APPLIED
        self.manifest['active_agents']['sha256'] = digest(self.proposal)
        self.write(checker.PATHS[0], self.proposal)
        (self.root/checker.PATHS[3]).unlink()
        self.save()

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes()
                for p in self.root.rglob('*') if p.is_file()}

    def test_pending_success_is_read_only(self):
        before = self.snapshot()
        self.assertEqual(set(checker.verify(self.root)), set(checker.PATHS))
        self.assertEqual(self.snapshot(), before)

    def test_applied_success_is_read_only(self):
        self.apply_fixture()
        before = self.snapshot()
        self.assertEqual(set(checker.verify(self.root)), set(checker.PATHS)-{checker.PATHS[3]})
        self.assertEqual(self.snapshot(), before)

    def test_altered_artifact_bytes_rejected_in_both_phases(self):
        for applied in (False, True):
            if applied:
                self.apply_fixture()
            for path in (checker.PATHS[1], checker.PATHS[2], checker.PATHS[4]):
                with self.subTest(applied=applied, path=path):
                    original = (self.root/path).read_bytes()
                    self.write(path, b'altered\n')
                    with self.assertRaises(ValueError):
                        checker.verify(self.root)
                    self.write(path, original)

    def test_altered_manifest_hashes_rejected_in_both_phases(self):
        for applied in (False, True):
            if applied:
                self.apply_fixture()
            for entry in ('active_agents', 'agents_replacement', 'historical_agents', 'workflow_archive'):
                with self.subTest(applied=applied, entry=entry):
                    original = self.manifest[entry]['sha256']
                    self.manifest[entry]['sha256'] = '0'*64
                    self.save()
                    with self.assertRaises(ValueError):
                        checker.verify(self.root)
                    self.manifest[entry]['sha256'] = original
                    self.save()

    def test_coordinated_original_baseline_rewrites_rejected(self):
        for entry, paths in [('historical_agents', (checker.PATHS[0], checker.PATHS[1])),
                             ('workflow_archive', (checker.PATHS[3], checker.PATHS[4]))]:
            with self.subTest(entry=entry):
                originals = {p: (self.root/p).read_bytes() for p in paths}
                original_hash = self.manifest[entry]['sha256']
                for path in paths:
                    self.write(path, b'rewritten baseline')
                self.manifest[entry]['sha256'] = digest(b'rewritten baseline')
                self.save()
                with self.assertRaises(ValueError):
                    checker.verify(self.root)
                for path, data in originals.items():
                    self.write(path, data)
                self.manifest[entry]['sha256'] = original_hash
                self.save()

    def test_old_workflow_present_after_applied_rejected(self):
        self.apply_fixture()
        self.write(checker.PATHS[3], self.workflow)
        with self.assertRaisesRegex(ValueError, 'workflow still present'):
            checker.verify(self.root)

    def test_dangling_old_workflow_after_applied_rejected(self):
        self.apply_fixture()
        (self.root/checker.PATHS[3]).symlink_to('nonexistent')
        with self.assertRaises((ValueError, FileNotFoundError)):
            checker.verify(self.root)

    def test_unknown_and_missing_status_rejected(self):
        for status in ('unknown', 'applied', '', None, 1):
            with self.subTest(status=status):
                self.manifest['status'] = status
                self.save()
                with self.assertRaisesRegex(ValueError, 'Unknown cutover status'):
                    checker.verify(self.root)
        del self.manifest['status']
        self.save()
        with self.assertRaises(ValueError):
            checker.verify(self.root)

    def test_phase_and_files_inconsistent_rejected(self):
        self.manifest['status'] = checker.APPLIED
        self.save()
        with self.assertRaises(ValueError):
            checker.verify(self.root)
        self.apply_fixture()
        self.manifest['status'] = checker.PENDING
        self.save()
        with self.assertRaises(ValueError):
            checker.verify(self.root)

    def test_active_manifest_old_hash_after_applied_rejected(self):
        self.apply_fixture()
        self.manifest['active_agents']['sha256'] = digest(self.old)
        self.save()
        with self.assertRaises(ValueError):
            checker.verify(self.root)

    def test_missing_pending_workflow_and_changed_active_rejected(self):
        (self.root/checker.PATHS[3]).unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            checker.verify(self.root)
        self.write(checker.PATHS[3], self.workflow)
        self.write(checker.PATHS[0], self.old.replace(b'\r\n', b'\n'))
        with self.assertRaises(ValueError):
            checker.verify(self.root)


if __name__ == '__main__':
    unittest.main()
