import copy
import importlib.util
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
        rows[guard.DOCS + "reels_controls/" + s + "?mask.fieldPaths=paused&mask.fieldPaths=active&mask.fieldPaths=desiredConcurrency"] = {"fields": {"paused": {"booleanValue": True}, "active": {"mapValue": {"fields": {}}}, "desiredConcurrency": {"integerValue": "1"}}}
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
        data = fixture(); url = next(u for u in data if "reels_controls/" in u); data[url]["fields"]["active"]["mapValue"]["fields"] = {"work": {"stringValue": "unsettled"}}
        with self.assertRaises(ValueError): guard.inspect(data.__getitem__)
        data = fixture(); del data[guard.BASE + "analysis"]
        with self.assertRaises(KeyError): guard.inspect(data.__getitem__)
