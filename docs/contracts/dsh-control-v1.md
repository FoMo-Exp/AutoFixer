# dsh-control/v1

**Status:** normative M0 contract

This contract is the local Node-to-dsh control boundary. All record shapes
which represent task evidence remain governed by
[`task-evidence-contract-v1`](task-evidence-contract-v1.md). Every response
or event field named `state` uses exactly the state vocabulary in that
contract's §5: `requested`, `approved`, `running`, `awaiting_review`,
`approved_for_merge`, `stopped`, `timed_out`, `expired`, `rejected`,
`cancelled`, or `merged`. No endpoint or client may invent another dsh state.

## Transport and common rules

- Unix uses a UDS; Windows uses a Named Pipe. dsh MUST NOT bind a TCP port.
- Every request except `/v1/health` sends `X-DSH-Protocol: 1`, an ephemeral
  `X-DSH-Boot-Token`, and `X-Request-Id`. Writes also send `Idempotency-Key`.
  `/v1/health` uses no protocol header to discover supported versions; if a
  caller optionally supplies an unsupported protocol value, it receives `426
  PROTOCOL_VERSION_UNSUPPORTED`.
- dsh retains each idempotency key for the evidence retention period. Reuse
  with a different payload returns `409 IDEMPOTENCY_CONFLICT`.
- Node MUST NOT submit a risk class, capability grant, shell command, raw argv,
  provider credential, or merge permission. Missing scope means denied.
- Tool execution accepts only registered `tool_id` plus schema-validated JSON
  arguments. Tool output and event arguments are redacted before response.

All errors use:

```json
{"error":{"code":"DSH_SCOPE_DENIED","message":"Action is outside the approved grant.","request_id":"req_...","retryable":false,"details":{}}}
```

## Create a run

`POST /v1/runs`

```json
{
  "task_id":"tsk_01J...",
  "issue":{"provider":"github","external_id":"1234","source_reference":"https://github.com/acme/payments/issues/1234"},
  "repository":{"repository_id":"github:acme/payments","url":"https://github.com/acme/payments.git","base_ref":"main","base_sha":"ab12cd..."},
  "request":{"summary":"Fix export exception.","acceptance_criteria":["Focused test passes"],"requested_by":{"actor_id":"usr_01J...","display_name":"Aphrodite Luminare"}},
  "proposed_work":{"localized_reversible_change":true,"broad_refactor":false,"dependency_change":false,"data_shape_change":false,"migration":false,"permission_sensitive":false,"material_uncertainty":false,"requests_secret_access":false,"writes_to_main":false,"edits_ci_workflows":false,"edits_governance":false,"publishes_package":false,"deploys":false,"alters_infrastructure":false,"unapproved_network":false},
  "requested_scope":{"path_hints":["web/src/export/**"],"tool_capabilities":["repo.read","workspace.patch","test.run"],"max_wall_clock_seconds":1800}
}
```

Returns `201` with a dsh-derived `run_id`, `state`, `risk_assessment`, and,
when low-risk, a grant summary. An elevated run returns `state: requested` plus
`required_action` containing a `scope_digest`; it is not executable yet.

Errors: `400 INVALID_REQUEST|INVALID_REPOSITORY_IDENTITY|INVALID_BASE_SHA`,
`403 DSH_POLICY_DENIED`, `409 IDEMPOTENCY_CONFLICT|TASK_ALREADY_HAS_ACTIVE_RUN`,
`422 DSH_RISK_PROHIBITED`, `503 DSH_UNAVAILABLE`.

## Record approval

`POST /v1/runs/{run_id}/approvals`

```json
{"approval_id":"apr_01J...","decision":"approve","approved_by":{"actor_id":"usr_01J...","identity":"github:aphrodite"},"approved_at":"2026-10-26T12:01:00Z","scope_digest":"sha256:3a9f..."}
```

`decision` is `approve` or `reject`. An approval response is `200` with the
new state, `audit_event_reference`, and, when approved, the grant summary.
Rejecting creates an auditable `rejected` terminal result. Errors: `404
RUN_NOT_FOUND`, `403 DSH_APPROVER_NOT_AUTHORIZED`, `409
TASK_STATE_CONFLICT|APPROVAL_ALREADY_RECORDED|DSH_APPROVAL_SCOPE_MISMATCH`,
`410 DSH_APPROVAL_WINDOW_EXPIRED`.

## Submit a Pi action intent

`POST /v1/runs/{run_id}/actions`

```json
{"action_id":"act_01J...","agent":{"runtime":"pi","session_id":"pis_01J...","turn_id":"turn_17"},"intent":{"tool_id":"test.run","arguments":{"target":"web/src/export/export-button.test.ts","mode":"focused"},"path_scope":["web/src/export/export-button.test.ts"],"network_destinations":[],"rationale":"Verify the regression."}}
```

Returns `202` with `action_id`, `state`, `accepted_tool_id`, and an audit event
reference. Completion is observed through events, never inferred from `202`.
Errors: `400 INVALID_ACTION_INTENT|INVALID_TOOL_ARGUMENTS`, `404
RUN_NOT_FOUND|TOOL_NOT_REGISTERED`, `403
DSH_SCOPE_DENIED|DSH_POLICY_DENIED|DSH_TOOL_NOT_ALLOWLISTED`, `409
TASK_STATE_CONFLICT|ACTION_ALREADY_SUBMITTED`, `410
DSH_GRANT_EXPIRED|DSH_GRANT_REVOKED`, `428 DSH_APPROVAL_REQUIRED`, `429
DSH_RUN_BUSY`, `503 DSH_SANDBOX_UNAVAILABLE`.

## Cancel a run

`POST /v1/runs/{run_id}/cancel`

```json
{"requested_by":{"actor_id":"usr_01J...","identity":"github:aphrodite"},"reason":"User stopped the task."}
```

Returns `202` with `cancellation_requested: true` and the audit reference.
dsh revokes the grant and terminates cancellable children; a later event must
record the `cancelled` terminal state and a complete bundle. Repeating against a
terminal run returns `200` with that existing terminal state. Errors: `404
RUN_NOT_FOUND`, `403 DSH_CANCELLER_NOT_AUTHORIZED`, `409
TASK_STATE_CONFLICT`, `503 DSH_CANCELLATION_CONTROL_FAILURE`.

## Read run, events, evidence, and artifacts

| Request | Successful response | Errors |
|---|---|---|
| `GET /v1/runs/{run_id}` | `200` run state, risk assessment, grant status and scope digest, execution counts, patch report, approval snapshot, bundle availability | `404 RUN_NOT_FOUND`; `503 DSH_EVIDENCE_STORE_UNAVAILABLE` |
| `GET /v1/runs/{run_id}/events?after_sequence=0&limit=100` | `200` ordered, redacted immutable events with `next_after_sequence` and `has_more` | `400 INVALID_EVENT_CURSOR|INVALID_LIMIT`; `404 RUN_NOT_FOUND`; `410 EVIDENCE_RETENTION_EXPIRED`; `503 DSH_EVIDENCE_STORE_UNAVAILABLE` |
| `GET /v1/runs/{run_id}/evidence-bundle` | `200` complete task/risk/grant/events/patch/approval evidence bundle | `404 RUN_NOT_FOUND`; `409 EVIDENCE_BUNDLE_NOT_FINALIZED`; `410 EVIDENCE_RETENTION_EXPIRED`; `503 DSH_EVIDENCE_STORE_UNAVAILABLE` |
| `GET /v1/runs/{run_id}/artifacts/{artifact_id}` | `200` authorised redacted `patch_diff`, `patch_report`, `validation_summary`, `redacted_execution_log`, or `evidence_bundle`, each with digest | `403 ARTIFACT_ACCESS_DENIED|ARTIFACT_SENSITIVE_CONTENT`; `404 RUN_NOT_FOUND|ARTIFACT_NOT_FOUND`; `409 ARTIFACT_NOT_FINALIZED`; `410 ARTIFACT_EXPIRED` |

An execution event includes its sequence, immutable state transition, redacted
tool identity/arguments, redacted output digest, decision/stop code, and
previous/event SHA-256 chain fields. dsh never returns raw secrets, provider
tokens, raw environment, absolute workspace paths, or unredacted output.

## Health

`GET /v1/health` returns `200`:

```json
{"service":"dsh","status":"ready","protocol":{"supported":["1"],"default":"1"},"contract_version":"1.0.0","policy_version":"dsh-policy-1","capabilities":{"local_transport_only":true,"execution_control":true,"event_read":true,"evidence_bundle":true,"provider_write":false}}
```

Errors: `426 PROTOCOL_VERSION_UNSUPPORTED`, `503 DSH_STARTING|DSH_DEGRADED`,
`500 DSH_CONFIGURATION_INVALID`.
