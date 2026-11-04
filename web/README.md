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

A signed-in session enters one workspace at a time. `GET /api/v1/workspaces`
lists exactly the caller's live, active memberships; the sidebar switcher shows
the workspace name, its repository binding, and the server-computed role. The
choice is persisted per user as the non-sensitive locator
`fp-workspace:<user id>` and restored on reload: one accessible workspace is
selected automatically, several require an explicit choice, and a workspace
that disappears from the live list is cleared (back to the chooser, or the
single remaining workspace, or the "no workspace access" gate).

Every task call — list, create, detail, runs, messages, approvals, cancel,
archive/recover, timeline, artifact, and the SSE stream — uses the
`/api/v1/workspaces/{workspace_id}/tasks...` family of the selected workspace.
Switching closes the previous stream and loads the new workspace's tasks. A
`404 NOT_FOUND` from the scoped family re-reads the membership list. Viewer
roles get a read-only surface; the server remains the authority, and a
client-supplied workspace id is never treated as proof of access.

A 401 from the task surface drops the credential and shows the recoverable
"session expired" sign-in screen. A 403 keeps the session and reports a
dismissible permission banner; a revoked membership surfaces as the
"no workspace access" gate.

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
