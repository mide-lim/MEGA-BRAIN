"""Synthetic BMFF structures and probe stubs only; never real media or ffprobe."""
import copy
import datetime as dt
import errno
import io
import os
import stat
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


class FixedUTC(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2030, 1, 1, tzinfo=dt.timezone.utc)


class MediaAdmissionTests(unittest.TestCase):
    def setUp(self):
        clock = patch.object(w.dt, "datetime", FixedUTC)
        clock.start()
        self.addCleanup(clock.stop)
        # Never inspect a real protected policy in any synthetic reader test.
        self.policy_loader = patch.object(w, "load_media_diagnostic", side_effect=ContractError("absent"))
        self.loader = self.policy_loader.start()
        self.addCleanup(self.policy_loader.stop)
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

    def vp9_record(self):
        self.probe["streams"][0]["codec_name"] = "vp9"
        self.probe["streams"][0].update(profile="Profile 0", codec_tag_string="vp09",
                                        pix_fmt="yuv420p", avg_frame_rate="30/1")
        self.probe["streams"][1].update(profile="LC", codec_tag_string="mp4a",
                                        sample_rate="48000", channels=2)
        self.metadata["video"]["video_codec"] = "vp9"
        self.write_metadata()
        return {"version": 1, "mode": "single_diagnostic", "campaign_id": "synthetic-campaign",
                "owner_request_sha256": "a" * 64,
                "expires_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "task_id": self.task["task_id"], "reel_id": self.task["reel_id"],
                "source_video_sha256": self.task["source"]["source_video_sha256"],
                "metadata_sha256": self.task["source"]["metadata_sha256"],
                "cloud": copy.deepcopy(self.task["cloud"]),
                "expected_probe": copy.deepcopy(self.probe["streams"])}

    def permit(self, record):
        self.loader.side_effect = None
        self.loader.return_value = record

    def test_vp9_without_policy_is_unspecified_not_api_rejection(self):
        self.vp9_record()
        with self.assertRaisesRegex(ContractError, "VP9 compatibility unspecified.*not API rejection"):
            self.read()

    def test_exact_diagnostic_media_read_only_preserves_bytes(self):
        self.permit(self.vp9_record())
        original = self.metadata_path.read_bytes()
        data, duration, reference = self.read()
        self.assertEqual((data, duration, reference["sha256"]), (self.data, 12, sha(original)))
        self.assertEqual(self.video.read_bytes(), self.data)
        self.assertEqual(self.metadata_path.read_bytes(), original)
        self.loader.assert_called_once_with()  # One media read, not a POST or consumption claim.

    def test_exact_he_aac_diagnostic_media_read_preserves_bytes(self):
        record = self.vp9_record()
        self.probe["streams"][1]["profile"] = "HE-AAC"
        record["expected_probe"][1]["profile"] = "HE-AAC"
        self.permit(record)
        original = self.metadata_path.read_bytes()
        data, duration, reference = self.read()
        self.assertEqual((data, duration, reference["sha256"]), (self.data, 12, sha(original)))
        self.assertEqual(self.video.read_bytes(), self.data)
        self.assertEqual(self.metadata_path.read_bytes(), original)
        self.loader.assert_called_once_with()  # Media admission only, never a POST claim.

    def test_diagnostic_aac_profile_must_match_exact_record(self):
        record = self.vp9_record()
        for actual, expected in (("HE-AAC", "LC"), ("LC", "HE-AAC")):
            self.probe["streams"][1]["profile"] = actual
            record["expected_probe"][1]["profile"] = expected
            self.permit(record)
            with self.subTest(actual=actual, expected=expected):
                with self.assertRaisesRegex(ContractError, "VP9 compatibility unspecified") as denied:
                    self.read()
                self.assertIn("exact probe mismatch", str(denied.exception.__cause__))

    def test_diagnostic_unknown_aac_profiles_denied_even_with_exact_record(self):
        record = self.vp9_record()
        for profile in ("HE-AACv2", "unknown", "", None):
            self.probe["streams"][1]["profile"] = profile
            record["expected_probe"][1]["profile"] = profile
            self.permit(record)
            with self.subTest(profile=profile):
                with self.assertRaisesRegex(ContractError, "VP9 compatibility unspecified") as denied:
                    self.read()
                self.assertIn("unsupported diagnostic AAC profile/tag", str(denied.exception.__cause__))

    def test_h264_never_loads_policy(self):
        self.read()
        self.loader.assert_not_called()

    def test_diagnostic_exact_task_hash_metadata_cloud_bindings(self):
        original = self.vp9_record()
        for key, value in (("task_id", "other-task"), ("reel_id", "other-reel"),
                           ("source_video_sha256", "b" * 64), ("metadata_sha256", "c" * 64),
                           ("cloud", dict(original["cloud"], project_id="other-project"))):
            with self.subTest(key=key):
                record = copy.deepcopy(original)
                record[key] = value
                self.permit(record)
                with self.assertRaises(ContractError):
                    self.read()

    def test_diagnostic_strict_schema_expiry_and_mode(self):
        original = self.vp9_record()
        for key, value in (("expires_at", "2000-01-01T00:00:00Z"),
                           ("expires_at", "2999-01-01T00:00:00Z"),
                           ("expires_at", "2026-10-30T12:00:00+00:00"),
                           ("expires_at", 123), ("mode", "equivalent"), ("version", True),
                           ("campaign_id", ""), ("owner_request_sha256", "bad"),
                           ("allow_vp9", True), ("expected_probe", None)):
            record = copy.deepcopy(original)
            record[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ContractError):
                self.permit(record)
                self.read()
        for record in (None, [], {}, {k: v for k, v in original.items() if k != "task_id"}):
            self.permit(record)
            with self.assertRaises(ContractError):
                self.read()

    def test_diagnostic_profiles_projection_and_individual_bounds(self):
        record = self.vp9_record()
        baseline = copy.deepcopy(self.probe)
        for index, key, value in ((0, "profile", "Profile 2"), (0, "pix_fmt", "yuv420p10le"),
                                  (0, "codec_tag_string", "avc1"), (0, "width", 4097),
                                  (0, "height", True), (0, "avg_frame_rate", "0/0"),
                                  (0, "avg_frame_rate", "nan"), (0, "avg_frame_rate", "121/1"),
                                  (0, "avg_frame_rate", "24/1"), (1, "profile", "HE-AAC"),
                                  (1, "codec_name", "opus"), (1, "codec_tag_string", "xxxx"),
                                  (1, "sample_rate", "96000"), (1, "sample_rate", 48000),
                                  (1, "channels", True), (1, "channels", 3)):
            self.probe = copy.deepcopy(baseline)
            self.probe["streams"][index][key] = value
            self.permit(record)
            with self.subTest(key=key, value=value), self.assertRaises(ContractError):
                self.read()
        for streams in (baseline["streams"] * 2, baseline["streams"] + [{"codec_type": "subtitle"}]):
            self.probe = copy.deepcopy(baseline)
            self.probe["streams"] = streams
            with self.assertRaises(ContractError):
                self.read()
        self.probe = baseline
        for edit in (lambda r: r["expected_probe"][0].update(width=641),
                     lambda r: r["expected_probe"][0].update(extra=True),
                     lambda r: r["expected_probe"][1].pop("profile")):
            bad = copy.deepcopy(record)
            edit(bad)
            self.permit(bad)
            with self.assertRaises(ContractError):
                self.read()

    def test_diagnostic_does_not_bypass_physical_or_toctou_gates(self):
        self.permit(self.vp9_record())
        self.video.write_bytes(self.data[:-1] + b"!")
        with self.assertRaisesRegex(ContractError, "hash"):
            self.read()
        self.loader.assert_not_called()
        self.install(self.data)
        with self.assertRaisesRegex(ContractError, "changed|substituted"):
            self.read(lambda: self.video.write_bytes(self.data[:-1] + b"!"))
        self.loader.assert_not_called()

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


class DiagnosticLoaderTests(unittest.TestCase):
    """All OS policy operations stubbed: no policy, credential, or chmod access."""
    def load(self, file_changes=None, parent_changes=None, changed=False, raw=b'{"version":1}', open_error=False):
        parent = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        parent.__dict__.update(parent_changes or {})
        observed = SimpleNamespace(st_mode=stat.S_IFREG | 0o640, st_uid=0, st_gid=0,
                                   st_nlink=1, st_size=len(raw), st_dev=1, st_ino=2,
                                   st_mtime_ns=3, st_ctime_ns=4)
        observed.__dict__.update(file_changes or {})
        after = copy.copy(observed)
        if changed:
            after.st_ctime_ns += 1
        class Stream(io.BytesIO):
            def fileno(self):
                return 20
        def opening(path, flags, **kwargs):
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertNotEqual(path, "task-supplied-path")
            if path == "media-diagnostic.v1.json":
                self.assertEqual(flags, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                self.assertEqual(kwargs, {"dir_fd": 10})
                if open_error:
                    raise OSError("synthetic missing or symlink")
                return 20
            self.assertIn(path, ("/", "etc", "megabrain", "reels-pilot"))
            self.assertTrue(flags & os.O_DIRECTORY)
            self.assertEqual(flags, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            return 10
        calls = 0
        def fstat(fd):
            nonlocal calls
            if fd == 10:
                return parent
            calls += 1
            return after if calls >= 3 else observed
        with patch.object(w.os, "open", side_effect=opening), patch.object(w.os, "close"), \
                patch.object(w.os, "fdopen", return_value=Stream(raw)), \
                patch.object(w.os, "fstat", side_effect=fstat), \
                patch.object(w.os, "stat", return_value=after):
            return w.load_media_diagnostic()

    def test_trusted_fixed_path_bounded_snapshot(self):
        self.assertEqual(self.load(), {"version": 1})

    def test_missing_o_path_fails_closed_before_open(self):
        with patch.object(w.os, "open") as opened, patch.object(w.os, "O_PATH", create=True):
            del w.os.O_PATH
            with self.assertRaisesRegex(ContractError, "traversal unavailable"):
                w.load_media_diagnostic()
            opened.assert_not_called()

    def test_unsafe_file_ownership_mode_symlink_links_size(self):
        for changes in ({"st_uid": 1000}, {"st_mode": stat.S_IFREG | 0o644},
                        {"st_mode": stat.S_IFLNK | 0o640}, {"st_mode": stat.S_IFIFO | 0o640},
                        {"st_nlink": 2}, {"st_size": 16385}, {"st_size": 0}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.load(file_changes=changes)
        with self.assertRaises(ContractError):
            self.load(open_error=True)

    def test_unsafe_parents_changing_snapshot_and_malformed_json(self):
        for changes in ({"st_uid": 1000}, {"st_mode": stat.S_IFDIR | 0o775},
                        {"st_mode": stat.S_IFDIR | 0o757}, {"st_mode": stat.S_IFREG | 0o755}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.load(parent_changes=changes)
        with self.assertRaises(ContractError):
            self.load(changed=True)
        for raw in (b'{', b'{"version":1,"version":1}', b'{"bad":NaN}'):
            with self.assertRaises(ContractError):
                self.load(raw=raw)


class DiagnosticDirectorySearchOnlyTests(unittest.TestCase):
    def test_actual_unprivileged_search_only_ancestry_read_and_write_denial(self):
        """Only initial / is mapped; all descendant DAC, fstat and reads are real."""
        if os.geteuid() != 0:
            self.skipTest("real UID switch requires root")
        self.assertTrue(hasattr(os, "fork"), "root DAC regression requires fork")
        with tempfile.TemporaryDirectory(prefix="diagnostic-search-only-") as value:
            root = Path(value)
            directories = [root, root / "etc", root / "etc/megabrain",
                           root / "etc/megabrain/reels-pilot"]
            for directory in directories:
                directory.mkdir(exist_ok=True)
                os.chown(directory, 0, 987)
                os.chmod(directory, 0o710)
            leaf = directories[-1] / "media-diagnostic.v1.json"
            raw = b'{"version":1,"synthetic":"directory-DAC-only"}'
            leaf.write_bytes(raw)
            os.chown(leaf, 0, 987)
            os.chmod(leaf, 0o640)
            anchor = os.open(root, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            original_open = os.open
            def anchored_open(name, flags, *args, **kwargs):
                if name == "/":
                    self.assertEqual(flags, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
                    self.assertEqual((args, kwargs), ((), {}))
                    return os.dup(anchor)
                return original_open(name, flags, *args, **kwargs)
            read_end, write_end = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_end)
                try:
                    # Pin a private test cwd before dropping UID: no traversal of
                    # private TMPDIR/runtime ancestry, and no post-drop imports.
                    os.fchdir(anchor)
                    os.setgroups([])
                    os.setgid(987)
                    os.setuid(65534)
                    self.assertEqual((os.getuid(), os.geteuid(), os.getgid(), os.getegid()),
                                     (65534, 65534, 987, 987))
                    self.assertEqual(os.getgroups(), [])
                    for name in (".", "etc", "etc/megabrain", "etc/megabrain/reels-pilot"):
                        fd = original_open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW,
                                           dir_fd=anchor)
                        try:
                            info = os.fstat(fd)
                            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)),
                                             (0, 987, 0o710))
                        finally:
                            os.close(fd)
                        with self.assertRaises(PermissionError) as denied:
                            fd = original_open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                               dir_fd=anchor)
                            os.close(fd)
                        self.assertEqual(denied.exception.errno, errno.EACCES)
                    relative_leaf = "etc/megabrain/reels-pilot/media-diagnostic.v1.json"
                    info = os.stat(relative_leaf, dir_fd=anchor, follow_symlinks=False)
                    self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink),
                                     (0, 987, 0o640, 1))
                    with patch.object(w.os, "open", side_effect=anchored_open):
                        self.assertEqual(w.load_media_diagnostic(), parse_json(raw))
                    for attempt in range(2):
                        with self.assertRaises(PermissionError) as denied:
                            fd = original_open(relative_leaf, os.O_WRONLY | os.O_NOFOLLOW,
                                               dir_fd=anchor)
                            os.close(fd)
                        self.assertEqual(denied.exception.errno, errno.EACCES)
                    os.write(write_end, b"DIRECTORY_DIAGNOSTIC_REAL_UID_PASS uid=65534 euid=65534 gid=987 egid=987 groups=[] ancestry=0:987/0710 leaf=0:987/0640 nlink=1 old_flags=EACCES read=OK write1=EACCES write2=EACCES root_open=pinned_fixture_seam")
                    os._exit(0)
                except BaseException as exc:
                    os.write(write_end, (type(exc).__name__ + ": " + str(exc)).encode()[:4096])
                    os._exit(1)
            os.close(write_end)
            try:
                result = os.read(read_end, 8192).decode()
            finally:
                os.close(read_end)
                _, status = os.waitpid(pid, 0)
                os.close(anchor)
            self.assertEqual(status, 0, result)
            self.assertTrue(result.startswith("DIRECTORY_DIAGNOSTIC_REAL_UID_PASS"), result)
            self.assertEqual(leaf.read_bytes(), raw)
            print(result, flush=True)


if __name__ == "__main__":
    # Direct offline invocation supplies reproducible provenance evidence.
    for path in (ROOT / "worker.py", Path(__file__)):
        print(path.name + " repository_sha256=" + sha(path.read_bytes()), flush=True)
    unittest.main(verbosity=2)
