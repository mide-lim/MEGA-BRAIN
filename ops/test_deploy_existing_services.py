import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deployment", Path(__file__).with_name("deploy-existing-services.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)

CONFIG = {
    "project": "example-project", "region": "us-central1", "queue": "processing",
    "registry": "us-central1-docker.pkg.dev/example-project/images",
    "services": {"web": "example-web", "worker": "example-worker"},
    "runtime_accounts": {k: k + "@example-project.iam.gserviceaccount.com" for k in deployment.KINDS},
}
OLD = "a" * 64
NEW = "b" * 64


def services():
    return {k: {
        "name": "projects/example-project/locations/us-central1/services/example-" + k,
        "etag": "first",
        "uri": "https://example-service.run.app",
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        "traffic": [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}],
        "template": {
            "revision": "generated-old", "serviceAccount": CONFIG["runtime_accounts"][k],
            "scaling": {"maxInstanceCount": 1},
            "containers": [{"image": CONFIG["registry"] + "/" + k + "@sha256:" + OLD,
                            "env": [{"name": "SETTING", "valueSource": {"secretKeyRef": {"secret": "setting", "version": "2"}}}]}],
            "volumes": [{"name": "config", "secret": {"secret": "settings", "items": [{"version": "3", "path": "config.json"}]}}],
        },
    } for k in deployment.KINDS}


def images():
    return {k: CONFIG["registry"] + "/" + k + "@sha256:" + NEW for k in deployment.KINDS}


class FakeGoogle:
    def __init__(self, original):
        self.values = copy.deepcopy(original)
        self.calls = []
        self.block = None
        self.reconciling = False
        self.pause_checks = 0

    def service(self, kind):
        return copy.deepcopy(self.values[kind])

    def paused(self):
        self.pause_checks += 1

    def update(self, kind, current, containers, validate_only=False):
        self.calls.append((kind, copy.deepcopy(containers), validate_only))
        if self.block == kind:
            self.block = None
            raise deployment.DeploymentError("Simulated patch failure")
        if not validate_only:
            self.values[kind]["template"]["containers"] = copy.deepcopy(containers)
            self.values[kind]["template"]["revision"] = "generated-new"
            self.values[kind]["etag"] = "next"
            if self.reconciling:
                self.values[kind]["reconciling"] = True
                raise deployment.DeploymentError("Simulated timeout")


class ValidationTests(unittest.TestCase):
    def test_valid_configuration_and_services(self):
        deployment.validate_config(CONFIG)
        deployment.validate_services(services(), CONFIG)

    def test_explicit_four_worker_instances_are_accepted_but_not_other_values(self):
        config = {**CONFIG, "runtime_max_instances": {"worker": 4, "web": 1}}
        value = services()
        value["worker"]["template"]["scaling"]["maxInstanceCount"] = 4
        deployment.validate_config(config)
        deployment.validate_services(value, config)
        for kind, actual in [("worker", 1), ("worker", 3), ("worker", 5), ("web", 2)]:
            changed = copy.deepcopy(value)
            changed[kind]["template"]["scaling"]["maxInstanceCount"] = actual
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_services(changed, config)
        with self.assertRaises(deployment.DeploymentError):
            deployment.validate_services(value, CONFIG)

    def test_reject_invalid_expected_runtime_maps(self):
        for limits in [None, [], {}, {"worker": 4}, {"worker": 4, "web": 1, "extra": 1}, {"worker": True, "web": 1}, {"worker": 4.0, "web": 1}, {"worker": 0, "web": 1}, {"worker": 5, "web": 1}]:
            with self.subTest(limits=limits), self.assertRaises(deployment.DeploymentError):
                deployment.validate_config({**CONFIG, "runtime_max_instances": limits})

    def test_rollout_and_rollback_preserve_four_worker_instances(self):
        original = services()
        original["worker"]["template"]["scaling"]["maxInstanceCount"] = 4
        config = {**CONFIG, "runtime_max_instances": {"worker": 4, "web": 1}}
        for fail in [False, True]:
            api = FakeGoogle(original)
            if fail:
                api.block = "web"
                with self.assertRaises(deployment.DeploymentError):
                    deployment.rollout(api, config, original, images(), smoke=lambda origin: None)
                self.assertEqual(deployment.baseline_digest(api.values), deployment.baseline_digest(original))
            else:
                deployment.rollout(api, config, original, images(), smoke=lambda origin: None)
            self.assertEqual(api.values["worker"]["template"]["scaling"]["maxInstanceCount"], 4)
            self.assertTrue(all(set(containers[0]) == set(original[kind]["template"]["containers"][0]) for kind, containers, _ in api.calls))

    def test_reject_outside_registry(self):
        value = copy.deepcopy(CONFIG)
        value["registry"] = "us-central1-docker.pkg.dev/another-project/images"
        with self.assertRaises(deployment.DeploymentError):
            deployment.validate_config(value)

    def test_reject_unpinned_secrets(self):
        for location in ["env", "volume"]:
            value = services()
            if location == "env":
                value["web"]["template"]["containers"][0]["env"][0]["valueSource"]["secretKeyRef"]["version"] = "latest"
            else:
                value["worker"]["template"]["volumes"][0]["secret"]["items"][0]["version"] = "latest"
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_services(value, CONFIG)

    def test_reject_runtime_or_scale_change(self):
        for name, new in [("serviceAccount", "other@example-project.iam.gserviceaccount.com"), ("scaling", {"maxInstanceCount": 2})]:
            value = services()
            value["worker"]["template"][name] = new
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_services(value, CONFIG)

    def test_reject_traffic_split_and_reconciling(self):
        for key, value in [("traffic", []), ("reconciling", True)]:
            original = services()
            original["web"][key] = value
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_services(original, CONFIG)

    def test_baseline_tracks_configuration_and_ignores_generated_revision(self):
        original = services()
        digest = deployment.baseline_digest(original)
        original["web"]["template"]["revision"] = "another-generated-name"
        self.assertEqual(digest, deployment.baseline_digest(original))
        original["web"]["template"]["containers"][0]["env"][0]["valueSource"]["secretKeyRef"]["version"] = "4"
        self.assertNotEqual(digest, deployment.baseline_digest(original))


class RolloutTests(unittest.TestCase):
    def test_success_changes_only_images(self):
        original = services()
        api = FakeGoogle(original)
        smoke = []
        deployment.rollout(api, CONFIG, original, images(), smoke=smoke.append)
        self.assertEqual(len(smoke), 1)
        self.assertGreaterEqual(api.pause_checks, 3)
        for kind in deployment.KINDS:
            self.assertEqual(api.values[kind]["template"]["containers"][0]["image"], images()[kind])
            self.assertEqual(deployment.without_image(api.values[kind]), deployment.without_image(original[kind]))

    def test_web_failure_restores_worker(self):
        original = services()
        api = FakeGoogle(original)
        api.block = "web"
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            deployment.rollout(api, CONFIG, original, images(), smoke=lambda origin: None)
        self.assertEqual(deployment.baseline_digest(api.values), deployment.baseline_digest(original))

    def test_smoke_failure_restores_both(self):
        original = services()
        api = FakeGoogle(original)
        def fail(origin):
            raise deployment.DeploymentError("Synthetic smoke failure")
        with self.assertRaisesRegex(deployment.DeploymentError, "restored"):
            deployment.rollout(api, CONFIG, original, images(), smoke=fail)
        self.assertEqual(deployment.baseline_digest(api.values), deployment.baseline_digest(original))

    def test_concurrent_edit_is_not_overwritten(self):
        original = services()
        api = FakeGoogle(original)
        api.values["worker"]["template"]["containers"][0]["env"] = []
        with self.assertRaises(deployment.DeploymentError):
            deployment.rollout(api, CONFIG, original, images(), smoke=lambda origin: None)
        self.assertEqual(api.calls, [])

    def test_timeout_does_not_overwrite_reconciling_operation(self):
        original = services()
        api = FakeGoogle(original)
        api.reconciling = True
        with self.assertRaisesRegex(deployment.DeploymentError, "operator review"):
            deployment.rollout(api, CONFIG, original, images(), smoke=lambda origin: None)
        self.assertEqual(len(api.calls), 1)

    def test_external_change_prevents_automatic_recovery(self):
        original = services()
        api = FakeGoogle(original)
        def concurrent(origin):
            api.values["web"]["template"]["containers"][0]["image"] = CONFIG["registry"] + "/web@sha256:" + "c" * 64
            raise deployment.DeploymentError("Concurrent update")
        with self.assertRaisesRegex(deployment.DeploymentError, "operator review"):
            deployment.rollout(api, CONFIG, original, images(), smoke=concurrent)
        self.assertTrue(api.values["web"]["template"]["containers"][0]["image"].endswith("c" * 64))
        self.assertEqual(api.values["worker"]["template"]["containers"][0]["image"], original["worker"]["template"]["containers"][0]["image"])

    def test_review_never_publishes_or_rolls_out(self):
        original = services()
        api = FakeGoogle(original)
        with patch.object(deployment, "Google", return_value=api), patch.object(deployment, "publish") as publish:
            outcome = deployment.run("review", CONFIG, "d" * 40, deployment.baseline_digest(original), "dummy")
        publish.assert_not_called()
        self.assertFalse(outcome["deployed"])
        self.assertEqual(len(api.calls), 2)
        self.assertTrue(all(call[2] for call in api.calls))

    def test_wrong_baseline_stops_before_patch(self):
        api = FakeGoogle(services())
        with patch.object(deployment, "Google", return_value=api):
            with self.assertRaisesRegex(deployment.DeploymentError, "baseline"):
                deployment.run("deploy", CONFIG, "d" * 40, "e" * 64, "dummy")
        self.assertEqual(api.calls, [])


class GoogleValidationTests(unittest.TestCase):
    def test_validate_only_does_not_poll_an_unpersisted_operation(self):
        api = deployment.Google(CONFIG, "dummy")
        response = {"name": "projects/example-project/locations/us-central1/operations/unpersisted"}
        with patch.object(api, "request", return_value=response) as request:
            api.update("web", services()["web"], services()["web"]["template"]["containers"], validate_only=True)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0], "PATCH")
        self.assertIn("validateOnly=true", request.call_args.args[1])

    def test_validate_only_rejects_an_immediate_error(self):
        api = deployment.Google(CONFIG, "dummy")
        with patch.object(api, "request", return_value={"error": {"code": 7}}):
            with self.assertRaisesRegex(deployment.DeploymentError, "validation failed"):
                api.update("web", services()["web"], services()["web"]["template"]["containers"], validate_only=True)

    def test_real_update_still_waits_for_the_persisted_operation(self):
        api = deployment.Google(CONFIG, "dummy")
        response = {"name": "projects/example-project/locations/us-central1/operations/persisted"}
        with patch.object(api, "request", side_effect=[response, {"done": True}]) as request:
            api.update("web", services()["web"], services()["web"]["template"]["containers"])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args.args[0], "GET")


class SmokeOriginTests(unittest.TestCase):
    def test_accepts_cloud_run_host_formats_without_real_network(self):
        class Response:
            status = 200
            def __init__(self, content):
                self.content = content
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, size):
                return self.content.encode()
        for origin in ["https://example-service.run.app", "https://example-service-abc.a.run.app", "https://example-service-123.us-central1.run.app"]:
            responses = [
                Response('Entrar com Google <link href="/style.css">'), Response("body {}"),
                *[deployment.urllib.error.HTTPError(origin, 401, "anonymous", {}, None) for _ in range(4)],
                deployment.urllib.error.HTTPError(origin, 403, "invalid", {}, None),
            ]
            with patch.object(deployment.urllib.request, "urlopen", side_effect=responses) as network:
                deployment.smoke_web(origin)
            self.assertEqual(network.call_count, 7)

    def test_rejects_external_or_ambiguous_origins_before_network(self):
        for origin in ["http://example.run.app", "https://example.run.app.evil.test", "https://example..run.app", "https://user@example.run.app", "https://example.run.app/path", "https://example.run.app:443"]:
            with patch.object(deployment.urllib.request, "urlopen") as network:
                with self.assertRaises(deployment.DeploymentError):
                    deployment.smoke_web(origin)
                network.assert_not_called()


class DeploymentDiagnosticsTests(unittest.TestCase):
    def test_readiness_polls_only_reads_without_extra_patch(self):
        original = services()
        api = FakeGoogle(original)
        reads = 0
        base_service = api.service
        def service(kind):
            nonlocal reads
            value = base_service(kind)
            if kind == "worker" and api.calls:
                reads += 1
                if reads < 3:
                    value["reconciling"] = True
            return value
        api.service = service
        with patch.object(deployment.time, "sleep"):
            deployment.rollout(api, CONFIG, original, images(), smoke=lambda origin: None)
        self.assertEqual(len(api.calls), 2)
        self.assertEqual(reads, 3)

    def test_readiness_rejects_configuration_changes_without_wait(self):
        original = services()
        api = FakeGoogle(original)
        api.values["worker"]["template"]["containers"][0]["env"] = []
        with patch.object(deployment.time, "sleep") as sleep:
            with self.assertRaisesRegex(deployment.DeploymentError, "configuration"):
                deployment.wait_ready(api, "worker", original["worker"], images()["worker"])
        sleep.assert_not_called()
        self.assertEqual(api.calls, [])

    def test_readiness_timeout_never_repeats_patch(self):
        original = services()
        api = FakeGoogle(original)
        with patch.object(deployment.time, "sleep") as sleep:
            with self.assertRaises(deployment.DeploymentError) as error:
                deployment.wait_ready(api, "worker", original["worker"], images()["worker"])
        self.assertEqual(error.exception.code, "readiness_timeout")
        self.assertEqual(sleep.call_count, 29)
        self.assertEqual(api.calls, [])

    def test_rollout_reports_phase_and_safe_cause_without_private_message(self):
        original = services()
        api = FakeGoogle(original)
        def fail(origin):
            raise deployment.DeploymentError("private-url token=SECRET", "smoke_video_http_503")
        with self.assertRaises(deployment.DeploymentError) as error:
            deployment.rollout(api, CONFIG, original, images(), smoke=fail)
        text = str(error.exception)
        self.assertIn("phase=web_smoke", text)
        self.assertIn("cause=smoke_video_http_503", text)
        self.assertNotIn("SECRET", text)
        self.assertEqual(deployment.baseline_digest(api.values), deployment.baseline_digest(original))
        self.assertEqual(deployment.safe_failure_code(deployment.DeploymentError("", "secret_value")), "operation_failed")

    def test_smoke_retries_transient_reads_but_never_authentication_mismatch(self):
        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, size):
                return b'Entrar com Google <link href="/style.css">'
        origin = "https://test.run.app"
        responses = [deployment.urllib.error.URLError("secret"), Response(), Response(),
                     *[deployment.urllib.error.HTTPError(origin, 401, "", {}, None) for _ in range(3)],
                     deployment.urllib.error.HTTPError(origin, 503, "", {}, None),
                     deployment.urllib.error.HTTPError(origin, 401, "", {}, None),
                     deployment.urllib.error.HTTPError(origin, 403, "", {}, None)]
        with patch.object(deployment.urllib.request, "urlopen", side_effect=responses) as network, patch.object(deployment.time, "sleep") as sleep:
            deployment.smoke_web(origin)
        self.assertEqual(network.call_count, 9)
        self.assertEqual(sleep.call_count, 2)
        with patch.object(deployment.urllib.request, "urlopen", side_effect=[Response(), Response(), Response()]) as network, patch.object(deployment.time, "sleep") as sleep:
            with self.assertRaises(deployment.DeploymentError) as error:
                deployment.smoke_web(origin)
        self.assertEqual(error.exception.code, "smoke_library_http_200")
        self.assertEqual(network.call_count, 3)
        sleep.assert_not_called()

    def test_smoke_transport_attempts_are_bounded_and_redacted(self):
        with patch.object(deployment.urllib.request, "urlopen", side_effect=TimeoutError("private token")) as network, patch.object(deployment.time, "sleep") as sleep:
            with self.assertRaises(deployment.DeploymentError) as error:
                deployment.smoke_web("https://test.run.app")
        self.assertEqual(network.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(error.exception.code, "smoke_transport")
        self.assertNotIn("private", str(error.exception))



if __name__ == "__main__":
    unittest.main()
