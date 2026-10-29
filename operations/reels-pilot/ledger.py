"""Durable one-call ledger; no provider, signer, retry, or automatic refund.

SQLite FULL synchronous DELETE journaling commits UNKNOWN before the external
boundary. Source identity is global across model/name/version/grant changes.
A received raw response is retained before parsing/persistence, enabling recovery
without asking the provider again.
"""
from contextlib import contextmanager
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import uuid

from approval import ApprovalDenied, VerifiedGrant, canonical, _instant

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_PERSISTENCE_RECOVERIES = 3
STATES = ("RESERVED", "UNKNOWN", "RESULT_RECEIVED_NOT_PERSISTED",
          "PERSISTENCE_UNCERTAIN", "PERSISTED")


class LedgerDenied(ValueError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat()


def _digest(value):
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{64}", value):
        raise LedgerDenied("source SHA256 required")
    return value


class _AttemptDB:
    """Fixed SQL table namespace, not a source identity substitution.

    Only successor operations use these additive tables. The global pilot_slot
    deliberately remains shared with the untouched legacy tables.
    """
    def __init__(self, connection):
        self.base = connection

    def execute(self, sql, parameters=()):
        sql = re.sub(r"\b(attempts|events|persistence_recovery_runs)\b",
                     lambda m: "second_" + m.group(0), sql)
        return self.base.execute(sql, parameters)


class Ledger:
    def __init__(self, path, *, create=False, expected_identity=None, attempt_grant_id=None):
        if attempt_grant_id is not None and not re.fullmatch(r"pilot-[a-z0-9-]{1,64}", attempt_grant_id):
            raise LedgerDenied("exact attempt grant selector required")
        if create and attempt_grant_id is not None:
            raise LedgerDenied("initialize legacy ledger only")
        self.attempt_grant_id = attempt_grant_id
        self.path = Path(path)
        if not self.path.is_absolute() or ".." in self.path.parts:
            raise LedgerDenied("absolute fixed ledger path required")
        parent = self.path.parent
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise LedgerDenied("private ledger directory required")
        if info.st_uid != os.geteuid():
            raise LedgerDenied("ledger directory must belong to executor")
        self._identity = (info.st_dev, info.st_ino, info.st_uid)
        if create:
            if os.geteuid() != 0:
                raise LedgerDenied("ledger initialization belongs to control identity")
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW, 0o600)
            os.fsync(fd)
            os.close(fd)
            directory = os.open(parent, os.O_DIRECTORY | os.O_NOFOLLOW)
            os.fsync(directory)
            os.close(directory)
        if not self.path.exists():
            raise LedgerDenied("preinitialized ledger required; never recreate after loss")
        info = self.path.lstat()
        self._file_identity = (info.st_dev, info.st_ino, info.st_uid)
        if expected_identity is not None and tuple(expected_identity) != self._file_identity:
            raise LedgerDenied("root policy ledger identity differs")
        if not create:
            with self._transaction() as db:
                if db.execute("PRAGMA user_version").fetchone()[0] != 2:
                    raise LedgerDenied("preinitialized ledger schema required")
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise LedgerDenied("ledger integrity check failed")
            return
        with self._transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS attempts(
                    source_sha256 TEXT PRIMARY KEY,
                    grant_id TEXT NOT NULL UNIQUE,
                    run_id TEXT NOT NULL UNIQUE,
                    request_sha256 TEXT NOT NULL,
                    model TEXT NOT NULL,
                    project TEXT NOT NULL,
                    service_account TEXT NOT NULL,
                    gross_reserved TEXT NOT NULL,
                    currency TEXT NOT NULL,
                    max_calls INTEGER NOT NULL CHECK(max_calls=1),
                    calls INTEGER NOT NULL CHECK(calls IN(0,1)),
                    state TEXT NOT NULL CHECK(state IN(
                        'RESERVED','UNKNOWN','RESULT_RECEIVED_NOT_PERSISTED',
                        'PERSISTENCE_UNCERTAIN','PERSISTED')),
                    reserved_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    started_at TEXT,
                    received_at TEXT,
                    persisted_at TEXT,
                    grant_json TEXT NOT NULL,
                    response BLOB,
                    response_sha256 TEXT,
                    refs_json TEXT,
                    problem TEXT
                );
                CREATE TABLE IF NOT EXISTS pilot_slot(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    source_sha256 TEXT NOT NULL REFERENCES attempts(source_sha256)
                );
                CREATE TABLE IF NOT EXISTS persistence_recovery_runs(
                    run_id TEXT PRIMARY KEY,
                    source_sha256 TEXT NOT NULL REFERENCES attempts(source_sha256),
                    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
                    previous_run_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN('ACTIVE','ABANDONED_PARTIAL','PERSISTED')),
                    UNIQUE(source_sha256,ordinal)
                );
                CREATE TABLE IF NOT EXISTS events(
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_sha256 TEXT NOT NULL REFERENCES attempts(source_sha256),
                    event TEXT NOT NULL, at TEXT NOT NULL, details TEXT NOT NULL
                );
            """)
            db.execute("PRAGMA user_version=2")

    def _check_path(self):
        parent = self.path.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o077 or
                (parent.st_dev, parent.st_ino, parent.st_uid) != self._identity):
            raise LedgerDenied("ledger directory changed")
        info = self.path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                info.st_mode & 0o077 or info.st_nlink != 1 or
                (info.st_dev, info.st_ino, info.st_uid) != self._file_identity):
            raise LedgerDenied("unsafe ledger file")

    @contextmanager
    def _transaction(self):
        self._check_path()
        db = sqlite3.connect(str(self.path), timeout=0, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                raise LedgerDenied("durable journal required")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE")
            yield _AttemptDB(db) if self.attempt_grant_id else db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _event(db, digest, event, details=None):
        db.execute("INSERT INTO events(source_sha256,event,at,details) VALUES(?,?,?,?)",
                   (digest, event, _now(), canonical(details or {}).decode()))

    def _record(self, db, digest):
        if self.attempt_grant_id and not db.base.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='second_attempts'").fetchone():
            raise LedgerDenied("reservation required")
        row = db.execute("SELECT * FROM attempts WHERE source_sha256=?",
                         (_digest(digest),)).fetchone()
        if row is None:
            raise LedgerDenied("reservation required")
        if self.attempt_grant_id and row["grant_id"] != self.attempt_grant_id:
            raise LedgerDenied("selected attempt differs; no sibling or third attempt")
        return row

    def select(self, grant_id=None):
        return Ledger(self.path, expected_identity=self._file_identity,
                      attempt_grant_id=grant_id)

    def _admit_successor(self, db, grant, run_id):
        """Same transaction as reservation; no legacy row/event/recovery mutation."""
        base = db.base
        proof = grant.get("successor")
        if not proof or grant["grant_id"] != self.attempt_grant_id:
            raise LedgerDenied("signed explicit successor and exact selector required")
        parent = base.execute("SELECT * FROM attempts WHERE source_sha256=?",
                              (grant["bindings"]["media"]["sha256"],)).fetchone()
        if parent is None or parent["state"] != "PERSISTED" or parent["calls"] != 1:
            raise LedgerDenied("original persisted known failure required")
        old = json.loads(parent["grant_json"])
        raw = parent["response"]
        if (not isinstance(raw, bytes) or hashlib.sha256(raw).hexdigest() != parent["response_sha256"] or
                proof["parent_grant_id"] != parent["grant_id"] or
                proof["parent_run_id"] != parent["run_id"] or
                proof["parent_response_sha256"] != parent["response_sha256"] or
                "successor" in old or run_id == parent["run_id"] or
                grant["grant_id"] == parent["grant_id"] or
                proof["approval_id"] != grant["authority"]["approval_id"] or
                grant["authority"]["approval_id"] == old["authority"]["approval_id"] or
                grant["bindings"]["media"] != old["bindings"]["media"] or
                grant["bindings"]["target"] != old["bindings"]["target"]):
            raise LedgerDenied("successor parent, identity or distinct approval differs")
        try:
            capture = json.loads(raw)
            body = base64.b64decode(capture["body_base64"], validate=True)
            error = json.loads(body)
            if (type(capture["http_status"]) is not int or capture["http_status"] != 400 or
                    capture["truncated"] is not False or not body or
                    error["error"]["code"] != 400 or
                    json.loads(parent["refs_json"])["analysis_state"] != "failed"):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise LedgerDenied("integrity checked complete known HTTP400 required") from None
        if grant["limits"]["currency"] != "USD" or __import__("decimal").Decimal(grant["limits"]["gross_budget"]) != 3:
            raise LedgerDenied("incremental USD3 required")
        # Clone schema definitions only, never original data. All foreign keys in
        # the successor namespace refer to successor rows; pilot_slot stays global.
        for name in ("attempts", "events", "persistence_recovery_runs"):
            schema = base.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()[0]
            schema = re.sub(r"\b(attempts|events|persistence_recovery_runs)\b",
                            lambda m: "second_" + m.group(0), schema)
            schema = schema.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
            base.execute(schema)
        if base.execute("SELECT 1 FROM second_attempts").fetchone():
            raise LedgerDenied("only one successor; no third or sibling attempt")
        for row in base.execute("SELECT grant_id,run_id,grant_json FROM attempts"):
            if (row["grant_id"] == grant["grant_id"] or row["run_id"] == run_id or
                    json.loads(row["grant_json"])["authority"]["approval_id"] == grant["authority"]["approval_id"]):
                raise LedgerDenied("grant, run or approval already consumed")

    def reserve(self, checked, *, run_id=None):
        if not isinstance(checked, VerifiedGrant):
            raise ApprovalDenied("independently verified signed grant required")
        grant = checked.grant
        digest = checked.source_sha256
        target = grant["bindings"]["target"]
        run_id = run_id or str(uuid.uuid4())
        try:
            uuid.UUID(run_id)
        except (ValueError, TypeError, AttributeError) as exc:
            raise LedgerDenied("run UUID required") from exc
        try:
            with self._transaction() as db:
                if db.execute("SELECT 1 FROM pilot_slot").fetchone():
                    raise LedgerDenied("another pilot attempt remains reserved or uncertain")
                if self.attempt_grant_id:
                    self._admit_successor(db, grant, run_id)
                elif "successor" in grant:
                    raise LedgerDenied("successor requires explicit attempt selector")
                db.execute("""
                    INSERT INTO attempts(
                        source_sha256,grant_id,run_id,request_sha256,model,project,
                        service_account,gross_reserved,currency,max_calls,calls,
                        state,reserved_at,expires_at,grant_json)
                    VALUES(?,?,?,?,?,?,?,?,?,1,0,'RESERVED',?,?,?)
                """, (digest, grant["grant_id"], run_id, grant["request_sha256"],
                      target["model"], target["project"], target["service_account"],
                      grant["limits"]["gross_budget"], grant["limits"]["currency"],
                      _now(), grant["expires_at"], canonical(grant).decode()))
                db.execute("INSERT INTO pilot_slot VALUES(1,?)", (digest,))
                self._event(db, digest, "RESERVE_BEFORE_IO")
        except sqlite3.IntegrityError as exc:
            raise LedgerDenied("source, grant, or run already consumed; never rearm") from exc
        return digest

    def begin_dispatch(self, digest, *, now):
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise LedgerDenied("aware dispatch clock required")
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] != "RESERVED" or row["calls"] != 0:
                raise LedgerDenied("one dispatch only; uncertain calls cannot repeat")
            grant = json.loads(row["grant_json"])
            if not _instant(grant["not_before"]) <= now.astimezone(timezone.utc) < _instant(row["expires_at"]):
                raise LedgerDenied("authorization expired before dispatch")
            db.execute("UPDATE attempts SET state='UNKNOWN',calls=1,started_at=? WHERE source_sha256=?",
                       (now.astimezone(timezone.utc).isoformat(), digest))
            self._event(db, digest, "IO_STARTED_UNKNOWN")
        # Only a successful durable commit permits the caller to send bytes.

    def receive(self, digest, response_bytes):
        if (not isinstance(response_bytes, bytes) or not response_bytes or
                len(response_bytes) > MAX_RESPONSE_BYTES):
            raise LedgerDenied("bounded nonempty raw response required")
        response_sha = hashlib.sha256(response_bytes).hexdigest()
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] != "UNKNOWN" or row["calls"] != 1:
                raise LedgerDenied("response requires one started call")
            db.execute("""UPDATE attempts SET state='RESULT_RECEIVED_NOT_PERSISTED',
                       response=?,response_sha256=?,received_at=? WHERE source_sha256=?""",
                       (response_bytes, response_sha, _now(), digest))
            self._event(db, digest, "RESPONSE_DURABLE", {"sha256": response_sha})
        return response_sha

    def begin_persistence_recovery(self, digest, *, previous_run_id, reason):
        """Durably select a fresh artifact version; retain all earlier bytes and budget.

        This is local persistence recovery from an already durable response, never
        provider replay. CAS prevents two recovery writers selecting different
        successors. Three fresh versions is the fixed pilot recovery bound.
        """
        if not isinstance(reason, str) or not reason or len(reason) > 300:
            raise LedgerDenied("bounded recovery reason required")
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] not in ("RESULT_RECEIVED_NOT_PERSISTED", "PERSISTENCE_UNCERTAIN"):
                raise LedgerDenied("recovery requires already durable response")
            if (not isinstance(row["response"], bytes) or
                    hashlib.sha256(row["response"]).hexdigest() != row["response_sha256"]):
                raise LedgerDenied("durable response integrity failed")
            previous = db.execute("SELECT * FROM persistence_recovery_runs WHERE source_sha256=? ORDER BY ordinal DESC LIMIT 1", (digest,)).fetchone()
            current_run = previous["run_id"] if previous else row["run_id"]
            count = previous["ordinal"] if previous else 0
            if previous_run_id != current_run:
                raise LedgerDenied("persistence recovery run changed; reread ledger")
            if count >= MAX_PERSISTENCE_RECOVERIES:
                raise LedgerDenied("persistence recovery limit reached; manual review without provider retry")
            recovery_run = str(uuid.uuid4())
            if previous:
                db.execute("UPDATE persistence_recovery_runs SET status='ABANDONED_PARTIAL' WHERE run_id=?", (current_run,))
            db.execute("INSERT INTO persistence_recovery_runs VALUES(?,?,?,?,?,?,?)",
                       (recovery_run, digest, count + 1, current_run, _now(), reason, "ACTIVE"))
            db.execute("UPDATE attempts SET state='PERSISTENCE_UNCERTAIN',problem=? WHERE source_sha256=?", (reason, digest))
            self._event(db, digest, "PERSISTENCE_RECOVERY_NEW_VERSION_NO_PROVIDER",
                        {"previous_run_id": current_run, "recovery_run_id": recovery_run,
                         "ordinal": count + 1, "reason": reason})
        return recovery_run

    def mark_persisted(self, digest, refs, *, persistence_run_id=None):
        if not isinstance(refs, dict) or not refs:
            raise LedgerDenied("verified persistence references required")
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] not in ("RESULT_RECEIVED_NOT_PERSISTED", "PERSISTENCE_UNCERTAIN"):
                raise LedgerDenied("durable received response required")
            recovery = db.execute("SELECT run_id FROM persistence_recovery_runs WHERE source_sha256=? ORDER BY ordinal DESC LIMIT 1", (digest,)).fetchone()
            current_run = recovery["run_id"] if recovery else row["run_id"]
            if (recovery and persistence_run_id is None) or (persistence_run_id is not None and persistence_run_id != current_run):
                raise LedgerDenied("persistence run changed; stale writer cannot finalize")
            db.execute("UPDATE attempts SET state='PERSISTED',refs_json=?,persisted_at=? WHERE source_sha256=?",
                       (canonical(refs).decode(), _now(), digest))
            db.execute("DELETE FROM pilot_slot WHERE source_sha256=?", (digest,))
            db.execute("UPDATE persistence_recovery_runs SET status='PERSISTED' WHERE source_sha256=? AND status='ACTIVE'", (digest,))
            self._event(db, digest, "PERSISTED_NO_REARM", refs)

    def mark_persistence_uncertain(self, digest, reason):
        if not isinstance(reason, str) or not reason or len(reason) > 300:
            raise LedgerDenied("bounded persistence reason required")
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] not in ("RESULT_RECEIVED_NOT_PERSISTED", "PERSISTENCE_UNCERTAIN"):
                raise LedgerDenied("received response required")
            db.execute("UPDATE attempts SET state='PERSISTENCE_UNCERTAIN',problem=? WHERE source_sha256=?",
                       (reason, digest))
            self._event(db, digest, "PERSISTENCE_UNCERTAIN_NO_RETRY")

    def get(self, digest):
        with self._transaction() as db:
            row = dict(self._record(db, digest))
            row.pop("response")
            row["grant"] = json.loads(row.pop("grant_json"))
            row["refs"] = json.loads(row.pop("refs_json") or "null")
            row["persistence_recoveries"] = [dict(r) for r in db.execute(
                "SELECT run_id,ordinal,previous_run_id,started_at,reason,status FROM persistence_recovery_runs WHERE source_sha256=? ORDER BY ordinal", (digest,))]
            row["persistence_run_id"] = row["persistence_recoveries"][-1]["run_id"] if row["persistence_recoveries"] else row["run_id"]
            row["events"] = [dict(r) for r in db.execute(
                "SELECT event,at,details FROM events WHERE source_sha256=? ORDER BY sequence",
                (digest,))]
            return row

    load = get

    def recover_response(self, digest):
        with self._transaction() as db:
            row = self._record(db, digest)
            if row["state"] not in ("RESULT_RECEIVED_NOT_PERSISTED",
                                    "PERSISTENCE_UNCERTAIN", "PERSISTED"):
                raise LedgerDenied("no durable response; no provider retry")
            raw = row["response"]
            if not isinstance(raw, bytes) or hashlib.sha256(raw).hexdigest() != row["response_sha256"]:
                raise LedgerDenied("durable response integrity failed")
            return raw
