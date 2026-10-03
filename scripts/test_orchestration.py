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

if __name__ == "__main__": unittest.main()
