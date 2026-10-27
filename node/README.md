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

| Variable                                                | Default                              | Meaning                                                 |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `FORGEPILOT_DSH_SOCKET`                                 | `$TMPDIR/dsh-<uid>/dsh-control.sock` | dsh control socket (or pipe name)                       |
| `FORGEPILOT_DSH_TOKEN_FILE`                             | `<socket>.token`                     | dsh boot-token file                                     |
| `FORGEPILOT_API_HOST` / `FORGEPILOT_API_PORT`           | `127.0.0.1` / `0`                    | loopback bind                                           |
| `FORGEPILOT_REPOSITORY_ID`                              | `github:Luthiel/AutoFixer`           | only the pilot repository is accepted                   |
| `FORGEPILOT_BASE_REF` / `FORGEPILOT_BASE_SHA`           | `main` / required                    | pinned base revision                                    |
| `FORGEPILOT_ACTOR_ID` / `FORGEPILOT_ACTOR_DISPLAY_NAME` | local operator                       | identity recorded on runs                               |
| `FORGEPILOT_APPROVER_IDENTITY`                          | `github:local-operator`              | must match a dsh `--approver`                           |
| `FORGEPILOT_PATH_HINTS`                                 | `node`                               | comma-separated granted path roots                      |
| `FORGEPILOT_TOOL_CAPABILITIES`                          | `echo,sleep`                         | dsh tools tasks may request                             |
| `FORGEPILOT_MAX_WALL_CLOCK_SECONDS`                     | `120`                                | per-run wall clock                                      |
| `FORGEPILOT_API_TOKEN_FILE`                             | `$TMPDIR/forgepilot-<uid>/api-token` | per-process API bearer-token file (0600)                |
| `FORGEPILOT_PI_PROVIDER` / `FORGEPILOT_PI_MODEL`        | unset                                | Pi model; unset means approvals report `PI_UNAVAILABLE` |

Provider API keys are resolved by pi-ai from the usual environment variables
(for example `ANTHROPIC_API_KEY`).

## Authentication and origin guards

Every `/api/v1` request must present the per-process bearer token:

```sh
curl -H "Authorization: Bearer $(cat $TMPDIR/forgepilot-<uid>/api-token)" ...
```

Possessing that token — not a statically configured identity string — is what
authorizes a caller to act as the local operator, approvals included. The
token is minted fresh at every start, written 0600 to a user-private file
(the same pattern dsh uses for its boot token), and read out of band by the
operator or UI. A random local process cannot impersonate the operator without
reading that file. Additionally:

- `FORGEPILOT_API_HOST` must be a loopback address (`127.0.0.1`, `localhost`,
  `::1`); the config refuses a non-loopback bind.
- Browser-originated calls are pinned to this server's own loopback `Origin`,
  and request bodies must be `application/json`, so a cross-site page cannot
  ride a simple `text/plain` request.

## Declared work and risk

Node never classifies risk. The `forgepilot-api/v1` create body carries no
authenticated, structured risk facts (only free-text summary and criteria
strings, which are attacker-influencable), so Node declares **no** positive
low-risk signal. dsh's `AssessRisk` then fails every task closed to
`elevated`, and each one requires the pre-grant human approval
(`POST /api/v1/tasks/{id}/approvals` with the `scope_digest` from the
`approval.required` event). A low-risk fast path may return only when the API
contract grows explicit, authenticated risk declarations that dsh can bind to
the grant — never inferred from free text or criteria presence.

## API contract

`web/src/api/contracts/` is generated from this implementation:

```sh
npm run export:openapi
```

- `openapi.json` — the OpenAPI 3.1 document.
- `schema.d.ts` — the generated TypeScript client types (openapi-typescript).

Two tests guard the baseline: a drift test fails when the committed files and
a fresh generation disagree, and an independent conformance test parses the
normative [forgepilot-api-v1](../docs/contracts/forgepilot-api-v1.md)
markdown itself — endpoints, the 13 SSE event types, and the UI status enum —
so the implementation and its own export cannot drift away from the contract
together.
