## Node-to-UI contract checklist

The workbench uses `src/api/contracts/openapi.json` and its generated
`schema.d.ts` as the only API source. The contract baseline is `main` at
`af2ac8e97a7e9e91fa9a0987e4c05352bf6d299a` (DAT-192 #19), which contains the
DAT-191 safe-summary contract (#18, merge commit `705b4a0`) and the DAT-188 M3
baseline `8734984`. No UI fixture invents a field outside this baseline.

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

- events for another task, or for a run other than `current_run_id`, never
  apply (cross-task/run isolation);
- only `pending` / `available` / `unavailable` are displayable; an unknown
  status renders as a plain unavailable state, and an unknown
  `unavailable_reason` renders as generic unavailable (the enum is additive);
- `available` without non-empty `text` is treated as unavailable;
- **`pi_summary.text` is withheld**: `PI_SUMMARY_TEXT_DISPLAY_ALLOWED` is
  `false`. The merged contract's "Honest residual" admits command-shaped text
  certified as `available` — `node app succeeded.` is exposed verbatim by
  `node/dist` on the `af2ac8e` baseline, and DAT-189 acceptance forbids
  displaying raw commands. Until the backend closes that residual or the
  Architect rules it acceptable, the workbench shows the summary state and
  reason only, and does not claim the natural-language-summary acceptance
  criterion. Rendering the certified text is a one-constant change once that
  ruling exists; the frontend does not attempt to re-judge the text.

Fixtures for these tests are the merged-contract captures under
`docs/fixtures/forgepilot-api-v1/` (`task-pi-summary-available.json`,
`pi-summary-events-available.json`), not invented shapes.
