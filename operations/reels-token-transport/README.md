# One-use encrypted API token transport

Operator runbook, not authorization to run live commands. All examples below use
operator-supplied paths/values, never credentials. Agents remain offline. Before
one separately authorized live mint, a trusted operator must pass genuine native
Windows/.NET synthetic interoperability and the original 197-test baseline CI.
Linux tests with injected processes do **not** satisfy either gate.

## Trust and prerequisites

- Root supplies an independently trusted authority JSON with exactly
  `target_service_account`, `quota_project`, `operation_id`, `grant_reference`,
  `destination`. The destination is an absolute POSIX VPS token filename, not a
  Windows path; no drive, backslash, relative path or `..` is accepted.
- Provisioning is a separate trusted-operator step, not performed by these
  helpers: authority file root:root `0600`; ancestors root-owned, no symlinks or
  group/world write. Control parent must already exist; `prepare` creates a new
  root:root `0700` session directory. The separate destination directory must
  already be root:GID987 `0710`, outside the session, with safe ancestors.
  Token destination and session names must be unused. UID999 must have GID987
  access through a protected worker-visible path (not through `/root`).
- Root Python uses the existing `cryptography` installation. Windows Python
  validation is stdlib-only; encryption requires native PowerShell 7.6+ for
  `ConvertFrom-Json -DateKind String` to preserve UTC timestamp strings exactly.
  Encryption uses native PowerShell/.NET, including
  `RSA.ImportFromPem`, RSA4096, OAEP-SHA256 and AES256-GCM (16-byte tag).
  Pin reviewed code, especially `encrypt.ps1`, and absolute SDK/PowerShell paths.
- Encryption alone does **not** authenticate sender origin: anyone with the
  public request can encrypt. Authenticate the operator out of band and deliver
  request and envelope SHA256 pins independently of their respective transport.
  Never accept a pin alongside attacker-controlled bytes as origin proof.
  Never copy Owner refresh credentials, SDK config, bearer tokens or plaintext
  payloads to MCP, the VPS, chat, command arguments or logs.

## Invocation sequence

Root commands below run from the repository root; `$PYTHON`, `$CONTROL`,
`$AUTHORITY`, `$REQUEST_SHA256`, `$ENVELOPE_SHA256` are operator-established values.
Do not reuse a session after uncertainty or expiration.

1. **Root prepare** (request valid for at most 300 seconds):

   ```sh
   "$PYTHON" operations/reels-token-transport/relay.py prepare --control "$CONTROL" --authority "$AUTHORITY"
   sha256sum "$CONTROL/request.json"
   ```

   Transfer only the public `request.json` to Windows. Independently deliver its
   exact file SHA256 and authority to the authenticated Windows operator. Keep
   `private.pem` on Root only. Pin file bytes, not a reserialized request.

2. **Windows mint, only after the gates and separate live authorization**.
   From the reviewed transport directory, with all variables supplied by the
   operator in PowerShell:

   ```powershell
   & $Python .\controller.py --request $Request --request-sha256 $RequestSha256 --authority $Authority --sdk $Sdk --account $Account --config $Config --pwsh $Pwsh > $Envelope
   if ($LASTEXITCODE -ne 0) { throw 'transport rejected' }
   (Get-FileHash -Algorithm SHA256 -LiteralPath $Envelope).Hash.ToLowerInvariant()
   ```

   `$Config` is the existing protected Windows human SDK configuration, not a
   copied refresh store. `sdk_bearer()` selects the explicit account with empty
   impersonation override. `post_once()` makes exactly one direct TLS POST to
   `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{exactEmail}:generateAccessToken`
   with cloud-platform scope and `lifetime: "900s"`. There is no redirect, retry,
   refresh or fallback. IAM authorization must already exist; this runbook does
   not grant permissions. Avoid shell tracing/transcripts of sensitive streams.
   CLI stdout contains only an encrypted envelope; ensure the chosen PowerShell
   redirection preserves readable JSON encoding. Pin the final transferred bytes.

3. **Encrypted envelope only over MCP**. Transfer the envelope file, never SDK
   stdout or the token payload. Authenticated operator delivers the exact file
   SHA256 to Root by an independent trusted channel. Root stages bytes exclusively
   as `$CONTROL/envelope.json`, root:root `0600`, single regular file, no links,
   in the protected `0700` inbox. Do not grant MCP direct write access to that
   inbox; Root mediates ingress and verifies the independent pin. `relay.write()`
   provides exclusive/nofollow/fsynced creation for operator integrations.

4. **Root consume**:

   ```sh
   "$PYTHON" operations/reels-token-transport/relay.py consume --control "$CONTROL" --authority "$AUTHORITY" --request-sha256 "$REQUEST_SHA256" --envelope-sha256 "$ENVELOPE_SHA256"
   ```

   This writes durable `spent.json` before parsing/decryption, checks both pins,
   authority/AAD/nonce, RSA4096 recipient, envelope lengths, payload bindings and
   expiry. Token lifetime is at most 900 seconds, future issue skew at most 30
   seconds, and at least 150 seconds must remain. Controller derives issue time
   from `expireTime - 900s`. Official UTC `Z` expiry accepts 0/3/6/9 fractional
   digits, floored to whole seconds, never extending validity. Exclusive writes
   set the exact requested fd mode before metadata checks, including under
   operator umask `0077`; the process umask is not changed.
   Success creates root:GID987 `0640` token and protected
   `descriptor.json`; stdout is the descriptor, not the token. Consume removes
   private key and ciphertext even on failure. Never delete `spent.json` to retry.

5. **Descriptor → UID999 diagnostic**. Root supplies the complete descriptor to
   the protected diagnostic harness, with the independently configured target
   `{service_account, project}` (not values trusted merely from the descriptor).
   The existing API is `api_token.TemporaryTokenSource(descriptor, target)` from
   `operations/reels-pilot/api_token.py`. Under UID999 with GID987, construct it
   and call `.token()` once, discarding the return without printing it; report
   only pass/fail. There is no diagnostic CLI flag. A successful synthetic
   roundtrip must return the known synthetic sentinel internally. Do not route
   a real bearer through an unprotected harness. This diagnostic is separate
   from worker dispatch: production keeps root-policy selection, complete signed
   descriptor binding, matching verified grant and durable UNKNOWN **before**
   lazy token read. It must not call a provider as part of this diagnostic.

6. **Terminal cleanup**, on success or failure:

   ```sh
   "$PYTHON" operations/reels-token-transport/relay.py cleanup --control "$CONTROL" --authority "$AUTHORITY"
   ```

   Cleanup is idempotent; token deletion requires its pinned inode/device.
   Preserve request/descriptor/spent receipts under Root protection. Destroy
   temporary Windows envelope/public-request copies according to operator policy;
   do not touch the Owner SDK store. A failed or expired attempt needs a fresh
   session and authorization, not an automatic remint.

## Required native Windows synthetic preflight and safe report

Use a fresh synthetic authority/request and synthetic token sentinel only, with
network blocked. Invoke `controller.mint(request_raw, request_sha256, authority,
sdk=..., account=..., config=..., pwsh=..., runner=..., http_post=..., clock=...)`
in an operator harness. Inject `http_post` returning synthetic HTTP 200 JSON
`{accessToken, expireTime}`; the runner must intercept **only** the SDK invocation
with a synthetic bearer and delegate the PowerShell invocation to real
`subprocess.run`. Thus the actual reviewed `encrypt.ps1` executes on native
Windows/.NET without any SDK or IAM call. Do not substitute a fake envelope for
this gate. Transfer and consume its real encrypted output on Root, then perform
UID999 diagnostic and cleanup. Also confirm malformed/expired responses and
non-200 HTTP statuses reject without retry. An unsupported .NET primitive or
JSON encoding failure blocks live mint; do not install a Python crypto fallback.

The library returns `(envelope, metadata)`; CLI currently prints only envelope.
The trusted harness may allowlist `http_status`, `expires_at`, `quota_project`,
`target_service_account`, `operation_id` from successful metadata for a safe
report. For rejection report only stage/pass-fail, never raw response bodies,
headers, SDK output or exceptions containing data. Record actual Windows/.NET
versions, synthetic roundtrip/cleanup results and baseline CI receipt separately.
No real HTTP/expiry success is claimed by offline synthetic tests.
