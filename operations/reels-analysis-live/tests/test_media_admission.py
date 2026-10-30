"""Synthetic BMFF structures and probe stubs only; never real media or ffprobe."""
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import worker as w
from common import ContractError, canonical, parse_json, sha


def box(kind, payload=b"", extended=False):
    if extended:
        return b"\0\0\0\1" + kind + (len(payload) + 16).to_bytes(8, "big") + payload
    return (len(payload) + 8).to_bytes(4, "big") + kind + payload


def movie(brand=b"isom", compatible=b"mp42", extended=False):
    return (box(b"ftyp", brand + b"\0" * 4 + compatible, extended)
            + box(b"moov", box(b"mvhd", b"synthetic header")
                  + box(b"trak", box(b"mdia", box(b"hdlr", b"synthetic track"))))
            + box(b"mdat", b"SYNTHETIC TEST BYTES. not encoded media", extended))


class MediaAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-admission-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = parse_json((ROOT / "examples/stored-video.preparation.json").read_bytes())
        self.video = self.root / self.task["source"]["relative_video_path"]
        self.video.parent.mkdir(parents=True)
        self.metadata_path = self.root / self.task["source"]["relative_metadata_path"]
        self.data = movie()
        self.metadata = {"id": self.task["reel_id"], "original": {"untouched": "canary"},
                         "video": {"file": "video.mp4", "container": "mp4", "mime_type": "video/mp4",
                                   "duration_seconds": 12, "width": 640, "height": 480,
                                   "video_codec": "h264", "audio_codec": "aac", "has_audio": True}}
        self.install(self.data)
        self.probe = {"format": {"duration": "12.0", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
                      "streams": [{"codec_type": "video", "codec_name": "h264", "width": 640, "height": 480},
                                  {"codec_type": "audio", "codec_name": "aac"}]}
        observed = self.root.stat()
        self.reader = w.StoredMediaReader(self.root, {"device": observed.st_dev, "inode": observed.st_ino})

    def write_metadata(self):
        data = canonical(self.metadata)
        self.metadata_path.write_bytes(data)
        self.task["source"]["metadata_sha256"] = sha(data)

    def install(self, data):
        self.video.write_bytes(data)
        self.task["source"].update(source_video_sha256=sha(data), declared_bytes=len(data))
        self.metadata["video"].update(size_bytes=len(data), sha256=sha(data))
        self.write_metadata()

    def read(self, mutation=None):
        def probe(*args, **kwargs):
            self.assertEqual(args[0][0], "ffprobe")
            self.assertTrue(args[0][-1].startswith("/proc/self/fd/"))
            self.assertEqual(len(kwargs["pass_fds"]), 1)
            self.assertEqual(kwargs["timeout"], 15)
            self.assertNotIn("shell", kwargs)
            if mutation:
                mutation()
            return SimpleNamespace(stdout=canonical(self.probe))
        with patch.object(subprocess, "run", side_effect=probe):
            return self.reader.read(self.task)

    def test_mp4_and_legacy_mov_preserve_all_bytes_and_metadata(self):
        for container in ("mp4", "mov"):
            with self.subTest(container=container):
                self.metadata["video"]["container"] = container
                self.write_metadata()
                original = self.metadata_path.read_bytes()
                data, duration, reference = self.read()
                self.assertEqual(data, self.data)
                self.assertEqual(duration, 12)
                self.assertEqual(reference["sha256"], sha(original))
                self.assertEqual(self.metadata_path.read_bytes(), original)
                self.assertEqual(self.video.read_bytes(), self.data)

    def test_extended_sizes_compatible_brand_and_final_mdat(self):
        for data in (movie(brand=b"xxxx", compatible=b"mp42", extended=True),
                     self.data[:-len(box(b"mdat", b"SYNTHETIC TEST BYTES. not encoded media"))]
                     + b"\0\0\0\0mdat" + b"synthetic"):
            with self.subTest(data=data):
                self.install(data)
                self.assertEqual(self.read()[0], data)

    def test_qt_unknown_and_unrelated_bytes_fail_even_legacy_label(self):
        self.metadata["video"]["container"] = "mov"
        for data in (movie(b"qt  ", b"qt  "), movie(b"zzzz", b"xxxx"),
                     movie(b"qt  ", b"mp42"), b"SYNTHETIC TEST BYTES. plain text",
                     box(b"free", b"arbitrary")):
            with self.subTest(data=data):
                self.install(data)
                with self.assertRaises(ContractError):
                    self.read()

    def test_malformed_truncated_missing_duplicate_and_nested_boxes(self):
        ftyp = box(b"ftyp", b"isom\0\0\0\0mp42")
        moov = box(b"moov", box(b"mvhd", b"synthetic")
                   + box(b"trak", box(b"hdlr", b"synthetic")))
        mdat = box(b"mdat", b"synthetic")
        cases = [self.data[:n] for n in (1, 7, 9, len(self.data) - 1)]
        cases += [box(b"ftyp", b"isom"), box(b"ftyp", b"isom\0\0\0\0x") + moov + mdat,
                  ftyp + mdat, ftyp + moov, ftyp + moov + box(b"mdat"),
                  ftyp + box(b"moov") + mdat, ftyp + ftyp + moov + mdat,
                  ftyp + moov + moov + mdat, ftyp + box(b"moov", b"partial") + mdat,
                  ftyp + box(b"moov", b"\0\0\0\x20trak") + mdat,
                  ftyp + moov + b"\0\0\0\1mdat\0", ftyp + moov + mdat + b"x",
                  ftyp + moov + box(b"uuid", b"short") + mdat,
                  ftyp + moov + box(b"moof", b"unhandled") + mdat,
                  ftyp + moov + b"\0\0\0\x04mdat", moov + ftyp + mdat]
        for data in cases:
            with self.subTest(data=data):
                self.install(data)
                with self.assertRaises(ContractError):
                    self.read()

    def test_box_count_nesting_and_ftyp_scan_are_bounded(self):
        deep = box(b"mvhd", b"synthetic")
        for _ in range(18):
            deep = box(b"trak", deep)
        cases = [box(b"ftyp", b"isom\0\0\0\0" + b"mp42" * 300) + self.data[20:],
                 self.data + box(b"free") * 4096,
                 box(b"ftyp", b"isom\0\0\0\0") + box(b"moov", deep) + box(b"mdat", b"x")]
        for data in cases:
            with self.subTest(length=len(data)), self.assertRaises(ContractError):
                w.validate_mp4_bytes(data)

    def test_vp9_is_blocked_pending_model_specific_evidence(self):
        self.probe["streams"][0]["codec_name"] = "vp9"
        self.metadata["video"]["video_codec"] = "vp9"
        self.write_metadata()
        with self.assertRaisesRegex(ContractError, "VP9 blocked pending Gemini 3.8 Flash"):
            self.read()

    def test_other_codecs_no_audio_and_probe_container_fail_closed(self):
        original = copy.deepcopy(self.probe)
        for kind in ("video", "audio"):
            self.probe = copy.deepcopy(original)
            self.probe["streams"] = [s for s in self.probe["streams"] if s["codec_type"] != kind]
            with self.assertRaisesRegex(ContractError, "both video and audio"):
                self.read()
        for index, codec in ((0, "hevc"), (1, "opus")):
            self.probe = copy.deepcopy(original)
            self.probe["streams"][index]["codec_name"] = codec
            with self.assertRaisesRegex(ContractError, "codec outside"):
                self.read()
        self.probe = copy.deepcopy(original)
        self.probe["format"]["format_name"] = "mov"
        with self.assertRaisesRegex(ContractError, "probe container"):
            self.read()

    def test_metadata_divergences_and_mime_are_rejected(self):
        original = copy.deepcopy(self.metadata)
        for key, value in (("size_bytes", 1), ("sha256", "0" * 64), ("duration_seconds", 13),
                           ("width", 641), ("height", 481), ("width", True),
                           ("container", "webm"), ("container", "quicktime"),
                           ("mime_type", "video/quicktime"), ("mime", "audio/mp4"),
                           ("mimeType", "video/webm"), ("video_codec", "vp9"),
                           ("audio_codec", "opus"), ("has_audio", False)):
            with self.subTest(field=key, value=value):
                self.metadata = copy.deepcopy(original)
                self.metadata["video"][key] = value
                self.write_metadata()
                with self.assertRaises(ContractError):
                    self.read()

    def test_hash_size_duration_dimensions_and_root_gates_remain(self):
        for key, value in (("source_video_sha256", "0" * 64), ("metadata_sha256", "0" * 64),
                           ("metadata_sha256", None), ("declared_bytes", len(self.data) + 1)):
            original = self.task["source"][key]
            self.task["source"][key] = value
            with self.subTest(field=key), self.assertRaises(ContractError):
                self.read()
            self.task["source"][key] = original
        for duration in ("nan", "inf", "181", "13", "0"):
            self.probe["format"]["duration"] = duration
            with self.subTest(duration=duration), self.assertRaises(ContractError):
                self.read()
        self.probe["format"]["duration"] = "12"
        self.probe["streams"][0]["width"] = 0
        with self.assertRaises(ContractError):
            self.read()
        self.probe["streams"][0]["width"] = 640
        self.root.rename(self.root.with_name(self.root.name + "-detached"))
        detached = self.root.with_name(self.root.name + "-detached")
        self.addCleanup(lambda: detached.rename(self.root))
        self.root.mkdir()
        self.addCleanup(self.root.rmdir)
        with self.assertRaises(OSError):
            self.read()

    def test_size_overflow_and_metadata_parse_cap_before_probe(self):
        with self.video.open("r+b") as stream:
            stream.truncate(w.MAX_MEDIA_BYTES + 1)
        with patch.object(subprocess, "run", side_effect=AssertionError("must not probe")):
            with self.assertRaisesRegex(ContractError, "50MB"):
                self.reader.read(self.task)
        self.install(self.data)
        self.metadata_path.write_bytes(b" " * 2_000_001)
        with patch.object(subprocess, "run", side_effect=AssertionError("must not probe")):
            with self.assertRaisesRegex(ContractError, "2MB"):
                self.reader.read(self.task)

    def test_substitute_after_authorization_and_during_probe(self):
        self.video.write_bytes(self.data[:-1] + b"!")
        with self.assertRaisesRegex(ContractError, "hash"):
            self.read()
        self.install(self.data)
        def replace():
            replacement = self.video.with_suffix(".replacement")
            replacement.write_bytes(self.data)
            replacement.replace(self.video)
        with self.assertRaisesRegex(ContractError, "substituted"):
            self.read(replace)
        self.install(self.data)
        with self.assertRaisesRegex(ContractError, "changed|substituted"):
            self.read(lambda: self.video.write_bytes(self.data[:-1] + b"!"))
        self.install(self.data)
        with self.assertRaisesRegex(ContractError, "metadata substituted"):
            self.read(lambda: self.metadata_path.write_bytes(b"{}"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
