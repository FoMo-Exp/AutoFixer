# ADR 0003: Pi orchestration with dsh control contracts

**Status:** Accepted

## Context

AutoFixer currently provides an offline Go CLI composed from `harness`,
`sandbox`, `delivery`, and deterministic planning. ForgePilot requires a
product workflow: a desktop UI, a TypeScript application service, a Pi Agent
SDK runtime, durable task views, and eventually a human-reviewed pull request.

Replacing the Go security boundary would duplicate tested risk, capability
grant, sandbox, event-chain, and protected-delivery controls while changing
the runtime. Pi's built-in tools run with the operating-system permissions of
the embedding process, so treating Pi as the authority would weaken the
least-privilege model.

## Decision

Keep Go dsh as the execution authority. Add a local TypeScript/Node
orchestration layer which embeds Pi Agent SDK, and later an Electron/React
client which calls only Node's public API.

```
Electron/React -- forgepilot-api/v1 --> Node + Pi -- dsh-control/v1 --> Go dsh
                                                    |                    |
                                                    |                    +-- risk/grants/sandbox/audit/delivery
                                                    +-- no direct shell, git credential, or merge authority
```

The two normative contracts are:

- [`dsh-control-v1`](../contracts/dsh-control-v1.md), for Node to Go dsh.
- [`forgepilot-api-v1`](../contracts/forgepilot-api-v1.md), for Node to UI.

`dsh-control/v1` is local-only HTTP/JSON over a Unix Domain Socket or Windows
Named Pipe. It requires an ephemeral boot token and has no TCP listener. It is
not a public API.

Pi default terminal and file-edit tools are disabled. Node exposes only an
`dsh_request_action` tool; each call contains a registered `tool_id` and
structured arguments. dsh maps it to the actual runner only after independent
allow-list, risk, capability-grant, path, network, and state checks.

## Consequences

- Node, Pi, and UI are not trusted to issue grants, classify risk, execute raw
  shell, read provider credentials, alter audit events, or merge pull requests.
- dsh is the fact source for run state, policy decisions, immutable evidence,
  patch reports, and approval snapshots. Node may persist projections only.
- A dsh execution failure is represented by an auditable terminal run and
  evidence bundle, not merely an HTTP error.
- The UI may begin only after `forgepilot-api/v1` is generated from the Node
  implementation and merged into `main`.
- A changed head SHA invalidates every prior QA, check, discussion, and
  approval observation for that head.

## Migration plan

| Milestone | Tracking issue | Deliverable and dependency |
| --- | --- | --- |
| M1 | [DAT-186](mention://issue/01a177f1-52ad-71fe-b403-8c6f0822534b) / AFP-09 | Add the dsh control server without changing existing CLI semantics; depends on this ADR. |
| M2 | [DAT-187](mention://issue/01a177f1-58c9-77b0-8c0c-a0bcb8d556f6) / AFP-10 | Add Node/Pi orchestration and the minimal product API; depends on M1. |
| M3 | [DAT-188](mention://issue/01a177f1-5eae-7043-96bf-7b3025d206dd) / AFP-11 | Add durable projections and SSE replay; depends on M2. |
| M4 | [DAT-189](mention://issue/01a177f1-67bf-79c0-a1ea-c109a0ee1a70) / AFP-12 | Add Electron/React on the merged OpenAPI baseline; depends on M2 and M3. |
| M5 | [DAT-190](mention://issue/01a177f1-6dab-722c-ace7-0c852b7e88f2) / AFP-13 | Validate a real protected PR in an isolated repository before any claim of production readiness; depends on M3, M4, and the existing governance controls. |

The issue identifiers above are the required M1–M5 delivery links for this
decision. M4 consumes the generated `forgepilot-api/v1` from `main`; it must
not create a substitute UI contract or fixture.

## Rejected alternatives

**Full TypeScript rewrite of dsh.** It would create parity and security
regression risk for process cancellation, grant enforcement, redaction, digest
chains, and protected delivery before user-facing value exists.

**Allow Pi to use default shell tools.** This would make the Pi process's OS
permissions the effective execution policy and bypass dsh's independent gates.
