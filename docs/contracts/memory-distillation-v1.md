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
carrying secret material is dropped.

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
| No secret survives minimization | `secret_or_pii` |
| No prohibited instructions (below) | `policy_violation` (rejects the whole batch) |

Claims are detected in the candidate text (negated statements are
observations, not claims). A `merged` claim needs evidence captured from an
`accepted` outcome — episode-only evidence can never support success. A
`tests_passed` claim needs `test` evidence whose retained validation attempt
exited 0. A `review_approved` claim needs a captured `reviewer_decision`.
The extractor cannot fabricate test results, reviewer decisions, or merge
states: only capture writes ledger entries, and only from real envelopes.

A candidate containing instructions to **expand permissions**, **bypass
approval**, **ignore policy**, or **address the evaluator** rejects the whole
distillation batch: nothing from that response is persisted.

Accepted candidates persist as `proposed` items (`trust: agent`, provenance
with model and prompt-template version) with their resolved evidence rows.
Promotion to `candidate`/`active` is a separate, gated path (DAT-234/235).

## 6. Egress and workspace isolation

Distillation model calls have exactly one egress path: the ADR-0005 model
gateway. The context is composed only from the current workspace's captured
outcomes (known ones only) plus explicitly supplied workspace material; a
material bound to another workspace is refused before anything is composed.
Everything sent outward is secret-scanned and minimized again. A gateway
denial fails the call closed and nothing is persisted.

## 7. Bounds

Envelope: identifier 200, reason 400, change summary 2000, tool 200,
reference 300 characters; ≤ 24 evidence references, ≤ 16 validation attempts.
Distillation: ≤ 16 materials of ≤ 4000 characters each. Every list is bounded;
nothing here reads or writes unbounded data.
