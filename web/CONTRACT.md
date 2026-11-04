## Node-to-UI contract checklist

The workbench uses `src/api/contracts/openapi.json` and its generated
`schema.d.ts` as the only API source. The identity/session contract baseline is
`0bf66c2b4382d78577c5e23c158907579f8c228d` (DAT-202 #39, OpenAPI `0.6.0`),
merged on top of the DAT-193 `0.5.0` baseline `5828f92`; work on this surface
targets `main` at `a1dc96f` (OpenAPI `0.9.0`, after DAT-244 #55 and DAT-245 #59
added the workspace-scoped task family). No UI fixture invents a field outside
this baseline.

| Endpoint                                                                        | Request fields                                                                                                         | Response type                       | Status |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| `GET /api/v1/workspaces?cursor=`                                                | optional `cursor`                                                                                                      | `{items: Workspace[], next_cursor}` | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks`                                  | `repository_id`, `base_ref`, `summary`, optional `source_reference`, `acceptance_criteria[]`; `Idempotency-Key` header | `Task`                              | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks?cursor=&status=`                   | optional `cursor`, `status`                                                                                            | `{items: Task[], next_cursor}`      | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}`                         | `workspace_id`, `task_id` path                                                                                         | `Task`                              | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs`                    | `workspace_id`, `task_id` path                                                                                         | `{items: RunSummary[]}`             | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/messages`               | `mode`, `content`                                                                                                      | `{task_id, queued}`                 | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/approvals`              | `decision`, `scope_digest`                                                                                             | `Task`                              | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/cancel`                 | optional `reason`                                                                                                      | `Task`                              | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/archive`                | `workspace_id`, `task_id` path                                                                                         | `Task`                              | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/recover`                | `workspace_id`, `task_id` path                                                                                         | `Task`                              | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/timeline`                | `workspace_id`, `task_id` path                                                                                         | `{items: TaskEvent[]}`              | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts/{artifact_id}` | `workspace_id`, `task_id`, `artifact_id` path                                                                          | redacted artifact object            | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/stream`                  | `workspace_id`, `task_id` path; optional `Last-Event-ID` header                                                        | SSE `TaskEvent` envelopes           | ✅     |
| `GET /api/v1/auth/providers`                                                    | none                                                                                                                   | `{items: LoginProvider[]}`          | ✅     |
| `GET /api/v1/auth/login`                                                        | `provider_instance_id`, optional `return_to`, `desktop_flow`                                                           | 302 + `fp_oauth_binding` cookie     | ✅     |
| `GET /api/v1/auth/callback`                                                     | `code`, `state`                                                                                                        | 302 + HttpOnly `fp_session`         | ✅     |
| `GET /api/v1/auth/session`                                                      | session cookie or bearer                                                                                               | `SessionInfo`                       | ✅     |
| `POST /api/v1/auth/logout`                                                      | `X-CSRF-Token` for cookie sessions                                                                                     | 204                                 | ✅     |
| `POST /api/v1/auth/desktop/flows`                                               | optional `provider_instance_id`                                                                                        | `DesktopFlow`                       | ✅     |
| `POST /api/v1/auth/desktop/flows/{flow_id}/exchange`                            | `secret`                                                                                                               | session grant                       | ✅     |

### Workspace switching

`GET /api/v1/workspaces` is the switcher's only source: it returns exactly the
caller's live, active memberships with `name`, `repository`, and the
server-computed display `role`. `SessionInfo.memberships` is used only for the
auth gate and role display, never as the task scope. The chosen workspace id is
stored per user under `fp-workspace:<user id>` as a non-sensitive UI locator
and restored after a reload; it is never an authorization input — every
workspace-scoped request is re-authorized server-side, and a foreign task id or
workspace is one indistinguishable `404`.

`ForgePilotClient` is constructed with that locator (`workspaceId`), so every
task call — list, create, detail, runs, messages, approvals, cancel,
archive/recover, timeline, artifact, and SSE — goes to the
`/api/v1/workspaces/{workspace_id}/tasks...` family. Switching remounts the
workbench with a new client, which aborts the previous SSE subscription and
clears the previous selection; the new workspace subscribes from its own
timeline. A `404 NOT_FOUND` from the scoped family re-reads the workspace list:
a revoked membership drops the workspace, clears the stored locator, and
returns to the chooser (or the sole remaining workspace). Viewer roles get a
read-only surface (no create, message, approval, cancel, or archive actions);
the server remains the authority.

`workspaceId: null` selects the legacy `/api/v1/tasks` family. It exists only
for the local-operator mode where the Node service has no identity subsystem
and serves its one configured workspace; the authenticated UI never uses it.

The Electron main process discovers an existing loopback service from launch
configuration or a discovery file, or starts the local Node entrypoint with a
Node executable and parses its loopback startup address. Renderer API calls
cross a restricted IPC bridge; the main process attaches the per-process
bearer token and sends requests only to the configured HTTP loopback origin.
Redirects are rejected, and the token is never exposed to renderer JavaScript.
This keeps the browser out of the API request path, so no CORS preflight is
needed and the Node API's origin and bearer checks remain unchanged. The UI
does not display the token, raw tool commands, or absolute workspace paths.

### Pi summary

`TaskEvent.data` is not a Pi display source. `pi.text_delta` carries raw
assistant text and is stripped before it enters UI state; the workbench never
renders it. Pi text is read only from the contract's fail-closed projection:
`Task.pi_summary` (`PiSummary | null`) and `pi.summary.updated` timeline/SSE
events whose `data.summary` is the same object.

`src/ui/pi-summary.ts` resolves the current view from the projection plus the
streamed events, and fails closed:

- **projection wins over older timeline events.** `Task.version` is the
  contract's monotonic task version and every event carries `task_version`;
  a projection at version V already contains every event with
  `task_version <= V`. Only events with `task_version > task.version` apply,
  sorted by `sequence`, so a replayed or reordered timeline can never roll a
  newer projection back to an older summary or turn;
- **strict run attribution.** A summary applies only when its `task_id` is
  the task's, the task has a non-null `current_run_id`, the summary carries a
  `run_id` string, and that `run_id` equals `current_run_id`. A missing
  identity, a task without a current run, and a previous run all fail closed
  (no summary is shown);
- only `pending` / `available` / `unavailable` are displayable; an unknown
  status renders as a plain unavailable state, and an unknown
  `unavailable_reason` renders as generic unavailable (the enum is additive);
- `available` without non-empty `text` is treated as unavailable;
- `untrusted_source` is rendered with its own copy: a settled turn with no
  validated structured report has no displayable text;
- **`pi_summary.text` is withheld**: `PI_SUMMARY_TEXT_DISPLAY_ALLOWED` is
  `false`. Contract `0.5.0` (DAT-193) defines the only displayable source as
  the validated structured `report_turn_summary` report rendered by Node in
  fixed wording, but `PiSummary` exposes no provenance or schema-version
  discriminator, and recorded history is never rewritten — a summary settled
  before DAT-193 stays `available` with arbitrary free-model text (the
  previous boundary exposed `node app succeeded.`). A client therefore cannot
  prove which `available` summaries came from the trusted report channel, and
  text inspection is explicitly not the trust boundary. The workbench fails
  closed: it shows the state and reason, never `text`, and does not claim the
  natural-language-summary acceptance criterion. It does not infer provenance
  from wording. **Required contract change:** a positive source marker on
  `PiSummary` (for example a provenance/version discriminator identifying the
  structured-report rendering) so clients can display exactly the proven
  source and withhold everything else.

Fixtures for these tests are the merged-contract captures under
`docs/fixtures/forgepilot-api-v1/` (`task-pi-summary-available.json`,
`pi-summary-events-available.json`), not invented shapes.

The Electron window smoke additionally runs the real orchestrator with
test-only deterministic scripted Pi streams through the existing
`createOrchestrator({ model, streamFn })` seam, for both paths:

- a turn that calls `report_turn_summary` with closed-enum values settles
  `available` with Node's fixed wording; the smoke asserts the exact rendered
  text, projection equality, current-run attribution, that a `Last-Event-ID`
  replay does not repeat the summary, and that the turn's free text appears in
  no summary surface;
- a free-text-only turn settles `unavailable` / `untrusted_source` with
  `text:null`, and neither the projection nor any summary event carries the
  turn text.

Each path opens a second real window over the same state to confirm the
rendered card after a reload: `AVAILABLE · TEXT WITHHELD` for the structured
report and `UNAVAILABLE` with the untrusted-source copy for the free-text
turn, with no withheld text in the DOM. No production debug endpoint, network
transfer, or credential is involved.
