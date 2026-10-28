"""Offline contract rehearsal. No signer, credentials, transport, or live authority.

The in-memory ledger demonstrates transitions only. It cannot provide durable or
cross-process exclusion and must never be installed as a production authorizer.
"""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

SCHEMA_PATH = Path(__file__).parent / "contracts" / "synthetic-grant.v1.schema.json"
_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
_VALIDATOR = Draft202012Validator(_SCHEMA, format_checker=FormatChecker())
LIVE_AUTHORITY = "DENIED"


class ContractDenied(ValueError):
    """The proposed synthetic operation does not satisfy the contract."""


def require_live_grant(*_args, **_kwargs):
    """No input, task flag, environment, or synthetic grant changes this denial."""
    raise ContractDenied("DENIED: this module cannot authorize live execution")


def _instant(value):
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ContractDenied("invalid timestamp") from exc
    if stamp.tzinfo is None or stamp.utcoffset() is None:
        raise ContractDenied("timezone required")
    return stamp.astimezone(timezone.utc)


def _money(value):
    # A JSON number/float must never enter the gross-budget calculation.
    if not isinstance(value, str):
        raise ContractDenied("money must be a decimal string")
    try:
        amount = Decimal(value)
    except Exception as exc:
        raise ContractDenied("invalid money") from exc
    if not amount.is_finite() or amount <= 0:
        raise ContractDenied("money must be finite and positive")
    return amount


def validate_simulation(grant, *, observed_bindings, now, gross_ceiling, currency):
    """Validate an untrusted proposal against independent synthetic observations.

    Observations/clock/ceiling must come from the simulator's controller, never
    copied from a task as authority. This function does not read media or prove a
    real digest. No return value is a capability consumable by the live worker.
    """
    errors = list(_VALIDATOR.iter_errors(grant))
    if errors:
        raise ContractDenied("synthetic contract schema rejected")
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ContractDenied("independent aware clock required")
    issued, start, end = map(_instant, (grant["issued_at"], grant["not_before"], grant["expires_at"]))
    now = now.astimezone(timezone.utc)
    if not issued <= start < end or not issued <= now or not start <= now < end:
        raise ContractDenied("outside validity window")
    if grant["bindings"] != observed_bindings:
        raise ContractDenied("independent binding mismatch")
    amount, ceiling = _money(grant["limits"]["gross_budget"]), _money(gross_ceiling)
    if grant["limits"]["currency"] != currency or amount > ceiling:
        raise ContractDenied("gross budget or currency mismatch")
    return deepcopy(grant)


class SimulationLedger:
    """Single-process, synthetic-only ledger; no I/O or refund implementation."""

    def __init__(self):
        self._by_digest = {}
        self._grant_ids = set()
        self._events = []

    @property
    def records(self):
        return deepcopy(self._by_digest)

    @property
    def events(self):
        return deepcopy(self._events)

    def reserve(self, grant, **observations):
        checked = validate_simulation(grant, **observations)
        digest = checked["bindings"]["media"]["sha256"]
        grant_id = checked["grant_id"]
        # Content identity deliberately excludes model/version/task/cache keys.
        if digest in self._by_digest or grant_id in self._grant_ids:
            raise ContractDenied("reserved content or grant cannot be repeated")
        self._by_digest[digest] = {
            "grant_id": grant_id, "status": "RESERVED", "calls": 0,
            "gross_reserved": checked["limits"]["gross_budget"],
            "currency": checked["limits"]["currency"],
            "bindings": checked["bindings"], "expires_at": checked["expires_at"],
            "reserved_at": observations["now"].astimezone(timezone.utc).isoformat(),
            "result_sha256": None, "reconciliations": [],
        }
        self._grant_ids.add(grant_id)
        self._events.append({"event": "RESERVE_BEFORE_IO", "digest": digest})
        return digest

    def dispatch_simulated(self, digest, *, now):
        record = self._record(digest)
        if record["status"] != "RESERVED":
            raise ContractDenied("one simulated dispatch only")
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ContractDenied("independent aware clock required")
        if not _instant(record["reserved_at"]) <= now.astimezone(timezone.utc) < _instant(record["expires_at"]):
            raise ContractDenied("expired before simulated dispatch")
        # UNKNOWN is installed before the simulated external boundary. A crash
        # or lost response must leave a consumed call and retained reservation.
        record["calls"] = 1
        record["status"] = "UNKNOWN"
        self._events.append({"event": "SIMULATED_IO_STARTED_UNKNOWN", "digest": digest})

    def receive_simulated(self, digest, *, result_sha256):
        record = self._record(digest)
        if record["status"] != "UNKNOWN":
            raise ContractDenied("response requires a started call")
        if (not isinstance(result_sha256, str) or len(result_sha256) != 64 or
                any(c not in "0123456789abcdef" for c in result_sha256)):
            raise ContractDenied("result digest required")
        record["result_sha256"] = result_sha256
        record["status"] = "RESULT_RECEIVED_NOT_PERSISTED"
        self._events.append({"event": "SIMULATED_RESPONSE_RECEIVED", "digest": digest})

    def persist_simulated(self, digest, *, succeeded):
        record = self._record(digest)
        if record["status"] != "RESULT_RECEIVED_NOT_PERSISTED" or type(succeeded) is not bool:
            raise ContractDenied("persistence requires a received result and boolean outcome")
        record["status"] = "PERSISTED" if succeeded else "PERSISTENCE_UNCERTAIN"
        self._events.append({"event": record["status"], "digest": digest})

    def reconcile_simulated(self, digest, *, evidence_sha256):
        record = self._record(digest)
        if (not isinstance(evidence_sha256, str) or len(evidence_sha256) != 64 or
                any(c not in "0123456789abcdef" for c in evidence_sha256)):
            raise ContractDenied("manual evidence digest required")
        # Evidence annotates the record; it grants no retry and releases no funds.
        record["reconciliations"].append(evidence_sha256)
        self._events.append({"event": "MANUAL_EVIDENCE_NO_REARM", "digest": digest})

    def _record(self, digest):
        try:
            return self._by_digest[digest]
        except (KeyError, TypeError) as exc:
            raise ContractDenied("reservation required before any simulated I/O") from exc
