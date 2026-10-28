"""Inherited Python guard for offline suites and their Python subprocesses."""
import builtins
import os
from pathlib import Path
import sys

if os.environ.get("REELS_OFFLINE_CI") == "1":
    _original_import = builtins.__import__
    _python = os.path.realpath(sys.executable)
    _auth_modules = ("google.auth", "google.oauth2", "google.genai", "google.cloud")

    def _guarded_import(name, *args, **kwargs):
        if any(name == item or name.startswith(item + ".") for item in _auth_modules):
            raise RuntimeError("OFFLINE_GUARD_AUTH")
        return _original_import(name, *args, **kwargs)

    builtins.__import__ = _guarded_import

    def _python_only(executable, arguments):
        if os.path.realpath(os.fsdecode(executable)) != _python:
            raise RuntimeError("OFFLINE_GUARD_PROCESS")
        if isinstance(arguments, (str, bytes)) or any(arg in ("-S", "-I", "-E") for arg in arguments):
            raise RuntimeError("OFFLINE_GUARD_PROCESS_FLAGS")

    def _audit(event, args):
        if event.startswith("socket."):
            raise RuntimeError("OFFLINE_GUARD_NETWORK")
        if event == "subprocess.Popen":
            _python_only(args[0], args[1])
        if event == "os.posix_spawn":
            _python_only(args[0], args[1])
        if event in ("os.system", "os.exec", "os.forkpty"):
            raise RuntimeError("OFFLINE_GUARD_PROCESS")
        if event == "open" and args and isinstance(args[0], (str, bytes, os.PathLike)):
            path = os.fsdecode(args[0]).replace("\\", "/").lower()
            if (path.endswith(("/auth.json", "/application_default_credentials.json", "/credentials")) or
                    "/.config/gcloud/" in path or "/.aws/" in path):
                raise RuntimeError("OFFLINE_GUARD_CREDENTIAL_FILE")

    sys.addaudithook(_audit)
