"""Identity-only diagnostic: bounded auth plus one fixed catalog metadata GET."""
from contextlib import contextmanager
from dataclasses import dataclass, field
import datetime as dt
import http.client
import json
import os
import re
from pathlib import Path
import ssl
import signal
import threading
import stat
import sys

LIVE = Path(__file__).resolve().parents[1] / "reels-analysis-live"
if str(LIVE) not in sys.path:
    sys.path.insert(0, str(LIVE))
from cloud_adapter import GoogleOfficialTokenSource, AuthFailure
from common import parse_json

CATALOG_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash?view=PUBLISHER_MODEL_VIEW_BASIC"
CATALOG_PATH = "/v1/publishers/google/models/gemini-3.8-flash?view=PUBLISHER_MODEL_VIEW_BASIC"
MAX_RESPONSE_BYTES = 1_000_000
TIMEOUT_SECONDS = 30
OPERATIONAL_UID = 999
OPERATIONAL_GID = 987
CREDENTIAL_CLASS = "google.auth.impersonated_credentials.Credentials"
INFERENCE_BUDGET = 0
PREDICT_AUTHORIZED = False

@dataclass(frozen=True)
class OperatorIdentityConfig:
    """Operator-owned configuration only; no task, authorization or URL fields."""
    project_id: str
    target_service_account: str
    adc_path: Path

    def __post_init__(self):
        # Pure validation; this constructor neither opens ADC nor performs auth.
        GoogleOfficialTokenSource(self.target_service_account, self.project_id, self.adc_path)

    @classmethod
    def from_operator_file(cls, path, *, expected_uid=OPERATIONAL_UID, expected_gid=OPERATIONAL_GID):
        path = Path(path)
        if not path.is_absolute():
            raise AuthFailure("operator configuration rejected")
        for component in [path] + list(path.parents):
            if component.is_symlink():
                raise AuthFailure("operator configuration rejected")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or info.st_gid != expected_gid or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16_384):
                raise AuthFailure("operator configuration rejected")
            value = parse_json(stream.read(16_385))
        if not isinstance(value, dict) or set(value) != {"project_id", "target_service_account", "adc_path"}:
            raise AuthFailure("operator configuration rejected")
        if not all(isinstance(value[key], str) and value[key] for key in value):
            raise AuthFailure("operator configuration rejected")
        return cls(value["project_id"], value["target_service_account"], Path(value["adc_path"]))

@dataclass(frozen=True)
class _TokenBundle:
    token: str = field(repr=False)
    credential_class: str
    expiry: dt.datetime

class OfficialIdentityAuthenticator:
    """Lazy official SDK path; tests inject synthetic loaders instead of calling it."""
    def acquire(self, config):
        source = GoogleOfficialTokenSource(config.target_service_account, config.project_id, config.adc_path)
        info = config.adc_path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OPERATIONAL_UID or info.st_gid != OPERATIONAL_GID or
                stat.S_IMODE(info.st_mode) != 0o600):
            raise AuthFailure("credential profile permissions rejected")
        profile = source.read_approved_profile()
        import google.auth
        from google.auth import impersonated_credentials
        from google.oauth2 import credentials as user_credentials
        from google.auth.transport.requests import Request
        import requests
        from requests.adapters import HTTPAdapter
        session = requests.Session()
        session.trust_env = False
        session.verify = True
        session.mount("https://", HTTPAdapter(max_retries=0))
        session.mount("http://", HTTPAdapter(max_retries=0))
        captured = []
        def loader(profile_object, **kwargs):
            credentials, project = google.auth.load_credentials_from_dict(profile_object, **kwargs)
            captured.append(credentials)
            return credentials, project
        try:
            token = source.refresh_validated_profile(
                profile, loader, impersonated_credentials.Credentials,
                user_credentials.Credentials, Request(session=session))
            credentials = captured[0]
            return _TokenBundle(token, CREDENTIAL_CLASS, credentials.expiry)
        finally:
            session.close()

class _ResponseLimit(Exception):
    def __init__(self, status):
        self.status = status

class _UnexpectedResponse(Exception):
    def __init__(self, status):
        self.status = status


@contextmanager
def _metadata_deadline():
    """Linux/main-thread absolute elapsed-time bound, not a per-read timeout."""
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, "setitimer"):
        raise AuthFailure("bounded metadata deadline unavailable")
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_timer != (0.0, 0.0):
        raise AuthFailure("existing process timer prevents bounded metadata diagnostic")
    previous_handler = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame):
        raise TimeoutError("metadata deadline reached")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, TIMEOUT_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


class SingleCatalogGet:
    """One direct fixed HTTPS GET; no proxy environment, redirect, retry or fallback."""
    def __init__(self, connection_factory=None):
        self._used = False
        self._connection_factory = connection_factory or http.client.HTTPSConnection

    def get(self, token, quota_project):
        if self._used:
            raise AuthFailure("metadata attempt already consumed")
        self._used = True
        if not isinstance(token, str) or not token or "\r" in token or "\n" in token:
            raise AuthFailure("metadata credential rejected")
        if not isinstance(quota_project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", quota_project):
            raise AuthFailure("metadata quota project rejected")
        # Configuration was validated before authentication; no arbitrary request URL exists.
        with _metadata_deadline():
            connection = self._connection_factory(
                "aiplatform.googleapis.com", timeout=TIMEOUT_SECONDS, context=ssl.create_default_context())
            try:
                connection.request("GET", CATALOG_PATH, headers={
                    "Authorization": "Bearer " + token,
                    "x-goog-user-project": quota_project,
                    "Accept": "application/json"})
                response = connection.getresponse()
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise _ResponseLimit(response.status)
                if response.status == 200:
                    content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
                    if content_type != "application/json":
                        raise _UnexpectedResponse(response.status)
                    try:
                        value = parse_json(body)
                    except Exception:
                        raise _UnexpectedResponse(response.status) from None
                    if not isinstance(value, dict) or value.get("name") != "publishers/google/models/gemini-3.8-flash":
                        raise _UnexpectedResponse(response.status)
                return response.status
            finally:
                connection.close()

def _safe_report(config=None, code="operator_config_rejected", http_status=None,
                 credential_class=None, expiry=None):
    if isinstance(http_status, bool) or not isinstance(http_status, int) or not 100 <= http_status <= 599:
        http_status = None
    return {"credential_class": credential_class,
            "target": config.target_service_account if config is not None else None,
            "quota_project": config.project_id if config is not None else None,
            "expiry": expiry,
            "status": {"code": code, "http_status": http_status}}

class IdentityDiagnostic:
    def __init__(self, authenticator=None, transport=None):
        self._authenticator = authenticator or OfficialIdentityAuthenticator()
        self._transport = transport or SingleCatalogGet()
        self._used = False

    def run(self, config):
        if type(config) is not OperatorIdentityConfig:
            return _safe_report()
        if self._used:
            return _safe_report(config, "identity_attempt_already_consumed")
        self._used = True  # Failure or uncertainty never triggers automatic replay.
        try:
            bundle = self._authenticator.acquire(config)
            if (type(bundle) is not _TokenBundle or bundle.credential_class != CREDENTIAL_CLASS or
                    not isinstance(bundle.token, str) or not bundle.token or "\r" in bundle.token or "\n" in bundle.token or
                    type(bundle.expiry) is not dt.datetime):
                return _safe_report(config, "authentication_metadata_unusable")
            expiry = bundle.expiry
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=dt.timezone.utc)
            expiry = expiry.astimezone(dt.timezone.utc)
            if expiry <= dt.datetime.now(dt.timezone.utc):
                return _safe_report(config, "authentication_metadata_unusable")
            safe_expiry = expiry.isoformat()
        except (Exception, KeyboardInterrupt):
            return _safe_report(config, "authentication_failed")
        try:
            status = self._transport.get(bundle.token, config.project_id)
            if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
                return _safe_report(config, "metadata_request_failed",
                                    credential_class=CREDENTIAL_CLASS, expiry=safe_expiry)
        except _UnexpectedResponse as error:
            return _safe_report(config, "metadata_response_unexpected", error.status,
                                CREDENTIAL_CLASS, safe_expiry)
        except _ResponseLimit as error:
            return _safe_report(config, "metadata_response_too_large", error.status,
                                CREDENTIAL_CLASS, safe_expiry)
        except (Exception, KeyboardInterrupt):
            return _safe_report(config, "metadata_request_failed",
                                credential_class=CREDENTIAL_CLASS, expiry=safe_expiry)
        code = "identity_metadata_verified" if status == 200 else "metadata_http_rejected"
        return _safe_report(config, code, status, CREDENTIAL_CLASS, safe_expiry)

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if os.geteuid() != OPERATIONAL_UID or os.getegid() != OPERATIONAL_GID:
        print(json.dumps(_safe_report(code="operational_user_required"), sort_keys=True))
        return 1
    if len(argv) != 2 or argv[0] != "--operator-config":
        print(json.dumps(_safe_report(), sort_keys=True))
        return 1
    try:
        config = OperatorIdentityConfig.from_operator_file(argv[1])
        report = IdentityDiagnostic().run(config)
    except (Exception, KeyboardInterrupt):
        report = _safe_report()
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"]["code"] == "identity_metadata_verified" else 1

if __name__ == "__main__":
    raise SystemExit(main())
