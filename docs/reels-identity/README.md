# Future grant contract: offline rehearsal

This release specifies and rehearses a future authorization boundary. Live
authority remains **DENIED**. It contains no real issuer, private key, token,
signing operation, transport, media access, or usable grant. The live worker's
existing authorization module is unchanged and does not import this simulator.
A task, environment variable, model answer, local cache, or successful diagnostic
does not authorize transmission, inference, or spending.

## Versioned synthetic envelope

`contracts/synthetic-grant.v1.schema.json` is a strict, local JSON Schema
2020-12 contract. Unknown fields fail closed. The only admitted envelope has
`SYNTHETIC_SIMULATION_ONLY`, authority `DENIED`, fixed synthetic issuer/signer,
and `SYNTHETIC_NOT_A_SIGNATURE`. The fixture uses invented identifiers and
future dates solely to make deterministic tests reproducible.

Bindings cover media ID plus independently verified SHA-256, project, service
account, model, location, policy version, worker/prompt/schema versions and
hashes, and each media/result/ledger root's filesystem, object, owner and mode,
plus runtime identity. The schema artifact denotes a versioned manifest containing
all task, provider-payload, result and grant contract versions and hashes; its
SHA-256 binds that entire manifest. This simulator does not resolve a real
manifest. Root values are synthetic identities, never paths from a
task. Changing any binding requires a new proposal and independent checks.
The simulator compares the full envelope with separate synthetic observations;
it does not verify real media, filesystem identities, or signatures.

Validity requires issued <= not-before <= current time < expiry, and expiry is
checked again before simulated dispatch. Maximum calls is exactly one. Gross
budget is a positive decimal string, converted with Decimal, and currency must
match USD or BRL exactly. Reserve the entire gross amount: no assumed credit,
refund, exchange rate, output discount, or net-budget calculation. Budget applies
per grant; this rehearsal does not implement a project-wide budget authority.

## Required production boundary, still unimplemented

A future release needs an independently approved issuer and cryptographic trust
root installed outside task JSON, environment, model output and mutable worker
configuration. Verify a canonical signed envelope, issuer/audience/key identity,
signature, revocation, validity and all bindings against independently acquired
observations. Private keys stay outside the worker; the issuer and worker must
have separate capabilities. Reject any synthetic mode or signature at that
boundary. No human or external issuer is provisioned by this release.

Before any potentially billable I/O, atomically and durably reserve the gross
budget, media content identity and single call, and persist/fsync that record
under the verified ledger root. Concurrent processes must share an authoritative
unique constraint keyed by media content digest and a second constraint on grant
ID. The record must bind the complete envelope and exact request digest; a task,
media alias, model/version/schema/prompt change, worker restart or cache miss
cannot evade a prior reservation. This simulator deliberately keys by digest,
excluding mutable version/cache/task identifiers.

Mark the call UNKNOWN durably before crossing the external boundary. A timeout,
connection error, crash or missing response is uncertain consumption. Do not
retry, change variants, release reservation, assume failure, or assume refund.
A definitive response must be retained under the verified result root and
atomically associated with the reservation and request digest. If persistence is
uncertain, retain the response digest and full reservation; do not resend.
Manual reconciliation requires evidence of provider billing/request outcome and
durable output. Its outcome is an auditable annotation, never automatic rearm or
refund. Any later authorization requires a separately approved design and scope.

The implemented SimulationLedger is memory-only and single-process. Its events
demonstrate ordering, not durability, fsync, process locking, root revalidation,
billing truth, crash recovery, external issuance, revocation or production
capabilities. Restarting it loses records; therefore it must never authorize live
work. The only public live-entry function always denies.

## Offline validation

Run `python3 -m unittest discover -s operations/reels-identity/tests -v`.
CI reuses the existing pinned Python/actions/dependency lock and offline guard,
then runs identity tests in a network namespace with a clean environment.
No Google auth import, credential read, media read or provider call is required.
Tests cover binding replacement, unverified media, expiry, monetary edge cases,
unknown fields, authority spoofing, pre-reservation I/O, one-call consumption,
variant retries, failed result persistence and reconciliation without rearming.

Existing evidence was reused: the prior Sprint2B denied authority, Sprint2C
offline guard and public IAM/model documentation. This contract makes no new
claim about account access, IAM entitlement, quota, billing credit or model
availability, and performs no public or authenticated provider audit.

## Bounded identity diagnostic

The separate auth_diagnostic module is an operator diagnostic, not a grant or
inference worker. Only a deliberately invoked operator entry may load an
approved service-account impersonation ADC and authenticate. Importing the
module or constructing its configuration performs no credential discovery.
No authentication runs in CI; tests inject synthetic authenticator/transport
objects and run under the inherited credential/network guard.

Its operator configuration is a separate strict local file, owned by the
operational user, mode 0600, with no task, URL, grant or authority fields.
The diagnostic admits one fixed catalog metadata HTTPS GET, a 30-second
request deadline and a 1,000,000-byte response ceiling. It implements no
redirect, retry, proxy-environment routing or fallback; a failed or uncertain
attempt is consumed. Authentication is separately bounded by the reused
strict token source. A timeout does not promise server-side cancellation.

The report exposes only credential class, target, quota project, expiry and
status. It must never print tokens, ADC content, credential repr or traceback.
A successful catalog status proves only that bounded metadata diagnostic;
it establishes no predict permission, inference entitlement, quota capacity,
credit coverage or permission to send media. Inference budget remains zero.

CI copies only the three unchanged support modules cloud_adapter.py, common.py
and storage.py from the existing offline baseline into a sibling scratch folder.
That permits the diagnostic tests to import their support without modifying
or copying the live authority, media, credentials, runtime or private receipts.
The existing baseline's public allowlist, provenance, pinned dependencies and
91 tests remain separate from the new identity suite.
