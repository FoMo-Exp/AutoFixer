# forgepilot-api/v1

**Status:** normative M0 public API contract

This is the Node-to-Electron/React API. The UI only calls Node at an ephemeral
loopback address; it never sees dsh sockets, boot tokens, Pi credentials, raw
tool output, or provider credentials.

## Authentication

Every `/api/v1` request MUST carry the per-process bearer token:

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

The OpenAPI document declares this as the `bearerAuth` security scheme
(`type: http`, `scheme: bearer`); every operation requires it and documents the
`401` response, so a client generated from the contract sends the credential.

## Task resource

```json
{
  "id":"tsk_01J...","version":12,"created_at":"2026-10-26T12:00:00Z","updated_at":"2026-10-26T12:03:00Z",
  "current_run_id":"run_01J...","run_history_url":"/api/v1/tasks/tsk_01J.../runs",
  "repository":{"id":"github:acme/payments","display_name":"acme/payments","base_ref":"main","base_sha":"ab12cd..."},
  "request":{"summary":"Fix export exception.","source_reference":"https://github.com/acme/payments/issues/1234"},
  "association":{"task_id":"tsk_01J...","run_id":"run_01J...","repository_id":"github:acme/payments","base_sha":"ab12cd...","head_sha":"9ef012..."},
  "revision":{"base_sha":"ab12cd...","head_sha":"9ef012..."},
  "status":"executing","status_reason":null,
  "risk":{"class":"low","decision_code":"risk_low_approved","requires_human_approval":false},
  "progress":{"phase":"validating","actions_completed":2,"actions_total":3},
  "pi_summary":{"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","status":"available","text":"Checked the echo tool and confirmed it prints hello.","unavailable_reason":null,"updated_at":"2026-10-26T12:03:00Z"},
  "governance":{"current_head_sha":"9ef012...","observations_valid":true,"merge_queue_eligible":false},
  "artifacts":{"patch":null,"report":null,"evidence_bundle_available":false,"index":[{"artifact_id":"patch_report","available":true,"digest":"sha256:…","head_sha":"9ef012..."}]}
}
```

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

`pi_summary` is the display-safe summary of the latest settled Pi turn for
the task's current run; its full semantics are specified in [Safe Pi text
summary](#safe-pi-text-summary) below. It is `null` until a Pi session exists
for the task.

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
| `GET /api/v1/tasks/{task_id}/runs` | none | `200 {items: redacted RunSummary[]}` ordered by creation time |
| `POST /api/v1/tasks/{task_id}/messages` | `{mode:"steer"|"follow_up",content:"..."}` | `202 {task_id, queued:true}` |
| `POST /api/v1/tasks/{task_id}/approvals` | `{decision:"approve"|"reject",scope_digest:"sha256:..."}` | `200 Task` |
| `POST /api/v1/tasks/{task_id}/cancel` | optional reason | `202 Task` |
| `GET /api/v1/tasks/{task_id}/timeline` | none | `200 {items: TimelineEvent[]}` |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | none | `200 redacted artifact` |
| `GET /api/v1/tasks/{task_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |

SSE events contain `event_id`, `sequence`, `occurred_at`, `task_id`,
`task_version`, `type`, and redacted `data`. Types are `task.status_changed`,
`pi.text_delta`, `pi.turn_settled`, `pi.summary.updated`, `plan.updated`,
`approval.required`,
`approval.resolved`, `tool.requested`, `tool.completed`, `tool.denied`,
`validation.completed`, `artifact.available`, `evidence.appended`, and
`task.terminal`. Node replays by `Last-Event-ID` in sequence order.

## Safe Pi text summary

`pi.text_delta` carries raw assistant text and is **never** a display
source: free-form model output can contain credentials, commands, absolute
workspace paths, or unredacted logs, and client-side filtering cannot be
the safety boundary. The product API exposes Pi text only as the fail-closed
`pi_summary` projection, judged on the Node side by the ordered safety-rule
table in `node/src/api/pi-summary.ts` — deterministic, reviewable, and free
of any model call, network transfer, or widened permission.

`GET /api/v1/tasks/{task_id}` (and every other Task response) carries the
`pi_summary` field, and every change is recorded as a `pi.summary.updated`
timeline/SSE event whose `data.summary` is the same object:

```json
{"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","status":"available","text":"Checked the echo tool and confirmed it prints hello.","unavailable_reason":null,"updated_at":"2026-10-26T12:03:00Z"}
```

Contract semantics:

- **Source.** The summary describes the fully assembled assistant text of
  one settled Pi turn (`run_started` to settlement) of the run's Pi session.
  Node performs the judging; the source is auditable in the orchestrator
  code, not reconstructed by the client.
- **Generation.** A turn that passes every safety rule is excerpted to its
  first non-empty paragraph, single-spaced, bounded to 240 characters.
- **Safety boundary.** The ordered rules keep out exactly these five
  classes; `available` means the whole turn passed all five, nothing more:
  - *credential-shaped material*: provider prefixes `sk-`, `sk_live_` /
    `sk_test_`, `ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_`, `github_pat_`,
    `AKIA` / `ASIA`, `xox*`, `glpat-`, `AIza`, `npm_`, `SG.`, `dop_v1_`,
    `SK`+32 hex, PEM private-key blocks, `Bearer …` headers, and
    `authorization` / `api_key` / `password` / … assignments;
  - *raw command material*: fenced code blocks, inline code spans containing
    shell metacharacters or a command executable, `$ ` prompt lines, bare
    invocations of shell utilities (sudo, su, chmod, chown, rm, mv, cp,
    curl, wget, ssh, scp, rsync, sh/bash/zsh, docker, kubectl, systemctl,
    launchctl), interpreter invocations with a flag or file argument
    (python, node, java, ruby, perl, php, deno), and git / npm / pnpm /
    yarn / bun / deno / pip / cargo / make / go invocations with a
    subcommand or flag;
  - *absolute local filesystem paths* at the roots `Users`, `home`, `root`,
    `tmp`, `var`, `private`, `etc`, `opt`, `mnt`, `media`, `srv`, `proc`,
    `usr`, `bin`, `sbin`, `Library`, `System`, `Applications`, `Volumes`,
    `workspace`, `workdir`, plus Windows drive letters;
  - *unredacted log / diagnostic output*: stack frames, log-level lines,
    `fatal:` / `error:` / `warning:` / `critical:` markers, ANSI escapes,
    and log timestamps;
  - *opaque high-entropy strings*: hex runs of 32+ characters and
    base64-shaped runs of 32+ characters (digests, API keys, auth blobs)
    whose safety cannot be determined from the text.

  The complete turn text is judged — never one fragment at a time — so
  material split across `pi.text_delta` fragments is caught in its
  assembled form. `available` asserts only non-membership in these five
  classes; it is not a general claim that the text is harmless.
- **Fail closed.** Any rule hit yields `status:"unavailable"` with
  `unavailable_reason:"unsafe_content"`; a failure inside the gate itself
  yields `"gate_error"`; a settled turn with no displayable text yields
  `"no_content"`. An unavailable summary never carries the raw turn text —
  in any field, event, or projection.
- **Lifecycle and attribution.** `pi_summary` is `null` until a Pi session
  exists for the task; `pending` from session start — and again at the
  start of every new run, which resets any earlier run's summary to
  `pending` — then exactly one `available`/`unavailable` per settled turn,
  each replacing the previous summary. `task_id`, `run_id`, and `turn_id`
  bind the summary to the producing task, run, and turn; a summary never
  crosses task or run boundaries.
- **Missing / unavailable semantics.** `text` is non-null if and only if
  `status` is `"available"`; `unavailable_reason` is non-null if and only if
  `status` is `"unavailable"`; both are null while `pending`. Clients render
  unavailable states from the reason enum and must never fall back to
  displaying the raw `pi.text_delta` stream.
- **SSE and recovery.** `pi.summary.updated` is a durable timeline event: it
  replays by `Last-Event-ID` in sequence order, survives an orchestrator
  restart with its original `event_id`, and the `pi_summary` projection
  field always equals the last published summary event. Each settled turn
  publishes exactly one summary event — the duplicated `agent_error` then
  `agent_settled` emission of a provider failure settles one turn once. Pi
  sessions are not resumed across restarts (see Durability), so a recovered
  task keeps the last settled summary it actually produced.
- **Terminal without a settled turn.** A terminal task whose last turn never
  settled (cancel or abort winning the race against settlement) keeps
  `status:"pending"` with `text:null`: Node never fabricates a summary after
  the terminal frame. Clients that render on a pending summary of a terminal
  task show no summary, gating on the task status instead.

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
