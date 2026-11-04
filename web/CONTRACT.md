## Node-to-UI contract checklist

The workbench uses `src/api/contracts/openapi.json` and its generated
`schema.d.ts` as the only API source. The identity/workspace surface targets the
DAT-205 contract `7f85830533aeebf8552451428f86cb5cb1d0d8c7` (OpenAPI `0.7.0`),
carried forward on `main` at `ff51ebf` (OpenAPI `0.9.0`, DAT-241/DAT-244
workspace scoping) on top of the DAT-202 auth baseline
`0bf66c2b4382d78577c5e23c158907579f8c228d` (OpenAPI `0.6.0`) and the DAT-193
`0.5.0` baseline `5828f92`. No UI fixture invents a field outside this
baseline.

| Endpoint                                              | Request fields                                                                                                         | Response type                   | Status |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------ |
| `POST /api/v1/tasks`                                  | `repository_id`, `base_ref`, `summary`, optional `source_reference`, `acceptance_criteria[]`; `Idempotency-Key` header | `Task`                          | ✅     |
| `GET /api/v1/tasks?cursor=&status=`                   | optional `cursor`, `status`                                                                                            | `{items: Task[], next_cursor}`  | ✅     |
| `GET /api/v1/tasks/{task_id}`                         | `task_id` path                                                                                                         | `Task`                          | ✅     |
| `GET /api/v1/tasks/{task_id}/runs`                    | `task_id` path                                                                                                         | `{items: RunSummary[]}`         | ✅     |
| `POST /api/v1/tasks/{task_id}/messages`               | `mode`, `content`                                                                                                      | `{task_id, queued}`             | ✅     |
| `POST /api/v1/tasks/{task_id}/approvals`              | `decision`, `scope_digest`                                                                                             | `Task`                          | ✅     |
| `POST /api/v1/tasks/{task_id}/cancel`                 | optional `reason`                                                                                                      | `Task`                          | ✅     |
| `GET /api/v1/tasks/{task_id}/timeline`                | `task_id` path                                                                                                         | `{items: TaskEvent[]}`          | ✅     |
| `GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}` | `task_id`, `artifact_id` path                                                                                          | redacted artifact object        | ✅     |
| `GET /api/v1/tasks/{task_id}/stream`                  | `task_id` path; optional `Last-Event-ID` header                                                                        | SSE `TaskEvent` envelopes       | ✅     |
| `GET /api/v1/auth/providers`                          | none                                                                                                                   | `{items: LoginProvider[]}`      | ✅     |
| `GET /api/v1/auth/login`                              | `provider_instance_id`, optional `return_to`, `desktop_flow`                                                           | 302 + `fp_oauth_binding` cookie | ✅     |
| `GET /api/v1/auth/callback`                           | `code`, `state`                                                                                                        | 302 + HttpOnly `fp_session`     | ✅     |
| `GET /api/v1/auth/session`                            | session cookie or bearer                                                                                               | `SessionInfo`                   | ✅     |
| `POST /api/v1/auth/logout`                            | `X-CSRF-Token` for cookie sessions                                                                                     | 204                             | ✅     |
| `POST /api/v1/auth/desktop/flows`                     | optional `provider_instance_id`                                                                                        | `DesktopFlow`                   | ✅     |
| `POST /api/v1/auth/desktop/flows/{flow_id}/exchange`  | `secret`                                                                                                               | session grant                   | ✅     |

Workspace switching is not implementable on this baseline: the task endpoints
carry no workspace selector (path, query, or header), and `GET /api/v1/auth/session`
memberships are not a task scope. Node resolves task authority against its
single configured workspace (`node/src/api/auth-service.ts`, `workspaceRole`),
so the UI must not present a switch that only changes a label. DAT-206 covers
the auth/session client; a real switcher depends on a workspace-scoped task
contract plus server enforcement.

### Workspace, member, team, and invitation surface

Baseline `7f85830533aeebf8552451428f86cb5cb1d0d8c7` (DAT-205 #38, OpenAPI
`0.7.0`). Fixtures are the merged-contract captures under
`docs/fixtures/identity-api-v1/`; no field is invented.

| Endpoint                                                               | Request fields                                                                           | Response type                                             | Status |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| `GET /api/v1/auth/session`                                             | none                                                                                     | `SessionInfo`                                             | ✅     |
| `GET /api/v1/auth/providers`                                           | none                                                                                     | `{items: LoginProvider[]}`                                | ✅     |
| `GET /api/v1/workspaces`                                               | optional `cursor`                                                                        | `{items: Workspace[], next_cursor}`                       | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/members`                        | `workspace_id` path; optional `cursor`                                                   | `{items: Membership[], next_cursor}`                      | ✅     |
| `PATCH /api/v1/workspaces/{workspace_id}/members/{membership_id}`      | `role`, `version`; optional `X-CSRF-Token`                                               | `Membership`                                              | ✅     |
| `DELETE /api/v1/workspaces/{workspace_id}/members/{membership_id}`     | path ids; optional `X-CSRF-Token`                                                        | `204`                                                     | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/teams`                          | `workspace_id` path; optional `cursor`                                                   | `{items: Team[], next_cursor}`                            | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/teams`                         | `name`, `leader_user_id`, optional `responsibility`                                      | `Team`                                                    | ✅     |
| `PATCH /api/v1/workspaces/{workspace_id}/teams/{team_id}`              | optional `name`, `leader_user_id`, `responsibility` (string or null), required `version` | `Team`                                                    | ✅     |
| `DELETE /api/v1/workspaces/{workspace_id}/teams/{team_id}`             | path ids                                                                                 | `204`                                                     | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/invitations`                    | `workspace_id` path; optional `cursor`                                                   | `{items: Invitation[], next_cursor}` (token-free)         | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/invitations`                   | optional `expires_in_seconds` (1–86400), `bound_provider_subject`                        | `CreatedInvitation` (`invitation`, `token`, `invite_url`) | ✅     |
| `DELETE /api/v1/workspaces/{workspace_id}/invitations/{invitation_id}` | path ids                                                                                 | `204`                                                     | ✅     |
| `POST /api/v1/invitations/preview`                                     | `token` in the JSON body                                                                 | `InvitationPreview`                                       | ✅     |
| `POST /api/v1/invitations/redeem`                                      | `token` in the JSON body                                                                 | `InvitationRedemption`                                    | ✅     |
| `GET /api/v1/admin/enterprises/{enterprise_id}/auth-audit`             | optional `limit`                                                                         | `{items: AuthAuditRecord[]}`                              | ✅     |

UI behavior that follows the contract:

- The invitation token is captured from the URL fragment, the fragment is
  cleared with `history.replaceState` before any request, and the token is
  submitted only in the `preview`/`redeem` POST bodies. Landing on an invite
  URL performs no consumption; the confirmation button is the only path to
  `redeem`.
- Only the create response is ever rendered with a token (grouped code and a
  QR encoding `invite_url`). The QR renders modules only, never token text.
  Every list view is token-free, and closing the reveal drops the token from
  component state.
- Bearer-authenticated transports never send `X-CSRF-Token`; the cookie
  transport echoes the session's `csrf_token` after `GET /auth/session`.
- Administrative controls are hidden for roles that cannot manage, but the
  server remains authoritative: `403 ROLE_NOT_ASSIGNABLE`, `403 FORBIDDEN`,
  `404 NOT_FOUND`, `409 VERSION_CONFLICT`, `422 TEAM_LEADER_NOT_MEMBER`, and
  `429 RATE_LIMITED` all render their envelope message and case reference.
- Stale or `unknown` provider-role provenance renders a `Stale` badge, and
  version conflicts reload the roster before the next write.

The Electron main process discovers an existing loopback service from launch
configuration or a discovery file, or starts the local Node entrypoint with a
Node executable and parses its loopback startup address. Renderer API calls
cross a restricted IPC bridge; the main process attaches the per-process
bearer token and sends requests only to the configured HTTP loopback origin.
Redirects are rejected, and the token is never exposed to renderer JavaScript.
This keeps the browser out of the API request path, so no CORS preflight is
needed and the Node API's origin and bearer checks remain unchanged. The UI
does not display the token, raw tool commands, or absolute workspace paths.

## Collaboration issue surface (DAT-222)

This surface targets `main` at `52393c682393757d6619cbb9fc973a37cdb61eaa`
(DAT-221, OpenAPI `0.9.0`) and its merged captures under
`docs/fixtures/collab-api-v1/` plus `docs/fixtures/identity-api-v1/workspace-page.json`.
Every fixture field comes from those captures or from
`web/src/api/contracts/openapi.json`; no field is invented by the UI.

| Endpoint                                                         | Request fields                                                                      | Response type                       | Status |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| `GET /api/v1/workspaces?cursor=`                                 | optional `cursor` (all pages are read)                                              | `{items: Workspace[], next_cursor}` | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues`                   | path `workspace_id`; optional `product_state`, `cursor`                             | `{items: Issue[], next_cursor}`     | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}`        | path `workspace_id`, `issue_id`                                                     | `Issue`                             | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stage`  | path `workspace_id`, `issue_id`                                                     | `IssueStage`                        | ✅     |
| `POST /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stage` | `to`, optional `reason`, optional `disposition.reference`; `Idempotency-Key` header | `IssueStage`                        | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks`  | path ids; `cursor` (every page is read)                                             | `{items: IssueTask[], next_cursor}` | ✅     |
| `POST …/issues/{issue_id}/tasks/{task_id}/state`                 | `to`; `Idempotency-Key` header                                                      | `IssueTask`                         | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs`   | path ids; `cursor` (every page is read)                                             | `{items: IssueRun[], next_cursor}`  | ✅     |
| `GET …/issues/{issue_id}/runs/{run_id}`                          | path ids                                                                            | `IssueRun`                          | ✅     |
| `GET /api/v1/workspaces/{workspace_id}/issues/{issue_id}/stream` | path ids; optional `Last-Event-ID` header                                           | SSE `IssueEvent` envelopes          | ✅     |

Scope boundaries:

- **Product and harness states are separate.** `Issue.product_state` /
  `IssueStage` render as "Product stage"; `IssueRun.state` renders as
  "Harness". Each axis has its own labels and copy. `awaiting_change_approval`
  says a frozen candidate awaits human change approval and no remote branch or
  PR exists; harness `awaiting_review` is only the observed dsh state of one
  run. Neither is derived from the other.
- **Disposition is an explicit entry.** A stage transition to
  `needs_human` or `cancelled` requires a reason; leaving `needs_human`
  requires a `disposition.reference`. The UI only offers
  `IssueStage.allowed_transitions`, never an inferred edge. A stopped,
  timed-out, expired, rejected, or cancelled run is rendered as an outcome
  with its stop reason; the surface offers no resume/retry affordance and
  states that continuation needs a new bounded run and a recorded disposition.
- **Lists are complete.** Child tasks and runs are read through every
  `next_cursor` page, so dependency state and stop outcomes are not limited to
  the first page.
- **Replay is idempotent.** The stream is opened without an anchor first (the
  service replays the retained log), then reconnects with the newest delivered
  `event_id`; the anchor advances on every delivered frame, including when the
  connection fails before the stream call returns. Events are deduplicated on `event_id`, ordered by `sequence`,
  and a detected sequence hole triggers a full replay without an anchor.
  Unknown event types and unknown stage/run/task states render explicitly
  instead of being mapped or dropped.
- **Scope and roles.** Workspace ids come from `GET /api/v1/workspaces`, and
  only archive-free workspaces are offered. `viewer` renders the surface
  read-only: stage transitions are disabled and task state controls are
  hidden. The service remains the authority for every check.
- The run worktree is shown by `worktree_id` only; the absolute `worktree.path`
  is never rendered. Handoffs are the run's `head_sha` and immutable
  `artifact_refs`; the surface shows those references and never fetches or
  invents raw memory.
- The Node service in this baseline exports the collaboration contract but does
  not yet route `/api/v1/workspaces/{workspace_id}/issues`; a 404 therefore
  renders as an explicit "no issue workspace available" state rather than an
  empty issue list. Candidate review, approvals, and delivery remain DAT-223's
  surface and are not implemented here.

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
