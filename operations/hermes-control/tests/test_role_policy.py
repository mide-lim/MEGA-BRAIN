import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from role_policy import allowed_tools,require_role
class RoleTests(unittest.TestCase):
    def test_central_routes_only_reels(self):
        require_role('hermes-home','reels-pilot')
        with self.assertRaises(ValueError):require_role('hermes-home','developer')
    def test_coordinator_routes_only_specialists(self):
        require_role('reels-pilot','developer');require_role('reels-pilot','validator')
        with self.assertRaises(ValueError):require_role('reels-pilot','reels-pilot')
    def test_leaf_cannot_spawn(self):
        with self.assertRaises(ValueError):require_role('developer','validator')
    def test_mutating_file_tools_only_developer(self):
        self.assertIn('write_file',allowed_tools('developer'))
        self.assertNotIn('write_file',allowed_tools('validator'))
        self.assertNotIn('patch',allowed_tools('validator'))
    def test_central_has_no_execution_tools(self):
        self.assertEqual(allowed_tools('hermes-home'),{'delegate_task'})
    def test_unknown_role_has_no_capabilities(self):self.assertEqual(allowed_tools('unregistered'),set())
if __name__=='__main__':unittest.main()
