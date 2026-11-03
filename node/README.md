# ForgePilot orchestrator (Node + Pi)

TypeScript service that replaces the prototype's deterministic planner with a
Pi Agent SDK session and exposes the minimal `forgepilot-api/v1` product API.
See [ADR-0003](../docs/adr/0003-pi-orchestration-and-dsh-control-contract.md)
for the authority model and
[forgepilot-api-v1](../docs/contracts/forgepilot-api-v1.md) /
[dsh-control-v1](../docs/contracts/dsh-control-v1.md) for the two contracts.

## Authority boundary

- **dsh is the fact source** for risk, capability grants, execution, and
  evidence. This service never classifies risk, never grants capabilities, and
  never executes tools.
- **Pi holds exactly one tool**, `dsh_request_action`, which forwards a
  structured action intent to dsh over the local control plane. Pi's default
  terminal and file-edit tools are not loaded; the agent loop runs with only
  the registered tool, and dsh re-checks every intent against the run's
  allow-list and capability grant before anything executes.
- **The UI calls only this service**, at an ephemeral loopback address. It
  never sees dsh sockets, boot tokens, Pi credentials, or provider
  credentials.

A denied intent is returned to the model as an error result and recorded on
the task timeline (`tool.denied`); the authoritative run state is re-read from
dsh, so refusals, stop conditions, timeouts, and expiries surface in Node task
status instead of being invented locally.

## Development

```sh
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest: unit + integration against the real Go dsh
```

The integration tests build the Go `autofixer` binary and start a private
`dsh serve` on a temporary UDS, so the Go toolchain must be on `PATH`. Only
the model stream is scripted (behind the real model gateway's policy,
credential, and identity checks); the Pi agent loop, tool validation, dsh
control plane, allow-list, grants, sandbox execution, stop conditions, and
timeouts are the real implementations.

Known polyglot quirk: after `npm install`, `go test ./...` from the repository
root also scans `node/node_modules` (it compiles; no test files). On a clean
checkout without `npm install` the Go suite is unaffected.

## Running

```sh
export FORGEPILOT_BASE_SHA=<pinned base commit>
npm run build && npm start
```

Configuration (environment):

| Variable                                                                    | Default                                         | Meaning                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGEPILOT_DSH_SOCKET`                                                     | `$TMPDIR/dsh-<uid>/dsh-control.sock`            | dsh control socket (or pipe name)                                                                                                                                      |
| `FORGEPILOT_DSH_TOKEN_FILE`                                                 | `<socket>.token`                                | dsh boot-token file                                                                                                                                                    |
| `FORGEPILOT_API_HOST` / `FORGEPILOT_API_PORT`                               | `127.0.0.1` / `0`                               | loopback bind                                                                                                                                                          |
| `FORGEPILOT_REPOSITORY_ID`                                                  | `github:Luthiel/AutoFixer`                      | only the pilot repository is accepted                                                                                                                                  |
| `FORGEPILOT_BASE_REF` / `FORGEPILOT_BASE_SHA`                               | `main` / required                               | pinned base revision                                                                                                                                                   |
| `FORGEPILOT_ACTOR_ID` / `FORGEPILOT_ACTOR_DISPLAY_NAME`                     | local operator                                  | identity recorded on runs                                                                                                                                              |
| `FORGEPILOT_APPROVER_IDENTITY`                                              | `github:local-operator`                         | must match a dsh `--approver`                                                                                                                                          |
| `FORGEPILOT_PATH_HINTS`                                                     | `node`                                          | comma-separated granted path roots                                                                                                                                     |
| `FORGEPILOT_TOOL_CAPABILITIES`                                              | `echo,sleep`                                    | dsh tools tasks may request                                                                                                                                            |
| `FORGEPILOT_MAX_WALL_CLOCK_SECONDS`                                         | `120`                                           | per-run wall clock                                                                                                                                                     |
| `FORGEPILOT_API_TOKEN_FILE`                                                 | `$TMPDIR/forgepilot-<uid>/api-token`            | per-process API bearer-token file (0600)                                                                                                                               |
| `FORGEPILOT_TASK_STATE_FILE`                                                | `$TMPDIR/forgepilot-<uid>/task-state.json`      | durable task projection (0600); restart re-associates tasks with dsh runs                                                                                              |
| `FORGEPILOT_PI_PROVIDER` / `FORGEPILOT_PI_MODEL`                            | unset                                           | Pi provider/model; unset means approvals report `PI_UNAVAILABLE`                                                                                                       |
| `FORGEPILOT_PI_BASE_URL`                                                    | unset                                           | requested model endpoint; must match a registered gateway endpoint                                                                                                     |
| `FORGEPILOT_ENTERPRISE_ID` / `FORGEPILOT_WORKSPACE_ID`                      | `ent_forgepilot_local` / `ws_autofixer`         | the task surface's workspace only (session gating, DAT-203 authority boundary); model-egress scope follows authenticated membership (DAT-242) — see the migration note |
| `FORGEPILOT_GATEWAY_POLICY_FILE`                                            | unset                                           | scoped model gateway policy set JSON — one policy per enterprise/workspace pair (endpoint allow-list, retry, fallbacks); see the policy shape below                    |
| `FORGEPILOT_GATEWAY_CREDENTIALS_FILE`                                       | unset                                           | provider credentials JSON (0600), `credentialRef -> secret`                                                                                                            |
| `FORGEPILOT_GATEWAY_AUDIT_FILE`                                             | `$TMPDIR/forgepilot-<uid>/gateway-audit.jsonl`  | durable gateway attempt records (audit/metering seam)                                                                                                                  |
| `FORGEPILOT_OAUTH_CLIENTS_FILE`                                             | unset                                           | OAuth app credentials JSON (0600), `provider origin -> {client_id, client_secret}`; setting it enables `/api/v1/auth` + `/api/v1/admin`                                |
| `FORGEPILOT_CONTROL_PLANE_DB`                                               | `$TMPDIR/forgepilot-<uid>/control-plane.sqlite` | durable identity/session database (settable only together with the clients file)                                                                                       |
| `FORGEPILOT_BOOTSTRAP_TOKEN`                                                | unset (required with the clients file)          | deployment-owned secret for first-admin bootstrap and first provider approval (min 32 chars)                                                                           |
| `FORGEPILOT_PUBLIC_ORIGIN`                                                  | unset (loopback per request)                    | external origin for OAuth redirects and desktop login links                                                                                                            |
| `FORGEPILOT_SESSION_TTL_SECONDS`                                            | `43200`                                         | server-side session lifetime                                                                                                                                           |
| `FORGEPILOT_OAUTH_FLOW_TTL_SECONDS` / `FORGEPILOT_DESKTOP_FLOW_TTL_SECONDS` | `600` / `600`                                   | authorization-flow / desktop-binding lifetimes                                                                                                                         |

## Model gateway (ADR-0005)

Every Pi model call goes through `node/src/gateway/`, the single fail-closed
egress path:

- The requested model is matched against the policy's explicitly registered
  endpoints; unknown models, unapproved endpoints, unregistered internal
  endpoints, and missing credentials are all denied with the stable redacted
  `MODEL_EGRESS_DENIED` error. The SDK default endpoint is unreachable because
  the gateway pins the registered `baseUrl` on every dispatch.
- Pi and the execution environment never hold provider credentials and have no
  credential or endpoint seam to bypass the gateway. Provider credential
  environment variables (for example `ANTHROPIC_API_KEY`) are refused at
  startup: configure the gateway credentials file and unset them. This is the
  deployment-layer block on env-based bypasses.
- Missing or partial gateway configuration fails closed — every dispatch is
  denied. Policy and credentials come only from the protected gateway files
  (`FORGEPILOT_GATEWAY_POLICY_FILE`, `FORGEPILOT_GATEWAY_CREDENTIALS_FILE`,
  owner-only 0600).
- Each dispatch attempt carries the enterprise/workspace/issue/run/invocation/
  trace identity into the gateway audit/metering event stream; the required
  pre-dispatch record must be durably written or the dispatch is blocked.
  Retries, fallbacks, and model switches are separate, fully re-checked
  invocations.

Scope and multi-tenancy (DAT-242): gateway policy resolution and every run's
binding identity follow the authoritative authenticated scope.
`resolveRequestScope` (`node/src/control-plane/request-scope.ts`, DAT-241)
resolves the caller's enterprise/workspace from live membership state at run
bind time and again on every dispatch and attempt — never from deployment
configuration and never from caller-supplied IDs. A binding's scope claim is
only ever compared against that resolution: a claim that disagrees is a
cross-tenant binding and is denied before any policy, credential, or provider
is touched. Missing, revoked, ambiguous, or cross-tenant memberships — and
requests with no authenticated scope at all — deny `MODEL_EGRESS_DENIED`
(fail closed: no default scope, no static single-scope path). Audit/metering
events are attributed to the authenticated scope. Policies are served per
enterprise/workspace pair: workspace A's identity can only resolve and
execute workspace A's policy and credential references.

Policy file shape (credentials are referenced, never inlined; one policy per
enterprise/workspace pair):

```json
{
  "policies": [
    {
      "scope": {
        "enterpriseId": "ent_forgepilot",
        "workspaceId": "ws_autofixer"
      },
      "revision": "2026-11-04.1",
      "endpoints": [
        {
          "endpointId": "ep_xiaomi_main",
          "provider": "xiaomi",
          "api": "anthropic-messages",
          "baseUrl": "https://api.xiaomimimo.com/anthropic",
          "internal": false,
          "credentialRef": "cred_xiaomi",
          "models": ["mimo-v2.5"]
        }
      ],
      "retry": { "maxAttempts": 2 },
      "fallbacks": []
    }
  ]
}
```

Deployment configuration migration (DAT-242):

- `FORGEPILOT_GATEWAY_POLICY_FILE` now carries the scoped policy set above:
  wrap the previous single-policy document in a `policies` entry and give it
  the `scope` it governs. A policy entry without a `scope`, a `policies` list
  without entries, or two entries for the same scope all fail startup; there
  is no legacy single-policy shape and no default scope.
- `FORGEPILOT_ENTERPRISE_ID` / `FORGEPILOT_WORKSPACE_ID` no longer govern
  model egress in any path (policy resolution, binding identity, or audit
  attribution). They remain only as the task surface's workspace selection
  (session access gating and the DAT-203 provider-authority boundary) until
  DAT-206/207 move the task surface onto request-scoped workspace contexts.
- Runs started without an authenticated workspace membership — e.g. through
  the legacy local-operator bearer — materialize but dispatch no model bytes:
  every dispatch is denied `MODEL_EGRESS_DENIED` (scope `SCOPE_UNAVAILABLE`).
  Model egress requires session-authenticated requests with a live workspace
  membership.

The `openai-compatible` provider uses `openai-completions` against the
registered base URL and accepts any model ID approved for that endpoint.

## Durability and restart recovery (M3)

The orchestrator persists its task projection — statuses, the ordered event
timeline, artifact metadata, and the create-idempotency ledger — to
`FORGEPILOT_TASK_STATE_FILE` as one atomically replaced, schema-versioned,
user-private (0600) JSON document. dsh remains the only fact source for runs
and evidence: on startup the service re-reads run state from dsh and
re-projects, without fabricating, overwriting, or reordering timeline events.
After a restart:

- tasks, timelines, and SSE `Last-Event-ID` replay resume exactly where they
  stopped — same `event_id`s, same `sequence` numbers, no duplicated business
  events; a terminal task's stream always closes after its replay, including
  when the client's `Last-Event-ID` is already anchored at `task.terminal`;
- a run that terminated while Node was down gains exactly one status
  transition and one `task.terminal` event; a run dsh no longer knows is
  projected `stopped` with a reason;
- Pi sessions are not resumed: a mid-run task keeps its dsh-projected status
  with a `status_reason` recording that the session was not resumed, and
  stays cancellable through the product API.

`POST /api/v1/tasks` additionally accepts an optional `Idempotency-Key`
header (≤256 chars, enforced with `400 INVALID_REQUEST` when longer): same
key + same payload replays the original task (including across restarts), the
same key with a different payload is `409 IDEMPOTENCY_CONFLICT`, and
concurrent same-key creates join one run.

**Single instance per state file.** The projection has no cross-process lock:
two orchestrators pointed at the same `FORGEPILOT_TASK_STATE_FILE` replace
whole documents and would silently drop each other's tasks. Run one
orchestrator per state file (the per-uid default assumes exactly that). The
parent directory is created `0700`, but like the api-token directory pattern
the mode only applies when Node creates it — on a shared `/tmp` another user
could pre-create `$TMPDIR/forgepilot-<uid>/`; prefer an absolute private
path under your home directory when that matters.

## Authentication and origin guards

Every `/api/v1` request must present the per-process bearer token:

```sh
curl -H "Authorization: Bearer $(cat $TMPDIR/forgepilot-<uid>/api-token)" ...
```

Possessing that token — not a statically configured identity string — is what
authorizes a caller to act as the local operator, approvals included. The
token is minted fresh at every start, written 0600 to a user-private file
(the same pattern dsh uses for its boot token), and read out of band by the
operator or UI. A random local process cannot impersonate the operator without
reading that file. Additionally:

- `FORGEPILOT_API_HOST` must be a loopback address (`127.0.0.1`, `localhost`,
  `::1`); the config refuses a non-loopback bind.
- Browser-originated calls are pinned to this server's own loopback `Origin`,
  and request bodies must be `application/json`, so a cross-site page cannot
  ride a simple `text/plain` request.

Session-authenticated callers resolve their enterprise/workspace/role scope
through the server-authoritative helper `resolveRequestScope`
(`node/src/control-plane/request-scope.ts`, DAT-241). The scope is derived
from the caller's live membership on every call — never from
client-provided enterprise/workspace IDs — and missing, revoked, ambiguous,
or cross-tenant memberships fail closed with stable 401/403 codes. Request
paths that need a scope (gateway, orchestrator, later projects) must use
this helper instead of re-deriving scope from request input.

## Declared work and risk

Node never classifies risk. The `forgepilot-api/v1` create body carries no
authenticated, structured risk facts (only free-text summary and criteria
strings, which are attacker-influencable), so Node declares **no** positive
low-risk signal. dsh's `AssessRisk` then fails every task closed to
`elevated`, and each one requires the pre-grant human approval
(`POST /api/v1/tasks/{id}/approvals` with the `scope_digest` from the
`approval.required` event). A low-risk fast path may return only when the API
contract grows explicit, authenticated risk declarations that dsh can bind to
the grant — never inferred from free text or criteria presence.

## API contract

`web/src/api/contracts/` is generated from this implementation:

```sh
npm run export:openapi
```

- `openapi.json` — the OpenAPI 3.1 document.
- `schema.d.ts` — the generated TypeScript client types (openapi-typescript).

Two tests guard the baseline: a drift test fails when the committed files and
a fresh generation disagree, and an independent conformance test parses the
normative [forgepilot-api-v1](../docs/contracts/forgepilot-api-v1.md)
markdown itself — endpoints, the 13 SSE event types, and the UI status enum —
so the implementation and its own export cannot drift away from the contract
together.
