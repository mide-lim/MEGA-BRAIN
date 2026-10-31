"""Finite, explicitly authorized recurrence. No scheduler, retries, or acceptance.

Pipeline owns attempts; explicit reconciliation appends a control event and
releases matching slots without modifying an attempt or its accounting.
Synthetic seams are Python-only and must use the existing fake transport.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextvars import copy_context
from threading import Lock
import copy
import datetime as dt
import math
import os
from pathlib import Path
import re
import stat

import worker
from common import ContractError, canonical, sha
import approval
import preparation_metrics as metrics
from ledger import LedgerDenied

CONTROL = Path('/etc/megabrain/reels-pilot/recurrence')
SCHEMA_SQL = (
    '''CREATE TABLE IF NOT EXISTS recurrence_batches(
    batch_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL, receipt_path TEXT, receipt_sha256 TEXT)''',
    '''CREATE TABLE IF NOT EXISTS recurrence_members(
    batch_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    member_id TEXT NOT NULL UNIQUE, source_sha256 TEXT NOT NULL UNIQUE,
    metadata_sha256 TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    envelope_json TEXT, run_manifest_sha256 TEXT, grant_id TEXT,
    result_json TEXT, result_at TEXT, persisted INTEGER NOT NULL DEFAULT 0,
    cleanup INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0,
    cleanup_path TEXT, cleanup_sha256 TEXT,
    PRIMARY KEY(batch_id,ordinal))''',
    '''CREATE TABLE IF NOT EXISTS recurrence_slot(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    batch_id TEXT NOT NULL, member_id TEXT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS recurrence_campaigns(
    campaign_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL, parent_approval_id TEXT NOT NULL UNIQUE,
    receipt_path TEXT, receipt_sha256 TEXT)''',
    '''CREATE TABLE IF NOT EXISTS recurrence_campaign_slots(
    campaign_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    batch_id TEXT NOT NULL UNIQUE, effective_sha256 TEXT,
    PRIMARY KEY(campaign_id,ordinal))''',
    '''CREATE TABLE IF NOT EXISTS recurrence_campaign_planned(
    campaign_id TEXT NOT NULL, batch_id TEXT NOT NULL, member_id TEXT NOT NULL UNIQUE,
    source_sha256 TEXT NOT NULL UNIQUE, metadata_sha256 TEXT NOT NULL UNIQUE,
    PRIMARY KEY(campaign_id,member_id))''',
    '''CREATE TABLE IF NOT EXISTS recurrence_campaign_allocations(
    campaign_id TEXT NOT NULL, batch_id TEXT NOT NULL, member_id TEXT NOT NULL UNIQUE,
    source_sha256 TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL UNIQUE,
    gross_USD TEXT NOT NULL, calls INTEGER NOT NULL CHECK(calls=1),
    PRIMARY KEY(campaign_id,member_id))''')
STATES = ('PENDING', 'AUTHORIZED', 'RUNNING', 'PERSISTED', 'NEEDS_REVIEW',
          'ACCEPTED', 'FAILED', 'BLOCKED')
BATCH_KEYS = {'batch_id', 'members', 'currency', 'max_calls', 'max_gross_USD',
              'wip', 'retries', 'fallback'}
MEMBER_KEYS = {'manifest', 'target', 'max_calls', 'max_gross_USD', 'currency'}
APPROVAL_KEYS = {'decision', 'batch_id', 'manifest_sha256', 'approval_id',
                 'approved_by', 'approved_at', 'expires_at',
                 'rights_and_global_privacy_accepted', 'max_calls', 'max_gross_USD'}
CLEANUP_KEYS = {'decision', 'batch_id', 'member_id', 'grant_id', 'source_sha256',
                'worker_result_sha256', 'cleaned_at', 'token_copy_removed',
                'temporary_bindings_removed', 'other_bindings_preserved'}


def now():
    return dt.datetime.now(dt.timezone.utc)


def require(condition, message):
    if not condition:
        raise ContractError(message)


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', value),
            'bounded identifier required')
    return value


def count(value, low, high):
    require(type(value) is int and low <= value <= high, 'integer limit')


def money(value, maximum):
    amount = approval._money(value)
    require(amount <= maximum, 'gross limit')
    return amount


def protected(path):
    path = approval.trusted_file(path)
    # Stricter than legacy key handling: even sticky writable ancestors forbidden.
    for parent in path.parents:
        require(not parent.lstat().st_mode & 0o022, 'writable receipt ancestor')
    require(path.stat().st_size <= 100000, 'receipt size')
    raw = path.read_bytes()
    approval.trusted_file(path)
    return approval.load_json(raw), sha(raw)


def validate_batch(batch, policy):
    require(isinstance(batch, dict) and set(batch) == BATCH_KEYS, 'batch shape')
    identifier(batch['batch_id'])
    require(type(batch['members']) is list and 1 <= len(batch['members']) <= 3, 'finite members')
    count(batch['max_calls'], 1, 3)
    count(batch['wip'], 1, 1)
    count(batch['retries'], 0, 0)
    require(batch['fallback'] is False and batch['currency'] == policy['currency'] == 'USD', 'fixed USD/no fallback')
    total = money(batch['max_gross_USD'], 9)
    require(batch['max_calls'] == len(batch['members']), 'exact batch calls')
    amounts = []
    seen = [set(), set(), set()]
    for member in batch['members']:
        require(isinstance(member, dict) and set(member) == MEMBER_KEYS, 'member shape')
        count(member['max_calls'], 1, 1)
        amounts.append(money(member['max_gross_USD'], 3))
        require(member['currency'] == 'USD' and member['target'] == policy['target'], 'dedicated target')
        manifest = worker.check_manifest(member['manifest'])
        require(manifest['manifest_version'] == 'reels-pilot-run.v2', 'new analysis requires v2')
        task = manifest['task']; source = task['source']
        worker.observed_bindings(policy, task)
        identifier(task['reel_id'])
        require(task['generation']['audio'] == 'embedded_in_video', 'embedded audio required')
        duration = source['declared_duration_seconds']
        require(type(duration) in (int, float) and math.isfinite(duration) and 0 < duration <= 180,
                'bounded duration')
        count(source['declared_bytes'], 1, worker.provider.MAX_MEDIA_BYTES)
        values = (task['reel_id'], source['source_video_sha256'], source['metadata_sha256'])
        for index, value in enumerate(values):
            if index:
                require(isinstance(value, str) and worker._DIGEST.fullmatch(value), 'digest required')
            require(value not in seen[index], 'member identity collision')
            seen[index].add(value)
    require(sum(amounts) == total, 'exact batch money')
    return copy.deepcopy(batch)


class _GuardedPipeline(worker.Pipeline):
    """Fixed composition: batch receipt rechecked wherever worker verifies grant."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.__history_manifest = None

    def _source(self, task):
        # Invalidate before IO, including a failed/interrupted source read.
        self.__history_manifest = None
        return super()._source(task)

    def _verify(self, manifest, envelope, stamp, *, recovery_record=None):
        if recovery_record is None:
            digest = sha(canonical(manifest))
            history_required = self.__history_manifest != digest
            self.queue._authority(self.batch_id, manifest, envelope,
                                  history_required=history_required)
            # Authority/history may block. Never authorize new IO with the
            # caller's pre-scan timestamp; recovery keeps its durable timestamp.
            stamp = now()
        verified = super()._verify(manifest, envelope, stamp, recovery_record=recovery_record)
        if recovery_record is None:
            # Only inventory is reused, never receipt, prior ledger or crypto.
            # This instance belongs to one run_one; no queue/global lifetime.
            self.__history_manifest = digest
        return verified


class Queue:
    def __init__(self, policy, *, bootstrap=False, synthetic=False):
        worker.validate_policy(policy, real=not synthetic)
        self.policy = copy.deepcopy(policy)
        self.synthetic = synthetic
        self.ledger = worker.Ledger(policy['ledger_path'], expected_identity=policy['ledger_identity'])
        if bootstrap:
            receipt, _ = protected(CONTROL / 'schema-approval.json')
            require(set(receipt) == {'decision', 'ledger_identity', 'schema_sha256', 'version_pins_sha256'} and
                    receipt['decision'] == 'APPLY_REELS_QUEUE_SCHEMA' and
                    receipt['ledger_identity'] == policy['ledger_identity'] and
                    receipt['schema_sha256'] == sha(canonical(SCHEMA_SQL)) and
                    receipt['version_pins_sha256'] == sha(canonical(policy['version_pins'])),
                    'Root additive schema approval required')
            with self.ledger._transaction() as db:
                for sql in SCHEMA_SQL:
                    db.execute(sql)
        with self.ledger._transaction() as db:
            require(db.execute("SELECT 1 FROM sqlite_master WHERE name='recurrence_batches'").fetchone(),
                    'Root must bootstrap additive schema first')

    def register_campaign(self, manifest):
        """Register exactly five ordered slots; no paid authority is created.

        manifest: campaign_id,parent_approval_id,groups,currency,max_calls,
        max_gross_USD,wip,retries,fallback. Each group has planned (legacy
        three-member batch), effective (exact ordered subset batch, or None),
        blocked (remaining planned IDs). Root campaign approval attests this
        entire split. Empty groups additionally need a fresh protected skip.json.
        Only effective media enters prepare/admission; planned inventory stays
        immutable, including blocked IDs/digests. API accepts no control roots.
        """
        require(isinstance(manifest, dict) and set(manifest) ==
                {'campaign_id', 'parent_approval_id', 'groups', 'currency', 'max_calls',
                 'max_gross_USD', 'wip', 'retries', 'fallback'}, 'campaign shape')
        identifier(manifest['campaign_id']); identifier(manifest['parent_approval_id'])
        require(manifest['currency'] == 'USD' and manifest['fallback'] is False, 'campaign USD/no fallback')
        count(manifest['wip'], 1, 1); count(manifest['retries'], 0, 0)
        count(manifest['max_calls'], 1, 15); money(manifest['max_gross_USD'], 45)
        require(type(manifest['groups']) is list and len(manifest['groups']) == 5, 'exactly five slots')
        seen = [set(), set(), set()]; batches = set()
        for group in manifest['groups']:
            require(set(group) == {'planned', 'effective', 'blocked'}, 'group shape')
            planned = validate_batch(group['planned'], self.policy)
            require(len(planned['members']) == 3, 'three immutable planned IDs')
            bid = planned['batch_id']; require(bid not in batches, 'duplicate batch'); batches.add(bid)
            for member in planned['members']:
                task = member['manifest']['task']; src = task['source']
                for i, value in enumerate((task['reel_id'], src['source_video_sha256'], src['metadata_sha256'])):
                    require(value not in seen[i], 'campaign identity collision'); seen[i].add(value)
            blocked = group['blocked']
            ids = [m['manifest']['task']['reel_id'] for m in planned['members']]
            require(type(blocked) is list and len(set(blocked)) == len(blocked) and
                    all(x in ids for x in blocked), 'blocked subset')
            eligible = [m for m in planned['members'] if m['manifest']['task']['reel_id'] not in blocked]
            effective = group['effective']
            if eligible:
                validate_batch(effective, self.policy)
                require(effective['batch_id'] == bid and effective['members'] == eligible, 'exact effective subset')
            else:
                require(effective is None, 'empty group has no active inventory')
        encoded = canonical(manifest).decode(); digest = sha(encoded.encode())
        with self.ledger._transaction() as db:
            old = db.execute('SELECT manifest_json FROM recurrence_campaigns WHERE campaign_id=?',
                             (manifest['campaign_id'],)).fetchone()
            if old:
                require(old[0] == encoded, 'campaign immutable'); return digest
            for group in manifest['groups']:
                require(not db.execute('SELECT 1 FROM recurrence_batches WHERE batch_id=?',
                                       (group['planned']['batch_id'],)).fetchone(), 'register before prepare')
            db.execute('INSERT INTO recurrence_campaigns(campaign_id,manifest_json,manifest_sha256,parent_approval_id) VALUES(?,?,?,?)',
                       (manifest['campaign_id'], encoded, digest, manifest['parent_approval_id']))
            for ordinal, group in enumerate(manifest['groups']):
                db.execute('INSERT INTO recurrence_campaign_slots VALUES(?,?,?,?)',
                           (manifest['campaign_id'], ordinal, group['planned']['batch_id'],
                            sha(canonical(group['effective'])) if group['effective'] else None))
                for member in group['planned']['members']:
                    task = member['manifest']['task']; source = task['source']
                    require(not db.execute('SELECT 1 FROM recurrence_members WHERE member_id=? OR source_sha256=? OR metadata_sha256=?',
                                           (task['reel_id'], source['source_video_sha256'], source['metadata_sha256'])).fetchone(),
                            'planned identity already queued')
                    db.execute('INSERT INTO recurrence_campaign_planned VALUES(?,?,?,?,?)',
                               (manifest['campaign_id'], group['planned']['batch_id'], task['reel_id'],
                                source['source_video_sha256'], source['metadata_sha256']))
        return digest

    def _campaign(self, db, campaign_id, *, authority=True):
        row = db.execute('SELECT * FROM recurrence_campaigns WHERE campaign_id=?', (campaign_id,)).fetchone()
        require(row is not None, 'unknown campaign')
        manifest = approval.load_json(row['manifest_json'])
        require(sha(canonical(manifest)) == row['manifest_sha256'] and
                manifest['parent_approval_id'] == row['parent_approval_id'], 'campaign integrity')
        slots = list(db.execute('SELECT * FROM recurrence_campaign_slots WHERE campaign_id=? ORDER BY ordinal', (campaign_id,)))
        require(len(slots) == 5, 'five persisted slots')
        for i, (slot, group) in enumerate(zip(slots, manifest['groups'])):
            require(slot['ordinal'] == i and slot['batch_id'] == group['planned']['batch_id'] and
                    slot['effective_sha256'] == (sha(canonical(group['effective'])) if group['effective'] else None),
                    'campaign slot integrity')
        if not authority:
            return manifest, None
        require(row['receipt_path'] is not None, 'campaign authorization required')
        value, digest = protected(row['receipt_path'])
        require(digest == row['receipt_sha256'], 'campaign receipt changed')
        require(set(value) == {'decision', 'campaign_id', 'manifest_sha256', 'approval_id', 'approved_by',
                              'approved_at', 'expires_at', 'rights_and_global_privacy_accepted', 'max_calls', 'max_gross_USD'},
                'campaign approval shape')
        require(value['decision'] == 'APPROVE_REELS_CAMPAIGN' and value['campaign_id'] == campaign_id and
                value['manifest_sha256'] == row['manifest_sha256'] and value['approval_id'] == row['parent_approval_id'] and
                isinstance(value['approved_by'], str) and 0 < len(value['approved_by']) <= 200 and
                value['rights_and_global_privacy_accepted'] is True, 'campaign human/privacy authority')
        require(approval._instant(value['approved_at']) <= now() < approval._instant(value['expires_at']), 'campaign expiry')
        count(value['max_calls'], 1, 15)
        require(value['max_calls'] == manifest['max_calls'] and
                money(value['max_gross_USD'], 45) == money(manifest['max_gross_USD'], 45), 'exact campaign ceiling')
        return manifest, value

    def authorize_campaign(self, campaign_id):
        # Fixed Root-owned control location, never supplied by task/environment.
        path = CONTROL / identifier(campaign_id) / 'campaign-approval.json'
        _, digest = protected(path)
        with self.ledger._transaction() as db:
            row = db.execute('SELECT * FROM recurrence_campaigns WHERE campaign_id=?', (campaign_id,)).fetchone()
            require(row is not None, 'unknown campaign')
            require(row['receipt_path'] is None or (row['receipt_path'] == str(path) and row['receipt_sha256'] == digest),
                    'campaign approval immutable')
            db.execute('UPDATE recurrence_campaigns SET receipt_path=?,receipt_sha256=? WHERE campaign_id=?',
                       (str(path), digest, campaign_id))
            self._campaign(db, campaign_id)

    def campaign_status(self, campaign_id):
        """Reserved exposure is NOT billed cost or actual provider POST count."""
        with self.ledger._transaction() as db:
            manifest, _ = self._campaign(db, campaign_id, authority=False)
            rows = [dict(r) for r in db.execute('SELECT * FROM recurrence_campaign_allocations WHERE campaign_id=?', (campaign_id,))]
            return {'manifest': manifest, 'reservations': rows, 'reserved_calls': len(rows),
                    'reserved_gross_USD': str(sum((money(r['gross_USD'], 3) for r in rows), 0))}

    def _campaign_order(self, db, slot, manifest):
        for group in manifest['groups'][:slot['ordinal']]:
            bid = group['planned']['batch_id']
            if group['effective'] is None:
                value, _ = protected(CONTROL / manifest['campaign_id'] / (bid + '.skip.json'))
                require(value == {'decision': 'SKIP_TECHNICALLY_BLOCKED_REELS_GROUP', 'campaign_id': manifest['campaign_id'],
                                  'manifest_sha256': sha(canonical(manifest)), 'batch_id': bid,
                                  'blocked': group['blocked']}, 'Root technical skip receipt')
            else:
                self._batch(db, bid)
                require(not db.execute('SELECT 1 FROM recurrence_members WHERE batch_id=? AND (persisted!=1 OR cleanup!=1)',
                                       (bid,)).fetchone(), 'prior group persistence/cleanup barrier')

    def _reserve_campaign(self, db, batch, member, envelope):
        slot = db.execute('SELECT * FROM recurrence_campaign_slots WHERE batch_id=?', (batch['batch_id'],)).fetchone()
        if slot is None:
            return
        manifest, _ = self._campaign(db, slot['campaign_id'])
        require(slot['effective_sha256'] == sha(canonical(batch)), 'campaign batch changed')
        self._campaign_order(db, slot, manifest)
        rows = list(db.execute('SELECT gross_USD FROM recurrence_campaign_allocations WHERE campaign_id=?', (slot['campaign_id'],)))
        gross = money(member['max_gross_USD'], 3)
        require(len(rows) + 1 <= manifest['max_calls'] and
                sum((money(r[0], 3) for r in rows), gross) <= money(manifest['max_gross_USD'], 45), 'campaign capacity exhausted')
        task = member['manifest']['task']
        db.execute('INSERT INTO recurrence_campaign_allocations VALUES(?,?,?,?,?,?,1)',
                   (slot['campaign_id'], batch['batch_id'], task['reel_id'], task['source']['source_video_sha256'],
                    envelope['grant']['grant_id'], str(gross)))

    def _batch(self, db, batch_id):
        row = db.execute('SELECT * FROM recurrence_batches WHERE batch_id=?', (batch_id,)).fetchone()
        require(row is not None, 'unknown batch')
        batch = approval.load_json(row['manifest_json'])
        require(sha(canonical(batch)) == row['manifest_sha256'], 'immutable manifest integrity')
        validate_batch(batch, self.policy)
        members = list(db.execute('SELECT * FROM recurrence_members WHERE batch_id=? ORDER BY ordinal', (batch_id,)))
        require(len(members) == len(batch['members']), 'immutable member count differs')
        for ordinal, queued in enumerate(members):
            task = batch['members'][ordinal]['manifest']['task']; source = task['source']
            require(queued['ordinal'] == ordinal and queued['member_id'] == task['reel_id'] and
                    queued['source_sha256'] == source['source_video_sha256'] and
                    queued['metadata_sha256'] == source['metadata_sha256'], 'queued identity differs from immutable manifest')
        return dict(row), batch

    def _history_receipt(self, batch):
        value, _ = protected(CONTROL / identifier(batch['batch_id']) / 'history.json')
        require(set(value) == {'decision', 'batch_id', 'manifest_sha256', 'roots', 'checked_at', 'complete'},
                'history receipt shape')
        require(value['decision'] == 'CONFIRM_REELS_HISTORY' and
                value['batch_id'] == batch['batch_id'] and
                value['manifest_sha256'] == sha(canonical(batch)) and
                value['roots'] == {key: self.policy['roots'][key] for key in ('media_root', 'result_root')} and
                value['complete'] is True,
                'Root complete history attestation required')
        checked = approval._instant(value['checked_at']); stamp = now()
        require(checked <= stamp <= checked + dt.timedelta(hours=24), 'history attestation freshness')

    @metrics.measured('history')
    def _history(self, member):
        """Read-only existing Windows/imported analysis/history, under fixed roots only.

        No remote Windows mount is invented. Inventory must already be imported
        into approved media/result roots. Malformed/oversized history fails closed.
        """
        task = member['manifest']['task']; source = task['source']
        forbidden = {task['reel_id'], source['source_video_sha256'], source['metadata_sha256']}
        def collision(value):
            if isinstance(value, dict):
                return any(collision(v) for v in value.values())
            if isinstance(value, list):
                return any(collision(v) for v in value)
            return isinstance(value, str) and value in forbidden
        scanned = 0
        scan_lock = Lock()
        identity = lambda s: (s.st_dev, s.st_ino)
        version = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

        def scan(job):
            nonlocal scanned
            root_name, current, expected = job
            # Reopen and check identity: no atomic snapshot of changing inventory.
            directory = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            children = []
            try:
                require(identity(os.fstat(directory)) == expected, 'history directory replaced')
                metrics.count('directories')
                with os.scandir(directory) as entries:
                    for entry in entries:
                        with scan_lock:
                            scanned += 1
                            metrics.count('entries')
                            require(scanned <= 20000, 'history scan bound; reconcile offline')
                        require(not entry.is_symlink(), 'symlink in inventory')
                        if entry.is_dir(follow_symlinks=False):
                            require(not (root_name == 'result_root' and entry.name == task['reel_id']),
                                    'existing result directory collision')
                            children.append((root_name, current / entry.name,
                                             identity(entry.stat(follow_symlinks=False))))
                        elif entry.is_file(follow_symlinks=False) and entry.name.startswith(('analysis', 'history')) and entry.name.endswith('.json'):
                            expected_file = entry.stat(follow_symlinks=False)
                            history = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                            with os.fdopen(history, 'rb') as stream:
                                before = os.fstat(stream.fileno())
                                require(version(expected_file) == version(before), 'history file replaced')
                                require(stat.S_ISREG(before.st_mode) and before.st_size <= 1000000, 'history size/type')
                                raw = stream.read(1000001)
                                metrics.count('history_reads')
                                metrics.count('history_bytes', len(raw))
                                after = os.fstat(stream.fileno())
                                linked = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                                require(version(before) == version(after) == version(linked) and len(raw) == before.st_size,
                                        'history changed during read')
                            require(len(raw) <= 1000000, 'history size')
                            require(not collision(approval.load_json(raw)), 'Windows/analysis history collision')
                return children
            finally:
                os.close(directory)

        pending = []  # At most the global entry bound plus two roots.
        for root_name in ('media_root', 'result_root'):
            root = Path(self.policy['roots'][root_name]['root_id'])
            if root_name == 'media_root':
                for part in ('media', 'reels'):
                    root = root / part
                    require(not root.is_symlink(), 'symlink in inventory root')
            require(root.is_dir() and not root.is_symlink(), 'history root missing')
            pending.append((root_name, root, identity(root.stat())))
        pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix='reels-history')
        active = set()
        try:
            while pending or active:
                while pending and len(active) < 16:
                    active.add(pool.submit(copy_context().run, scan, pending.pop()))
                done, active = wait(active, return_when=FIRST_COMPLETED)
                for future in done:
                    pending.extend(future.result())
        finally:
            for future in active:
                future.cancel()
            pool.shutdown(wait=True, cancel_futures=True)

    def _no_dispatch_proof(self, db, source, *, applying=False):
        """Validate a restricted Root control, never an old grant or calls=0 alone.

        All evidence is fixed-location, protected, hash-bound audited material.
        Historical markers are revalidated against the complete unchanged ledger
        snapshot; an arbitrary event cannot waive the global uncertainty barrier.
        """
        attempt = db.execute('SELECT * FROM attempts WHERE source_sha256=?', (source,)).fetchone()
        member = db.execute('SELECT * FROM recurrence_members WHERE source_sha256=?', (source,)).fetchone()
        require(attempt is not None and member is not None, 'exact claimed attempt required')
        a, m = dict(attempt), dict(member)
        bid, mid = identifier(m['batch_id']), identifier(m['member_id'])
        path = CONTROL / bid / (mid + '.reconcile.json')
        proof, digest = protected(path)
        require(set(proof) == {'decision', 'batch_id', 'member_id', 'source_sha256', 'grant_id', 'run_id',
                'expected_member_state', 'expected_attempt_state', 'ledger_identity', 'batch_manifest_sha256',
                'run_manifest_sha256', 'request_sha256', 'attempt_sha256', 'member_before', 'events',
                'allocations', 'approved_at', 'expires_at', 'approved_by', 'process_audit', 'evidence'},
                'reconciliation proof shape')
        require(proof['decision'] == 'RECONCILE_EXPIRED_BEFORE_DISPATCH' and
                proof['batch_id'] == bid and proof['member_id'] == mid and
                proof['source_sha256'] == source and proof['grant_id'] == a['grant_id'] == m['grant_id'] and
                proof['run_id'] == a['run_id'] and proof['ledger_identity'] == self.policy['ledger_identity'] and
                proof['expected_member_state'] == 'RUNNING' and proof['expected_attempt_state'] == 'RESERVED' and
                isinstance(proof['approved_by'], str) and 0 < len(proof['approved_by']) <= 200,
                'exact reconciliation authority/identity')
        require(a['state'] == 'RESERVED' and type(a['calls']) is int and a['calls'] == 0 and
                all(a[k] is None for k in ('started_at', 'received_at', 'persisted_at', 'response',
                                          'response_sha256', 'refs_json', 'problem')),
                'only pristine undispatched reservation')
        require(sha(canonical(a)) == proof['attempt_sha256'], 'attempt snapshot changed')
        row, batch = self._batch(db, bid)
        manifest = batch['members'][m['ordinal']]['manifest']
        grant = approval.load_json(a['grant_json'])
        envelope = approval.load_json(m['envelope_json'])
        require(envelope['grant'] == grant and grant['grant_id'] == a['grant_id'] and
                grant['bindings']['media']['sha256'] == source and grant['bindings']['media']['id'] == mid and
                grant['manifest_sha256'] == m['run_manifest_sha256'] == proof['run_manifest_sha256'] == sha(canonical(manifest)) and
                a['request_sha256'] == grant['request_sha256'] == manifest['request_sha256'] == proof['request_sha256'] and
                row['manifest_sha256'] == proof['batch_manifest_sha256'] and
                a['expires_at'] == grant['expires_at'], 'immutable request/manifest/grant binding')
        expired, reserved = approval._instant(a['expires_at']), approval._instant(a['reserved_at'])
        approved, expires = approval._instant(proof['approved_at']), approval._instant(proof['expires_at'])
        require(expired < reserved <= approved <= now() and approved < expires <= approved + dt.timedelta(hours=1),
                'expired before reservation and bounded fresh control')
        events = [dict(r) for r in db.execute('SELECT sequence,event,at,details FROM events WHERE source_sha256=? ORDER BY sequence', (source,))]
        original = proof['events']
        require(type(original) is list and len(original) == 1 and set(original[0]) == {'sequence', 'event', 'at', 'details'} and
                type(original[0]['sequence']) is int and original[0]['event'] == 'RESERVE_BEFORE_IO' and
                original[0]['details'] == '{}' and reserved <= approval._instant(original[0]['at']) <= approved,
                'exact reserve-only event snapshot')
        require(not db.execute('SELECT 1 FROM persistence_recovery_runs WHERE source_sha256=?', (source,)).fetchone(),
                'no recovery history')
        allocations = [dict(r) for r in db.execute('SELECT * FROM recurrence_campaign_allocations WHERE member_id=? OR source_sha256=? OR grant_id=? ORDER BY campaign_id,member_id', (mid, source, a['grant_id']))]
        require(allocations == proof['allocations'] and all(r['batch_id'] == bid and r['member_id'] == mid and
                r['source_sha256'] == source and r['grant_id'] == a['grant_id'] for r in allocations), 'allocation snapshot changed')
        evidence = {}
        names = ('worker-result.json', 'worker.stdout', 'run-started.json', 'signed-control.json', 'token-cleanup.json', 'IAM-cleanup.json')
        require(isinstance(proof['evidence'], dict) and set(proof['evidence']) == set(names), 'complete evidence hashes required')
        for name in names:
            value, bound_hash = protected(CONTROL / bid / (mid + '.reconcile-evidence') / name)
            require(isinstance(proof['evidence'][name], str) and worker._DIGEST.fullmatch(proof['evidence'][name]) and
                    bound_hash == proof['evidence'][name], 'evidence hash mismatch')
            evidence[name] = value
        result, stdout = evidence['worker-result.json'], evidence['worker.stdout']
        stopped = {'error_type': 'LedgerDenied', 'retry_allowed': False, 'state': 'STOPPED'}
        require(result['result'] == stdout == stopped and type(result['exit']) is int and result['exit'] == 1 and
                result['automatic_retry'] is False and result['timed_out'] is False and
                type(result['worker_pid']) is int and result['worker_pid'] > 1, 'coherent failed-before-send exit')
        finished = approval._instant(result['finished_at'])
        start, signed = evidence['run-started.json'], evidence['signed-control.json']
        require(start['grant_id'] == signed['grant_id'] == a['grant_id'] and start['retry'] is False and
                approval._instant(start['started_at']) <= expired < reserved <= finished <= approved and
                signed['expires_at'] == a['expires_at'] and signed['grant_signature_verified'] is True and
                signed['token_bytes_read'] is False and type(signed['new_generateContent_POSTs']) is int and
                signed['new_generateContent_POSTs'] == 0 and
                isinstance(signed['policy_sha256'], str) and worker._DIGEST.fullmatch(signed['policy_sha256']) and
                expired <= approval._instant(signed['token_expires_at']) <= finished, 'signed no-send evidence/order')
        token, iam = evidence['token-cleanup.json'], evidence['IAM-cleanup.json']
        require(all(token[k] is True for k in ('encrypted_envelope_removed', 'private_key_removed', 'token_copy_removed')) and
                all(iam[k] is True for k in ('SDK_cleanup_verified', 'creator_removed', 'inference_binding_removed', 'other_bindings_preserved')) and
                iam['member_id'] == mid and isinstance(iam['operation_id'], str) and iam['operation_id'] and
                finished <= approval._instant(iam['checked_at']) <= approved, 'audited token/IAM cleanup')
        audit = proof['process_audit']
        require(set(audit) == {'complete', 'no_active_consumers', 'exclusive_operator_maintenance', 'worker_pid', 'checked_at'} and
                all(audit[k] is True for k in ('complete', 'no_active_consumers', 'exclusive_operator_maintenance')) and
                audit['worker_pid'] == result['worker_pid'] and
                finished <= approval._instant(audit['checked_at']) <= approved, 'protected complete quiescence audit')
        before = proof['member_before']
        require(isinstance(before, dict) and before['state'] == 'RUNNING' and before['cleanup'] == before['persisted'] == before['review'] == 0 and
                all(before[k] is None for k in ('result_json', 'result_at', 'cleanup_path', 'cleanup_sha256')),
                'pristine running member snapshot')
        outcome = {'state': 'BLOCKED', 'kind': 'NO_DISPATCH_RECONCILED', 'provider_io': 'NOT_STARTED',
                   'provider_calls': 0, 'retry_allowed': False, 'grant_id': a['grant_id'], 'run_id': a['run_id']}
        after = dict(before, state='BLOCKED', cleanup=1, result_json=canonical(outcome).decode(),
                     result_at=proof['approved_at'], cleanup_path=str(path), cleanup_sha256=digest)
        details = {'receipt_sha256': digest, 'attempt_sha256': proof['attempt_sha256'],
                   'member_after_sha256': sha(canonical(after)), 'batch_id': bid, 'member_id': mid,
                   'grant_id': a['grant_id'], 'run_id': a['run_id']}
        if applying:
            require(approved <= now() < expires and now() - approval._instant(audit['checked_at']) <= dt.timedelta(minutes=5),
                    'control/quiescence audit expired')
            require(not (Path('/proc') / str(result['worker_pid'])).exists(), 'worker active or PID reused')
            require(Path('/proc/self/stat').is_file(), 'process inspection unavailable')
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit() or int(proc.name) == os.getpid():
                    continue
                try:
                    command = (proc / 'cmdline').read_bytes()
                except FileNotFoundError:
                    continue
                # Permission/inspection errors propagate: never infer quiescence.
                require(not any(name in command for name in
                        (b'/opt/megabrain/reels-pilot/releases/', b'campaign-control.py',
                         b'prepare-member.py', b'recurrence.py')), 'active consumer')
            require(m == before and events == original, 'member/event snapshot changed')
            require([tuple(r) for r in db.execute('SELECT * FROM pilot_slot')] == [(1, source)] and
                    [tuple(r) for r in db.execute('SELECT * FROM recurrence_slot')] == [(1, bid, mid)], 'exact held slots required')
        else:
            require(m == after and len(events) == 2 and events[:1] == original and
                    events[-1]['event'] == 'NO_DISPATCH_RECONCILED' and
                    events[-1]['at'] == proof['approved_at'] and events[-1]['details'] == canonical(details).decode() and
                    events[-1]['sequence'] > original[0]['sequence'], 'fully matching terminal control required')
            require(not db.execute('SELECT 1 FROM pilot_slot WHERE source_sha256=?', (source,)).fetchone() and
                    not db.execute('SELECT 1 FROM recurrence_slot WHERE batch_id=? AND member_id=?', (bid, mid)).fetchone(),
                    'reconciled slots changed')
        # Recheck every protected byte while holding the same ledger transaction.
        require(protected(path) == (proof, digest), 'control changed during reconciliation')
        for name in names:
            require(protected(CONTROL / bid / (mid + '.reconcile-evidence') / name) ==
                    (evidence[name], proof['evidence'][name]), 'evidence changed during reconciliation')
        return outcome, after, details

    def reconcile_no_dispatch(self, batch_id, member_id, *, source_sha256, grant_id, run_id,
                              expected_member_state, expected_attempt_state):
        """Explicit no-IO control; preserve attempt, allocation and reservation money."""
        identifier(batch_id); identifier(member_id)
        with self.ledger._transaction() as db:
            row = db.execute('SELECT * FROM recurrence_members WHERE batch_id=? AND member_id=?', (batch_id, member_id)).fetchone()
            attempt = db.execute('SELECT * FROM attempts WHERE source_sha256=?', (source_sha256,)).fetchone()
            require(row is not None and attempt is not None and row['source_sha256'] == source_sha256 and
                    row['grant_id'] == attempt['grant_id'] == grant_id and attempt['run_id'] == run_id and
                    expected_member_state == 'RUNNING' and expected_attempt_state == 'RESERVED', 'explicit exact control selectors')
            repeat = bool(row['cleanup'])
            outcome, after, details = self._no_dispatch_proof(db, source_sha256, applying=not repeat)
            if repeat:
                return outcome
            db.execute('UPDATE recurrence_members SET state=?,cleanup=?,result_json=?,result_at=?,cleanup_path=?,cleanup_sha256=? WHERE batch_id=? AND member_id=?',
                       (after['state'], after['cleanup'], after['result_json'], after['result_at'], after['cleanup_path'], after['cleanup_sha256'], batch_id, member_id))
            db.execute('INSERT INTO events(source_sha256,event,at,details) VALUES(?,?,?,?)',
                       (source_sha256, 'NO_DISPATCH_RECONCILED', after['result_at'], canonical(details).decode()))
            db.execute('DELETE FROM pilot_slot WHERE singleton=1 AND source_sha256=?', (source_sha256,))
            db.execute('DELETE FROM recurrence_slot WHERE singleton=1 AND batch_id=? AND member_id=?', (batch_id, member_id))
            return outcome

    @metrics.measured('prior')
    def _prior(self, db, member, *, current_grant=None):
        task = member['manifest']['task']; source = task['source']
        for table in ('attempts', 'second_attempts'):
            if not db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                continue
            for row in db.execute('SELECT source_sha256,grant_json,refs_json,state FROM ' + table):
                metrics.count('prior_rows')
                grant = approval.load_json(row['grant_json'])
                if (current_grant is not None and table == 'attempts' and
                        row['source_sha256'] == source['source_video_sha256'] and
                        grant['grant_id'] == current_grant):
                    continue
                if row['state'] != 'PERSISTED':
                    require(isinstance(self, Queue), 'old uncertain attempt')
                    require(table == 'attempts', 'old uncertain successor')
                    _, closed, _ = self._no_dispatch_proof(db, row['source_sha256'])
                    require(row['source_sha256'] != source['source_video_sha256'] and
                            closed['member_id'] != task['reel_id'] and
                            closed['metadata_sha256'] != source['metadata_sha256'], 'reconciled source forever consumed')
                    continue
                refs = approval.load_json(row['refs_json'])
                require(isinstance(refs, dict) and isinstance(refs.get('artifact_prefix'), str) and
                        isinstance(refs.get('manifest_sha256'), str), 'historical refs required')
                store = worker.FileStore(self.policy['roots']['result_root']['root_id'],
                                         read_only=getattr(self, 'read_only', False), metrics=metrics.current())
                prefix = refs['artifact_prefix']
                verified = store.verify_selected(prefix, ('analysis.v1.json', 'provenance.json'))
                require(verified['manifest_sha256'] == refs['manifest_sha256'],
                        'historical immutable manifest differs')
                analysis = approval.load_json(verified['selected']['analysis.v1.json'])
                provenance = approval.load_json(verified['selected']['provenance.json'])
                reference = analysis['identity']['source_metadata_reference']
                metadata = provenance['metadata_sha256']
                require(isinstance(metadata, str) and worker._DIGEST.fullmatch(metadata) and
                        (reference is None or reference['sha256'] == metadata), 'historical metadata integrity')
                require(row['source_sha256'] != source['source_video_sha256'] and
                        grant['bindings']['media']['id'] != task['reel_id'] and
                        metadata != source['metadata_sha256'], 'prior attempt/reservation collision')

    def prepare(self, batch):
        batch = validate_batch(batch, self.policy)
        with self.ledger._transaction() as db:
            slot = db.execute('SELECT * FROM recurrence_campaign_slots WHERE batch_id=?', (batch['batch_id'],)).fetchone()
            if slot:
                self._campaign(db, slot['campaign_id'], authority=False)
                require(slot['effective_sha256'] == sha(canonical(batch)), 'registered effective inventory only')
            for member in batch['members']:
                task = member['manifest']['task']; source = task['source']
                planned = db.execute('SELECT batch_id FROM recurrence_campaign_planned WHERE member_id=? OR source_sha256=? OR metadata_sha256=?',
                                     (task['reel_id'], source['source_video_sha256'], source['metadata_sha256'])).fetchall()
                require(all(row[0] == batch['batch_id'] for row in planned), 'planned campaign identity cannot escape slot')
        self._history_receipt(batch)
        encoded = canonical(batch).decode(); digest = sha(encoded.encode())
        with self.ledger._transaction() as db:
            old = db.execute('SELECT manifest_json FROM recurrence_batches WHERE batch_id=?', (batch['batch_id'],)).fetchone()
            if old:
                require(old[0] == encoded, 'batch ID immutable; no expansion')
                return digest
        # A validated persisted campaign slot registers PENDING inventory only;
        # source/request admission remains mandatory in each member's run path.
        # Legacy batches still eagerly observe media, never download.
        if slot is None:
            if self.synthetic:
                from test_worker_provider import FakeProvider
                scanner = worker.Pipeline(self.policy, synthetic=True, transport=FakeProvider())
            else:
                scanner = worker.Pipeline(self.policy)
        for member in batch['members']:
            self._history(member)
            if slot is None:
                data, _, _ = scanner._source(member['manifest']['task'])
                require(sha(worker.provider.request_bytes(member['manifest']['task'], data)) == member['manifest']['request_sha256'],
                        'inventory request differs')
        with self.ledger._transaction() as db:
            old = db.execute('SELECT manifest_json FROM recurrence_batches WHERE batch_id=?', (batch['batch_id'],)).fetchone()
            if old:
                require(old[0] == encoded, 'batch ID immutable')
                return digest
            for member in batch['members']:
                self._prior(db, member)
                task = member['manifest']['task']; src = task['source']
                require(not db.execute('SELECT 1 FROM recurrence_members WHERE member_id=? OR source_sha256=? OR metadata_sha256=?',
                        (task['reel_id'], src['source_video_sha256'], src['metadata_sha256'])).fetchone(), 'queued identity collision')
            db.execute('INSERT INTO recurrence_batches(batch_id,manifest_json,manifest_sha256) VALUES(?,?,?)',
                       (batch['batch_id'], encoded, digest))
            for ordinal, member in enumerate(batch['members']):
                task = member['manifest']['task']; src = task['source']
                db.execute('INSERT INTO recurrence_members(batch_id,ordinal,member_id,source_sha256,metadata_sha256,state) VALUES(?,?,?,?,?,?)',
                           (batch['batch_id'], ordinal, task['reel_id'], src['source_video_sha256'], src['metadata_sha256'], 'PENDING'))
        return digest

    def _receipt(self, row, batch):
        require(row['receipt_path'] is not None, 'explicit batch authorization required')
        value, digest = protected(row['receipt_path'])
        require(digest == row['receipt_sha256'], 'receipt bytes changed')
        require(set(value) == APPROVAL_KEYS, 'approval keys')
        require(value['decision'] == 'APPROVE_REELS_BATCH' and value['batch_id'] == batch['batch_id'] and
                value['manifest_sha256'] == row['manifest_sha256'], 'approval identity')
        require(value['rights_and_global_privacy_accepted'] is True, 'rights/global privacy required')
        require(isinstance(value['approval_id'], str) and 0 < len(value['approval_id']) <= 200 and
                isinstance(value['approved_by'], str) and 0 < len(value['approved_by']) <= 200, 'human authority')
        start = approval._instant(value['approved_at']); end = approval._instant(value['expires_at'])
        require(start <= now() < end, 'batch receipt outside validity')
        count(value['max_calls'], 1, 3)
        require(value['max_calls'] == batch['max_calls'] and
                money(value['max_gross_USD'], 9) == money(batch['max_gross_USD'], 9), 'exact approval quota')
        with self.ledger._transaction() as db:
            self._campaign_child(db, batch, value)
        return value

    def _campaign_child(self, db, batch, receipt):
        slot = db.execute('SELECT * FROM recurrence_campaign_slots WHERE batch_id=?', (batch['batch_id'],)).fetchone()
        parent = db.execute('SELECT campaign_id FROM recurrence_campaigns WHERE parent_approval_id=?', (receipt['approval_id'],)).fetchone()
        if slot is None:
            require(parent is None, 'campaign parent cannot authorize unregistered/sixth batch')
            return
        manifest, authority = self._campaign(db, slot['campaign_id'])
        require(slot['effective_sha256'] == sha(canonical(batch)), 'exact registered batch')
        require(all(receipt[k] == authority[k] for k in
                    ('approval_id', 'approved_by', 'approved_at', 'expires_at', 'rights_and_global_privacy_accepted')),
                'child must derive same human parent decision')

    def authorize(self, batch_id, receipt):
        _, digest = protected(receipt)
        with self.ledger._transaction() as db:
            checked_row, checked_batch = self._batch(db, batch_id)
        checked_row.update(receipt_path=str(receipt), receipt_sha256=digest)
        self._receipt(checked_row, checked_batch)
        with self.ledger._transaction() as db:
            row, batch = self._batch(db, batch_id)
            require(not db.execute("SELECT 1 FROM recurrence_members WHERE batch_id=? AND state NOT IN ('PENDING','AUTHORIZED')", (batch_id,)).fetchone(), 'cannot replace running authority')
            if row['receipt_path']:
                require(row['receipt_path'] == str(receipt) and row['receipt_sha256'] == digest, 'approval immutable')
            row.update(receipt_path=str(receipt), receipt_sha256=digest)
            # Full legacy receipt was checked above. Recheck protected bytes and
            # campaign parent inside the state-changing transaction as well.
            value, fresh_digest = protected(receipt)
            require(fresh_digest == digest, 'receipt changed during authorization')
            self._campaign_child(db, batch, value)
            db.execute('UPDATE recurrence_batches SET receipt_path=?,receipt_sha256=? WHERE batch_id=?', (str(receipt), digest, batch_id))
            db.execute("UPDATE recurrence_members SET state='AUTHORIZED' WHERE batch_id=? AND state='PENDING'", (batch_id,))

    def _authority(self, batch_id, manifest, envelope, *, history_required=True):
        with self.ledger._transaction() as db:
            row, batch = self._batch(db, batch_id)
        receipt = self._receipt(row, batch)
        member = next((m for m in batch['members'] if m['manifest'] == manifest), None)
        require(member is not None, 'exact member manifest')
        grant = envelope['grant']
        self._history_receipt(batch)
        if history_required:
            self._history(member)
        with self.ledger._transaction() as db:
            claimed = db.execute('SELECT state,grant_id,source_sha256 FROM recurrence_members WHERE batch_id=? AND member_id=?',
                                 (batch_id, manifest['task']['reel_id'])).fetchone()
            current = (grant['grant_id'] if claimed['state'] == 'RUNNING' and
                       claimed['grant_id'] == grant['grant_id'] and
                       claimed['source_sha256'] == manifest['task']['source']['source_video_sha256'] else None)
            self._prior(db, member, current_grant=current)
        require('successor' not in grant, 'successors forbidden in recurrence')
        require(grant['authority']['approval_id'] == receipt['approval_id'] and
                grant['authority']['approver'] == receipt['approved_by'] and
                approval._instant(grant['authority']['approved_at']) >= approval._instant(receipt['approved_at']) and
                approval._instant(grant['expires_at']) <= approval._instant(receipt['expires_at']), 'grant batch authority/expiry')
        require(grant['limits']['currency'] == 'USD' and
                money(grant['limits']['gross_budget'], 3) <= money(member['max_gross_USD'], 3), 'member grant budget')

    def _pipeline(self, batch_id, *, transport=None, writer_hook=None):
        if self.synthetic:
            from test_worker_provider import FakeProvider
            require(type(transport) is FakeProvider, 'existing FakeProvider required')
        else:
            require(transport is None and writer_hook is None, 'real hooks forbidden')
        pipeline = _GuardedPipeline(self.policy, synthetic=self.synthetic, transport=transport, writer_hook=writer_hook)
        pipeline.queue = self; pipeline.batch_id = batch_id
        return pipeline

    def status(self, batch_id):
        with self.ledger._transaction() as db:
            self._batch(db, batch_id)
            return [dict(r) for r in db.execute('SELECT ordinal,member_id,state,persisted,cleanup,review,grant_id FROM recurrence_members WHERE batch_id=? ORDER BY ordinal', (batch_id,))]

    def next(self, batch_id):
        with self.ledger._transaction() as db:
            self._batch(db, batch_id)
            slot = db.execute('SELECT * FROM recurrence_campaign_slots WHERE batch_id=?', (batch_id,)).fetchone()
            if slot:
                manifest, _ = self._campaign(db, slot['campaign_id'])
                self._campaign_order(db, slot, manifest)
            if db.execute('SELECT 1 FROM recurrence_slot').fetchone() or db.execute('SELECT 1 FROM pilot_slot').fetchone():
                return None
            row = db.execute('SELECT member_id,state FROM recurrence_members WHERE batch_id=? AND cleanup=0 ORDER BY ordinal LIMIT 1', (batch_id,)).fetchone()
            return dict(row) if row else None

    @metrics.operational('Queue.run_one')
    @metrics.measured('coordination')
    def run_one(self, batch_id, envelope, *, executor_id, transport=None, writer_hook=None):
        with self.ledger._transaction() as db:
            _, batch = self._batch(db, batch_id)
            row = db.execute('SELECT * FROM recurrence_members WHERE batch_id=? AND cleanup=0 ORDER BY ordinal LIMIT 1', (batch_id,)).fetchone()
            require(row is not None and row['state'] == 'AUTHORIZED', 'no authorized next member; never replay running')
            row = dict(row); manifest = batch['members'][row['ordinal']]['manifest']
        pipeline = self._pipeline(batch_id, transport=transport, writer_hook=writer_hook)
        # Crypto verification before claim and any worker IO.
        pipeline._verify(manifest, envelope, now())
        with self.ledger._transaction() as db:
            current = db.execute('SELECT state FROM recurrence_members WHERE batch_id=? AND ordinal=?', (batch_id, row['ordinal'])).fetchone()
            require(current[0] == 'AUTHORIZED', 'concurrent claim')
            require(not db.execute('SELECT 1 FROM recurrence_slot').fetchone() and not db.execute('SELECT 1 FROM pilot_slot').fetchone(), 'global WIP1')
            for table in ('attempts', 'second_attempts'):
                if db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                    for uncertain in db.execute("SELECT source_sha256 FROM " + table + " WHERE state!='PERSISTED'"):
                        require(table == 'attempts', 'old uncertain successor')
                        self._no_dispatch_proof(db, uncertain['source_sha256'])
            self._prior(db, batch['members'][row['ordinal']])
            self._reserve_campaign(db, batch, batch['members'][row['ordinal']], envelope)
            db.execute('INSERT INTO recurrence_slot VALUES(1,?,?)', (batch_id, row['member_id']))
            db.execute("UPDATE recurrence_members SET state='RUNNING',envelope_json=?,run_manifest_sha256=?,grant_id=? WHERE batch_id=? AND ordinal=?",
                       (canonical(envelope).decode(), sha(canonical(manifest)), envelope['grant']['grant_id'], batch_id, row['ordinal']))
        try:
            result = pipeline.run(manifest, envelope, executor_id=executor_id)
        except Exception as exc:
            self._save_exception(batch_id, row['member_id'], row['source_sha256'], exc)
            raise
        return self._save(batch_id, row['member_id'], result)

    def _save_exception(self, batch_id, member_id, digest, exc):
        """Control evidence only, never a provider result or permission to retry."""
        with self.ledger._transaction() as db:
            record = db.execute('SELECT state,calls,started_at,response,response_sha256 FROM attempts WHERE source_sha256=?',
                                (digest,)).fetchone()
            known_zero = record is None or (
                record['state'] == 'RESERVED' and record['calls'] == 0 and
                record['started_at'] is None and record['response'] is None and
                record['response_sha256'] is None)
            # Do not persist exception messages (which may contain credentials).
            kind = type(exc).__name__
            kind = kind if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', kind) else 'Exception'
            control = {'state': 'BLOCKED', 'kind': 'exception_control',
                       'phase': 'pipeline_run', 'exception_type': kind,
                       'provider_io': 'NOT_STARTED' if known_zero else 'MAY_HAVE_STARTED',
                       'retry_allowed': False}
            if known_zero:
                control['provider_calls'] = 0
            # Atomic metadata/state update; leave reservations, counters and both
            # slots untouched, including durable UNKNOWN/response states.
            db.execute("UPDATE recurrence_members SET state='BLOCKED',result_json=?,result_at=? WHERE batch_id=? AND member_id=? AND cleanup=0",
                       (canonical(control).decode(), now().isoformat(), batch_id, member_id))

    def _save(self, batch_id, member_id, result):
        encoded = canonical(result).decode()
        persisted = result['state'] == 'PERSISTED'
        with self.ledger._transaction() as db:
            # Durable exact worker result stored before presentation state transition.
            db.execute('UPDATE recurrence_members SET result_json=?,result_at=?,persisted=? WHERE batch_id=? AND member_id=?',
                       (encoded, now().isoformat(), int(persisted), batch_id, member_id))
        with self.ledger._transaction() as db:
            db.execute('UPDATE recurrence_members SET state=? WHERE batch_id=? AND member_id=? AND cleanup=0',
                       ('PERSISTED' if persisted else 'BLOCKED', batch_id, member_id))
        return result

    @metrics.operational('Queue.recover', 'recovery')
    def recover(self, batch_id, member_id, *, executor_id, transport=None):
        with self.ledger._transaction() as db:
            _, batch = self._batch(db, batch_id)
            row = db.execute('SELECT * FROM recurrence_members WHERE batch_id=? AND member_id=?', (batch_id, member_id)).fetchone()
            require(row is not None and row['envelope_json'] is not None, 'claimed member required')
            row = dict(row); manifest = batch['members'][row['ordinal']]['manifest']
            require(sha(canonical(manifest)) == row['run_manifest_sha256'], 'claimed manifest changed')
        try:
            record = self.ledger.get(row['source_sha256'])
        except LedgerDenied:
            record = None
        if record is None or record['state'] in ('UNKNOWN', 'RESERVED'):
            with self.ledger._transaction() as db:
                db.execute("UPDATE recurrence_members SET state='BLOCKED' WHERE batch_id=? AND member_id=?", (batch_id, member_id))
            return {'state': 'BLOCKED', 'retry_allowed': False}
        require(record['grant_id'] == row['grant_id'], 'worker grant differs')
        pipeline = self._pipeline(batch_id, transport=transport)
        result = pipeline.recover(manifest, approval.load_json(row['envelope_json']), executor_id=executor_id)
        if row['cleanup']:
            require(canonical(result).decode() == row['result_json'], 'closed result differs')
            return result
        return self._save(batch_id, member_id, result)

    def cleanup(self, batch_id, member_id, receipt, *, executor_id, transport=None):
        # Verify actual immutable files through persistence-only worker path first.
        result = self.recover(batch_id, member_id, executor_id=executor_id, transport=transport)
        require(result['state'] == 'PERSISTED', 'unknown cannot be closed')
        value, digest = protected(receipt)
        with self.ledger._transaction() as db:
            row = db.execute('SELECT * FROM recurrence_members WHERE batch_id=? AND member_id=?', (batch_id, member_id)).fetchone()
            require(set(value) == CLEANUP_KEYS and value['decision'] == 'CLOSE_REELS_MEMBER', 'cleanup shape')
            expected = {'batch_id': batch_id, 'member_id': member_id, 'grant_id': row['grant_id'],
                        'source_sha256': row['source_sha256'], 'worker_result_sha256': sha(row['result_json'].encode())}
            require(all(value[k] == v for k, v in expected.items()), 'cleanup identity/result')
            require(all(value[k] is True for k in ('token_copy_removed', 'temporary_bindings_removed', 'other_bindings_preserved')), 'verified complete cleanup required')
            record = db.execute('SELECT persisted_at FROM attempts WHERE source_sha256=?', (row['source_sha256'],)).fetchone()
            require(record and approval._instant(record[0]) <= approval._instant(value['cleaned_at']) <= now(), 'cleanup must follow durable result')
            if row['cleanup']:
                require(row['cleanup_path'] == str(receipt) and row['cleanup_sha256'] == digest, 'cleanup receipt immutable')
                return
            require(db.execute('SELECT 1 FROM recurrence_slot WHERE batch_id=? AND member_id=?', (batch_id, member_id)).fetchone(), 'held slot required')
            state = 'NEEDS_REVIEW' if result['analysis_state'] == 'needs_review' else 'FAILED'
            # Uncertain HTTP outcomes are not proof of a safe next paid call.
            require(result['analysis_state'] in ('needs_review', 'failed'), 'uncertain HTTP requires manual reconciliation')
            protected_value, protected_digest = protected(receipt)
            require(protected_value == value and protected_digest == digest, 'cleanup changed')
            db.execute('UPDATE recurrence_members SET cleanup=1,review=?,state=?,cleanup_path=?,cleanup_sha256=? WHERE batch_id=? AND member_id=?',
                       (int(state == 'NEEDS_REVIEW'), state, str(receipt), digest, batch_id, member_id))
            db.execute('DELETE FROM recurrence_slot WHERE batch_id=? AND member_id=?', (batch_id, member_id))


@metrics.operational('recurrence.main', 'control')
def main():
    parser = argparse.ArgumentParser(description='Finite on-demand queue; fixed Root policy and control files. No automatic next call.')
    parser.add_argument('command', choices=('bootstrap', 'prepare', 'status', 'next', 'authorize', 'run-one', 'recover', 'cleanup', 'close', 'reconcile-no-dispatch'))
    parser.add_argument('batch_id', nargs='?')
    parser.add_argument('--member-id')
    parser.add_argument('--executor-id')
    for field in ('source-sha256', 'grant-id', 'run-id', 'expected-member-state', 'expected-attempt-state'):
        parser.add_argument('--' + field)
    args = parser.parse_args()
    metrics.note(kind=('new' if args.command == 'run-one' else
                       'recovery' if args.command == 'recover' else 'control'))
    try:
        policy = worker.load_policy()
        if args.command == 'bootstrap':
            require(args.batch_id is None and args.member_id is None and args.executor_id is None, 'bootstrap takes no batch')
            Queue(policy, bootstrap=True)
            print(canonical({'state': 'SCHEMA_READY'}).decode())
            return 0
        identifier(args.batch_id)
        queue = Queue(policy)
        base = CONTROL / args.batch_id
        if args.command == 'prepare':
            batch, _ = protected(base / 'inventory.json')
            require(batch['batch_id'] == args.batch_id, 'inventory batch differs')
            result = {'manifest_sha256': queue.prepare(batch), 'state': 'PENDING'}
        elif args.command == 'authorize':
            queue.authorize(args.batch_id, base / 'approval.json'); result = {'state': 'AUTHORIZED'}
        elif args.command == 'reconcile-no-dispatch':
            require(args.executor_id is None, 'control takes no executor')
            result = queue.reconcile_no_dispatch(args.batch_id, args.member_id,
                    source_sha256=args.source_sha256, grant_id=args.grant_id, run_id=args.run_id,
                    expected_member_state=args.expected_member_state, expected_attempt_state=args.expected_attempt_state)
        elif args.command in ('status', 'next'):
            result = getattr(queue, args.command)(args.batch_id)
        else:
            require(args.executor_id is not None, 'executor ID required')
            if args.command == 'run-one':
                pending = queue.next(args.batch_id)
                require(pending is not None, 'WIP or finished')
                member_id = identifier(pending['member_id'])
                envelope, _ = protected(base / (member_id + '.grant.json'))
                result = queue.run_one(args.batch_id, envelope, executor_id=args.executor_id)
            else:
                identifier(args.member_id)
                if args.command == 'recover':
                    result = queue.recover(args.batch_id, args.member_id, executor_id=args.executor_id)
                else:
                    queue.cleanup(args.batch_id, args.member_id, base / (args.member_id + '.cleanup.json'), executor_id=args.executor_id)
                    result = queue.status(args.batch_id)
        print(canonical(result).decode())
        return 0
    except Exception as exc:
        print(canonical({'state': 'STOPPED', 'error_type': type(exc).__name__, 'retry_allowed': False}).decode())
        metrics.note(rejected=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
