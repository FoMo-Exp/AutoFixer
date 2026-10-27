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

For an Electron launch, configure the ephemeral Node service through
`FORGEPILOT_API_URL` or `FORGEPILOT_API_PORT` and provide
`FORGEPILOT_API_TOKEN_FILE`. The preload reads the token into an isolated
renderer bridge; the token is never written into the web bundle or rendered in
the UI. `VITE_FORGEPILOT_API_URL` and `VITE_FORGEPILOT_API_TOKEN` are available
for local browser development only.

The workbench reconnects its authenticated SSE stream with `Last-Event-ID`,
replays the durable timeline without duplicate events, and shows a visible
offline/reconnecting state while the Node service is unavailable.
