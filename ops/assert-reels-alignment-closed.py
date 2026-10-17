"""Read-only owner guard for the reviewed pre-publication cleanup window.
No credential file, provider call, data write or error body is read/exported.
"""
import datetime as dt
import json
import os
import socket
import time
import urllib.error
import urllib.request

PROJECT = "megabrain-v0-1017370021431"
BASE = "https://run.googleapis.com/v2/projects/" + PROJECT + "/locations/us-central1/services/megabrain-v0-"
QUEUES = "https://cloudtasks.googleapis.com/v2/projects/" + PROJECT + "/locations/us-central1/queues/v0-"
DOCS = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents/"
STAGES = ("acquisition", "transcription", "analysis")
IMAGES = {"web": "5c24a46312288cb8d601e53e3d3fd491bf7d6b31251ea144d64c64f32f3a3bb2", **{s: "de3709258cd5f67041b372376b41a03f14ea3dfd6c5cb04863cfab223f9cc1e0" for s in STAGES}, "worker": "8a6895e5780dd5697de525be8450f91c2bd4dd9a7fe4ea742d90f8ee77079ce7"}
LEGACY_ETAG = '\"CJWgxtYGEKi0qZsB/cHJvamVjdHMvbWVnYWJyYWluLXYwLTEwMTczNzAwMjE0MzEvbG9jYXRpb25zL3VzLWNlbnRyYWwxL3NlcnZpY2VzL21lZ2FicmFpbi12MC13b3JrZXI\"'


def require(value):
    if not value:
        raise ValueError("Closed reviewed runtime changed; cleanup must stop.")


def inspect(get):
    targets = {"service:" + s: BASE + s for s in ("web", *STAGES, "worker")}
    for s in (*STAGES, "processing"):
        targets["queue:" + s] = QUEUES + s
        targets["tasks:" + s] = QUEUES + s + "/tasks?pageSize=1&responseView=BASIC&fields=tasks(name),nextPageToken"
    for s in STAGES:
        targets["control:" + s] = DOCS + "reels_controls/" + s + "?mask.fieldPaths=paused&mask.fieldPaths=active&mask.fieldPaths=desiredConcurrency&mask.fieldPaths=effectiveConcurrency"
    for s in ("admission", "automation"):
        targets["writer:" + s] = DOCS + "settings/" + s + "?mask.fieldPaths=enabled"
    # Owner transport is sequential and fail-fast. No pending worker continues
    # issuing GETs after a refusal or validation failure.
    observations = {k: get(url) for k, url in targets.items()}
    for s in ("web", *STAGES, "worker"):
        value = observations["service:" + s]
        resource = BASE.split("/v2/")[1] + s
        require(value.get("name") == resource and not value.get("reconciling"))
        ready = value.get("latestReadyRevision", "")
        require(ready.startswith(resource + "/revisions/") and ready == value.get("latestCreatedRevision"))
        revision = ready.rsplit("/", 1)[-1]
        require(value.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED")
        require(value.get("traffic") == [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}])
        require(value.get("trafficStatuses") == [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": revision, "percent": 100}])
        containers = value.get("template", {}).get("containers", [])
        require(len(containers) == 1)
        image_name = "web" if s == "web" else "worker"
        require(containers[0].get("image") == "us-central1-docker.pkg.dev/" + PROJECT + "/v0-images/" + image_name + "@sha256:" + IMAGES[s])
        if s == "worker":
            require(value.get("etag") == LEGACY_ETAG)
        else:
            require([e for e in containers[0].get("env", []) if e.get("name") == "MEGABRAIN_REELS_CLOSED_RELEASE"] == [{"name": "MEGABRAIN_REELS_CLOSED_RELEASE", "value": "v2"}])
    for s in (*STAGES, "processing"):
        q = observations["queue:" + s]
        require(q.get("name") == QUEUES.split("/v2/")[1] + s and q.get("state") == "PAUSED")
        tasks = observations["tasks:" + s]
        require(not tasks.get("tasks") and not tasks.get("nextPageToken"))
    for s in STAGES:
        fields = observations["control:" + s].get("fields", {})
        paused = fields.get("paused")
        require(isinstance(paused, dict) and paused.get("booleanValue") is True)
        # Pipeline.acquire persists active as an array of execution IDs. Empty
        # Firestore arrays may omit values in REST; a missing field or map is
        # not evidence that no work remains. Effective concurrency is capacity,
        # not occupancy, and release intentionally retains its configured value.
        active = fields.get("active")
        require(isinstance(active, dict) and set(active) == {"arrayValue"})
        contents = active["arrayValue"]
        require(isinstance(contents, dict) and set(contents).issubset({"values"}))
        values = contents.get("values", [])
        require(isinstance(values, list) and not values)
        for field in ("desiredConcurrency", "effectiveConcurrency"):
            require(fields.get(field) == {"integerValue": "1"})
    for s in ("admission", "automation"):
        require(observations["writer:" + s].get("fields", {}).get("enabled", {}).get("booleanValue") is False)
    return {"project": PROJECT, "closed": True, "fourServicesClosed": True, "fourQueuesClosed": True, "legacyPreserved": True, "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "readOnly": True}


def get_with_dns_retry(url, token, deadline, *, opener=urllib.request.urlopen, clock=time.monotonic, sleep=time.sleep):
    """Only retry temporary DNS resolution failure before any HTTP response."""
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token}, method="GET")
    for attempt in range(3):
        remaining = deadline - clock()
        require(remaining > 0)
        received_response = False
        try:
            response = opener(request, timeout=min(30, remaining))
            received_response = True
            with response:
                result = json.load(response)
            require(clock() < deadline)
            return result
        except urllib.error.URLError as error:
            reason = error.reason
            temporary_dns = (type(error) is urllib.error.URLError and
                             isinstance(reason, socket.gaierror) and
                             reason.errno == socket.EAI_AGAIN)
            if received_response or not temporary_dns or attempt == 2:
                raise
            # No retry of HTTP errors, body/JSON/validation failures, timeouts,
            # other DNS errors, provider calls or writes. Never exceed budget.
            require(deadline - clock() > 2)
            sleep(2)
    raise ValueError("Closed-runtime DNS read budget exhausted.")


def main():
    token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
    require(bool(token))
    deadline = time.monotonic() + 90
    def get(url):
        return get_with_dns_retry(url, token, deadline)
    print(json.dumps(inspect(get)))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Closed-runtime guard refused operation.", file=__import__("sys").stderr)
        raise SystemExit(1)
