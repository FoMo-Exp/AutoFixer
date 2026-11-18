# Workspace memory distillation v1 (DAT-233)

Contract for the ADR-0009 write path that sits between the dsh evidence and
delivery records and the memory schema (`docs/contracts/memory-schema-v1.md`):
the **outcome envelope** consumed by capture, the redaction rules every field
passes, the strict **distillation output schema**, and the validation rules a
candidate must survive before it becomes a `proposed` memory item.

Implementation lives in `node/src/distill/`. This document is a documentation
contract, not an HTTP API: the `v1` memory surface is defined by DAT-236.

## 1. Known terminal outcomes only

An outcome envelope exists only when a run reached a terminal state **and** the
outcome is known. The class is derived from the envelope — never supplied by
the producer:

| Terminal state | Derived class | Learnable | Positive |
| --- | --- | --- | --- |
| `merged` | `accepted` | yes | yes |
| `rejected` (reason required) | `rejected` | yes | no |
| `cancelled` (reason required) | `cancelled` | yes | no |
| `stopped` + `stop_disposition: failed` (classified `failure_cause`) | `failed` | yes | no |
| `stopped` + `stop_disposition: infra_failure` | `infra_failure` | no | no |
| `stopped` + `stop_disposition: unknown` | `unknown` | no | no |
| `timed_out`, `expired` | `timeout` | no | no |

`timeout`, `unknown`, and `infra_failure` outcomes are captured as `episode`
items only. They are never counted as success, never positive evidence, never
enter the distillation input, and never support a candidate claim.

## 2. Outcome envelope

The envelope mirrors the evidence contract's terminal records
(`docs/contracts/task-evidence-contract-v1.md` §2–§5). Parsing is strict:
unknown fields at any level are rejected, strings are bounded, enums are
closed, and cross-field consistency makes a fabricated merge impossible.

```json
{
  "contract_version": "1.0.0",
  "task_id": "task-1",
  "run_id": "run-1",
  "issue_id": "issue-1",
  "terminal_state": "merged",
  "stop_disposition": null,
  "failure_cause": null,
  "reason": null,
  "delivery": {
    "patch_status": "merged",
    "head_sha": "head-1",
    "pr_id": "pr-42",
    "change_summary": "Localized source and test correction.",
    "validation": [
      { "tool": "test-runner --focused", "exit_status": 0, "event_reference": "evidence://events/run-1/7" }
    ]
  },
  "evidence": [
    { "evidence_type": "reviewer_decision", "reference": "evidence://review/run-1/approval" }
  ]
}
```

- `terminal_state` ∈ `merged`, `rejected`, `cancelled`, `stopped`, `timed_out`, `expired`.
- `stop_disposition` ∈ `failed`, `infra_failure`, `unknown`; required exactly
  for `stopped`, forbidden otherwise. `failure_cause` ∈ `build_failure`,
  `test_failure`, `validation_failure`, `merge_conflict`, `policy_denied`,
  `tool_failure`, `resource_limit`; required exactly for `failed`.
- `reason` is required and non-empty for `rejected` and `cancelled`.
- `patch_status` ∈ `not_created`, `prepared_no_pr`, `proposed`, `merged`, with
  the evidence contract's identity nullability rules. Only `merged` may carry a
  merged delivery record, and only with a non-null PR identity.
- `evidence_type` ∈ `run`, `issue`, `pr`, `commit`, `test`, `reviewer_decision`,
  `incident`; references are unique, opaque, and bounded.
- Every identifier and reference that can be persisted (`task_id`, `run_id`,
  `issue_id`, `head_sha`, `pr_id`, `evidence[].reference`,
  `validation[].event_reference`) must be free of secret- and PII-shaped
  material. The evidence contract admits no secret or raw sensitive output in
  a record, so a credential- or personal-data-shaped reference is **rejected**
  (never stored, never scrubbed into a different identity).

Capture derives the **evidence ledger** from the envelope: the run and issue
identities, the PR and head commit identities when they exist, one `test` entry
per retained validation attempt (recording whether it exited 0), and the
envelope's own evidence references. Nothing a model says can add an entry.

## 3. Redaction and sensitivity

Every free-text field is secret-scanned and minimized before persistence or
egress: credential-shaped material is scrubbed, email addresses, phone
numbers, payment-card numbers, and user home paths become placeholders
(`[email]`, `[phone]`, `[payment_card]`, `[user_path]`). The result is scanned
again and anything left fails closed.

Sensitivity is classified from the material found: a secret makes the item
`restricted`, other personal data makes it `confidential`, clean content is
`internal`. Secrets never enter a memory item at all — a distilled candidate
carrying secret material is dropped. Evidence references are not free text:
they are opaque identifiers and are validated (and rejected when secret- or
PII-shaped) at parse time and again at the evidence-persistence boundary.

## 4. Distillation output schema

The extractor emits exactly one JSON object. The schema is strict: closed keys
at every level, closed vocabularies, bounded strings and cardinalities. Any
violation rejects the whole response.

```json
{
  "candidates": [
    {
      "kind": "lesson",
      "statement": "The focused vitest suite must pass before a change is proposed",
      "preconditions": ["node workspace with vitest configured"],
      "scope": { "path_prefix": "node/" },
      "evidence": [{ "evidence_type": "test", "reference": "evidence://events/run-1/7" }]
    }
  ]
}
```

- `kind` ∈ `fact`, `lesson`, `playbook`, `anti_pattern`. Episodes are captured,
  policy is human-authored; neither is distilled.
- `statement` ≤ 2000 characters. `preconditions`: 1–8 entries, each ≤ 300
  characters — a candidate must state when it applies.
- `scope` (optional) ∈ `team_id`, `path_prefix`, `language`, `task_family`.
  Scope is **structured applicability metadata** — a team identifier, a path
  prefix, a language, or a task family. It is not free text and not a field
  for carrying instructions. Scope values are model output like the statement
  and take the same treatment: secret- and PII-scan/minimize (secret material
  in any scope value drops the candidate) and the policy scan below covers
  every scope value.
- `evidence` ≤ 10 citations. An empty array is parsed but the candidate is
  **dropped**: a candidate without evidence is never persisted.
- At most 20 candidates per response.

## 5. Candidate validation

A candidate survives only when every part is attributable; otherwise it is
dropped with a recorded reason and never persisted:

| Check | Drop reason |
| --- | --- |
| Cites at least one evidence reference | `missing_evidence` |
| Every citation resolves in the captured ledger | `unresolved_evidence` |
| At least one citation comes from a known outcome | `no_known_outcome_evidence` |
| Every positive claim (merged / tests passed / review approved) is backed by captured evidence of that kind | `unsupported_claim` |
| No secret survives minimization (statement, preconditions, and scope values alike) | `secret_or_pii` |
| No prohibited instructions in the statement, preconditions, or scope values (below) | `policy_violation` (rejects the whole batch) |

Claims are detected in the statement and preconditions only (negated
statements are observations, not claims); scope is applicability metadata and
never an outcome assertion. A `merged` claim needs evidence captured from an
`accepted` outcome — episode-only evidence can never support success. A
`tests_passed` claim needs `test` evidence whose retained validation attempt
exited 0. A `review_approved` claim needs a captured `reviewer_decision`.
The extractor cannot fabricate test results, reviewer decisions, or merge
states: only capture writes ledger entries, and only from real envelopes.

A candidate containing instructions to **expand permissions**, **bypass
approval**, **ignore policy**, or **address the evaluator** — in any persisted
field: statement, preconditions, or applicability scope — rejects the whole
distillation batch: nothing from that response is persisted.

Accepted candidates persist as `proposed` items (`trust: agent`, provenance
with model and prompt-template version) with their resolved evidence rows.
The persistence boundary re-checks statement, preconditions, and every scope
value for secret and personal material before the item is written.
Promotion to `candidate`/`active` is a separate, gated path (DAT-234/235).

## 6. Egress and workspace isolation

Distillation model calls have exactly one egress path: the ADR-0005 model
gateway. Every captured outcome is bound to the workspace that captured it:
before any context is composed, an outcome whose episode belongs to another
workspace or enterprise is refused with `SCOPE_DENIED`, so foreign summaries
and evidence can never be composed into the model request and can never turn
into candidates written into the wrong workspace. The context is composed
only from the current workspace's captured outcomes (known ones only) plus
explicitly supplied workspace material; a material bound to another workspace
is likewise refused before anything is composed.
Everything sent outward is secret-scanned and minimized again. A gateway
denial fails the call closed and nothing is persisted.

## 7. Bounds

Envelope: identifier 200, reason 400, change summary 2000, tool 200,
reference 300 characters; ≤ 24 evidence references, ≤ 16 validation attempts.
Distillation: ≤ 16 materials of ≤ 4000 characters each. Every list is bounded;
nothing here reads or writes unbounded data.

## 8. Scheduled capture from authoritative dsh evidence (DAT-264)

The envelope of §1–§2 is produced by a durable capture outbox, never by an
agent assertion and never by the Node task projection alone.

### 8.1 Sources

A capture job exists only for a run whose authoritative `GET /v1/runs/{id}`
reports a terminal dsh state. The envelope is built strictly from that
evidence:

| Envelope field | Source |
| --- | --- |
| `task_id`, `run_id`, `issue_id` | the run resource |
| `terminal_state` | the run resource `state` |
| `delivery.*` | the run's finalized `patch_report` |
| `delivery.validation[]` | the patch report's retained attempts |
| `evidence[]` | the patch report's `evidence_references` (typed `run`) |
| `stop_disposition`, `failure_cause`, `reason` | the highest-sequence `state_transition` event's `decision_or_stop_code` |

A run that is not terminal, has no `patch_report`, has no state-transition
evidence, or whose newest transition disagrees with the reported state is not
capturable. The job records a stable error code and retries; it never writes a
fallback envelope.

### 8.2 Terminal classification

`rejected` and `cancelled` require the recorded decision/stop code as their
reason. `stopped` is classified from that code, fail closed:

| Code family | Disposition / cause |
| --- | --- |
| `stop_out_of_grant`, `deny_*`, gate refusals (`*_denied`, `grant_scope_exceeded`) | `failed` / `policy_denied` |
| `stop_execution_failure` | `failed` / `tool_failure` |
| `execution_resource_limit_exceeded` | `failed` / `resource_limit` |
| `execution_limit_unenforceable`, `execution_supervision_unavailable`, `execution_descendants_survived`, `stop_audit_failure` | `infra_failure` |
| anything else (for example `stop_local_review_required`) | `unknown` |

`timed_out` and `expired` are `timeout`. `unknown`, `timeout`, and
`infra_failure` remain episode-only: they are never success, never positive
evidence, and never distilled from. A `merged` run whose patch report is not
`merged` is contradictory evidence and is refused (`MERGED_WITHOUT_DELIVERY`).

### 8.3 Scheduling and idempotency

- Terminal snapshots are enqueued from the server-side task projection, which
  supplies the owning enterprise/workspace. The worker never takes a workspace
  from the run payload, and `task_id` on the run must equal the job's task.
- One row exists per `(workspace_id, run_id, terminal_state)`. Re-enqueueing,
  restart recovery, and duplicate delivery are no-ops for a captured snapshot.
  A stopped run that later becomes cancelled is a different terminal snapshot
  and is captured separately, as its own episode.
- A worker claims a due row under a lease. Capture and the `captured` marker
  commit in one transaction (the outbox shares the memory store's connection),
  so a crash between the episode write and completion cannot duplicate it.
- A failed dsh read, evidence gap, or memory write leaves the row `pending`
  with a stable error code and bounded backoff. After the attempt budget the
  row becomes `failed`, visible to operators, instead of retrying forever or
  reporting success.

## 9. Scheduled distillation of captured outcomes (DAT-265)

Capture (§8) records the exact redacted envelope it used, with a SHA-256
digest, in the same transaction as the episode. Distillation is a second
durable outbox over those snapshots: it is derived from a captured row, never
from a callback, an agent assertion, or a re-read of dsh.

### 9.1 Derivation

One `memory_distillation` row exists per captured snapshot whose derived
outcome class is learnable — `accepted`, `rejected`, `cancelled`, `failed`.
Episode-only classes (`timeout`, `unknown`, `infra_failure`) never get a row,
so they can never reach a model call and can never become a candidate or a
success claim. A snapshot captured before this outbox existed (no stored
envelope) is never back-filled from a reconstructed envelope; it simply has no
distillation job.

The row carries the server-side enterprise/workspace of the capture row. The
worker derives the memory scope and the gateway scope binding from those
columns only — the envelope and the model cannot retarget them. A row whose
capture snapshot disagrees with the row's scope is refused with `SCOPE_DENIED`
before any context is composed, and a snapshot whose stored digest no longer
matches is refused with `ENVELOPE_DIGEST_MISMATCH` before any model call.

### 9.2 One pass

1. Claim a due row under a lease.
2. Re-read the capture snapshot, verify digest and scope, rebuild the outcome
   record from the stored envelope (§2) and the captured episode.
3. Compose the §6 context (this outcome only) and dispatch through the ADR-0005
   gateway. A gateway denial or a transport failure fails the pass closed: no
   item is written and the row is retried with a stable error code.
4. Parse the §4 schema and run the §5 validation. A policy-violating batch is
   closed as `skipped` / `POLICY_VIOLATION_BATCH` and persists nothing, not
   even its clean candidates.
5. Run every accepted candidate through the DAT-234 admission gate. Dedupe,
   contradiction, and poisoning checks live there: an exact or near duplicate
   folds its evidence into the existing item; a contradiction is drawn as a
   `contradicts` link with a retirement *proposal* (never executed here); a
   poisoned candidate is discarded with its reason codes recorded.
6. Persist the items and the row's completion in one transaction.

### 9.3 Nothing is activated

An item the admission gate admits is persisted as a **`candidate`** (DAT-266):
the gate's schema, evidence, redaction, dedupe, contradiction, and poisoning
checks *are* ADR-0009's `proposed -> candidate` step. A rejected or held
candidate stays `proposed`. The pipeline never writes `active`: only the
named-human governance path (DAT-251, promoted through DAT-235's
`approveAndPromote`) can do that, and it stamps the approver on the exact
version.

A candidate is retrievable at reduced weight, capped per bundle, and labelled
unapproved (DAT-236). It is never factual injection, and it still cannot
authorize a tool, approval, or grant.

### 9.4 Traceability

Each pass records the capture job, the run and terminal state, the derived
outcome class, the model id, the prompt-template version, the persisted (or
merged-into) item ids, and accepted/dropped counts. Each item's provenance
carries the pipeline's model and prompt version — never values the extractor
supplied — and its evidence rows cite only references capture recorded. The
admission decision row for the candidate hash completes the audit chain.

### 9.5 Idempotency and recovery

- Deriving is idempotent: one row per captured snapshot (`UNIQUE` capture key),
  so a restart or a duplicate projection is a no-op.
- A duplicate snapshot (the same content distilled again) is handled by the
  admission gate's exact-hash idempotency: it merges into the first item rather
  than creating a second one.
- A crash after the model call but before persistence leaves the row claimed
  and retryable; the retry re-dispatches and persists once.
- Attempts are bounded; exhausting them marks the row `failed` with a stable
  error code, visible to operators, instead of retrying forever or reporting a
  success that never happened.

## 10. Delivery terminal state (DAT-266)

A real remediation ends when a human merges the delivered pull request. That
merge is not a dsh state: dsh finalized the local preparation as
`prepared_no_pr` and cannot see the provider. Capture therefore has a second,
delivery-keyed source in addition to the dsh-state source.

### 10.1 Identity

One capture row exists per `(workspace_id, delivery_id)`; rows captured from a
dsh state keep `delivery_id = NULL` and are unchanged. The delivery source is
eligible only when **all** of these hold, read from the product's own records
plus a live provider read:

| Fact | Requirement |
| --- | --- |
| Delivery | `state = delivered`, with `pr_id`, `pr_url`, branch, target branch, and exact `head_sha` |
| Candidate | exists, not invalidated, `head_sha` equals the delivery head |
| Run | the candidate's run is bound to a task (`task_id` non-null) |
| Approval | consumed by *this* delivery, bound to the delivered head, with a named approver |
| Validation | at least one retained attempt with a tool and event reference |
| Provider read | the PR is `merged`, with the same PR id, head, branch, and base as the delivery |

Any mismatch refuses with a stable code (`PR_NOT_MERGED`,
`PR_IDENTITY_MISMATCH`, `DELIVERY_APPROVAL_MISMATCH`,
`CANDIDATE_INVALIDATED`, `DELIVERY_PROVIDER_UNAVAILABLE`, …). An open, closed,
moved, or unreadable PR is **never** captured as `accepted`; an outage is
retryable and an exhausted attempt is marked `failed`.

### 10.2 Discovery

A bounded watcher observes delivered PRs on a fixed cadence. It performs no
provider write (the delivery seam has no merge operation) and enqueues exactly
one job on a merge. A delivery that already has a capture row is not observed
again, and the outbox's unique delivery key makes a duplicate enqueue a no-op.

Each scan reads at most one batch of deliveries, and the next scan continues
after the last delivery it read (wrapping at the end). The rotation is
process-local: a restart begins a fresh cycle. Without it, a prefix of
unmerged deliveries would consume every batch and a later merge would never be
observed.

### 10.3 Effect on the rest of the pipeline

The captured envelope is a normal `merged` outcome: the episode is classified
`accepted`, its evidence ledger cites the PR, the exact head commit, the
retained validation attempts (typed `test`), and the consumed approval (typed
`reviewer_decision`). Distillation, admission, human governance, and
next-run retrieval proceed exactly as in §9. The delivery read never touches
dsh and cannot change a run's capability grant.
