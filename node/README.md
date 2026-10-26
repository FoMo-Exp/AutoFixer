# ForgePilot orchestrator (Node + Pi)

TypeScript service that replaces the prototype's deterministic planner with a
Pi Agent SDK session and exposes the minimal `forgepilot-api/v1` product API.
See [ADR-0003](../docs/adr/0003-pi-orchestration-and-dsh-control-contract.md)
for the authority model and
[forgepilot-api-v1](../docs/contracts/forgepilot-api-v1.md) /
[dsh-control-v1](../docs/contracts/dsh-control-v1.md) for the two contracts.

## Authority boundary

- **dsh is the fact source** for risk, capability grants, execution, and
  evidence. This service never classifies risk, never grants capabilities, and
  never executes tools.
- **Pi holds exactly one tool**, `dsh_request_action`, which forwards a
  structured action intent to dsh over the local control plane. Pi's default
  terminal and file-edit tools are not loaded; the agent loop runs with only
  the registered tool, and dsh re-checks every intent against the run's
  allow-list and capability grant before anything executes.
- **The UI calls only this service**, at an ephemeral loopback address. It
  never sees dsh sockets, boot tokens, Pi credentials, or provider
  credentials.

A denied intent is returned to the model as an error result and recorded on
the task timeline (`tool.denied`); the authoritative run state is re-read from
dsh, so refusals, stop conditions, timeouts, and expiries surface in Node task
status instead of being invented locally.

## Development

```sh
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest: unit + integration against the real Go dsh
```

The integration tests build the Go `autofixer` binary and start a private
`dsh serve` on a temporary UDS, so the Go toolchain must be on `PATH`. Only
the model stream is scripted; the Pi agent loop, tool validation, dsh
control plane, allow-list, grants, sandbox execution, stop conditions, and
timeouts are the real implementations.

Known polyglot quirk: after `npm install`, `go test ./...` from the repository
root also scans `node/node_modules` (it compiles; no test files). On a clean
checkout without `npm install` the Go suite is unaffected.

## Running

```sh
export FORGEPILOT_BASE_SHA=<pinned base commit>
npm run build && npm start
```

Configuration (environment):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORGEPILOT_DSH_SOCKET` | `$TMPDIR/dsh-<uid>/dsh-control.sock` | dsh control socket (or pipe name) |
| `FORGEPILOT_DSH_TOKEN_FILE` | `<socket>.token` | dsh boot-token file |
| `FORGEPILOT_API_HOST` / `FORGEPILOT_API_PORT` | `127.0.0.1` / `0` | loopback bind |
| `FORGEPILOT_REPOSITORY_ID` | `github:Luthiel/AutoFixer` | only the pilot repository is accepted |
| `FORGEPILOT_BASE_REF` / `FORGEPILOT_BASE_SHA` | `main` / required | pinned base revision |
| `FORGEPILOT_ACTOR_ID` / `FORGEPILOT_ACTOR_DISPLAY_NAME` | local operator | identity recorded on runs |
| `FORGEPILOT_APPROVER_IDENTITY` | `github:local-operator` | must match a dsh `--approver` |
| `FORGEPILOT_PATH_HINTS` | `node` | comma-separated granted path roots |
| `FORGEPILOT_TOOL_CAPABILITIES` | `echo,sleep` | dsh tools tasks may request |
| `FORGEPILOT_MAX_WALL_CLOCK_SECONDS` | `120` | per-run wall clock |
| `FORGEPILOT_PI_PROVIDER` / `FORGEPILOT_PI_MODEL` | unset | Pi model; unset means tasks report `PI_UNAVAILABLE` |

Provider API keys are resolved by pi-ai from the usual environment variables
(for example `ANTHROPIC_API_KEY`).

## Declared work and risk

Node never classifies risk; it declares facts and dsh classifies
independently:

- a task **with** acceptance criteria declares a localized reversible change
  (low-risk path);
- a task **without** acceptance criteria declares material uncertainty and
  fails closed to elevated, which requires the pre-grant approval
  (`POST /api/v1/tasks/{id}/approvals` with the `scope_digest` from the
  `approval.required` event).

## API contract

`web/src/api/contracts/openapi.json` is generated from this implementation:

```sh
npm run export:openapi
```

The openapi drift test fails when the committed file and the implementation
disagree, so the UI milestone always consumes a baseline that matches `main`.
