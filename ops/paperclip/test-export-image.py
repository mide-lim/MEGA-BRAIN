"""Export identity tests. Docker and models are never called."""
import importlib.util,pathlib,unittest,tempfile,stat
s=importlib.util.spec_from_file_location("export_image",pathlib.Path(__file__).with_name("export-image.py"))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class IdentityTests(unittest.TestCase):
 def setUp(self):
  self.commit="a"*40
  self.image={"Id":"sha256:"+"b"*64,"Os":"linux","Architecture":"amd64","Config":{"Labels":{"org.opencontainers.image.revision":self.commit,"org.opencontainers.image.source":"https://github.com/mide-lim/MEGA-BRAIN"}}}
 def test_exact_identity(self): m.validate_identity(self.commit,self.commit,self.image)
 def test_wrong_checkout(self):
  with self.assertRaises(ValueError):m.validate_identity(self.commit,"c"*40,self.image)
 def test_wrong_image_revision(self):
  self.image["Config"]["Labels"]["org.opencontainers.image.revision"]="c"*40
  with self.assertRaises(ValueError):m.validate_identity(self.commit,self.commit,self.image)
 def test_other_source(self):
  self.image["Config"]["Labels"]["org.opencontainers.image.source"]="https://example.invalid"
  with self.assertRaises(ValueError):m.validate_identity(self.commit,self.commit,self.image)
 def test_wrong_platform(self):
  self.image["Architecture"]="arm64"
  with self.assertRaises(ValueError):m.validate_identity(self.commit,self.commit,self.image)
 def test_invalid_image_id(self):
  self.image["Id"]="fixture"
  with self.assertRaises(ValueError):m.validate_identity(self.commit,self.commit,self.image)
 def test_only_public_controls_exported(self):
  self.assertEqual(set(m.CONTROLS),{"codex-pilot","authorize-packet.py","packet-preflight.py"})
 def test_control_modes_explicit_and_bytes_preserved(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory)/"repo";root.mkdir()
   for relative in m.CONTROLS.values():
    p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b"synthetic public source")
   controls=pathlib.Path(directory)/"controls"
   hashes=m.copy_controls(root,controls)
   self.assertEqual(m.CONTROL_MODES,{"codex-pilot":0o755,"authorize-packet.py":0o700,"packet-preflight.py":0o644})
   for name,mode in m.CONTROL_MODES.items():
    self.assertEqual(stat.S_IMODE((controls/name).stat().st_mode),mode)
    self.assertEqual((controls/name).read_bytes(),b"synthetic public source")
    self.assertEqual(hashes[name],m.sha256(controls/name))
if __name__=="__main__":unittest.main()
