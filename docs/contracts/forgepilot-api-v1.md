# forgepilot-api/v1

**Status:** normative public API contract (v0.8)

This is the Node-to-UI API: the Node-to-Electron/React workbench surface (M0)
and the enterprise identity surface (ADR-0006). The UI only calls Node — at an
ephemeral loopback address in the local pilot, or the enterprise service's
configured origin — and it never sees dsh sockets, boot tokens, Pi credentials,
raw tool output, or provider credentials. The OpenAPI document and TypeScript
client under `web/src/api/contracts/` are generated from the implementation and
must conform to this contract; the conformance tests compare all three.

## Authentication

Every `/api/v1` request in the local pilot MUST carry the per-process bearer
token:

```
Authorization: Bearer <token>
```

The token is minted fresh at each orchestrator start and written `0600` to a
user-private file (`FORGEPILOT_API_TOKEN_FILE`, default
`$TMPDIR/forgepilot-<uid>/api-token`). The UI, running as the same local user,
reads that file and the ephemeral loopback port from the orchestrator's startup
configuration and sends the token on every call. Possessing the token — not a
statically configured identity string — is what authorizes a caller to act as
the local operator, approvals included.

A missing, malformed, or wrong token is `401 UNAUTHENTICATED` on every
endpoint. The server additionally pins browser requests to its own loopback
`Origin` and requires `application/json` bodies, so a cross-site page cannot
ride a simple request; those guards are server-side hardening and do not
replace the token.

The OpenAPI document declares two security schemes: `bearerAuth`
(`type: http`, `scheme: bearer`) and `sessionCookie` (`type: apiKey`,
`in: cookie`, `name: fp_session`). The local pilot authenticates with the
bearer token on every endpoint. The enterprise identity surface accepts either
credential for the same server-side session:

- **web** — the protected `fp_session` session cookie (HttpOnly, SameSite=Lax,
  Secure), set by the OAuth callback. Every state-changing request
  authenticated by cookie MUST echo the session's `csrf_token` in the
  `X-CSRF-Token` header; a missing or wrong value is `403 CSRF_TOKEN_INVALID`.
- **desktop** — the session access token returned by the desktop flow
  exchange (`POST /api/v1/auth/desktop/flows/{flow_id}/exchange`), sent as
  `Authorization: Bearer <token>` and held by the desktop main process; it is
  never exposed to renderer JavaScript. Bearer requests are not ambient and
  carry no CSRF header.

`401 UNAUTHENTICATED` is uniform: a missing, malformed, expired, or
invalidated credential, a suspended account, and an invalid desktop exchange
ticket all return the same body and never name the cause (see
Non-enumeration). A credential authenticates the principal only — it never
grants scope. Every non-public operation documents the `401` response; the
anonymous login-bootstrap operations (`GET /api/v1/auth/providers`,
`GET /api/v1/auth/login`, `GET /api/v1/auth/callback`,
`POST /api/v1/auth/desktop/flows`,
`POST /api/v1/auth/desktop/flows/{flow_id}/exchange`) require no credential.

## Enterprise identity, sessions, and administration (DAT-202)

When the deployment configures `FORGEPILOT_OAUTH_CLIENTS_FILE`, the API also
serves the ADR-0006 identity surface and `/api/v1/tasks` requests MAY instead
authenticate with a server-side session:

- **Web** sessions arrive as the `fp_session` HttpOnly, `SameSite=Lax` cookie
  (`sessionCookie` scheme). Cookie-authenticated mutating requests MUST echo
  the session's CSRF token from `GET /api/v1/auth/session` in the
  `X-CSRF-Token` header. Session tokens are 256-bit random values stored only
  as SHA-256 digests; the CSRF token is the pairing secret and grants nothing
  without the cookie.
- **Desktop** sessions arrive as `Authorization: Bearer <session-token>`
  (desktop flows skip CSRF: no ambient credential is sent). Desktop sign-in
  starts in the system browser; the credential is delivered exactly once by
  `POST /api/v1/auth/desktop/flows/{flow_id}/exchange`, and neither an
  embedded login page nor Git passwords are involved.
- Login is OAuth authorization code with a single-use `state`, an S256 PKCE
  challenge, and one exact pre-registered `redirect_uri`. The flow is bound to
  the starting browser via the `fp_oauth_binding` HttpOnly cookie, so a
  login-CSRF callback is refused. Accounts are matched only by (provider
  instance, stable provider subject); emails never merge identities.
- Only administrator-approved provider instances accept logins. Registration
  (`POST …/provider-instances`) refuses arbitrary self-hosted and
  internal-network origins: HTTPS, no credentials/path/query/fragment, default
  port, public hostname or IP literal, and public DNS answers are required.
- The first enterprise administrator is granted only through the
  deployment-owned bootstrap (`POST …/bootstrap`, `X-Bootstrap-Token`,
  audited, at most once per enterprise, naming the provider identity
  explicitly). The first ordinary login never becomes an administrator.
- Logout, suspension, and membership revocation invalidate sessions
  immediately: reads, writes, and live SSE subscriptions all fail or close.
  Session-authenticated task access additionally requires an active workspace
  membership (`viewer` is read-only).
- Authentication secrets (OAuth client secrets, session tokens, desktop
  secrets, states, verifiers) never appear in renderer responses, logs, audit
  records, callback URLs, or analytics.

Endpoints (details in the OpenAPI document):

| Request | Request body | Response |
|---|---|---|
| `GET /api/v1/auth/providers` | none | `200 {items: LoginProvider[]}` |
| `GET /api/v1/auth/login?provider_instance_id=&return_to=&desktop_flow=` | none | `302` to the provider; `Set-Cookie: fp_oauth_binding` |
| `GET /api/v1/auth/callback?code=&state=` | none | web `302` + `Set-Cookie: fp_session`; desktop `200` text |
| `GET /api/v1/auth/session` | none | `200 SessionInfo` (incl. `csrf_token`) |
| `POST /api/v1/auth/logout` | none | `204` |
| `POST /api/v1/auth/desktop/flows` | optional `provider_instance_id` | `201 DesktopFlow` |
| `POST /api/v1/auth/desktop/flows/{flow_id}/exchange` | `{secret}` | `200 {token,…}` once; `428` pending, `410` consumed/expired |
| `POST /api/v1/admin/enterprises/{enterprise_id}/bootstrap` | `provider_instance_id`, `subject` | `200 {enterprise_id, user_id, role:"admin"}` |
| `POST /api/v1/admin/enterprises/{enterprise_id}/provider-instances` | `provider_type`, `origin_url` | `201 {provider_instance}` |
| `GET /api/v1/admin/enterprises/{enterprise_id}/auth-audit?limit=` | none | `200 {items: AuthAuditRecord[]}` |
| `PUT /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}` | `{role}` | `200 Membership` |
| `DELETE /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}` | none | `204` |
| `POST /api/v1/admin/users/{user_id}/suspend` | optional `enterprise_id` | `200 User` |
| `POST /api/v1/admin/users/{user_id}/activate` | optional `enterprise_id` | `200 User` |

## Task resource

```json
{
  "id":"tsk_01J...","workspace_id":"wsp_01J...","version":12,"created_at":"2026-10-26T12:00:00Z","updated_at":"2026-10-26T12:03:00Z",
  "current_run_id":"run_01J...","run_history_url":"/api/v1/tasks/tsk_01J.../runs",
  "repository":{"id":"github:acme/payments","display_name":"acme/payments","base_ref":"main","base_sha":"ab12cd..."},
  "request":{"summary":"Fix export exception.","source_reference":"https://github.com/acme/payments/issues/1234"},
  "association":{"task_id":"tsk_01J...","run_id":"run_01J...","repository_id":"github:acme/payments","base_sha":"ab12cd...","head_sha":"9ef012..."},
  "revision":{"base_sha":"ab12cd...","head_sha":"9ef012..."},
  "status":"executing","status_reason":null,
  "risk":{"class":"low","decision_code":"risk_low_approved","requires_human_approval":false},
  "progress":{"phase":"validating","actions_completed":2,"actions_total":3},
  "pi_summary":{"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","status":"unavailable","text":null,"unavailable_reason":"untrusted_source","source":null,"updated_at":"2026-10-26T12:03:00Z"},
  "governance":{"current_head_sha":"9ef012...","observations_valid":true,"merge_queue_eligible":false},
  "artifacts":{"patch":null,"report":null,"evidence_bundle_available":false,"index":[{"artifact_id":"patch_report","available":true,"digest":"sha256:…","head_sha":"9ef012..."}]}
}
```

`run_history_url` is relative to the route family that served the task:
`/api/v1/tasks/{task_id}/runs` on the legacy compatibility family and
`/api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs` on the
workspace-scoped family, so following it can never cross workspaces.

`workspace_id` is the task's durable workspace ownership. It is always equal
to the workspace in a workspace-scoped path, is never a request input, and can
never be changed: a task read through another workspace's route family is
`404 TASK_NOT_FOUND`.

`association` and `revision` are the verifiable task/run/repository/base-SHA/
head-SHA bindings. `run_id` and `head_sha` are projected from the
authoritative dsh run (`head_sha` from its patch report, null until one
exists); `task_id`, `repository_id`, and `base_sha` are the creation bindings
dsh accepted and pinned for the run — Node records them at create time and
never invents or re-derives them afterwards. `governance` projects the GitHub merge boundary for
the current head: approvals and checks are observations of one exact head, so
when dsh reports a newer head than the last approval snapshot, Node marks
`observations_valid: false` and `merge_queue_eligible: false` until dsh
observes them against the current head. `artifacts.index` lists artifact
metadata (identifier, availability, digest, bound head) as reported by dsh;
binary contents stay behind `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}`.

The UI status enum is `queued`, `assessing_risk`, `awaiting_approval`,
`approved`, `planning`, `executing`, `validating`, `awaiting_review`,
`approved_for_merge`, `stopped`, `rejected`, `cancelled`, `timed_out`,
`expired`, or `merged`. It is a projection and cannot mutate dsh's state
machine. `failed` is deliberately not a status: an execution failure is
projected as its authoritative `stopped` or `timed_out` outcome.

Cancelled tasks expose `archived`, a durable workspace visibility flag. It
defaults to true for existing cancelled tasks. Restoring a task sets it to
false without changing its terminal status, run, or event history; archiving
it again sets the flag to true. Other task statuses omit this field.

`pi_summary` is the display-safe projection for the latest settled Pi turn
of the task's current run; free model turn text is never displayable
(DAT-193 trust boundary) and the available path is the turn's validated
structured Pi report (see [Safe Pi text
summary](#safe-pi-text-summary) below). Text is served only together with
the verifiable `source` record that proves it (DAT-194); a summary whose
source cannot be re-proven — including every summary recorded before the
provenance contract — is served `unavailable` with `text:null`. It is
`null` until a Pi session exists for the task.

## Authoritative run-state projection

The authoritative dsh value is exactly the state vocabulary in
[`task-evidence-contract-v1` §5](task-evidence-contract-v1.md). UI status is
allowed only the following mapping; no other dsh-to-UI mapping is valid.

| UI status | Allowed dsh state | Meaning |
|---|---|---|
| `queued`, `assessing_risk`, `awaiting_approval` | `requested` | Request exists, risk/grant decision is incomplete. |
| `approved` | `approved` | Grant is recorded but execution has not begun. |
| `planning`, `executing`, `validating` | `running` | Display phases of one authoritative running state. |
| `awaiting_review` | `awaiting_review` | Current-head PR exists; repository mutation has stopped. |
| `approved_for_merge` | `approved_for_merge` | Current-head governance observations permit GitHub merge-queue admission only. |
| `stopped` | `stopped` | A stop condition needs human disposition. |
| `timed_out`, `expired`, `rejected`, `cancelled`, `merged` | Same-named dsh state | Terminal authoritative outcome. |

`current_run_id` identifies the run from which the displayed state and evidence
were derived. `GET /api/v1/tasks/{task_id}/runs` returns the ordered redacted
run summaries for that task; terminal grants are never reused.

## Endpoints

| Request | Request body | Response |
|---|---|---|
| `POST /api/v1/tasks` | `repository_id`, `base_ref`, `summary`, `source_reference`, `acceptance_criteria[]`; optional `Idempotency-Key` header | `201 Task` |
| `GET /api/v1/tasks?cursor=&status=` | none | `200 {items: Task[], next_cursor}` |
| `GET /api/v1/tasks/{task_id}` | none | `200 Task` |
| `GET /api/v1/tasks/{task_id}/runs` | none | `200 {items: redacted RunSummary[]}` ordered by creation time; optional `actions_completed` / `safety_events` / `updated_at` are run-attributed and absent when they cannot be |
| `POST /api/v1/tasks/{task_id}/messages` | `{mode:"steer"|"follow_up",content:"..."}` | `202 {task_id, queued:true}` |
| `POST /api/v1/tasks/{task_id}/approvals` | `{decision:"approve"|"reject",scope_digest:"sha256:..."}` | `200 Task` |
| `POST /api/v1/tasks/{task_id}/cancel` | optional reason | `202 Task` |
| `POST /api/v1/tasks/{task_id}/archive` | none | `200 Task` with `archived: true` |
| `POST /api/v1/tasks/{task_id}/recover` | none | `200 Task` with `archived: false` |
| `GET /api/v1/tasks/{task_id}/timeline` | none | `200 {items: TimelineEvent[]}` |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | none | `200 redacted artifact` |
| `GET /api/v1/tasks/{task_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |
| `POST /api/v1/workspaces/{workspace_id}/tasks` | `repository_id`, `base_ref`, `summary`, `source_reference`, `acceptance_criteria[]`; optional `Idempotency-Key` header (workspace-scoped namespace) | `201 Task` bound to the workspace's repository and gateway identity |
| `GET /api/v1/workspaces/{workspace_id}/tasks?cursor=&status=` | none | `200 {items: Task[], next_cursor}` confined to that workspace |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}` | none | `200 Task` |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs` | none | `200 {items: redacted RunSummary[]}` |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/messages` | `{mode:"steer"\|"follow_up",content:"..."}` | `202 {task_id, queued:true}` |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/approvals` | `{decision:"approve"\|"reject",scope_digest:"sha256:..."}` | `200 Task` |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/cancel` | optional reason | `202 Task` |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/archive` | none | `200 Task` with `archived: true` |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/recover` | none | `200 Task` with `archived: false` |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/timeline` | none | `200 {items: TimelineEvent[]}` |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts/{artifact_id}` | none | `200 redacted artifact` |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |
| `GET /api/v1/workspaces?cursor=` | none | `200 {items: Workspace[], next_cursor}` |
| `POST /api/v1/workspaces` | `{name, repository_id, provider_instance_id}` | `201 Workspace` |
| `GET /api/v1/workspaces/{workspace_id}` | none | `200 Workspace` |
| `PATCH /api/v1/workspaces/{workspace_id}` | `{name, version}` | `200 Workspace` |
| `POST /api/v1/workspaces/{workspace_id}/archive` | `{version}` | `200 Workspace` |
| `POST /api/v1/workspaces/{workspace_id}/restore` | `{version}` | `200 Workspace` |
| `POST /api/v1/workspaces/{workspace_id}/transfer` | `{repository_id, provider_instance_id, version}` | `200 Workspace` |
| `GET /api/v1/workspaces/{workspace_id}/members?cursor=` | none | `200 {items: Membership[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/members` | `{user_id, role}` | `201 Membership` |
| `PATCH /api/v1/workspaces/{workspace_id}/members/{membership_id}` | `{role, version}` | `200 Membership` |
| `DELETE /api/v1/workspaces/{workspace_id}/members/{membership_id}` | none | `204` |
| `GET /api/v1/workspaces/{workspace_id}/member-candidates?cursor=` | none | `200 {items: MemberCandidate[], next_cursor}` |
| `GET /api/v1/workspaces/{workspace_id}/teams?cursor=` | none | `200 {items: Team[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/teams` | `{name, leader_user_id, responsibility?}` | `201 Team` |
| `GET /api/v1/workspaces/{workspace_id}/teams/{team_id}` | none | `200 Team` |
| `PATCH /api/v1/workspaces/{workspace_id}/teams/{team_id}` | `{name?, leader_user_id?, responsibility?, version}` | `200 Team` |
| `DELETE /api/v1/workspaces/{workspace_id}/teams/{team_id}` | none | `204` |
| `GET /api/v1/workspaces/{workspace_id}/invitations?cursor=` | none | `200 {items: Invitation[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/invitations` | `{expires_in_seconds?, bound_provider_subject?}` | `201 CreatedInvitation` |
| `DELETE /api/v1/workspaces/{workspace_id}/invitations/{invitation_id}` | none | `204` |
| `POST /api/v1/workspaces/{workspace_id}/memory/search` | `{purpose, query, scope?, run_id?, max_items?, max_tokens?, context_window_tokens?, include_candidates?, policy_version?, query_embedding?}` | `200 MemoryBundle` (bounded, cited; `degraded` on store outage) |
| `POST /api/v1/workspaces/{workspace_id}/memory/feedback` | `{bundle_id, run_id, outcome, items?[], note?}` | `201 MemoryFeedbackRecord` |
| `GET /api/v1/workspaces/{workspace_id}/memory/items?kind=&status=&tier=&limit=&cursor=` | none | `200 {items: MemoryItemView[], next_cursor}` |
| `GET /api/v1/workspaces/{workspace_id}/memory/versions` | none | `200 MemoryVersions` |
| `POST /api/v1/workspaces/{workspace_id}/memory/eval-runs` | `{kind, dataset, policy_version, memory_version, metrics, verdict, notes?}` | `201 MemoryEvalRunRecord` |
| `GET /api/v1/workspaces/{workspace_id}/memory/proposals?status=&risk=&limit=` | none | `200 {proposals: RsiProposal[]}` |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals` | `{title, summary, diff, target, candidate_policy?, memory_item?}` | `201 RsiProposal` |
| `GET /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}` | none | `200 RsiProposal` |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/evaluations` | `{datasets?[]}` | `201 RsiProposal` (replay executed server-side; metrics/verifier refused) |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/approvals` | `{note?}` | `201 RsiProposal` |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/canary` | none | `201 RsiProposal` (canary at 10%) |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/canary/observations` | none | `201 RsiProposal` (sample derived from pinned runs) |
| `POST /api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/rollback` | `{reason}` | `200 RsiProposal` |
| `GET /api/v1/workspaces/{workspace_id}/memory/rsi/status` | none | `200 RsiStatus` |
| `POST /api/v1/workspaces/{workspace_id}/memory/rsi/kill-switch` | `{enabled, reason?}` | `200 {controls: RsiControls}` |
| `PATCH /api/v1/workspaces/{workspace_id}/memory/rsi/controls` | `{auto_promote_low_risk?, weekly_change_budget?, weekly_reflection_token_budget?}` | `200 {controls: RsiControls}` |
| `POST /api/v1/invitations/preview` | `{token}` | `200 InvitationPreview` |
| `POST /api/v1/invitations/redeem` | `{token}` | `200 InvitationRedemption` |

### Workspace-scoped task access (DAT-244)

`/api/v1/workspaces/{workspace_id}/tasks...` is the switching-capable task
surface. `{workspace_id}` is a **locator, not authorization**: on every
request the server resolves the caller's live membership for that workspace
from authenticated session state. Non-membership, revoked membership,
cross-enterprise, and unknown workspace are all one indistinguishable
`404 NOT_FOUND`; the response never says which condition applied. A session
with several memberships selects a workspace by the path only, and
`Task.workspace_id` always equals that path value. `viewer` is read-only
(`403 FORBIDDEN` for writes, reads allowed).

Task ownership is durable and checked on every subresource: a task id from
another workspace is `404 TASK_NOT_FOUND` for list cursors, detail, runs,
messages, approvals, cancel, archive, recover, timeline, artifacts, and the
SSE stream. SSE subscriptions are bound to both the session and this
workspace, so logout, suspension, or losing this workspace's membership
closes the stream immediately; losing membership elsewhere does not.

`GET /api/v1/workspaces` returns exactly the workspaces the caller holds a
live membership in — name, repository binding, and the caller's role — as
`{items, next_cursor}` ordered by workspace creation time. Substituting or
enumerating ids cannot widen it.

The pre-existing `/api/v1/tasks...` family remains a **local-operator
compatibility seam**: it is bound to the deployment's configured workspace
for both the operator bearer and sessions, and a session still needs
membership in that configured workspace. It is not an enterprise switcher
path, and no client-supplied workspace id, header, or body field ever becomes
an authorization input.

### Creating a task in a workspace

`POST /api/v1/workspaces/{workspace_id}/tasks` creates the task and its dsh
run inside the path workspace. The workspace's binding is authority for the
run's repository, base revision, and model-gateway enterprise/workspace
identity; the deployment's configured repository is never a fallback.

- `repository_id` must equal the workspace's repository binding; otherwise
  `400 REPOSITORY_NOT_IN_WORKSPACE`.
- `base_ref` must equal that binding's pinned base revision; otherwise
  `400 BASE_REF_NOT_SUPPORTED`.
- No live membership, unknown, archived, and cross-enterprise workspaces are
  one indistinguishable `404 NOT_FOUND`; a viewer is `403 FORBIDDEN`.
- A workspace whose repository has no pinned base revision in this deployment
  is `409 REPOSITORY_BINDING_UNAVAILABLE`; a provider instance that is no
  longer registered is `409 PROVIDER_INSTANCE_NOT_APPROVED`. Both refuse with
  zero dsh dispatch.
- `Idempotency-Key` is namespaced per workspace: the same key in two
  workspaces names two independent creates; within one workspace, a repeated
  key with a different payload is `409 IDEMPOTENCY_CONFLICT`.

```json
{"repository_id":"github:acme/payments","base_ref":"main","summary":"Fix the flaky retry","acceptance_criteria":["retry test is green"]}
```

Archive and recover apply only to cancelled tasks and return `409` for other
statuses. These operations move the existing task between workspace views;
they do not resume or create a run.

### Workspace memory (DAT-236)

The memory surface implements ADR-0009's read path and is detailed in
`docs/contracts/memory-retrieval-v1.md`. It is session-authenticated and
workspace-scoped; `workspace_id` is a locator, never authority. Retrieval
applies hard filters (workspace, applicability, status, sensitivity, validity,
approval) before hybrid BM25+vector scoring, then a strict budget: **eight
items or 1,500 tokens by default, never more than 15% of the model context**;
it omits rather than dilutes. Mandatory L4 policy is never counted against the
budget and are never truncated (a policy corpus over the supported bound fails
the request rather than returning policy-incomplete context). The caller's stated
context window is used exactly; windows below 1,000 are rejected rather than
silently enlarged. Unapproved candidates appear at reduced weight, capped at two,
and are labeled. Contradictions are surfaced rather than silently overwritten: while a
conflict is unresolved neither side is injected as fact. Every bundle names the
exact `memory_version` and retrieval-policy version it read, and every
retrieval is audited with the injected item versions. The versions surface obeys
the same sensitivity ceiling as browse: hidden items are not enumerable by ID,
version, hash, timestamp, or count, and the ceiling applies to each historical
version's own sensitivity. If the memory store is
unavailable, `search` returns `200` with `degraded: true` and no items — the run
proceeds with configured policy only, never invented lessons.

Memory is untrusted data: a bundle can never grant a capability, approve a
change, or authorize a tool action, and `dsh` remains the sole execution gate.
Promotion, deprecation, quarantine, and retrieval-policy writes are deliberately
**not** reachable from this surface; those belong to the memory lifecycle and
bounded-RSI slices.


### Bounded RSI (DAT-238)

The RSI surface is a governance layer over memory artifacts and retrieval
policy; it is detailed by `docs/contracts/memory-rsi-v1.md`. It is
session-authenticated and workspace-scoped. The risk ladder is derived from the
target, never supplied by the caller: retrieval weights and ranking
tie-breakers are class A, lessons/playbooks/prompt hints are class B, retrieval
bounds/scope taxonomy/consolidation thresholds are class C, and class D
(capability grants, approval rules, evidence schema, evaluation definitions,
safety policy, merge/deploy) is rejected. Class B needs one named human
approval; class C needs two distinct humans (owner and reviewer keys); class A
skips human approval only when the workspace has enabled automatic promotion.

The server — not the caller — runs the offline replay over the stored corpus
against the workspace golden set **and** a hidden holdout the proposer cannot
read. No operation accepts a score, an evaluation case, or holdout content: the
holdout contributes an aggregate sample count only. The recorded verifier is
the authenticated evaluator with a server-derived replay reference, and a
request that carries a verifier claim or metrics is refused. Promotion requires a minimum sample per arm, a
non-negative success delta, a Newcombe confidence interval that does not
establish a regression beyond the fixed margin, zero forbidden-item injection,
and no rework or cost breach. A passing candidate enters a 10% → 50% → 100%
canary whose stages each require their own minimum sample; rollouts are
serialized per workspace and a canary refuses a baseline that moved since
evaluation. A canary observation
is computed server-side from the runs the rollout pinned and their terminal task
outcomes (pending runs excluded); any request body is refused, so an owner
cannot submit a passing sample. Any security event, regression, or breach rolls
it back automatically. The workspace kill switch
takes effect in the same call: active canaries roll back, new runs pin the
baseline policy, and RSI actions are refused. Promotions consume a weekly change
budget, and replay consumes a weekly reflection-token budget.

Every pinned run's canary evidence comes from that run's own `RunSummary`
entry; task-level aggregates are used only for single-run tasks. Every run pins
the exact memory version and policy identity it used at run creation (surfaced
as the Task `memory` block), so a bad promotion is
reproducible after rollback and a canary run's candidate overlay is visible. Memory remains untrusted data, and
`dsh` remains the only tool gate: nothing on this surface can grant a
capability, approve a change, or alter an approval rule.

SSE events contain `event_id`, `sequence`, `occurred_at`, `task_id`,
`task_version`, `type`, and redacted `data`. Types are `task.status_changed`,
`pi.text_delta`, `pi.turn_settled`, `pi.summary.updated`, `plan.updated`,
`approval.required`,
`approval.resolved`, `tool.requested`, `tool.completed`, `tool.denied`,
`validation.completed`, `artifact.available`, `evidence.appended`, and
`task.terminal`. Node replays by `Last-Event-ID` in sequence order.

`tool.denied` data carries the shared error envelope
(`docs/contracts/error-envelope-v1.md`) in `data.error_envelope`, the origin
dsh code in `data.error_code`, and the envelope's safe message in
`data.message` — actionable guidance without secrets or policy internals;
raw failure detail stays behind the separate diagnostics access check.

## Safe Pi text summary

`pi.text_delta` carries raw assistant text and is **never** a display
source: free-form model output can contain credentials, commands, absolute
workspace paths, or unredacted logs, and client-side filtering cannot be
the safety boundary. The product API exposes Pi text only as the fail-closed
`pi_summary` projection, judged on the Node side in
`node/src/api/pi-summary.ts` (DAT-191, classification boundary DAT-192,
trust boundary DAT-193) — deterministic, reviewable, and free of any model
call, network transfer, or widened permission.

**Trust boundary (DAT-193).** Displayability comes from provenance, not
from inspecting text. `status:"available"` may only ever carry text that
production code composed from an auditable trusted source — a source whose
origin and validation are reviewable in this repository, with a trust
chain this contract can state — never text a rule table merely passed.
Free model output has no such provenance: any turn, in any wording, may
carry commands, credentials, absolute paths, or raw logs, and no
deterministic rule table can prove that arbitrary free text contains none.
DAT-191/DAT-192 hardened the table across three QA rounds, and QA still
reproduced raw commands reaching `available` on the merged baseline
(`node app succeeded.`, `The team used poetry lock to pin versions.`).
A settled model turn's free text is therefore never displayable,
whatever the table says: the DAT-192 rule table remains only as the
*classifier* that names why material is kept out, and a pass of that
table is a classification, not a certification. The one displayable
source this version has is the structured Pi report channel described
below.

`GET /api/v1/tasks/{task_id}` (and every other Task response) carries the
`pi_summary` field, and every change is recorded as a `pi.summary.updated`
timeline/SSE event whose `data.summary` is the same object:

```json
{"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","status":"available","text":"Pi reported that it inspected and updated the package manifest and the lockfile and that the change is ready for review.","unavailable_reason":null,"source":{"kind":"turn_report","version":1,"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","report":{"areas":["manifest","lockfile"],"activities":["inspected","updated"],"outcome":"ready_for_review"}},"updated_at":"2026-10-26T12:03:00Z"}
```

Contract semantics:

- **Source and trust chain: the structured Pi report (DAT-193).** `text`,
  when present, is the fixed-wording rendering of one settled Pi turn's
  validated structured report. The model labels the turn's work through
  the `report_turn_summary` tool, whose parameters are closed enums
  (`areas`, `activities`, `outcome`) with no free-text field and no
  argument that could carry a command, token, path, or log; Node
  validates the report against that vocabulary server-side (the
  provider-side schema is descriptive only) and records it only when it
  is valid; Node itself composes every displayed word from fixed phrases
  (`node/src/pi/turn-report.ts`), framed as Pi's own report — "Pi reported that it …" — not as an independently verified fact, and it
  conveys the turn's concrete work (what was done, to which parts, with
  which outcome), never run status or action counts. The tool executes
  nothing: no additional model, external network, widened permission, or
  dsh action is involved. A turn whose report is missing, unknown, or
  invalid fails closed exactly like a turn with no report. Free model
  text has no such source and is never displayable — no rule table can
  prove arbitrary free text safe, and DAT-193 claims no such proof — so a
  free-text-only turn always settles `unavailable`. The rendered report
  text is additionally run through the DAT-192 classifier before
  release (defence in depth; in that direction the classifier can only
  withhold, never allow).
- **Verifiable source: the provenance record (DAT-194).** `source` is
  non-null if and only if `status` is `"available"`, and it states the
  whole trust chain in the payload: `kind` is the closed provenance
  channel (this version defines exactly one, `"turn_report"`, and any
  other kind is not a trusted source); `version` versions the proof
  format and its rendering vocabulary (this version defines `1`; the
  version is read from the record and never inferred from the writer or
  the running service, so an unknown version is unverifiable);
  `task_id`/`run_id`/`turn_id` bind the proof to the exact task, run,
  and turn the summary describes; and `report` echoes the validated
  closed-enum structured report the sentence was fixed-rendered from, so
  a client can corroborate the closed vocabulary and the attribution.
  The gate is server-side: on every read — the Task response, the
  timeline, the SSE replay, and the live stream — Node re-proves an
  `available` summary from its stored source: the report must validate
  against the closed vocabulary, re-render through the fixed wording
  byte-for-byte equal to `text`, still pass the classifier, and be
  attributed to this summary's own task/run/turn at a known `kind` and
  `version`. Anything Node cannot prove — a missing source (every
  DAT-191/192 record), an unknown kind or version, attribution naming a
  different task, run, or turn, a report that does not reproduce the
  stored text, a damaged record, or an unknown status — is served
  `status:"unavailable"` with `unavailable_reason:"untrusted_source"`
  and `text:null`. Nothing about provenance is ever inferred from the
  text's shape, a timestamp, or the service's current version. A client
  MAY check `source` before rendering, but that check is corroboration,
  not the safety boundary: the UI MUST NOT treat client-side validation
  as the trust decision.
- **Classification (DAT-192): why material is kept out.** The ordered
  rules keep out exactly these classes; a hit yields `unavailable` with
  that class's reason. The table only ever adds rejections and never
  creates an allowance — it classifies withheld material, it does not
  certify display:
  - *credential-shaped material* (`secret_material` → `unsafe_content`):
    provider prefixes `sk-`, `sk_live_` /
    `sk_test_`, `ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_`, `github_pat_`,
    `AKIA` / `ASIA`, `xox*`, `glpat-`, `AIza`, `npm_`, `SG.`, `dop_v1_`,
    `SK`+32 hex, PEM private-key blocks, `Bearer …` headers, and
    `authorization` / `api_key` / `password` / … assignments;
  - *shell syntax* (`shell_syntax` → `unsafe_content`): fenced code
    blocks, code spans containing shell metacharacters or a command
    executable, `$ ` prompt lines, pipes, `&` sequences, `;` before a
    command, redirections (`>`, `>>`, `<`), and `$VAR` / `$(…)` references;
  - *absolute local filesystem paths* (`absolute_path` → `unsafe_content`)
    at the roots `Users`, `home`, `root`,
    `tmp`, `var`, `private`, `etc`, `opt`, `mnt`, `media`, `srv`, `proc`,
    `usr`, `bin`, `sbin`, `Library`, `System`, `Applications`, `Volumes`,
    `workspace`, `workdir`, plus Windows drive letters;
  - *command invocations* (`tool_invocation` → `unsafe_content`): any
    occurrence of a command token with no ordinary prose use (`ls`, `cat`,
    `grep`, `sed`, `awk`, `chmod`, `curl`, `docker`, `npm`, … — the
    authoritative list is the exported `PI_SUMMARY_UNAMBIGUOUS_COMMAND_TOKENS`
    table); a polysemous head (`git`, `make`, `node`, `go`, `find`,
    `python`, `echo`, … — `PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS`) followed
    by a known subcommand (`git status`, `git submodule`, `npm ci`,
    `make install`), a file-like argument (`cat package.json`,
    `node server.js`), a quoted argument, a path argument, or a `.` target;
    and a **non-starter word immediately followed by a base command verb**
    (`Poetry install`, `Bazel build`, `vite build`, `Mise install`,
    `git submodule update`) — the base verbs are the exported
    `PI_SUMMARY_COMMAND_VERBS` table; grammatical English only uses bare
    base verbs after auxiliaries, modals, or `to`, all of which are prose
    starters and therefore exempt heads, so this pair shape is an
    invocation rather than narrative;
  - *argument material* (`command_material` → `unsafe_content`): flag-shaped
    tokens (`-la`, `--init`, `-name`) wherever they appear, `./` `../` `~/`
    relative paths, `//target` arguments (`//app:server`), and unspaced
    `NAME=value` assignments;
  - *unredacted log / diagnostic output* (`raw_log` → `unsafe_content`):
    stack frames, log-level lines,
    `fatal:` / `error:` / `warning:` / `critical:` markers, ANSI escapes,
    and log timestamps;
  - *opaque high-entropy strings* (`high_entropy` → `unsafe_content`):
    hex runs of 32+ characters and
    base64-shaped runs of 32+ characters (digests, API keys, auth blobs)
    whose safety cannot be determined from the text;
  - *execution reports* (`execution_report` → `undecidable`): a subject
    reporting that it ran / executed / invoked / … something unspecified —
    the text does not say what was executed, so the turn is not
    certifiable and no guess is made;
  - *unrecognised sentence and line openers* (`prose_starter` →
    `undecidable`): every segment of a certifiable turn — turn start,
    inline sentence end, and **every line start** (single newlines are
    judged; list and quote markers after them are skipped) — must open
    with a reviewed narrative starter (`PI_SUMMARY_PROSE_STARTERS`:
    pronouns, determiners, conjunctions, prepositions, auxiliaries,
    adverbs, result participles; matched case-insensitively, so
    capitalisation is no exemption), or an `-ed`/`-ing`
    participle/gerund form, or a polysemous command head **with an
    in-segment narrative marker**. An opener that is a base form of
    `PI_SUMMARY_COMMAND_VERBS` is an imperative and never certifies, even
    when the sentence carries a narrative marker (`Note the caveat.`,
    `Ensure the lockfile is current.`, `Deploy the new version.`,
    `Update the lockfile after review.`). Any other unrecognised opener
    certifies only when the same segment carries a narrative marker — a
    copula/auxiliary/modal token or a participial `-ed` verb form —
    narrative like `Alpha task verified the export path.` has one, while
    command lines (`Bazel build //app:server`, `Poetry install`,
    `poetry install` on its own line) do not. A polysemous head without
    a marker is likewise undecidable (QA round-2): segment-start
    `node app`, `echo hello`, `python script`, `head notes`,
    `sort files`, `kill 1234`, `date today`, `man pages`, `source env`,
    and `git history` fail closed, while `Node is fast.` and
    `git history is clean.` certify on their copula.

  The complete turn text is judged — never one fragment at a time — so
  material split across `pi.text_delta` fragments is caught in its
  assembled form. The reach of this table over arbitrary free text is
  exactly what DAT-191/192 could not close: an invocation written in
  plain-English words *inside* an otherwise narrative sentence and
  carrying none of the structural material above (for example
  `The team used poetry lock to pin versions.`) passes every class, and a
  marker-rescued segment opener such as `node app succeeded.` passes the
  prose classification. DAT-193 withholds both shapes as
  `untrusted_source` instead of exposing them: the classification table is
  no longer a display decision, and no residual of it is displayable.
- **Fail closed.** Any rule hit yields `status:"unavailable"` with
  `unavailable_reason` set to that rule's reason — `"unsafe_content"` for
  identified unsafe material, `"undecidable"` when the classifier could
  not recognise the turn as narrative prose; a failure inside the
  classifier itself yields `"gate_error"`; a settled turn with no content
  yields `"no_content"`; a turn no rule flags still yields
  `"untrusted_source"`, because its content has no auditable trusted
  source — free model text, a structured report that failed
  server-side validation, or a recorded summary whose source cannot be
  re-proven on read (DAT-194: legacy, missing, forged, or
  unknown-version provenance). The reason enum is additive: clients MUST render an unknown
  reason — and an unknown status — as a plain unavailable state. An
  unavailable summary never carries the raw turn text — in any field,
  event, or projection.
- **Compatibility with recorded history (DAT-193, DAT-194).** Fields,
  event type, lifecycle, and attribution are unchanged, so
  DAT-191/192/193 clients keep working: a settlement is either
  `available` with the report-rendered `text` above or `unavailable`
  with `text:null`, `source` is an additive field, and the reason enum
  only grows. No persisted projection and no recorded timeline event is
  rewritten: summaries settled before DAT-193 and before DAT-194 remain
  exactly as recorded, and no old record is ever re-labelled trusted.
  Provenance is decided on read instead: the `pi_summary` projection and
  every served `pi.summary.updated` payload pass the same source gate,
  so a legacy `available` free-text summary keeps its bytes on disk and
  its event envelope (`event_id`, `sequence`, `occurred_at`) untouched
  while being served as `unavailable`/`"untrusted_source"` with
  `text:null`. A client that predates the `source` field and renders
  only on `status`/`text` is therefore still safe — the server never
  serves text it cannot prove — and a current client additionally
  requires a known `kind`/`version` with matching attribution as
  defence in depth.
- **Lifecycle and attribution.** `pi_summary` is `null` until a Pi session
  exists for the task; `pending` from session start — and again at the
  start of every new run, which resets any earlier run's summary to
  `pending` — then exactly one `available`/`unavailable` per settled turn,
  each replacing the previous summary. `task_id`, `run_id`, and `turn_id`
  bind the summary to the producing task, run, and turn; a summary never
  crosses task or run boundaries.
- **Missing / unavailable semantics.** `text` is non-null if and only if
  `status` is `"available"`; `source` is non-null if and only if
  `status` is `"available"`; `unavailable_reason` is non-null if and only if
  `status` is `"unavailable"`; `text`, `source`, and `unavailable_reason`
  are null while `pending`. An unprovable or unavailable summary carries
  neither text nor source, so a provenance question can never resurrect
  withheld content. Clients render unavailable states from the reason enum
  and must never fall back to displaying the raw `pi.text_delta` stream.
- **SSE and recovery.** `pi.summary.updated` is a durable timeline event: it
  replays by `Last-Event-ID` in sequence order, survives an orchestrator
  restart with its original `event_id`, and the `pi_summary` projection
  field always equals the last published summary event **as served** —
  both pass the same provenance gate, so projection and events agree on
  what is displayable even when a recorded summary cannot prove its
  source. Each settled turn publishes exactly one summary event — the duplicated `agent_error` then
  `agent_settled` emission of a provider failure settles one turn once. Pi
  sessions are not resumed across restarts (see Durability), so a recovered
  task keeps the last settled summary it actually produced, provenance
  included.
- **Terminal without a settled turn.** A terminal task whose last turn never
  settled (cancel or abort winning the race against settlement) keeps
  `status:"pending"` with `text:null`: Node never fabricates a summary after
  the terminal frame. Clients that render on a pending summary of a terminal
  task show no summary, gating on the task status instead.

## Error model: the shared error envelope

Every endpoint's errors use one shared, versioned envelope (aligned with the
ADR-0008 / DAT-226 shared error contract; the actionable agent/human error
contract is `docs/contracts/error-envelope-v1.md`, whose §3 maps this
surface's stable codes into the shared catalog for tool results and task
events). Display text may be localized
without changing machine codes; no field ever carries secrets, credentials,
invitation tokens, or sensitive diagnostics.

```json
{"error":{"envelope_version":1,"code":"TASK_STATE_CONFLICT","stage":"execution","category":"stop","message":"The task cannot be cancelled in its terminal state.","retryable":false,"retry_after_seconds":null,"request_id":"req_...","details":{},"next_action":"refresh"}}
```

- `envelope_version` — envelope format version; additive evolution within 1.
- `code` — stable machine code; never localized, never re-mapped.
- `stage` — where processing rejected the request: `auth`, `validation`,
  `authorization`, `policy`, `execution`, `delivery`, `reconciliation`, or
  `unknown`.
- `category` — outcome semantics: `denial` (refused; do not retry), `stop`
  (fix the request or state), `retry` (a retry may succeed within limits),
  `unknown` (reconcile before further writes). The service, never a model or
  a client, decides retry eligibility; a policy denial is never rewritten as
  a generic server error and no grant is ever widened automatically.
- `message` — safe user-facing guidance; a trace ID alone is never the only
  guidance. An unexpected `INTERNAL_ERROR` serves one fixed safe message; its
  cause stays in server-side logs, correlated by `request_id`.
- `retryable` — the service's retry judgment for this instance.
- `retry_after_seconds` — seconds to wait before a retry; non-null when
  applicable (typically `429` and retryable `503`), matching the
  `Retry-After` header where the server sends one.
- `request_id` — trace/case reference to quote in support and security cases.
- `details` — safe structured context only (e.g. a conflicting version, a
  denied capability category).
- `next_action` — the authorized next action as a machine code:
  `reauthenticate`, `refresh`, `retry`, `resubmit`, `reconcile`,
  `request_review`, `request_new_invitation`, `contact_admin`, or `null`.
  Additive vocabulary: unknown actions render as generic guidance from
  `message`.

Stable codes and their default envelope semantics:

| Code | HTTP | stage | category | retryable | next_action |
|---|---|---|---|---|---|
| `INVALID_REQUEST` | 400 | validation | stop | no | `resubmit` |
| `INVALID_CURSOR` | 400 | validation | stop | no | `resubmit` |
| `UNAUTHENTICATED` | 401 | auth | denial | no | `reauthenticate` |
| `FORBIDDEN` | 403 | authorization | denial | no | `contact_admin` |
| `CSRF_TOKEN_INVALID` | 403 | auth | stop | no | `refresh` |
| `NOT_FOUND` | 404 | validation | stop | no | — |
| `TASK_NOT_FOUND` | 404 | validation | stop | no | — |
| `TASK_STATE_CONFLICT` | 409 | execution | stop | no | `refresh` |
| `IDEMPOTENCY_CONFLICT` | 409 | validation | stop | no | `resubmit` |
| `VERSION_CONFLICT` | 409 | validation | stop | no | `refresh` |
| `WORKSPACE_REPOSITORY_CONFLICT` | 409 | validation | stop | no | — |
| `MEMBERSHIP_CONFLICT` | 409 | validation | stop | no | — |
| `AUTHORITY_RECHECK_REQUIRED` | 409 | reconciliation | stop | no | `reconcile` |
| `DSH_GRANT_EXPIRED` | 410 | policy | stop | no | `request_review` |
| `DSH_RISK_PROHIBITED` | 422 | policy | denial | no | `request_review` |
| `TEAM_LEADER_NOT_MEMBER` | 422 | validation | stop | no | `resubmit` |
| `DSH_APPROVAL_REQUIRED` | 428 | policy | stop | no | `request_review` |
| `RATE_LIMITED` | 429 | execution | retry | yes | `retry` |
| `ROLE_NOT_ASSIGNABLE` | 403 | authorization | denial | no | `contact_admin` |
| `INVITATION_NOT_ACCEPTED` | 403 | authorization | denial | no | `request_new_invitation` |
| `INTERNAL_ERROR` | 500 | unknown | unknown | no | `contact_admin` |
| `PI_UNAVAILABLE` | 503 | execution | stop | no | `contact_admin` |
| `DSH_UNAVAILABLE` | 503 | execution | retry | yes | `retry` |
| `PROVIDER_ROSTER_INCOMPLETE` | 503 | reconciliation | retry | yes | `retry` |

Node maps dsh policy outcomes without exposing dsh internals:
`403 DSH_SCOPE_DENIED|DSH_POLICY_DENIED` (stage `policy`, category `denial`),
`410 DSH_GRANT_EXPIRED`, `422 DSH_RISK_PROHIBITED`, and
`428 DSH_APPROVAL_REQUIRED`. A dsh failure's own message and details can
carry internal diagnostics, so they never cross the API boundary: these
errors serve one fixed safe message each, and `details` carries only the
allowlisted origin code in `dsh_code` (plus the rejected `task_id` on `422`)
— never raw dsh messages, Go error strings, or response fragments.

The implementation MUST generate an OpenAPI document and TypeScript client
from this contract. UI work is blocked until that generated contract is merged
to `main`; fixtures must match it exactly.

## Idempotent task creation

`POST /api/v1/tasks` accepts an optional `Idempotency-Key` header (≤256
characters). Repeating a create with the same key and the same normalized
payload returns the original `201 Task` — same `id`, same `current_run_id` —
instead of minting a second run; concurrent creates with one key join the
same run. The same key with a different payload is `409
IDEMPOTENCY_CONFLICT`. Keys and their task bindings survive a process
restart: replaying a pre-restart create after a restart still returns the
pre-restart task. Requests without the header are never deduplicated.

## Durability and restart recovery

Node persists its task projection — statuses, the ordered event timeline,
artifact metadata, and the idempotency ledger — as one atomically replaced,
schema-versioned, user-private (0600) document. dsh remains the only fact
source for runs and evidence: recovery re-reads run state from dsh and
re-projects; it never fabricates, overwrites, or reorders timeline events.
Consequences a client can rely on:

- After a restart, `GET /tasks/{id}` and `GET /tasks/{id}/timeline` return
  the same events, in the same order, with the same `event_id`s and
  `sequence` numbers as before the restart.
- `GET /tasks/{id}/stream` replays from the durable timeline, so a
  `Last-Event-ID` captured before a restart resumes exactly after that event:
  ordered, gap-free, and without repeating business events. A stream for a
  terminal task always closes after its replay — including when the client's
  `Last-Event-ID` is already anchored at `task.terminal` and the replay has
  nothing left to write.
- A task whose run reached a terminal dsh state while Node was down gains
  exactly one new status transition and one `task.terminal` event at
  recovery; a run dsh no longer knows is projected `stopped` with a reason,
  never left silently running on a phantom association.
- Pi sessions are not resumed across a restart. A task that was mid-run
  keeps its dsh-projected status with a `status_reason` recording that the
  session was not resumed; approvals and cancels remain available.

## Workspace, team, and member administration

Every workspace-scoped path carries `{workspace_id}`, but the identifier is a
locator, never authority: each request's enterprise/workspace scope and role
are resolved server-side from authenticated membership, and a client-supplied
ID is never sufficient (ADR-0006). The task endpoints above resolve their
workspace the same way server-side.

A workspace binds one provider instance and one immutable provider-assigned
`repository_id`, not a mutable URL. Create/archive/restore enforce one active
workspace per repository per enterprise transactionally
(`WORKSPACE_REPOSITORY_CONFLICT`). Renames change metadata only. A transfer
replaces the binding with authority revalidation — it never silently changes
the enterprise or expands credentials — and is blocked with
`AUTHORITY_RECHECK_REQUIRED` while authority is stale or unknown.

Workspace roles are `owner`, `admin`, `member`, `viewer`, assigned only
within the actor's own authority (`ROLE_NOT_ASSIGNABLE` for escalation);
enterprise administration does not automatically grant repository data
access. Members carry `MemberAuthority`: normalized provider-role provenance
(`organization_owner`, `group`, `inherited_role`, `direct_collaborator`, or
`unknown`), `verified_at`, and `stale`. Authority that belongs to an
organization is never invented as a repository "owner" user. Stale or unknown
authority blocks sensitive actions pending reconciliation.

`GET /api/v1/workspaces/{workspace_id}/member-candidates` is the import view:
missing provider permissions or incomplete roster pages are
`PROVIDER_ROSTER_INCOMPLETE` — an error, never an empty member list.

Teams are a routing signal, never an authorization source: team leadership or
membership grants no repository access, security privilege, or delivery
approval. Leaders MUST be active workspace members
(`TEAM_LEADER_NOT_MEMBER`).

## Invitations

Owners create invitations; both the QR value and the grouped copyable code
convey the same opaque bearer token (at least 128 bits of random entropy,
URL-safe, stored only as a keyed digest). Defaults: 24-hour expiry, one
redemption, `member` role only; an owner may only shorten the expiry or bind a
verified provider subject. Administrative role elevation is a separate audited
action after joining.

The create response is the ONLY place the raw token ever appears — never in
any later read, telemetry, referrer, error message, log, analytics export, or
third-party asset. `invite_url` carries the token in the URL fragment
(`…#<token>`), never the query: the landing page never consumes the token on
GET (link previews and security scanners learn nothing), clears the fragment
from browser history after capture, and submits the token only in an
authenticated confirmation POST body. `POST /api/v1/invitations/preview` is
that body's non-consuming sibling — it renders the join-confirmation screen
and runs live eligibility checks without redeeming.

`POST /api/v1/invitations/redeem` is the explicit join confirmation. One
transaction checks expiry, revocation, remaining uses, the intended
enterprise/workspace/subject, the inviter's current authority, existing
membership, and the invitee's current repository access, then adds the
`member` membership and consumes the invitation atomically. Concurrent
redeemers cannot both succeed. The same subject retrying their own redemption
is an idempotent replay of the join. Workspace scope comes from the
invitation itself, never from client input. Login alone or possession of a
leaked code never grants repository access. Redemption, preview, and creation
are rate-limited by actor and request origin
(`RATE_LIMITED`, `retry_after_seconds` set). Audits record creation,
revocation, attempted redemption, results, and effective roles — never the
bearer token.

## Collaboration v1 (DAT-221)

Status: implementation contract whose durable issue/task/run/approval/delivery
serving code is still landing; the immutable-candidate freeze and review-card
reads below are implemented in the collaboration domain (DAT-219). It defines
the durable issue/task/run/candidate/approval/delivery resources and their
event stream of ADR-0007 so dependent web work is built against a merged
contract; it claims no running control until the implementation lands, and dsh
remains the execution gate.

Product stages and harness run states are separate vocabularies. An issue's
`product_state` is the product lifecycle (`triage`, `planning`, `implementing`,
`validating`, `awaiting_change_approval`, `delivering`, `pr_review`,
`completed`, `needs_human`, `cancelled`); a run's `state` is the observed dsh /
FP-01 harness state. `awaiting_change_approval` means an immutable candidate
awaits a candidate-bound human change approval and no PR exists; harness
`awaiting_review` exists only once a provider PR exists. A published PR is not
completion — only a provider-confirmed merge is.

Mutating operations accept an optional `Idempotency-Key` header: a repeated
request with the same key and payload returns the recorded result, the same key
with a different payload is `409 IDEMPOTENCY_CONFLICT`, and safe retries reuse
the key. A candidate/approval/delivery record is never client-authored and
never client-mutated; an approval decision carries the reviewed `diff_digest`
and the approver is the authenticated caller, so an agent can never approve its
own work. No branch push or PR exists before a current candidate-bound human
approval, and only the trusted delivery broker performs provider writes — no
direct main write, merge, self-review, or check waiver.

| Request | Request body | Response |
|---|---|---|
| `GET /api/v1/workspaces/{workspace_id}/issues?cursor=&product_state=` | none | `200 {items: Issue[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/issues` | `repository_id`, `base_ref`, `summary`, `source_reference?`; optional `Idempotency-Key` | `201 Issue` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}` | none | `200 Issue` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stage` | none | `200 IssueStage` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stage` | `{to, reason?, disposition?}` | `200 IssueStage` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks?cursor=` | none | `200 {items: IssueTask[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks` | `{role, assignee_agent_id?, depends_on?}` | `201 IssueTask` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks/{task_id}` | none | `200 IssueTask` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks/{task_id}/state` | `{to}` | `200 IssueTask` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs?cursor=` | none | `200 {items: IssueRun[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs` | `{task_id?, role, scope, limits}` | `201 IssueRun` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs/{run_id}` | none | `200 IssueRun` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/candidates?cursor=` | none | `200 {items: Candidate[], next_cursor}` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/candidates/{candidate_id}` | none | `200 Candidate` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals?cursor=` | none | `200 {items: Approval[], next_cursor}` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals/{approval_id}` | none | `200 Approval` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals/{approval_id}/decision` | `{decision, diff_digest, note?}` | `200 Approval` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries?cursor=` | none | `200 {items: Delivery[], next_cursor}` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries` | `{approval_id}` | `202 Delivery` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}` | none | `200 Delivery` |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}/reconcile` | optional `note` | `202 Delivery` |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |

### Candidate freeze and review card (DAT-219)

A candidate is frozen by the service when local preparation stops; it is never
client-authored or client-mutated. The record binds the exact base, candidate
commit, and tree identity, the sha256 diff digest and changed paths, the
validation configuration/environment and every validation attempt, the risk
decision, and patch/report provenance references. The diff content is retained
in a content-addressed store outside the ephemeral worktree, so the card and its
evidence stay reviewable after cleanup; `diff.digest` is the sha256 of that
retained content and can be recomputed independently instead of trusted. The
containment check resolves symlinks, so a retention root that only appears to be
outside the worktree is refused.

Validation evidence is passing evidence, and the required checks are **policy**,
not execution output. A configuration administrator registers a versioned test
policy scoped to one workspace and repository: required checks, `config_digest`
(`sha256:<64 hex>`), and environment, recorded with `registered_by`. Each
repository has exactly one current version; registering a new version moves that
pointer, and older versions stay registered for audit and replay. A worker lease
never defines or edits policy.

Before validation executes, the run binds exactly one immutable plan to the
repository's **current** policy version. The plan command accepts only the run
and the policy id — checks, config digest, and environment are frozen from the
registered policy and can never be supplied per command. A plan for a stopped
or terminal run, a second plan for the same run, a policy from another
workspace/repository, or a superseded policy version is refused.

`validation.required_checks` must equal the bound policy's checks, its
`config_digest`/`environment` must match, and every result must name a policy
check with exit status `0`. A failed attempt, an attempt with no exit status or
output digest, an unplanned check, or a missing required check stops the run
instead of producing a review card. The card exposes `policy_id`,
`policy_version`, and `policy_digest`, so an approval (DAT-220) binds to one
exact policy version even after a newer one becomes current; a policy update
does not retroactively invalidate an already frozen candidate.

Every validation `event_reference` must be a retained `test_report` artifact of
the same run produced from the frozen base and head whose digest equals the
attempt's `output_digest` (algorithm `sha256`, hex value), so a "passing" result
cannot point at a patch/report of another purpose, at a plan or grant record, at
another revision, or at a digest the execution artifact does not have.
`audit_refs` entries resolve to retained artifacts, grants, or the approved
plan of the same run (`evidence://runs/{run_id}/...`); artifact references must
bind the frozen revision, and a fabricated path never freezes a candidate.

`Candidate` carries optional `invalidated_at`/`invalidated_reason`. When the
issue base advances, every candidate frozen against an older base is
permanently invalid (`base_advanced`) and can never be approved or delivered:
refreshing a base requires a new run, new validation, and a new candidate. A
frozen candidate has no branch or PR — no provider write exists before a
current, candidate-bound human approval.

`GET .../candidates` serves stable pages: `next_cursor` is the last served
candidate id and an unknown cursor is `400 INVALID_CURSOR`, so a client never
silently restarts or skips the list.

The reviewer notification carries bounded metadata (summary, changed-path
count, line counts, test totals, risk class) and an authenticated client link
to the card. It never contains diff text, changed path names, tool output,
digests, or a bearer/approval credential; the link selects a candidate and
approval remains a confirmed authenticated mutation in the client.

### Issue events and replay

Issue events contain `event_id`, `sequence`, `occurred_at`, `issue_id`, `type`,
and projected `data`. Types are `issue.created`, `issue.stage_changed`,
`issue.terminal`, `task.created`, `task.state_changed`, `run.opened`,
`run.state_changed`, `run.grant_recorded`, `run.grant_revoked`,
`run.artifact_attached`, `candidate.frozen`, `approval.requested`,
`approval.decided`, `approval.invalidated`, `delivery.requested`,
`delivery.state_changed`, `delivery.reconciled`, and `operation.denied`.

`event_id` is stable and idempotent across replays: a replayed or redelivered
event keeps the same id and payload, a new event never reuses an id, and a
consumer MUST deduplicate on `event_id`. `sequence` is monotonic and gap-free
per issue and is the ordering cursor. On reconnect the client sends the last
delivered `event_id` in `Last-Event-ID`; Node replays every later event in
`sequence` order from the durable projection — including events written while
disconnected and across orchestrator restarts — so no business event is
duplicated or lost. An unknown id replays from the start of the retained log.
The stream closes after `issue.terminal`, including when the anchor is already
terminal.

### Outcome semantics

Every failure uses the shared versioned envelope
(`docs/contracts/error-envelope-v1.md`). The collaboration surface fixes three
outcome classes and their retryability:

- `stop` — a `stopped` run or a `needs_human` issue stop. Not retryable with
  the same intent; continuation requires human disposition and a fresh
  run/grant (`stopped -> running` does not exist). `DISPOSITION_REQUIRED`
  (428) is the needs-human stop (`stage: policy`, `next_action:
  request_review`); `TRANSITION_FORBIDDEN`, `PRODUCT_HARNESS_CONFLICT`,
  `TASK_BLOCKED`, and `APPROVAL_NOT_APPROVED` are ordinary stops.
- `unknown` — an ambiguous provider/delivery outcome
  (`DELIVERY_OUTCOME_UNKNOWN`): never auto-retried, `retryable: false`,
  `next_action: reconcile`; reconcile against branch/provider evidence before
  any further write, and a safe retry reconciles the same operation instead of
  creating a duplicate PR.
- `retry` — only service-decided bounded retries are retryable, with
  `retryable: true` and `retry_after_seconds` on the envelope; a denial is
  never rewritten as a retryable server error.

`partial` delivery (a pushed branch without a PR) is an explicit recorded
outcome, never success and never automatically deleted.

## Pagination

List endpoints paginate with an opaque cursor: request `?cursor=`, response
`{items, next_cursor}` with `next_cursor: null` at the end. Cursors are
server-defined; clients MUST NOT construct, parse, or interpret them, and an
unknown cursor is `400 INVALID_CURSOR`. Order is documented per endpoint
(tasks and invitations: creation time, newest first; workspaces: creation
time; members and teams: stable server order).

## Non-enumeration

`401`, `403`, and `404` never let a caller enumerate resources or account
state they cannot see:

- `401 UNAUTHENTICATED` is byte-identical for every authentication failure:
  missing, malformed, expired, or invalidated credential, suspended account,
  and invalid desktop ticket. Suspension is never visible through a generic
  401; it is surfaced only after provider-authenticated sign-in and to
  enterprise administrators.
- `404 NOT_FOUND` is byte-identical whether the entity does not exist, belongs
  to another enterprise or workspace, or the caller's membership was revoked.
  The server MAY record the true cause in audit logs; the response never
  carries it.
- `403` appears only when the requested entity is visible to the caller but
  the action exceeds their authority (`FORBIDDEN`, `ROLE_NOT_ASSIGNABLE`,
  `CSRF_TOKEN_INVALID`).
- Invitation preview and redemption collapse every non-consumable state —
  unknown, expired, revoked, already consumed, wrong-subject for a bound
  invitation, ineligible or already-member invitee — into the single
  `403 INVITATION_NOT_ACCEPTED`. The caller cannot learn which condition
  failed. The one exception is the caller's own idempotent replay, which
  succeeds.
- `429 RATE_LIMITED` is intentionally distinguishable so clients back off.

## Session invalidation and streams

Logout, suspension, membership revocation, and session expiry invalidate
authorization and subscriptions (ADR-0006). On invalidation the server
terminates every SSE subscription bound to the invalidated credential at
invalidation time — not at the next event — and each affected stream closes.
Every later request with that credential fails with the uniform
`401 UNAUTHENTICATED`; a member whose membership was revoked sees the
workspace's resources, streams, artifacts, approvals, and writes as
`404 NOT_FOUND` from the same request path onward. Reconnects follow
Non-enumeration: the stream resumes only under a still-valid credential, and
`Last-Event-ID` replay then continues in sequence order from the durable
projection. Capability grants derived from the revoked membership are
revoked; execution that depends on the lost authority is stopped.
