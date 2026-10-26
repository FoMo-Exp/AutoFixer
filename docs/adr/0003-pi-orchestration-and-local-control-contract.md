# ADR 0003: Pi Orchestration and Local Control Contract

**Status:** Accepted

**Date:** 2026-10-26

## Context

The local Go prototype proves the remediation kernel but its deterministic planner and
CLI are not a product orchestration surface. ForgePilot needs a conversational
TypeScript/Node layer and an Electron client without creating a second policy,
execution, audit, provider-credential, or merge path. The durable decision is to
put Pi Agent SDK in Node for bounded orchestration while retaining Go `dsh` as the
only authority for risk, grants, sandbox dispatch, immutable evidence, and protected
delivery.

## Decision

### Ownership and authority

| Component | Owns | May do | Must not do |
| --- | --- | --- | --- |
| Go `dsh` | Task/run state machine, risk conclusion, capability grants, structured-tool registry, sandbox dispatch, audit/evidence chain, protected branch/PR adapter and merge eligibility evaluation | Decide and record whether an already-registered action is allowed; issue terminal evidence | Trust a caller's risk/grant claim; run raw shell or unregistered argv; expose provider credentials; merge or enqueue a PR |
| Node/TypeScript | Pi session lifecycle, task-facing API, local control client, UI-safe task projection and event fan-out | Translate a Pi controlled-tool intent to one `dsh-control/v1` request; persist a derived projection | Evaluate risk/grants, execute host commands, alter dsh evidence, access provider tokens, or decide merge eligibility |
| Pi Agent SDK | Natural-language planning, explanation, and invocation of the one controlled tool | Emit text and typed `dsh_request_action` intents | Receive terminal/file-edit/network/provider tools, direct dsh credentials, shell access, or an approval/merge tool |
| Electron/React | Local user interaction and rendering of Node's public API | Submit tasks, display redacted state/evidence, request cancellation, and show approval state | Connect to dsh, issue grants, reveal tokens/raw commands/absolute paths, or merge PRs |

`dsh` is the source of truth. Node records only `dsh_event_id`, sequence, digest,
and redacted display fields; it cannot create, reorder, or repair a dsh event. A
Node restart must re-query dsh and rebuild its projection. All authorization is the
intersection of the dsh grant and structured-tool registration; absence of either is
denial.

### Local `dsh-control/v1` transport and authentication

`dsh-control/v1` is a local RPC-over-HTTP-message contract, not a network service.
Unix uses one owner-only UDS path in a run-owned directory; Windows uses an ACLed
Named Pipe. dsh MUST reject TCP, HTTP listener, inherited proxy, remote socket, and
non-local transport configuration. The endpoint path is not accepted from UI input.

At boot, dsh creates a cryptographically random single-instance `boot_token`, passes
it to its directly spawned Node child through a one-time private launch channel, and
retains only a keyed verifier. Every request supplies `X-Dsh-Boot-Token`; dsh compares
it in constant time. The token is never placed in a URL, log, event, Node database,
browser process, Pi prompt/tool result, or UI API. Socket/pipe ACLs and the token are
both required. Restart, explicit rotation, ownership failure, cancellation, expiry,
or audit failure invalidates the token and outstanding control requests.

All JSON bodies carry `version: "v1"`; unknown required fields, an incompatible major
version, or unknown enum values are rejected. IDs are opaque. Timestamps are UTC RFC
3339. Responses include `request_id`; dsh audit events additionally include their
monotonic `sequence`, `event_digest`, and `scope_digest` where applicable.

### `dsh-control/v1` endpoints

The following endpoint set is exhaustive for Node. `Idempotency-Key` is required on
every `POST` except `cancel`, where `run_id` plus the requested terminal intent is the
idempotency key. For a repeated key with byte-equivalent request scope, dsh returns
the original response and performs no second transition or dispatch. A key reused
with different method/path/body returns `idempotency_conflict`.

| Endpoint | Request | Success response | Errors | Idempotency |
| --- | --- | --- | --- | --- |
| `GET /dsh-control/v1/health` | token only | `service_version`, `protocol_version`, `boot_epoch` | `unauthenticated`, `transport_denied` | Read-only |
| `POST /dsh-control/v1/runs` | `task_id`, immutable `repository_url`, `base_sha`, bounded `requested_work`, `requester`, `risk_input_ref` | `run_id`, `state`, `risk_assessment`, `scope_digest` (only if approved), `event_ref` | `invalid_request`, `risk_prohibited`, `approval_required`, `repository_mismatch`, `policy_denied` | Creates at most one run for the key; retry returns it |
| `POST /dsh-control/v1/runs/{run_id}/approvals` | verified human `approval_ref`, `actor_identity`, `approved_head_sha`, `approval_kind` (`elevated_grant` or `merge_quorum_observation`) | current `approval_snapshot`, `state`, `event_ref` | `invalid_approval`, `approval_not_authorized`, `head_mismatch`, `state_conflict` | One observation per key; duplicate returns the original observation |
| `POST /dsh-control/v1/runs/{run_id}/actions` | `action_id`, registered `tool_name`, schema-valid `arguments`, `expected_scope_digest`, `expected_state` | `action_id`, `decision` (`accepted`, `denied`, `stopped`), `state`, `event_ref`, and redacted `result_ref` when available | `unknown_tool`, `invalid_arguments`, `grant_denied`, `scope_changed`, `state_conflict`, `timeout`, `cancelled`, `audit_failed` | At most one dispatch; retries return the recorded decision/result |
| `POST /dsh-control/v1/runs/{run_id}/cancel` | `reason_code`, optional redacted reason | `state`, `event_ref`, `already_terminal` | `not_found`, `state_conflict` | Repeating cancellation never adds an event after the first terminal transition |
| `GET /dsh-control/v1/runs/{run_id}` | token only | authoritative run summary: state, risk, grant status, scope/head digests, terminal refs | `not_found`, `unauthenticated` | Read-only |
| `GET /dsh-control/v1/runs/{run_id}/events?after_sequence=&limit=` | cursor and bounded limit | ordered, redacted authoritative events with `next_after_sequence` | `invalid_cursor`, `not_found` | Read-only; events are never rewritten |
| `GET /dsh-control/v1/runs/{run_id}/evidence` | token only | evidence-bundle manifest with digests and authorized opaque retrieval refs | `not_found`, `evidence_unavailable`, `access_denied` | Read-only; raw secret output is never returned |

`POST /runs` does not allow Node to provide a risk class, grant, permitted command,
or provider token. `POST /actions` accepts only schemas registered in dsh; a schema
MUST express the operation declaratively and MUST NOT contain `command`, `shell`,
arbitrary `argv`, raw file content, or provider credentials. dsh itself recomputes
the scope digest from the active grant, registry/policy versions, repository/base
SHA, permitted paths/network, and current head where one exists. It rejects a stale
`expected_scope_digest` before dispatch.

The canonical control error envelope is:

```json
{
  "version": "v1",
  "request_id": "opaque",
  "error": {
    "code": "grant_denied",
    "message": "Action is outside the active capability grant.",
    "retryable": false,
    "event_ref": "evidence://events/run/17"
  }
}
```

No error message includes a token, raw command, path outside permitted display scope,
or raw sandbox/provider output. `unauthenticated`, `transport_denied`,
`invalid_request`, `not_found`, `state_conflict`, `idempotency_conflict`,
`policy_denied`, `grant_denied`, `approval_required`, `head_mismatch`,
`scope_changed`, `unknown_tool`, `invalid_arguments`, `cancelled`, `timeout`, and
`audit_failed` are the v1 stable codes. `audit_failed` and an unbound/malformed
evidence record are control failures: dsh stops the run and revokes its grant.

### Node public `forgepilot-api/v1` contract

Node exposes REST plus SSE only on localhost, using an Electron-main-process mediated
origin/CSRF policy; it MUST NOT bind a non-loopback interface. It publishes an
OpenAPI 3.1 document at `GET /forgepilot-api/v1/openapi.json`, generated from the
same schemas used by the server. The document and all endpoint paths are versioned by
the URL major version. A v1-compatible minor addition is optional and ignored by old
clients; removing/renaming a field or changing semantics requires `/v2` and a
parallel transition period.

| Public resource | Methods and semantics |
| --- | --- |
| `/forgepilot-api/v1/tasks` | `POST` creates a bounded task request; response is a redacted task projection containing `task_id`, `run_id` when available, state, risk/approval status, and links. Node forwards the task to dsh; it never accepts client-supplied grant/risk/tool data. |
| `/forgepilot-api/v1/tasks/{task_id}` | `GET` returns the latest redacted projection, current dsh state, base/head SHA, scope-digest status, and a stale marker when dsh is unavailable. |
| `/forgepilot-api/v1/tasks/{task_id}/cancel` | `POST` requests cancellation; success reflects the dsh terminal/ongoing state. It is safe to retry. |
| `/forgepilot-api/v1/tasks/{task_id}/approvals` | `GET` returns only approval/quorum status and head binding; `POST` submits a human-authenticated approval reference to Node for dsh validation. The UI cannot self-assert an identity or a passing approval. |
| `/forgepilot-api/v1/tasks/{task_id}/events` | `GET` is SSE. It accepts `Last-Event-ID`, emits increasing dsh sequence IDs, replays from the next sequence, and finishes with `reset_required` when the cursor is outside retention. Duplicates may be retransmitted; consumers deduplicate by `id`. |
| `/forgepilot-api/v1/tasks/{task_id}/evidence` and `/evidence/{artifact_id}` | `GET` returns the redacted manifest and authorized display-safe artifact stream. It never exposes raw logs, boot tokens, provider tokens, or host paths. |

SSE event names are `task_state`, `pi_text`, `action_requested`, `action_decided`,
`evidence_available`, `approval_changed`, `head_changed`, `control_unavailable`, and
`reset_required`. Each includes `id` (dsh sequence or a Node-only monotonic display
sequence), `task_id`, `run_id`, UTC `occurred_at`, `redaction_level`, and a payload
whose canonical evidence reference/digest is included when it describes dsh state.
`pi_text` is display-only and cannot be interpreted as an authorization outcome.

The public error envelope keeps the same shape as dsh but uses only
`validation_failed`, `not_found`, `conflict`, `control_unavailable`, `forbidden`,
`rate_limited`, and `internal_error`. Node maps dsh stable codes to a safe public
code while retaining the exact dsh code only in protected local audit metadata.

### Approval and head-SHA invalidation

Only an authenticated human approval system may create an approval reference. Node
and Pi may transport an assertion but dsh verifies actor identity, approval kind,
timestamp, and the exact current head SHA. dsh records the resulting observation in
its immutable chain. On any head SHA change, dsh immediately emits `head_changed`,
creates a new approval snapshot, and marks prior QA, required-check,
resolved-discussion, and both named-human approval observations stale. Node/UI may
display that fact but may not override it. dsh continues to enforce ADR-0001: only
GitHub's merge queue may merge after all current-head conditions hold.

### Migration and delivery sequence

The existing CLI becomes a compatibility client of the same dsh core; it cannot
retain a bypass execution path. No existing evidence chain is rewritten. New product
records reference the current task/evidence contract and the originating dsh event
digest. The implementation sequence is deliberately ordered:

1. [DAT-186](mention://issue/01a177f1-52ad-71fe-b403-8c6f0822534b) (M1) implements the local control server and preserves CLI compatibility.
2. [DAT-187](mention://issue/01a177f1-58c9-77b0-8c0c-a0bcb8d556f6) (M2) adds Pi orchestration, controlled tool, and the minimal generated public contract.
3. [DAT-188](mention://issue/01a177f1-5eae-7043-96bf-7b3025d206dd) (M3) adds durable projections, replay, and recovery without changing dsh authority.
4. [DAT-189](mention://issue/01a177f1-67bf-79c0-a1ea-c109a0ee1a70) (M4) begins only after the M2/M3 contract is merged into `main`; it consumes the generated OpenAPI, not mocks.
5. [DAT-190](mention://issue/01a177f1-6dab-722c-ace7-0c852b7e88f2) (M5) validates the full protected path in an isolated repository.

### Considered options

- **Let Node/Pi call the sandbox, GitHub provider, or shell directly:** rejected because it creates an authority path that cannot be reduced to the dsh grant/evidence chain.
- **Expose dsh over localhost TCP:** rejected because loopback forwarding and ambient local processes materially widen the attack surface; UDS/Named Pipe ownership plus a boot token is the narrower local boundary.
- **Allow arbitrary Pi tools with prompt-only restrictions:** rejected because prompt instructions are not a security boundary; Pi receives only a typed controlled tool.
- **Let Node persist an independent audit log:** rejected because divergence would make evidence ordering and merge eligibility ambiguous.

## Consequences

The product gains a practical conversational and desktop layer while accepting a
strict local process topology, generated-contract discipline, and dsh round-trips.
Those costs are intentional: every consequential action remains bound to the same
grant, exact revision, and immutable evidence model already established in ADR-0001
and the task/evidence contract.
