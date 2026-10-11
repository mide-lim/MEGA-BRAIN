#!/usr/bin/env python3
"""Export committed source only and record LF-normalized file hashes."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
destination = args.output.resolve()
if destination.exists() and any(destination.iterdir()):
    raise SystemExit("Build context must be absent or empty.")
destination.mkdir(parents=True, exist_ok=True)
archive = subprocess.check_output(["git", "-C", str(root), "archive", "--format=tar", "HEAD:google-v0"])
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
    source.extractall(destination, filter="data")
records = []
for path in sorted(destination.rglob("*")):
    if path.is_symlink():
        raise SystemExit("Symlinks are not accepted in the release context.")
    if not path.is_file():
        continue
    data = path.read_bytes()
    try:
        if b"\0" in data:
            raise UnicodeError()
        data.decode("utf-8")
        normalized = data.replace(b"\r\n", b"\n")
        if normalized != data:
            path.write_bytes(normalized)
        data = normalized
    except UnicodeError:
        pass
    records.append({"path": path.relative_to(destination).as_posix(), "sha256": hashlib.sha256(data).hexdigest()})
manifest = {"schema_version": 1, "commit": commit, "source_directory": "google-v0",
            "text_normalization": "UTF-8 text uses LF; binary files retain their bytes", "files": records}
manifest_path = destination / "config/release-source-manifest.json"
manifest_path.parent.mkdir(parents=True, exist_ok=True)
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"commit": commit, "files": len(records)}))
