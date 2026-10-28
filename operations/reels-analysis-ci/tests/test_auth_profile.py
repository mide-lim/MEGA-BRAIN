"""Synthetic loader/type/request stubs only; no Google package or network."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

CI = Path(__file__).resolve().parents[1]
LIVE = CI.parent / "reels-analysis-live"
sys.path.insert(0, str(LIVE))
from cloud_adapter import (AuthFailure, BoundedAuthRequest, GoogleOfficialTokenSource,
                           OAUTH_TOKEN_URL, CLOUD_SCOPE)
import worker

class FakeHuman:
    _token_uri = OAUTH_TOKEN_URL
    _refresh_handler = None
    universe_domain = "googleapis.com"

class FakeImpersonated:
    def __init__(self, target, project, target_url):
        self.signer_email = target
        self.quota_project_id = project
        self.universe_domain = "googleapis.com"
        self._source_credentials = FakeHuman()
        self._delegates = None
        self._iam_endpoint_override = None
        self._target_scopes = [CLOUD_SCOPE]
        self._lifetime = 3600
        self.target_url = target_url
        self.token = None
    def refresh(self, request):
        request(OAUTH_TOKEN_URL, method="POST", body=b"synthetic-refresh")
        request(self.target_url, method="POST", body=b"synthetic-iam")
        self.token = "SYNTHETIC_ACCESS_TOKEN_NOT_REAL"

class AuthProfileTests(unittest.TestCase):
    def setUp(self):
        self.project = "synthetic-project"
        self.target = "analysis-worker@" + self.project + ".iam.gserviceaccount.com"
        self.source = GoogleOfficialTokenSource(self.target, self.project, "/synthetic/adc-fixture.json")
        self.profile = {"type":"impersonated_service_account",
                        "service_account_impersonation_url":self.source.target_url,
                        "quota_project_id":self.project,
                        "source_credentials":{"type":"authorized_user",
                            "client_id":"SYNTHETIC_CLIENT", "client_secret":"SYNTHETIC_CLIENT_SECRET",
                            "refresh_token":"SYNTHETIC_REFRESH_TOKEN_NOT_REAL"}}
        self.calls = []
        self.credentials = FakeImpersonated(self.target, self.project, self.source.target_url)
    def delegate(self, **kwargs):
        self.calls.append(kwargs)
        self.assertFalse(kwargs["allow_redirects"])
        return SimpleNamespace(status=200, data=b'{"synthetic":true}')
    def loader(self, profile, **kwargs):
        self.assertIs(profile, self.profile)
        self.assertEqual(kwargs["quota_project_id"], self.project)
        self.assertEqual(kwargs["scopes"], [CLOUD_SCOPE])
        return self.credentials, None
    def refresh(self, loader=None):
        return self.source.refresh_validated_profile(
            self.profile, loader or self.loader, FakeImpersonated, FakeHuman, self.delegate)

    def test_two_bounded_auth_stages_return_fake_token_without_printing(self):
        token = self.refresh()
        self.assertEqual(token, "SYNTHETIC_ACCESS_TOKEN_NOT_REAL")
        self.assertEqual([row["url"] for row in self.calls], [OAUTH_TOKEN_URL,self.source.target_url])

    def test_direct_unknown_and_target_mismatch_rejected_before_http(self):
        for credentials in (FakeHuman(), object()):
            self.credentials = credentials
            with self.assertRaises(AuthFailure):
                self.refresh()
            self.assertEqual(self.calls, [])
        self.credentials = FakeImpersonated(self.target, self.project, self.source.target_url)
        self.credentials.signer_email = "different-target"
        with self.assertRaises(AuthFailure):
            self.refresh()
        self.assertEqual(self.calls, [])

    def test_profile_rejects_unknown_external_key_and_target_before_loader(self):
        original = copy.deepcopy(self.profile)
        for mutate in (
            lambda p:p.update(type="service_account"),
            lambda p:p.update(type="external_account",credential_source={"executable":{"command":"not-run"}}),
            lambda p:p["source_credentials"].update(type="service_account"),
            lambda p:p.update(service_account_impersonation_url="https://invalid.example/token"),
            lambda p:p.update(delegates=["not-approved"]),
            lambda p:p["source_credentials"].update(token_uri="https://invalid.example/token")):
            self.profile = copy.deepcopy(original)
            mutate(self.profile)
            with self.assertRaises(AuthFailure):
                self.refresh(loader=lambda *a,**k:self.fail("unsafe profile reached official loader stub"))
            self.assertEqual(self.calls, [])

    def test_loader_cannot_make_http_before_runtime_type_checks(self):
        def premature(profile, **kwargs):
            kwargs["request"](OAUTH_TOKEN_URL,method="POST")
            self.fail("pre-validation request accepted")
        with self.assertRaises(AuthFailure):
            self.refresh(loader=premature)
        self.assertEqual(self.calls, [])

    def test_runtime_source_delegate_endpoint_scope_and_lifetime_must_match(self):
        for field, value in (("_source_credentials",object()),("_delegates",["not-approved"]),
                             ("_iam_endpoint_override","https://invalid.example"),
                             ("_target_scopes",["unexpected"]),("_lifetime",3601)):
            self.credentials = FakeImpersonated(self.target, self.project, self.source.target_url)
            setattr(self.credentials,field,value)
            with self.assertRaises(AuthFailure):
                self.refresh()
            self.assertEqual(self.calls, [])
        self.credentials = FakeImpersonated(self.target, self.project, self.source.target_url)
        self.credentials._source_credentials._refresh_handler = lambda request: None
        with self.assertRaises(AuthFailure):
            self.refresh()
        self.assertEqual(self.calls, [])

    def test_request_gate_rejects_duplicates_unknown_ports_methods_and_order(self):
        request = BoundedAuthRequest(self.delegate,self.source.target_url)
        request.enable_after_profile_validation()
        request(OAUTH_TOKEN_URL,method="POST")
        request(self.source.target_url,method="POST")
        for url in (OAUTH_TOKEN_URL,self.source.target_url):
            with self.assertRaises(AuthFailure):
                request(url,method="POST")
        self.assertEqual(len(self.calls),2)
        for url,method in (("http://oauth2.googleapis.com/token","POST"),
                           ("https://oauth2.googleapis.com:443/token","POST"),
                           ("https://oauth2.googleapis.com/token?extra=1","POST"),
                           ("https://sts.googleapis.com/v1/token","POST"),
                           ("http://metadata.google.internal/","GET"),
                           (OAUTH_TOKEN_URL,"GET")):
            denied = BoundedAuthRequest(lambda **k:self.fail("denied endpoint reached HTTP"),self.source.target_url)
            denied.enable_after_profile_validation()
            with self.assertRaises(AuthFailure):
                denied(url,method=method)

    def test_cached_human_token_allows_iam_only_and_no_later_oauth(self):
        request = BoundedAuthRequest(self.delegate,self.source.target_url)
        request.enable_after_profile_validation()
        request(self.source.target_url,method="POST")
        with self.assertRaises(AuthFailure):
            request(OAUTH_TOKEN_URL,method="POST")
        self.assertEqual(len(self.calls),1)

    def test_failed_auth_endpoint_cannot_be_retried(self):
        calls=[]
        def failed(**kwargs):
            calls.append(kwargs)
            raise OSError("synthetic network failure")
        request=BoundedAuthRequest(failed,self.source.target_url)
        request.enable_after_profile_validation()
        with self.assertRaises(OSError):
            request(OAUTH_TOKEN_URL,method="POST")
        with self.assertRaises(AuthFailure):
            request(OAUTH_TOKEN_URL,method="POST")
        self.assertEqual(len(calls),1)

    def test_task_project_checked_before_media_and_token(self):
        task=json.loads((LIVE/"examples/stored-video.preparation.json").read_text())
        grant=SimpleNamespace(approved_project="different-project")
        with patch.object(worker.authorization,"require_live_grant",return_value=grant), \
             patch.object(worker,"StoredMediaReader",side_effect=AssertionError("no media")), \
             patch.object(worker,"GoogleOfficialTokenSource",side_effect=AssertionError("no token")):
            with self.assertRaises(AuthFailure):
                worker.execute_live(task,executor_id="simulation/integration-test")


    def test_grant_target_checked_before_media_and_token(self):
        task=json.loads((LIVE/"examples/stored-video.preparation.json").read_text())
        grant=SimpleNamespace(approved_project=task["cloud"]["project_id"],
                              approved_service_account="invalid-target",
                              approved_adc_path="/synthetic/adc-fixture.json")
        with patch.object(worker.authorization,"require_live_grant",return_value=grant), \
             patch.object(worker,"StoredMediaReader",side_effect=AssertionError("no media")), \
             patch.object(worker.GoogleOfficialTokenSource,"token",side_effect=AssertionError("no token")):
            with self.assertRaises(AuthFailure):
                worker.execute_live(task,executor_id="simulation/integration-test")


if __name__ == "__main__":
    unittest.main()
