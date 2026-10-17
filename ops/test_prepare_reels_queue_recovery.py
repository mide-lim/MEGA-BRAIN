import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('queue_recovery', Path(__file__).with_name('prepare-reels-queue-recovery.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Fake:
    def __init__(self):
        self.queues = {stage: dict(name=m.queue_name(stage), state='PAUSED' if stage == 'processing' else 'RUNNING',
                                  rateLimits=dict(maxConcurrentDispatches=1, maxDispatchesPerSecond=1, maxBurstSize=10),
                                  retryConfig=dict(maxAttempts=1, maxRetryDuration='0s', minBackoff='0.100s',
                                                   maxBackoff='3600s', maxDoublings=16), stackdriverLoggingConfig={'samplingRatio': 1})
                       for stage in m.QUEUE_STAGES}
        self.runtime_data = {kind: dict(name=f'projects/{m.PROJECT}/locations/{m.REGION}/services/megabrain-v0-{kind}',
                                       revision=f'projects/{m.PROJECT}/locations/{m.REGION}/services/megabrain-v0-{kind}/revisions/megabrain-v0-{kind}-00001-abc',
                                       image=m.APPROVED_IMAGES[kind],
                                       closedFence=None if kind == 'worker' else 'v2', ready=True) for kind in m.KINDS}
        self.nonempty = False
        self.patches = []
        self.fail_stage = None
        self.queue_calls = 0
        self.drift_at = None

    def queue(self, stage):
        self.queue_calls += 1
        result = copy.deepcopy(self.queues[stage])
        if self.drift_at and self.queue_calls >= self.drift_at and stage == 'analysis':
            result['rateLimits']['maxDispatchesPerSecond'] = 2
        return result

    def tasks(self, stage):
        return {'tasks': [{'name': 'synthetic'}]} if self.nonempty else {}

    def runtime(self):
        return copy.deepcopy(self.runtime_data)

    def patch(self, stage, body):
        self.patches.append((stage, copy.deepcopy(body)))
        self.queues[stage]['retryConfig'] = copy.deepcopy(body['retryConfig'])
        self.queues[stage]['rateLimits']['maxConcurrentDispatches'] = 1
        if stage == self.fail_stage:
            raise TimeoutError('response lost after apply')


class QueueRecovery(unittest.TestCase):
    def baseline(self, fake):
        value = m.capture(fake)
        return value, m.digest(m.stable(value))

    def test_exact_change_preserves_legacy_state_rates_and_closed_runtime(self):
        fake = Fake()
        baseline, fingerprint = self.baseline(fake)
        before = copy.deepcopy(fake.queues)
        result = m.apply_recovery(fake, baseline, fingerprint)
        self.assertEqual(result['changed'], list(m.STAGES))
        self.assertFalse(result['activationAllowed'])
        self.assertEqual(result['tasksCreated'], 0)
        self.assertEqual(fake.queues['processing'], before['processing'])
        for stage in m.STAGES:
            self.assertEqual(fake.queues[stage]['state'], before[stage]['state'])
            self.assertEqual(fake.queues[stage]['rateLimits'], before[stage]['rateLimits'])
            self.assertEqual(fake.queues[stage]['retryConfig'], m.TARGET_RETRY)
        self.assertEqual([x[0] for x in fake.patches], list(m.STAGES))

    def test_already_configured_is_idempotent_without_patch(self):
        fake = Fake()
        fake.queues = m.desired_queues(fake.queues)
        baseline, fingerprint = self.baseline(fake)
        self.assertEqual(m.apply_recovery(fake, baseline, fingerprint)['changed'], [])
        self.assertEqual(fake.patches, [])

    def test_misbound_project_queue_runtime_and_nonempty_fail_before_write(self):
        mutations = [
            lambda s: s.update(project='wrong'),
            lambda s: s['queues']['acquisition'].update(name=m.queue_name('processing')),
            lambda s: s['queues'].pop('processing'),
            lambda s: s['taskCounts'].update(analysis=1),
            lambda s: s['runtime']['web'].update(closedFence=''),
            lambda s: s['runtime']['analysis'].update(ready=False),
            lambda s: s['runtime']['web'].update(revision='other'),
            lambda s: s['runtime']['web'].update(image='mutable:latest'),
            lambda s: s['runtime']['analysis'].update(image=m.IMAGE_ROOT + 'worker@sha256:' + 'a' * 64),
            lambda s: s['runtime']['worker'].update(image=m.APPROVED_IMAGES['analysis']),
            lambda s: s['queues']['processing'].update(state='RUNNING'),
            lambda s: s['queues']['analysis']['rateLimits'].update(maxConcurrentDispatches=2),
            lambda s: s.update(observedAt='2000-01-01T00:00:00Z'),
            lambda s: s.update(observedAt='2100-01-01T00:00:00Z'),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                fake = Fake()
                baseline, _ = self.baseline(fake)
                mutation(baseline)
                with self.assertRaises(ValueError):
                    m.apply_recovery(fake, baseline, m.digest(m.stable(baseline)))
                self.assertEqual(fake.patches, [])

    def test_fingerprint_and_fresh_remote_empty_closed_checks(self):
        for change in (lambda f: setattr(f, 'nonempty', True),
                       lambda f: f.runtime_data['web'].update(closedFence=''),
                       lambda f: f.queues['analysis'].update(state='PAUSED'),
                       lambda f: f.queues['analysis'].update(stackdriverLoggingConfig={'samplingRatio': 0}),
                       lambda f: f.runtime_data['worker'].update(image=m.APPROVED_IMAGES['analysis'])):
            fake = Fake()
            baseline, fingerprint = self.baseline(fake)
            change(fake)
            with self.assertRaises(ValueError):
                m.apply_recovery(fake, baseline, fingerprint)
            self.assertEqual(fake.patches, [])
        fake = Fake()
        baseline, _ = self.baseline(fake)
        with self.assertRaises(ValueError):
            m.apply_recovery(fake, baseline, 'b' * 64)
        self.assertEqual(fake.patches, [])

    def test_drift_between_stage_patches_stops_without_rollback(self):
        fake = Fake()
        baseline, fingerprint = self.baseline(fake)
        fake.drift_at = 13  # baseline4 + firstpreflight4 + firstreadback4
        with self.assertRaisesRegex(ValueError, 'Concurrent change'):
            m.apply_recovery(fake, baseline, fingerprint)
        self.assertEqual([x[0] for x in fake.patches], ['acquisition'])

    def test_partial_ambiguous_write_stops_without_retry_rollback_or_other_stage(self):
        fake = Fake()
        baseline, fingerprint = self.baseline(fake)
        fake.fail_stage = 'transcription'
        with self.assertRaisesRegex(ValueError, 'uncertain'):
            m.apply_recovery(fake, baseline, fingerprint)
        self.assertEqual([x[0] for x in fake.patches], ['acquisition', 'transcription'])
        self.assertEqual(fake.queues['transcription']['retryConfig'], m.TARGET_RETRY)
        self.assertEqual(fake.queues['analysis']['retryConfig']['maxAttempts'], 1)

    def test_transport_cannot_address_old_queue_or_arbitrary_payload(self):
        class Never:
            def patch(self, *args, **kwargs):
                raise AssertionError('network must not be reached')
        api = m.Google(Never())
        with self.assertRaises(ValueError):
            api.patch('processing', {})
        with self.assertRaises(ValueError):
            api.patch('acquisition', {'name': m.queue_name('acquisition'), 'state': 'RUNNING'})

class RuntimeTransport(unittest.TestCase):
    def test_revision_and_traffic_fence_are_verified_without_persisting_other_env(self):
        class Response:
            def __init__(self, value):
                self.value = value
            def raise_for_status(self):
                pass
            def json(self):
                return self.value
        class Session:
            def __init__(self):
                self.calls = []
                self.foreign = False
                self.bad_traffic = False
                self.bad_fence = False
            def get(self, url, params, timeout):
                self.calls.append((url, params))
                kind = url.split('megabrain-v0-')[-1].split('-00001')[0]
                revision = f'projects/{m.PROJECT}/locations/{m.REGION}/services/megabrain-v0-{kind}/revisions/megabrain-v0-{kind}-00001-abc'
                if '/revisions/' not in url:
                    if self.foreign:
                        revision = 'projects/other/locations/us-central1/revisions/foreign'
                    return Response(dict(name=url.split('/v2/')[1], latestReadyRevision=revision,
                                         terminalCondition={'state': 'CONDITION_SUCCEEDED'},
                                         trafficStatuses=[dict(revision=revision, percent=99 if self.bad_traffic else 100)]))
                return Response(dict(name=revision, containers=[dict(image=m.APPROVED_IMAGES[kind],
                    env=[dict(name=m.FENCE, value='wrong' if self.bad_fence else 'v2'),
                         dict(name='OTHER', value='PRIVATE_ENV_SENTINEL')])]))
        session = Session()
        result = m.Google(session).runtime()
        self.assertNotIn('PRIVATE_ENV_SENTINEL', str(result))
        self.assertEqual(set(result), set(m.KINDS))
        self.assertEqual(len(session.calls), 10)
        for flag in ('foreign', 'bad_traffic', 'bad_fence'):
            session = Session()
            setattr(session, flag, True)
            with self.assertRaises(ValueError):
                m.Google(session).runtime()
            if flag in ('foreign', 'bad_traffic'):
                self.assertEqual(len(session.calls), 1)


if __name__ == '__main__':
    unittest.main()
