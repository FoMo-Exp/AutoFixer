## Node-to-UI contract checklist

The workbench uses `src/api/contracts/openapi.json` and its generated
`schema.d.ts` as the only API source. The contract baseline is `main` at
`8734984` (DAT-188 M3), which contains the M2 contract commit `6a0a679`
(DAT-187). No UI fixture invents a field outside this baseline.

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

`TaskEvent.data` is the only Pi source in this contract: `pi.text_delta`
carries `delta` and `pi.turn_settled` carries no payload. The contract does not
define a server-redacted natural-language summary, so the workbench never
renders `delta`. It renders a summary built from typed event fields instead:
contiguous delta runs as one Pi turn row with its update count and settle state,
plus a task-level tally of turns, text updates, and `tool.*` outcomes. Adding a
redacted summary field would be a contract change owned by the Node service;
until then, redacted artifacts remain the detail path.
