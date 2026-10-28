"""Run the signed-grant/ledger/provider/writer chain with synthetic data only."""
import ast
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "operations/reels-analysis-ci"))
from verify_public import scan_text
def main():
    assert os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net"), "isolated network namespace required"
    inventory = json.loads((Path(__file__).with_name("pilot-public-files.json")).read_text())
    expected = set(inventory["files"])
    actual = {p.relative_to(ROOT).as_posix() for p in (ROOT / "operations/reels-pilot").rglob("*") if p.is_file()}
    assert actual == expected, "pilot public surface changed without review"
    for name in sorted(actual):
        p = ROOT / name
        assert not p.is_symlink() and not any(x.is_symlink() for x in p.parents)
        raw = p.read_bytes()
        assert len(raw) < 1_000_000 and b"\0" not in raw
        text = raw.decode("utf-8")
        scan_text(name, text)
        if p.suffix == ".py": compile(ast.parse(text), name, "exec")
        if p.suffix == ".json": json.loads(text)
    with tempfile.TemporaryDirectory(prefix="pilot-offline-") as value:
        scratch = Path(value)
        scratch.chmod(0o755)  # Public code copies only; allows the actual UID999 denial probe.
        for name in ("reels-pilot", "reels-identity", "reels-analysis-live", "reels-analysis"):
            shutil.copytree(ROOT / "operations" / name, scratch / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "outputs"))
        env = {"PATH":str(Path(sys.executable).parent)+":/usr/bin:/bin", "LANG":"C.UTF-8", "LC_ALL":"C.UTF-8",
               "HOME":str(scratch / "empty-home"), "TMPDIR":str(scratch), "PYTHONDONTWRITEBYTECODE":"1", "PYTHONNOUSERSITE":"1",
               "TZ":"UTC", "OPENSSL_CONF":"/dev/null"}
        Path(env["HOME"]).mkdir()
        done = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"],
                              cwd=scratch / "reels-pilot", env=env, capture_output=True, text=True, timeout=240)
        print(done.stdout, end="")
        print(done.stderr, end="", file=sys.stderr)
        assert done.returncode == 0, "pilot chain failed"
        count = re.search(r"Ran (\d+) tests?", done.stderr)
        assert count and int(count.group(1)) == inventory["expected_tests"] and "\nOK" in done.stderr, "test count differs from reviewed inventory"
    print(json.dumps({"pilot_surface_files":len(actual), "network_namespace":True,
                      "real_credentials_forwarded":False, "real_media":0, "real_provider_calls":0}))
if __name__ == "__main__": main()
