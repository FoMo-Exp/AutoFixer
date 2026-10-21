# ForgePilot task and evidence contract v1

**Contract version:** `1.0.0`

**Status:** implementation contract
**Normative source:** `docs/adr/0001-forgepilot-governance-and-threat-model.md` (FP-01)

This document gives the ForgePilot pilot one versioned, implementation-neutral
representation for a remediation task and the evidence it must retain. It is a
documentation contract, not an HTTP API, database design, or a grant of
authority. An implementation may add its own transport or storage fields only
when they do not weaken the required fields and rules below.

The words **MUST**, **MUST NOT**, and **MAY** are normative. A missing required
field, an unverifiable digest, or an evidence record that cannot be tied to the
current PR head is a control failure; it blocks `awaiting_review` and
merge-queue eligibility.

## 1. Versioning and identifiers

Every task, risk assessment, execution event, patch report, and approval
snapshot MUST carry `contract_version: "1.0.0"`. `major.minor.patch` uses
semantic-versioning intent:

- A patch version clarifies this document without changing a required field or
  meaning.
- A minor version may add optional fields; v1 readers MUST preserve and ignore
  fields they do not understand.
- A major version may change required fields or meanings. A record MUST NOT
  claim compatibility with a different major version.

`task_id` identifies the requested remediation task. `run_id` identifies one
capability-grant attempt for that task. A terminal grant never resumes: a later
attempt MUST receive a new `run_id` and begin in `requested`, as required by
FP-01. Identifiers are opaque strings; this contract does not prescribe an ID
format.

Times are UTC RFC 3339 timestamps. A SHA and any digest is the exact value
reported by the source system, accompanied by its algorithm where the value is
an artifact or event digest. No secret, access token, or raw sensitive output
may appear in a record.

## 2. Contract shape

A complete task evidence bundle contains the following logical records. The
same values may be stored in separate append-only records, but their references
MUST resolve within the retained evidence bundle.

| Record | Required purpose | Required linkage |
| --- | --- | --- |
| `task_input` | Identifies the requested remediation and target revision. | `task_id`, `issue_id`, repository URL, base SHA |
| `risk_assessment` | Records the pre-approval risk decision. | `task_id`, `run_id`, risk class, assessor, policy version, elevated-approval reference when applicable |
| `capability_grant` | Bounds the only actions a runner may exercise. | `run_id`, grant version, repository/base SHA, permitted scope |
| `execution_event[]` | Immutable evidence of each state transition and tool invocation. | `run_id`, ordered digest chain, prior/resulting state |
| `patch_report` | Records an explicit no-patch outcome or binds a patch and validation evidence to its revision. | `task_id`, `run_id`, base SHA, and branch/head/PR identifiers when they exist |
| `approval_snapshot` | Shows the merge boundary for one exact head, or why no approval was available. | `run_id`, current head SHA or `null`, snapshot time |

`task_input` MUST contain:

```json
{
  "contract_version": "1.0.0",
  "task_id": "opaque-task-id",
  "issue_id": "issue-tracker-id",
  "requested_at": "2026-10-21T09:00:00Z",
  "repository": {
    "url": "https://github.com/owner/repository.git",
    "base_sha": "exact-base-commit-sha"
  },
  "requested_work": {
    "summary": "bounded description of the reported problem",
    "source_reference": "immutable issue or report reference"
  }
}
```

`requested_work` identifies the report being diagnosed; it does not grant a
tool, path, network, branch, or merge permission. Those permissions exist only
in an approved `capability_grant`.

`risk_assessment` MUST contain `contract_version`, `task_id`, `run_id`,
`assessed_at`, `assessor_identity`, `risk_class`, `decision_code`,
`rationale_reference`, `policy_version`, and `elevated_approval_reference`.
`risk_class` is exactly one of `low`, `elevated`, or `prohibited`.
`elevated_approval_reference` MUST be a non-null reference to the pre-grant
approval record for an `elevated` assessment. That record MUST name the human
approver and approval timestamp, and its timestamp MUST precede grant issuance.
For `low` and `prohibited` assessments, `elevated_approval_reference` MUST be
explicitly `null`. A `prohibited` assessment MUST lead to `rejected`; it MUST
NOT be downgraded in the same run.

`capability_grant`, when a run is approved, MUST contain `contract_version`,
`task_id`, `run_id`, `issued_at`, `expires_at`, `policy_version`,
`capability_grant_version`, `repository_url`, `base_sha`, `permitted_paths`,
`permitted_tools`, `network_destinations`, `max_wall_clock_seconds`,
`resource_limits`, `may_create_patch`, `may_create_or_update_pr`, and
`approval_reference`. Missing scope means denied. For an `elevated` run,
`approval_reference` MUST equal `risk_assessment.elevated_approval_reference`.
`permitted_tools` records a tool identity and its allowed arguments;
`network_destinations` is an explicit allowlist and is normally empty.

## 3. Required immutable execution event

Each state transition and every tool invocation MUST append one
`execution_event`. Events are ordered by `sequence` and form a digest chain:
`previous_event_digest` is the digest of the immediately preceding event, or
`null` only for sequence 1. `event_digest` is computed from the canonical,
redacted event content using its declared `digest_algorithm`.

| Field | Required value | FP-01 source |
| --- | --- | --- |
| `contract_version` | This contract version. | Consequences: explicit product surfaces |
| `event_id`, `sequence`, `event_type` | Unique event label, order, and either `state_transition` or `tool_invocation`. | Audit record; append-only event store |
| `run_id` | The remediation-run identifier. | Audit record: run ID |
| `task_id`, `issue_id`, `pr_id` | Task link plus issue and PR identifiers; `pr_id` may be `null` before a PR exists. | Audit record: issue and PR IDs |
| `actor_identity`, `execution_identity` | The actor and the identity used to execute. | Audit record: actor and execution identity |
| `occurred_at` | UTC event time. | Audit record: UTC timestamp |
| `prior_state`, `resulting_state` | FP-01 state names; no invented state value. | Run state and risk; audit record |
| `risk_class` | `low`, `elevated`, or `prohibited`. | Run state and risk; audit record |
| `policy_version`, `capability_grant_version` | Exact versions in force. | Audit record |
| `repository_url`, `base_sha`, `branch`, `head_sha` | Exact repository and revision binding; branch/head may be `null` before they exist. | Audit record |
| `requested_tool`, `actual_tool` | Redacted tool identity and arguments, or `null` for a state-only event. | Audit record: requested and actual tool/arguments |
| `path_scope`, `network_scope` | Granted/requested path and network scopes observed for this event. | Audit record; capability model |
| `exit_status`, `output_digest` | Redacted exit result and digest of redacted output, or `null` when no tool ran. | Audit record |
| `artifact_digests` | Digest references for evidence artifacts, including an empty array when none exist. | Audit record |
| `approval_snapshot_ref` | Reference to the snapshot applicable when this event was observed. | Audit record: approval identities and timestamps; GitHub merge boundary |
| `decision_or_stop_code` | Decision or stop-condition code; `null` only when neither applies. | Audit record; stop and escalation conditions |
| `previous_event_digest`, `event_digest`, `digest_algorithm` | Tamper-evident chain fields. | Threat model: append-only event store with digest chain |

An event MUST record redacted arguments and output only. `requested_tool` is the
tool/arguments requested by the task or dispatcher; `actual_tool` is what the
runner attempted. A mismatch, out-of-grant dispatch, secret detection,
unapproved egress, audit failure, unexpected repository/base/policy change,
prohibited path, failed validation, resource violation, security concern, or
head-unbound evidence MUST stop the run and revoke the grant.

## 4. Patch report and approval snapshot

Every complete evidence bundle MUST contain one `patch_report`, including a
rejection or cancellation that produced no patch. `patch_status` is exactly one
of `not_created`, `prepared_no_pr`, `proposed`, or `merged`; it determines which
revision fields are present:

- `not_created`: `branch`, `head_sha`, and `pr_id` MUST each be explicitly
  `null`.
- `prepared_no_pr`: `branch` and `head_sha` MUST be non-null, `branch` MUST
  begin `autofixer/`, and `pr_id` MUST be explicitly `null`.
- `proposed` or `merged`: `branch`, `head_sha`, and `pr_id` MUST all be
  non-null, and `branch` MUST begin `autofixer/`.

`patch_report` MUST contain:

| Field | Rule | FP-01 source |
| --- | --- | --- |
| `contract_version`, `task_id`, `run_id`, `issued_at` | Versioned, time-stamped task/run linkage. | Consequences; audit record |
| `repository_url`, `base_sha` | Identify the exact repository and base revision for every outcome. | Audit record |
| `patch_status`, `branch`, `head_sha`, `pr_id` | Follow the status-specific null and branch rules above. A non-null revision value identifies the exact proposed revision. | Audit record; GitHub merge boundary |
| `change_summary` | Bounded patch description, or an explicit no-patch disposition. | Scope: prepare a patch only inside approved checkout |
| `validation` | At least one record for every validation attempt: tool/arguments, redacted exit status, output digest, and matching event reference. | Audit record; stop condition for validation failure |
| `evidence_references` | Non-empty retained event/artifact references, bound to `head_sha` when one exists, or to the terminal event when `patch_status` is `not_created`. | Audit record; evidence must be tied to current head |
| `report_digest`, `digest_algorithm` | Tamper-evident report reference. | Audit record; threat model digest chain |

An `approval_snapshot` MUST contain `contract_version`, `task_id`, `run_id`,
`observed_at`, `head_sha`, `qa`, `required_checks`, `review_discussions`,
`approval_quorum`, `merge_queue_eligible`, `approval_snapshot_status`, and an
`evidence_reference`. `approval_quorum` follows the language in `CONTEXT.md`:
it is an object containing `status`, `head_sha`, and `approvals`; each approval
contains the approver identity, approved head SHA, and timestamp. It is always
required, even when approval was not requested or cannot apply. In that case,
use an explicit status such as `not_requested` or `not_applicable`, set
`merge_queue_eligible` to `false`, and preserve empty arrays rather than
omitting the observations.

The snapshot `head_sha`, `qa.head_sha`, `review_discussions.head_sha`, and
`approval_quorum.head_sha` MAY be `null` only when the associated
`patch_report.patch_status` is `not_created`; otherwise they MUST equal the
patch report's non-null `head_sha`. `qa.identity` and `qa.approved_at` MAY be
`null` only when `qa.status` is `not_requested` or `not_applicable`.

For a proposed PR head, a snapshot is `eligible` only if, simultaneously:

1. `qa.status` is `passed` for that exact `head_sha`;
2. every `required_checks[]` entry is `passed` for that exact `head_sha`;
3. `review_discussions.status` is `resolved` for that exact `head_sha`; and
4. `approval_quorum.approvals` has current-head approvals from both `Luthiel`
   and `Ludwig-Planck`.

A new head SHA MUST produce a new snapshot and invalidates the old QA/checks/
discussion/approval-quorum observations. A snapshot describes GitHub's merge
boundary; a runner MUST NOT use it to merge, dismiss reviews, waive checks,
self-approve, or enqueue a PR.

## 5. State and completeness rules

`requested`, `approved`, `running`, `awaiting_review`, `approved_for_merge`,
`stopped`, `timed_out`, `expired`, `rejected`, `cancelled`, and `merged` are the
only state values. Transitions MUST follow FP-01's state table. In particular:

- `approved` requires recorded scope, risk class, and capability grant.
- `running` may exercise only the grant. Cancellation, expiry, and timeout
  revoke credentials and block further dispatch.
- `awaiting_review` requires a PR for the current commit and no further
  repository mutation.
- A `stopped` run requires human disposition. It may become `cancelled`, or a
  new grant may move it to `approved`.
- `timed_out`, `expired`, `rejected`, `cancelled`, and `merged` are terminal
  for that grant.

Every terminal outcome MUST retain a complete evidence bundle, including a
`patch_report` and `approval_snapshot`, even when it has no patch, PR, or tool
output. `null` is permitted only for the risk-assessment cases explicitly
defined in section 2, the execution-event cases in section 3, the patch-report
and approval-snapshot cases explicitly defined in section 4, and nowhere else.
Absence is never a substitute for a known empty or
not-applicable value. Evidence references MUST resolve to access-controlled,
append-only retained records. Artifact references MUST name the digest
algorithm and digest; sensitive raw data remains outside the contract record.

## 6. Canonical terminal examples

The following field-complete terminal-outcome records are fixtures for FP-03
through FP-06. Their evidence references resolve to the `task_input`,
`capability_grant` (when issued), and immutable events required by sections 2
and 3. They use synthetic opaque IDs, sample timestamps, and sample digests;
they do not authorize the described work.

### 6.1 Success (`merged`)

```json
{
  "contract_version": "1.0.0",
  "task_id": "task-demo-success-001",
  "run_id": "run-demo-success-001",
  "terminal_state": "merged",
  "risk_assessment": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-success-001",
    "run_id": "run-demo-success-001",
    "assessed_at": "2026-10-21T09:00:00Z",
    "assessor_identity": "human:reviewer-17",
    "risk_class": "low",
    "decision_code": "risk_low_approved",
    "rationale_reference": "evidence://risk/task-demo-success-001",
    "policy_version": "governance-1",
    "elevated_approval_reference": null
  },
  "patch_report": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-success-001",
    "run_id": "run-demo-success-001",
    "issued_at": "2026-10-21T09:12:00Z",
    "repository_url": "https://github.com/example/service.git",
    "base_sha": "base111",
    "patch_status": "merged",
    "branch": "autofixer/task-demo-success-001",
    "head_sha": "head222",
    "pr_id": "pr-42",
    "change_summary": "Localized source and test correction.",
    "validation": [{
      "tool": "test-runner --focused",
      "exit_status": 0,
      "output_digest": { "algorithm": "sha256", "value": "out333" },
      "event_reference": "evidence://events/run-demo-success-001/7"
    }],
    "evidence_references": ["evidence://events/run-demo-success-001/7", "evidence://artifacts/run-demo-success-001/patch"],
    "report_digest": "report444",
    "digest_algorithm": "sha256"
  },
  "approval_snapshot": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-success-001",
    "run_id": "run-demo-success-001",
    "observed_at": "2026-10-21T10:00:00Z",
    "head_sha": "head222",
    "qa": { "status": "passed", "head_sha": "head222", "identity": "qa:team", "approved_at": "2026-10-21T09:30:00Z" },
    "required_checks": [{ "name": "required-check", "status": "passed", "head_sha": "head222", "observed_at": "2026-10-21T09:35:00Z" }],
    "review_discussions": { "status": "resolved", "head_sha": "head222", "observed_at": "2026-10-21T09:40:00Z" },
    "approval_quorum": {
      "status": "satisfied",
      "head_sha": "head222",
      "approvals": [
        { "identity": "Luthiel", "head_sha": "head222", "approved_at": "2026-10-21T09:45:00Z" },
        { "identity": "Ludwig-Planck", "head_sha": "head222", "approved_at": "2026-10-21T09:50:00Z" }
      ]
    },
    "merge_queue_eligible": true,
    "approval_snapshot_status": "eligible",
    "evidence_reference": "evidence://approvals/run-demo-success-001/head222"
  },
  "evidence_references": ["evidence://events/run-demo-success-001", "evidence://approvals/run-demo-success-001/head222"]
}
```

### 6.2 Rejected (`rejected`)

```json
{
  "contract_version": "1.0.0",
  "task_id": "task-demo-rejected-001",
  "run_id": "run-demo-rejected-001",
  "terminal_state": "rejected",
  "risk_assessment": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-rejected-001",
    "run_id": "run-demo-rejected-001",
    "assessed_at": "2026-10-21T11:00:00Z",
    "assessor_identity": "human:reviewer-18",
    "risk_class": "prohibited",
    "decision_code": "prohibited_secret_access",
    "rationale_reference": "evidence://risk/task-demo-rejected-001",
    "policy_version": "governance-1",
    "elevated_approval_reference": null
  },
  "patch_report": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-rejected-001",
    "run_id": "run-demo-rejected-001",
    "issued_at": "2026-10-21T11:01:00Z",
    "repository_url": "https://github.com/example/service.git",
    "base_sha": "base555",
    "patch_status": "not_created",
    "branch": null,
    "head_sha": null,
    "pr_id": null,
    "change_summary": "No patch was prepared because the request was prohibited.",
    "validation": [],
    "evidence_references": ["evidence://events/run-demo-rejected-001/1"],
    "report_digest": "report666",
    "digest_algorithm": "sha256"
  },
  "approval_snapshot": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-rejected-001",
    "run_id": "run-demo-rejected-001",
    "observed_at": "2026-10-21T11:01:00Z",
    "head_sha": null,
    "qa": { "status": "not_requested", "head_sha": null, "identity": null, "approved_at": null },
    "required_checks": [],
    "review_discussions": { "status": "not_applicable", "head_sha": null, "observed_at": "2026-10-21T11:01:00Z" },
    "approval_quorum": { "status": "not_requested", "head_sha": null, "approvals": [] },
    "merge_queue_eligible": false,
    "approval_snapshot_status": "not_requested",
    "evidence_reference": "evidence://approvals/run-demo-rejected-001/no-pr"
  },
  "evidence_references": ["evidence://risk/task-demo-rejected-001", "evidence://events/run-demo-rejected-001/1", "evidence://approvals/run-demo-rejected-001/no-pr"]
}
```

### 6.3 Cancelled (`cancelled`)

```json
{
  "contract_version": "1.0.0",
  "task_id": "task-demo-cancelled-001",
  "run_id": "run-demo-cancelled-001",
  "terminal_state": "cancelled",
  "risk_assessment": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-cancelled-001",
    "run_id": "run-demo-cancelled-001",
    "assessed_at": "2026-10-21T12:00:00Z",
    "assessor_identity": "human:reviewer-19",
    "risk_class": "elevated",
    "decision_code": "elevated_approved_then_cancelled",
    "rationale_reference": "evidence://risk/task-demo-cancelled-001",
    "policy_version": "governance-1",
    "elevated_approval_reference": "evidence://grant-approvals/run-demo-cancelled-001"
  },
  "patch_report": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-cancelled-001",
    "run_id": "run-demo-cancelled-001",
    "issued_at": "2026-10-21T12:10:00Z",
    "repository_url": "https://github.com/example/service.git",
    "base_sha": "base777",
    "patch_status": "prepared_no_pr",
    "branch": "autofixer/task-demo-cancelled-001",
    "head_sha": "head888",
    "pr_id": null,
    "change_summary": "Partial patch retained as evidence; no PR was opened after cancellation.",
    "validation": [{
      "tool": "test-runner --focused",
      "exit_status": 0,
      "output_digest": { "algorithm": "sha256", "value": "out999" },
      "event_reference": "evidence://events/run-demo-cancelled-001/4"
    }],
    "evidence_references": ["evidence://events/run-demo-cancelled-001/4", "evidence://events/run-demo-cancelled-001/5"],
    "report_digest": "reportaaa",
    "digest_algorithm": "sha256"
  },
  "approval_snapshot": {
    "contract_version": "1.0.0",
    "task_id": "task-demo-cancelled-001",
    "run_id": "run-demo-cancelled-001",
    "observed_at": "2026-10-21T12:15:00Z",
    "head_sha": "head888",
    "qa": { "status": "not_requested", "head_sha": "head888", "identity": null, "approved_at": null },
    "required_checks": [],
    "review_discussions": { "status": "not_applicable", "head_sha": "head888", "observed_at": "2026-10-21T12:15:00Z" },
    "approval_quorum": { "status": "not_requested", "head_sha": "head888", "approvals": [] },
    "merge_queue_eligible": false,
    "approval_snapshot_status": "not_requested",
    "evidence_reference": "evidence://approvals/run-demo-cancelled-001/head888"
  },
  "evidence_references": ["evidence://risk/task-demo-cancelled-001", "evidence://grant-approvals/run-demo-cancelled-001", "evidence://events/run-demo-cancelled-001/5", "evidence://approvals/run-demo-cancelled-001/head888"]
}
```

## 7. Consumer guidance

FP-03 through FP-06 MAY cite this document as `task-evidence-contract@1.0.0`.
They MUST preserve the terminal examples' required task ID, version, risk
result, evidence references, and approval snapshot fields. A consumer that
cannot produce or retain an event required by section 3 MUST stop rather than
fabricate evidence. A consumer that needs a broader capability or a changed
state transition needs a separately reviewed governance change; this contract
does not create an exception.
