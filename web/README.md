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
split across events and cannot be safely classified mid-stream. Instead the
timeline shows a Pi summary derived only from contract-typed fields: one row per
contiguous Pi turn (update count and whether the turn settled) plus a task-wide
summary of turns, text updates, and action/validation outcomes. Every other
event keeps its own row, so actions and approvals appear between the turns that
produced them. Natural-language Pi output is never rendered; inspect the
redacted artifact view for the server-redacted detail.
