"""Prepared Cloud adapter. Importing this module performs no auth or network."""
import base64
import http.client
import re
import ssl
from common import ContractError, ROOT, parse_json, canonical

MODEL = "gemini-3.8-flash"
LOCATION = "global"
API_VERSION = "v1beta1"
MAX_CAPTURED_RESPONSE_BYTES = 4_000_000

class AuthFailure(PermissionError):
    pass

class Response:
    def __init__(self, status, body, headers=None, truncated=False):
        self.status, self.body = status, body
        self.headers = headers or {}
        self.truncated = truncated

def endpoint(task):
    cloud = task["cloud"]
    if cloud["model"] != MODEL or cloud["location"] != LOCATION or cloud["api_version"] != API_VERSION:
        raise ContractError("endpoint/model/location not in installed allowlist")
    project = cloud["project_id"]
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project):
        raise ContractError("project identifier")
    return ("https://aiplatform.googleapis.com/v1beta1/projects/" + project +
            "/locations/global/publishers/google/models/gemini-3.8-flash:generateContent")

def provider_schema(value):
    """Reviewed provider subset; full strict JSON Schema remains local."""
    if "anyOf" in value:
        choices = [x for x in value["anyOf"] if x.get("type") != "null"]
        if len(choices) != 1:
            raise ContractError("unsupported provider schema union")
        result = provider_schema(choices[0])
        result["nullable"] = True
        return result
    result = {}
    typ = value.get("type")
    if isinstance(typ, list):
        nonnull = [t for t in typ if t != "null"]
        if len(nonnull) != 1:
            raise ContractError("unsupported provider schema type")
        typ = nonnull[0]
        result["nullable"] = True
    if typ:
        result["type"] = typ.upper()
    for key in ("enum", "required", "minimum", "maximum"):
        if key in value:
            result[key] = value[key]
    if "properties" in value:
        result["properties"] = {k: provider_schema(v) for k, v in value["properties"].items()}
    if "items" in value:
        result["items"] = provider_schema(value["items"])
    return result

def build_request(task, media_bytes):
    endpoint(task)
    schema = parse_json((ROOT / "contracts/model-payload.v1.schema.json").read_bytes())
    prompt = (ROOT / "prompts/stored-multimodal.v1.txt").read_text()
    return {
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": "video/mp4",
                            "data": base64.b64encode(media_bytes).decode("ascii")},
             "mediaProcessing": "STATIC", "videoMetadata": {"fps": 1}},
            {"text": prompt}]}],
        "generationConfig": {
            "mediaResolution": "MEDIA_RESOLUTION_LOW",
            "responseMimeType": "application/json",
            "responseSchema": provider_schema(schema),
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "maxOutputTokens": 4096}}

class SingleHTTPTransport:
    is_simulated_transport = False
    """One direct HTTPS POST. No SDK retries, redirects, 401 refresh or resending."""
    def __init__(self):
        self._sent = False

    def send(self, url, body, token):
        if self._sent:
            raise RuntimeError("transport already used; inference resend forbidden")
        if not re.fullmatch(
            r"https://aiplatform\.googleapis\.com/v1beta1/projects/[a-z][a-z0-9-]{4,61}[a-z0-9]"
            r"/locations/global/publishers/google/models/gemini-3\.8-flash:generateContent", url):
            raise ContractError("transport endpoint denied")
        if not isinstance(token, str) or not token or "\r" in token or "\n" in token:
            raise AuthFailure("invalid auth token")
        self._sent = True
        # http.client does not automatically redirect or retry HTTP requests.
        connection = http.client.HTTPSConnection("aiplatform.googleapis.com", timeout=120,
                                                 context=ssl.create_default_context())
        try:
            connection.request("POST", url.removeprefix("https://aiplatform.googleapis.com"),
                               body=body, headers={"Authorization": "Bearer " + token,
                                                   "Content-Type": "application/json"})
            result = connection.getresponse()
            try:
                captured = result.read(MAX_CAPTURED_RESPONSE_BYTES + 1)
                truncated = len(captured) > MAX_CAPTURED_RESPONSE_BYTES
            except http.client.IncompleteRead as partial:
                captured = partial.partial
                truncated = True
            headers = {k.lower(): v for k, v in result.getheaders()
                       if k.lower() in ("content-type", "x-request-id", "x-goog-request-id")}
            return Response(result.status, captured[:MAX_CAPTURED_RESPONSE_BYTES], headers, truncated)
        finally:
            connection.close()

OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

class BoundedAuthRequest:
    """At most one OAuth POST and one target IAM POST, with no retry or redirect."""
    def __init__(self, delegate, target_url):
        self.delegate = delegate
        self.target_url = target_url
        self.enabled = False
        self.oauth_seen = False
        self.iam_seen = False

    def enable_after_profile_validation(self):
        self.enabled = True

    def __call__(self, url, method="GET", body=None, headers=None, **kwargs):
        if not self.enabled:
            raise AuthFailure("authentication HTTP denied before profile validation")
        if method != "POST":
            raise AuthFailure("authentication method denied")
        if url == OAUTH_TOKEN_URL:
            if self.oauth_seen or self.iam_seen:
                raise AuthFailure("duplicate/out-of-order OAuth request denied")
            self.oauth_seen = True
        elif url == self.target_url:
            if self.iam_seen:
                raise AuthFailure("duplicate IAM token request denied")
            self.iam_seen = True
        else:
            raise AuthFailure("authentication endpoint denied")
        kwargs["allow_redirects"] = False
        # Reserve the endpoint before I/O: even a failed request cannot be repeated.
        return self.delegate(url=url, method="POST", body=body, headers=headers, **kwargs)

class GoogleOfficialTokenSource:
    """Prepared strict impersonated-ADC profile. No discovery or task/env overrides."""
    def __init__(self, approved_service_account, approved_project, approved_adc_path):
        from pathlib import Path
        if not isinstance(approved_project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", approved_project):
            raise AuthFailure("approved project invalid")
        account_pattern = r"[a-z][a-z0-9-]{4,28}[a-z0-9]@" + re.escape(approved_project) + r"\.iam\.gserviceaccount\.com"
        if not isinstance(approved_service_account, str) or not re.fullmatch(account_pattern, approved_service_account):
            raise AuthFailure("approved target service account invalid")
        path = Path(approved_adc_path)
        if not path.is_absolute():
            raise AuthFailure("approved ADC path must be absolute")
        self.approved_project = approved_project
        self.approved_service_account = approved_service_account
        self.approved_adc_path = path
        self.target_url = ("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
                           approved_service_account + ":generateAccessToken")

    def validate_profile(self, profile):
        top = {"type", "service_account_impersonation_url", "source_credentials",
               "delegates", "quota_project_id", "universe_domain"}
        required = {"type", "service_account_impersonation_url", "source_credentials"}
        if not isinstance(profile, dict) or not required <= set(profile) or not set(profile) <= top:
            raise AuthFailure("unsupported ADC profile shape")
        if profile["type"] != "impersonated_service_account":
            raise AuthFailure("direct or unknown ADC type denied")
        if profile["service_account_impersonation_url"] != self.target_url:
            raise AuthFailure("ADC target mismatch")
        if profile.get("delegates") not in (None, []):
            raise AuthFailure("delegated impersonation chain denied")
        if profile.get("quota_project_id", self.approved_project) != self.approved_project:
            raise AuthFailure("ADC quota project mismatch")
        if profile.get("universe_domain", "googleapis.com") != "googleapis.com":
            raise AuthFailure("ADC universe denied")
        source = profile["source_credentials"]
        required_source = {"type", "client_id", "client_secret", "refresh_token"}
        allowed_source = required_source | {"account", "quota_project_id", "universe_domain",
                                            "token_uri", "token", "expiry", "rapt_token"}
        if not isinstance(source, dict) or not required_source <= set(source) or not set(source) <= allowed_source:
            raise AuthFailure("unsupported source ADC profile")
        if source["type"] != "authorized_user":
            raise AuthFailure("source must be human OAuth authorized_user")
        if any(not isinstance(source[key], str) or not source[key] for key in required_source - {"type"}):
            raise AuthFailure("source OAuth fields missing")
        if any(not isinstance(source[key], str) for key in set(source) - {"type"}):
            raise AuthFailure("source OAuth optional fields must be strings")
        if source.get("token_uri", OAUTH_TOKEN_URL) != OAUTH_TOKEN_URL:
            raise AuthFailure("source OAuth endpoint denied")
        if source.get("universe_domain", "googleapis.com") != "googleapis.com":
            raise AuthFailure("source OAuth universe denied")
        if "quota_project_id" in source and source["quota_project_id"] != self.approved_project:
            raise AuthFailure("source quota project mismatch")
        return profile

    def read_approved_profile(self):
        from storage import read_bytes
        for path in [self.approved_adc_path] + list(self.approved_adc_path.parents):
            if path.is_symlink():
                raise AuthFailure("ADC symlink denied")
        if self.approved_adc_path.stat().st_size > 1_000_000:
            raise AuthFailure("ADC profile exceeds local size bound")
        # Strict JSON parsing precedes the official loader, which receives this same object.
        return self.validate_profile(parse_json(read_bytes(self.approved_adc_path)))

    def refresh_validated_profile(self, profile, loader, impersonated_type, authorized_user_type, delegate):
        self.validate_profile(profile)
        request = BoundedAuthRequest(delegate, self.target_url)
        # No HTTP is allowed during loading or before exact runtime-type verification.
        credentials, loaded_project = loader(
            profile, scopes=[CLOUD_SCOPE], quota_project_id=self.approved_project, request=request)
        if type(credentials) is not impersonated_type:
            raise AuthFailure("direct or unknown credential class denied")
        source = getattr(credentials, "_source_credentials", None)
        if type(source) is not authorized_user_type:
            raise AuthFailure("non-human OAuth source credential denied")
        if credentials.signer_email != self.approved_service_account:
            raise AuthFailure("runtime impersonation target mismatch")
        if loaded_project not in (None, self.approved_project):
            raise AuthFailure("loaded credential project mismatch")
        if getattr(credentials, "quota_project_id", None) != self.approved_project:
            raise AuthFailure("runtime quota project mismatch")
        if getattr(credentials, "universe_domain", None) != "googleapis.com":
            raise AuthFailure("runtime universe denied")
        if getattr(source, "_token_uri", None) != OAUTH_TOKEN_URL or getattr(source, "_refresh_handler", None) is not None:
            raise AuthFailure("custom human OAuth refresh source denied")
        if getattr(source, "universe_domain", None) != "googleapis.com":
            raise AuthFailure("source runtime universe denied")
        if getattr(credentials, "_delegates", None) not in (None, []):
            raise AuthFailure("runtime delegation chain denied")
        if getattr(credentials, "_iam_endpoint_override", None) not in (None, self.target_url):
            raise AuthFailure("runtime IAM endpoint override denied")
        if getattr(credentials, "_target_scopes", None) != [CLOUD_SCOPE]:
            raise AuthFailure("runtime target scopes denied")
        lifetime = getattr(credentials, "_lifetime", None)
        if isinstance(lifetime, bool) or not isinstance(lifetime, int) or not 0 < lifetime <= 3600:
            raise AuthFailure("runtime target lifetime denied")
        request.enable_after_profile_validation()
        credentials.refresh(request)
        if not request.iam_seen or not isinstance(credentials.token, str) or not credentials.token:
            raise AuthFailure("no target token returned by the bounded refresh")
        return credentials.token

    def token(self):
        # Real invocation remains behind the installed, currently denying authority.
        profile = self.read_approved_profile()
        import google.auth
        from google.auth import impersonated_credentials
        from google.oauth2 import credentials as user_credentials
        from google.auth.transport.requests import Request
        import requests
        from requests.adapters import HTTPAdapter
        session = requests.Session()
        session.trust_env = False  # Credentials never follow environment proxies or netrc.
        session.mount("https://", HTTPAdapter(max_retries=0))
        session.mount("http://", HTTPAdapter(max_retries=0))
        try:
            return self.refresh_validated_profile(
                profile, google.auth.load_credentials_from_dict,
                impersonated_credentials.Credentials, user_credentials.Credentials,
                Request(session=session))
        finally:
            session.close()
