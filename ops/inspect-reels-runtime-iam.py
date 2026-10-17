#!/usr/bin/env python3
"""Read-only, fixed-scope IAM diagnostic. No workload or provider calls.

Policy evaluation proves IAM only; quotas, API availability, ACLs, VPC Service
Controls and processing authorization are independent. Captured reports must
come from a reviewed authenticated owner execution; JSON is not an attestation.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re

PROJECT = "megabrain-v0-1017370021431"
REGION = "us-central1"
ENDPOINT = "https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot"
SOURCE = "policytroubleshooter.googleapis.com/v3/iam:troubleshoot"
MAX_AGE_SECONDS = 900
STAGES = ("acquisition", "transcription", "analysis")


def matrix(model, speech_location):
    """Generate only diagnostic tuples; never create a Cloud Task."""
    if not isinstance(model, str) or not re.fullmatch(r"gemini-[a-z0-9.-]{1,80}", model):
        raise ValueError("Exact configured Gemini model required.")
    if speech_location not in ("global", "us"):
        raise ValueError("Configured Speech location must be global or us.")
    rows = []
    def add(identity, resource, permission, scope="exact"):
        principal = identity if "@" in identity else identity + "@" + PROJECT + ".iam.gserviceaccount.com"
        tuple_ = dict(principal=principal, fullResourceName=resource, permission=permission)
        check_id = hashlib.sha256(json.dumps(tuple_, sort_keys=True).encode()).hexdigest()
        rows.append(dict(id=check_id, accessTuple=tuple_, scope=scope))
    for identity in ("v0-web", "v0-worker"):
        for stage in STAGES:
            resource = "//cloudtasks.googleapis.com/projects/" + PROJECT + "/locations/" + REGION + "/queues/v0-" + stage
            for permission in ("cloudtasks.tasks.create", "cloudtasks.tasks.get", "cloudtasks.tasks.fullView"):
                # Queues are the IAM policy attachment point. This checks the
                # queue-level permission, without fabricating an existing task.
                add(identity, resource, permission, "queue-policy")
        add(identity, "//iam.googleapis.com/projects/" + PROJECT + "/serviceAccounts/v0-queue@" + PROJECT + ".iam.gserviceaccount.com", "iam.serviceAccounts.actAs")
        # The diagnostic API rejects the Firestore Database full resource name.
        # This is explicitly an ancestor project-policy check, not database IAM.
        project_resource = "//cloudresourcemanager.googleapis.com/projects/" + PROJECT
        for permission in ("datastore.entities.get", "datastore.entities.list", "datastore.entities.create", "datastore.entities.update"):
            add(identity, project_resource, permission, "project-policy")
        bucket = "//storage.googleapis.com/projects/_/buckets/" + PROJECT + "-media"
        for permission in (("storage.objects.get",) if identity == "v0-web" else ("storage.objects.get", "storage.objects.create")):
            add(identity, bucket, permission, "bucket-policy")
    for stage in STAGES:
        add("v0-queue", "//run.googleapis.com/projects/" + PROJECT + "/locations/" + REGION + "/services/megabrain-v0-" + stage, "run.routes.invoke")
    add("v0-worker", "//speech.googleapis.com/projects/" + PROJECT + "/locations/" + speech_location + "/recognizers/_", "speech.recognizers.recognize")
    # No operation exists for this future pilot. Evaluate the parent project
    # policy only; this never polls or resubmits a historical paid operation.
    add("v0-worker", "//cloudresourcemanager.googleapis.com/projects/" + PROJECT, "speech.operations.get", "project-policy")
    add("v0-worker", "//aiplatform.googleapis.com/projects/" + PROJECT + "/locations/global/publishers/google/models/" + model, "aiplatform.endpoints.predict")
    # These Google-managed agents perform GCS input reads and OIDC minting;
    # proving the caller SA alone would leave both execution paths unproved.
    add("service-711042421394@gcp-sa-speech.iam.gserviceaccount.com",
        "//storage.googleapis.com/projects/_/buckets/" + PROJECT + "-media",
        "storage.objects.get", "bucket-policy")
    add("service-711042421394@gcp-sa-cloudtasks.iam.gserviceaccount.com",
        "//iam.googleapis.com/projects/" + PROJECT + "/serviceAccounts/v0-queue@" + PROJECT + ".iam.gserviceaccount.com",
        "iam.serviceAccounts.getOpenIdToken")
    return rows


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timezone required")
    return parsed


def incomplete(value):
    """Evaluate policy summaries, not inconclusive unrelated role bindings.

    overallAccessState is authoritative. A secondary allow binding can be
    unknown while another binding definitely grants access. Unsupported deny
    permissions do not make an otherwise definitive CAN_ACCESS inconclusive.
    Heuristic relevance is never used as an authorization decision.
    """
    if value.get("error") or value.get("errors"):
        return True
    for key in ("allowPolicyExplanation", "denyPolicyExplanation", "pabPolicyExplanation"):
        explanation = value.get(key, {})
        if not isinstance(explanation, dict):
            return True
        if explanation.get("error") or explanation.get("errors"):
            return True
        if (key == "denyPolicyExplanation" and explanation.get("permissionDeniable") is False
                and value.get("overallAccessState") == "CAN_ACCESS"
                and explanation.get("denyAccessState") != "DENY_ACCESS_STATE_DENIED"):
            continue
        for state_key, state in explanation.items():
            if state_key.endswith("AccessState"):
                if not isinstance(state, str) or "UNKNOWN" in state or "UNSPECIFIED" in state or state in (
                    "DENY_ACCESS_STATE_DENIED", "PAB_ACCESS_STATE_DENIED",
                    "PAB_ACCESS_STATE_NOT_ALLOWED", "ALLOW_ACCESS_STATE_NOT_GRANTED"):
                    return True
    return False


def normalized_tuple(value):
    if not isinstance(value, dict):
        return None
    # permissionFqdn is documented output-only. An empty context adds no facts;
    # every nonempty context and every other field must remain exactly bound.
    return {k:v for k,v in value.items() if k != "permissionFqdn"
            and not (k == "conditionContext" and v == {})}


def evaluate(requests, capture, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expected = {r["id"]: r for r in requests}
    if len(expected) != len(requests) or not requests:
        raise ValueError("Invalid diagnostic matrix.")
    records = capture.get("checks", []) if isinstance(capture, dict) else []
    if not isinstance(records, list):
        records = []
    index = {}
    duplicate = set()
    for record in records:
        if not isinstance(record, dict):
            continue
        key = record.get("id")
        if key in index:
            duplicate.add(key)
        index[key] = record
    envelope_ok = isinstance(capture, dict) and capture.get("project") == PROJECT and capture.get("source") == SOURCE
    unknown_ids = set(index) - set(expected)
    checks = []
    for key, requested in expected.items():
        record = index.get(key, {})
        access, reason = "unknown", "missing_diagnostic"
        response = record.get("response", {})
        if not isinstance(response, dict):
            response = {}
        try:
            age = (now - timestamp(record.get("observedAt"))).total_seconds()
            fresh = 0 <= age <= MAX_AGE_SECONDS
        except (TypeError, ValueError, OverflowError):
            fresh = False
        if not envelope_ok:
            reason = "untrusted_capture_envelope"
        elif unknown_ids or key in duplicate:
            reason = "unexpected_or_duplicate_check"
        elif not fresh:
            reason = "stale_or_invalid_observation"
        elif record.get("httpStatus") != 200:
            reason = "diagnostic_http_error"
        elif normalized_tuple(response.get("accessTuple")) != normalized_tuple(requested["accessTuple"]):
            reason = "principal_resource_permission_mismatch"
        else:
            reason = "tuple_valid"
        if reason == "tuple_valid":
            state = response.get("overallAccessState")
            explanations = [response.get(k, {}) for k in ("allowPolicyExplanation", "denyPolicyExplanation", "pabPolicyExplanation")]
            summary_errors = response.get("error") or response.get("errors") or any(
                not isinstance(x, dict) or x.get("error") or x.get("errors") for x in explanations)
            # A definitive denial is not an incomplete grant. For example,
            # allow NOT_GRANTED plus unsupported deny UNKNOWN is still denied.
            if state == "CANNOT_ACCESS" and not summary_errors:
                access, reason = "denied", "overall_cannot_access"
            elif incomplete(response):
                reason = "incomplete_policy_evaluation"
            elif state == "CAN_ACCESS":
                access, reason = "granted", "overall_can_access"
            else:
                reason = "overall_unknown"
        checks.append(dict(id=key, **requested["accessTuple"], scope=requested["scope"], access=access, reason=reason))
    ready = all(c["access"] == "granted" for c in checks)
    return dict(schemaVersion=1, observedAt=now.isoformat(), project=PROJECT,
                source=SOURCE, effectivePermissionsObserved=ready, ready=ready,
                activationAllowed=False, processingAuthorized=False, checks=checks,
                missingCapabilities=[dict(id=c["id"], reason=c["reason"]) for c in checks if c["access"] != "granted"],
                limitations=["IAM diagnostic only; no provider call or task creation.",
                             "Queue/database/bucket/project checks concern policies at the stated attachment points; task/object-specific conditions require separate verification.",
                             "Imported JSON requires independently verified authenticated capture provenance.",
                             "Unsupported deny permission (permissionDeniable=false) does not override definitive CAN_ACCESS; secondary binding uncertainty does not override policy summaries."])


def capture_requests(requests, session, clock=None, sleep_fn=None):
    """Only the fixed diagnostic endpoint; pace below its 15/minute quota."""
    import time
    checks = []
    for index, requested in enumerate(requests):
        if index:
            (sleep_fn or time.sleep)(4.5)
        response = session.post(ENDPOINT, json={"accessTuple": requested["accessTuple"]}, timeout=30)
        data = response.json()
        # Preserve only diagnostic fields; never persist credentials/headers.
        allowed = ("overallAccessState", "accessTuple", "allowPolicyExplanation",
                   "denyPolicyExplanation", "pabPolicyExplanation", "errors")
        def states_only(value):
            # No recursive policy/binding/member maps: preserve only each
            # policy type's aggregate verdict and diagnostic support flags.
            if not isinstance(value, dict):
                return {"errors":{"present":True}}
            return {key: ({"present":True} if key in ("error", "errors") else item)
                    for key,item in value.items()
                    if key.endswith("AccessState") or key in ("permissionDeniable", "relevance")
                    or key in ("error", "errors") and item}
        selected = {}
        if isinstance(data, dict):
            for key in allowed:
                if key in data:
                    if key == "errors":
                        selected[key] = {"present":True} if data[key] else []
                    else:
                        selected[key] = data[key] if key in ("accessTuple", "overallAccessState") else states_only(data[key])
        if response.status_code != 200:
            error = data.get("error", {}) if isinstance(data, dict) else {}
            selected = {"error": {"code": error.get("code"), "status": error.get("status")}}
        checks.append(dict(id=requested["id"], observedAt=(clock or (lambda:dt.datetime.now(dt.timezone.utc)))().isoformat(),
                           httpStatus=response.status_code, response=selected))
    return dict(schemaVersion=1, project=PROJECT, source=SOURCE, checks=checks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--speech-location", required=True, choices=("global", "us"))
    parser.add_argument("--capture", type=Path, help="Reviewed owner diagnostic JSON; no network calls.")
    args = parser.parse_args()
    requests = matrix(args.model, args.speech_location)
    if args.capture:
        print(json.dumps(evaluate(requests, json.loads(args.capture.read_text())), indent=2))
    else:
        print(json.dumps(dict(schemaVersion=1, project=PROJECT, source=SOURCE, checks=requests), indent=2))


if __name__ == "__main__":
    main()
