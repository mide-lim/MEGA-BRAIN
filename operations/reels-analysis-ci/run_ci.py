"""Run both offline suites in separate scratch copies and guarded subprocesses."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
sys.dont_write_bytecode = True
from verify_public import verify_public

ROOT = Path(__file__).resolve().parents[2]
CI = Path(__file__).resolve().parent

def environment(scratch):
    # Do not forward credential, cloud, GitHub-token, model-provider or home config.
    return {
        "PATH": str(Path(sys.executable).parent) + os.pathsep + "/usr/bin:/bin",
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
        "TMPDIR": str(scratch), "PYTHONPATH": str(CI / "guard"),
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0", "REELS_OFFLINE_CI": "1",
    }

def probe_guard(scratch, env):
    credential_fixture = scratch / "application_default_credentials.json"
    credential_fixture.write_text('{"synthetic":true}\n')
    cases = {
        "network": ("import socket; socket.create_connection(('127.0.0.1', 1), timeout=0.1)",
                    "OFFLINE_GUARD_NETWORK"),
        "auth": ("import google.auth", "OFFLINE_GUARD_AUTH"),
        "credential_file": ("open(" + repr(str(credential_fixture)) + ").read()",
                            "OFFLINE_GUARD_CREDENTIAL_FILE"),
        "non_python_process": ("import subprocess; subprocess.run(['/bin/true'], check=True)",
                               "OFFLINE_GUARD_PROCESS"),
        "unguarded_child": ("import subprocess,sys; subprocess.run([sys.executable,'-S','-c','pass'],check=True)",
                            "OFFLINE_GUARD_PROCESS_FLAGS"),
    }
    for name, (code, marker) in cases.items():
        completed = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                                   capture_output=True, text=True, timeout=5)
        assert completed.returncode != 0 and marker in completed.stderr, "guard probe failed: " + name
    return len(cases)

def run_module(module, expected, scratch, env):
    source = ROOT / "operations" / module
    target = scratch / module
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "outputs", "*.pyc"))
    (target / "outputs").mkdir()
    completed = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=target, env=env, capture_output=True, text=True, timeout=120)
    output = completed.stdout + completed.stderr
    count = re.search(r"Ran (\d+) tests?", output)
    if completed.returncode or not count or int(count.group(1)) != expected or "\nOK" not in output:
        print(output, file=sys.stderr)
        raise AssertionError(module + " suite failed or count changed")
    return {"module": module, "tests": int(count.group(1)), "status": "passed",
            "separate_process": True, "scratch_copy": True}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-network-namespace", action="store_true")
    args = parser.parse_args()
    if args.require_network_namespace:
        assert os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net"), "network namespace not isolated"
    checks = verify_public()
    with tempfile.TemporaryDirectory(prefix="reels-offline-ci-") as value:
        scratch = Path(value)
        env = environment(scratch)
        probes = probe_guard(scratch, env)
        guard_suite = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", str(CI / "tests"), "-v"],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
        assert guard_suite.returncode == 0, guard_suite.stdout + guard_suite.stderr
        integration_count = re.search(r"Ran (\d+) tests?", guard_suite.stdout + guard_suite.stderr)
        assert integration_count, "integration test count missing"
        suites = [run_module("reels-analysis", 36, scratch, env),
                  run_module("reels-analysis-live", 54, scratch, env)]
    print(json.dumps({"public_checks": checks, "guard_probes": probes, "integration_unit_tests": int(integration_count.group(1)), "suites": suites,
                      "module_tests": sum(row["tests"] for row in suites),
                      "total_tests": sum(row["tests"] for row in suites) + int(integration_count.group(1)),
                      "os_network_namespace_required": args.require_network_namespace,
                      "google_auth_or_model_calls": 0}, sort_keys=True))

if __name__ == "__main__":
    main()
