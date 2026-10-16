#!/usr/bin/env python3
"""Linux-only bounded subprocess supervisor. Receipt is private fd 3, never tool IO."""
import ctypes
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time

interrupted = False


def stop(_signum, _frame):
    global interrupted
    interrupted = True


def enable_subreaper():
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Linux subreaper required")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "subreaper unavailable")
    value = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(value), 0, 0, 0) != 0 or value.value != 1:
        raise RuntimeError("subreaper not verified")


def kill_children():
    # Killing direct children makes their descendants ours, even after setsid.
    # pidfds prevent a reused PID from receiving a delayed signal.
    path = "/proc/self/task/%s/children" % os.getpid()
    with open(path, encoding="ascii") as stream:
        children = stream.read().split()
    for value in children:
        pid = int(value)
        try:
            descriptor = os.pidfd_open(pid)
            try:
                with open(path, encoding="ascii") as stream:
                    still_child = value in stream.read().split()
                if still_child:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            finally:
                os.close(descriptor)
        except ProcessLookupError:
            pass


def main():
    os.set_inheritable(3, False)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raw = sys.stdin.buffer.readline(1048578)
    if len(raw) > 1048577 or not raw.endswith(b"\n"):
        return 2
    request = json.loads(raw)
    nonce = request["nonce"]
    limit, timeout = request["max_buffer"], request["timeout"]
    if (not isinstance(nonce, str) or len(nonce) != 64 or
            type(limit) is not int or not 1 <= limit <= 16777216 or
            type(timeout) is not int or not 1 <= timeout <= 600000):
        return 2
    enable_subreaper()  # Must succeed and be verified before the tool exists.
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return 2
    if interrupted:
        return 2
    started = time.monotonic()
    selector = None
    captured = [bytearray(), bytearray()]
    reason = None
    exit_code = None
    no_children = False
    cleanup_started = None
    child = subprocess.Popen(
        [request["file"], *request["args"]], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        cwd=request["cwd"], env=request["env"], start_new_session=True)
    # Guard every initialization step after Popen: selector construction and
    # registration can fail (including EMFILE) while the tool is already alive.
    try:
        selector = selectors.DefaultSelector()
        for index, stream in enumerate((child.stdout, child.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, index)
        while True:
            if interrupted:
                reason = reason or "interrupted"
            if time.monotonic() - started >= timeout / 1000:
                reason = reason or "timeout"
            if reason:
                cleanup_started = cleanup_started or time.monotonic()
                kill_children()
            # ECHILD, after subreaper adoption, is the positive tree boundary.
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    no_children = True
                    break
                except InterruptedError:
                    continue
                if pid == 0:
                    break
                if pid == child.pid:
                    exit_code = os.waitstatus_to_exitcode(status)
                    child.returncode = exit_code
            for key, _events in selector.select(0.01):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                index = key.data
                available = limit - len(captured[index])
                captured[index].extend(block[:max(0, available)])
                if len(block) > available:
                    reason = reason or "output_limit"
            if no_children and not selector.get_map():
                break
            if cleanup_started and time.monotonic() - cleanup_started > 0.8:
                return 2  # Cleanup uncertainty can never become positive proof.
    finally:
        # Release descriptors before cleanup so EMFILE cannot prevent opening
        # /proc children or pidfds. A close failure must not bypass tree cleanup.
        close_error = None
        for resource in (selector, child.stdout, child.stderr):
            if resource is not None:
                try:
                    resource.close()
                except Exception as error:
                    close_error = error
        if not no_children:
            # Unexpected local IO failures still attempt bounded tree cleanup.
            deadline = time.monotonic() + 0.8
            while time.monotonic() < deadline:
                kill_children()
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == child.pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
                if pid == 0:
                    time.sleep(0.01)
        if close_error is not None:
            raise close_error
    if exit_code is None:
        return 2
    if exit_code < 0:
        reason = reason or "interrupted"
    stdout, stderr = map(bytes, captured)
    sys.stdout.buffer.write(stdout)
    sys.stdout.buffer.flush()
    sys.stderr.buffer.write(stderr)
    sys.stderr.buffer.flush()
    receipt = {
        "v": 1, "nonce": nonce, "status": reason or "normal",
        "exit_code": exit_code, "subreaper": True,
        "wait": "ECHILD" if no_children else None,
        "stdout_bytes": len(stdout), "stderr_bytes": len(stderr),
        "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
        "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
    }
    os.write(3, json.dumps(receipt, separators=(",", ":")).encode("ascii"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never emit executable/arguments, paths, environment or raw exception text.
        sys.exit(2)
