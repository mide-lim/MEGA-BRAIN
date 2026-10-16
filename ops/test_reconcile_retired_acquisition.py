"""Offline proof/drift/atomicity checks; no credentials or Google access."""
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('retired', Path(__file__).with_name('reconcile-retired-acquisition.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
AUTH = 'MEG-109:operator-capacity-only'


class Clock(datetime):
    @classmethod
    def now(cls, tz=None): return cls(2026, 10, 16, 4, 0, tzinfo=timezone.utc)


class Fake:
    def __init__(self):
        self.writes_enabled = False; self.calls = []; self.commits = 0; self.begins = 0; self.behavior = None
        version = '2026-10-16T00:14:27.636272Z'
        data = {
            'settings/financial': {'paused': True, 'reserved_cents': 1950, 'spent_cents': 108200, 'untouched': 'credit policy and legacy reservations'},
            'settings/automation': {'enabled': False, 'transcription_enabled': False, 'analysis_enabled': False, 'parallelism': 1},
            'settings/acquisition': {'schema_version': 1, 'enabled': False, 'parallelism': 1, 'active': {m.SLOT: {'execution_id': m.JOB, 'attempt_id': m.ATTEMPT, 'video_id': m.VIDEO, 'acquired_at': '2026-10-16T00:14:20.357Z'}}},
            'settings/admission': {'enabled': False}, 'settings/media_delivery': {'enabled': False},
            m.CLAIM: {'video_id': m.VIDEO, 'stage': 'upload', 'execution_attempt_id': m.ATTEMPT, 'status': 'uncertain', 'acquisition_end_status': 'unconfirmed', 'acquisition_metrics': {'adapter_calls': 1, 'extractions': 1}, 'created_at': '2026-10-16T00:14:20.237Z'},
            m.APPROVAL: {'schema_version': 1, 'kind': 'assisted_upload', 'status': 'consumed', 'request_id': m.REQUEST, 'maximum_cents': 100, 'task': {'videoId': m.VIDEO, 'stage': 'upload', 'poll': 0}, 'outcome': {'execution_id': m.JOB, 'status': 'uncertain'}, 'consumed_at': '2026-10-16T00:14:20.000Z', 'observed_at': '2026-10-16T00:14:27.700Z'},
            m.FRAGMENT: {'schema_version': 1, 'owner': 'settings/financial', 'index': int(m.FRAGMENT[-2:], 16), 'entries': {m.JOB: {'video_id': m.VIDEO, 'stage': 'upload', 'status': 'uncertain', 'maximum_cents': 100, 'assisted_scope_ref': m.APPROVAL}, 'legacy': {'maximum_cents': 1850}}},
            'videos/' + m.VIDEO: {'id': m.VIDEO, 'status': 'needs_attention'},
        }
        self.docs = {p: {'version': version, 'data': v} for p, v in data.items()}
        self.docs.update({m.PROOF: None, m.AUDIT: None})
        self.revision = {'name': m.RUN.split('/v2/', 1)[1] + '/revisions/' + m.OLD, 'uid': m.OLD_UID, 'conditions': [{'type': 'Active', 'state': 'CONDITION_FAILED', 'revisionReason': 'RETIRED', 'lastTransitionTime': '2026-10-16T02:47:11.997822Z'}]}
        current = m.RUN.split('/v2/', 1)[1] + '/revisions/' + m.CURRENT
        self.service = {'name': m.RUN.split('/v2/', 1)[1], 'uid': '10518fa0-fa0d-4da7-8009-7e21d6e3aceb', 'etag': 'reviewed-etag', 'terminalCondition': {'state': 'CONDITION_SUCCEEDED'}, 'latestReadyRevision': current, 'latestCreatedRevision': current, 'traffic': [{'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', 'percent': 100}], 'trafficStatuses': [{'revision': m.CURRENT, 'percent': 100}], 'scaling': {'maxInstanceCount': 1}, 'template': {'executionEnvironment': 'EXECUTION_ENVIRONMENT_GEN2', 'maxInstanceRequestConcurrency': 1, 'scaling': {'maxInstanceCount': 1}, 'timeout': '890s', 'containers': [{'image': m.IMAGE, 'command': ['node'], 'args': ['--import', '/app/scripts/smoke-worker.mjs', '/app/scripts/serve-worker.mjs'], 'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}}}]}}
        self.queue = {'state': 'PAUSED', 'rateLimits': {'maxConcurrentDispatches': 1}, 'retryConfig': {'maxAttempts': 1}}
        self.tasks = {}; self.scheduler = {'state': 'PAUSED'}; self.objects = {}
        self.logs = {'entries': [{'insertId': m.INSERT_ID, 'timestamp': '2026-10-16T00:14:19.588472Z', 'resource': {'labels': {'revision_name': m.OLD}}, 'httpRequest': {'requestMethod': 'POST', 'status': 200, 'latency': '8.150783042s'}}]}

    def document(self, p, transaction=None):
        self.calls.append(('document', p, transaction))
        return copy.deepcopy((self.tx if transaction else self.docs)[p])

    def request(self, method, url, body=None):
        self.calls.append((method, url, copy.deepcopy(body)))
        if method == 'GET':
            path = url.split('?', 1)[0]
            return copy.deepcopy({m.RUN: self.service, m.RUN + '/revisions/' + m.OLD: self.revision, m.QUEUE: self.queue, m.QUEUE + '/tasks': self.tasks, m.SCHEDULER: self.scheduler, m.BUCKET: self.objects}[path])
        if url == m.LOGS: return copy.deepcopy(self.logs)
        assert self.writes_enabled
        if url == m.FIRE + ':beginTransaction':
            self.begins += 1; self.tx = copy.deepcopy(self.docs)
            return {'transaction': 'synthetic-transaction'}
        assert url == m.FIRE + ':commit'; self.commits += 1
        assert body['transaction'] == 'synthetic-transaction' and len(body['writes']) == 2
        if self.behavior == 'conflict': self.docs[m.CLAIM]['version'] = 'concurrent-version'
        if self.docs != self.tx: raise RuntimeError('Transaction read conflict')
        next_docs = copy.deepcopy(self.docs)
        for write in body['writes']:
            p = write['update']['name'].split('/documents/', 1)[1]
            values = {k: m.decode(v) for k, v in write['update']['fields'].items()}
            if p == m.AUDIT:
                assert write['currentDocument'] == {'exists': False} and next_docs[p] is None
                next_docs[p] = {'version': 'audit-version', 'data': values}
            else:
                assert p == 'settings/acquisition' and write['updateMask'] == {'fieldPaths': ['active']} and values == {'active': {}}
                assert write['currentDocument']['updateTime'] == next_docs[p]['version']
                next_docs[p] = {'version': 'reconciled-version', 'data': {**next_docs[p]['data'], **values}}
        self.docs = next_docs
        if self.behavior == 'lost': raise TimeoutError('Receipt lost AFTER atomic commit')
        if self.behavior == 'cloud_drift': self.service['etag'] = 'concurrent-deploy'
        return {'writeResults': [{'updateTime': 'audit-version'}, {'updateTime': 'reconciled-version'}][:1 if self.behavior == 'short_receipt' else 2]}


class RetirementTests(unittest.TestCase):
    def setUp(self):
        clock = patch.object(m, 'datetime', Clock); clock.start(); self.addCleanup(clock.stop)
        self.api = Fake(); self.original = copy.deepcopy(self.api.docs)
        self.plan = m.plan(m.documents(self.api), m.cloud(self.api))
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.receipt = Path(self.tmp.name) / 'receipt.json'

    def apply(self): return m.apply(self.api, self.plan, m.digest(self.plan), AUTH, self.receipt)

    def test_plan_is_read_only_and_only_proposes_two_targets(self):
        self.assertEqual(self.original, self.api.docs)
        self.assertEqual(self.plan['writes'], [m.AUDIT, 'settings/acquisition:active'])
        self.assertEqual(self.api.begins, 0); self.assertEqual(self.api.commits, 0)

    def test_atomic_capacity_only_and_idempotent(self):
        self.assertEqual(self.apply()['status'], 'applied_verified')
        changed = [p for p in m.DOCS if self.api.docs[p] != self.original[p]]
        self.assertEqual(set(changed), {m.AUDIT, 'settings/acquisition'})
        self.assertEqual(self.api.docs['settings/acquisition']['data']['active'], {})
        self.assertEqual(self.api.docs[m.CLAIM]['data']['acquisition_end_status'], 'unconfirmed')
        self.assertNotIn('ended', self.api.docs[m.AUDIT]['data'])
        self.assertEqual(self.apply()['status'], 'already_applied_verified')
        self.assertEqual(self.api.commits, 1)

    def test_lost_or_incomplete_commit_receipt_recovers_only_by_read(self):
        for behavior in ['lost', 'short_receipt']:
            with self.subTest(behavior=behavior):
                self.api = Fake(); self.api.behavior = behavior; self.receipt = Path(self.tmp.name) / behavior
                with self.assertRaises(m.Refused): self.apply()
                self.assertEqual(self.apply()['status'], 'already_applied_verified')
                self.assertEqual(self.api.commits, 1); self.assertEqual(self.api.begins, 1)
                self.assertFalse(self.api.writes_enabled)

    def test_conflict_has_no_partial_writes_and_never_replays(self):
        self.api.behavior = 'conflict'
        with self.assertRaises(m.Refused): self.apply()
        self.assertIsNone(self.api.docs[m.AUDIT])
        self.assertEqual(self.api.docs['settings/acquisition'], self.original['settings/acquisition'])
        with self.assertRaises(m.Refused): self.apply()
        self.assertEqual(self.api.commits, 1)

    def test_plan_hash_and_explicit_authorization_required(self):
        for fingerprint, auth in [('wrong', AUTH), (m.digest(self.plan), ''), (m.digest(self.plan), 'MEG-92:other')]:
            with self.subTest(auth=auth), self.assertRaises(m.Refused):
                m.apply(self.api, self.plan, fingerprint, auth, self.receipt)
        self.assertEqual(self.api.commits, 0)

    def test_changed_documents_or_invalid_identity_fail_closed(self):
        mutations = [(m.CLAIM, 'execution_attempt_id', 'other'), (m.CLAIM, 'video_id', 'other'), (m.CLAIM, 'status', 'completed'), (m.APPROVAL, 'status', 'authorized'), (m.APPROVAL, 'consumed_at', '2026-10-17T00:00:00Z'), ('settings/financial', 'reserved_cents', 1850), ('settings/automation', 'analysis_enabled', True), ('settings/media_delivery', 'enabled', True), ('videos/' + m.VIDEO, 'video_key', 'existing')]
        for path, key, value in mutations:
            with self.subTest(path=path, key=key):
                self.api = Fake(); self.api.docs[path]['data'][key] = value
                with self.assertRaises(m.Refused): self.apply()
                self.assertEqual(self.api.commits, 0)

    def test_slot_and_proof_mismatches(self):
        for mode in ['missing', 'additional', 'wrong_attempt', 'proof']:
            with self.subTest(mode=mode):
                self.api = Fake(); active = self.api.docs['settings/acquisition']['data']['active']
                if mode == 'missing': active.clear()
                if mode == 'additional': active['other'] = copy.deepcopy(active[m.SLOT])
                if mode == 'wrong_attempt': active[m.SLOT]['attempt_id'] = 'other'
                if mode == 'proof': self.api.docs[m.PROOF] = {'version': 'new', 'data': {'ended': True}}
                with self.assertRaises(m.Refused): self.apply()
                self.assertEqual(self.api.commits, 0)

    def test_retirement_route_runtime_or_request_ambiguity(self):
        for mode in ['uid', 'active', 'retiring', 'tag', 'image', 'concurrency', 'tasks', 'logs', 'object']:
            with self.subTest(mode=mode):
                self.api = Fake()
                if mode == 'uid': self.api.revision['uid'] = 'different'
                if mode == 'active': self.api.revision['conditions'][0]['state'] = 'CONDITION_SUCCEEDED'
                if mode == 'retiring': self.api.revision['conditions'][0]['revisionReason'] = 'RETIRING'
                if mode == 'tag': self.api.service['traffic'][0]['tag'] = 'legacy'
                if mode == 'image': self.api.service['template']['containers'][0]['image'] = 'different'
                if mode == 'concurrency': self.api.service['template']['maxInstanceRequestConcurrency'] = 2
                if mode == 'tasks': self.api.tasks = {'tasks': [{'name': 'unexpected'}]}
                if mode == 'logs': self.api.logs['entries'] *= 2
                if mode == 'object': self.api.objects = {'items': [{'name': 'existing'}]}
                with self.assertRaises(m.Refused): self.apply()
                self.assertEqual(self.api.commits, 0)

    def test_post_commit_drift_does_not_restore_or_reapply(self):
        self.api.behavior = 'cloud_drift'
        with self.assertRaises(m.Refused): self.apply()
        with self.assertRaises(m.Refused): self.apply()
        self.assertEqual(self.api.commits, 1)
        self.assertEqual(self.api.docs['settings/acquisition']['data']['active'], {})
        self.assertEqual(self.api.docs['settings/financial'], self.original['settings/financial'])

    def test_conflicting_audit_and_unconfirmed_prior_intent_block(self):
        self.receipt.write_text('unknown')
        with self.assertRaises(m.Refused): self.apply()
        self.receipt.unlink(); self.apply()
        self.api.docs[m.AUDIT]['data']['scope'] = 'money'
        with self.assertRaises(m.Refused): self.apply()
        self.assertEqual(self.api.commits, 1)

    def test_transport_rejects_all_unrelated_mutations(self):
        api = m.Google('synthetic-token')
        for method, url in [('POST', m.FIRE + ':commit'), ('PATCH', m.FIRE + '/settings/acquisition'), ('POST', m.RUN), ('GET', 'https://example.com')]:
            with self.subTest(url=url), self.assertRaises(m.Refused): api.request(method, url, {})

    def test_default_cli_creates_plan_without_transaction(self):
        path = Path(self.tmp.name) / 'plan.json'
        with patch.object(m.sys, 'argv', ['tool', '--token-stdin', '--plan', str(path)]), patch.object(m.sys, 'stdin', io.StringIO('synthetic-token\n')), patch.object(m, 'Google', return_value=self.api), patch('sys.stdout', new_callable=io.StringIO):
            m.main()
        self.assertEqual(json.loads(path.read_text()), self.plan)
        self.assertEqual(self.api.commits, 0); self.assertEqual(self.api.begins, 0)


if __name__ == '__main__': unittest.main()
