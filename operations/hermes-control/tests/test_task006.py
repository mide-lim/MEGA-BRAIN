"""Portable task006 regressions. All clients/dispatch are local test doubles."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

CONTROL = Path(__file__).resolve().parents[1]
REPO = CONTROL.parents[1]
sys.path.insert(0, str(CONTROL))
import prompt_master as pm
import hermes_runtime as runtime
from role_policy import OFFLINE_MODELS, OFFLINE_PROFILE_MODELS

class PolicyTests(unittest.TestCase):
    def task(self, budget=48):
        task = json.loads((CONTROL/'tests/fixtures/synthetic-prompt-master.json').read_text())
        task['scope'] = {'workspace': str(pm.OFFLINE_WORKSPACE), 'data': 'offline-code-only'}
        task['allowed_operations'] = sorted(pm.OFFLINE_ALLOWED)
        task['resource_policy'] = {'model': dict(OFFLINE_MODELS), 'provider': 'openai-codex',
            'max_model_calls': budget, 'deadline_seconds': 600, 'max_spawn_depth': 2,
            'concurrency': 1, 'paid_fallback': False}
        task['expires_at'] = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1)).isoformat()
        task['context_refs'] = ['worktree-sha256:test-pin']
        return task

    def test_budget32_48_and_child_iterations(self):
        for budget, iterations in [(32, 12), (48, 18)]:
            with self.subTest(budget=budget):
                task = self.task(budget)
                self.assertIs(pm.validate(task), task)
                self.assertEqual(pm.child_iterations(task), iterations)
        synthetic = json.loads((CONTROL/'tests/fixtures/synthetic-prompt-master.json').read_text())
        self.assertEqual(pm.child_iterations(synthetic), 6)

    def test_reject_other_budgets_and_financial_scope_changes(self):
        for value in [True, 16, 31, 33, 47, 49, '48']:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): pm.validate(self.task(value))
        for field, value in [('provider','paid'), ('concurrency',2), ('deadline_seconds',601),
                             ('max_spawn_depth',3), ('paid_fallback',True)]:
            task = self.task(); task['resource_policy'][field] = value
            with self.assertRaises(ValueError): pm.validate(task)
        task = self.task(); task['resource_policy']['model']['reels'] = 'gpt-6-luna'
        with self.assertRaises(ValueError): pm.validate(task)
        task = self.task(); task['allowed_operations'].append('google')
        with self.assertRaises(ValueError): pm.validate(task)

    def test_authority_roots_are_pinned_not_environment_selected(self):
        with patch.dict('os.environ', {'HERMES_CONTROL_ROOT':'/tmp/untrusted',
                                      'HERMES_WORKSPACE':'/tmp/untrusted'}):
            self.assertEqual(pm.BASE, Path('/srv/vps-mcp/workspace/megabrain-restructure'))
            self.assertEqual(pm.ROOT, pm.BASE/'operations/hermes-migration')
            self.assertEqual(runtime.ROOT, pm.ROOT)
            task = self.task(); task['scope']['workspace'] = '/tmp/untrusted'
            with self.assertRaisesRegex(ValueError, 'Scope'): pm.validate(task)

    def test_configuration_budget_models_and_children_without_profile_writes(self):
        for budget, iterations in [(32,12), (48,18)]:
            configs = []
            template = {'terminal': {'docker_volumes':[], 'docker_env':{}, 'backend':'docker',
                'docker_network':False, 'docker_forward_env':False}, 'delegation':{},
                'agent':{}, 'fallback_providers':[], 'approvals':{}}
            fake_yaml = SimpleNamespace(safe_load=lambda _: copy.deepcopy(template),
                safe_dump=lambda config, **kw: configs.append(copy.deepcopy(config)) or '{}')
            with patch.dict(sys.modules, {'yaml':fake_yaml}), \
                 patch.object(Path,'read_text',return_value='{}'), \
                 patch.object(Path,'write_text') as writes, \
                 patch.object(Path,'is_dir',return_value=True), \
                 patch.object(pm.subprocess,'check_output',return_value='4b16ee0f5ffd8016f3c6eef9143fda54926109cb'), \
                 patch.object(pm,'tree_digest',return_value='test-pin'):
                pm.configure_scope(self.task(budget))
                self.assertEqual(writes.call_count, 5)
            self.assertEqual([c['model']['default'] for c in configs],
                             ['gpt-6-luna','gpt-6.1-sol','gpt-6.1-sol','gpt-6.1-sol'])
            for config in configs:
                self.assertEqual(config['delegation']['oneshot_max_children'], 4)
                self.assertEqual(config['delegation']['max_iterations'], iterations)
                self.assertEqual(config['delegation']['child_timeout_seconds'], 420)
                self.assertFalse(config['terminal']['docker_network'])

class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(pm,'ROOT',self.root); self.root_patch.start()
        self.db_patch = patch.object(pm,'DB',self.root/'dispatch.sqlite'); self.db_patch.start()
        self.tid = 'MB-TASK006-RETRIEVAL-0001'
        with pm.connect() as db:
            db.execute('insert into tasks values(?,?,?,?,?)', (self.tid,'sha','running','session-real-fixture','stamp'))
            pm.event(db,self.tid,'accepted',{'sha256':'sha'})
            pm.event(db,self.tid,'running',{})
    def tearDown(self):
        self.db_patch.stop(); self.root_patch.stop(); self.temp.cleanup()
    def test_status_read_only_ordered_and_receipt_not_loaded(self):
        with patch.object(Path,'read_text',side_effect=AssertionError('status must not read receipt')):
            status = pm.retrieve(self.tid)
        self.assertEqual(status['status'],'running')
        self.assertEqual(status['session_id'],'session-real-fixture')
        self.assertEqual([e['kind'] for e in status['events']], ['accepted','running'])
        self.assertNotIn('receipt',status)
        with pm.connect() as db:
            self.assertEqual(db.execute('select count(*) from events').fetchone()[0],2)
    def test_result_missing_then_present_and_unknown_state(self):
        self.assertIsNone(pm.retrieve(self.tid,result=True)['receipt'])
        receipt = {'passed':False,'session_id':'fixture-interrupted'}
        path = self.root/'runs'/self.tid/'receipt.json'; path.parent.mkdir(parents=True)
        path.write_text(json.dumps(receipt))
        with pm.connect() as db:
            db.execute('update tasks set status=? where id=?',('unknown',self.tid))
        answer = pm.retrieve(self.tid,result=True)
        self.assertEqual(answer['receipt'],receipt)
        self.assertEqual(answer['status'],'unknown')
    def test_invalid_unknown_and_missing_database_do_not_create_tasks(self):
        for tid in ['../escape','MB-VALID-BUT-UNKNOWN']:
            with self.assertRaises(ValueError): pm.retrieve(tid,result=True)
        missing = self.root/'missing.sqlite'
        with patch.object(pm,'DB',missing):
            with self.assertRaises(sqlite3.OperationalError): pm.retrieve(self.tid)
        self.assertFalse(missing.exists())
    def test_corrupt_receipt_is_not_success(self):
        path = self.root/'runs'/self.tid/'receipt.json'; path.parent.mkdir(parents=True)
        path.write_text('{broken')
        with self.assertRaises(json.JSONDecodeError): pm.retrieve(self.tid,result=True)

class BudgetTests(unittest.TestCase):
    def client(self):
        return SimpleNamespace(base_url='https://chatgpt.com/backend-api/codex',
                               max_retries=99, responses=SimpleNamespace(create=Mock(return_value='fake-local-only')))
    def test_fake_client_enforces32_48_exactly_and_idempotent_protection(self):
        for limit in [32,48]:
            client=self.client(); original=client.responses.create; events=[]
            guard=runtime.CallBudget(limit,events,OFFLINE_PROFILE_MODELS)
            agent=SimpleNamespace(session_id='fixture-developer',tools=[])
            with patch.object(runtime,'get_hermes_home',return_value=Path('/fixture/developer')):
                self.assertIs(guard.protect(client,agent),client)
                guard.protect(client,agent)
                for _ in range(limit): self.assertEqual(client.responses.create(model='gpt-6.1-sol'), 'fake-local-only')
                with self.assertRaisesRegex(RuntimeError,'budget exhausted'):
                    client.responses.create(model='gpt-6.1-sol')
            self.assertEqual(original.call_count,limit)
            self.assertEqual(guard.calls,limit)
            self.assertEqual(len(events),limit)
            self.assertEqual(client.max_retries,0)
    def test_failed_request_consumes_budget_without_retry(self):
        client=self.client(); client.responses.create.side_effect=TimeoutError('local simulation')
        guard=runtime.CallBudget(1,[],OFFLINE_PROFILE_MODELS)
        with patch.object(runtime,'get_hermes_home',return_value=Path('/fixture/developer')):
            guard.protect(client,SimpleNamespace(session_id='fixture',tools=[]))
            with self.assertRaises(TimeoutError): client.responses.create(model='gpt-6.1-sol')
            with self.assertRaises(RuntimeError): client.responses.create(model='gpt-6.1-sol')
        self.assertEqual(guard.calls,1)
    def test_non_subscription_models_and_tools_rejected_before_call(self):
        for url in ['https://api.openai.com/v1','http://chatgpt.com/backend-api/codex',
                    'https://chatgpt.com/backend-api/codex?token=bad']:
            client=self.client(); client.base_url=url
            with self.assertRaises(RuntimeError): runtime.CallBudget(1,[]).protect(client,None)
        client=self.client(); guard=runtime.CallBudget(2,[],OFFLINE_PROFILE_MODELS)
        with patch.object(runtime,'get_hermes_home',return_value=Path('/fixture/validator')):
            guard.protect(client,SimpleNamespace(session_id='fixture',tools=[]))
            for kwargs in [{'model':'gpt-6-luna'}, {'model':'gpt-6.1-sol','tools':[{'name':'write_file'}]}]:
                with self.assertRaises(RuntimeError): client.responses.create(**kwargs)
        self.assertEqual(guard.calls,0)

class ArtifactTests(unittest.TestCase):
    def test_cutover_exact_bytes_and_hashes(self):
        spec=importlib.util.spec_from_file_location('cutover_checker',REPO/'scripts/check_hermes_cutover.py')
        checker=importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
        actual = checker.verify()
        manifest = json.loads((REPO/'ops/hermes/cutover.json').read_text())
        expected = set(checker.PATHS)
        if manifest['status'] == checker.APPLIED:
            expected.remove(checker.PATHS[3])
        self.assertEqual(set(actual), expected)
    def test_receipt_selects_last_role_without_destroying_lineage(self):
        sessions=[{'profile':role,'session_id':str(i)} for i,role in enumerate(
            ['developer','validator','developer','validator'])]
        before=copy.deepcopy(sessions)
        self.assertEqual(runtime.last_role_session(sessions,'developer')['session_id'],'2')
        self.assertEqual(runtime.last_role_session(sessions,'validator')['session_id'],'3')
        self.assertIsNone(runtime.last_role_session(sessions,'missing'))
        self.assertEqual(sessions,before)

if __name__ == '__main__': unittest.main()
