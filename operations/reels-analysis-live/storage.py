"""Manifest-last, readback-verified versioned files; no rename/hardlink assumptions."""
import os
from pathlib import Path
from common import ContractError, canonical, parse_json, sha

class DurabilityError(OSError):
    pass

def confined(root, relative):
    root = Path(root).absolute()
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative) or ":" in str(relative):
        raise ContractError("path escape")
    current = root
    for part in [None] + list(relative.parts):
        if part is not None:
            current = current / part
        if current.is_symlink():
            raise ContractError("symlink denied")
    return current

def read_bytes(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        import stat
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ContractError("nonregular artifact")
        return stream.read()

class FileStore:
    """Root supplied by trusted program, never task JSON. Only immutable versions."""
    def __init__(self, root, hook=None, expected_identity=None, *, read_only=False, metrics=None):
        self.read_only = read_only
        self.metrics = metrics
        self.root = Path(root).absolute()
        self.expected_identity = expected_identity
        self.hook = hook or (lambda event, path, data: None)
        if self.root.is_symlink():
            raise ContractError("symlink root")
        # Check every existing ancestor; lexical traversal cannot bypass a mount root.
        current = self.root
        while current != current.parent:
            if current.is_symlink():
                raise ContractError("symlink ancestor")
            current = current.parent
        if expected_identity is not None and not self.root.exists():
            raise DurabilityError("approved root absent; refuse local fallback directory")
        if not read_only:
            self.root.mkdir(parents=True, exist_ok=True)
        self.assert_identity()

    def assert_identity(self):
        current = self.root
        while current != current.parent:
            if current.is_symlink():
                raise ContractError("symlink root/ancestor")
            current = current.parent
        if not self.root.is_dir():
            raise DurabilityError("approved root missing")
        observed = self.root.stat()
        if self.expected_identity is not None:
            expected = self.expected_identity
            if set(expected) != {"device", "inode"} or expected != {"device": observed.st_dev, "inode": observed.st_ino}:
                raise DurabilityError("approved root identity changed; mount/local fallback denied")

    def _directory_sync(self, path):
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def put(self, relative, data):
        if self.read_only:
            raise ContractError('read-only store')
        self.assert_identity()
        path = confined(self.root, relative)
        parent = path.parent
        current = self.root
        for component in parent.relative_to(self.root).parts:
            current = current / component
            if current.is_symlink():
                raise ContractError("symlink parent")
            if not current.exists():
                current.mkdir()
                self._directory_sync(current.parent)
        self.hook("before_write", path, data)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            self.hook("before_fsync", path, data)
            os.fsync(stream.fileno())
        self._directory_sync(parent)
        self.hook("after_write", path, data)
        self.assert_identity()
        observed = read_bytes(path)
        self.hook("after_readback", path, observed)
        if observed != data:
            raise DurabilityError("write readback mismatch")
        return sha(observed)

    def put_json(self, relative, value):
        return self.put(relative, canonical(value) + b"\n")

    def get(self, relative, *, _guarded=False):
        self.assert_identity()
        path = confined(self.root, relative)
        if self.read_only or _guarded:
            linked = path.lstat()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                import stat
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_size > 10_000_000:
                    raise ContractError('artifact size/type')
                data = stream.read(10_000_001)
                after = os.fstat(stream.fileno())
                version = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                if len(data) != before.st_size or version(linked) != version(before) or version(before) != version(after) or version(after) != version(path.lstat()):
                    raise ContractError('artifact changed')
        else:
            data = read_bytes(path)
        if _guarded:
            self.assert_identity()
        if self.metrics is not None:
            self.metrics.count('artifact_reads')
            self.metrics.count('artifact_bytes', len(data))
        return data

    def manifest(self, prefix, names, metadata):
        if self.read_only:
            raise ContractError('read-only store')
        # Each artifact is read again immediately before committing the manifest.
        files = {name: sha(self.get(str(Path(prefix) / name))) for name in names}
        value = {"manifest_version": "readback.v1", "files_sha256": files, "metadata": metadata}
        self.put_json(str(Path(prefix) / "manifest.json"), value)
        self.verify(prefix)
        return value

    def verify_selected(self, prefix, required):
        """Fresh bounded verification; retain only manifest and required bytes.

        File versions are checked again after the whole pass. This is not an
        atomic filesystem snapshot, and no evidence survives into another call.
        """
        self.assert_identity()
        root_version = self.root.stat()
        identity = lambda s: (s.st_dev, s.st_ino)
        version = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        versions = {}

        def read(name):
            relative = str(Path(prefix) / name)
            path = confined(self.root, relative)
            before = path.lstat()
            data = self.get(relative, _guarded=True)
            if version(before) != version(path.lstat()):
                raise ContractError('artifact changed during verification')
            versions[relative] = version(before)
            return data

        if self.metrics is not None:
            self.metrics.count('artifact_verifications')
        raw = read('manifest.json')
        value = parse_json(raw)
        if not isinstance(value, dict) or set(value) != {'manifest_version', 'files_sha256', 'metadata'}:
            raise ContractError('manifest shape')
        files = value['files_sha256']
        if value['manifest_version'] != 'readback.v1' or not isinstance(files, dict):
            raise ContractError('manifest version/files')
        required = frozenset(required)
        if not required.issubset(files):
            raise ContractError('required artifact not covered by manifest')
        selected = {}
        for name, digest in files.items():
            if not name or '/' in name or '\\' in name or name in ('.', '..', 'manifest.json'):
                raise ContractError('manifest path escape')
            data = read(name)
            if sha(data) != digest:
                raise ContractError('manifest artifact mismatch: ' + name)
            if name in required:
                selected[name] = data
        self.assert_identity()
        if identity(root_version) != identity(self.root.stat()):
            raise ContractError('root changed during verification')
        for relative, expected in versions.items():
            if version(confined(self.root, relative).lstat()) != expected:
                raise ContractError('artifact changed during verification')
        return {'manifest': value, 'manifest_raw': raw,
                'manifest_sha256': sha(raw), 'selected': selected}

    def verify(self, prefix):
        if self.metrics is not None:
            self.metrics.count('artifact_verifications')
        value = parse_json(self.get(str(Path(prefix) / "manifest.json")))
        if not isinstance(value, dict) or set(value) != {"manifest_version", "files_sha256", "metadata"}:
            raise ContractError("manifest shape")
        if value["manifest_version"] != "readback.v1" or not isinstance(value["files_sha256"], dict):
            raise ContractError("manifest version/files")
        for name, digest in value["files_sha256"].items():
            if "/" in name or "\\" in name or name in (".", "..", "manifest.json"):
                raise ContractError("manifest path escape")
            if sha(self.get(str(Path(prefix) / name))) != digest:
                raise ContractError("manifest artifact mismatch: " + name)
        return value
