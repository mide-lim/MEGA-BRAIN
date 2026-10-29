"""External one-call approval. Worker verifies; only a separate root operator signs.

A task, environment flag, or the synthetic Sprint2D authority cannot mint a
capability. Production policy/key paths are selected by the fixed worker entry.
This module performs no authentication, media read, or provider request.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

from jsonschema import Draft202012Validator, FormatChecker

HERE = Path(__file__).resolve().parent
SCHEMA = json.loads((HERE / "contracts" / "grant.v1.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
_VERIFIED = object()
OPENSSL = "/usr/bin/openssl"
OPENSSL_ENV = {"PATH": "/usr/bin:/bin", "OPENSSL_CONF": "/dev/null",
               "HOME": "/nonexistent", "LANG": "C"}


class ApprovalDenied(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ApprovalDenied("duplicate JSON key")
        value[key] = item
    return value


def load_json(raw):
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, bytes) or len(raw) > 1000000:
        raise ApprovalDenied("bounded JSON document required")
    try:
        return json.loads(raw, object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              ApprovalDenied("non-finite JSON value")))
    except (UnicodeError, ValueError, TypeError) as exc:
        raise ApprovalDenied("invalid approval JSON") from exc


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _instant(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError, AttributeError) as exc:
        raise ApprovalDenied("aware timestamp required") from exc


def _money(value):
    if not isinstance(value, str):
        raise ApprovalDenied("money must be a decimal string")
    try:
        result = Decimal(value)
    except Exception as exc:
        raise ApprovalDenied("invalid money") from exc
    if not result.is_finite() or result <= 0:
        raise ApprovalDenied("positive finite money required")
    return result


def trusted_file(path, *, private=False):
    """Root ownership and non-writable path chain prevent worker key substitution."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ApprovalDenied("absolute trusted path required")
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
            raise ApprovalDenied("trust material must be a root-owned regular file")
        if info.st_mode & 0o022 or (private and info.st_mode & 0o077):
            raise ApprovalDenied("trust material has unsafe permissions")
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
                raise ApprovalDenied("untrusted path ancestor")
            # Root-owned sticky ancestors cannot rename an existing root child.
            if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                raise ApprovalDenied("worker-writable trust path")
    except OSError as exc:
        raise ApprovalDenied("trust file unavailable") from exc
    return path


def _require_ed25519(path, *, private=False):
    trusted_file(OPENSSL)
    arguments = [OPENSSL, "pkey"]
    if not private:
        arguments.append("-pubin")
    arguments.extend(["-in", str(path), "-pubout", "-outform", "DER"])
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=10, check=False, env=dict(OPENSSL_ENV))
    # Canonical RFC8410 SubjectPublicKeyInfo: Ed25519 OID + exactly32 keybytes.
    prefix = bytes.fromhex("302a300506032b6570032100")
    if result.returncode or len(result.stdout) != 44 or not result.stdout.startswith(prefix):
        raise ApprovalDenied("Ed25519 key type required")


def validate_document(grant):
    try:
        errors = list(VALIDATOR.iter_errors(grant))
    except (TypeError, ValueError) as exc:
        raise ApprovalDenied("grant schema rejected") from exc
    if errors:
        raise ApprovalDenied("grant schema rejected")
    if "successor" in grant:
        proof = grant["successor"]
        if (proof["approval_id"] != grant["authority"]["approval_id"] or
                proof["parent_grant_id"] == grant["grant_id"] or
                _money(grant["limits"]["gross_budget"]) != Decimal("3") or
                grant["limits"]["currency"] != "USD"):
            raise ApprovalDenied("distinct explicit successor approval and USD3 required")
    return deepcopy(grant)


@dataclass(frozen=True)
class VerifiedGrant:
    _encoded: bytes
    _proof: object

    @property
    def grant(self):
        if self._proof is not _VERIFIED:
            raise ApprovalDenied("verified capability required")
        return load_json(self._encoded)

    @property
    def source_sha256(self):
        return self.grant["bindings"]["media"]["sha256"]

    @property
    def grant_id(self):
        return self.grant["grant_id"]


def verify_grant(envelope, *, trusted_public_key, observed_bindings, now,
                 gross_ceiling, currency, request_sha256, manifest_sha256):
    if not isinstance(envelope, dict) or set(envelope) != {"grant", "signature"}:
        raise ApprovalDenied("signed envelope required")
    grant = validate_document(envelope["grant"])
    encoded = canonical(grant)
    public_key = trusted_file(trusted_public_key)
    _require_ed25519(public_key)
    try:
        signature = base64.b64decode(envelope["signature"], validate=True)
        if len(signature) != 64:
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise ApprovalDenied("Ed25519 signature required") from exc
    with tempfile.TemporaryDirectory(prefix="reels-grant-verify-") as tmp:
        message, sig = Path(tmp) / "message", Path(tmp) / "signature"
        message.write_bytes(encoded)
        sig.write_bytes(signature)
        result = subprocess.run(
            [OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key),
             "-rawin", "-in", str(message), "-sigfile", str(sig)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, check=False, env=dict(OPENSSL_ENV))
    if result.returncode:
        raise ApprovalDenied("signature rejected")
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ApprovalDenied("independent aware clock required")
    now = now.astimezone(timezone.utc)
    issued, start, end, approved = map(_instant, (
        grant["issued_at"], grant["not_before"], grant["expires_at"],
        grant["authority"]["approved_at"]))
    if not approved <= issued <= start < end or not start <= now < end:
        raise ApprovalDenied("grant outside validity window")
    if (end - issued).total_seconds() > 3600:
        raise ApprovalDenied("single supervised session exceeds one hour")
    if grant["bindings"] != observed_bindings:
        raise ApprovalDenied("independent bindings differ")
    if grant["manifest_sha256"] != manifest_sha256:
        raise ApprovalDenied("exact full manifest digest differs")
    if grant["request_sha256"] != request_sha256:
        raise ApprovalDenied("exact serialized request digest differs")
    amount = _money(grant["limits"]["gross_budget"])
    if grant["limits"]["currency"] != currency or amount > _money(gross_ceiling):
        raise ApprovalDenied("independent gross ceiling or currency differs")
    return VerifiedGrant(encoded, _VERIFIED)


def sign_human_approval(proposal, *, approval_record, private_key):
    """Root control operation after human approval; never callable as worker UID.

    The separate approval record must pin the canonical full grant, not merely a
    task ID or generic approval flag. No real approval is shipped in the repo.
    """
    if os.geteuid() != 0:
        raise ApprovalDenied("signing belongs to separate root control identity")
    grant = validate_document(proposal)
    approval_path = trusted_file(approval_record, private=True)
    key = trusted_file(private_key, private=True)
    _require_ed25519(key, private=True)
    approval = load_json(approval_path.read_bytes())
    needed = {
        "decision": "APPROVE_SINGLE_REEL",
        "approved_grant_sha256": sha256(canonical(grant)),
        "approval_id": grant["authority"]["approval_id"],
        "approved_by": grant["authority"]["approver"],
        "approved_at": grant["authority"]["approved_at"],
        "media_read_authorized": True,
        "media_transmit_authorized": True,
        "inference_authorized": True,
    }
    if any(approval.get(k) != v or (isinstance(v, bool) and type(approval.get(k)) is not bool)
           for k, v in needed.items()):
        raise ApprovalDenied("explicit exact human approval record required")
    with tempfile.TemporaryDirectory(prefix="reels-human-sign-") as tmp:
        message, signature = Path(tmp) / "message", Path(tmp) / "signature"
        message.write_bytes(canonical(grant))
        result = subprocess.run(
            [OPENSSL, "pkeyutl", "-sign", "-inkey", str(key), "-rawin",
             "-in", str(message), "-out", str(signature)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, check=False, env=dict(OPENSSL_ENV))
        if result.returncode:
            raise ApprovalDenied("control signer failed")
        raw = signature.read_bytes()
        if len(raw) != 64:
            raise ApprovalDenied("Ed25519 key required")
    return {"grant": grant, "signature": base64.b64encode(raw).decode("ascii")}
