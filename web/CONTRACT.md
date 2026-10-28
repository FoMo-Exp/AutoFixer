## Node-to-UI contract checklist

The workbench uses `src/api/contracts/openapi.json` and its generated
`schema.d.ts` as the only API source. The contract baseline is `main` at
`5828f92ca6fbff0b462d05896e689b9aad66362f` (DAT-193 #21, OpenAPI `0.5.0`,
merge-base `af2ac8e`), which contains DAT-191 (#18, `705b4a0`), DAT-192 (#19,
`af2ac8e`) and the DAT-188 M3 baseline `8734984`. No UI fixture invents a
field outside this baseline.

| Endpoint                                              | Request fields                                                                                                         | Response type                  | Status |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ |
| `POST /api/v1/tasks`                                  | `repository_id`, `base_ref`, `summary`, optional `source_reference`, `acceptance_criteria[]`; `Idempotency-Key` header | `Task`                         | ✅     |
| `GET /api/v1/tasks?cursor=&status=`                   | optional `cursor`, `status`                                                                                            | `{items: Task[], next_cursor}` | ✅     |
| `GET /api/v1/tasks/{task_id}`                         | `task_id` path                                                                                                         | `Task`                         | ✅     |
| `GET /api/v1/tasks/{task_id}/runs`                    | `task_id` path                                                                                                         | `{items: RunSummary[]}`        | ✅     |
| `POST /api/v1/tasks/{task_id}/messages`               | `mode`, `content`                                                                                                      | `{task_id, queued}`            | ✅     |
| `POST /api/v1/tasks/{task_id}/approvals`              | `decision`, `scope_digest`                                                                                             | `Task`                         | ✅     |
| `POST /api/v1/tasks/{task_id}/cancel`                 | optional `reason`                                                                                                      | `Task`                         | ✅     |
| `GET /api/v1/tasks/{task_id}/timeline`                | `task_id` path                                                                                                         | `{items: TaskEvent[]}`         | ✅     |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | `task_id`, `artifact_id` path                                                                                          | redacted artifact object       | ✅     |
| `GET /api/v1/tasks/{task_id}/stream`                  | `task_id` path; optional `Last-Event-ID` header                                                                        | SSE `TaskEvent` envelopes      | ✅     |

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
