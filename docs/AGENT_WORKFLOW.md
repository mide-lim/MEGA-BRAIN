# Hermes task workflow

The approved operating architecture is a single Hermes runtime with Codex as provider, Desktop Commander as transport, and explicitly configured profile routes. The repository cutover is staged for independent review and pending trusted operator installation; this checkout does not alter the active protected `AGENTS.md` or active workflow.

## Roles and authorization

A task is admitted by a versioned Prompt Master contract, not by Paperclip state or a native Codex agent. Use the named Hermes Central → Reels coordinator → Developer/Validator routes only. The Validator is read-only and independent. No model, profile, or process is started automatically by editing a task or changing state. The operator authorizes each run under the deployed root-owned controls; contracts do not grant system permissions.

Keep offline implementation separate from live media, Google, IAM, paid API, and deployment approvals. Never read or expose credentials. Historical packets, Paperclip code, and Codex-pilot material remain preserved for reference and are not active orchestration.

## Run and review

Validate a contract before dispatch. Developer implements and executes deterministic tests; Validator independently reviews the diff and evidence, then runs the read-only probe. Retain actual session lineage, tool outputs, test results, limitations, and finalization acknowledgements. Do not claim tests or review that did not occur. Do not retry uncertain/interrupted runs automatically.

The exact offline validator command for this migration is `bash /reference/validate_offline.sh` as a standalone command. Protected-file installation, active workflow archival, and repository publication remain pending operator action after independent review.

[Prompt Master contracts](TASK_PACKETS.md) · [Review policy](REVIEW_POLICY.md) · [Start](../README.md)
