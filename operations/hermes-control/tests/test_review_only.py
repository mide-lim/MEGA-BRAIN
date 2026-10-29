"""Offline fake-runtime regressions; synthetic proof is never independent approval."""
import copy
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prompt_master as pm
import hermes_runtime as rt
from role_policy import OFFLINE_MODELS


def task(review=True):
    value=json.loads((Path(__file__).parent/'fixtures/synthetic-prompt-master.json').read_text())
    value['scope']={'workspace':str(pm.OFFLINE_WORKSPACE),'data':'offline-code-only'}
    value['allowed_operations']=sorted(pm.OFFLINE_ALLOWED)
    value['resource_policy']={'model':dict(OFFLINE_MODELS),'provider':'openai-codex',
        'max_model_calls':48,'deadline_seconds':600,'max_spawn_depth':2,'concurrency':1,'paid_fallback':False}
    value['expires_at']=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1)).isoformat()
    value['context_refs']=['worktree-sha256:test-pin']+(['review-only:true'] if review else [])
    return value


def command(command, output, code=0):
    return [{'role':'assistant','tool_calls':[{'id':command,'function':{'name':'terminal',
        'arguments':json.dumps({'command':command})}}]},
        {'role':'tool','tool_call_id':command,'content':json.dumps({'exit_code':code,'output':output})}]


def outcome():
    return {'messages':command('bash /reference/validate_offline.sh','HERMES_OFFLINE_TESTS_PASSED')+
        command('/opt/python/bin/python3 /acceptance/verify_read_only.py','VALIDATOR_READ_ONLY_CONFIRMED'),
        'final_response':'HERMES_VALIDATION_APPROVED'}


class ReviewTests(unittest.TestCase):
    def test_admission_exact_marker_and_offline_only(self):
        self.assertIsNotNone(pm.validate(task()))
        for ref in ['review-only:false','prefix-review-only:true','review-only:true ', 'REVIEW-ONLY:TRUE']:
            value=task(False);value['context_refs']=[ref]
            self.assertFalse(pm.is_review_only(value))
            self.assertIs(pm.validate(value),value)
        value=task();value['scope']={'workspace':str(pm.ROOT/'synthetic-workspace'),'data':'synthetic-only'}
        with self.assertRaisesRegex(ValueError,'Review-only'):pm.validate(value)
        for refs in ['review-only:true', {'review-only:true':True}, [True]]:
            value=task();value['context_refs']=refs
            with self.assertRaises(ValueError):pm.validate(value)

    def test_role_guard_review_and_ordinary(self):
        for review in [False,True]:
            value=task(review)
            rt.require_session_role(value,'/profiles/hermes-home')
            rt.require_session_role(value,'/profiles/reels-pilot',{'profile':'hermes-home'},True)
            rt.require_session_role(value,'/profiles/validator',{'profile':'reels-pilot'},True)
            if not review:rt.require_session_role(value,'/profiles/developer',{'profile':'reels-pilot'},True)
        for parent,child,delegated in [(None,'developer',False),('reels-pilot','developer',True),
                ('hermes-home','validator',True),('validator','reels-pilot',True),
                (None,'validator',False),('reels-pilot','unknown',True),(None,'validator',True)]:
            with self.subTest(parent=parent,child=child):
                with self.assertRaises((ValueError,RuntimeError)):
                    rt.require_session_role(task(),child,{'profile':parent} if parent else None,delegated)

    def test_configure_scope_all_ro_and_ordinary_developer_rw(self):
        for review in [False,True]:
            configs=[]
            template={'terminal':{'docker_volumes':['old:/workspace:rw','old:/workspace:ro'],
                'docker_env':{},'backend':'docker','docker_network':False,'docker_forward_env':False},
                'delegation':{},'agent':{},'fallback_providers':[]}
            yaml=SimpleNamespace(safe_load=lambda _:copy.deepcopy(template),
                safe_dump=lambda c,**kw:configs.append(copy.deepcopy(c)) or '{}')
            with patch.dict(sys.modules,{'yaml':yaml}),patch.object(Path,'read_text',return_value='{}'),\
                    patch.object(Path,'write_text'),patch.object(Path,'is_dir',return_value=True),\
                    patch.object(pm.subprocess,'check_output',return_value='4b16ee0f5ffd8016f3c6eef9143fda54926109cb'),\
                    patch.object(pm,'tree_digest',return_value='test-pin'):
                pm.configure_scope(task(review))
            for name,config in zip(['central','reels-pilot','developer','validator'],configs):
                mounts=[v for v in config['terminal']['docker_volumes'] if ':/workspace:' in v]
                self.assertEqual(mounts,[str(pm.OFFLINE_WORKSPACE)+':/workspace:'+('rw' if name=='developer' and not review else 'ro')])

    def test_checks_require_actual_validator_evidence_not_quotes(self):
        sessions=[{'profile':name,'session_id':name} for name in ['hermes-home','reels-pilot','validator']]
        records={'validator':{'result':outcome()}}
        def checks():return rt.completion_checks(task(),sessions,{},1,records)
        self.assertTrue(all(checks().values()))
        self.assertFalse(all(rt.completion_checks(task(False),sessions,{},1,records).values()))
        for change in ['missing_tests','failed_command','missing_probe','quoted_approval','error','missing_record','developer']:
            saved=copy.deepcopy(records)
            with self.subTest(change=change):
                result=records['validator']['result']
                if change=='missing_tests':result['messages']=result['messages'][2:]
                if change=='failed_command':result['messages'][1]['content']=json.dumps({'exit_code':1,'output':'HERMES_OFFLINE_TESTS_PASSED'})
                if change=='missing_probe':result['messages']=result['messages'][:2]
                if change=='quoted_approval':result['final_response']='quoted HERMES_VALIDATION_APPROVED only'
                if change=='error':result['error']=True
                if change=='missing_record':records.clear()
                if change=='developer':sessions.append({'profile':'developer','session_id':'developer'})
                self.assertFalse(all(checks().values()))
                if change=='developer':sessions.pop()
            records=saved

    def test_fake_runtime_exercises_both_modes_and_blocks_developer_before_init(self):
        for review,attack in [(False,False),(True,False),(True,True)]:
            with self.subTest(review=review,attack=attack),tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
                root=Path(temp);run=root/'run';run.mkdir()
                (run/'contract.json').write_text(json.dumps(task(review)))
                (root/'current-state.json').write_text('{"revision":39}')
                (root/'active-contract').mkdir()
                home=[Path('/fixture/hermes-home')];initialized=[];prompts=[]
                class FakeAgent:
                    def __init__(self,**kw):
                        self.session_id=kw.get('session_id',home[0].name)
                        self.model=kw.get('model','gpt-6.1-sol');self.tools=[]
                        self.client=None;initialized.append(home[0].name)
                    _ensure_primary_openai_client=Mock()
                    _create_request_openai_client=Mock()
                    def close(self):pass
                    def run_conversation(self,prompt,**kw):
                        prompts.append(prompt)
                        role=home[0].name
                        if role=='hermes-home':children=['reels-pilot']
                        elif role=='reels-pilot':children=['developer'] if attack else (['validator'] if review else ['developer','validator'])
                        else:children=[]
                        for child in children:
                            old=home[0];home[0]=Path('/fixture')/child
                            try:
                                agent=FakeAgent(parent_session_id=self.session_id,platform='subagent')
                                agent.run_conversation('fake child')
                            finally:home[0]=old
                        return outcome()
                class FakeBudget:
                    def __init__(self,*a,**kw):self.calls=1
                    def protect_agent(self,agent):pass
                replacements={'BASE':root,'ROOT':root,'PROJECT':root,'AIAgent':FakeAgent,
                    'CallBudget':FakeBudget,'load_runtime':lambda:None,'get_hermes_home':lambda:home[0],
                    'load_config':lambda:{'model':{'provider':'openai-codex'},'fallback_providers':[],
                        'delegation':{'backend':'profile_routes'}},
                    'shell_hooks':SimpleNamespace(register_from_config=lambda *a,**kw:range(6)),
                    'STATE':root/'absent','port_open':lambda:False,
                    'resolve_runtime_provider':lambda **kw:{'provider':'openai-codex','api_mode':'codex_responses',
                        'source':'manual:device_code','base_url':'fake','api_key':'fake'},
                    'start':lambda **kw:{'fake':True},'stop':lambda:{'fake':True},
                    'discover_plugins':lambda:None,'finalize_session':lambda **kw:None,
                    'wait_finalized':lambda sid:{'fake':sid},'memory_call':lambda *a,**kw:{'fake':True}}
                for name,value in replacements.items():stack.enter_context(patch.object(rt,name,value,create=True))
                stack.enter_context(patch.object(rt.signal,'signal'))
                stack.enter_context(patch.object(rt.signal,'alarm'))
                cwd=Path.cwd();stack.callback(os.chdir,cwd)
                stack.enter_context(patch.dict(os.environ,{},clear=False))
                code=rt.run(run)
                receipt=json.loads((run/'receipt.json').read_text())
                self.assertEqual(code,2 if attack else 0)
                if review:self.assertNotIn('developer',initialized)
                else:self.assertIn('developer',initialized)
                if attack:self.assertIn('Review-only forbids',receipt['error_message'])
                elif review:
                    self.assertTrue(receipt['checks']['no_developer'])
                    self.assertIn('No implementation or edits',prompts[0])
                    self.assertNotIn('delegate implementation',prompts[0])
                else:self.assertIn('delegate implementation',prompts[0])


if __name__=='__main__':unittest.main()
