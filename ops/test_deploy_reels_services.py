"""Closed-release safety contracts. Synthetic adapters only; run in Actions."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('closed_deployment', Path(__file__).with_name('deploy-reels-services.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
PROJECT = 'megabrain-v0-1017370021431'
REGISTRY = 'us-central1-docker.pkg.dev/' + PROJECT + '/v0-images'
COMMIT = 'd' * 40
CONFIG = {'project': PROJECT, 'region': 'us-central1', 'queue': 'v0-processing', 'registry': REGISTRY,
          'services': {k: 'megabrain-v0-' + k for k in ('worker', 'web')},
          'runtime_accounts': {k: 'v0-' + k + '@' + PROJECT + '.iam.gserviceaccount.com' for k in ('worker', 'web')}}


def services():
    result = {}
    for kind in ('worker', 'web', 'acquisition', 'transcription', 'analysis'):
        image_kind = 'web' if kind == 'web' else 'worker'
        container = {'image': REGISTRY + '/' + image_kind + '@sha256:' + 'a' * 64,
                     'command': ['node'], 'args': ['/app/scripts/serve-worker.mjs'],
                     'env': [{'name': 'CONFIG', 'value': '/etc/config.json'},
                             {'name': 'SECRET', 'valueSource': {'secretKeyRef': {'secret': 'fixture-secret', 'version': '2'}}}],
                     'volumeMounts': [{'name': 'config', 'mountPath': '/etc'}],
                     'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}}}
        if kind == 'web':
            container['command'] = []
            container['args'] = []
        elif kind != 'worker':
            container['args'] = ['/app/scripts/serve-stage-worker.mjs', 'upload' if kind == 'acquisition' else kind]
        result[kind] = {'name': f'projects/{PROJECT}/locations/us-central1/services/megabrain-v0-{kind}',
                        'etag': 'original-' + kind, 'uri': f'https://megabrain-v0-{kind}-fixture.run.app',
                        'latestReadyRevision': kind + '-old', 'terminalCondition': {'state': 'CONDITION_SUCCEEDED'},
                        'traffic': [{'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', 'percent': 100}],
                        'template': {'revision': kind + '-generated-old',
                                     'serviceAccount': CONFIG['runtime_accounts'][image_kind],
                                     'scaling': {'minInstanceCount': 0, 'maxInstanceCount': 1},
                                     'maxInstanceRequestConcurrency': 1, 'timeout': '890s',
                                     'containers': [container],
                                     'volumes': [{'name': 'config', 'secret': {'secret': 'fixture-config', 'items': [{'version': '6', 'path': 'config.json'}]}}]}}
    return result


def queues():
    return {k: {'name': f'projects/{PROJECT}/locations/us-central1/queues/v0-{k}', 'state': 'PAUSED',
                'rateLimits': {'maxConcurrentDispatches': 1, 'maxDispatchesPerSecond': 1},
                'retryConfig': {'maxAttempts': 1}, 'httpTarget': None, 'appEngineRoutingOverride': None, 'purgeTime': None}
            for k in ('processing', 'acquisition', 'transcription', 'analysis')}


def images():
    return {kind: REGISTRY + '/' + kind + '@sha256:' + 'b' * 64 for kind in ('worker', 'web')}


class FakeGoogle:
    def __init__(self, original=None):
        self.values = copy.deepcopy(original if original is not None else services())
        self.queue_values = queues()
        self.calls = []
        self.queue_reads = 0
        self.fail_before = None
        self.uncertain = None

    def service(self, kind):
        return copy.deepcopy(self.values[kind])

    def queues(self):
        self.queue_reads += 1
        return copy.deepcopy(self.queue_values)

    def update(self, kind, current, containers, validate_only=False):
        self.calls.append((kind, copy.deepcopy(containers), validate_only))
        if validate_only:
            return
        if self.fail_before == kind:
            self.fail_before = None
            raise deployment.DeploymentError('synthetic rejected patch')
        self.values[kind]['template']['containers'] = copy.deepcopy(containers)
        self.values[kind]['template']['revision'] = kind + '-generated-new'
        self.values[kind]['latestReadyRevision'] = kind + '-new'
        self.values[kind]['etag'] = kind + '-new'
        if self.uncertain == kind:
            self.values[kind]['reconciling'] = True
            raise deployment.DeploymentError('private timeout details', 'update_timeout')


class OfflineCase(unittest.TestCase):
    def setUp(self):
        # Any accidental real transport or publication is a test failure.
        self.network = patch.object(deployment.existing.urllib.request, 'urlopen', side_effect=AssertionError('Real network forbidden'))
        self.commands = patch.object(deployment.existing, 'command', side_effect=AssertionError('Real command forbidden'))
        self.sleep = patch.object(deployment.time, 'sleep')
        for guard in (self.network, self.commands, self.sleep):
            guard.start()
            self.addCleanup(guard.stop)

    def assert_baseline_equal(self, actual, expected):
        for kind in deployment.KINDS:
            self.assertEqual(deployment.existing.service_view(actual[kind]), deployment.existing.service_view(expected[kind]))


class ConfigurationContracts(OfflineCase):
    def test_only_four_targets_with_worker_image_for_all_stages(self):
        expanded = deployment.expanded_config(CONFIG)
        self.assertEqual(set(deployment.KINDS), set(services()))
        self.assertEqual(set(deployment.TARGETS), {'web', 'acquisition', 'transcription', 'analysis'})
        self.assertNotIn('worker', deployment.TARGETS)
        for stage in deployment.STAGES:
            self.assertEqual(expanded['runtime_accounts'][stage], CONFIG['runtime_accounts']['worker'])
        deployment.validate_services(services(), CONFIG)
        self.assertEqual(set(CONFIG['services']), {'worker', 'web'})

    def test_reject_foreign_project_region_queue_mapping_or_account(self):
        mutations = [lambda c: c.update(project='foreign-project'), lambda c: c.update(region='europe-west1'),
                     lambda c: c.update(queue='v0-analysis'), lambda c: c['services'].update(worker='other-worker'),
                     lambda c: c['runtime_accounts'].update(web='other@' + PROJECT + '.iam.gserviceaccount.com'),
                     lambda c: c.update(registry='us-central1-docker.pkg.dev/foreign-project/v0-images')]
        for mutate in mutations:
            config = copy.deepcopy(CONFIG)
            mutate(config)
            with self.subTest(config=config), self.assertRaises(deployment.DeploymentError):
                deployment.expanded_config(config)

    def test_all_five_resource_names_are_bound_to_project_and_service(self):
        for kind in deployment.KINDS:
            value = services()
            value[kind]['name'] = 'projects/foreign-project/locations/us-central1/services/megabrain-v0-' + kind
            with self.subTest(kind=kind), self.assertRaises(deployment.DeploymentError):
                deployment.validate_services(value, CONFIG)

    def test_stage_images_must_use_pinned_worker_prefix(self):
        for stage in deployment.STAGES:
            for image in [REGISTRY + '/web@sha256:' + 'a' * 64, REGISTRY + '/worker:latest',
                          'us-central1-docker.pkg.dev/foreign-project/v0-images/worker@sha256:' + 'a' * 64]:
                value = services()
                value[stage]['template']['containers'][0]['image'] = image
                with self.subTest(stage=stage, image=image), self.assertRaises(deployment.DeploymentError):
                    deployment.validate_services(value, CONFIG)

    def test_stage_identity_and_entrypoint_are_fixed(self):
        for stage in deployment.STAGES:
            for attribute, replacement in [('serviceAccount', CONFIG['runtime_accounts']['web']), ('args', ['/app/scripts/serve-worker.mjs']),
                                           ('args', ['/app/scripts/serve-stage-worker.mjs', 'analysis' if stage != 'analysis' else 'upload'])]:
                value = services()
                target = value[stage]['template'] if attribute == 'serviceAccount' else value[stage]['template']['containers'][0]
                target[attribute] = replacement
                with self.subTest(stage=stage, attribute=attribute), self.assertRaises(deployment.DeploymentError):
                    deployment.validate_services(value, CONFIG)

    def test_unpinned_env_and_volume_secrets_rejected_for_each_service(self):
        for kind in deployment.KINDS:
            for location in ('env', 'volume'):
                value = services()
                template = value[kind]['template']
                secret = template['containers'][0]['env'][1]['valueSource']['secretKeyRef'] if location == 'env' else template['volumes'][0]['secret']['items'][0]
                secret['version'] = 'latest'
                with self.subTest(kind=kind, location=location), self.assertRaises(deployment.DeploymentError):
                    deployment.validate_services(value, CONFIG)

    def test_closed_fence_is_idempotent_and_rejects_conflicts(self):
        service = services()['analysis']
        first = deployment.closed_containers(service, images()['worker'])
        service['template']['containers'] = first
        self.assertEqual(first, deployment.closed_containers(service, images()['worker']))
        for replacement in [[{'name': deployment.FENCE, 'value': 'true'}], [{'name': deployment.FENCE, 'value': 'v2'}] * 2,
                            [{'name': deployment.FENCE, 'valueSource': {'secretKeyRef': {'secret': 'fixture', 'version': '2'}}}]]:
            service['template']['containers'][0]['env'] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(deployment.DeploymentError):
                deployment.closed_containers(service, images()['worker'])

    def test_baseline_covers_every_service_config_fence_and_all_four_queues(self):
        original, queue_values = services(), queues()
        digest = deployment.baseline_digest(original, queue_values)
        for kind in deployment.KINDS:
            for location in ('env', 'volume', 'scaling'):
                changed = copy.deepcopy(original)
                template = changed[kind]['template']
                if location == 'env':
                    template['containers'][0]['env'].append({'name': deployment.FENCE, 'value': 'v2'})
                elif location == 'volume':
                    template['volumes'][0]['secret']['items'][0]['version'] = '7'
                else:
                    template['scaling']['maxInstanceCount'] = 2
                self.assertNotEqual(digest, deployment.baseline_digest(changed, queue_values), (kind, location))
        for kind in queue_values:
            changed = copy.deepcopy(queue_values)
            changed[kind]['retryConfig']['maxAttempts'] = 20
            self.assertNotEqual(digest, deployment.baseline_digest(original, changed), kind)
        generated = copy.deepcopy(original)
        generated['web']['etag'] = 'changed-etag'
        generated['analysis']['template']['revision'] = 'generated'
        self.assertEqual(digest, deployment.baseline_digest(generated, queue_values))


class QueueAndPatchContracts(OfflineCase):
    def queue_api(self, mutate=None, tasks=None):
        api = deployment.Google(deployment.expanded_config(CONFIG), 'synthetic')
        def request(method, url, body=None):
            self.assertEqual(method, 'GET')
            self.assertIsNone(body)
            stage = re.search(r'/queues/v0-([^/?]+)', url).group(1)
            if '/tasks?' in url:
                self.assertIn('responseView=BASIC', url)
                return copy.deepcopy((tasks or {}).get(stage, {}))
            value = queues()[stage]
            value.update(stats={'tasksCount': '0'}, etag='volatile')
            if mutate:
                mutate(stage, value)
            return value
        return api, request

    def test_queue_snapshot_checks_all_four_without_payload_or_volatile_stats(self):
        api, fake = self.queue_api()
        with patch.object(api, 'request', side_effect=fake) as request:
            self.assertEqual(api.queues(), queues())
        self.assertEqual(request.call_count, 8)

    def test_any_nonempty_queue_or_continuation_blocks(self):
        for kind in queues():
            for response in [{'tasks': [{'name': 'synthetic-task'}]}, {'nextPageToken': 'synthetic-next'}]:
                api, fake = self.queue_api(tasks={kind: response})
                with self.subTest(kind=kind, response=response), patch.object(api, 'request', side_effect=fake):
                    with self.assertRaises(deployment.DeploymentError):
                        api.queues()

    def test_three_running_empty_stages_are_preserved_with_legacy_paused(self):
        api, fake = self.queue_api(mutate=lambda stage, value: value.update(state='RUNNING') if stage != 'processing' else None)
        with patch.object(api, 'request', side_effect=fake):
            actual = api.queues()
        self.assertEqual(actual['processing']['state'], 'PAUSED')
        self.assertTrue(all(actual[stage]['state'] == 'RUNNING' for stage in deployment.STAGES))

    def test_legacy_running_or_stage_unknown_state_is_rejected(self):
        for kind, state in [('processing', 'RUNNING'), ('acquisition', 'DISABLED'), ('transcription', None), ('analysis', 'STATE_UNSPECIFIED')]:
            api, fake = self.queue_api(mutate=lambda stage, value: value.update(state=state) if stage == kind else None)
            with self.subTest(kind=kind, state=state), patch.object(api, 'request', side_effect=fake), self.assertRaises(deployment.DeploymentError):
                api.queues()

    def test_foreign_or_absent_queue_identity_rejected(self):
        for kind in queues():
            for name in [None, f'projects/foreign-project/locations/us-central1/queues/v0-{kind}',
                         f'projects/{PROJECT}/locations/us-central1/queues/other-queue']:
                api, fake = self.queue_api(mutate=lambda stage, value: value.update(name=name) if stage == kind else None)
                with self.subTest(kind=kind, name=name), patch.object(api, 'request', side_effect=fake), self.assertRaises(deployment.DeploymentError):
                    api.queues()

    def test_exact_patch_is_containers_only_with_etag_and_closed_fence(self):
        api = deployment.Google(deployment.expanded_config(CONFIG), 'synthetic')
        original = services()['acquisition']
        containers = deployment.closed_containers(original, images()['worker'])
        with patch.object(api, 'request', return_value={'done': True}) as request:
            api.update('acquisition', original, containers)
        method, url, body = request.call_args.args
        self.assertEqual(method, 'PATCH')
        self.assertTrue(url.endswith('/services/megabrain-v0-acquisition?updateMask=template.containers'))
        self.assertEqual(body, {'name': original['name'], 'etag': original['etag'], 'template': {'containers': containers}})
        self.assertEqual(set(body['template']), {'containers'})
        expected = copy.deepcopy(original['template']['containers'])
        expected[0]['image'] = images()['worker']
        expected[0]['env'].append({'name': deployment.FENCE, 'value': 'v2'})
        self.assertEqual(containers, expected)

    def test_validate_only_never_polls_unpersisted_operation(self):
        api = deployment.Google(deployment.expanded_config(CONFIG), 'synthetic')
        original = services()['web']
        with patch.object(api, 'request', return_value={'name': 'unpersisted-operation'}) as request:
            api.update('web', original, deployment.closed_containers(original, images()['web']), validate_only=True)
        self.assertEqual(request.call_count, 1)
        self.assertIn('validateOnly=true', request.call_args.args[1])


class ReleaseContracts(OfflineCase):
    def test_review_only_validates_four_targets_without_publication(self):
        original, api = services(), FakeGoogle()
        with patch.object(deployment, 'Google', return_value=api), patch.object(deployment.existing, 'publish') as publish:
            result = deployment.run('review', CONFIG, COMMIT, deployment.baseline_digest(original, queues()), 'synthetic')
        publish.assert_not_called()
        self.assertEqual([(k, v) for k, _, v in api.calls], [(k, True) for k in deployment.TARGETS])
        self.assertEqual(api.values, original)
        self.assertFalse(result['deployed'])
        self.assertFalse(result['processing_enabled'])

    def test_invalid_commit_baseline_or_mode_has_no_cloud_or_publish_side_effect(self):
        for mode, commit, baseline in [('unexpected', COMMIT, 'e' * 64), ('deploy', 'main', 'e' * 64), ('review', COMMIT, 'bad')]:
            with patch.object(deployment, 'Google') as google, patch.object(deployment.existing, 'publish') as publish:
                with self.assertRaises(deployment.DeploymentError):
                    deployment.run(mode, CONFIG, commit, baseline, 'synthetic')
            google.assert_not_called()
            publish.assert_not_called()

    def test_wrong_baseline_stops_before_validation_or_publication(self):
        api = FakeGoogle()
        with patch.object(deployment, 'Google', return_value=api), patch.object(deployment.existing, 'publish') as publish:
            with self.assertRaisesRegex(deployment.DeploymentError, 'baseline'):
                deployment.run('deploy', CONFIG, COMMIT, 'e' * 64, 'synthetic')
        self.assertEqual(api.calls, [])
        publish.assert_not_called()

    def test_deploy_publishes_two_images_but_rolls_only_four_targets(self):
        original, api = services(), FakeGoogle()
        with patch.object(deployment, 'Google', return_value=api), patch.object(deployment.existing, 'publish', return_value=images()) as publish, patch.object(deployment, 'rollout', return_value=original) as rollout:
            result = deployment.run('deploy', CONFIG, COMMIT, deployment.baseline_digest(original, queues()), 'synthetic')
        publish.assert_called_once_with(CONFIG, 'synthetic', COMMIT, services='all')
        rollout.assert_called_once_with(api, CONFIG, original, images(), queues())
        self.assertTrue(result['legacy_worker_preserved'])
        self.assertTrue(result['queues_preserved'])
        self.assertEqual(set(result['target_revisions']), set(deployment.TARGETS))
        self.assertNotIn('worker', [k for k, _, _ in api.calls])

    def test_drift_during_image_publication_prevents_any_real_patch(self):
        for changed in ('worker', 'analysis', 'queue', 'fence'):
            original, api = services(), FakeGoogle()
            def publish(*args, **kwargs):
                if changed == 'queue':
                    api.queue_values['transcription']['retryConfig']['maxAttempts'] = 20
                elif changed == 'fence':
                    api.values['web']['template']['containers'][0]['env'].append({'name': deployment.FENCE, 'value': 'v2'})
                else:
                    api.values[changed]['template']['volumes'][0]['secret']['items'][0]['version'] = '7'
                return images()
            with self.subTest(changed=changed), patch.object(deployment, 'Google', return_value=api), patch.object(deployment.existing, 'publish', side_effect=publish), patch.object(deployment, 'rollout') as rollout:
                with self.assertRaises(deployment.DeploymentError):
                    deployment.run('deploy', CONFIG, COMMIT, deployment.baseline_digest(original, queues()), 'synthetic')
            rollout.assert_not_called()
            self.assertTrue(all(validate_only for _, _, validate_only in api.calls))

    def test_real_image_publication_checks_both_local_labels_and_registry_digests(self):
        calls = []
        def command(args, input_text=None):
            calls.append(args)
            if args[:3] == ['docker', 'image', 'inspect']:
                image = args[3]
                if image.startswith('megabrain-'):
                    return json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': COMMIT}}}])
                kind = image.split('/')[-1].split(':')[0]
                return json.dumps([{'RepoDigests': [images()[kind]]}])
            return ''
        with patch.object(deployment.existing, 'command', side_effect=command):
            self.assertEqual(deployment.existing.publish(CONFIG, 'synthetic', COMMIT, services='all'), images())
        self.assertEqual([args[-1] for args in calls if 'push' in args], [REGISTRY + '/' + k + ':git-' + COMMIT for k in ('worker', 'web')])
        self.assertFalse(any('run.googleapis.com' in str(args) for args in calls))


class RolloutContracts(OfflineCase):
    def test_success_preserves_legacy_args_secrets_scaling_and_queues(self):
        original, api, smokes = services(), FakeGoogle(), []
        final = deployment.rollout(api, CONFIG, original, images(), queues(), smoke=smokes.append)
        self.assertEqual([kind for kind, _, _ in api.calls], list(deployment.TARGETS))
        self.assertEqual(api.values['worker'], original['worker'])
        self.assertEqual(api.queue_values, queues())
        self.assertEqual(smokes, [original['web']['uri']])
        self.assertGreaterEqual(api.queue_reads, 5)
        for kind in deployment.TARGETS:
            expected = copy.deepcopy(original[kind]['template'])
            expected.pop('revision')
            actual = copy.deepcopy(final[kind]['template'])
            actual.pop('revision')
            expected['containers'] = deployment.closed_containers(original[kind], images()['web' if kind == 'web' else 'worker'])
            self.assertEqual(actual, expected)

    def test_rejected_patch_restores_previous_targets_without_duplicate_retry(self):
        original, api = services(), FakeGoogle()
        api.fail_before = 'analysis'
        with self.assertRaisesRegex(deployment.DeploymentError, 'previous_configuration_preserved_or_restored'):
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=lambda origin: None)
        self.assertEqual([k for k, _, _ in api.calls], ['acquisition', 'transcription', 'analysis', 'transcription', 'acquisition'])
        self.assert_baseline_equal(api.values, original)

    def test_uncertain_patch_is_never_repeated_or_rolled_back_while_reconciling(self):
        original, api = services(), FakeGoogle()
        api.uncertain = 'acquisition'
        with self.assertRaisesRegex(deployment.DeploymentError, 'recovery_requires_review'):
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=lambda origin: None)
        self.assertEqual([k for k, _, _ in api.calls], ['acquisition'])
        self.assertEqual(api.values['worker'], original['worker'])

    def test_concurrent_change_refuses_recovery_of_changed_target(self):
        original, api = services(), FakeGoogle()
        def concurrent(origin):
            api.values['web']['template']['containers'][0]['env'].append({'name': 'CONCURRENT', 'value': 'preserve'})
            raise deployment.DeploymentError('private token=fixture', 'smoke_video_http_503')
        with self.assertRaises(deployment.DeploymentError) as failure:
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=concurrent)
        self.assertIn('recovery_requires_review', str(failure.exception))
        self.assertNotIn('fixture', str(failure.exception))
        self.assertEqual([k for k, _, _ in api.calls].count('web'), 1)
        self.assertEqual(api.values['web']['template']['containers'][0]['env'][-1]['name'], 'CONCURRENT')
        for stage in deployment.STAGES:
            self.assertEqual(deployment.existing.service_view(api.values[stage]), deployment.existing.service_view(original[stage]))

    def test_legacy_change_before_rollout_stops_without_touching_any_service(self):
        original, api = services(), FakeGoogle()
        api.values['worker']['template']['containers'][0]['env'] = []
        with self.assertRaisesRegex(deployment.DeploymentError, 'configuration_changed'):
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=lambda origin: None)
        self.assertEqual(api.calls, [])

    def test_queue_change_between_targets_stops_and_restores_only_owned_changes(self):
        original, api = services(), FakeGoogle()
        base_update = api.update
        def update(*args, **kwargs):
            base_update(*args, **kwargs)
            api.queue_values['analysis']['retryConfig']['maxAttempts'] = 20
        api.update = update
        with self.assertRaisesRegex(deployment.DeploymentError, 'configuration_changed'):
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=lambda origin: None)
        self.assertEqual([k for k, _, _ in api.calls], ['acquisition', 'acquisition'])
        self.assertEqual(api.queue_values['analysis']['retryConfig']['maxAttempts'], 20)
        self.assert_baseline_equal(api.values, original)

    def test_smoke_failure_rolls_back_four_targets_and_preserves_safe_cause(self):
        original, api = services(), FakeGoogle()
        def fail(origin):
            raise deployment.DeploymentError('private details', 'smoke_video_http_503')
        with self.assertRaises(deployment.DeploymentError) as failure:
            deployment.rollout(api, CONFIG, original, images(), queues(), smoke=fail)
        self.assertEqual([k for k, _, _ in api.calls], list(deployment.TARGETS) + list(reversed(deployment.TARGETS)))
        self.assertIn('phase=web_smoke', str(failure.exception))
        self.assertIn('cause=smoke_video_http_503', str(failure.exception))
        self.assertNotIn('private details', str(failure.exception))
        self.assert_baseline_equal(api.values, original)

    def test_readiness_polls_only_reads_and_times_out_without_another_patch(self):
        original, api = services(), FakeGoogle()
        desired = deployment.desired_service(original['acquisition'], deployment.closed_containers(original['acquisition'], images()['worker']))
        with self.assertRaises(deployment.DeploymentError) as failure:
            deployment.wait_ready(api, 'acquisition', original['acquisition'], desired)
        self.assertEqual(failure.exception.code, 'readiness_timeout')
        self.assertEqual(api.calls, [])

    def test_readiness_rejects_concurrent_fence_drift(self):
        original, api = services(), FakeGoogle()
        desired = deployment.desired_service(original['analysis'], deployment.closed_containers(original['analysis'], images()['worker']))
        api.values['analysis']['template']['containers'][0]['env'].append({'name': deployment.FENCE, 'value': 'invalid'})
        with self.assertRaises(deployment.DeploymentError) as failure:
            deployment.wait_ready(api, 'analysis', original['analysis'], desired)
        self.assertEqual(failure.exception.code, 'configuration_changed')
        self.assertEqual(api.calls, [])


class CLIAndWorkflowContracts(OfflineCase):
    def test_cli_requires_web_stages_and_passes_exact_mode_commit_and_baseline(self):
        argv = ['deploy-reels-services.py', '--mode', 'review', '--services', 'web_stages', '--commit', COMMIT, '--baseline', 'e' * 64, '--output', 'unused.json']
        outcome = {'status': 'closed_review_passed'}
        with patch.object(deployment.sys, 'argv', argv), patch.dict(deployment.os.environ, {'MEGABRAIN_DEPLOY_CONFIG': json.dumps(CONFIG), 'GOOGLE_ACCESS_TOKEN': 'synthetic'}, clear=True), patch.object(deployment, 'run', return_value=outcome) as run, patch.object(deployment.Path, 'write_text'), patch('builtins.print'):
            self.assertEqual(deployment.main(), 0)
        run.assert_called_once_with('review', {**CONFIG, 'runtime_max_instances': {'worker': 1, 'web': 1}}, COMMIT, 'e' * 64, 'synthetic')

    def test_cli_rejects_other_selections_before_cloud_access(self):
        for selection in ('all', 'web', 'worker'):
            argv = ['deploy-reels-services.py', '--mode', 'review', '--services', selection, '--commit', COMMIT, '--baseline', 'e' * 64, '--output', 'unused.json']
            with self.subTest(selection=selection), patch.object(deployment.sys, 'argv', argv), patch.object(deployment, 'run') as run, patch('sys.stderr'):
                with self.assertRaises(SystemExit):
                    deployment.main()
            run.assert_not_called()

    def test_workflow_routes_only_explicit_web_stages_to_closed_helper(self):
        workflow = (Path(__file__).parents[1] / '.github/workflows/google-deploy.yml').read_text()
        self.assertIn('options: [all, web, web_stages]', workflow)
        self.assertIn('DEPLOY_SERVICES: ${{ inputs.services }}', workflow)
        branch = re.search(r'if \[ "\$DEPLOY_SERVICES" = "web_stages" \]; then\n(.*?)\n\s*else\n(.*?)\n\s*fi', workflow, re.S)
        self.assertIsNotNone(branch)
        self.assertIn('python3 ops/deploy-reels-services.py', branch.group(1))
        self.assertNotIn('deploy-existing-services.py', branch.group(1))
        self.assertIn('python3 ops/deploy-existing-services.py', branch.group(2))
        for body in branch.groups():
            self.assertIn('--services "$DEPLOY_SERVICES"', body)
            self.assertIn('--baseline "$REVIEWED_BASELINE"', body)
            self.assertIn('--commit "$SOURCE_COMMIT"', body)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn("python3 -m unittest discover -s ops -p 'test_*.py'", workflow)
        self.assertIn('scripts/smoke-stage-workers.mjs', workflow)


if __name__ == '__main__':
    unittest.main()
