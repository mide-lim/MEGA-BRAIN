"""Offline root-controller transport. Authority is operator configuration, not task input."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat

BINDINGS = {'target_service_account', 'quota_project', 'operation_id', 'nonce',
            'grant_reference', 'issued_at', 'expires_at'}
AUTH = {'target_service_account', 'quota_project', 'operation_id', 'grant_reference', 'destination'}
REQUEST = AUTH | {'schema', 'nonce', 'issued_at', 'expires_at', 'public_key_pem', 'recipient_key_sha256'}
ENVELOPE = {'schema', 'request_sha256', 'wrapped_key', 'iv', 'ciphertext'}
MAX = 32768


class Rejected(ValueError):
    pass


def deny():
    raise Rejected('transport rejected')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict(raw):
    if len(raw) > MAX:
        deny()
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                deny()
            result[k] = v
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: deny())
        if not isinstance(value, dict):
            deny()
        return value
    except (ValueError, UnicodeError, RecursionError):
        deny()


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.(?:[0-9]{3}|[0-9]{6}|[0-9]{9}))?Z', value):
        deny()
    try:
        # Floor official fractional expiry to whole seconds; never extend validity.
        whole = value.split('.', 1)[0] + 'Z' if '.' in value else value
        return dt.datetime.strptime(whole, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
    except ValueError:
        deny()


def utc(value):
    return value.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def now():
    return dt.datetime.now(dt.timezone.utc)


def authority(a):
    if not isinstance(a, dict) or set(a) != AUTH:
        deny()
    for v in a.values():
        if not isinstance(v, str) or not 1 <= len(v) <= 512 or any(not 33 <= ord(c) <= 126 for c in v):
            deny()
    if not re.fullmatch(r'[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com', a['target_service_account']):
        deny()
    # This is a VPS destination even when the caller runs on Windows.
    destination = PurePosixPath(a['destination'])
    if not destination.is_absolute() or '..' in destination.parts or str(destination) == '/' or '\\' in a['destination'] or ':' in a['destination']:
        deny()


def validate_request(r, a, clock=None):
    authority(a)
    if set(r) != REQUEST or r['schema'] != 'api-token-request.v1' or any(r[k] != a[k] for k in AUTH):
        deny()
    if not re.fullmatch('[0-9a-f]{64}', r['nonce']):
        deny()
    clock = now() if clock is None else clock
    issued, expires = instant(r['issued_at']), instant(r['expires_at'])
    if not dt.timedelta(0) < expires-issued <= dt.timedelta(seconds=300) or issued > clock+dt.timedelta(seconds=30) or expires <= clock:
        deny()
    if digest(r['public_key_pem'].encode('ascii')) != r['recipient_key_sha256']:
        deny()


def validate_recipient(r):
    """Root-only PEM validation; the Windows sender checks RSA4096 in .NET."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = serialization.load_pem_public_key(r['public_key_pem'].encode('ascii'))
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size != 4096 or digest(r['public_key_pem'].encode()) != r['recipient_key_sha256']:
        deny()


def aad(r):
    return b'api-token-v1:' + digest(canonical(r)).encode('ascii')


def path(p):
    p = Path(p)
    if not p.is_absolute() or '..' in p.parts or str(p) == '/':
        deny()
    return p


def directory(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        deny()


def parent(p):
    p = path(p)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory(os.fstat(fd))
        for part in p.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            directory(os.fstat(fd))
        return fd
    except BaseException:
        os.close(fd)
        raise


def leaf(s, mode=0o600, gid=0):
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_gid != gid or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != mode:
        deny()


def read(p, mode=0o600, gid=0):
    d = parent(p)
    try:
        fd = os.open(path(p).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
        try:
            leaf(os.fstat(fd), mode, gid)
            raw = os.read(fd, MAX+1)
            leaf(os.fstat(fd), mode, gid)
            if len(raw) > MAX:
                deny()
            return raw
        finally:
            os.close(fd)
    finally:
        os.close(d)


def write(p, raw, mode=0o600, gid=0):
    d = parent(p)
    try:
        fd = os.open(path(p).name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=d)
        try:
            if gid:
                os.fchown(fd, 0, gid)
            os.fchmod(fd, mode)
            leaf(os.fstat(fd), mode, gid)
            view = memoryview(raw)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    deny()
                view = view[n:]
            os.fsync(fd)
            info = os.fstat(fd)
        finally:
            os.close(fd)
        os.fsync(d)
        return info
    finally:
        os.close(d)


def session(p):
    p = path(p)
    d = parent(p / 'check')
    try:
        s = os.fstat(d)
        if stat.S_IMODE(s.st_mode) != 0o700 or s.st_gid != 0:
            deny()
    finally:
        os.close(d)
    return p


def remove(p, mode=0o600, gid=0, identity=None):
    d = parent(p)
    try:
        try:
            s = os.stat(path(p).name, dir_fd=d, follow_symlinks=False)
        except FileNotFoundError:
            return
        leaf(s, mode, gid)
        if identity and (s.st_dev, s.st_ino) != (identity['device'], identity['inode']):
            deny()
        os.unlink(path(p).name, dir_fd=d)
        os.fsync(d)
    finally:
        os.close(d)


def prepare(control, a):
    authority(a)
    p = path(control)
    d = parent(p)
    try:
        os.mkdir(p.name, 0o700, dir_fd=d)
        os.fsync(d)
    finally:
        os.close(d)
    p = session(p)
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    try:
        key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
        write(p/'private.pem', key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        t = now().replace(microsecond=0)
        r = dict(a, schema='api-token-request.v1', nonce=secrets.token_hex(32), issued_at=utc(t), expires_at=utc(t+dt.timedelta(seconds=300)), public_key_pem=public, recipient_key_sha256=digest(public.encode()))
        write(p/'request.json', canonical(r))
        return r
    except BaseException:
        remove(p/'private.pem')
        raise


def payload(value, r, clock=None):
    if set(value) != BINDINGS | {'purpose', 'access_token'} or value['purpose'] != 'api-token-v1':
        deny()
    if any(value[k] != r[k] for k in AUTH - {'destination'}) or value['nonce'] != r['nonce']:
        deny()
    token = value['access_token']
    if not isinstance(token, str) or not 1 <= len(token) <= 16384 or any(not 33 <= ord(c) <= 126 for c in token):
        deny()
    issued, expires = instant(value['issued_at']), instant(value['expires_at'])
    clock = now() if clock is None else clock
    if not dt.timedelta(0) < expires-issued <= dt.timedelta(seconds=900) or issued > clock+dt.timedelta(seconds=30) or expires-clock < dt.timedelta(seconds=150):
        deny()


def cleanup(control):
    p = session(control)
    for name in ('private.pem', 'envelope.json'):
        remove(p/name)
    try:
        d = strict(read(p/'descriptor.json'))
    except FileNotFoundError:
        return
    remove(d['token_file'], 0o640, 987, d['file_identity'])


def consume(control, a, request_sha256, envelope_sha256):
    p = session(control)
    # A durable terminal receipt precedes parsing, pin checking and decryption.
    # Uncertainty (including missing transport) spends this session permanently.
    try:
        write(p/'spent.json', canonical({'schema': 'api-token-spent.v1'}))
        rraw = read(p/'request.json')
        eraw = read(p/'envelope.json')
        if not re.fullmatch('[0-9a-f]{64}', request_sha256) or not re.fullmatch('[0-9a-f]{64}', envelope_sha256) or digest(rraw) != request_sha256 or digest(eraw) != envelope_sha256:
            deny()
        r, e = strict(rraw), strict(eraw)
        validate_request(r, a)
        validate_recipient(r)
        if set(e) != ENVELOPE or e['schema'] != 'api-token-envelope.v1' or e['request_sha256'] != digest(canonical(r)):
            deny()
        from cryptography.hazmat.primitives import serialization, hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = serialization.load_pem_private_key(read(p/'private.pem'), password=None)
        decoded = {k: base64.b64decode(e[k], validate=True) for k in ('wrapped_key', 'iv', 'ciphertext')}
        if len(decoded['wrapped_key']) != 512 or len(decoded['iv']) != 12 or not 16 <= len(decoded['ciphertext']) <= 24576:
            deny()
        secret = key.decrypt(decoded['wrapped_key'], padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        if len(secret) != 32:
            deny()
        raw = AESGCM(secret).decrypt(decoded['iv'], decoded['ciphertext'], aad(r))
        value = strict(raw)
        payload(value, r)
        dest = path(a['destination'])
        if dest.parent == p or p in dest.parents:
            deny()
        fd = parent(dest)
        try:
            s = os.fstat(fd)
            if s.st_gid != 987 or stat.S_IMODE(s.st_mode) != 0o710:
                deny()
        finally:
            os.close(fd)
        s = write(dest, raw, 0o640, 987)
        ident = dict(device=s.st_dev, inode=s.st_ino, uid=0, gid=987, mode='0640', size=len(raw), sha256=digest(raw))
        descriptor = {k: value[k] for k in BINDINGS}
        descriptor.update(mode='api_impersonated_token', token_file=str(dest), file_identity=ident)
        try:
            write(p/'descriptor.json', canonical(descriptor))
        except BaseException:
            remove(dest, 0o640, 987, ident)
            raise
        return descriptor
    finally:
        for name in ('private.pem', 'envelope.json'):
            remove(p/name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'consume', 'cleanup'])
    parser.add_argument('--control', required=True)
    parser.add_argument('--authority', required=True, help='root-protected operator configuration, not task data')
    parser.add_argument('--request-sha256')
    parser.add_argument('--envelope-sha256')
    args = parser.parse_args()
    try:
        a = strict(read(args.authority))
        if args.action == 'prepare':
            result = prepare(args.control, a)
        elif args.action == 'consume':
            if not args.request_sha256 or not args.envelope_sha256:
                deny()
            result = consume(args.control, a, args.request_sha256, args.envelope_sha256)
        else:
            cleanup(args.control)
            result = {'status': 'cleaned'}
        print(canonical(result).decode())
    except Exception:
        parser.exit(1, 'transport rejected\n')


if __name__ == '__main__':
    main()
