# Hermes migration — evidence dated 2026-10-28

## Evidence and observation limits

This report separates historical runtime evidence from task006 offline repository
staging. Sources are the read-only `/reference/AUDIT-INPUT.json` (audit timestamp
2026-10-28T22:16:49.806105+00:00) and `/reference/e2e-acceptance.json` (accepted
2026-10-28T23:02:55.891895+00:00). These are supplied evidence, not new service
probes or fresh deployment claims. The audit covers only the authorized VPS namespace.

The recorded architecture is one Hermes runtime: Codex is the subscription provider,
Desktop Commander transports tools, and native specialists/Paperclip operations are
not active. The recorded clean Hermes core was
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`; the E2E plugin was
`b3825d097195b5748585b0491fab48c95d105c19`.

## Actually exercised versus prepared

The audit reports ten configured profiles, but only Central, Reels, Developer and
Validator were actually tested. Research, Planner, Writer and other project profiles
were prepared only; configuration is not execution or acceptance. Real synthetic
orchestration in the E2E used these sessions and parent lineage:

| Role | Session | Parent |
| --- | --- | --- |
| Central | `mb-hermes-6982bbb07e0441dda9de4b57374e288a` | none |
| Reels | `20261028_225715_e8fc52` | Central session above |
| Developer | `20261028_225721_2a074b` | Reels session above |
| Validator | `20261028_225736_bde0e4` | Reels session above |

The E2E records 18 calls in the successful phase, 50 guard-observed calls including
failed attempts, and 11 deterministic negative simulations. Those historical totals
are not the budget or call consumption of task006. The current offline policy is
Central `gpt-6-luna`, Reels/Developer/Validator `gpt-6.1-sol`, provider
`openai-codex`, finite budget 32 or 48, deadline 600 seconds, concurrency 1,
depth 2, no paid fallback. Child iteration limits are 12 for 32 and 18 for 48.

The exact reserved `context_refs` entry `review-only:true` admits review mode only
for offline-code-only scope. It prohibits Developer initialization/delegation and
implementation, mounts every project workspace read-only, and permits only
Central → Reels → Validator. Success requires no Developer plus actual Validator
offline-test and read-only-probe outputs and standalone approval. Ordinary contracts
retain the Developer → Validator flow; budgets, models and deadlines are unchanged.

## Memory, isolation and interruption

The existing ai-memory was reused; native Hermes memory was disabled. The audit
records exact finalization, handoff, restart and isolation passing, and the E2E
phase explicitly includes memory restart/isolation with runtime PIDs 234589,
237431 and 237024. The audit retirement gate records actual E2E, recovery,
isolation and interruption passing. These historical acknowledgements do not
constitute task006 finalization acknowledgements. Interrupted/uncertain dispatches
must remain unknown and must not be replayed automatically. Current portable tests
exercise interruption and retrieval deterministically, not live memory or models.

## Installed runtime versus pending repository cutover

The audit records the installed Hermes runtime and `hermes-pilot` launcher. Its
observed services were MCP stability monitor, PC mount, tailscaled and VPS MCP
host; observed containers were gateway, caddy and backend. No absence claim is
made for other hosts. No service/container is changed by this offline task.

The historical E2E remaining list included active legacy retirement/repository CI,
general Prompt Master dispatch and Sprint2E API-auth offline implementation/review.
The current checkout now stages the Prompt Master controller, schema, template,
example, checker integration and portable tests; this is not a claim that these
repository revisions are installed in production. Production authority roots stay
pinned; environment variables and task payloads cannot choose authority roots.

[The cutover manifest](../ops/hermes/cutover.json) pins active instructions,
[the proposed replacement](../operations/hermes-control/proposals/AGENTS.md.txt),
and the active workflow/exact archive. Independent review, trusted operator
installation/active workflow retirement, repository CI/publication and deployment
remain pending. Active `AGENTS.md` and `.github/workflows/paperclip-control.yml`
are untouched. [Historical instructions](history/AGENTS-2026-10-28.txt) preserve
the exact active bytes; they are evidence, not current task authority. No link
checker exemption was added for active Markdown.

## Still gated or pending

Sprint2E API-auth implementation and independent review remain pending offline
work, not an accepted deliverable of this migration task. This report makes no
Google pilot readiness claim: the audit records zero model POSTs, no ADC, no
temporary IAM or real grant, and preservation of the protected key and empty
ledger. The E2E records no Google calls, paid API route or native specialists.
Live Google/media/IAM, financial gates and deployment remain separately denied
or subject to explicit future authorization; no synthetic evidence authorizes them.

Preserve Git history, sprint evidence, backups, media, still-used credentials,
operational databases and PR101/102/103. No data deletion is authorized. Task006
test results and real sessions belong in its actual runtime receipt/transcripts;
no independent approval or finalization is asserted by this staged report.
## Trusted operator closure — 2026-10-28 (BRT)

The preceding pending/staging statements describe the pre-cutover checkpoint. They are historical observations, superseded by this receipt and the applied manifest. The owner authorized reviewed installation, publication and merge with satisfactory CI; Google execution remains excluded.

Full staged review was approved in MB-HERMES-FINAL-RECONCILE-20261028-011, Validator 20261029_005727_363b6f. The only post-cutover correction changed the historical CI link in ops/paperclip/SINGLE_ATTEMPT.md to the preserved archive. Installed-controller task MB-HERMES-POSTCUTOVER-LINK-20261028-013 actually routed Central → Reels → Developer → independent Validator. Final acceptance MB-HERMES-CONSOLIDATE-20261028-016, Validator 20261029_011533_fa247b, approved current source, actual archived gates and fresh acceptance.

Real tools verified the applied checker, full source preservation, exact one-line diff, 78 valid Markdown links, 19 orchestration tests, 55 controller tests and read-only denial. The 55 tests also passed as UID65534, all capabilities dropped, no network, source read-only. SQLite ResourceWarnings remain non-fatal. E2E JSON printed by unit fixtures is simulation; the session identities above are real runs.

Active instructions equal the proposal, SHA256 e9b5a5a938af3d7aa2725856d27de5f1a4ba3afb8e29e5d35193b8c3a0c3826d. Historical AGENTS and workflow retain SHA256 b5f68918a7667a1a764212379f043eb622d32b8f0465d7e4aa641d602363d60a and 0695ec04052a2db1ba88ac187fdfae628d353812716d224141ab0b2d58356cbb. The old workflow is absent from the active directory.

The reviewed seven-module bundle is installed under the canonical VPS root at operations/hermes-control/releases/b168b6b03ef28351, aggregate SHA256 b168b6b03ef283514a288c13e9c481dc67a25daf089faf16596ca3f1bef7b2e8. The sole owner CLI is bin/megabrain-task (run/status/result). It is finite and on demand, without a gateway, scheduler, native-agent fallback or another Hermes installation. Root-owned contracts, deduplication, unknown states, tools/models and the existing subscription route stay enforced. Review-only mode forbids Developer and mounts all project scopes RO. Final acceptance recorded exact ai-memory finalization, actual handoff and shutdown; restart/project isolation remain proven by the earlier real E2E.

Official state and plan are the JSON files at /srv/vps-mcp/workspace/megabrain-restructure/. The retired Paperclip path is not required. Local mirror instructions were updated with previous bytes preserved. Official state records GitHub CI/integration separately; the source manifest grants no deployment.

PR101–103, multimodal A+B, provider, signed approvals, durable ledger and the protected release remain preserved. No live policy was installed. No Google login/token, IAM, inference, media access, queue, paid model API or product deployment occurred in this closure. Next work is only offline API-auth adaptation from existing handoffs: short-lived impersonation design, trusted root-policy binding, one-shot encrypted transport and fake-token tests, retaining strict ADC. Real minting, permissions and a Reel run require separate authorization.
