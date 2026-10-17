"""Synthetic contract tests. Execute only in GitHub Actions."""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("runtime_iam", Path(__file__).with_name("inspect-reels-runtime-iam.py"))
iam = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(iam)
NOW = dt.datetime(2026, 10, 17, 5, 0, tzinfo=dt.timezone.utc)


class RuntimeIamTests(unittest.TestCase):
    def setUp(self):
        self.requests = iam.matrix("gemini-2.5-flash", "us")
        self.capture = dict(project=iam.PROJECT, source=iam.SOURCE, checks=[
            dict(id=r["id"], observedAt=NOW.isoformat(), httpStatus=200,
                 response=dict(overallAccessState="CAN_ACCESS", accessTuple=dict(r["accessTuple"])))
            for r in self.requests])

    def result(self):
        return iam.evaluate(self.requests, self.capture, now=NOW)

    def assertBlocked(self):
        result = self.result()
        self.assertFalse(result["ready"])
        self.assertFalse(result["effectivePermissionsObserved"])
        self.assertFalse(result["activationAllowed"])

    def test_complete_exact_fresh_synthetic_fixture(self):
        result = self.result()
        self.assertTrue(result["ready"])
        self.assertTrue(result["effectivePermissionsObserved"])
        self.assertFalse(result["processingAuthorized"])
        self.assertEqual(len(result["checks"]), 39)

    def test_fixed_matrix_covers_full_payload_recovery_and_actas(self):
        tuples = [r["accessTuple"] for r in self.requests]
        for identity in ("v0-web", "v0-worker"):
            own = [t for t in tuples if t["principal"].startswith(identity + "@")]
            for permission in ("cloudtasks.tasks.create", "cloudtasks.tasks.get", "cloudtasks.tasks.fullView"):
                self.assertEqual(len([t for t in own if t["permission"] == permission]), 3)
            self.assertEqual(len([t for t in own if t["permission"] == "iam.serviceAccounts.actAs"]), 1)
        self.assertEqual(len([t for t in tuples if t["permission"] == "run.routes.invoke"]), 3)
        self.assertFalse(any(any(p in t["permission"].lower() for p in ("delete", "getaccesstoken", "setiam")) for t in tuples))

    def test_managed_service_agents_are_required_without_grants(self):
        tuples = [r["accessTuple"] for r in self.requests]
        speech = [t for t in tuples if t["principal"] == "service-711042421394@gcp-sa-speech.iam.gserviceaccount.com"]
        tasks = [t for t in tuples if t["principal"] == "service-711042421394@gcp-sa-cloudtasks.iam.gserviceaccount.com"]
        self.assertEqual([t["permission"] for t in speech], ["storage.objects.get"])
        self.assertTrue(speech[0]["fullResourceName"].endswith("/buckets/" + iam.PROJECT + "-media"))
        self.assertEqual([t["permission"] for t in tasks], ["iam.serviceAccounts.getOpenIdToken"])
        self.assertTrue(tasks[0]["fullResourceName"].endswith("/serviceAccounts/v0-queue@" + iam.PROJECT + ".iam.gserviceaccount.com"))
        self.capture["checks"].pop()
        self.assertBlocked()

    def test_missing_and_http_error_do_not_grant(self):
        self.capture["checks"].pop()
        self.assertBlocked()
        self.capture["checks"][0]["httpStatus"] = 403
        self.assertBlocked()

    def test_allow_only_and_denied_are_not_effective_access(self):
        first = self.capture["checks"][0]["response"]
        first["overallAccessState"] = "CANNOT_ACCESS"
        first["allowPolicyExplanation"] = {"allowAccessState": "ALLOW_ACCESS_STATE_GRANTED"}
        self.assertBlocked()
        self.assertEqual(self.result()["checks"][0]["access"], "denied")
        first.pop("overallAccessState")
        self.assertBlocked()

    def test_real_v3_denial_is_denied_not_unknown(self):
        first = self.capture["checks"][0]["response"]
        first["overallAccessState"] = "CANNOT_ACCESS"
        first["allowPolicyExplanation"] = {"allowAccessState":"ALLOW_ACCESS_STATE_NOT_GRANTED"}
        for deny in ({"denyAccessState":"DENY_ACCESS_STATE_DENIED"},
                     {"denyAccessState":"DENY_ACCESS_STATE_UNKNOWN_INFO", "permissionDeniable":False},
                     {"denyAccessState":"DENY_ACCESS_STATE_NOT_DENIED"}):
            first["denyPolicyExplanation"] = deny
            self.assertEqual(self.result()["checks"][0]["access"], "denied")
            self.assertBlocked()
        first["errors"] = [{"code":7}]
        self.assertEqual(self.result()["checks"][0]["access"], "unknown")
        self.assertBlocked()

    def test_all_unknown_states_and_malformed_responses_fail_closed(self):
        for state in ("UNKNOWN", "OVERALL_ACCESS_STATE_UNSPECIFIED", None, True, 1):
            self.capture["checks"][0]["response"]["overallAccessState"] = state
            self.assertBlocked()
        self.capture["checks"][0]["response"] = []
        self.assertBlocked()

    def test_tuple_misbinding_is_not_a_runtime_proof(self):
        for field in ("principal", "fullResourceName", "permission"):
            original = self.capture["checks"][0]["response"]["accessTuple"][field]
            self.capture["checks"][0]["response"]["accessTuple"][field] = "wrong"
            self.assertBlocked()
            self.capture["checks"][0]["response"]["accessTuple"][field] = original

    def test_only_documented_output_permission_fqdn_is_ignored(self):
        self.capture["checks"][0]["response"]["accessTuple"]["permissionFqdn"] = "cloudtasks.googleapis.com/tasks.create"
        self.assertTrue(self.result()["ready"])
        self.capture["checks"][0]["response"]["accessTuple"]["principalOverride"] = "owner"
        self.assertBlocked()

    def test_actual_v3_empty_condition_context_is_normalized_only_when_empty(self):
        first = self.capture["checks"][0]["response"]["accessTuple"]
        first["permissionFqdn"] = "cloudtasks.googleapis.com/tasks.create"
        first["conditionContext"] = {}
        self.assertTrue(self.result()["ready"])
        for context in ({"request":{"receiveTime":NOW.isoformat()}}, None, [], ""):
            first["conditionContext"] = context
            self.assertBlocked()

    def test_firestore_is_explicit_project_policy_not_database_proof(self):
        rows = [r for r in self.requests if r["accessTuple"]["permission"].startswith("datastore.")]
        self.assertEqual(len(rows), 8)
        for row in rows:
            self.assertEqual(row["scope"], "project-policy")
            self.assertEqual(row["accessTuple"]["fullResourceName"],
                             "//cloudresourcemanager.googleapis.com/projects/" + iam.PROJECT)

    def test_future_stale_and_timezone_free_timestamps_fail(self):
        for observed in ((NOW + dt.timedelta(seconds=1)).isoformat(),
                         (NOW - dt.timedelta(seconds=901)).isoformat(),
                         "2026-10-17T05:00:00", None, 12):
            self.capture["checks"][0]["observedAt"] = observed
            self.assertBlocked()

    def test_duplicate_unknown_id_and_wrong_envelope_fail(self):
        self.capture["checks"].append(copy.deepcopy(self.capture["checks"][0]))
        self.assertBlocked()
        self.capture["checks"][-1]["id"] = "unknown"
        self.assertBlocked()
        self.capture["checks"].pop()
        self.capture["source"] = "roles-present"
        self.assertBlocked()

    def test_nested_deny_pab_errors_or_unknown_never_hidden(self):
        for field in ("denyPolicyExplanation", "pabPolicyExplanation", "allowPolicyExplanation"):
            for detail in ({"denyAccessState": "DENY_ACCESS_STATE_UNKNOWN"},
                           {"denyAccessState": "DENY_ACCESS_STATE_DENIED"},
                           {"errors": [{"code": 7}]}):
                self.capture["checks"][0]["response"][field] = detail
                self.assertBlocked()
            self.capture["checks"][0]["response"].pop(field)

    def test_unsupported_deny_can_access_is_explicit_narrow_exception(self):
        first = self.capture["checks"][0]["response"]
        first["denyPolicyExplanation"] = {"denyAccessState":"DENY_ACCESS_STATE_UNKNOWN_INFO",
                                         "permissionDeniable":False}
        self.assertTrue(self.result()["ready"])
        first["denyPolicyExplanation"].pop("permissionDeniable")
        self.assertBlocked()
        first["denyPolicyExplanation"]["permissionDeniable"] = False
        first["overallAccessState"] = "CANNOT_ACCESS"
        self.assertBlocked()
        first["overallAccessState"] = "UNKNOWN_INFO"
        self.assertBlocked()
        first["overallAccessState"] = "CAN_ACCESS"
        first["denyPolicyExplanation"]["permissionDeniable"] = True
        self.assertBlocked()
        first["denyPolicyExplanation"]["permissionDeniable"] = "false"
        self.assertBlocked()
        first["denyPolicyExplanation"] = {"permissionDeniable":False, "denyAccessState":"DENY_ACCESS_STATE_DENIED"}
        self.assertBlocked()
        first["denyPolicyExplanation"] = {"permissionDeniable":False, "errors":[{"code":7}]}
        self.assertBlocked()

    def test_secondary_unknown_binding_does_not_override_definitive_summary(self):
        first = self.capture["checks"][0]["response"]
        first["allowPolicyExplanation"] = {
            "allowAccessState":"ALLOW_ACCESS_STATE_GRANTED",
            "explainedPolicies":[{"bindingExplanations":[
                {"allowAccessState":"ALLOW_ACCESS_STATE_UNKNOWN_CONDITIONAL"}]}]}
        self.assertTrue(self.result()["ready"])
        first["errors"] = [{"code":7}]
        self.assertBlocked()
        first.pop("errors")
        first["allowPolicyExplanation"]["allowAccessState"] = "ALLOW_ACCESS_STATE_UNKNOWN_INFO"
        self.assertBlocked()

    def test_argument_injection_is_rejected(self):
        for model, region in (("gemini-x:generateContent", "us"), ("https://evil", "us"),
                              ("gemini-valid", "us-central1"), (None, "us")):
            with self.assertRaises(ValueError):
                iam.matrix(model, region)

    def test_capture_only_diagnostic_endpoint_no_workload_or_credentials(self):
        class Response:
            status_code = 200
            def json(self):
                return dict(overallAccessState="CAN_ACCESS", accessTuple=first["accessTuple"],
                            secret="must not survive", policy={"bindings": ["unrelated"]})
        class Session:
            calls = []
            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return Response()
        first = self.requests[0]
        session = Session()
        captured = iam.capture_requests([first], session, clock=lambda: NOW)
        self.assertEqual(len(session.calls), 1)
        url, options = session.calls[0]
        self.assertEqual(url, iam.ENDPOINT)
        self.assertEqual(options, dict(json={"accessTuple": first["accessTuple"]}, timeout=30))
        self.assertEqual(captured["checks"][0]["response"],
                         dict(overallAccessState="CAN_ACCESS", accessTuple=first["accessTuple"]))

    def test_capture_redacts_policies_but_preserves_diagnostic_failure(self):
        requested = self.requests[0]
        class Response:
            status_code = 200
            def json(self):
                return dict(overallAccessState="CAN_ACCESS", accessTuple=requested["accessTuple"],
                            denyPolicyExplanation={"denyAccessState":"DENY_ACCESS_STATE_UNKNOWN_INFO",
                                                   "permissionDeniable":True,
                                                   "policy":{"bindings":[{"members":["unrelated"]}]},
                                                   "explainedResources":[{"memberships":{"user:private@example.test":{"denyAccessState":"DENY_ACCESS_STATE_UNKNOWN_INFO"}}}]},
                            errors=[{"code":7, "message":"private detail"}])
        class Session:
            def post(self, url, **kwargs):
                return Response()
        capture = iam.capture_requests([requested], Session(), clock=lambda: NOW)
        serialized = str(capture)
        self.assertNotIn("unrelated", serialized)
        self.assertNotIn("private detail", serialized)
        self.assertNotIn("private@example.test", serialized)
        self.assertNotIn("memberships", serialized)
        self.assertEqual(capture["checks"][0]["response"]["denyPolicyExplanation"],
                         {"denyAccessState":"DENY_ACCESS_STATE_UNKNOWN_INFO", "permissionDeniable":True})
        self.assertFalse(iam.evaluate([requested], capture, now=NOW)["ready"])

    def test_capture_paces_fixed_diagnostics_without_retrying(self):
        calls, pauses = [], []
        class Response:
            status_code = 429
            def json(self):
                return {"error":{"code":429, "status":"RESOURCE_EXHAUSTED"}}
        class Session:
            def post(self, url, **kwargs):
                calls.append(url)
                return Response()
        capture = iam.capture_requests(self.requests[:2], Session(), clock=lambda:NOW, sleep_fn=pauses.append)
        self.assertEqual(calls, [iam.ENDPOINT, iam.ENDPOINT])
        self.assertEqual(pauses, [4.5])
        self.assertEqual([r["httpStatus"] for r in capture["checks"]], [429, 429])
        self.assertFalse(iam.evaluate(self.requests[:2], capture, now=NOW)["ready"])

    def test_denial_http_body_never_persists_raw_message(self):
        requested = self.requests[0]
        class Response:
            status_code = 403
            def json(self):
                return {"error":{"code":403,"status":"PERMISSION_DENIED","message":"private"}}
        class Session:
            def post(self, url, **kwargs):
                return Response()
        capture = iam.capture_requests([requested], Session(), clock=lambda: NOW)
        self.assertEqual(capture["checks"][0]["response"],
                         {"error":{"code":403,"status":"PERMISSION_DENIED"}})
        self.assertFalse(iam.evaluate([requested], capture, now=NOW)["ready"])


if __name__ == "__main__":
    unittest.main()
