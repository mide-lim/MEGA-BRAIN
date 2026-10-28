"""Reviewable allowlist, syntax, schemas, dependency hashes and workflow checks."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
CI = Path(__file__).resolve().parent

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def load(name):
    return json.loads((CI / name).read_text())

def scan_text(name, text):
    # Build path signatures from fragments so the scanner can scan itself too.
    private_prefixes = ("/" + "srv" + "/", "/" + "paperclip" + "/",
                        "/" + "root" + "/" + "dev_", "C:" + "\\" + "Users" + "\\")
    patterns = [
        r"AIza[0-9A-Za-z_-]{30,}", r"gh[pousr]_[0-9A-Za-z]{20,}",
        r"github_pat_[0-9A-Za-z_]{20,}", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        r"ya29\.[0-9A-Za-z_-]{20,}", r"\b[0-9]{6}-[0-9]{6}-[0-9]{6}\b",
        r"[a-z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com",
        r"https?://[^\s\"']*(?:cdninstagram|fbcdn)",
        r"https?://(?:www\.)?instagram\.com/(?:p|reel)/",
    ]
    assert not any(prefix in text for prefix in private_prefixes), "private path in " + name
    for pattern in patterns:
        assert not re.search(pattern, text), "secret/private-data signature in " + name

def verify_workflow(workflow, tools):
    # Count ALL uses keys, including unknown/unpinned or inline ones.
    keys = re.findall(r"\buses[ \t]*:", workflow)
    refs = re.findall(r"(?m)^[ \t]*(?:-[ \t]+)?uses:[ \t]*([^\s#]+)", workflow)
    expected = {name + "@" + tools[name]["commit"]
                for name in ("actions/checkout", "actions/setup-python")}
    assert len(keys) == len(refs) == 2 and set(refs) == expected, "unpinned/unknown Action"
    assert all(re.fullmatch(r"[a-zA-Z0-9_/-]+@[0-9a-f]{40}", ref) for ref in refs)
    assert "persist-credentials: false" in workflow
    assert "id-token: none" in workflow and "contents: read" in workflow
    assert "unshare --net" in workflow and "--require-network-namespace" in workflow
    assert "pull_request_target" not in workflow and "workflow_dispatch" not in workflow
    assert not re.search(r"secrets\.|id-token:\s*write|google-github-actions|environment:\s*production", workflow)
    assert "python-version: '" + tools["python"]["version"] + "'" in workflow
    assert "--require-hashes" in workflow and "--no-deps" in workflow

def verify_public():
    inventory = load("public-files.json")
    required = set(inventory["required_files"])
    optional = set(inventory["optional_files"])
    allowed = required | optional
    actual = set()
    for subtree in ("operations/reels-analysis", "operations/reels-analysis-live",
                    "operations/reels-analysis-ci", "docs/reels-analysis"):
        base = ROOT / subtree
        if not base.exists():
            continue
        for directory, directories, files in os.walk(base, followlinks=False):
            for name in directories + files:
                path = Path(directory) / name
                if path.is_symlink():
                    raise AssertionError("symlink in public surface: " + str(path.relative_to(ROOT)))
            for name in files:
                actual.add(str((Path(directory) / name).relative_to(ROOT)))
    actual.add(".github/workflows/reels-analysis-ci.yml")
    assert required <= actual, "required public files missing: " + str(sorted(required - actual))
    assert actual <= allowed, "non-allowlisted public files: " + str(sorted(actual - allowed))
    forbidden_names = {"runtime", "outputs", "journals", "evidence", ".env", "auth.json",
                       "current-state.json", "implementation-receipt.json"}
    for name in sorted(actual):
        path = ROOT / name
        assert not set(Path(name).parts) & forbidden_names, "private/runtime filename: " + name
        assert "candidate-" not in path.name and "root-mock" not in path.name, "private example"
        data = path.read_bytes()
        assert len(data) < 1_000_000 and b"\0" not in data, "binary/oversized public artifact: " + name
        text = data.decode("utf-8")
        scan_text(name, text)
        if path.suffix == ".py":
            ast.parse(text, filename=name)
            compile(text, name, "exec")  # Syntax only; never import live code.
        elif path.name.endswith(".schema.json"):
            Draft202012Validator.check_schema(json.loads(text))
        elif path.suffix == ".json":
            json.loads(text)
    for module, example in (("reels-analysis", "offline-task.json"),
                            ("reels-analysis-live", "stored-video.preparation.json")):
        task = json.loads((ROOT / "operations" / module / "examples" / example).read_text())
        assert task["reel_id"].startswith("synthetic-"), "non-synthetic example identity"
    provenance = load("source-provenance.json")
    for row in provenance["public_file_mappings"]:
        assert row["repository_path"] in allowed
        assert not Path(row["source_relative_path"]).is_absolute()
        assert re.fullmatch(r"[0-9a-f]{64}", row["source_sha256"])
        assert digest(ROOT / row["repository_path"]) == row["repository_sha256"], "provenance mismatch"
    tools = load("toolchain.json")
    expected_lock = [p["package"] + "==" + p["version"] + " --hash=sha256:" + p["sha256"]
                     for p in tools["offline_dependencies"]["packages"]]
    assert (CI / "requirements.offline.lock.txt").read_text().splitlines() == expected_lock
    assert len(expected_lock) == 5
    assert not any(("google-auth==" in row or "requests==" in row) for row in expected_lock)
    verify_workflow((ROOT / ".github/workflows/reels-analysis-ci.yml").read_text(), tools)
    return {"public_files": len(actual), "mapped_source_files": len(provenance["public_file_mappings"]),
            "offline_dependencies": len(expected_lock), "schema_and_syntax": "passed"}

if __name__ == "__main__":
    print(json.dumps(verify_public(), sort_keys=True))
