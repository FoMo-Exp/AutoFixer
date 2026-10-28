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
