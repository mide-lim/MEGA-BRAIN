"""Finite, explicitly authorized recurrence. No scheduler, retries, or acceptance.

Only recurrence_* tables are written here; Pipeline owns its existing ledger.
Synthetic seams are Python-only and must use the existing fake transport.
"""
import argparse
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
    batch_id TEXT NOT NULL, member_id TEXT NOT NULL)''')
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
        for root_name in ('media_root', 'result_root'):
            root = Path(self.policy['roots'][root_name]['root_id'])
            if root_name == 'media_root':
                for part in ('media', 'reels'):
                    root = root / part
                    require(not root.is_symlink(), 'symlink in inventory root')
            require(root.is_dir() and not root.is_symlink(), 'history root missing')
            pending = [root]
            while pending:
                # Recheck the directory at open, not just its cached entry type.
                # This is not an atomic snapshot of the changing inventory.
                current = pending.pop()
                directory = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    with os.scandir(directory) as entries:
                        for entry in entries:
                            scanned += 1
                            require(scanned <= 20000, 'history scan bound; reconcile offline')
                            require(not entry.is_symlink(), 'symlink in inventory')
                            if entry.is_dir(follow_symlinks=False):
                                require(not (root_name == 'result_root' and entry.name == task['reel_id']),
                                        'existing result directory collision')
                                pending.append(current / entry.name)
                            elif entry.is_file(follow_symlinks=False) and entry.name.startswith(('analysis', 'history')) and entry.name.endswith('.json'):
                                history = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                                with os.fdopen(history, 'rb') as stream:
                                    require(os.fstat(stream.fileno()).st_size <= 1000000, 'history size')
                                    raw = stream.read(1000001)
                                require(len(raw) <= 1000000, 'history size')
                                require(not collision(approval.load_json(raw)), 'Windows/analysis history collision')
                finally:
                    os.close(directory)

    def _prior(self, db, member, *, current_grant=None):
        task = member['manifest']['task']; source = task['source']
        for table in ('attempts', 'second_attempts'):
            if not db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                continue
            for row in db.execute('SELECT source_sha256,grant_json,refs_json,state FROM ' + table):
                grant = approval.load_json(row['grant_json'])
                if (current_grant is not None and table == 'attempts' and
                        row['source_sha256'] == source['source_video_sha256'] and
                        grant['grant_id'] == current_grant):
                    continue
                require(row['state'] == 'PERSISTED', 'old uncertain attempt')
                refs = approval.load_json(row['refs_json'])
                require(isinstance(refs, dict) and isinstance(refs.get('artifact_prefix'), str) and
                        isinstance(refs.get('manifest_sha256'), str), 'historical refs required')
                store = worker.FileStore(self.policy['roots']['result_root']['root_id'])
                prefix = refs['artifact_prefix']
                store.verify(prefix)
                require(sha(store.get(prefix + '/manifest.json')) == refs['manifest_sha256'],
                        'historical immutable manifest differs')
                analysis = approval.load_json(store.get(prefix + '/analysis.v1.json'))
                provenance = approval.load_json(store.get(prefix + '/provenance.json'))
                reference = analysis['identity']['source_metadata_reference']
                metadata = provenance['metadata_sha256']
                require(isinstance(metadata, str) and worker._DIGEST.fullmatch(metadata) and
                        (reference is None or reference['sha256'] == metadata), 'historical metadata integrity')
                require(row['source_sha256'] != source['source_video_sha256'] and
                        grant['bindings']['media']['id'] != task['reel_id'] and
                        metadata != source['metadata_sha256'], 'prior attempt/reservation collision')

    def prepare(self, batch):
        batch = validate_batch(batch, self.policy)
        self._history_receipt(batch)
        encoded = canonical(batch).decode(); digest = sha(encoded.encode())
        with self.ledger._transaction() as db:
            old = db.execute('SELECT manifest_json FROM recurrence_batches WHERE batch_id=?', (batch['batch_id'],)).fetchone()
            if old:
                require(old[0] == encoded, 'batch ID immutable; no expansion')
                return digest
        # Observe existing media, never download. Synthetic uses worker byte guard.
        if self.synthetic:
            from test_worker_provider import FakeProvider
            scanner = worker.Pipeline(self.policy, synthetic=True, transport=FakeProvider())
        else:
            scanner = worker.Pipeline(self.policy)
        for member in batch['members']:
            self._history(member)
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
        return value

    def authorize(self, batch_id, receipt):
        _, digest = protected(receipt)
        with self.ledger._transaction() as db:
            row, batch = self._batch(db, batch_id)
            require(not db.execute("SELECT 1 FROM recurrence_members WHERE batch_id=? AND state NOT IN ('PENDING','AUTHORIZED')", (batch_id,)).fetchone(), 'cannot replace running authority')
            if row['receipt_path']:
                require(row['receipt_path'] == str(receipt) and row['receipt_sha256'] == digest, 'approval immutable')
            row.update(receipt_path=str(receipt), receipt_sha256=digest)
            self._receipt(row, batch)
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
            if db.execute('SELECT 1 FROM recurrence_slot').fetchone() or db.execute('SELECT 1 FROM pilot_slot').fetchone():
                return None
            row = db.execute('SELECT member_id,state FROM recurrence_members WHERE batch_id=? AND cleanup=0 ORDER BY ordinal LIMIT 1', (batch_id,)).fetchone()
            return dict(row) if row else None

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
                    require(not db.execute("SELECT 1 FROM " + table + " WHERE state!='PERSISTED'").fetchone(), 'old uncertain attempt')
            self._prior(db, batch['members'][row['ordinal']])
            db.execute('INSERT INTO recurrence_slot VALUES(1,?,?)', (batch_id, row['member_id']))
            db.execute("UPDATE recurrence_members SET state='RUNNING',envelope_json=?,run_manifest_sha256=?,grant_id=? WHERE batch_id=? AND ordinal=?",
                       (canonical(envelope).decode(), sha(canonical(manifest)), envelope['grant']['grant_id'], batch_id, row['ordinal']))
        result = pipeline.run(manifest, envelope, executor_id=executor_id)
        return self._save(batch_id, row['member_id'], result)

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


def main():
    parser = argparse.ArgumentParser(description='Finite on-demand queue; fixed Root policy and control files. No automatic next call.')
    parser.add_argument('command', choices=('bootstrap', 'prepare', 'status', 'next', 'authorize', 'run-one', 'recover', 'cleanup', 'close'))
    parser.add_argument('batch_id', nargs='?')
    parser.add_argument('--member-id')
    parser.add_argument('--executor-id')
    args = parser.parse_args()
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
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
