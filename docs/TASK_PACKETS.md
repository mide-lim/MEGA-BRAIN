# Prompt Master task contracts

A versioned Prompt Master contract declares task identity, project, objective, scope, allowed and prohibited operations, context, acceptance criteria, resource limits, approvals, evidence, and expiry. Use `templates/prompt-master.schema.json` and the versioned template/example; independent `MB-` task IDs are required. Paperclip issue identifiers are not required.

Historical `tasks/*.json` packets are retained unchanged as archive material. `scripts/check_task_packets.py` validates both their legacy format and current Prompt Master contracts. A contract is not a system permission or a live-service approval.

## Controls

Only explicitly configured Hermes profile routes are valid. Developer writes and tests; Validator independently reviews read-only. Preserve actual session lineage and results. Never automatically replay an uncertain interruption. Live media, Google, IAM, paid API, and deployment remain separately gated.

The migration operator cutover is pending: protected active `AGENTS.md`, the active workflow, and repository publication have not been changed. Historical Paperclip and Codex-pilot assets are preserved, not executed.

[Workflow](AGENT_WORKFLOW.md) · [Review policy](REVIEW_POLICY.md) · [Home](../README.md)
