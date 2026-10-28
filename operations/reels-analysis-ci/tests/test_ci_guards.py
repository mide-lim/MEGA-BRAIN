import json
from pathlib import Path
import sys
import unittest

CI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI))
from verify_public import scan_text, verify_workflow

class PublicBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tools = json.loads((CI / "toolchain.json").read_text())
        self.workflow = (CI.parents[1] / ".github/workflows/reels-analysis-ci.yml").read_text()

    def test_current_pinned_workflow_accepted(self):
        verify_workflow(self.workflow, self.tools)

    def test_extra_unpinned_and_unknown_pinned_actions_denied(self):
        for ref in ("example/action@v1", "example/action@" + "0" * 40):
            with self.assertRaises(AssertionError):
                verify_workflow(self.workflow + "\n      - uses: " + ref + "\n", self.tools)
        with self.assertRaises(AssertionError):
            verify_workflow(self.workflow + "\n      - {uses: example/action@v1}\n", self.tools)

    def test_secret_and_private_paths_detected_in_scanner_itself(self):
        name = "operations/reels-analysis-ci/verify_public.py"
        for value in ("AIza" + "X" * 35, "/" + "srv" + "/private-example",
                      "github_pat_" + "x" * 40):
            with self.assertRaises(AssertionError):
                scan_text(name, value)

    def test_privileged_workflow_changes_denied(self):
        for value in (self.workflow.replace("id-token: none", "id-token: write"),
                      self.workflow.replace("pull_request:", "pull_request_target:"),
                      self.workflow + "\n# " + "secrets." + "PRIVATE_VALUE\n"):
            with self.assertRaises(AssertionError):
                verify_workflow(value, self.tools)

if __name__ == "__main__":
    unittest.main()
