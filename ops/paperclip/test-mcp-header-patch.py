"""Conventional tests for the bounded MCP field compatibility overlay."""
import importlib.util,unittest,tempfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location("overlay",Path(__file__).with_name("patch-single-attempt.py"))
overlay=importlib.util.module_from_spec(spec);spec.loader.exec_module(overlay)
TARGET="packages/adapters/codex-local/src/server/codex-home.ts"
OLD="`headers = { Authorization ="
NEW="`http_headers = { Authorization ="
class HeaderPatchTests(unittest.TestCase):
    def test_field_only(self):
        source='prefix\n'+OLD+' fixture }\n suffix'
        result=overlay.transform(TARGET,source)
        self.assertEqual(result,source.replace(OLD,NEW))
    def test_missing_anchor(self):
        with self.assertRaises(ValueError):overlay.transform(TARGET,"no managed field")
    def test_duplicate_anchor(self):
        with self.assertRaises(ValueError):overlay.transform(TARGET,OLD+OLD)
    def test_hash_drift_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);file=root/TARGET;file.parent.mkdir(parents=True);file.write_text(OLD)
            previous=overlay.EXPECTED
            try:
                overlay.EXPECTED={TARGET:"0"*64}
                with self.assertRaises(ValueError):overlay.apply(root)
                self.assertEqual(file.read_text(),OLD)
            finally:overlay.EXPECTED=previous
    def test_known_input_applies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);file=root/TARGET;file.parent.mkdir(parents=True);file.write_text(OLD)
            previous=overlay.EXPECTED
            try:
                overlay.EXPECTED={TARGET:hashlib.sha256(file.read_bytes()).hexdigest()}
                overlay.apply(root);self.assertEqual(file.read_text(),NEW)
            finally:overlay.EXPECTED=previous
if __name__=="__main__":unittest.main()
