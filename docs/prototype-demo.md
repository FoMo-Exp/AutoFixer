# Prototype demo and developer use guide

This guide is the developer-facing entry point for the currently implemented
AutoFixer prototype. It describes what can be reproduced from this repository
today; it does not grant authority to run a remediation or to change a remote
repository.

The normative record shape is
[`task-evidence-contract-v1`](contracts/task-evidence-contract-v1.md). The
prototype applies that contract through the `harness`, `sandbox`, and
`delivery` Go packages.

## What is available now

The repository requires Go 1.25 (see `go.mod`). Its current entry point is the
package test suite, which uses local fixtures and injected delivery clients.
There is no compiled CLI, configuration file format, task submission endpoint,
or report-export command in this revision.

Run the complete offline verification suite from the repository root:

```sh
go test ./...
```

The tests do not open a real pull request, modify `main`, or require a GitHub
credential. Sandbox fixture commands use local programs such as `/bin/sleep`
and `/bin/sh`; their grants declare no network destinations.

### Pending AFP-05 command integration

The user-facing command, its flags, task-input file location, and report
output location are **pending AFP-05 integration**. In particular, neither of
the following is a supported command today:

```text
autofixer run ...
autofixer demo ...
```

When AFP-05 has merged, replace this section only with commands confirmed by
the implemented `--help` output and an observed local run. Until then, use the
focused test commands below as the reproducible demo surface.

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
time-bounded capability grant.

## Reproducible offline narratives

Each command below runs an existing fixture in isolation. A passing test is
the expected result. These fixtures retain evidence in an in-memory event
store for assertions; they do not currently write a JSON evidence bundle to
disk. The contract examples remain the inspectable serialized form.

| Narrative | Run | Expected terminal result and audit evidence |
| --- | --- | --- |
| Success-path state machine | `go test ./harness -run '^TestFullHappyPathToMerged$' -count=1` | A low-risk fixture records seven chained events: grant issuance, `running`, allowed tool dispatch, `awaiting_review`, eligibility evaluation, `approved_for_merge`, and `merged`. The chain is verified by `VerifyChain`. This is a state-machine fixture, not a real GitHub merge. |
| Prohibited request | `go test ./harness -run '^TestProhibitedRunRejectedWithQueryableEvidence$' -count=1` | A prohibited secret-access assessment refuses grant issuance, transitions to terminal `rejected`, and retains a queryable state-transition event with `prohibited_secret_access`. |
| Cancellation during execution | `go test ./sandbox -run '^TestExecuteCancelTerminatesCleansAndPreservesEvidence$' -count=1` | A permitted local `/bin/sleep 10` is cancelled by its context. The run reaches terminal `cancelled`, appends cancellation outcome and transition evidence, verifies the digest chain, and removes the one-time workspace. |

For delivery-linkage coverage, run:

```sh
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

For all three focused fixtures, inspect the test assertions and the contract
for these fields:

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
run and append evidence rather than running the requested tool.

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

These boundaries are intentional. A demo should demonstrate the controls and
evidence format, never be treated as authority to access credentials, mutate
protected resources, publish, deploy, or merge.
