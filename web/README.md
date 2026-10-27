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
silently retrying an unusable service.

The Electron window smoke starts an isolated real dsh and Node service, opens
the production `BrowserWindow` with the packaged preload and `file://` assets,
then verifies REST and SSE through the renderer IPC bridge. It also checks the
missing-base-SHA startup guidance. Build the Node service first:

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

Raw Pi text deltas are hidden as they arrive because a secret or command can
be split across events and cannot be safely classified mid-stream. The timeline
shows a fixed safety summary; inspect the redacted artifact view for details.
