import copy
import importlib.util
import io
import socket
import threading
import time
import urllib.error
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("alignment_guard", Path(__file__).with_name("assert-reels-alignment-closed.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def fixture():
    rows = {}
    for s in ("web", *guard.STAGES, "worker"):
        url = guard.BASE + s
        resource = url.split("/v2/")[1]
        revision = "megabrain-v0-" + s + "-00001-test"
        image = "web" if s == "web" else "worker"
        rows[url] = {"name": resource, "latestReadyRevision": resource + "/revisions/" + revision, "latestCreatedRevision": resource + "/revisions/" + revision, "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "traffic": [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}], "trafficStatuses": [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": revision, "percent": 100}], "template": {"containers": [{"image": "us-central1-docker.pkg.dev/" + guard.PROJECT + "/v0-images/" + image + "@sha256:" + guard.IMAGES[s], "env": [{"name": "MEGABRAIN_REELS_CLOSED_RELEASE", "value": "v2"}]}]}, "etag": guard.LEGACY_ETAG}
    for s in (*guard.STAGES, "processing"):
        rows[guard.QUEUES + s] = {"name": (guard.QUEUES + s).split("/v2/")[1], "state": "PAUSED"}
        rows[guard.QUEUES + s + "/tasks?pageSize=1&responseView=BASIC&fields=tasks(name),nextPageToken"] = {}
    for s in guard.STAGES:
        rows[guard.DOCS + "reels_controls/" + s + "?mask.fieldPaths=paused&mask.fieldPaths=active&mask.fieldPaths=desiredConcurrency&mask.fieldPaths=effectiveConcurrency"] = {"fields": {"paused": {"booleanValue": True}, "active": {"arrayValue": {}}, "desiredConcurrency": {"integerValue": "1"}, "effectiveConcurrency": {"integerValue": "1"}}}
    for s in ("admission", "automation"):
        rows[guard.DOCS + "settings/" + s + "?mask.fieldPaths=enabled"] = {"fields": {"enabled": {"booleanValue": False}}}
    return rows


class ClosedGuardTest(unittest.TestCase):
    def test_complete_closed_readonly_guard(self):
        proof = guard.inspect(fixture().__getitem__)
        self.assertTrue(proof["closed"])
        self.assertTrue(proof["fourServicesClosed"])
        self.assertTrue(proof["fourQueuesClosed"])
    def test_legacy_queue_task_or_unknown_result_refuses(self):
        for response in ({"tasks": [{"name": "unexpected"}]}, {"nextPageToken": "unknown"}):
            data = fixture(); data[guard.QUEUES + "processing/tasks?pageSize=1&responseView=BASIC&fields=tasks(name),nextPageToken"] = response
            with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
    def test_any_open_fence_changed_image_or_legacy_revision_refuses(self):
        for s in ("web", *guard.STAGES):
            data = fixture(); data[guard.BASE + s]["template"]["containers"][0]["env"] = []
            with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        data = fixture(); data[guard.BASE + "web"]["template"]["containers"][0]["image"] = "changed"
        with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        data = fixture(); data[guard.BASE + "worker"]["etag"] = "changed"
        with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
    def test_live_control_or_writer_and_incomplete_reads_refuse(self):
        for url in [u for u in fixture() if "settings/" in u]:
            data = fixture(); data[url]["fields"]["enabled"]["booleanValue"] = True
            with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        data = fixture(); url = next(u for u in data if "reels_controls/" in u); data[url]["fields"]["active"] = {"arrayValue": {"values": [{"stringValue": "unsettled"}]}}
        with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        data = fixture(); del data[guard.BASE + "analysis"]
        with self.assertRaises(KeyError): guard.inspect(data.__getitem__)

    def test_explicit_empty_array_forms_are_accepted_with_configured_capacity_one(self):
        for active in ({"arrayValue": {}}, {"arrayValue": {"values": []}}):
            data = fixture()
            for url in [u for u in data if "reels_controls/" in u]:
                data[url]["fields"]["active"] = copy.deepcopy(active)
            self.assertTrue(guard.inspect(data.__getitem__)["closed"])

    def test_absent_nonempty_or_wrongly_typed_occupancy_refuses(self):
        values = (None, {"nullValue": None}, {"mapValue": {}}, {"arrayValue": {"values": [{"stringValue": "busy"}]}}, {"arrayValue": {"values": {}}}, {"arrayValue": {"values": False}}, {"arrayValue": []}, {"booleanValue": False}, {"arrayValue": {}, "mapValue": {}})
        for active in values:
            data = fixture(); url = next(u for u in data if "reels_controls/" in u)
            if active is None: del data[url]["fields"]["active"]
            else: data[url]["fields"]["active"] = copy.deepcopy(active)
            with self.assertRaises(ValueError): guard.inspect(data.__getitem__)

    def test_configured_capacity_drift_missing_and_boolean_are_not_idle_counts(self):
        for field in ("desiredConcurrency", "effectiveConcurrency"):
            for value in (None, {"integerValue": "0"}, {"integerValue": "2"}, {"integerValue": 1}, {"booleanValue": True}):
                data = fixture(); url = next(u for u in data if "reels_controls/" in u)
                if value is None: del data[url]["fields"][field]
                else: data[url]["fields"][field] = copy.deepcopy(value)
                with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        for value in (None, {"booleanValue": False}, {"booleanValue": 1}, {"integerValue": "1"}):
            data = fixture(); url = next(u for u in data if "reels_controls/" in u)
            if value is None: del data[url]["fields"]["paused"]
            else: data[url]["fields"]["paused"] = value
            with self.assertRaises(ValueError): guard.inspect(data.__getitem__)


class SerialOwnerReadTest(unittest.TestCase):
    def test_all_eighteen_observations_are_sequential_in_the_original_order(self):
        rows = fixture()
        lock = threading.Lock()
        calls = []
        active = 0
        maximum = 0
        def get(url):
            nonlocal active, maximum
            with lock:
                calls.append(url)
                active += 1
                maximum = max(maximum, active)
            # Synthetic body-consumption latency makes the former fan-out fail
            # this assertion. This test performs no network or credential read.
            time.sleep(0.002)
            result = copy.deepcopy(rows[url])
            with lock:
                active -= 1
            return result
        self.assertTrue(guard.inspect(get)["closed"])
        self.assertEqual(calls, list(rows))
        self.assertEqual(len(calls), 18)
        self.assertEqual(maximum, 1)
        self.assertEqual(active, 0)

    def test_first_read_failure_stops_without_pending_gets_or_retry(self):
        rows = fixture()
        calls = []
        failure = RuntimeError("synthetic read failure")
        def get(url):
            calls.append(url)
            if len(calls) == 4:
                raise failure
            return rows[url]
        with self.assertRaises(RuntimeError) as result:
            guard.inspect(get)
        self.assertIs(result.exception, failure)
        self.assertEqual(calls, list(rows)[:4])


class TemporaryDNSReadTest(unittest.TestCase):
    def transient(self):
        return urllib.error.URLError(socket.gaierror(socket.EAI_AGAIN, "synthetic DNS"))

    def test_only_temporary_pre_response_dns_retries_the_same_get_at_most_three_times(self):
        now = [0.0]; pauses = []; calls = []
        def sleep(seconds):
            pauses.append(seconds); now[0] += seconds
        def opener(request, timeout):
            calls.append((request.full_url, request.get_method(), timeout, request.get_header("Authorization")))
            if len(calls) < 3:
                raise self.transient()
            return io.StringIO('{"closed":true}')
        result = guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 90, opener=opener, clock=lambda: now[0], sleep=sleep)
        self.assertEqual(result, {"closed": True})
        self.assertEqual(len(calls), 3)
        self.assertEqual(pauses, [2, 2])
        self.assertTrue(all(row[0] == guard.BASE + "web" and row[1] == "GET" and row[2] == 30 and row[3] == "Bearer fixture-token" for row in calls))

    def test_third_dns_failure_propagates_without_fourth_attempt(self):
        calls = []; pauses = []
        failure = self.transient()
        def opener(request, timeout):
            calls.append(request.full_url); raise failure
        with self.assertRaises(urllib.error.URLError) as result:
            guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 90, opener=opener, clock=lambda: 0, sleep=pauses.append)
        self.assertIs(result.exception, failure)
        self.assertEqual(len(calls), 3)
        self.assertEqual(pauses, [2, 2])

    def test_http_other_dns_timeout_and_unknown_errors_never_retry(self):
        failures = [
            urllib.error.HTTPError(guard.BASE + "web", 503, "synthetic HTTP", {}, None),
            urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "synthetic permanent DNS")),
            urllib.error.URLError(TimeoutError("synthetic timeout")),
            TimeoutError("synthetic timeout"),
            RuntimeError("synthetic unknown"),
        ]
        for failure in failures:
            calls = []; pauses = []
            def opener(request, timeout):
                calls.append(request.full_url); raise failure
            with self.assertRaises(Exception) as result:
                guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 90, opener=opener, clock=lambda: 0, sleep=pauses.append)
            self.assertIs(result.exception, failure)
            self.assertEqual(len(calls), 1)
            self.assertEqual(pauses, [])

    def test_body_or_json_failure_never_replays_an_http_response(self):
        failure = self.transient()
        class FailedBody(io.StringIO):
            def read(self, *args):
                raise failure
        for response in (FailedBody(""), io.StringIO("not JSON")):
            calls = []; pauses = []
            def opener(request, timeout):
                calls.append(request.full_url); return response
            with self.assertRaises(Exception):
                guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 90, opener=opener, clock=lambda: 0, sleep=pauses.append)
            self.assertEqual(len(calls), 1)
            self.assertEqual(pauses, [])

    def test_global_deadline_bounds_timeout_and_prevents_unfunded_backoff_or_attempt(self):
        now = [0.0]; calls = []; pauses = []
        def sleep(seconds):
            pauses.append(seconds); now[0] += seconds
        def opener(request, timeout):
            calls.append(timeout); raise self.transient()
        with self.assertRaises(ValueError):
            guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 3, opener=opener, clock=lambda: now[0], sleep=sleep)
        self.assertEqual(calls, [3, 1])
        self.assertEqual(pauses, [2])
        calls.clear()
        with self.assertRaises(ValueError):
            guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 0, opener=opener, clock=lambda: 0, sleep=pauses.append)
        self.assertEqual(calls, [])

    def test_a_response_returned_after_deadline_fails_closed_without_retry(self):
        now = [0.0]; calls = []
        def opener(request, timeout):
            calls.append(timeout); now[0] = 91
            return io.StringIO('{"closed":true}')
        with self.assertRaises(ValueError):
            guard.get_with_dns_retry(guard.BASE + "web", "fixture-token", 90, opener=opener, clock=lambda: now[0], sleep=lambda _: self.fail("must not retry"))
        self.assertEqual(calls, [30])
