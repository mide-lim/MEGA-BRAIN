"""Security boundary regression tests; Codex is always stubbed."""
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch
import check_task_packets as policy

ROOT = Path(__file__).resolve().parents[1]

class PacketTests(unittest.TestCase):
    def setUp(self):
        self.packet = json.loads((ROOT / "tasks/MEG-2.json").read_text())

    def test_valid_packet(self):
        policy.validate(self.packet, ROOT)

    def test_private_and_escaping_paths(self):
        for path in ("../other", "/etc/passwd", ".env", "x/auth.json", ".git/config", "docs/*"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                policy.relative_path(path, ROOT)

    def test_other_repository(self):
        self.packet["repository"] = "mide-lim/OTHER"
        with self.assertRaises(ValueError): policy.validate(self.packet, ROOT)

    def test_context_and_execution_caps(self):
        for mutate in (lambda p: p["context"][0].update(max_chars=12001),
                       lambda p: p["execution_budget"].update(worker_runs=2),
                       lambda p: p["review"].update(mode="human")):
            packet = copy.deepcopy(self.packet)
            mutate(packet)
            with self.assertRaises(ValueError): policy.validate(packet, ROOT)

    def test_diff_rejects_outside_scope(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"outside.txt\0")
        with patch.object(policy.subprocess, "run", return_value=result), self.assertRaises(ValueError):
            policy.audit_diff(self.packet, ROOT, self.packet["base_commit"], "HEAD")

    def test_diff_accepts_exact_and_directory_paths(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"AGENTS.md\0ops/paperclip/codex-pilot\0")
        with patch.object(policy.subprocess, "run", return_value=result):
            self.assertEqual(policy.audit_diff(self.packet, ROOT, self.packet["base_commit"], "HEAD"), 2)

class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pilot = self.root / "pilot"
        self.repo = self.root / "repo"
        self.auth = self.root / "auth"
        for directory in (self.pilot, self.repo / "tasks", self.auth): directory.mkdir(parents=True)
        (self.auth / "auth.json").write_text(json.dumps({"tokens": {"fixture": True}}))
        self.packet = json.loads((ROOT / "tasks/MEG-2.json").read_text())
        self.packet["execution_budget"]["worker_runs"] = 1
        self.file = self.repo / "tasks/MEG-2.json"
        self.file.write_text(json.dumps(self.packet))
        self.permit = {"role": "worker", "issueId": self.packet["paperclip_issue_id"],
                       "packetPath": str(self.file), "packetSha256": hashlib.sha256(self.file.read_bytes()).hexdigest(),
                       "expiresAt": 100900}
        self.source = (ROOT / "ops/paperclip/codex-pilot").read_text().replace("'/paperclip/pilot'", repr(str(self.pilot))).replace("'/workspaces/MEGA-BRAIN'", repr(str(self.repo)))
        self.model_calls = 0
        self.preflight_result = 0

    def run_launcher(self, args=None, permit=True, extra_env=None):
        if permit: (self.pilot / "allow-once").write_text(json.dumps(self.permit))
        env = {"CODEX_HOME": str(self.auth), "PAPERCLIP_TASK_ID": self.packet["paperclip_issue_id"]}
        env.update(extra_env or {})
        def run(command, **kwargs):
            if command[0] == "python3": return subprocess.CompletedProcess(command, self.preflight_result)
            self.model_calls += 1
            self.assertNotIn("DATABASE_URL", kwargs["env"])
            return subprocess.CompletedProcess(command, 0)
        with patch.dict(os.environ, env, clear=True), patch.object(sys, "argv", ["codex-pilot"] + (args or ["exec", "task"])), patch("time.time", return_value=100000), patch("subprocess.run", side_effect=run), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                exec(compile(self.source, "codex-pilot", "exec"), {"__name__": "__main__"})
        return result.exception.code

    def test_valid_permit_consumed_and_recorded(self):
        self.assertEqual(self.run_launcher(extra_env={"DATABASE_URL": "fixture"}), 0)
        self.assertEqual(self.model_calls, 1)
        self.assertFalse((self.pilot / "allow-once").exists())
        self.assertEqual(len(json.loads((self.pilot / "launches.json").read_text())), 1)
        self.assertEqual(json.loads((self.pilot / "packet-launches.json").read_text())[0]["issueId"], self.packet["paperclip_issue_id"])

    def test_no_permit(self):
        self.assertEqual(self.run_launcher(permit=False), 78)
        self.assertEqual(self.model_calls, 0)

    def test_wrong_task_expired_or_changed_packet(self):
        for change in ({"issueId": "other"}, {"expiresAt": 99999}, {"packetSha256": "wrong"}, {"role": "reviewer"}):
            with self.subTest(change=change):
                original = self.permit.copy()
                self.permit.update(change)
                self.assertEqual(self.run_launcher(), 78)
                self.permit = original
        self.assertEqual(self.model_calls, 0)

    def test_preflight_failure_and_zero_budget(self):
        self.preflight_result = 1
        self.assertEqual(self.run_launcher(), 78)
        self.preflight_result = 0
        self.packet["execution_budget"]["worker_runs"] = 0
        self.file.write_text(json.dumps(self.packet))
        self.permit["packetSha256"] = hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.assertEqual(self.run_launcher(), 78)
        self.assertEqual(self.model_calls, 0)

    def test_preflight_failure_consumes_permit_without_model(self):
        self.preflight_result = 1
        self.assertEqual(self.run_launcher(), 78)
        self.assertFalse((self.pilot / "allow-once").exists())
        self.preflight_result = 0
        self.assertEqual(self.run_launcher(permit=False), 78)
        self.assertEqual(self.model_calls, 0)

    def test_two_entries_in_rolling_window(self):
        (self.pilot / "launches.json").write_text(json.dumps([96000, 92000]))
        self.assertEqual(self.run_launcher(), 78)
        self.assertEqual(self.model_calls, 0)

    def test_concurrent_entry_denied(self):
        import fcntl
        with open(self.pilot / "launch.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_launcher(), 78)
        self.assertEqual(self.model_calls, 0)

    def test_global_and_task_limits(self):
        (self.pilot / "launches.json").write_text(json.dumps([99000]))
        self.assertEqual(self.run_launcher(), 78)
        (self.pilot / "launches.json").unlink()
        (self.pilot / "packet-launches.json").write_text(json.dumps([{"issueId": self.permit["issueId"], "role": "worker"}]))
        self.assertEqual(self.run_launcher(), 78)
        self.assertEqual(self.model_calls, 0)

    def test_paid_api_and_sandbox_bypass(self):
        self.assertEqual(self.run_launcher(extra_env={"OPENAI_API_KEY": "fixture"}), 78)
        for args in (["exec", "--yolo"], ["exec", "--sandbox=danger-full-access"], ["app-server"]):
            self.assertEqual(self.run_launcher(args=args), 78)
        self.assertEqual(self.model_calls, 0)

class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        import types
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        (self.repo / "tasks").mkdir(parents=True)
        self.state = self.root / "state"
        self.state.mkdir()
        self.packet = json.loads((ROOT / "tasks/MEG-2.json").read_text())
        self.packet["execution_budget"]["worker_runs"] = 1
        self.file = self.repo / "tasks/MEG-2.json"
        self.file.write_text(json.dumps(self.packet))
        self.ids = self.root / "ids.json"
        self.ids.write_text(json.dumps({"projectId": "fixture-project", "agentId": "fixture-agent"}))
        self.api_calls = []
        def api(path):
            self.api_calls.append(path)
            if path.startswith("issues/"):
                return {"projectId":"fixture-project", "identifier": self.packet["id"], "status":"todo"}
            return {"status":"paused"}
        self.module = types.ModuleType("admin_api")
        self.module.api = api
        self.source = (ROOT / "ops/paperclip/authorize-packet.py").read_text()
        self.source = self.source.replace("'/srv/paperclip/workspaces/MEGA-BRAIN'", repr(str(self.repo))).replace("'/srv/paperclip/data/pilot'", repr(str(self.state))).replace("'/opt/paperclip/pilot.json'", repr(str(self.ids)))
        self.worker_code = 0
        self.root_code = 0
        self.commands = []

    def run_authorizer(self):
        from contextlib import redirect_stdout
        def run(command, **kwargs):
            self.commands.append(command)
            if command[0] == "python3":
                return subprocess.CompletedProcess(command, self.root_code)
            if "git" in command:
                return subprocess.CompletedProcess(command, 0, stdout=self.packet["base_commit"] + "\n")
            self.assertIn("--user", command)
            self.assertIn("1000:1000", command)
            return subprocess.CompletedProcess(command, self.worker_code)
        with patch.dict(sys.modules, {"admin_api": self.module}), patch.object(sys, "argv", ["authorize-packet.py", "--packet", str(self.file), "--role", "worker", "--dry-run"]), patch("subprocess.run", side_effect=run), patch("time.time", return_value=100000), redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                exec(compile(self.source, "authorize-packet.py", "exec"), {"__name__":"__main__"})
        return result.exception.code

    def test_root_pass_worker_fail_no_authorization(self):
        self.worker_code = 1
        self.assertEqual(self.run_authorizer(), "Worker UID preflight failed; no authorization created")
        self.assertFalse((self.state / "allow-once").exists())
        self.assertEqual(self.api_calls, [])

    def test_worker_pass_dry_run_never_emits_permit(self):
        self.assertEqual(self.run_authorizer(), 0)
        self.assertFalse((self.state / "allow-once").exists())
        self.assertEqual(sum("1000:1000" in command and "python3" in command for command in self.commands), 1)

    def test_global_limit_prevents_authorization(self):
        (self.state / "launches.json").write_text(json.dumps([92000, 96000]))
        self.assertEqual(self.run_authorizer(), "Global execution limit reached")
        self.assertFalse((self.state / "allow-once").exists())

    def test_root_failure_stops_before_worker(self):
        self.root_code = 1
        self.assertEqual(self.run_authorizer(), "Preflight failed; no authorization created")
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.api_calls, [])


if __name__ == "__main__": unittest.main()
