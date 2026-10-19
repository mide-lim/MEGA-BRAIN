"""Closed publication of exactly web + three existing Reels stage services.

Reuses image publication and authenticated transport, but never deploys the
legacy worker. No queue/IAM/data mutation or provider request is implemented.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

spec = importlib.util.spec_from_file_location('existing_deployment', Path(__file__).with_name('deploy-existing-services.py'))
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
DeploymentError = existing.DeploymentError
PROJECT = 'megabrain-v0-1017370021431'
REGION = 'us-central1'
STAGES = ('acquisition', 'transcription', 'analysis')
KINDS = ('worker', 'web', *STAGES)
TARGETS = (*STAGES, 'web')
QUEUES = ('processing', *STAGES)
FENCE = 'MEGABRAIN_REELS_CLOSED_RELEASE'


def expanded_config(config):
    existing.validate_config(config)
    if config['project'] != PROJECT or config['region'] != REGION or config['queue'] != 'v0-processing':
        raise DeploymentError('Closed publication outside authorized project')
    if config['services'] != {'worker': 'megabrain-v0-worker', 'web': 'megabrain-v0-web'}:
        raise DeploymentError('Existing service mapping changed')
    if config['runtime_accounts'] != {kind: f'v0-{kind}@{PROJECT}.iam.gserviceaccount.com' for kind in ('worker', 'web')}:
        raise DeploymentError('Runtime account mapping changed')
    result = copy.deepcopy(config)
    for stage in STAGES:
        result['services'][stage] = 'megabrain-v0-' + stage
        result['runtime_accounts'][stage] = config['runtime_accounts']['worker']
    return result


class Google(existing.Google):
    def queues(self):
        result = {}
        for stage in QUEUES:
            url = f'https://cloudtasks.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}/queues/v0-{stage}'
            raw = self.request('GET', url)
            if raw.get('name') != f'projects/{PROJECT}/locations/{REGION}/queues/v0-{stage}' or raw.get('state') not in ('RUNNING', 'PAUSED'):
                raise DeploymentError('Unexpected queue identity or state')
            # Stable configuration only; never compare volatile stats/ETags.
            result[stage] = {field: raw.get(field) for field in ('name', 'state', 'rateLimits', 'retryConfig', 'httpTarget', 'appEngineRoutingOverride', 'purgeTime')}
            tasks = self.request('GET', url + '/tasks?pageSize=1&responseView=BASIC&fields=tasks(name),nextPageToken')
            if tasks.get('tasks') or tasks.get('nextPageToken'):
                # A paused stage retains pending deliveries during a repair release.
                # The closed revision cannot process them; never purge or resume here.
                if stage not in STAGES or raw.get('state') != 'PAUSED':
                    raise DeploymentError('Pending deliveries require a paused stage queue')
        if result['processing']['state'] != 'PAUSED':
            raise DeploymentError('Legacy processing queue must remain paused')
        return result


def baseline_digest(services, queues):
    return hashlib.sha256(existing.canonical({'services': {kind: existing.service_view(services[kind]) for kind in KINDS}, 'queues': queues}).encode()).hexdigest()


def closed_containers(service, image):
    containers = copy.deepcopy(service['template']['containers'])
    env = containers[0].get('env', [])
    values = [item for item in env if item.get('name') == FENCE]
    if len(values) > 1 or any(item != {'name': FENCE, 'value': 'v2'} for item in values):
        raise DeploymentError('Closed-release fence has conflicting configuration')
    containers[0]['image'] = image
    containers[0]['env'] = [item for item in env if item.get('name') != FENCE] + [{'name': FENCE, 'value': 'v2'}]
    return containers


def desired_service(original, containers):
    desired = copy.deepcopy(original)
    desired['template']['containers'] = containers
    return desired


def validate_services(services, config):
    for kind in KINDS:
        if services[kind].get('name') != f'projects/{PROJECT}/locations/{REGION}/services/megabrain-v0-{kind}':
            raise DeploymentError('Unexpected service identity')
    existing.validate_services({kind: services[kind] for kind in ('worker', 'web')}, config)
    for stage in STAGES:
        # Each stage reuses the worker image/account and preserves its own args.
        existing.validate_services({'worker': services[stage], 'web': services['web']}, config)
        service = services[stage]
        if service.get('name') != f'projects/{PROJECT}/locations/{REGION}/services/megabrain-v0-{stage}':
            raise DeploymentError('Unexpected stage service identity')
        if service['template']['containers'][0].get('command') != ['node']:
            raise DeploymentError('Stage must use the tested node entrypoint')
        args = service['template']['containers'][0].get('args', [])
        expected = 'upload' if stage == 'acquisition' else stage
        if len(args) != 2 or not args[0].endswith('/serve-stage-worker.mjs') or args[1] != expected:
            raise DeploymentError('Stage entrypoint changed')
        closed_containers(service, service['template']['containers'][0]['image'])
    if services['web']['template']['containers'][0].get('command', []) or services['web']['template']['containers'][0].get('args', []):
        raise DeploymentError('Web must use the tested image entrypoint')
    closed_containers(services['web'], services['web']['template']['containers'][0]['image'])


def wait_ready(api, kind, original, desired):
    allowed = [existing.service_view(original), existing.service_view(desired)]
    for attempt in range(30):
        value = api.service(kind)
        if existing.service_view(value) not in allowed:
            raise DeploymentError('Concurrent service configuration change', 'configuration_changed')
        if existing.service_view(value) == allowed[1] and not value.get('reconciling'):
            if value.get('terminalCondition', {}).get('state') == 'CONDITION_SUCCEEDED':
                return value
            if value.get('terminalCondition', {}).get('state') == 'CONDITION_FAILED':
                raise DeploymentError('Closed revision failed', 'revision_failed')
        if attempt < 29:
            time.sleep(1)
    raise DeploymentError('Closed revision readiness timeout', 'readiness_timeout')


def verify_snapshot(api, expected, queues):
    if api.queues() != queues:
        raise DeploymentError('Queue configuration changed', 'configuration_changed')
    current = {kind: api.service(kind) for kind in KINDS}
    if any(existing.service_view(current[kind]) != existing.service_view(expected[kind]) for kind in KINDS):
        raise DeploymentError('Reviewed service snapshot changed', 'configuration_changed')
    return current


def rollout(api, config, originals, images, queues, smoke=existing.smoke_web):
    expected = copy.deepcopy(originals)
    touched = []
    phase = 'preflight'
    try:
        for kind in TARGETS:
            phase = kind + '_preflight'
            current = verify_snapshot(api, expected, queues)[kind]
            image = images['web' if kind == 'web' else 'worker']
            containers = closed_containers(current, image)
            desired = desired_service(current, containers)
            touched.append((kind, desired))  # A timed-out PATCH may have applied.
            phase = kind + '_update'
            api.update(kind, current, containers)
            phase = kind + '_readiness'
            expected[kind] = wait_ready(api, kind, current, desired)
        phase = 'web_smoke'
        smoke(api.service('web')['uri'])
        verify_snapshot(api, expected, queues)
    except Exception as error:
        failed = []
        for kind, desired in reversed(touched):
            try:
                current = api.service(kind)
                if current.get('reconciling'):
                    raise DeploymentError('Update still uncertain')
                if existing.service_view(current) == existing.service_view(originals[kind]):
                    continue
                if existing.service_view(current) != existing.service_view(desired):
                    raise DeploymentError('Concurrent change; recovery refused')
                api.update(kind, current, copy.deepcopy(originals[kind]['template']['containers']))
                wait_ready(api, kind, current, originals[kind])
            except Exception:
                failed.append(kind)
        suffix = 'recovery_requires_review' if failed else 'previous_configuration_preserved_or_restored'
        raise DeploymentError('Closed publication failed; phase=' + phase + '; cause=' + existing.safe_failure_code(error) + '; ' + suffix) from None
    return expected


def run(mode, config, commit, expected_baseline, token):
    if mode not in ('review', 'deploy') or not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'[a-f0-9]{64}', expected_baseline):
        raise DeploymentError('Exact mode, commit and baseline required')
    expanded = expanded_config(config)
    api = Google(expanded, token)
    queues = api.queues()
    originals = {kind: api.service(kind) for kind in KINDS}
    validate_services(originals, config)
    if baseline_digest(originals, queues) != expected_baseline:
        raise DeploymentError('Production differs from reviewed closed baseline')
    # Validate the exact fence/environment payload, without changing services.
    for kind in TARGETS:
        original = originals[kind]
        api.update(kind, original, closed_containers(original, original['template']['containers'][0]['image']), validate_only=True)
    if mode == 'review':
        return {'commit': commit, 'status': 'closed_review_passed', 'services': 'web_stages', 'deployed': False, 'processing_enabled': False}
    images = existing.publish(config, token, commit, services='all')
    verify_snapshot(api, originals, queues)
    final = rollout(api, config, originals, images, queues)
    return {'commit': commit, 'status': 'closed_deployed_and_checked', 'services': 'web_stages', 'deployed': True, 'processing_enabled': False,
            'images': images, 'target_revisions': {kind: final[kind].get('latestReadyRevision') for kind in TARGETS}, 'legacy_worker_preserved': True, 'queues_preserved': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['review', 'deploy'], required=True)
    parser.add_argument('--services', choices=['web_stages'], required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        config = json.loads(os.environ['MEGABRAIN_DEPLOY_CONFIG'])
        limits = json.loads(os.environ.get('MEGABRAIN_RUNTIME_MAX_INSTANCES', '{"worker":1,"web":1}'))
        if 'runtime_max_instances' in config and config['runtime_max_instances'] != limits:
            raise DeploymentError('Protected runtime limit conflict')
        config = {**config, 'runtime_max_instances': limits}
        result = run(args.mode, config, args.commit, args.baseline, os.environ['GOOGLE_ACCESS_TOKEN'])
        Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
        print(result['status'])
        return 0
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        print('Closed publication did not complete; inspect private state before retrying.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
