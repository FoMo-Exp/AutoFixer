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
  "pi_summary":{"task_id":"tsk_01J...","run_id":"run_01J...","turn_id":"turn_1","status":"unavailable","text":null,"unavailable_reason":"untrusted_source","source":null,"updated_at":"2026-10-26T12:03:00Z"},
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
| `GET /api/v1/tasks/{task_id}/runs` | none | `200 {items: redacted RunSummary[]}` ordered by creation time |
| `POST /api/v1/tasks/{task_id}/messages` | `{mode:"steer"|"follow_up",content:"..."}` | `202 {task_id, queued:true}` |
| `POST /api/v1/tasks/{task_id}/approvals` | `{decision:"approve"|"reject",scope_digest:"sha256:..."}` | `200 Task` |
| `POST /api/v1/tasks/{task_id}/cancel` | optional reason | `202 Task` |
| `POST /api/v1/tasks/{task_id}/archive` | none | `200 Task` with `archived: true` |
| `POST /api/v1/tasks/{task_id}/recover` | none | `200 Task` with `archived: false` |
| `GET /api/v1/tasks/{task_id}/timeline` | none | `200 {items: TimelineEvent[]}` |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | none | `200 redacted artifact` |
| `GET /api/v1/tasks/{task_id}/stream` | `Last-Event-ID` optional | `200 text/event-stream` |

Archive and recover apply only to cancelled tasks and return `409` for other
statuses. These operations move the existing task between workspace views;
they do not resume or create a run.

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
