# Google identity and activation proposal

Status: proposal only, audited 2026-10-27. Offline CI is the only activated path in this PR. No Google login, identity change, inference, media transmission, billing configuration or deployment is authorized here.

## Observed identity boundaries

The private audit separates the Console user, local Cloud CLI, GitHub federation, VPS process and future worker. The human CLI account has Owner; its default project is unset, so every audit command selected the approved project explicitly. Human Console/CLI access does not establish VPS authentication.

Ten enabled service accounts were observed. Their current roles divide into legacy worker, web, queues, operations/data operator, billing reconciler/trigger, two deploy accounts and the default compute account. No user-managed keys were returned by the ten metadata-only key listings. This does not establish absence of every credential type.

The legacy worker identity is shared by four existing Cloud Run services and holds Vertex AI User, Speech Client, Datastore User, Logging Writer and Service Usage Consumer. It is unsuitable for a new least-privilege pilot. The operations identity also has object and datastore read access; it is not a strictly metadata-only auditor. Existing identities and workloads remain unchanged.

An active GitHub pool/provider and a deployment service-account binding were read. The provider restricts immutable owner/repository IDs, main, workflow_dispatch, the exact deployment workflow and the production environment subject. Its observed subject uses GitHub's immutable-ID format. This is structural evidence, not a successful OIDC exchange or deployment test. GitHub documents [subject variants](https://docs.github.com/en/actions/reference/security/oidc); do not replace this provider with a generic example.

The main branch currently reports protected=false and no repository rulesets were returned. Production environment reviewers/protection could not be verified: the connector does not support that administration endpoint and the browser has no signed-in GitHub session. Do not describe production as protected until these settings are checked. No merge or CD run is part of this PR.

On the VPS, gcloud was not on PATH; the two checked standard ADC locations and ADC override environment variables were absent. A network-denied official ADC discovery diagnostic did not establish usable credentials. The private runtime is root-owned and mode 0700, so the intended operational user cannot use it. Do not change its permissions to expose private state.

## Logical profiles and minimum scope

These are responsibilities, not seven new accounts. Exact private identifiers and dated bindings belong in the private audit.

| Profile | Current or proposed identity and service | Minimum permissions and scope | Authentication, persistence and revocation |
| --- | --- | --- | --- |
| Human administrator | Existing human; approves sensitive changes | Existing Owner observed; do not propagate Owner to automation. IAM administration only during a separately approved change | Human login; revoke sessions/bindings through the administrator; current broad access is a recorded risk |
| Google auditor | Existing read-only operator only for already authorized resources; proposed narrow metadata role if needed | Project get/getIamPolicy, service-account list/get/getIamPolicy, pool/provider get/list, enabled-service and relevant quota metadata; add resource viewers only when required | Existing audited human/impersonation route; no data-plane media/object read by default; remove scoped bindings |
| Developer | Existing human for source and supervised diagnostics | No cloud rights needed for offline development. Future Token Creator only on the dedicated worker SA | Local reviewed runtime; supervised ADC impersonation after approval; revoke source ADC and SA binding |
| GitHub CI | No Google identity | GitHub contents:read; no id-token:write, Google secrets, environment or cloud role | Ephemeral runner; no cloud credentials to persist or revoke |
| GitHub Deploy | Reuse existing deployment SA and GitHub provider | Existing resource-scoped deploy roles; workloadIdentityUser on that exact SA. Audit final deployment plan before changing rights | OIDC to SA impersonation, manual approved workflow only; remove provider/binding for future exchanges |
| Reels multimodal worker | Propose one dedicated SA, not the shared legacy worker | Custom project role: aiplatform.endpoints.predict plus serviceusage.services.use on the explicit quota project. No Storage, Speech, Firestore, deploy or secret roles | Supervised impersonated ADC for the pilot; short-lived target token. No autonomous service identity established yet |
| Financial control | Existing human for this read-only audit; future scoped billing viewer if needed | billing.accounts.get, getPricing, getSpendingInformation, billing.credits.list, billing.budgets.get/list on the billing account; extra billing IAM reads only for that audit | Human/approved viewer; viewing costs does not permit setting a cap; revoke billing binding separately |

The exact current permission catalog must be checked before creating a custom role. In the audited current catalog, pool/provider permissions include iam.googleapis.com/workloadIdentityPools.get/list and iam.googleapis.com/workloadIdentityPoolProviders.get/list. Do not silently substitute older permission names. See [IAM roles](https://docs.cloud.google.com/iam/docs/roles-permissions/iam) and [billing roles](https://docs.cloud.google.com/iam/docs/roles-permissions/billing).

The two worker permissions are project scoped; they do not enforce a single model, region, duration, price or call. Do not claim an untested resource.name IAM condition fences a publisher model. The application must enforce the exact external grant and allowlist. Vertex AI User is substantially broader. See [model access control](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control) and [quota projects](https://docs.cloud.google.com/docs/quotas/set-quota-project).

## Authentication decision

| Option | Security and persistence | Dependencies, cost and suitability |
| --- | --- | --- |
| VPS federation | Avoids a human refresh credential when backed by a trusted issuer; rotates subject/target tokens | No suitable external issuer was established by the bounded audit. SSH, Tailscale and Codex login are not that issuer. Do not build an issuer or reuse GitHub tokens outside their job |
| Supervised impersonated ADC | Human source refresh credentials persist locally until revoked; target access token is short lived, normally at most 3600 seconds | Preferred for one manually supervised pilot after approval. Requires dedicated SA, scoped Token Creator, approved operational-user runtime and manual login. This is not permanent unattended authentication |
| Managed Google worker | Attached SA obtains credentials from its managed runtime; no human refresh credential on the VPS | Possible future automation, with deployment and infrastructure costs. No Cloud Run/job/storage/queue deployment is proposed for this Sprint |

For GitHub CD, direct WIF removes the intermediary SA when the target supports federated principals. SA impersonation is already configured and is the simplest reuse for this existing pipeline; do not redesign it just to complete offline CI. Workload Identity User on the exact SA permits the federated exchange; Service Account User/actAs only permits attachment, and human Token Creator permits impersonation. See [deployment federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) and [SA permissions](https://docs.cloud.google.com/iam/docs/service-account-permissions).

Python supports [impersonated ADC](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment). A future approved setup may use gcloud auth application-default login --impersonate-service-account WORKER_SA_EMAIL under the operational user. This writes source credentials and requires explicit approval; no login is executed by this document. Do not print credentials or access tokens. Revoke the application-default login after the supervised session, and remove the temporary impersonation binding when no longer needed.

The prepared adapter must accept only the exact approved impersonated target, source profile, quota project and explicit ADC path supplied by a future trusted grant. One human OAuth refresh plus one target IAM exchange is separate from the single inference POST. Unknown credential types, endpoints, redirects, retries, target/project mismatches and delegated impersonation remain denied. This path is tested with stubs and independently with the installed official SDK using entirely synthetic credentials and a fake HTTP transport; real authentication is untested. google-auth 2.62.0 is the reviewed runtime snapshot; it is excluded from offline CI. Its [current package](https://pypi.org/project/google-auth/2.62.0/) moved to the active Google Cloud Python monorepo; an archived repository's release page is not an upgrade guide.

## Grouped activation proposal — not applied

1. Create one dedicated worker SA and one custom project role containing only the two worker permissions above. Bind the role to that SA and Token Creator to the approving human on that SA only. Do not alter legacy SA roles, existing WIF, APIs or deploy configuration. Required administration: service-account create, custom-role create and scoped project/SA IAM policy changes.
2. Install an isolated runtime owned by the operational user, with an approved private ADC directory and explicit project/quota project. Keep the existing root-private evidence/runtime unchanged. Review package hashes and directory ownership before login.
3. After approval, have the human perform the supervised impersonated ADC login. Validate the strict profile and target without logging credential contents; if separately approved, refresh once and perform only one allowlisted metadata GET. Successful metadata access is not inference readiness.
4. Keep the real authority denied until a separately implemented and reviewed grant issuer/validator binds media ID/hash, project, model, location, identity, approved storage roots, versions, expiry, one-call reservation and numeric gross budget. No task JSON or CLI flag can replace that grant.
5. Request media read/probe/hash/transmission and inference spending separately, after quota, credit eligibility, retention and payload limits are resolved. The suggested US$0.50 has not been authorized. Current billable execution budget is zero.

Risk and cost: creating this dedicated identity need not deploy a service, but predict permission can authorize billable requests if used outside the reviewed controls. Human ADC is persistent source authentication. Scope names, including cloud-platform.read-only, are not a reliable inference fence. Neither this PR nor IAM alone supplies a financial ceiling.

Validation: verify selected fields of the new SA and its exact bindings, run offline tests, then test only the explicitly approved auth metadata route. Do not use generateContent or CountTokens as a connectivity test. Record credential class, target, quota project, expiry and success without tokens, headers, raw ADC or tracebacks.

Rollback: revoke the local application-default login, remove the dedicated human-to-SA binding and the dedicated project role binding; disable/delete only the newly created unused SA/role after checking dependencies. Credential and policy revocation is not instantaneous; already issued tokens and calls may continue during expiry/propagation. Do not delete journals, reservations, captured responses or uncertain attempts.

## Financial controls and remaining gates

Credits, pricing and budgets are separate facts. Exact account figures, SKU checks and model readiness are documented in the dated private Sprint report; no private billing data is committed here. A positive credit balance does not establish coverage for a chosen SKU.

Alert-only budgets do not stop spending. Eligible [spend cap budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) may restrict first-party Vertex AI usage for one project/month, but measure gross usage without credits, have measurement/enforcement delay, allow in-flight requests to finish and may leave fixed costs running. No cap, budget or API is enabled here. Project cap configuration requires billing.resourcebudgets.read/write/configureSpendCap and project get; billing-account configuration uses billing.budgets.configureSpendCap. Viewing finance does not grant these rights.

Before a real pilot: exact model/location entitlement, effective quota, video/audio payload limits and codec support, retention/region choice, credit/SKU eligibility, approved gross budget, source media authority, operational-user auth and storage permissions, external grant implementation and independent review must all be satisfied. Windows ACL and power-loss durability are not proved by synthetic readback tests.

## Reproducible operator sequence

Run the [offline checks](README.md#local-checks) first. They require no Google identity. Then review the private dated inventory and finance evidence with explicit project selection. Never treat a refreshed report timestamp as a refreshed observation.

For a later authorized authentication diagnostic, use an explicit trusted ADC path and a bounded official transport; log only safe identity metadata. Stop on 401/403 or unknown credential profile and propose the exact missing permission. Do not widen roles, retry a model request or fall back to another provider.

For an authorized media run, follow the [one-call procedure](README.md#future-one-call-procedure). After an ambiguous request or storage failure, preserve the reservation and captured raw response; there is no automatic retry or reset. Recover by validating manifest seals, version hashes and journal consistency, followed by independent review. Publication, expansion and deployment require their own acceptance.
