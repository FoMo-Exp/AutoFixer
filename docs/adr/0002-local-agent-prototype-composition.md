# ADR 0002: Local Agent Prototype Composition

**Status:** Accepted

**Date:** 2026-10-23

## Context

The existing `harness`, `sandbox`, and `delivery` packages already establish
the authority boundary for a remediation run. `harness` owns capability grants,
policy decisions, state transitions, and append-only execution evidence.
`sandbox` executes a policy-approved invocation in a one-time credential-free
workspace. `delivery` validates the evidence bundle and is the only existing
boundary for branch and pull-request adapters.

The prototype needs a local Go CLI that can demonstrate one controlled
end-to-end remediation task without turning planning, registration, or CLI
convenience code into a second policy or execution path.

## Decision

The prototype is a local, dependency-injected composition root with a single
golden task: a controlled task input is assessed and planned, each planned
allow-listed action is dispatched through the existing policy and sandbox
boundary, and the terminal run yields a patch report plus evidence bundle.
The CLI is not an authority boundary and no new package may widen a capability
grant or invoke a host command directly.

### Package ownership and stable seams

| Package | Owns | Stable boundary | Must not own |
| --- | --- | --- | --- |
| `cmd/autofixer/` | Argument parsing, command selection, dependency composition, process exit/output formatting | Builds a `loop.Runner` from explicitly supplied dependencies; maps a terminal result to JSON or human-readable output | Policy, planner logic, tool execution, session persistence, or provider credentials |
| `agent/loop/` | One task attempt's orchestration, cancellation/timeout propagation, terminal result assembly | Accepts controlled task input plus planner, registry, session/event recorder, and adapters as interfaces; returns a terminal result | Grant-policy reimplementation, direct `os/exec`, direct GitHub/provider calls, or mutable audit records |
| `agent/planner/` | Validates and produces a deterministic structured action plan from controlled task input | A plan contains only declarative action requests and an explicit no-action/rejection result; the initial implementation is a deterministic fake planner | Tool lookup, capability decisions, execution, network/model calls, or delivery |
| `agent/tools/` | Immutable tool registrations and conversion of a registered planned action into the request understood by the loop | Registry lookup is allow-list-only and rejects unknown, malformed, or risk-incompatible actions before dispatch | Executing commands, granting permission, or bypassing `harness.Run.EvaluateAndRecordAction` and `sandbox.Runner.Execute` |
| `agent/session/` | In-process task/session index and immutable task metadata | Lookup by task ID and final session snapshot | Raw secret/tool output retention, policy evaluation, or event ordering authority |
| `agent/events/` | Append-only, ordered application timeline and references to harness evidence | Records application events and immutable references to `harness.ExecutionEvent` records; exports a task timeline | Copying/replacing the harness audit log, mutating past events, or executing actions |

`harness/`, `sandbox/`, and `delivery/` remain authoritative and are not
modified for this composition. The loop obtains execution only by calling
`sandbox.Runner.Execute`; that call evaluates and records the action through
the harness. The loop may ask `delivery` to validate and assemble a
`delivery.EvidenceBundle`. A branch push or PR operation remains possible only
through the existing protected delivery adapter and only when the current
capability grant permits it; the golden task uses no real provider write.

### Golden-task lifecycle

1. `cmd/autofixer run` accepts only controlled, local task input and creates a
   task/session record.
2. `agent/loop` creates the existing harness run and records a plan event.
3. `agent/planner` returns a deterministic structured plan; `agent/tools`
   resolves every action against the immutable allow-list.
4. For every resolved action, the loop requests dispatch through
   `sandbox.Runner.Execute`. A denial, expiry, cancellation, timeout, failed
   audit append, or invalid plan is terminal; no fallback execution is allowed.
5. The loop records application timeline references to the authoritative
   harness evidence and asks `delivery` to construct the patch report/evidence
   bundle. The demo may produce a `not_created` report; a patch/report outcome
   must still be bound to the terminal evidence chain.
6. The CLI prints the terminal result and references. It neither merges nor
   declares a pull request merge-eligible.

### Safety constraints

- Initial operation is local CLI only. There is no UI, remote planner, model
  provider, background service, deployment, secret management, or new network
  capability.
- Unknown tools, arguments, paths, destinations, and mutation intents are
  denied by default. Registry acceptance is additional validation, never a
  substitute for the harness grant check.
- Session and application events contain references, redacted summaries, and
  identifiers only. The canonical execution record remains the harness event
  chain; raw credentials and raw sensitive output are never copied into the
  new packages.
- Cancellation and timeout are propagated via `context.Context`; cleanup and
  credential revocation remain the sandbox/harness responsibility.

### Implementation boundaries

The work is deliberately split so these changes can be developed in parallel
from `main` and integrated by AFP-05 only after the ADR is merged:

| Work item | Writable surface | Dependency |
| --- | --- | --- |
| AFP-02 | `cmd/autofixer/`, `agent/loop/` | This ADR; use injected interfaces only |
| AFP-03 | `agent/planner/`, `agent/tools/` | This ADR; no loop/session/base-package edits |
| AFP-04 | `agent/session/`, `agent/events/` | This ADR; no loop/planner/base-package edits |
| AFP-05 | Composition root and end-to-end tests needed to wire the prior seams | AFP-02, AFP-03, and AFP-04 merged into `main` |

## Consequences

The first prototype is intentionally narrow but independently testable: each
new package can be tested with fakes while the existing security controls are
exercised only through their published APIs. This adds small adapter interfaces
and an application timeline, but prevents duplicate policy, unaudited command
execution, and accidental expansion of provider authority. Expanding beyond a
local deterministic prototype requires a separate ADR that explicitly evaluates
the changed authority, data-retention, and network boundaries.
