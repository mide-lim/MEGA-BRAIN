"""Offline fixtures only: no SDK/HTTP/PowerShell process is executed."""
import base64
import builtins
import copy
import datetime as dt
import importlib.util
import os
from pathlib import Path, PureWindowsPath
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import relay
import controller
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NOW = dt.datetime(2026, 10, 29, 2, 0, tzinfo=dt.timezone.utc)
DUMMY = 'SYNTHETIC-NOT-A-CREDENTIAL'


def encrypted(r, value, aad=None):
    public = serialization.load_pem_public_key(r['public_key_pem'].encode())
    key, iv = bytes(range(32)), bytes(range(12))
    wrapped = public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    cipher = AESGCM(key).encrypt(iv, relay.canonical(value), relay.aad(r) if aad is None else aad)
    return dict(schema='api-token-envelope.v1', request_sha256=relay.digest(relay.canonical(r)),
                wrapped_key=base64.b64encode(wrapped).decode(), iv=base64.b64encode(iv).decode(),
                ciphertext=base64.b64encode(cipher).decode())


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-transport-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.control = self.base/'session'
        self.tokens = self.base/'tokens'
        self.tokens.mkdir(mode=0o710)
        self.dest = self.tokens/'token.json'
        self.a = dict(target_service_account='synthetic@synthetic-project.iam.gserviceaccount.com',
                      quota_project='synthetic-project', operation_id='operation-1', grant_reference='synthetic-grant',
                      destination=str(self.dest))
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(relay, 'now', return_value=NOW).start()
        # Cap-drop fixture: adjust only exact fixture inodes/ancestor metadata.
        # Real fd walk, nofollow, nlink, exclusivity, fsync, bytes, crypto remain active.
        original_stat, original_fstat = os.stat, os.fstat
        ancestor_inodes = {original_stat(p).st_ino for p in [self.base, *self.base.parents]}
        def adjusted(info):
            v = list(info)
            if info.st_ino in ancestor_inodes:
                v[0] &= ~0o022
                v[4] = 0
            if info.st_ino == original_stat(self.tokens).st_ino:
                v[5] = 987
            try:
                token_inode = original_stat(self.dest).st_ino
            except FileNotFoundError:
                token_inode = None
            if info.st_ino == token_inode:
                v[5] = 987
            return os.stat_result(v)
        mock.patch.object(os, 'stat', side_effect=lambda *a, **kw: adjusted(original_stat(*a, **kw))).start()
        mock.patch.object(os, 'fstat', side_effect=lambda fd: adjusted(original_fstat(fd))).start()
        original_chown = os.fchown
        def fixture_chown(fd, uid, gid):
            if original_fstat(fd).st_ino == original_stat(self.dest).st_ino and (uid, gid) == (0, 987):
                return
            original_chown(fd, uid, gid)
        mock.patch.object(os, 'fchown', side_effect=fixture_chown).start()
        self.r = relay.prepare(self.control, self.a)
        self.value = {k: self.r[k] for k in relay.BINDINGS-{'issued_at', 'expires_at'}}
        self.value.update(purpose='api-token-v1', access_token=DUMMY, issued_at=relay.utc(NOW),
                          expires_at=relay.utc(NOW+dt.timedelta(seconds=900)))
        self.e = encrypted(self.r, self.value)

    def inbox(self, e=None):
        raw = relay.canonical(self.e if e is None else e)
        relay.write(self.control/'envelope.json', raw)
        return relay.digest(raw)

    def consume(self, pin=None, a=None):
        return relay.consume(self.control, self.a if a is None else a,
                             relay.digest(relay.canonical(self.r)), self.inbox() if pin is None else pin)

    def closed(self):
        self.assertTrue((self.control/'spent.json').exists())
        self.assertFalse((self.control/'private.pem').exists())
        self.assertFalse((self.control/'envelope.json').exists())

    def test_real_roundtrip_descriptor_and_diagnostic_adapter_read(self):
        d = self.consume()
        self.assertNotIn(DUMMY, relay.canonical(d).decode())
        self.assertEqual(set(d), relay.BINDINGS | {'mode', 'token_file', 'file_identity'})
        spec = importlib.util.spec_from_file_location('transport_api_fixture', HERE.parent/'reels-pilot/api_token.py')
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        class Clock(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW
        with mock.patch.object(api.dt, 'datetime', Clock):
            source = api.TemporaryTokenSource(d, {'service_account': self.a['target_service_account'], 'project': self.a['quota_project']})
            self.assertEqual(source.token(), DUMMY)
        self.closed()
        relay.cleanup(self.control)
        relay.cleanup(self.control)
        self.assertFalse(self.dest.exists())
        self.assertTrue((self.control/'spent.json').exists())

    def test_payload_binding_subcases(self):
        for key in ('target_service_account', 'quota_project', 'operation_id', 'grant_reference', 'nonce', 'purpose', 'expires_at'):
            value = dict(self.value, **{key: 'wrong'})
            with self.subTest(key=key), self.assertRaises(ValueError):
                relay.payload(value, self.r, NOW)
        for seconds in (149, 931):
            v = dict(self.value, expires_at=relay.utc(NOW+dt.timedelta(seconds=seconds)))
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                relay.payload(v, self.r, NOW)

    def test_wrong_aad_terminal(self):
        self.e = encrypted(self.r, self.value, b'wrong-aad')
        with self.assertRaises(Exception):
            self.consume()
        self.closed()
        with self.assertRaises(FileExistsError):
            self.consume(pin='0'*64)

    def test_authority_request_mismatch_subcases(self):
        for key in relay.AUTH:
            a = dict(self.a, **{key: 'wrong'})
            with self.subTest(key=key), self.assertRaises(Exception):
                relay.validate_request(self.r, a, NOW)
        for key, value in [('expires_at', relay.utc(NOW)), ('nonce', 'bad'), ('recipient_key_sha256', '0'*64)]:
            r = dict(self.r, **{key: value})
            with self.subTest(key=key), self.assertRaises(Exception):
                relay.validate_request(r, self.a, NOW)

    def test_windows_native_paths_validate_posix_destination(self):
        self.assertFalse(PureWindowsPath(self.a['destination']).is_absolute())
        with mock.patch.object(relay, 'Path', PureWindowsPath):
            relay.validate_request(self.r, self.a, NOW)
            for destination in ('C:/tokens/token.json', 'C:token.json', r'C:\tokens\token.json',
                                'relative/token.json', '/tokens/../token.json', '/',
                                r'\\server\share\token.json'):
                with self.subTest(destination=destination), self.assertRaises(relay.Rejected):
                    a = dict(self.a, destination=destination)
                    relay.validate_request(dict(self.r, destination=destination), a, NOW)

    def test_windows_controller_shared_validation_without_python_crypto(self):
        original_import = builtins.__import__
        def stdlib_import(name, *args, **kwargs):
            if name == 'cryptography' or name.startswith('cryptography.'):
                raise AssertionError('Windows must not import cryptography')
            return original_import(name, *args, **kwargs)
        def runner(args, **kwargs):
            raw = b'SYNTHETIC-OWNER\n' if 'print-access-token' in args else relay.canonical(self.e)
            return types.SimpleNamespace(returncode=0, stdout=raw, stderr=b'')
        post = mock.Mock(return_value=(200, relay.canonical(
            {'accessToken': DUMMY, 'expireTime': self.value['expires_at']})))
        with mock.patch('builtins.__import__', side_effect=stdlib_import), \
                mock.patch.object(relay, 'Path', PureWindowsPath), \
                mock.patch.object(controller, 'executable', side_effect=str), \
                mock.patch.object(controller, 'environment', return_value={}):
            relay.validate_request(self.r, self.a, NOW)
            e, metadata = controller.mint(
                relay.canonical(self.r), relay.digest(relay.canonical(self.r)), self.a,
                sdk='C:/synthetic/sdk', account='synthetic@example.test',
                config='C:/synthetic/config', pwsh='C:/synthetic/pwsh',
                runner=runner, http_post=post, clock=lambda: NOW)
        post.assert_called_once()
        self.assertEqual(e, self.e)
        self.assertEqual(metadata['http_status'], 200)

    def test_sdk_child_environment_rejects_hostile_inheritance(self):
        forced = {
            'CLOUDSDK_CORE_DISABLE_FILE_LOGGING': 'true',
            'CLOUDSDK_CORE_LOG_HTTP': 'false',
            'CLOUDSDK_CORE_LOG_HTTP_SHOW_REQUEST_BODY': 'false',
            'CLOUDSDK_CORE_LOG_HTTP_STREAMING_BODY': 'false',
            'CLOUDSDK_CORE_DISABLE_USAGE_REPORTING': 'true',
            'CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK': 'true',
        }
        inherited = {key: 'false' if value == 'true' else 'true'
                     for key, value in forced.items()}
        inherited.update({
            'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT': 'synthetic-impersonation',
            'CLOUDSDK_AUTH_ACCESS_TOKEN': DUMMY,
            'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE': '/synthetic/token',
            'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE': '/synthetic/credential',
            'GOOGLE_APPLICATION_CREDENTIALS': '/synthetic/adc',
            'CLOUDSDK_CONFIG': '/synthetic/untrusted-config',
            'CLOUDSDK_CORE_DISABLE_PROMPTS': '0',
            'UNRELATED_SECRET': DUMMY,
        })
        windows = {key: 'synthetic-'+key for key in (
            'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
            'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')}
        expected = dict(windows, **forced,
                        CLOUDSDK_CONFIG=str(self.base), CLOUDSDK_CORE_DISABLE_PROMPTS='1',
                        CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT='')
        runner = mock.Mock(return_value=types.SimpleNamespace(
            returncode=0, stdout=b'SYNTHETIC-OWNER\n', stderr=b''))
        with mock.patch.dict(os.environ, dict(inherited, **windows), clear=True), \
                mock.patch.object(controller, 'executable', side_effect=str):
            self.assertEqual(controller.environment(self.base), expected)
            self.assertEqual(controller.sdk_bearer(
                '/synthetic/sdk', 'synthetic@example.test', self.base, runner), 'SYNTHETIC-OWNER')
        runner.assert_called_once()
        args, kwargs = runner.call_args
        self.assertEqual(kwargs['env'], expected)
        self.assertFalse(kwargs['shell'])
        self.assertIn('--account=synthetic@example.test', args[0])
        self.assertIn('--impersonate-service-account=', args[0])
        self.assertNotIn(DUMMY, str(kwargs['env']))

    def test_powershell_source_preserves_timestamp_strings(self):
        # Static regression guard only; native Windows/.NET remains an operator gate.
        source = (HERE/'encrypt.ps1').read_text(encoding='utf-8')
        self.assertIn(
            '$value=([Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable -DateKind String)',
            source)
        self.assertEqual(source.count('ConvertFrom-Json'), 1)
        self.assertIn(
            '$plain=[Text.Encoding]::ASCII.GetBytes(($value.payload | ConvertTo-Json -Compress -Depth 10))',
            source)
        for timestamp in ('2026-10-29T02:00:00.123456+00:00',
                          '2026-10-29T02:15:00.654321+00:00'):
            with self.subTest(timestamp=timestamp):
                raw = relay.canonical({'issued_at': timestamp, 'expires_at': timestamp})
                self.assertEqual(relay.strict(raw), {'issued_at': timestamp, 'expires_at': timestamp})
        for conversion in ('[datetime]', '[DateTime]', 'ToLocalTime', 'ToUniversalTime'):
            self.assertNotIn(conversion, source)

    def test_pin_and_malformed_transport_close(self):
        pin = self.inbox()
        with self.assertRaises(ValueError):
            self.consume(pin='0'*64)
        self.closed()
        for raw in (b'{', b'{"a":1,"a":2}', b'[]', b'NaN', b'x'*(relay.MAX+1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                relay.strict(raw)

    def test_missing_transport_is_spent_and_cleanup_idempotent(self):
        with self.assertRaises(FileNotFoundError):
            self.consume(pin='0'*64)
        self.closed()
        relay.cleanup(self.control)
        relay.cleanup(self.control)
        with self.assertRaises(FileExistsError):
            self.consume(pin='0'*64)

    def test_truncation_bad_nonce_and_envelope_digest(self):
        self.e['ciphertext'] = base64.b64encode(b'truncated').decode()
        with self.assertRaises(Exception):
            self.consume()
        self.closed()
        self.assertFalse(self.dest.exists())

    def test_paths_symlink_hardlink_and_exclusive(self):
        safe = self.control/'safe'
        relay.write(safe, b'safe')
        with self.assertRaises(FileExistsError):
            relay.write(safe, b'overwrite')
        link = self.control/'link'
        link.symlink_to(safe)
        with self.assertRaises(Exception):
            relay.read(link)
        link.unlink()
        os.link(safe, link)
        with self.assertRaises(ValueError):
            relay.read(safe)
        link.unlink()
        relay.cleanup(self.control)
        self.assertEqual(relay.read(safe), b'safe')

    def fake_mint(self, response=None, status=200):
        calls = []
        def runner(args, **kw):
            self.assertNotIn(DUMMY, str(args)+str(kw['env']))
            self.assertTrue(kw['shell'] is False)
            calls.append(args)
            if 'print-access-token' in args:
                self.assertIn('--account=synthetic@example.test', args)
                self.assertIn('--impersonate-service-account=', args)
                return types.SimpleNamespace(returncode=0, stdout=b'SYNTHETIC-OWNER\n', stderr=b'')
            value = relay.strict(kw['input'])
            return types.SimpleNamespace(returncode=0, stdout=relay.canonical(encrypted(value['request'], value['payload'])), stderr=b'')
        posts = []
        def post(target, bearer):
            posts.append((target, bearer))
            return status, response if response is not None else relay.canonical({'accessToken': DUMMY, 'expireTime': self.value['expires_at']})
        with mock.patch.object(controller, 'executable', side_effect=lambda p: str(p)):
            result = controller.mint(relay.canonical(self.r), relay.digest(relay.canonical(self.r)), self.a,
                                     sdk='/synthetic/sdk', account='synthetic@example.test', config=str(self.base),
                                     pwsh='/synthetic/pwsh', runner=runner, http_post=post, clock=lambda: NOW)
        return result, calls, posts

    def test_fake_sdk_http_one_mint_only_ciphertext_output(self):
        (e, metadata), calls, posts = self.fake_mint()
        self.assertEqual(len(posts), 1)
        self.assertEqual(len(calls), 2)
        self.assertNotIn(DUMMY, relay.canonical([e, metadata]).decode())
        self.e = e
        self.consume()

    def test_official_fractional_expiry_floor_and_fake_http(self):
        for fraction in ('', '.123', '.123456', '.123456789'):
            with self.subTest(fraction=fraction):
                self.assertEqual(relay.instant('2026-10-29T03:00:00'+fraction+'Z'),
                                 NOW+dt.timedelta(hours=1))
                response = relay.canonical({'accessToken': DUMMY,
                                            'expireTime': '2026-10-29T02:14:59'+fraction+'Z'})
                (envelope, metadata), calls, posts = self.fake_mint(response)
                self.assertEqual(len(posts), 1)
                self.assertEqual(len(calls), 2)
                self.assertEqual(metadata['expires_at'], '2026-10-29T02:14:59Z')
        self.e = envelope
        self.consume()
        value = relay.strict(relay.read(self.dest, 0o640, 987))
        self.assertEqual(value['issued_at'], '2026-10-29T01:59:59Z')
        self.assertEqual(value['expires_at'], '2026-10-29T02:14:59Z')
        self.assertEqual(relay.instant(value['expires_at'])-relay.instant(value['issued_at']),
                         dt.timedelta(seconds=900))
        bad = (None, 123, float('inf'), float('nan'), 'Infinity', 'NaN',
               '2026-10-29T02:15:00+00:00', '2026-10-29T02:15:00-03:00',
               '2026-10-29T02:15:00', '2026-10-29T02:15:00z',
               '2026-10-29T02:15:00.Z', '2026-10-29T02:15:00.1Z',
               '2026-10-29T02:15:00.1234Z', '2026-10-29T02:15:00.1234567890Z',
               '2026-02-30T02:15:00.123Z', '2026-10-29T24:15:00Z',
               '2026-10-29T02:15:60Z', '2026-10-29T02:15:00.１２３Z',
               '2026-10-29T02:15:00Z\n')
        for expiry in bad:
            with self.subTest(expiry=expiry):
                with self.assertRaises(relay.Rejected):
                    relay.instant(expiry)
                with self.assertRaises(relay.Rejected):
                    self.fake_mint(relay.canonical({'accessToken': DUMMY, 'expireTime': expiry}))
        for expiry in ('2026-10-29T02:02:29.999999999Z', '2026-10-29T02:15:31.123Z'):
            with self.subTest(expiry=expiry), self.assertRaises(relay.Rejected):
                self.fake_mint(relay.canonical({'accessToken': DUMMY, 'expireTime': expiry}))

    def test_write_exact_fd_modes_under_private_umask(self):
        previous = os.umask(0o077)
        try:
            for target, mode, gid in ((self.control/'private-mode', 0o600, 0),
                                      (self.dest, 0o640, 987)):
                with self.subTest(mode=oct(mode)):
                    info = relay.write(target, b'synthetic-mode-fixture', mode, gid)
                    self.assertEqual(stat.S_IMODE(info.st_mode), mode)
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)
                    self.assertEqual(relay.read(target, mode, gid), b'synthetic-mode-fixture')
                    with self.assertRaises(FileExistsError):
                        relay.write(target, b'overwrite', mode, gid)
            self.assertEqual(os.umask(0o077), 0o077)
        finally:
            os.umask(previous)

    def test_fake_http_failures_no_retry_and_strict_expiry(self):
        for status, response in [(302, b'{}'), (500, b'{}'), (200, b'{"accessToken":"x","accessToken":"y"}'),
                                 (200, relay.canonical({'accessToken': DUMMY, 'expireTime': '2026-10-29T02:15:31Z'})),
                                 (200, relay.canonical({'accessToken': 'bad token', 'expireTime': self.value['expires_at']}))]:
            with self.subTest(status=status, response=response), self.assertRaises(ValueError):
                self.fake_mint(response, status)

    def test_real_http_implementation_fixed_endpoint_one_post(self):
        connection = mock.Mock()
        response = connection.getresponse.return_value
        response.status = 503
        response.read.return_value = b'{}'
        with mock.patch.object(controller.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            self.assertEqual(controller.post_once(self.a['target_service_account'], 'SYNTHETIC'), (503, b'{}'))
        constructor.assert_called_once_with('iamcredentials.googleapis.com', timeout=20)
        connection.request.assert_called_once()
        args, kw = connection.request.call_args
        self.assertEqual(args, ('POST', '/v1/projects/-/serviceAccounts/'+self.a['target_service_account']+':generateAccessToken'))
        self.assertEqual(kw['body'], controller.BODY)
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
