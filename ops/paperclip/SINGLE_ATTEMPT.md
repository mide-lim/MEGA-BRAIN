# Single-attempt execution controls

This change is a candidate for independent review. It does not install itself,
start agents, issue permits, merge changes, deploy MegaBrain or resume any queue.

## Failure and correction

A launcher preflight rejection previously surfaced as a generic adapter failure,
which upstream recovery could treat as transient. The same permit remained
available after the failed preflight.

The launcher now consumes a validated, matching permit before preflight.
Authorization also checks preflight inside the worker container as UID 1000.
The existing global cap remains two model entries per rolling 24 hours,
at least one hour apart, with global concurrency one and a per-task budget.

An admission attempt and a model entry are distinct:
a preflight failure consumes the permit but does not consume a model-entry budget.
A new permit requires a new explicit operator decision. Failed attempts must not
be used to silently regenerate permits or increase budgets.

## Fixed upstream overlay

[Dockerfile.single-attempt](Dockerfile.single-attempt) derives from a fixed public
image digest. [patch-single-attempt.py](patch-single-attempt.py) verifies hashes of
all four upstream files before changing any of them, and refuses drift.
Both TypeScript source and compiled JavaScript are patched.

For the codex_local adapter configured with the exact command
`/usr/local/bin/codex-pilot`:
- Exit 78 with a `Pilot:` error is classified as `pilot_admission_rejected`.
- Continuation recovery treats that code as non-retryable.
- The bounded retry scheduler refuses automatic replacement runs for this launcher,
  including generic adapter failure, provider quota and timeout.
- Other adapters and commands retain upstream behavior.

This is a local overlay, not a claimed upstream configuration option.
A future upstream release requires a new audited overlay and tests.

## Validation

[CI](../../.github/workflows/paperclip-control.yml) builds the candidate image on
GitHub, checks compiled JavaScript syntax and exercises the actual image's
scheduling, outcome classification and recovery functions with synthetic inputs.
The integration harness executes their relevant boundaries with dependencies
stubbed; it does not bootstrap the HTTP server or connect PostgreSQL.

Launcher regression tests never start Codex. The image test runs with no network,
no runtime data mounts and a read-only filesystem. Credentials and production
data are unnecessary.

CI success does not prove all Paperclip scheduler paths are disabled. The
single-use permit remains the final barrier to a model invocation.
Before agent activation, independently review all automated wake paths and
validate a synthetic task against the staged server with an isolated database:
a rejected admission must produce no successor run or queued wake request.
That full server validation remains a deployment gate.

## Review and promotion

Risk: high, because this changes execution authorization and runtime infrastructure.
Follow [the review policy](../../docs/REVIEW_POLICY.md): independent reviewer or
explicit independent human review, plus CI on the final commit. The implementer
cannot approve their own change.

After approval, an administrator must:
1. Preserve the current image, launcher, authorization helper and configuration.
2. Build or retrieve the reviewed candidate image and record its digest.
3. Promote the launcher and authorization helper from the reviewed commit.
4. Keep the agent paused and permits absent during replacement.
5. Run the staged full-server validation above without a model.
6. Confirm installed file hashes match the reviewed source.
7. Only then issue a fresh packet/permit for a separately authorized small task.

Changing only the launcher leaves upstream automatic attempt records possible.
Changing only the image leaves the permit/preflight weakness present.
A partial promotion must not reactivate the agent.
Rollback restores the previous image and controls with the agent paused and no permit.

[Controls](README.md)
