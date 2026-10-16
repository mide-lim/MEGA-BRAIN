"""Operator-only, unit-scoped retirement reconciliation. Default: read-only plan."""
import argparse
import copy
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import sys
import re
import urllib.error
import urllib.parse
import urllib.request

PROJECT = 'megabrain-v0-1017370021431'
JOB = 'job_8f2788cc183d2ae71f43e666843029c549d33cdf2469e01a079affc857d67d95'
ATTEMPT = '66a2b225-5d0c-46e5-b2c1-307258051c17'
VIDEO = 'C02Z8eipgu2'
REQUEST = 'meg104_C02Z8eipgu2_once_v1'
SLOT = JOB + '_' + ATTEMPT.replace('-', '')
OLD = 'megabrain-v0-worker-00047-dpj'
OLD_UID = 'da1588c5-125d-4d55-886b-f90249854a13'
CURRENT = 'megabrain-v0-worker-00048-wnv'
IMAGE = 'us-central1-docker.pkg.dev/' + PROJECT + '/v0-images/worker@sha256:8a6895e5780dd5697de525be8450f91c2bd4dd9a7fe4ea742d90f8ee77079ce7'
INSERT_ID = '6ad16c63000ba13dcfec9d7d'
FIRE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents'
RUN = 'https://run.googleapis.com/v2/projects/' + PROJECT + '/locations/us-central1/services/megabrain-v0-worker'
QUEUE = 'https://cloudtasks.googleapis.com/v2/projects/' + PROJECT + '/locations/us-central1/queues/v0-processing'
SCHEDULER = 'https://cloudscheduler.googleapis.com/v1/projects/' + PROJECT + '/locations/us-central1/jobs/v0-billing-daily'
LOGS = 'https://logging.googleapis.com/v2/entries:list'
BUCKET = 'https://storage.googleapis.com/storage/v1/b/' + PROJECT + '-media/o'
CLAIM = 'jobs/' + JOB
APPROVAL = 'jobs/assisted_upload_' + REQUEST
FRAGMENT = 'control_chunks/financial_jobs_' + format(int(hashlib.sha256(JOB.encode()).hexdigest()[:2], 16) % 16, '02x')
PROOF = 'execution_stops/' + JOB + '_' + ATTEMPT
AUDIT = 'jobs/admin_retired_capacity_' + hashlib.sha256(SLOT.encode()).hexdigest()[:32]
DOCS = ['settings/financial', 'settings/automation', 'settings/acquisition', 'settings/admission',
        'settings/media_delivery', CLAIM, APPROVAL, FRAGMENT, 'videos/' + VIDEO, PROOF, AUDIT]
TARGET = dict(execution_id=JOB, attempt_id=ATTEMPT, video_id=VIDEO, revision=OLD, revision_uid=OLD_UID)
KIND = 'cloud_run_retired_capacity_v1'


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def timestamp(value):
    require(isinstance(value, str), 'Missing timestamp')
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(date.tzinfo is not None, 'Timestamp timezone required')
        return date
    except (ValueError, TypeError):
        raise Refused('Invalid timestamp') from None


def encode(value):
    if value is None: return {'nullValue': None}
    if isinstance(value, bool): return {'booleanValue': value}
    if isinstance(value, int): return {'integerValue': str(value)}
    if isinstance(value, str): return {'stringValue': value}
    if isinstance(value, list): return {'arrayValue': {'values': [encode(x) for x in value]}}
    if isinstance(value, dict): return {'mapValue': {'fields': {k: encode(v) for k, v in value.items()}}}
    raise Refused('Unsupported Firestore value')


def decode(value):
    for key in ['nullValue', 'stringValue', 'booleanValue', 'timestampValue', 'doubleValue']:
        if key in value: return value[key]
    if 'integerValue' in value: return int(value['integerValue'])
    if 'arrayValue' in value: return [decode(x) for x in value['arrayValue'].get('values', [])]
    if 'mapValue' in value: return {k: decode(v) for k, v in value['mapValue'].get('fields', {}).items()}
    raise Refused('Unsupported Firestore response')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class Google:
    def __init__(self, token):
        require(token and not any(c.isspace() for c in token), 'Temporary token required')
        self.token = token
        self.writes_enabled = False
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, url, body=None):
        allowed_get = [RUN, RUN + '/revisions/' + OLD, QUEUE, QUEUE + '/tasks', SCHEDULER, BUCKET]
        path = url.split('?', 1)[0]
        allowed = method == 'GET' and (path in allowed_get or path in [FIRE + '/' + p for p in DOCS])
        allowed |= method == 'POST' and url == LOGS
        allowed |= self.writes_enabled and method == 'POST' and url in [FIRE + ':beginTransaction', FIRE + ':commit']
        require(allowed, 'Request outside unit reconciliation scope')
        request = urllib.request.Request(url, method=method, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json',
        }, data=None if body is None else canonical(body).encode())
        try:
            with self.opener.open(request, timeout=35) as response: return json.load(response)
        except urllib.error.HTTPError as error:
            if method == 'GET' and error.code == 404 and path.startswith(FIRE + '/'): return None
            raise Refused('Google HTTP ' + str(error.code) + '; inspect without replay') from None
        except (urllib.error.URLError, TimeoutError):
            raise Refused('Google transport uncertainty; inspect without replay') from None

    def document(self, path, transaction=None):
        require(path in DOCS, 'Document outside unit scope')
        query = '?' + urllib.parse.urlencode({'transaction': transaction}) if transaction else ''
        raw = self.request('GET', FIRE + '/' + path + query)
        if raw is None: return None
        return {'version': raw['updateTime'], 'data': {k: decode(v) for k, v in raw.get('fields', {}).items()}}


def cloud(api):
    revision = api.request('GET', RUN + '/revisions/' + OLD)
    require(revision.get('name') == RUN.split('/v2/', 1)[1] + '/revisions/' + OLD and revision.get('uid') == OLD_UID, 'Wrong retired revision identity')
    active = [x for x in revision.get('conditions', []) if x.get('type') == 'Active']
    require(len(active) == 1 and active[0].get('state') == 'CONDITION_FAILED' and active[0].get('revisionReason') == 'RETIRED', 'Revision infrastructure is not retired')
    service = api.request('GET', RUN)
    require(service.get('uid') == '10518fa0-fa0d-4da7-8009-7e21d6e3aceb' and not service.get('reconciling') and service.get('terminalCondition', {}).get('state') == 'CONDITION_SUCCEEDED', 'Worker not ready')
    require(service.get('latestReadyRevision', '').endswith('/' + CURRENT) and service.get('latestCreatedRevision') == service.get('latestReadyRevision'), 'Unexpected current revision')
    require(service.get('traffic') == [{'type': 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', 'percent': 100}], 'Unexpected traffic or old revision tag')
    require(all(x.get('revision') == CURRENT and not x.get('tag') for x in service.get('trafficStatuses', [])) and service.get('trafficStatuses'), 'Unconfirmed effective traffic')
    template = service['template']; container = template.get('containers', [{}])[0]
    require(len(template.get('containers', [])) == 1 and container.get('image') == IMAGE and template.get('executionEnvironment') == 'EXECUTION_ENVIRONMENT_GEN2', 'Worker source/environment drift')
    require(container.get('command') == ['node'] and container.get('args') == ['--import', '/app/scripts/smoke-worker.mjs', '/app/scripts/serve-worker.mjs'], 'Synthetic startup drift')
    require(template.get('maxInstanceRequestConcurrency') == 1 and template.get('scaling', {}).get('maxInstanceCount') == 1 and service.get('scaling', {}).get('maxInstanceCount') == 1 and template.get('timeout') == '890s' and container.get('resources', {}).get('limits') == {'cpu': '1', 'memory': '512Mi'}, 'Worker bounds drift')
    queue = api.request('GET', QUEUE + '?fields=name,state,rateLimits,retryConfig')
    tasks = api.request('GET', QUEUE + '/tasks?pageSize=5&responseView=BASIC&fields=tasks(name),nextPageToken')
    scheduler = api.request('GET', SCHEDULER + '?fields=name,state')
    require(queue.get('state') == 'PAUSED' and queue.get('rateLimits', {}).get('maxConcurrentDispatches') == 1 and queue.get('retryConfig', {}).get('maxAttempts') == 1 and not tasks.get('tasks') and not tasks.get('nextPageToken') and scheduler.get('state') == 'PAUSED', 'Processing entries not closed')
    filt = ' AND '.join(['resource.type="cloud_run_revision"', 'resource.labels.revision_name="' + OLD + '"', 'logName="projects/' + PROJECT + '/logs/run.googleapis.com%2Frequests"', 'httpRequest.requestMethod="POST"', 'httpRequest.requestUrl="https://megabrain-v0-worker-711042421394.us-central1.run.app/tasks/assisted-upload"', 'timestamp>="2026-10-16T00:14:00Z"', 'timestamp<="2026-10-16T00:15:00Z"'])
    logs = api.request('POST', LOGS, {'resourceNames': ['projects/' + PROJECT], 'filter': filt, 'pageSize': 5, 'orderBy': 'timestamp asc'})
    entries = logs.get('entries', [])
    require(not logs.get('nextPageToken') and len(entries) == 1 and entries[0].get('insertId') == INSERT_ID and entries[0].get('resource', {}).get('labels', {}).get('revision_name') == OLD and entries[0].get('httpRequest', {}).get('status') == 200, 'Original request correlation ambiguous')
    require(timestamp(entries[0]['timestamp']) < timestamp(active[0]['lastTransitionTime']) <= datetime.now(timezone.utc), 'Invalid retirement time')
    latency = entries[0].get('httpRequest', {}).get('latency', '')
    require(re.fullmatch(r'\d+(?:\.\d+)?s', latency) and entries[0]['httpRequest'].get('requestMethod') == 'POST', 'Incomplete original request evidence')
    for prefix in ['originals/instagram/' + VIDEO + '/', 'results/instagram/' + VIDEO + '/']:
        objects = api.request('GET', BUCKET + '?' + urllib.parse.urlencode({'prefix': prefix, 'maxResults': 5, 'fields': 'items(name,generation),nextPageToken'}))
        require(not objects.get('items') and not objects.get('nextPageToken'), 'Artifact requires separate reconciliation')
    return {'revision': {'name': revision['name'], 'uid': revision['uid'], 'active': active[0]},
            'service': {'name': service['name'], 'uid': service['uid'], 'etag': service['etag'], 'revision': service['latestReadyRevision']},
            'queue': queue, 'scheduler': scheduler, 'request': {'insert_id': INSERT_ID, 'timestamp': entries[0]['timestamp'], 'latency': latency}}


def documents(api, transaction=None): return {p: api.document(p, transaction) for p in DOCS}
def signature(doc): return None if doc is None else {'version': doc['version'], 'digest': digest(doc['data'])}


def correlation(d, evidence):
    start = timestamp(evidence['request']['timestamp'])
    end = start + timedelta(seconds=float(evidence['request']['latency'][:-1]))
    approval = d[APPROVAL]['data']; claim = d[CLAIM]['data']
    consumed, created, observed = [timestamp(x) for x in [approval.get('consumed_at'), claim.get('created_at'), approval.get('observed_at')]]
    require(start <= consumed <= created <= observed <= end + timedelta(seconds=1), 'Approval/claim outside original request lifecycle')
    require(created <= timestamp(d[CLAIM]['version']) <= end + timedelta(seconds=1), 'Claim version outside original attempt')


def validate(d):
    require(all(d[p] and d[p].get('version') for p in DOCS if p not in [AUDIT, PROOF]), 'Required unit record missing')
    data = lambda p: d[p]['data']
    f = data('settings/financial'); auto = data('settings/automation'); acq = data('settings/acquisition')
    require(f.get('paused') is True and f.get('reserved_cents') == 1950 and f.get('spent_cents') == 108200, 'Financial preservation mismatch')
    require(all(auto.get(k) is False for k in ['enabled', 'analysis_enabled', 'transcription_enabled']) and auto.get('parallelism') == 1, 'Automation not closed')
    require(data('settings/admission').get('enabled') is False and data('settings/media_delivery').get('enabled') is False, 'Entry gates not closed')
    require(acq.get('schema_version') == 1 and acq.get('enabled') is False and acq.get('parallelism') == 1 and isinstance(acq.get('active'), dict), 'Acquisition control invalid')
    claim = data(CLAIM)
    require(claim.get('video_id') == VIDEO and claim.get('stage') == 'upload' and claim.get('execution_attempt_id') == ATTEMPT and claim.get('status') == 'uncertain' and claim.get('acquisition_end_status') == 'unconfirmed', 'Wrong attempt or changed outcome')
    require(claim.get('acquisition_metrics', {}).get('adapter_calls') == 1 and claim.get('acquisition_metrics', {}).get('extractions') == 1, 'Attempt scope mismatch')
    approval = data(APPROVAL)
    require(approval.get('schema_version') == 1 and approval.get('kind') == 'assisted_upload' and approval.get('request_id') == REQUEST and approval.get('status') == 'consumed' and approval.get('task') == {'videoId': VIDEO, 'stage': 'upload', 'poll': 0} and approval.get('maximum_cents') == 100 and approval.get('outcome') == {'execution_id': JOB, 'status': 'uncertain'}, 'Consumed approval mismatch')
    fragment = data(FRAGMENT)
    require(fragment.get('owner') == 'settings/financial' and fragment.get('schema_version') == 1 and fragment.get('index') == int(FRAGMENT[-2:], 16), 'Wrong financial fragment')
    unit = fragment.get('entries', {}).get(JOB, {})
    require(unit.get('video_id') == VIDEO and unit.get('stage') == 'upload' and unit.get('status') == 'uncertain' and unit.get('maximum_cents') == 100 and unit.get('assisted_scope_ref') == APPROVAL, 'Unit reserve mismatch')
    video = data('videos/' + VIDEO)
    require(video.get('id') == VIDEO and not any(video.get(k) for k in ['media_verified', 'video_key', 'transcript', 'transcript_key', 'analysis', 'analysis_key', 'candidate_analysis_key']), 'Video result requires separate reconciliation')
    require(d[PROOF] is None, 'Unexpected internal stop evidence')


def plan(d, evidence):
    validate(d)
    correlation(d, evidence)
    require(d[AUDIT] is None, 'Audit already exists; inspect original plan')
    active = d['settings/acquisition']['data']['active']
    require(set(active) == {SLOT} and active[SLOT].get('execution_id') == JOB and active[SLOT].get('attempt_id') == ATTEMPT and active[SLOT].get('video_id') == VIDEO, 'Exact held occupation missing or unexpected additional slots')
    require(timestamp(d[CLAIM]['data']['created_at']) <= timestamp(active[SLOT].get('acquired_at')) <= timestamp(d[APPROVAL]['data']['observed_at']), 'Slot outside original attempt')
    after = copy.deepcopy(d['settings/acquisition']['data']); after['active'] = {}
    return {'schema_version': 1, 'kind': KIND, 'target': TARGET, 'documents': {p: signature(d[p]) for p in DOCS},
            'cloud_digest': digest(evidence), 'after_acquisition_digest': digest(after),
            'writes': [AUDIT, 'settings/acquisition:active'], 'retained_reserved_cents': 1950}


def audit_for(p, authorization, now):
    return {'schema_version': 1, 'kind': KIND, 'administrative': True, 'scope': 'capacity_only',
            'target': TARGET, 'authorization_ref': authorization, 'plan_sha256': digest(p),
            'original_documents': p['documents'], 'cloud_digest': p['cloud_digest'],
            'after_acquisition_digest': p['after_acquisition_digest'], 'reconciled_at': now}


def verify_applied(d, evidence, p, authorization):
    validate(d)
    correlation(d, evidence)
    require(d[AUDIT] is not None, 'No audit: unresolved commit; do not replay')
    audit = d[AUDIT]['data']; when = audit.get('reconciled_at')
    require(timestamp(when) <= datetime.now(timezone.utc), 'Invalid audit time')
    require(audit == audit_for(p, authorization, when), 'Conflicting administrative audit')
    require(digest(evidence) == p['cloud_digest'], 'Cloud reference changed after application')
    require(digest(d['settings/acquisition']['data']) == p['after_acquisition_digest'], 'Post-commit acquisition mismatch')
    require(all(signature(d[path]) == p['documents'][path] for path in DOCS if path not in [AUDIT, 'settings/acquisition']), 'Protected record changed')


def apply(api, p, expected_hash, authorization, receipt):
    require(p.get('target') == TARGET and p.get('kind') == KIND and digest(p) == expected_hash, 'Reviewed plan fingerprint required')
    require(isinstance(authorization, str) and authorization.startswith('MEG-109:') and 9 < len(authorization) <= 160 and all(c.isalnum() or c in ':_-.#/' for c in authorization), 'Explicit MEG-109 authorization required')
    evidence = cloud(api); d = documents(api)
    if d[AUDIT] is not None:
        verify_applied(d, evidence, p, authorization)
        return {'status': 'already_applied_verified', 'plan_sha256': expected_hash, 'writes': 0}
    require(not receipt.exists(), 'Existing intent without verified outcome; inspect only')
    require(plan(d, evidence) == p, 'Dry-run reference changed; do not apply')
    with receipt.open('x', encoding='utf-8') as out:
        json.dump({'status': 'intent_only_do_not_replay', 'plan_sha256': expected_hash, 'authorization_ref': authorization}, out)
    try:
        api.writes_enabled = True
        transaction = api.request('POST', FIRE + ':beginTransaction', {'options': {'readWrite': {}}})['transaction']
        # All reads precede the two writes, including records never modified.
        d = documents(api, transaction); evidence = cloud(api)
        require(plan(d, evidence) == p, 'Transaction or cloud reference changed; stop')
        audit = audit_for(p, authorization, datetime.now(timezone.utc).isoformat())
        writes = [
            {'update': {'name': FIRE.split('/v1/', 1)[1] + '/' + AUDIT, 'fields': {k: encode(v) for k, v in audit.items()}}, 'currentDocument': {'exists': False}},
            {'update': {'name': FIRE.split('/v1/', 1)[1] + '/settings/acquisition', 'fields': {'active': encode({})}}, 'updateMask': {'fieldPaths': ['active']}, 'currentDocument': {'updateTime': d['settings/acquisition']['version']}},
        ]
        try:
            response = api.request('POST', FIRE + ':commit', {'transaction': transaction, 'writes': writes})
            require(len(response.get('writeResults', [])) == 2 and all(x.get('updateTime') for x in response['writeResults']), 'Incomplete commit receipt')
        except Exception:
            raise Refused('Commit outcome requires read-only inspection; never retry or restore snapshots') from None
    finally:
        api.writes_enabled = False
    verify_applied(documents(api), cloud(api), p, authorization)
    result = {'status': 'applied_verified', 'plan_sha256': expected_hash, 'writes': 2, 'reserved_cents_unchanged': 1950}
    receipt.write_text(canonical(result) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True, help='New plan output in dry-run; reviewed input with --apply')
    parser.add_argument('--token-stdin', action='store_true', required=True, help='Pipe an ephemeral token; never paste on an interactive terminal')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--plan-sha256')
    parser.add_argument('--authorization-ref')
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    if args.apply and not all([args.plan_sha256, args.authorization_ref, args.receipt]): parser.error('Apply requires fingerprint, authorization and exclusive receipt path')
    if not args.apply and any([args.plan_sha256, args.authorization_ref, args.receipt]): parser.error('Apply-only arguments are forbidden in dry-run')
    require(not sys.stdin.isatty(), 'Token must arrive through a pipe')
    api = Google(sys.stdin.readline().strip())
    if args.apply:
        require(args.receipt.resolve() != args.plan.resolve(), 'Receipt must not overwrite reviewed plan')
        p = json.loads(args.plan.read_text(encoding='utf-8'))
        result = apply(api, p, args.plan_sha256, args.authorization_ref, args.receipt)
    else:
        evidence = cloud(api); p = plan(documents(api), evidence)
        with args.plan.open('x', encoding='utf-8') as out: out.write(canonical(p) + '\n')
        result = {'status': 'dry_run_only', 'plan_sha256': digest(p), 'writes': 0, 'proposed_write_targets': p['writes']}
    print(canonical(result))


if __name__ == '__main__':
    try: main()
    except (Refused, OSError, ValueError, KeyError, TypeError):
        print('Reconciliation refused or uncertain. Keep entries closed; inspect the same plan/audit without replay.', file=sys.stderr)
        raise SystemExit(1)
