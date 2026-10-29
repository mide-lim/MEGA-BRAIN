"""Windows operator helper. Import and injectable library paths never contact a service."""
import argparse
import base64
import datetime as dt
import http.client
import os
from pathlib import Path
import re
import subprocess
import time
import relay

HOST = 'iamcredentials.googleapis.com'
BODY = relay.canonical({'scope': ['https://www.googleapis.com/auth/cloud-platform'], 'lifetime': '900s'})


def environment(config):
    config = Path(config)
    if not config.is_absolute() or not config.is_dir() or config.is_symlink():
        relay.deny()
    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'}}
    env['CLOUDSDK_CONFIG'] = str(config)
    env['CLOUDSDK_CORE_DISABLE_PROMPTS'] = '1'
    env['CLOUDSDK_CORE_DISABLE_FILE_LOGGING'] = 'true'
    env['CLOUDSDK_CORE_LOG_HTTP'] = 'false'
    env['CLOUDSDK_CORE_LOG_HTTP_SHOW_REQUEST_BODY'] = 'false'
    env['CLOUDSDK_CORE_LOG_HTTP_STREAMING_BODY'] = 'false'
    env['CLOUDSDK_CORE_DISABLE_USAGE_REPORTING'] = 'true'
    env['CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK'] = 'true'
    env['CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT'] = ''
    return env


def executable(value):
    p = Path(value)
    if not p.is_absolute() or not p.is_file() or p.is_symlink():
        relay.deny()
    return str(p)


def sdk_bearer(sdk, account, config, runner=subprocess.run):
    if not isinstance(account, str) or not account or any(c.isspace() for c in account) or account.startswith('-'):
        relay.deny()
    result = runner([executable(sdk), 'auth', 'print-access-token', '--account='+account,
                     '--impersonate-service-account=', '--quiet'], input=b'', stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=20, shell=False, env=environment(config))
    if result.returncode != 0 or not 1 <= len(result.stdout) <= 16386:
        relay.deny()
    try:
        token = result.stdout.decode('ascii').removesuffix('\n').removesuffix('\r')
    except UnicodeError:
        relay.deny()
    if not token or len(token) > 16384 or any(not 33 <= ord(c) <= 126 for c in token):
        relay.deny()
    return token


def post_once(target, bearer, quota_project):
    """Direct TLS only: no proxy, redirect, retry, refresh or fallback implementation."""
    connection = http.client.HTTPSConnection(HOST, timeout=20)
    deadline = time.monotonic()+20
    try:
        connection.request('POST', '/v1/projects/-/serviceAccounts/'+target+':generateAccessToken',
                           body=BODY, headers={'Authorization': 'Bearer '+bearer,
                                               'x-goog-user-project': quota_project,
                                               'Content-Type': 'application/json', 'Content-Length': str(len(BODY))})
        response = connection.getresponse()
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            relay.deny()
        if connection.sock is not None:
            connection.sock.settimeout(remaining)
        raw = response.read(relay.MAX+1)
        if time.monotonic() > deadline or len(raw) > relay.MAX:
            relay.deny()
        return response.status, raw
    finally:
        connection.close()


def failure_metadata(status, raw):
    """Allowlist bounded HTTP status and Google ErrorInfo identifiers, never messages."""
    safe = {'status': status} if type(status) is int and 100 <= status <= 599 else {}
    try:
        error = relay.strict(raw).get('error')
    except (ValueError, TypeError, RecursionError):
        return safe
    if not isinstance(error, dict) or not isinstance(error.get('details'), list):
        return safe
    for detail in error['details']:
        if not isinstance(detail, dict) or detail.get('@type') != 'type.googleapis.com/google.rpc.ErrorInfo' or detail.get('domain') != 'googleapis.com':
            continue
        fields = {'reason': detail.get('reason')}
        metadata = detail.get('metadata')
        if isinstance(metadata, dict):
            fields.update(service=metadata.get('service'), consumer=metadata.get('consumer'))
        for key, pattern in (
                ('reason', r'[A-Z][A-Z0-9_]{0,63}'),
                ('service', r'[a-z][a-z0-9-]{0,62}\.googleapis\.com'),
                ('consumer', r'projects/(?:[0-9]{1,20}|[a-z][a-z0-9-]{4,28}[a-z0-9])')):
            value = fields.get(key)
            if isinstance(value, str) and re.fullmatch(pattern, value):
                safe[key] = value
        break
    return safe


class HTTPRejected(relay.Rejected):
    def __init__(self, status, raw):
        self.metadata = failure_metadata(status, raw)
        super().__init__('transport rejected: '+relay.canonical(self.metadata).decode('ascii'))


def encrypt(request, value, pwsh, config, runner=subprocess.run):
    script = Path(__file__).with_name('encrypt.ps1')
    if script.is_symlink() or not script.is_file():
        relay.deny()
    result = runner([executable(pwsh), '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(script)],
                    input=relay.canonical({'request': request, 'payload': value,
                                           'aad_b64': base64.b64encode(relay.aad(request)).decode(),
                                           'request_sha256': relay.digest(relay.canonical(request))}),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, shell=False,
                    env=environment(config))
    if result.returncode != 0:
        relay.deny()
    e = relay.strict(result.stdout)
    if set(e) != relay.ENVELOPE or e['schema'] != 'api-token-envelope.v1' or e['request_sha256'] != relay.digest(relay.canonical(request)):
        relay.deny()
    for k, low, high in [('wrapped_key', 512, 512), ('iv', 12, 12), ('ciphertext', 16, 24576)]:
        n = len(base64.b64decode(e[k], validate=True))
        if not low <= n <= high:
            relay.deny()
    return e


def mint(request_raw, request_sha256, authority, *, sdk, account, config, pwsh,
         runner=subprocess.run, http_post=post_once, clock=relay.now):
    # Pins and authority must arrive through the independently trusted operator channel.
    if relay.digest(request_raw) != request_sha256:
        relay.deny()
    r = relay.strict(request_raw)
    relay.validate_request(r, authority, clock())
    bearer = sdk_bearer(sdk, account, config, runner)
    status, raw = http_post(r['target_service_account'], bearer, r['quota_project'])  # Exactly one call.
    del bearer
    if status != 200:
        raise HTTPRejected(status, raw)
    response = relay.strict(raw)
    if set(response) != {'accessToken', 'expireTime'}:
        relay.deny()
    expires = relay.instant(response['expireTime'])
    t = clock()
    if not dt.timedelta(seconds=150) <= expires-t <= dt.timedelta(seconds=930):
        relay.deny()
    value = {k: r[k] for k in relay.BINDINGS-{'issued_at', 'expires_at'}}
    value.update(purpose='api-token-v1', access_token=response['accessToken'],
                 issued_at=relay.utc(expires-dt.timedelta(seconds=900)), expires_at=relay.utc(expires))
    relay.payload(value, r, t)
    relay.validate_request(r, authority, t)
    envelope = encrypt(r, value, pwsh, config, runner)
    return envelope, {'http_status': 200, 'expires_at': value['expires_at'],
                      'quota_project': r['quota_project'], 'target_service_account': r['target_service_account'],
                      'operation_id': r['operation_id']}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('request', 'request-sha256', 'authority', 'sdk', 'account', 'config', 'pwsh'):
        p.add_argument('--'+key, required=True)
    args = p.parse_args()
    try:
        # CLI deliberately selects real transport; injection exists only at library level.
        raw = Path(args.request).read_bytes()
        a = relay.strict(Path(args.authority).read_bytes())
        envelope, metadata = mint(raw, args.request_sha256, a, sdk=args.sdk, account=args.account,
                                  config=args.config, pwsh=args.pwsh)
        print(relay.canonical(envelope).decode())
    except Exception:
        p.exit(1, 'transport rejected\n')


if __name__ == '__main__':
    main()
