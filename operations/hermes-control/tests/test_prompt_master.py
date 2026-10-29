"""Deterministic negative-path simulations, never a substitute for live delegation."""
import copy, datetime as dt, hashlib, importlib.util, json, os, sqlite3, stat, tempfile, unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prompt_master as pm

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.oldroot,self.olddb=pm.ROOT,pm.DB;pm.ROOT=self.root;pm.DB=self.root/'ledger.sqlite'
        self.scope_patch=patch.object(pm,'configure_scope',return_value=None);self.scope_patch.start()
        for n in ['inbox','runs','synthetic-workspace']:(self.root/n).mkdir(mode=0o700)
        source=Path(__file__).resolve().parent/'fixtures/synthetic-prompt-master.json'
        self.task=json.loads(source.read_text());self.task['task_id']='MB-NEGATIVE-TEST-00001'
        self.task['scope']['workspace']=str(self.root/'synthetic-workspace')
        self.task['expires_at']=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1)).isoformat()
        real_fstat=os.fstat
        def fixture_uid_only(fd):
            st=real_fstat(fd)
            fixture=self.root/'inbox/task.json'
            if fixture.exists() and (st.st_dev,st.st_ino)==(fixture.stat().st_dev,fixture.stat().st_ino):
                fields=list(st);fields[4]=0
                return os.stat_result(fields)
            return st
        self.uid_patch=patch.object(pm.os,'fstat',side_effect=fixture_uid_only)
        self.uid_patch.start()
    def tearDown(self):
        self.uid_patch.stop();self.scope_patch.stop();pm.ROOT,pm.DB=self.oldroot,self.olddb;self.temp.cleanup()
    def save(self):
        p=self.root/'inbox/task.json';data=json.dumps(self.task).encode();p.write_bytes(data);p.chmod(0o600)
        return p,hashlib.sha256(data).hexdigest()
    def test_missing_authorization(self):
        self.task['authorization_ref']='none'
        with self.assertRaises(ValueError):pm.validate(self.task)
    def test_external_operation_denied(self):
        self.task['allowed_operations'].append('google')
        with self.assertRaises(ValueError):pm.validate(self.task)
    def test_expired(self):
        self.task['expires_at']='2020-01-01T00:00:00+00:00'
        with self.assertRaises(ValueError):pm.validate(self.task)
    def test_budget_expansion_denied(self):
        self.task['resource_policy']['max_model_calls']=17
        with self.assertRaises(ValueError):pm.validate(self.task)
    def test_integrity_failure_before_launch(self):
        p,h=self.save();p.write_text(p.read_text()+' ')
        with patch.object(pm.subprocess,'run') as launch:
            with self.assertRaises(ValueError):pm.execute(p,h)
            launch.assert_not_called()
    def test_symlink_rejected(self):
        p,h=self.save();link=self.root/'inbox/link.json';link.symlink_to(p)
        with self.assertRaises(ValueError):pm.load_trusted(link,h)
    def test_world_readable_rejected(self):
        p,h=self.save();p.chmod(0o644)
        with self.assertRaises(ValueError):pm.load_trusted(p,h)
    def test_interruption_unknown_never_replayed(self):
        p,h=self.save()
        with patch.object(pm.subprocess,'run',side_effect=TimeoutError('simulated interruption')) as launch:
            with self.assertRaises(TimeoutError):pm.execute(p,h)
            self.assertEqual(launch.call_count,1)
        with pm.connect() as db:
            self.assertEqual(db.execute('select status from tasks').fetchone()[0],'unknown')
        with patch.object(pm.subprocess,'run') as launch:
            with self.assertRaisesRegex(ValueError,'Duplicate'):pm.execute(p,h)
            launch.assert_not_called()
    def test_profile_lock_blocks_second_writer(self):
        p,h=self.save()
        with (self.root/'profile-execution.lock').open('a') as lock:
            pm.fcntl.flock(lock,pm.fcntl.LOCK_EX|pm.fcntl.LOCK_NB)
            with patch.object(pm.subprocess,'run') as launch:
                with self.assertRaises(BlockingIOError):pm.execute(p,h)
                launch.assert_not_called()
    def test_specialist_failure_never_success(self):
        p,h=self.save()
        def fail(*args,**kwargs):
            run=self.root/'runs'/self.task['task_id']
            (run/'receipt.json').write_text(json.dumps({'passed':False,'session_id':'simulated-failed-specialist'}))
            return type('Exit',(),{'returncode':2})()
        with patch.object(pm.subprocess,'run',side_effect=fail):self.assertEqual(pm.execute(p,h),2)
        with pm.connect() as db:self.assertEqual(db.execute('select status from tasks').fetchone()[0],'unknown')
    def test_packaged_runtime_launch_is_adjacent_to_dispatcher(self):
        p,h=self.save()
        def complete(argv, **kwargs):
            self.assertEqual(Path(argv[1]), Path(pm.__file__).resolve().with_name('hermes_runtime.py'))
            self.assertNotEqual(Path(argv[1]), self.root/'hermes_runtime.py')
            self.assertEqual(Path(argv[2]), self.root/'runs'/self.task['task_id'])
            (Path(argv[2])/'receipt.json').write_text(json.dumps({'passed':True,'session_id':'local-packaging-fixture'}))
            return type('Exit',(),{'returncode':0})()
        with patch.object(pm.subprocess,'run',side_effect=complete) as launch:
            self.assertEqual(pm.execute(p,h),0)
            launch.assert_called_once()

    def test_paperclip_is_not_a_required_field(self):
        self.assertNotIn('paperclip_issue_id',pm.REQUIRED);self.assertIs(pm.validate(self.task),self.task)

class TrustedStatTests(unittest.TestCase):
    def test_production_predicate_positive_and_each_negative(self):
        good={'st_mode':stat.S_IFREG|0o600,'st_uid':0,'st_nlink':1}
        self.assertTrue(pm.trusted_contract_stat(SimpleNamespace(**good)))
        for field,value in [('st_uid',1000),('st_nlink',2),('st_nlink',0),
                ('st_mode',stat.S_IFDIR|0o600),('st_mode',stat.S_IFLNK|0o600),
                ('st_mode',stat.S_IFIFO|0o600),('st_mode',stat.S_IFREG|0o644),
                ('st_mode',stat.S_IFREG|0o400),('st_mode',stat.S_IFREG|0o700),
                ('st_mode',stat.S_IFREG|0o4600)]:
            with self.subTest(field=field,value=value):
                self.assertFalse(pm.trusted_contract_stat(SimpleNamespace(**(good|{field:value}))))

if __name__=='__main__':
    os.umask(0o077);unittest.main()
