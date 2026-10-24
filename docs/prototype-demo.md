# Prototype demo and developer use guide

This guide is the developer-facing entry point for the currently implemented
AutoFixer prototype. It describes what can be reproduced from this repository
today; it does not grant authority to run a remediation or to change a remote
repository.

The normative record shape is
[`task-evidence-contract-v1`](contracts/task-evidence-contract-v1.md). The
prototype applies that contract through the `harness`, `sandbox`, and
`delivery` Go packages, composed by the `autofixer` CLI.

## What is available now

The repository requires Go 1.25 (see `go.mod`). Its user-facing entry point is
the `autofixer` CLI, which runs one controlled task attempt offline: it
assesses risk, plans deterministically, dispatches only allow-listed tools
through the existing sandbox and harness policy, records an application
timeline, and emits a delivery evidence bundle. There is no task submission
endpoint or provider integration; operation is local CLI only.

Run the complete offline verification suite from the repository root:

```sh
go test ./...
```

The tests do not open a real pull request, modify `main`, or require a GitHub
credential. Sandbox fixture commands use local programs such as `/bin/sleep`
and `/bin/sh`; their grants declare no network destinations.

## The golden-task demo command

The single documented demo is the golden task, an embedded offline fixture.
It dispatches one allow-listed `echo hello` tool and produces a
`not_created` evidence bundle bound to the terminal event:

```sh
go run ./cmd/autofixer demo
```

Text output (from an observed local run):

```text
task_id: golden-localized-001
run_id: run-57b43e101582156e
outcome: completed
terminal_state: stopped
code: stop_local_review_required
reason: task completed locally; no pull request is bound, human disposition required
risk_class: low
risk_decision_code: risk_low_approved
actions_dispatched: 1
events: 5
timeline_events: 9
patch_status: not_created
evidence_references: 3
exit_code: 0
```

The same composition runs any controlled task input file. The fixture is also
a runnable input:

```sh
go run ./cmd/autofixer run --input cmd/autofixer/testdata/golden-task.json --format json
```

`--format json` emits the terminal `loop.Result`, the harness audit-event
summaries, the application `timeline`, and the full `evidence_bundle`.
`--timeout <duration>` overrides the input's task timeout. Commands and flags
were confirmed against the implemented `--help` surface and an observed local
run; the fixture lives at `cmd/autofixer/testdata/golden-task.json`.

### Command surface

```text
usage: autofixer run --input <task.json|-> [--format text|json] [--timeout <duration>]
       autofixer demo [--format text|json] [--timeout <duration>]
```

`run` reads the controlled task input from a file or stdin (`-`). `demo` runs
the embedded golden-task fixture. Exit codes map the terminal outcome:
`0` completed, `2` invalid input, `3` rejected (including prohibited risk and
illegal plans), `4` cancelled, `5` timed out, `6` stopped (including denial),
`1` control failure.

### What the composition wires

The CLI composes the seams defined by
[ADR 0002](adr/0002-local-agent-prototype-composition.md):

- `agent/planner`'s deterministic `FakePlanner` replays the input's scripted
  `plan`; `planner.Validate` refuses an illegal plan before dispatch.
- `agent/tools`' registry allow-list is a second, independent gate in front of
  the harness grant. The composition owns the allow-list (`echo hello`,
  `sleep 5`); the task input cannot widen it.
- Dispatch goes registry → `sandbox.Runner` → harness FP-03 policy inside the
  sandbox, so a tool must clear both gates.
- `agent/session` and `agent/events` record the application timeline: the
  immutable task input, the plan, and every state change and tool event
  mirrored from the authoritative harness evidence as typed references.
- `delivery` validates and assembles the evidence bundle. The local demo
  produces a `not_created` patch report bound to the terminal event and a
  `not_requested` approval snapshot with null head bindings.

## Sample task input

The following is a documentation template for the `task_input` record. It is
not a submitted task or a capability grant. Replace every illustrative ID and
timestamp, and replace `base_sha` with the exact commit selected for the real
run. The example uses the current `main` revision as a concrete base reference
only: `52081eaddca099967fd8be13b3060337fde50d3f`.

```json
{
  "contract_version": "1.0.0",
  "task_id": "demo-localized-001",
  "issue_id": "DEMO-1",
  "requested_at": "2026-10-23T14:00:00Z",
  "repository": {
    "url": "https://github.com/Luthiel/AutoFixer.git",
    "base_sha": "52081eaddca099967fd8be13b3060337fde50d3f"
  },
  "requested_work": {
    "summary": "Localized, reversible correction with a focused test.",
    "source_reference": "issue://DEMO-1"
  }
}
```

`task_input` identifies the requested work; it does not itself authorize a
tool, path, network destination, patch, pull request, or merge. A real run
also needs a matching risk assessment, and any allowed execution needs a
time-bounded capability grant. The full CLI input additionally declares the
capability grant scope and the scripted plan; see
`cmd/autofixer/testdata/golden-task.json` for a complete example.

## Reproducible offline narratives

Each command below runs an existing fixture in isolation. A passing test is
the expected result. The CLI fixtures retain evidence in an in-memory event
store and emit it on stdout; the package fixtures retain evidence for
assertions. The contract examples remain the inspectable serialized form.

| Narrative | Run | Expected terminal result and audit evidence |
| --- | --- | --- |
| Golden task end to end | `go run ./cmd/autofixer demo` | One allow-listed `echo hello` dispatch: `completed`/`stopped` with `stop_local_review_required`, 5 chained harness events, an application timeline, and a `not_created` evidence bundle. Offline; no provider write. |
| Illegal plan | `go test ./cmd/autofixer -run '^TestE2EIllegalPlanIsRejectedTerminal$' -count=1` | A plan step naming an empty tool is refused by `planner.Validate` before dispatch: `rejected`/`invalid_plan`, no dispatch counted, and a `not_created` bundle with a null grant. |
| Registry denial (unregistered tool) | `go test ./cmd/autofixer -run '^TestE2ERegistryDeniesUnregisteredTool$' -count=1` | The grant permits the tool but the allow-list does not: `denied`/`deny_tool_unregistered`, no dispatch, and no tool-invocation evidence — the second gate stopped it before any process ran. |
| Grant denial (out of grant) | `go test ./cmd/autofixer -run '^TestE2EHarnessDeniesOutOfGrantTool$' -count=1` | The registry permits the tool but the capability grant does not name it: `denied`/`stop_out_of_grant`, with harness evidence recording the refusal. |
| Prohibited request | `go test ./cmd/autofixer -run '^TestRunCommandRejectsProhibitedWork$' -count=1` | A prohibited secret-access assessment refuses grant issuance, ends terminal `rejected`, and retains a bundle with a `prohibited` risk class and a null grant. |
| Timeout during dispatch | `go test ./cmd/autofixer -run '^TestE2ETimesOutDuringDispatch$' -count=1` | A permitted `/bin/sleep 5` exceeds a one-second task timeout: `timed_out`, with an auditable bundle. |
| Cancellation during execution | `go test ./cmd/autofixer -run '^(TestE2ECancelDuringDispatch|TestCLISmokeCancel)$' -count=1` | A permitted sleep is cancelled (context cancel in-process, SIGINT at the binary level): terminal `cancelled` with an auditable bundle and no surviving sandbox workspace. |

For the lower-level state-machine and delivery-linkage coverage, run:

```sh
go test ./harness -run '^TestFullHappyPathToMerged$' -count=1
go test ./delivery -run '^(TestEvidenceBundleBindsEventsAndReferencesToCurrentHead|TestNotCreatedEvidenceBundleRequiresNullRevisionBindings)$' -count=1
```

Those tests confirm that a proposed patch's evidence is bound to its current
head and that a `not_created` outcome keeps all revision bindings explicitly
null.

## Expected evidence and report structure

A terminal run is represented by an `EvidenceBundle` with the records below.
All records use `contract_version: "1.0.0"`, and the task/run/repository/base
identifiers must agree across records.

| Record | Required developer-visible contents |
| --- | --- |
| `task_input` | `task_id`, `issue_id`, request time, repository URL, exact base SHA, work summary, and immutable source reference. |
| `risk_assessment` | Task/run linkage, assessor and time, `low`/`elevated`/`prohibited` class, decision code, policy version, rationale reference, and the explicit elevated-approval reference or `null`. |
| `capability_grant` | Present only when issued. It binds the same task/run/repository/base SHA to expiry, allowed paths, exact tool arguments, network allowlist, resource bounds, and patch/PR scope bits. |
| `execution_events` | Ordered, append-only records. Each includes identities, prior/resulting state, risk and policy values, repository/revision binding, redacted requested/actual tool data, scopes, result digest, decision/stop code, and SHA-256 chain fields. |
| `patch_report` | Explicit `not_created`, `prepared_no_pr`, `proposed`, or `merged` status; revision fields have status-specific null rules. Created patches include validation evidence and references; every report has a SHA-256 digest. |
| `approval_snapshot` | Observed QA, required checks, review discussions, two-person approval quorum, merge-queue eligibility, snapshot status, and evidence reference. Any patch revision requires every sub-observation to bind to the same current head. |

The top-level bundle also retains resolvable `evidence_references` and optional
`artifact_references`. For an outcome with no patch, use
`patch_status: "not_created"` and explicit `null` branch, head, and PR values;
the report must reference the terminal event. Never omit a known empty or
not-applicable value to imply it.

### Audit fields to check in each narrative

For all fixtures, inspect the test assertions and the contract for these
fields:

```text
contract_version, task_id, run_id, issue_id,
event_id, sequence, event_type, occurred_at,
prior_state, resulting_state, risk_class,
policy_version, capability_grant_version,
repository_url, base_sha, branch, head_sha, pr_id,
requested_tool, actual_tool, path_scope, network_scope,
exit_status, output_digest, artifact_digests,
approval_snapshot_ref, decision_or_stop_code,
previous_event_digest, event_digest, digest_algorithm
```

Tool arguments and retained tool output are redacted before they enter event
or report evidence. The cancellation fixture additionally expects an output
digest, the `execution_cancelled` decision code on the outcome and terminal
transition, and no surviving sandbox workspace.

## Refusal paths and prototype limits

The prototype fails closed when scope is absent or a request is outside the
grant. Its risk assessment classifies these requests as prohibited: secret
access, writes to `main`, CI/workflow edits, governance changes, package
publication, deployment, infrastructure alteration, and unapproved network
egress. It treats broad refactors, dependency or data-shape changes,
migrations, permission-sensitive work, and material uncertainty as elevated;
an elevated grant requires a recorded human approval that predates issuance.

At dispatch time, missing/revoked/expired grants and mismatched repository,
base SHA, tool arguments, branch, paths, network destinations, or patch/PR
permissions are denied. Out-of-grant and expired dispatches stop or revoke the
run and append evidence rather than running the requested tool. The registry
allow-list is an independent second gate: a tool the grant permits but the
allow-list does not is denied before any process runs.

Several limits matter when interpreting a local demo:

- The sandbox has a one-time workspace and scrubbed child environment, but it
  does not claim OS-level syscall sandboxing. On a stock host, the control is
  deny-by-default dispatch plus the audit trail; it cannot independently block
  a child-process egress attempt outside its declared scope.
- Delivery validates the only allowed repository, the protected `main` base,
  `autofixer/` task branches, and safe source paths. It delegates to injected
  clients and never merges a pull request, dismisses reviews, self-approves,
  waives checks, or enqueues a merge.
- The approval snapshot evaluates logical evidence only. GitHub branch
  protection and merge-queue verification still require the manual DAT-176
  configuration. A passing local test is not proof that those remote controls
  are configured or green.
- Event storage in this prototype is in memory. A complete retained,
  access-controlled production evidence store and a user-facing report export
  are not supplied by the current package surface.
- The demo produces a `not_created` patch report: the golden task dispatches a
  permitted tool but creates no repository patch. A patch-producing outcome
  requires the protected delivery adapter and a real provider write, which are
  out of scope for this local prototype.

These boundaries are intentional. A demo should demonstrate the controls and
evidence format, never be treated as authority to access credentials, mutate
protected resources, publish, deploy, or merge.
