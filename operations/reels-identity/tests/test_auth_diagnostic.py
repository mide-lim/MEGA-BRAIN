"""Synthetic identity diagnostic tests. No SDK auth, ADC or Google requests."""
from contextlib import redirect_stdout
import datetime as dt
import io
import json
import os
from pathlib import Path
import signal
import ssl
import tempfile
import time
import unittest
from unittest.mock import patch
import sys

MODULE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE))
import auth_diagnostic as d

FAKE_TOKEN = "SYNTHETIC_TOKEN_NOT_REAL"

class FakeAuthenticator:
    def __init__(self, error=None, expiry=None):
        self.calls = 0
        self.error = error
        self.expiry = expiry or (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5))
    def acquire(self, config):
        self.calls += 1
        if self.error:
            raise self.error
        return d._TokenBundle(FAKE_TOKEN, d.CREDENTIAL_CLASS, self.expiry)

class FakeTransport:
    def __init__(self, status=200, error=None):
        self.calls = 0
        self.status = status
        self.error = error
    def get(self, token, quota_project):
        self.calls += 1
        if self.error:
            raise self.error
        return self.status

class FakeResponse:
    def __init__(self, status=200, body=None, content_type="application/json"):
        self.status = status
        self.body = body if body is not None else b'{"name":"publishers/google/models/gemini-3.8-flash"}'
        self.content_type = content_type
        self.read_limits = []
    def read(self, limit):
        self.read_limits.append(limit)
        return self.body
    def getheader(self, name, default=""):
        return self.content_type if name.lower() == "content-type" else default

class FakeConnection:
    def __init__(self, response=None):
        self.response = response or FakeResponse()
        self.requests = []
        self.closed = False
    def request(self, method, path, **kwargs):
        self.requests.append((method,path,kwargs))
    def getresponse(self):
        return self.response
    def close(self):
        self.closed = True

class IdentityDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.project = "synthetic-project"
        self.target = "identity-worker@" + self.project + ".iam.gserviceaccount.com"
        self.config = d.OperatorIdentityConfig(self.project,self.target,Path("/synthetic/adc-fixture.json"))

    def test_task_json_and_authorized_flags_are_not_authority(self):
        auth,transport = FakeAuthenticator(),FakeTransport()
        report=d.IdentityDiagnostic(auth,transport).run({"authorized":True,"budget":999})
        self.assertEqual(report["status"]["code"],"operator_config_rejected")
        self.assertEqual((auth.calls,transport.calls),(0,0))
        self.assertEqual(d.INFERENCE_BUDGET,0)
        self.assertFalse(d.PREDICT_AUTHORIZED)

    def test_success_safe_fields_only_and_no_token_repr(self):
        auth,transport=FakeAuthenticator(),FakeTransport()
        report=d.IdentityDiagnostic(auth,transport).run(self.config)
        self.assertEqual(set(report),{"credential_class","target","quota_project","expiry","status"})
        self.assertEqual(report["status"],{"code":"identity_metadata_verified","http_status":200})
        self.assertEqual(report["target"],self.target)
        self.assertNotIn(FAKE_TOKEN,json.dumps(report))
        self.assertNotIn(FAKE_TOKEN,repr(d._TokenBundle(FAKE_TOKEN,d.CREDENTIAL_CLASS,auth.expiry)))
        self.assertEqual((auth.calls,transport.calls),(1,1))

    def test_auth_error_and_duplicate_do_not_retry_or_leak(self):
        secret="SENSITIVE_SYNTHETIC_ERROR_NOT_REAL"
        auth,transport=FakeAuthenticator(error=RuntimeError(secret)),FakeTransport()
        diagnostic=d.IdentityDiagnostic(auth,transport)
        first=diagnostic.run(self.config);second=diagnostic.run(self.config)
        self.assertEqual(first["status"]["code"],"authentication_failed")
        self.assertEqual(second["status"]["code"],"identity_attempt_already_consumed")
        self.assertEqual((auth.calls,transport.calls),(1,0))
        self.assertNotIn(secret,json.dumps([first,second]))

    def test_metadata_errors_401_403_404_429_redirect_stop_once(self):
        for status in (401,403,404,429,500,302):
            auth,transport=FakeAuthenticator(),FakeTransport(status)
            diagnostic=d.IdentityDiagnostic(auth,transport)
            first=diagnostic.run(self.config);diagnostic.run(self.config)
            self.assertEqual(first["status"],{"code":"metadata_http_rejected","http_status":status})
            self.assertEqual((auth.calls,transport.calls),(1,1))

    def test_transport_timeout_stops_and_hides_exception(self):
        auth,transport=FakeAuthenticator(),FakeTransport(error=TimeoutError(FAKE_TOKEN))
        diagnostic=d.IdentityDiagnostic(auth,transport)
        report=diagnostic.run(self.config);diagnostic.run(self.config)
        self.assertEqual(report["status"]["code"],"metadata_request_failed")
        self.assertNotIn(FAKE_TOKEN,json.dumps(report))
        self.assertEqual((auth.calls,transport.calls),(1,1))

    def test_expired_or_bad_bundle_never_gets(self):
        transport=FakeTransport()
        expired=FakeAuthenticator(expiry=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=1))
        report=d.IdentityDiagnostic(expired,transport).run(self.config)
        self.assertEqual(report["status"]["code"],"authentication_metadata_unusable")
        self.assertEqual(transport.calls,0)
        auth=FakeAuthenticator()
        with patch.object(auth,"acquire",return_value=d._TokenBundle(FAKE_TOKEN,"unknown-class",auth.expiry)):
            report=d.IdentityDiagnostic(auth,transport).run(self.config)
        self.assertEqual(report["status"]["code"],"authentication_metadata_unusable")
        self.assertEqual(transport.calls,0)

    def test_fixed_get_url_timeout_limit_headers_tls_and_no_retry(self):
        response=FakeResponse()
        connection=FakeConnection(response)
        calls=[]
        def factory(host,**kwargs):
            calls.append((host,kwargs))
            return connection
        transport=d.SingleCatalogGet(factory)
        self.assertEqual(transport.get(FAKE_TOKEN,self.project),200)
        with self.assertRaises(d.AuthFailure):
            transport.get(FAKE_TOKEN,self.project)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][0],"aiplatform.googleapis.com")
        self.assertEqual(calls[0][1]["timeout"],30)
        self.assertEqual(calls[0][1]["context"].verify_mode,ssl.CERT_REQUIRED)
        self.assertEqual(connection.requests[0][0],"GET")
        self.assertEqual(connection.requests[0][1],
                         "/v1/publishers/google/models/gemini-3.8-flash?view=PUBLISHER_MODEL_VIEW_BASIC")
        self.assertEqual(d.CATALOG_URL,"https://aiplatform.googleapis.com"+connection.requests[0][1])
        self.assertEqual(response.read_limits,[1_000_001])
        self.assertTrue(connection.closed)

    def test_actual_transport_non_200_never_follows_redirect_or_refreshes(self):
        for status in (401,403,404,429,302):
            connection=FakeConnection(FakeResponse(status,b"synthetic error","text/plain"))
            transport=d.SingleCatalogGet(lambda *a,**k:connection)
            self.assertEqual(transport.get(FAKE_TOKEN,self.project),status)
            self.assertEqual(len(connection.requests),1)
            self.assertTrue(connection.closed)

    def test_unexpected_200_content_type_json_name_are_rejected(self):
        for response in (FakeResponse(body=b"<html>unexpected</html>",content_type="text/html"),
                         FakeResponse(body=b"not-json"),
                         FakeResponse(body=b'{"name":"different"}'),
                         FakeResponse(body=b'{"name":"publishers/google/models/gemini-3.8-flash","name":"duplicate"}'),
                         FakeResponse(body=b"[]")):
            connection=FakeConnection(response)
            transport=d.SingleCatalogGet(lambda *a,**k:connection)
            report=d.IdentityDiagnostic(FakeAuthenticator(),transport).run(self.config)
            self.assertEqual(report["status"],{"code":"metadata_response_unexpected","http_status":200})
            self.assertTrue(connection.closed)

    def test_response_body_over_limit_rejected_without_body_log(self):
        connection=FakeConnection(FakeResponse(body=b"x"*1_000_001))
        transport=d.SingleCatalogGet(lambda *a,**k:connection)
        report=d.IdentityDiagnostic(FakeAuthenticator(),transport).run(self.config)
        self.assertEqual(report["status"],{"code":"metadata_response_too_large","http_status":200})
        self.assertTrue(connection.closed)

    def test_global_deadline_interrupts_slow_body_and_restores_signal(self):
        class SlowResponse(FakeResponse):
            def read(self,limit):
                time.sleep(0.2)
                return self.body
        original=signal.getsignal(signal.SIGALRM)
        connection=FakeConnection(SlowResponse())
        with patch.object(d,"TIMEOUT_SECONDS",0.03), patch.object(d.ssl,"create_default_context",return_value=object()):
            start=time.monotonic()
            report=d.IdentityDiagnostic(FakeAuthenticator(),
                d.SingleCatalogGet(lambda *a,**k:connection)).run(self.config)
        self.assertLess(time.monotonic()-start,1.0)
        self.assertEqual(report["status"]["code"],"metadata_request_failed")
        self.assertEqual(signal.getsignal(signal.SIGALRM),original)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
        self.assertTrue(connection.closed)

    def test_header_injection_rejected_before_connection(self):
        for token,project in ((FAKE_TOKEN+chr(13)+chr(10)+"Injected: x",self.project),
                              (FAKE_TOKEN,"bad"+chr(13)+chr(10)+"project")):
            with self.assertRaises(d.AuthFailure):
                d.SingleCatalogGet(lambda *a,**k:self.fail("no connection")).get(token,project)

    def test_operator_config_permissions_shape_owner_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/"operator-fixture.json"
            value={"project_id":self.project,"target_service_account":self.target,
                   "adc_path":"/synthetic/adc-fixture.json"}
            path.write_text(json.dumps(value));path.chmod(0o600)
            config=d.OperatorIdentityConfig.from_operator_file(path,expected_uid=os.getuid(),expected_gid=os.getgid())
            self.assertEqual(config.project_id,self.project)
            path.chmod(0o644)
            with self.assertRaises(d.AuthFailure):
                d.OperatorIdentityConfig.from_operator_file(path,expected_uid=os.getuid(),expected_gid=os.getgid())
            path.chmod(0o600);value["authorized"]=True;path.write_text(json.dumps(value))
            with self.assertRaises(d.AuthFailure):
                d.OperatorIdentityConfig.from_operator_file(path,expected_uid=os.getuid(),expected_gid=os.getgid())
            link=Path(temporary)/"link.json";link.symlink_to(path)
            with self.assertRaises(d.AuthFailure):
                d.OperatorIdentityConfig.from_operator_file(link,expected_uid=os.getuid(),expected_gid=os.getgid())
            with self.assertRaises(d.AuthFailure):
                d.OperatorIdentityConfig.from_operator_file(path,expected_uid=os.getuid()+1,expected_gid=os.getgid())

    def test_main_invalid_args_and_wrong_uid_do_not_echo_or_trace(self):
        output=io.StringIO()
        with patch.object(d.os,"geteuid",return_value=999),patch.object(d.os,"getegid",return_value=987),redirect_stdout(output):
            self.assertEqual(d.main(["--token",FAKE_TOKEN]),1)
        self.assertNotIn(FAKE_TOKEN,output.getvalue())
        self.assertNotIn("Traceback",output.getvalue())
        output=io.StringIO()
        with patch.object(d.os,"geteuid",return_value=0),redirect_stdout(output):
            self.assertEqual(d.main(["--operator-config","/synthetic/operator.json"]),1)
        self.assertEqual(json.loads(output.getvalue())["status"]["code"],"operational_user_required")

    def test_google_auth_is_lazy_proxy_env_disabled_and_no_inference_entrypoint(self):
        import ast
        source=(MODULE/"auth_diagnostic.py").read_text();tree=ast.parse(source)
        for node in tree.body:
            if isinstance(node,(ast.Import,ast.ImportFrom)):
                self.assertNotIn("google.auth",ast.get_source_segment(source,node))
        self.assertIn("session.trust_env = False",source)
        self.assertIn("HTTPAdapter(max_retries=0)",source)
        self.assertNotIn("generateContent",source)
        self.assertNotIn("countTokens",source)

if __name__ == "__main__":
    unittest.main()
