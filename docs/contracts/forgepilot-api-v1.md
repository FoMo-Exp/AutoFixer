# forgepilot-api/v1

**Status:** normative M0 public API contract

This is the Node-to-Electron/React API. The UI only calls Node at an ephemeral
loopback address; it never sees dsh sockets, boot tokens, Pi credentials, raw
tool output, or provider credentials.

## Task resource

```json
{
  "id":"tsk_01J...","version":12,"created_at":"2026-10-26T12:00:00Z","updated_at":"2026-10-26T12:03:00Z",
  "current_run_id":"run_01J...","run_history_url":"/api/v1/tasks/tsk_01J.../runs",
  "repository":{"id":"github:acme/payments","display_name":"acme/payments","base_ref":"main","base_sha":"ab12cd..."},
  "request":{"summary":"Fix export exception.","source_reference":"https://github.com/acme/payments/issues/1234"},
  "status":"executing","status_reason":null,
  "risk":{"class":"low","decision_code":"risk_low_approved","requires_human_approval":false},
  "progress":{"phase":"validating","actions_completed":2,"actions_total":3},
  "artifacts":{"patch":null,"report":null,"evidence_bundle_available":false}
}
```

The UI status enum is `queued`, `assessing_risk`, `awaiting_approval`,
`approved`, `planning`, `executing`, `validating`, `awaiting_review`,
`approved_for_merge`, `stopped`, `rejected`, `cancelled`, `timed_out`,
`expired`, or `merged`. It is a projection and cannot mutate dsh's state
machine. `failed` is deliberately not a status: an execution failure is
projected as its authoritative `stopped` or `timed_out` outcome.

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
| `POST /api/v1/tasks` | `repository_id`, `base_ref`, `summary`, `source_reference`, `acceptance_criteria[]` | `201 Task` |
| `GET /api/v1/tasks?cursor=&status=` | none | `200 {items: Task[], next_cursor}` |
| `GET /api/v1/tasks/{task_id}` | none | `200 Task` |
| `GET /api/v1/tasks/{task_id}/runs` | none | `200 {items: redacted RunSummary[]}` ordered by creation time |
| `POST /api/v1/tasks/{task_id}/messages` | `{mode:"steer"|"follow_up",content:"..."}` | `202 {task_id, queued:true}` |
| `POST /api/v1/tasks/{task_id}/approvals` | `{decision:"approve"|"reject",scope_digest:"sha256:..."}` | `200 Task` |
| `POST /api/v1/tasks/{task_id}/cancel` | optional reason | `202 Task` |
| `GET /api/v1/tasks/{task_id}/timeline` | none | `200 {items: TimelineEvent[]}` |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | none | `200 redacted artifact` |
| `GET /api/v1/tasks/{task_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |

SSE events contain `event_id`, `sequence`, `occurred_at`, `task_id`,
`task_version`, `type`, and redacted `data`. Types are `task.status_changed`,
`pi.text_delta`, `pi.turn_settled`, `plan.updated`, `approval.required`,
`approval.resolved`, `tool.requested`, `tool.completed`, `tool.denied`,
`validation.completed`, `artifact.available`, `evidence.appended`, and
`task.terminal`. Node replays by `Last-Event-ID` in sequence order.

## Error model

```json
{"error":{"code":"TASK_STATE_CONFLICT","message":"The task cannot be cancelled in its terminal state.","request_id":"req_...","retryable":false,"details":{}}}
```

General codes are `400 INVALID_REQUEST|INVALID_CURSOR`, `401 UNAUTHENTICATED`,
`403 FORBIDDEN`, `404 TASK_NOT_FOUND`, `409 TASK_STATE_CONFLICT|IDEMPOTENCY_CONFLICT`,
`429 RATE_LIMITED`, `500 INTERNAL_ERROR`, and `503 PI_UNAVAILABLE|DSH_UNAVAILABLE`.
Node maps dsh policy outcomes without exposing sensitive dsh internals:
`403 DSH_SCOPE_DENIED|DSH_POLICY_DENIED`, `410 DSH_GRANT_EXPIRED`, `422
DSH_RISK_PROHIBITED`, and `428 DSH_APPROVAL_REQUIRED`.

The implementation MUST generate an OpenAPI document and TypeScript client
from this contract. UI work is blocked until that generated contract is merged
to `main`; fixtures must match it exactly.
