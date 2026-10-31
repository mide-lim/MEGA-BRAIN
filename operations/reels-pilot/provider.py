"""One-shot Vertex REST transport and strict response parsing; no network at import."""
import copy
import http.client
import math
import re
import signal
import ssl
import time
from pathlib import Path
import sys
import preparation_metrics as metrics

LIVE = Path(__file__).resolve().parents[1] / "reels-analysis-live"
if str(LIVE) not in sys.path:
    sys.path.insert(0, str(LIVE))
from common import ContractError, canonical, parse_json, sha
from cloud_adapter import Response, build_request, endpoint, GoogleOfficialTokenSource
from semantic_payload import validate_payload

MAX_RESPONSE_BYTES = 4_000_000
MAX_MEDIA_BYTES = 7_000_000  # Deliberately conservative pilot limit, not a codec guarantee.
MAX_REQUEST_BYTES = 10_000_000
DEADLINE_SECONDS = 120


@metrics.measured('request')
def request_bytes(task, media):
    if not isinstance(media, bytes) or not 0 < len(media) <= MAX_MEDIA_BYTES:
        raise ContractError("pilot media byte limit")
    value = build_request(task, media)
    forbidden = {"temperature", "topP", "topK", "candidateCount",
                 "frequencyPenalty", "presencePenalty"}
    if forbidden & set(value["generationConfig"]):
        raise ContractError("deprecated or unsupported generation parameter")
    body = canonical(value)
    if len(body) > MAX_REQUEST_BYTES:
        raise ContractError("pilot encoded request byte limit")
    return body


class DirectTransport:
    """A single direct TLS request with a whole-operation deadline, no HTTP retries."""
    is_simulated_transport = False

    def __init__(self):
        self._sent = False

    def send(self, url, body, token):
        if self._sent:
            raise ContractError("provider transport already consumed")
        if not re.fullmatch(
            r"https://aiplatform\.googleapis\.com/v1beta1/projects/"
            r"[a-z][a-z0-9-]{4,61}[a-z0-9]/locations/global/publishers/google/"
            r"models/gemini-3\.8-flash:generateContent", url):
            raise ContractError("unapproved inference endpoint")
        if not isinstance(body, bytes) or len(body) > MAX_REQUEST_BYTES:
            raise ContractError("request bound")
        if not isinstance(token, str) or not token or any(c in token for c in "\r\n"):
            raise ContractError("invalid token")
        self._sent = True
        connection = http.client.HTTPSConnection(
            "aiplatform.googleapis.com", timeout=DEADLINE_SECONDS,
            context=ssl.create_default_context())
        # A single-process CLI uses SIGALRM to bound DNS, TLS, send and body capture.
        # Unlike per-read socket timeouts, a slow peer cannot extend this deadline.
        if signal.getitimer(signal.ITIMER_REAL)[0] != 0:
            raise ContractError("existing process deadline conflicts with provider boundary")
        previous_handler = signal.getsignal(signal.SIGALRM)
        def abort(_signum, _frame):
            raise TimeoutError("provider whole-operation deadline")
        signal.signal(signal.SIGALRM, abort)
        signal.setitimer(signal.ITIMER_REAL, DEADLINE_SECONDS)
        deadline = time.monotonic() + DEADLINE_SECONDS
        try:
            connection.connect()
            connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
            connection.request("POST", url.removeprefix("https://aiplatform.googleapis.com"),
                               body=body, headers={"Authorization": "Bearer " + token,
                                                   "Content-Type": "application/json",
                                                   "x-goog-user-project": url.split("/projects/", 1)[1].split("/", 1)[0]})
            result = connection.getresponse()
            captured = bytearray()
            truncated = False
            while len(captured) <= MAX_RESPONSE_BYTES:
                if time.monotonic() >= deadline:
                    raise TimeoutError("provider deadline")
                part = result.read1(min(65536, MAX_RESPONSE_BYTES + 1 - len(captured)))
                if not part:
                    break
                captured.extend(part)
            truncated = len(captured) > MAX_RESPONSE_BYTES
            headers = {k.lower(): v for k, v in result.getheaders()
                       if k.lower() in {"content-type", "x-request-id", "x-goog-request-id"}}
            return Response(result.status, bytes(captured[:MAX_RESPONSE_BYTES]), headers, truncated)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            connection.close()


def bounded_auth_token(get_token):
    """Bound the reused strict OAuth/IAM exchange without credentials in subprocesses."""
    if signal.getitimer(signal.ITIMER_REAL)[0] != 0:
        raise ContractError("existing deadline conflicts with authentication boundary")
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_signum, _frame):
        raise TimeoutError("authentication whole-operation deadline")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 30)
    try:
        return get_token()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def validate_usage(value):
    """Keep exact vendor metadata, reject malformed token counts; do not invent cost."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ContractError("usage metadata must be an object")
    def inspect(obj):
        if isinstance(obj, dict):
            for key, item in obj.items():
                if key.endswith("TokenCount") or key == "tokenCount":
                    if type(item) is not int or item < 0:
                        raise ContractError("invalid provider token count")
                inspect(item)
        elif isinstance(obj, list):
            for item in obj:
                inspect(item)
    inspect(value)
    if all(key in value for key in ("promptTokenCount", "candidatesTokenCount", "totalTokenCount")):
        if value["totalTokenCount"] < value["promptTokenCount"] + value["candidatesTokenCount"]:
            raise ContractError("provider total token count inconsistent")
    return copy.deepcopy(value)


def parse_response(response, *, duration, synthetic=False, governance_separate=False):
    if response.truncated or len(response.body) > MAX_RESPONSE_BYTES:
        raise ContractError("provider response truncated")
    if response.status != 200:
        raise ContractError("provider HTTP " + str(response.status))
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise ContractError("provider JSON Content-Type required")
    outer = parse_json(response.body)
    if not isinstance(outer, dict) or outer.get("error"):
        raise ContractError("provider rejected or blocked response")
    feedback = outer.get("promptFeedback", {})
    if not isinstance(feedback, dict) or feedback.get("blockReason"):
        raise ContractError("provider prompt feedback blocked or malformed")
    candidates = outer.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != 1 or not isinstance(candidates[0], dict):
        raise ContractError("exactly one response candidate")
    candidate = candidates[0]
    if candidate.get("finishReason") != "STOP":
        raise ContractError("provider completion is not STOP")
    ratings = candidate.get("safetyRatings", [])
    if not isinstance(ratings, list) or any(not isinstance(r, dict) or r.get("blocked") is True for r in ratings):
        raise ContractError("blocked or malformed safety ratings")
    content = candidate.get("content")
    if not isinstance(content, dict) or content.get("role", "model") != "model":
        raise ContractError("provider content role")
    parts = content.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ContractError("empty model response")
    # Thinking parts are not the answer. Accept and ignore their opaque signature,
    # but never execute tools or merge thoughts into the structured payload.
    answer = []
    for part in parts:
        if not isinstance(part, dict) or not set(part) <= {"text", "thought", "thoughtSignature"}:
            raise ContractError("non-text/tool response forbidden")
        if "thought" in part and type(part["thought"]) is not bool:
            raise ContractError("malformed thought flag")
        if "thoughtSignature" in part and not isinstance(part["thoughtSignature"], str):
            raise ContractError("malformed thought signature")
        if "text" in part and not isinstance(part["text"], str):
            raise ContractError("malformed model text")
        if part.get("thought") is not True and part.get("text"):
            answer.append(part["text"])
    if not answer:
        raise ContractError("no structured answer")
    payload = parse_json("".join(answer))
    if governance_separate:
        from governance import validate_content
        validate_content(payload, duration)
    else:
        validate_payload(payload, duration)
    model = outer.get("modelVersion")
    if not isinstance(model, str) or not model:
        raise ContractError("modelVersion required for provenance")
    if not synthetic and not re.fullmatch(r"gemini-3\.8-flash(?:-[0-9]{3})?", model):
        raise ContractError("unexpected provider modelVersion")
    validate_usage(outer.get("usageMetadata"))
    return outer, payload
