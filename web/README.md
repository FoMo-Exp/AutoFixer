## ForgePilot Workbench

The `web/` package is the Electron + React operator workbench for the
ForgePilot Node service. It calls only the loopback `forgepilot-api/v1`
contract in `src/api/contracts/`.

```sh
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

## Enterprise sign-in and workspace scope

Browser and desktop share one authentication gate. A session token never enters
a URL, referrer, `localStorage`, or renderer JavaScript.

- **Browser (cookie session).** The page lists `GET /api/v1/auth/providers`,
  navigates to `GET /api/v1/auth/login` with the chosen provider instance id and
  a relative `return_to`, and reads `GET /api/v1/auth/session` after the
  callback. The session lives in the HttpOnly `fp_session` cookie; mutating
  requests echo the session's CSRF token in `X-CSRF-Token`. A rejected CSRF
  token is refreshed once from the session endpoint and the request retried
  once. Browser mode requires the workbench to be served from the API's own
  loopback origin (the OAuth callback redirects there and the cookie is scoped
  to it); it is not available from the cross-origin Vite dev server.
- **Desktop (system browser).** Electron main creates
  `POST /api/v1/auth/desktop/flows`, opens the returned `login_url` with the
  operating system browser, and polls the single-use
  `/desktop/flows/{flow_id}/exchange` until the browser completes sign-in. The
  flow secret and the resulting bearer token stay in the main process; the API
  proxy attaches the token per request. The token is held in memory only, so a
  workbench restart requires signing in again.
- **Legacy local-operator mode.** When the Node service has no identity
  subsystem (`GET /api/v1/auth/providers` returns 404), the workbench keeps the
  launch-time local-operator bearer token path.

The workbench deliberately has no workspace switch yet. `GET/POST /api/v1/tasks`
take no workspace selector, and Node resolves session authority against one
configured workspace (`AuthService.workspaceRole`). Relabeling tasks from
another membership would therefore show the same data under a different name —
a false affordance. Real switching needs a workspace-scoped task contract and
server enforcement first; until then the session's `memberships` only decide
the "no workspace access" gate. A client-supplied workspace id is never treated
as proof of access.

A 401 from the task surface drops the credential and shows the recoverable
"session expired" sign-in screen. A 403 keeps the session and reports a
dismissible permission banner; a revoked membership surfaces as the
"no workspace access" gate.

## Issue workbench

The **Issues** surface tracks a workspace's product issues, child tasks,
bounded runs, and durable event log. It is workspace-scoped: the workspace
list comes from `GET /api/v1/workspaces`, and only active memberships are
offered. A credential without an identity workspace (legacy local-operator
mode) sees an explicit unavailable state instead of an empty list.

- **Product stage ≠ harness state.** `product_state` (triage → planning →
  implementing → validating → awaiting_change_approval → delivering →
  pr_review → completed) is the product lifecycle. A run's `state`
  (`requested`, `running`, `awaiting_review`, `stopped`, …) is what dsh
  observed for that bounded run. `awaiting_change_approval` means a frozen
  candidate awaits human change approval and no PR exists; harness
  `awaiting_review` is a different axis and never sets the product stage.
- **Disposition entry.** Moving to `needs_human` or `cancelled` requires a
  reason. Leaving `needs_human` requires a human disposition reference bound
  to the authenticated caller. Only the service-reported
  `allowed_transitions` are offered. A stopped or otherwise exhausted run is
  shown as an outcome with its stop reason; there is no resume button, because
  continuing needs a fresh bounded run and grant.
- **Complete lists.** Child tasks and runs are read through every cursor page,
  so dependency state and every stop outcome are present even when the
  service paginates them.
- **Replay-safe timeline.** The workbench reads the retained log from
  `…/stream`, advances its `Last-Event-ID` anchor as each frame arrives, and
  reconnects from that anchor after a network error. It deduplicates on
  `event_id`, orders on `sequence`, and repairs a detected sequence hole with
  a full replay. Unknown event types and unknown enum values are labelled as
  unknown.
- **Evidence boundaries.** Run cards show `worktree_id` (never the absolute
  path), grants, scope, limits, stop reason, and handoff evidence
  (`head_sha` plus immutable artifact references). Candidates, approvals, and
  delivery operations belong to the separate candidate-review surface.

`viewer` memberships render read-only: stage transitions are disabled and task
state controls are hidden. The service still enforces every authorization
check.

## Bounded RSI surface

The **RSI** surface reviews self-improvement proposals and the workspace
controls that bound them. It is workspace-scoped and needs the `member` role:
a viewer sees an explicit role gate instead of an empty list, and no read is
issued. Proposal titles, targets, diffs, evaluations, approvals, rollouts, and
observations come from the DAT-238 RSI contract (OpenAPI `0.9.0`).

- The server runs the replay. A caller selects the golden set and hidden
  holdout; metrics, a verifier claim, and evidence text are refused. The
  verdict, per-arm samples, delta, confidence interval, approval keys, budget
  state, and canary eligibility are rendered exactly as stored. `inconclusive`
  reads as a refusal, never a pass.
- The hidden holdout is aggregate-only. The status card shows its case count and
  last evaluation time; an evaluation row shows aggregate samples and a
  `holdout_used` flag. No holdout case content is returned by the contract, and
  none is displayed or reconstructed.
- The risk ladder maps the target class to its approval gate: A automatic only
  when enabled, otherwise one named human; B one named human; C two humans with
  the owner and reviewer keys; D rejected by the loop. A proposer is never
  offered evaluation or approval of its own proposal.
- Owners start the 10% canary, record a stage observation (samples are derived
  from pinned runs), roll back, change controls, or engage and release the
  kill switch. Admins approve. Engaging the kill switch requires a reason and
  stops the loop in the same call; the form only lowers budgets and never
  raises the fixed sample or regression ceilings.
- Rollback requires a reason, which is rendered with the ended rollout.
  Historical run pins and prior evaluations are never rewritten.
- A regression, a failed dataset verdict, or a forbidden-item injection is
  surfaced as a prominent warning above the gate; the raw evaluation table
  stays available underneath.

## Provider account binding (settings)

The workbench Settings dialog binds GitHub or GitLab accounts so the task
composer can offer discovered repositories and branches alongside the
free-text inputs (which are always kept as a "Custom…" option).

- Account tokens are entered in the renderer but never stored there: the
  main process verifies the token against the provider, then persists
  `{ account id, provider, instance origin, login }` plus the token in
  `<userData>/provider-accounts.json` (0600, atomic replace). No IPC
  response ever contains a token.
- Discovery runs in the main process (`electron/git-providers.ts`): GitHub
  via `api.github.com` (or `<host>/api/v3` for Enterprise), GitLab via
  `<origin>/api/v4` with optional self-hosted instance origins (https,
  origin-only). Every request is pinned to the API origin derived from the
  bound instance, so a crafted repository name cannot redirect a token.
- The renderer sees only renderer-safe projections: account ids/logins,
  repository ids (`github:owner/repo`, `gitlab:group/sub/project`), and
  branch names.
- Settings IPC channels (`forgepilot:settings:*`) reuse the API proxy's
  trusted-sender guard: only the app window's top frame may call them.
- Without the Electron bridge (plain-browser dev), settings and the
  pickers degrade to free-text input instead of failing.

The workbench only _selects_ `repository_id`/`base_ref`; the Node service
and dsh keep their existing governance over which repositories and refs a
task may target. The credential boundary for this feature is recorded in
[ADR-0004](../docs/adr/0004-workbench-provider-credential-boundary.md).

## Orchestrator model settings

The Electron Settings dialog includes Xiaomi MiMo and the other built-in Pi
providers. Provider and API base URL share an equal-width row; API key and
Model ID share the row below. Selecting a provider fills its default endpoint;
OpenAI-compatible leaves the endpoint blank for a local or HTTPS server.
The API key is encrypted with Electron `safeStorage` in the app's user-data
directory; it is never returned to renderer JavaScript. The main process passes
it only to the local Node orchestrator child and restarts ForgePilot after a
model configuration is saved or removed. In a plain browser the model settings
are unavailable.

Registered models retain their Pi metadata. Newly discovered models use the
selected provider's protocol at the configured endpoint, with conservative
token limits. OpenAI-compatible endpoints use the OpenAI Chat Completions
protocol.

The **Test connection** button probes the current form values before saving.
It reads the endpoint's model catalogue without requiring a Model ID, then
turns the Model ID field into the shared dropdown. Anthropic and Gemini
pagination and provider-specific authentication are supported. Editing the
provider, endpoint or key invalidates the old catalogue. A failed discovery
keeps manual Model ID entry available. Leaving the API key blank reuses the
saved key for the same provider; an entered key is used for that test. The
request times out after 20 seconds and returns only model IDs and safe status
messages; it does not save settings or restart the app. Xiaomi discovery uses
its [official model-list endpoint](https://mimo.mi.com/docs/en-US/api/model/list-models).

For an Electron launch, the main process first checks the configured
`FORGEPILOT_API_URL` / `FORGEPILOT_API_PORT`, then an optional
`FORGEPILOT_API_DISCOVERY_FILE`, and finally starts the local Node entrypoint
(`node/dist/src/index.js`, or `FORGEPILOT_NODE_ENTRY`) and discovers its
ephemeral loopback URL from the service startup line. It uses the `node`
executable from `PATH` to start that entrypoint; set
`FORGEPILOT_NODE_EXECUTABLE` when Node is installed elsewhere. It shuts down
only the child process it started. The Electron renderer sends API calls over
a restricted IPC bridge; the main process adds the bearer token and performs
the HTTP request, so browser CORS preflight is not involved and the token is
never exposed to renderer JavaScript. `VITE_FORGEPILOT_API_URL` and
`VITE_FORGEPILOT_API_TOKEN` are for direct local browser development only; for
development with the Node API, open the Vite server through Electron so the
IPC bridge is active.

The default Node auto-start requires `FORGEPILOT_BASE_SHA`, a 7–40 character
hexadecimal commit id for the repository base. If it is missing, the
workbench displays this setting in an actionable startup error instead of
silently retrying an unusable service. When the Node entrypoint itself is
missing (for example on a fresh checkout that has not run
`cd node && npm run build`), the startup error names the build command and the
`FORGEPILOT_NODE_ENTRY` / `FORGEPILOT_API_URL` / `FORGEPILOT_API_PORT` /
`FORGEPILOT_API_DISCOVERY_FILE` settings that point at a built or existing
service.

The Electron window smoke also opens the window without a configured API URL
so the main process must launch Node itself and discover the published
loopback URL, then checks the missing-base-SHA and missing-entrypoint startup
guidance. Build the Node service first:

```sh
cd node && npm run build
cd ../web && npm run build && npm run test:electron-window
```

If Electron is installed outside this package's local binary path, set
`ELECTRON_BINARY` to its executable for the window smoke. The faster
`npm run test:electron-node` transport-only check remains available too.

The workbench reconnects its authenticated SSE stream with `Last-Event-ID`,
replays the durable timeline without duplicate events, and shows a visible
offline/reconnecting state while the Node service is unavailable.

Raw Pi text deltas are hidden as they arrive because a secret or command can be
split across events and cannot be safely classified mid-stream; the workbench
strips them before they enter UI state and never renders them. Pi text is read
only from the contract's fail-closed `pi_summary` projection (`Task.pi_summary`
and `pi.summary.updated` events), which the workbench renders as a state card:
`pending`, `available`, or `unavailable` with its reason code. Unknown reasons
and unknown statuses render as a plain unavailable state.

Contract `0.5.0` (DAT-193) makes the validated structured
`report_turn_summary` report — rendered by Node in fixed wording — the only
displayable Pi source, and withholds free model text as `untrusted_source`.
This build still withholds `pi_summary.text` for `available` summaries: the
payload carries no provenance or schema-version discriminator, recorded
history is never rewritten, and a summary settled before DAT-193 stays
`available` with arbitrary free-model text (the earlier boundary exposed
`node app succeeded.`). A client cannot prove which `available` summaries
came from the trusted report channel, so the card shows the state and reason
and never the text; provenance is not inferred from wording. The card states
this and the required contract addition is recorded in `CONTRACT.md`.

Summary resolution fails closed elsewhere too: the task projection wins over
timeline events that are not newer than `Task.version`, and a summary is used
only when its `task_id` matches and its `run_id` equals the task's
`current_run_id` — missing identity, a task without a current run, and a
previous run all yield no summary. See `CONTRACT.md` for the exact rules.

## Workspace administration and invitations

The topbar **Workspaces** entry opens the identity surface when the session
reports a workspace membership or enterprise role. It lists the workspaces the
server resolved for this caller and shows members with their effective role and
provider-role provenance (`MemberAuthority`), teams with their active leader
and responsibility, and owner/admin invitations. Mutating controls (role
changes, removal, team create/update/delete, invitation create/revoke) appear
only for workspace owners/admins or enterprise administrators; every request is
still authorized server-side, and a denial renders the envelope's message,
next action, and `request_id` as the support case reference. Enterprise
administrators also get the secret-free auth audit trail for the workspace's
enterprise.

Creating an invitation returns the only copy of the bearer token: the dialog
shows a QR encoding `invite_url` plus a grouped copyable code and drops both
when closed. Listed invitations are token-free. An invite link carries the
token in the URL fragment; the landing page captures it, clears the fragment
with `history.replaceState` before issuing any request, and shows the
join-confirmation screen only after an authenticated `POST
/api/v1/invitations/preview`. Nothing is consumed until the operator presses
**Join workspace**, which calls `POST /api/v1/invitations/redeem`; every
non-consumable state is the contract's single `INVITATION_NOT_ACCEPTED`
denial. A sign-in round trip keeps the token in `sessionStorage` only for the
length of that redirect and removes it on return.

Cookie-authenticated deployments need the session's CSRF echo: after `GET
/auth/session` the renderer attaches `X-CSRF-Token` to mutating requests, while
bearer-authenticated requests never send it. API requests opt into cross-origin
credentials so a loopback API on another port still receives `fp_session`;
Electron's IPC fetch ignores that field and keeps its bearer attachment in the
main process.
