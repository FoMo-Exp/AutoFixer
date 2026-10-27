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
ephemeral loopback URL from the service startup line. It shuts down only the
child process it started. `FORGEPILOT_API_TOKEN_FILE` is passed through the
isolated preload bridge; the token is never written into the web bundle or
rendered in the UI. `VITE_FORGEPILOT_API_URL` and `VITE_FORGEPILOT_API_TOKEN`
are available for local browser development only.

The workbench reconnects its authenticated SSE stream with `Last-Event-ID`,
replays the durable timeline without duplicate events, and shows a visible
offline/reconnecting state while the Node service is unavailable.
