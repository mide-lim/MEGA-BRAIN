"""One-use opaque bearer from a root-controller/IAM issuance binding.

No bearer claims are decoded or trusted. No refresh, environment or network.
Construction checks metadata only; the worker calls token after signed approval
and its durable UNKNOWN transition. All errors deliberately omit secret data.
"""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat

MAX_FILE = 24 * 1024
MAX_TOKEN = 16 * 1024
CLOCK_SKEW = 30
PROVIDER_DEADLINE = 120
BINDINGS = {"target_service_account", "quota_project", "operation_id", "nonce",
            "grant_reference", "issued_at", "expires_at"}
DESCRIPTOR_KEYS = BINDINGS | {"mode", "token_file", "file_identity"}
IDENTITY_KEYS = {"device", "inode", "uid", "gid", "mode", "size", "sha256"}


class ApiTokenDenied(ValueError):
    pass


def _deny():
    raise ApiTokenDenied("temporary authentication rejected")


def _instant(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        _deny()
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _deny()


def _lifetime(descriptor):
    issued, expires = (_instant(descriptor[k]) for k in ("issued_at", "expires_at"))
    if not dt.timedelta(0) < expires - issued <= dt.timedelta(seconds=900):
        _deny()
    return issued, expires


def _window(descriptor, now):
    issued, expires = _lifetime(descriptor)
    if issued > now + dt.timedelta(seconds=CLOCK_SKEW):
        _deny()
    if expires - now < dt.timedelta(seconds=PROVIDER_DEADLINE + CLOCK_SKEW):
        _deny()


def validate_descriptor(value, target):
    """Validate immutable signed data, independent of clock and credential file."""
    if not isinstance(value, dict) or set(value) != DESCRIPTOR_KEYS:
        _deny()
    if value["mode"] != "api_impersonated_token":
        _deny()
    for key in BINDINGS:
        item = value[key]
        if not isinstance(item, str) or not 1 <= len(item) <= 512 or any(
                not 33 <= ord(c) <= 126 for c in item):
            _deny()
    if (value["target_service_account"] != target["service_account"] or
            value["quota_project"] != target["project"]):
        _deny()
    path = value["token_file"]
    if not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path:
        _deny()
    p = Path(path)
    if not p.is_absolute() or ".." in p.parts or str(p) != path or path == "/":
        _deny()
    identity = value["file_identity"]
    if not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS:
        _deny()
    for key in ("device", "inode", "uid", "gid", "size"):
        if type(identity[key]) is not int or identity[key] < 0:
            _deny()
    if (identity["uid"] != 0 or identity["gid"] != 987 or identity["mode"] != "0640"
            or not 0 < identity["size"] <= MAX_FILE or identity["inode"] == 0):
        _deny()
    if not isinstance(identity["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", identity["sha256"]):
        _deny()
    _lifetime(value)


def _directory(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        _deny()


def _leaf(info, identity):
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
             stat.S_IMODE(info.st_mode), info.st_size) !=
            (identity["device"], identity["inode"], 0, 987, 0o640, identity["size"])):
        _deny()


def _parent(path):
    """Walk pinned directory FDs, never follow any symlink, including ancestors."""
    fd = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _directory(os.fstat(fd))
        for component in Path(path).parts[1:-1]:
            child = os.open(component, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            _directory(os.fstat(fd))
        return fd
    except BaseException:
        os.close(fd)
        raise


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _deny()
        result[key] = value
    return result


class TemporaryTokenSource:
    def __init__(self, descriptor, target):
        validate_descriptor(descriptor, target)
        self._descriptor = copy.deepcopy(descriptor)
        self._used = False
        _window(self._descriptor, dt.datetime.now(dt.timezone.utc))
        self._metadata()

    def _metadata(self):
        d = self._descriptor
        fd = None
        try:
            fd = _parent(d["token_file"])
            _leaf(os.stat(Path(d["token_file"]).name, dir_fd=fd, follow_symlinks=False), d["file_identity"])
        except OSError:
            _deny()
        finally:
            if fd is not None:
                os.close(fd)

    def token(self):
        if self._used:
            _deny()
        self._used = True  # Failed reads are consumed too; never retry.
        d = self._descriptor
        _window(d, dt.datetime.now(dt.timezone.utc))
        parent = fd = None
        try:
            parent = _parent(d["token_file"])
            fd = os.open(Path(d["token_file"]).name,
                         os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            _leaf(os.fstat(fd), d["file_identity"])
            raw = bytearray()
            while len(raw) <= MAX_FILE:
                chunk = os.read(fd, MAX_FILE + 1 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
            _leaf(os.fstat(fd), d["file_identity"])
            if len(raw) != d["file_identity"]["size"] or hashlib.sha256(raw).hexdigest() != d["file_identity"]["sha256"]:
                _deny()
            payload = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                                 parse_constant=lambda _: _deny())
            if not isinstance(payload, dict) or set(payload) != BINDINGS | {"purpose", "access_token"}:
                _deny()
            if payload["purpose"] != "api-token-v1" or any(payload[k] != d[k] for k in BINDINGS):
                _deny()
            token = payload["access_token"]
            if not isinstance(token, str) or not 1 <= len(token) <= MAX_TOKEN or any(
                    not 33 <= ord(c) <= 126 for c in token):
                _deny()
            _window(d, dt.datetime.now(dt.timezone.utc))
            return token
        except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
            _deny()
        finally:
            if fd is not None:
                os.close(fd)
            if parent is not None:
                os.close(parent)
