# Bounded recursive self-improvement v1 (DAT-238)

Contract for the bounded RSI loop over workspace memory and retrieval policy.
It implements the RSI section of ADR-0009
(`docs/adr/0009-workspace-memory-lessons-and-rsi.md`) on top of the memory
schema (`memory-schema-v1.md`) and the retrieval surface
(`memory-retrieval-v1.md`). The generated OpenAPI document at
`web/src/api/contracts/openapi.json` is the frontend baseline.

RSI is **advisory to delivery and authoritative only for memory artifacts**. It
cannot grant a capability, approve a change, alter an approval rule, change an
evidence schema, edit the evaluation definitions, change safety policy, or
merge/deploy. `dsh` remains the only execution gate.

## Risk ladder

The target determines the risk; a request never supplies its own risk class.

| Risk | Targets | Required gate |
| --- | --- | --- |
| A | `retrieval_weights`, `ranking_tiebreakers` | Passing offline replay. Named human approval unless the workspace enabled `auto_promote_low_risk`. |
| B | `lesson`, `playbook`, `prompt_hint` | Passing offline replay plus one named human approval (owner or admin), distinct from the proposer. |
| C | `retrieval_bounds`, `scope_taxonomy`, `consolidation_thresholds` | Passing offline replay plus two distinct human approvals: owner key and reviewer (admin) key. |
| D | `capability_grant`, `approval_rules`, `evidence_schema`, `evaluation_definition`, `safety_policy`, `merge_deploy` | Refused. Only a normal reviewed code or policy change can alter these. |

Artifact shapes:

- A and C targets carry a complete `candidate_policy`. It is validated against
  the same hard ceilings as a stored policy and stays **unpublished** until the
  canary reaches 100%; evaluation exercises it through a preview that neither
  stores a version nor records a retrieval run.
- B targets carry `memory_item: {item_id, item_version}` and accept only a
  `candidate` item at its current version.

## Evaluation integrity

- The **server** executes the replay. No operation accepts metrics, a score, a
  case, holdout content, or a verifier claim; the request selects datasets only.
- The recorded verifier is the authenticated evaluator with a server-derived
  `replay:<proposal>:v<version>:<dataset>` reference. The only verifier kind is
  `test`; agent self-report is not representable, and the proposer cannot
  evaluate its own proposal.
- Replay compares two arms over the stored workspace corpus:
  - policy targets: the promoted policy versus the candidate policy;
  - memory-item targets: candidate injection disabled versus enabled.
- A case succeeds when every `expected_item_ids` entry is injected and no
  `forbidden_item_ids` entry is. Forbidden injection is a security event in
  either arm.
- Reporting datasets: `golden` (human-curated) and `holdout` (hidden). Both
  must pass before a canary can start. The holdout is stored in a separate
  table with one reader — the replay — and the API exposes an aggregate count
  and last-evaluation timestamp only.
- Case provisioning is not an HTTP operation. The golden and holdout sets are
  provisioned out of band; changing an acceptance set is a class-D change that
  follows normal review.

## Gate arithmetic

Fixed bounds, not workspace settings:

| Bound | Value |
| --- | --- |
| Minimum sample per arm | 20 |
| Maximum tolerated success-rate drop (point estimate) | 0 (non-negative required) |
| Regression margin, applied to the confidence upper bound | 0.02 |
| Rework growth per sample | 0.05 |
| Context-cost growth | 25% |
| Canary stages and per-stage minimum candidate sample | 10% / 10, 50% / 25, 100% / 50 |

The difference is estimated with **Newcombe's hybrid score interval**; each arm
also has a Wilson interval. A verdict is:

- `inconclusive` when the sample is below the minimum — a refusal, not a pass;
- `fail` on any security event, negative delta, a confidence upper bound below
  `-0.02`, rework growth over 0.05 per sample, or cost growth over 25%;
- `pass` otherwise.

A workspace may tighten behaviour (`auto_promote_low_risk` off, lower
`weekly_change_budget`, lower `weekly_reflection_token_budget`, kill switch),
never raise these.

## Budgets

- Weekly change budget: default 3 promoted changes per ISO week (Monday, UTC).
  Promotion consumes one unit; the next canary start requires remaining budget.
- Weekly reflection-token budget: default 200,000 tokens. Each replay records
  the tokens spent across both arms; a run whose spend would exceed the budget
  is refused before any evaluation row is written.

## Canary, promotion, rollback

- A canary starts only when the offline gate passes, approvals are complete,
  budget remains, and the kill switch is inactive.
- An observation is computed server-side from the runs pinned into the rollout
  (candidate arm) and baseline pins created since it started (control arm),
  joined with their terminal task outcomes. Pending runs are excluded, and any
  request body is refused — an owner cannot submit a passing sample. The
  evidence reference is the server-generated pin set.
- A fail verdict rolls back automatically with the reason; an inconclusive
  verdict (including either arm below its minimum sample) does not advance.
- A pass advances 10% → 50% → 100%. The pass at 100% promotes:
  - a policy target publishes exactly one new immutable policy version;
  - a memory-item target records the approving human's review stamp and
    activates the exact proposed version.
- Manual rollback stops a canary. Reverting a promoted policy publishes the
  baseline policy as a new version; reverting a promoted memory item
  deprecates it. Historical run pins are never rewritten.

## Kill switch and run pins

- The kill switch is per workspace. Engaging it requires a reason and takes
  effect in the same call: every active canary is rolled back, new pins resolve
  to the baseline policy, and proposals, evaluations, approvals, and canaries
  are refused until it is released.
- `resolveRunVersions(workspace, run_id)` is called by the orchestrator at run
  start (before the Pi prompt is built) and pins exactly one memory version and
  one policy identity per run. The task projection records the result in a
  `memory` block; a canary run's candidate overlay is consumed by the
  unpublished-policy retrieval preview before the prompt. The pin is idempotent and stable across retries. A run
  selected for an active canary also receives the unpublished candidate policy
  as an overlay for preview; baseline runs receive none. Selecting the canary
  uses a deterministic hash bucket of `workspace_id` + `run_id`, so the same
  run always lands in the same arm.

Run execution calls the resolver before planning. A baseline run retrieves with
the pinned stored version (audited); a canary run assembles the same bounded
bundle through the overlay preview and records the pin as its audit anchor.

## HTTP surface

All operations require a web/desktop session and derive enterprise/workspace
scope from membership. Path `workspace_id` is a locator, never authority.

| Operation | Role | Purpose |
| --- | --- | --- |
| `GET /memory/proposals` | member | Bounded list, filter by status/risk |
| `POST /memory/proposals` | member | Open a proposal (proposer = session user) |
| `GET /memory/proposals/{id}` | member | Detail, evaluations, approvals, rollout, gate |
| `POST /memory/proposals/{id}/evaluations` | owner | Run replay over golden and holdout (datasets only) |
| `POST /memory/proposals/{id}/approvals` | owner/admin | Record an approval for this version |
| `POST /memory/proposals/{id}/canary` | owner | Start the 10% canary |
| `POST /memory/proposals/{id}/canary/observations` | owner | Compute and record a stage sample from pinned runs |
| `POST /memory/proposals/{id}/rollback` | owner | Stop or revert |
| `GET /memory/rsi/status` | member | Controls, budgets, holdout counter, active rollout |
| `POST /memory/rsi/kill-switch` | owner | Engage or release immediately |
| `PATCH /memory/rsi/controls` | owner | Tighten budgets or disable automatic promotion |

Refusal semantics: `400` for an invalid or forbidden request (including class
D targets and self-verification), `403` for insufficient role, `404` for a
workspace outside membership or an unknown proposal, and `409` for a state
conflict (kill switch active, budget exhausted, gate unsatisfied, already
live).
