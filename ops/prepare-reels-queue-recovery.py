#!/usr/bin/env python3
"""Bounded configuration recovery for three existing, empty stage queues.

No task, provider, data, hold, IAM, create, resume or delete operation exists.
Cloud Tasks has no queue ETag: re-read fingerprints bound drift detection,
not atomic CAS. Stop on partial/ambiguous failure; never roll back blindly.
"""
import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re

PROJECT = 'megabrain-v0-1017370021431'
REGION = 'us-central1'
STAGES = ('acquisition', 'transcription', 'analysis')
QUEUE_STAGES = (*STAGES, 'processing')
KINDS = ('worker', 'web', *STAGES)
# Exact reviewed closed publication, not a caller-supplied image assertion.
IMAGE_ROOT = f'{REGION}-docker.pkg.dev/{PROJECT}/v0-images/'
APPROVED_IMAGES = {
    'web': IMAGE_ROOT + 'web@sha256:d361578ee401fdc22babbea02a56346bc2814cfb1b0c6e1b7ced44116a9818b5',
    'worker': IMAGE_ROOT + 'worker@sha256:8a6895e5780dd5697de525be8450f91c2bd4dd9a7fe4ea742d90f8ee77079ce7',
    **{stage: IMAGE_ROOT + 'worker@sha256:c89bf657cfabcab99ac3bbc7ee333ad8964871bd4227095934e8c53e3073b441' for stage in STAGES},
}
TARGET_RETRY = dict(maxAttempts=20, maxRetryDuration='3600s', minBackoff='10s',
                    maxBackoff='60s', maxDoublings=3)
QUEUE_FIELDS = ('name', 'state', 'rateLimits', 'retryConfig', 'httpTarget',
                'appEngineRoutingOverride', 'purgeTime', 'stackdriverLoggingConfig')
FENCE = 'MEGABRAIN_REELS_CLOSED_RELEASE'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def queue_name(stage):
    return f'projects/{PROJECT}/locations/{REGION}/queues/v0-{stage}'


def queue_view(raw):
    return {field: raw.get(field) for field in QUEUE_FIELDS}


def validate_snapshot(snapshot, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if snapshot.get('project') != PROJECT:
        raise ValueError('Wrong project')
    try:
        observed = dt.datetime.fromisoformat(snapshot['observedAt'].replace('Z', '+00:00'))
        age = (now - observed).total_seconds()
    except (KeyError, TypeError, ValueError):
        raise ValueError('Invalid observation time') from None
    if not 0 <= age <= 900:
        raise ValueError('Snapshot expired')
    queues = snapshot.get('queues', {})
    if set(queues) != set(QUEUE_STAGES):
        raise ValueError('Exactly the three stages and preserved legacy queue required')
    for stage in QUEUE_STAGES:
        queue = queues[stage]
        if queue.get('name') != queue_name(stage) or queue.get('state') not in ('RUNNING', 'PAUSED'):
            raise ValueError('Unexpected queue identity/state')
        if snapshot.get('taskCounts', {}).get(stage) != 0:
            raise ValueError('Queue not empty')
        if queue.get('rateLimits', {}).get('maxConcurrentDispatches') != 1:
            raise ValueError('Queue concurrency must already equal one')
    if queues['processing']['state'] != 'PAUSED':
        raise ValueError('Legacy queue must remain paused')
    runtime = snapshot.get('runtime', {})
    if set(runtime) != set(KINDS):
        raise ValueError('Four closed service proofs and preserved legacy worker required')
    for kind, service in runtime.items():
        expected = f'projects/{PROJECT}/locations/{REGION}/services/megabrain-v0-{kind}'
        revision = service.get('revision')
        if service.get('name') != expected or not isinstance(revision, str) or not re.fullmatch(re.escape(expected + '/revisions/megabrain-v0-' + kind + '-') + r'[a-z0-9-]+', revision):
            raise ValueError('Service/revision mismatch')
        if (kind != 'worker' and service.get('closedFence') != 'v2') or service.get('ready') is not True:
            raise ValueError('Runtime processing/dispatch not proven closed')
        if service.get('image') != APPROVED_IMAGES[kind]:
            raise ValueError('Runtime image outside exact reviewed allowlist')


def desired_queues(queues):
    result = copy.deepcopy(queues)
    for stage in STAGES:
        result[stage]['retryConfig'] = dict(TARGET_RETRY)
        result[stage]['rateLimits']['maxConcurrentDispatches'] = 1
    return result


def capture(api):
    queues, counts = {}, {}
    for stage in QUEUE_STAGES:
        queues[stage] = queue_view(api.queue(stage))
        tasks = api.tasks(stage)
        counts[stage] = 1 if tasks.get('tasks') or tasks.get('nextPageToken') else 0
    return dict(project=PROJECT, observedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                queues=queues, taskCounts=counts, runtime=api.runtime())


def stable(snapshot):
    return {key: snapshot[key] for key in ('project', 'queues', 'taskCounts', 'runtime')}


def apply_recovery(api, baseline, expected_digest, now=None):
    validate_snapshot(baseline, now)
    if not re.fullmatch(r'[a-f0-9]{64}', expected_digest or '') or digest(stable(baseline)) != expected_digest:
        raise ValueError('Reviewed baseline fingerprint required')
    expected = copy.deepcopy(baseline)
    desired = desired_queues(baseline['queues'])
    touched = []
    for stage in STAGES:
        current = capture(api)
        validate_snapshot(current, now)
        if stable(current) != stable(expected):
            raise ValueError('Concurrent change; stop and review partial state')
        if current['queues'][stage] == desired[stage]:
            continue
        # Record before PATCH: a lost response can still mean the update applied.
        touched.append(stage)
        try:
            api.patch(stage, {'name': queue_name(stage), 'retryConfig': TARGET_RETRY,
                             'rateLimits': {'maxConcurrentDispatches': 1}})
            expected['queues'][stage] = desired[stage]
            after = capture(api)
            validate_snapshot(after, now)
            if stable(after) != stable(expected):
                raise ValueError('Unexpected readback')
        except Exception:
            raise ValueError('Recovery uncertain after ' + ','.join(touched) +
                             '; inspect current state; no rollback/retry performed') from None
    return dict(status='queue_recovery_configured', changed=touched,
                processingEnabled=False, dispatchEnabled=False,
                tasksCreated=0, activationAllowed=False, legacyPreserved=True)


class Google:
    def __init__(self, session):
        self.session = session

    def get(self, url, fields):
        response = self.session.get(url, params={'fields': fields}, timeout=30)
        response.raise_for_status()
        return response.json()

    def queue(self, stage):
        if stage not in QUEUE_STAGES:
            raise ValueError('Unknown queue')
        return self.get('https://cloudtasks.googleapis.com/v2/' + queue_name(stage),
                        ','.join(QUEUE_FIELDS))

    def tasks(self, stage):
        if stage not in QUEUE_STAGES:
            raise ValueError('Unknown queue')
        return self.get('https://cloudtasks.googleapis.com/v2/' + queue_name(stage) +
                        '/tasks?pageSize=1&responseView=BASIC', 'tasks(name),nextPageToken')

    def runtime(self):
        result = {}
        for kind in KINDS:
            name = f'projects/{PROJECT}/locations/{REGION}/services/megabrain-v0-{kind}'
            service = self.get('https://run.googleapis.com/v2/' + name,
                               'name,reconciling,terminalCondition,trafficStatuses,latestReadyRevision')
            traffic = service.get('trafficStatuses', [])
            if service.get('name') != name or service.get('reconciling') or service.get('terminalCondition', {}).get('state') != 'CONDITION_SUCCEEDED' or len(traffic) != 1 or traffic[0].get('percent') != 100:
                raise ValueError('Service not fully stable')
            revision = traffic[0].get('revision', '')
            if '/' not in revision:
                revision = name + '/revisions/' + revision
            if not re.fullmatch(re.escape(name + '/revisions/megabrain-v0-' + kind + '-') + r'[a-z0-9-]+', revision):
                raise ValueError('Traffic revision outside fixed service')
            if revision != service.get('latestReadyRevision'):
                raise ValueError('Serving revision differs from ready revision')
            raw = self.get('https://run.googleapis.com/v2/' + revision,
                           'name,containers(image,env(name,value)),conditions')
            containers = raw.get('containers', [])
            if raw.get('name') != revision or len(containers) != 1:
                raise ValueError('Revision mismatch')
            fence = [row for row in containers[0].get('env', []) if row.get('name') == FENCE]
            if kind != 'worker' and fence != [{'name': FENCE, 'value': 'v2'}]:
                raise ValueError('Closed release fence absent/conflicting')
            if containers[0].get('image') != APPROVED_IMAGES[kind]:
                raise ValueError('Serving image outside exact reviewed allowlist')
            # Persist only the nonsecret fence; discard every other env value.
            result[kind] = dict(name=name, revision=revision,
                                image=containers[0].get('image'), closedFence='v2' if kind != 'worker' else None, ready=True)
        return result

    def patch(self, stage, body):
        if stage not in STAGES or body != {'name': queue_name(stage), 'retryConfig': TARGET_RETRY,
                                          'rateLimits': {'maxConcurrentDispatches': 1}}:
            raise ValueError('Patch outside fixed scope')
        response = self.session.patch('https://cloudtasks.googleapis.com/v2/' + queue_name(stage),
                                      params={'updateMask': 'retryConfig,rateLimits.maxConcurrentDispatches'},
                                      json=body, timeout=30)
        response.raise_for_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['capture', 'apply'], required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--baseline')
    args = parser.parse_args()
    # Transport credential supplied by authorized operator, never read from files.
    import requests
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + os.environ['GOOGLE_ACCESS_TOKEN']
    api = Google(session)
    if args.mode == 'capture':
        snapshot = capture(api)
        validate_snapshot(snapshot)
        args.snapshot.write_text(json.dumps(snapshot, indent=2) + '\n')
        args.snapshot.chmod(0o600)
        print(json.dumps(dict(status='captured_not_applied', baseline=digest(stable(snapshot)))))
    else:
        print(json.dumps(apply_recovery(api, json.loads(args.snapshot.read_text()), args.baseline)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Queue preparation stopped; inspect private evidence. No blind rollback/retry.')
