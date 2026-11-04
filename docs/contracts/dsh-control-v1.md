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

The registered tool surface is the frozen `tools.json` fixture
(`docs/fixtures/dsh-control-v1/tools.json`): the structured operations
`repo.read`, `repo.search`, `workspace.patch`, `test.run`, and `dep.prepare`
that replace raw shell and file access, plus the M0 enum fixtures. Test and
dependency commands come only from registered sandbox profiles (`go.test`,
`node.test`, `go.mod`, `node.package`); a request may pick a profile, mode,
and target but can never name a command, and an over-privileged request
(missing target, unknown mode, unregistered profile, escaping path) is
refused with `403 DSH_TOOL_NOT_ALLOWLISTED` and a run-stopping evidence
record. Paths are lexically and symlink contained; secret-looking paths and
`.git` are prohibited for every tool; dependency and migration edits require
an elevated run and workflow/governance edits are never allowed. A profile's
real execution scope must fit the grant: a focused run is bounded to its
target and package directory, while `suite`, dependency preparation, and
root-level targets are repository-wide and need a repository-wide grant —
otherwise `403 DSH_SCOPE_DENIED` (`grant_scope_exceeded`). Declared
resource limits are enforced, never merely recorded: the whole process
domain (group plus descendants) is killed on a memory or CPU breach, a
kernel CPU cap is pinned where the platform has one, and an execution whose
caps cannot be enforced is blocked instead of running uncapped. An
execution's process lifecycle ends with the execution: supervision keeps
enforcing the caps until nothing of the execution is alive, and every
descendant it can attribute — background children and children that created
their own session included — is terminated when the command ends. That
lifecycle guarantee requires a platform-owned execution domain: on Linux the
execution runs in its own PID namespace (bubblewrap), so the kernel removes
every remaining process when the namespace dies, and the guarantee is
absolute.

macOS has no cgroup or PID namespace, and the non-privileged mechanisms do
not close the gap. A child that forks, calls `setsid`, is reparented, and
moves its working directory out of the run's workspace before an observation
escapes both the process group and the descendant walk, so its memory and CPU
stop being accounted. Seatbelt still confines what that child can reach — no
descendant can drop the inherited rules, so control-plane secrets, host
credentials, unapproved networks, and writes outside the workspace stay
blocked — but confinement is not a complete execution domain. Measured
alternatives were rejected: a transient `launchd` job does not terminate a
`setsid` + reparented descendant when the job is removed (its control is the
process group), and an EndpointSecurity fork listener requires root and a
signed Apple entitlement, which a local desktop runtime cannot assume.
Therefore **untrusted execution is refused on macOS**: test and dependency
profiles are blocked with `503 DSH_SANDBOX_UNAVAILABLE` and
`details.reason = "execution_domain_incomplete"` until a container or VM
execution backend is configured; there is no best-effort downgrade. Structured
`repo.read`, `repo.search`, and `workspace.patch` operations remain available
because they run no untrusted process. Local development of the execution
backend requires Linux with bubblewrap or a container/VM host. Supervision
that cannot be established — no process accounting, a fork watcher that
cannot be created or armed, or a backend that cannot guarantee the execution
domain — blocks the execution with `503 DSH_SANDBOX_UNAVAILABLE` instead of
running it unsupervised.

Returns `202` with `action_id`, `state`, `accepted_tool_id`, an audit event
reference, and — for structured operations — `result` and `output`.
`result` binds the outcome to the exact revision (`revision`:
repository/base SHA/tree digest) and, for test and dependency runs, the test
environment (`environment`: OS isolation backend, applied-profile digest,
network policy, and the enforced resource caps with the mechanism that
enforces them — `enforced_limits`) under one tamper-evident `digest`.
`output` is the
redacted, bounded output (file content, search matches, tool output).
Completion is observed through events, never inferred from `202`.
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
