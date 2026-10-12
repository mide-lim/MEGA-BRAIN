#!/usr/bin/env python3
"""Apply a reviewed overlay to the pinned Paperclip image, failing on source drift."""
import argparse
import hashlib
from pathlib import Path

EXPECTED = {
    "packages/adapters/codex-local/src/server/codex-home.ts": "d013f3334e7a7822dcf0aa4c5753c68be9d79fe4b49d964a4d3f8d57bd72a353",
    "server/src/services/heartbeat.ts": "ca824cac19a745bf96931eef59fb84408c795ecb8922b4d092044f1dec056ec5",
    "server/dist/services/heartbeat.js": "2e1b0ad8d773172b9d4a888aa32cc10efb519b9e1326b532969ef1f83c9b5e58",
    "server/src/services/recovery/service.ts": "fdcf5cb37d08bd9eb49d8a28580a770485a37306822052b9d18f71c7f3bb6d56",
    "server/dist/services/recovery/service.js": "20c276385ac361f9fab887c20daa001360c824337f84c87430cb8997f030a108",
}
PILOT_MATCH = 'agent.adapterType === "codex_local" && parseObject(agent.adapterConfig).command === "/usr/local/bin/codex-pilot"'
GUARD = """
        // This launcher requires a new operator authorization for every attempt.
        if (PILOT_MATCH) {
            return {
                outcome: "not_scheduled",
                errorCode: "pilot_manual_authorization_required",
                reason: "Pilot execution requires a new manual authorization; automatic retry is disabled",
            };
        }
""".replace("PILOT_MATCH", PILOT_MATCH)
CLASSIFY = """
        const pilotAdmissionRejected =
            PILOT_MATCH &&
            adapterResult.exitCode === 78 &&
            typeof adapterResult.errorMessage === "string" &&
            adapterResult.errorMessage.startsWith("Pilot:");
""".replace("PILOT_MATCH", PILOT_MATCH)

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("Upstream patch anchor must occur exactly once")
    return text.replace(old, new, 1)

def transform(path, text):
    if path.endswith("codex-home.ts"):
        return replace_once(text, "`headers = { Authorization =", "`http_headers = { Authorization =")
    if path.endswith(("heartbeat.ts", "heartbeat.js")):
        if path.endswith(".js"):
            anchor = "async function scheduleBoundedRetryForRun(run, agent, opts) {"
            text = replace_once(text, anchor, anchor + GUARD)
        else:
            start = text.index("  async function scheduleBoundedRetryForRun(")
            end = text.index("    const now = opts?.now ?? new Date();", start)
            typed_guard = GUARD.replace('outcome: "not_scheduled",', 'outcome: "not_scheduled" as const,').replace('errorCode: "pilot_manual_authorization_required",', 'errorCode: "pilot_manual_authorization_required" as const,')
            text = text[:end] + typed_guard + text[end:]
        if path.endswith(".js"):
            text = replace_once(text, "                const runErrorCode = outcome", CLASSIFY + "                const runErrorCode = outcome")
        else:
            text = replace_once(text, "        const runErrorCode =\n", CLASSIFY + "        const runErrorCode =\n")
        text = replace_once(text, "(adapterResult.errorCode ??", '(pilotAdmissionRejected ? "pilot_admission_rejected" : adapterResult.errorCode) ?? (')
        # Parenthesize the coalescing expression without changing its outcome.
        # Existing trailing parenthesis closes the new fallback expression.
        return text
    anchor = 'const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set'
    start = text.index(anchor)
    bracket = text.index("[", start)
    return text[:bracket + 1] + '\n  "pilot_admission_rejected",' + text[bracket + 1:]

def apply(root):
    updated = {}
    for relative, expected in EXPECTED.items():
        path = root / relative
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("Pinned upstream hash mismatch: " + relative)
        updated[path] = transform(relative, raw.decode())
    # Verify all inputs before writing any file.
    for path, content in updated.items():
        path.write_text(content)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/app"))
    args = parser.parse_args()
    apply(args.root.resolve())
    print("Pinned Paperclip single-attempt overlay applied")
