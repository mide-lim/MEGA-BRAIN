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
The boundary harness uses stubbed dependencies. A second harness boots the
actual candidate server and a temporary PostgreSQL instance on an internal
network, with no published ports, production mounts or model credentials.
It substitutes the launcher with a rejecting fixture, triggers one synthetic
task, observes 75 seconds after failure, and checks both successor runs and
pending wake requests. These synthetic agents and budgets exist only in the
disposable database. All containers, anonymous volumes and the test network
are removed by the harness.

Launcher regression tests never start Codex. The image test runs with no network,
no runtime data mounts and a read-only filesystem. Credentials and production
data are unnecessary.

CI validates the rejection/recovery case on the full candidate server; it does
not prove every possible automated wake path is disabled. Independently review
those paths before activation. The single-use permit remains the final barrier
to a model invocation. Repeat the isolated server test on the exact image
digest selected for promotion. A rejected admission must produce no successor
run or queued wake request.

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

## Image delivery from CI

After a main-branch push passes all image tests, CI exports that same image,
three public source controls and a manifest as a temporary Actions artifact.
The image is labeled with its exact repository commit. The manifest records
image ID, platform, archive SHA256 and each control SHA256. Export refuses a
checkout/image mismatch, tracked changes, unexpected platform or existing output.
Only the listed public source controls are copied; runtime directories and
credentials are never included. No registry credentials or deploy permissions
are added to this workflow.

Retention is one day. The operator should remove the artifact after verified
transfer to limit storage. PR builds do not export installation artifacts.
Before installation, verify the workflow run and source commit independently
of the manifest, validate the archive and control hashes, then import the image
and confirm its exact ID. Loading an image alone must not restart any service.
Independent review and approval remain required before promotion.

### Required installation permissions

Actions artifact transfer does not preserve Unix execution permissions. The
manifest includes fixed controlModes; do not rely on the archive's file modes.
An administrator must restore and verify these modes after hash validation:

| Control | Owner/group | Mode |
| --- | --- | --- |
| codex-pilot | root/root | 0755 |
| authorize-packet.py | root/root | 0700 |
| packet-preflight.py | root/root | 0644 |

Use the fixed allowlist above, not arbitrary names or modes from an untrusted
manifest. Verify content SHA256, ownership and modes before restarting the
service. After container recreation, verify UID 1000 can read the preflight
and execute the launcher. Keep the agent paused and no permit present during
these checks. A correct content hash alone does not establish executability.

## Compatibilidade de autenticação dos MCPs internos

O overlay também corrige o campo gerado pelo adaptador Codex de `headers` para `http_headers`, reconhecido pelo CLI fixado. O SHA256 do gerador upstream é conferido antes de qualquer escrita. Os valores e as verificações de identidade dos tokens permanecem no mecanismo upstream. Uma edição manual da configuração não basta, pois o adaptador a gera novamente em cada execução.

A fixture isolada inspeciona os cabeçalhos com o CLI real, sem chamar um modelo, e consulta as listas de ferramentas dos dois MCPs com tokens apenas do banco descartável. Também verifica recusas sem token, com token inválido, vencido, de outro run e do tipo de autenticação inadequado. Nenhuma ferramenta de escrita é chamada. Tokens não são impressos e credenciais de produção não são montadas.

Os testes de uma tentativa e ausência de sucessor continuam obrigatórios. A correção deve receber revisão independente e aprovação conforme [política de revisão](../../docs/REVIEW_POLICY.md) antes de instalar. A redução do contexto das skills fica em uma mudança separada.
