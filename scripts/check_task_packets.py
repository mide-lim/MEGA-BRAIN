"""Validate bounded task packets and optionally audit changed paths; no model calls."""
import argparse
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

SHA = re.compile(r"[0-9a-f]{40}")
REPO = "mide-lim/MEGA-BRAIN"


def relative_path(value, root, directory=False):
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        raise ValueError("path must be relative and non-empty")
    clean = value[:-1] if directory and value.endswith("/") else value
    parts = clean.split("/")
    if any(part in ("", ".", "..", ".git", "backups", "node_modules") or part.startswith(".env") or part in ("auth.json", "hosts.yml") for part in parts):
        raise ValueError("unsafe or private path")
    if any(c in clean for c in "*?[]<>:"):
        raise ValueError("path placeholders and globbing are forbidden")
    if not (root / clean).resolve().is_relative_to(root):
        raise ValueError("path escapes the repository")
    return value


def text_list(value, name):
    if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(name + " must contain non-empty strings")


def validate(packet, root):
    if not isinstance(packet, dict) or packet.get("schema_version") != 1:
        raise ValueError("schema_version must be 1")
    if not re.fullmatch(r"MEG-[1-9][0-9]*", str(packet.get("id", ""))):
        raise ValueError("id must be a MEGA-BRAIN issue identifier")
    uuid.UUID(packet["paperclip_issue_id"])
    if packet.get("repository") != REPO:
        raise ValueError("packet belongs to a different repository")
    if not SHA.fullmatch(str(packet.get("base_commit", ""))):
        raise ValueError("base_commit must be a full immutable SHA")
    if not isinstance(packet.get("objective"), str) or not packet["objective"].strip():
        raise ValueError("objective is required")
    text_list(packet.get("acceptance_criteria"), "acceptance_criteria")
    text_list(packet.get("validation_commands"), "validation_commands")
    text_list(packet.get("allowed_paths"), "allowed_paths")
    for path in packet["allowed_paths"]:
        relative_path(path, root, directory=True)
    context = packet.get("context")
    if not isinstance(context, list) or not 1 <= len(context) <= 8:
        raise ValueError("context must contain 1 to 8 references")
    total = 0
    for item in context:
        if not isinstance(item, dict):
            raise ValueError("context reference must be an object")
        path = relative_path(item.get("path"), root)
        if not (root / path).is_file():
            raise ValueError("context file is missing")
        if not isinstance(item.get("reason"), str) or not item["reason"].strip():
            raise ValueError("context reason is required")
        text_list(item.get("sections"), "context sections")
        chars = item.get("max_chars")
        if type(chars) is not int or not 1 <= chars <= 12000:
            raise ValueError("invalid planned context size")
        total += chars
    if total > 12000:
        raise ValueError("planned selected context exceeds 12000 characters")
    budget = packet.get("execution_budget", {})
    for key in ("worker_runs", "reviewer_runs", "fix_runs"):
        if type(budget.get(key)) is not int or not 0 <= budget[key] <= 1:
            raise ValueError(key + " must be 0 or 1")
    if sum(budget[key] for key in ("worker_runs", "reviewer_runs", "fix_runs")) > 2:
        raise ValueError("packet model budget exceeds two executions")
    if type(budget.get("timeout_minutes")) is not int or not 1 <= budget["timeout_minutes"] <= 15:
        raise ValueError("timeout exceeds the pilot policy")
    if budget.get("reasoning") not in ("low", "medium", "high"):
        raise ValueError("reasoning must be explicit")
    risk = packet.get("risk")
    review = packet.get("review", {})
    if risk not in ("low", "medium", "high"):
        raise ValueError("risk must be explicit")
    mode = review.get("mode")
    if mode not in ("human", "independent_human", "independent_agent", "independent_agent_and_human"):
        raise ValueError("review mode must be explicit")
    if risk in ("medium", "high") and mode == "human":
        raise ValueError("non-low risk requires independent review")
    if mode.startswith("independent_agent") and budget["reviewer_runs"] != 1:
        raise ValueError("model review requires a reserved reviewer execution")
    if review.get("status") not in ("pending", "approved", "changes_requested", "blocked"):
        raise ValueError("review status must be explicit")
    if not isinstance(review.get("reason"), str) or not review["reason"].strip():
        raise ValueError("review reason is required")
    return packet


def audit_diff(packet, root, base, head):
    if base != packet["base_commit"] or not SHA.fullmatch(base):
        raise ValueError("diff base must match the packet")
    if head != "HEAD" and not SHA.fullmatch(head):
        raise ValueError("diff head must be HEAD or a full SHA")
    result = subprocess.run(["git", "-C", str(root), "diff", "--name-only", "-z", base, head, "--"], check=True, capture_output=True)
    changed = result.stdout.decode().split("\0")
    for path in filter(None, changed):
        relative_path(path, root)
        if not any(path == allowed or (allowed.endswith("/") and path.startswith(allowed)) for allowed in packet["allowed_paths"]):
            raise ValueError("changed path outside packet scope: " + path)
    return len(list(filter(None, changed)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--packet", type=Path)
    parser.add_argument("--diff-base")
    parser.add_argument("--diff-head", default="HEAD")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.diff_base and not args.packet:
        parser.error("--diff-base requires --packet")
    paths = [args.packet.resolve()] if args.packet else sorted((root / "tasks").glob("*.json"))
    if not paths:
        print("No task packets found", file=sys.stderr)
        return 1
    try:
        for path in paths:
            packet = validate(json.loads(path.read_text()), root)
            print("Valid packet:", packet["id"])
            if args.diff_base:
                print("Changed paths within scope:", audit_diff(packet, root, args.diff_base, args.diff_head))
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print("Task packet rejected:", str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
