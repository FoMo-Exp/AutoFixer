# ADR 0009: Workspace-scoped lessons, tiered memory, and bounded recursive self-improvement

**Status:** Proposed — detailed design awaiting review; nothing here is
implemented.

**Date:** 2026-11-03

## Context

AutoFixer is a team product. A workspace is one repository shared by selected
members and teams (ADR-0006). Every remediation run already produces a plan,
tool and sandbox evidence, test results, a proposed change, a human decision,
and a delivery outcome (ADR-0007/0008). Today that experience is consumed once
and then effectively lost: the next run rediscovers the same build command,
the same flaky test, the same rejected approach, and the same reviewer
objection. Operators also cannot see, correct, or retire what an agent
"learned" from earlier work.

The requester asked for workspace-based **Lesson** and long-term/short-term
memory, plus recursive self-improvement (RSI), drawing on practical
open-source and published approaches. The product requirement is team
learning with accountability, not an agent that quietly rewrites itself.

Prior decisions bound this design:

- workspace and enterprise isolation, with no client-supplied scope as
  authority (ADR-0006);
- human change approval before any PR, and no agent-granted approval
  (ADR-0007);
- fail-closed model egress, non-secret audit evidence, retention limits, and
  unknown outcomes that are never reported as success (ADR-0005/0008);
- repository governance that memory must not bypass (ADR-0001).

"Recursive self-improvement" here means improving the context, lessons,
playbooks, and retrieval policy used by later runs, based on evaluated
outcomes. It does **not** mean autonomous modification of guardrails,
permissions, evaluation definitions, or the ability to merge its own changes.

## Prior art and what this decision adopts

The following mechanisms are adopted as design inputs. Their repositories and
papers were consulted for architecture, not copied; no source or schema
compatibility is claimed.

| Source | Practicable mechanism | How it is used here |
| --- | --- | --- |
| MemGPT / Letta ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560), [letta-ai/letta](https://github.com/letta-ai/letta)) | Tiered context, eviction, explicit memory tools, sleep-time consolidation | Separate working, episodic, semantic, procedural, and policy tiers; consolidation as a background job. Agents do not edit active memory directly. |
| Generative Agents ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) | Memory stream with recency, importance, and relevance retrieval; reflection | Retrieval scoring and periodic reflection over completed runs. |
| Reflexion ([arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) | Verbal post-episode reflection held in an episodic buffer | Failure and rejection lessons, but evidence-bound and workspace-scoped. |
| ExpeL ([arXiv:2308.10144](https://arxiv.org/abs/2308.10144)) | Cross-task insight extraction from successes and failures | Distillation across runs instead of per-chat summarization. |
| Voyager ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291)) | Library of skills only after verification | Procedural lessons may become playbooks only after validation. |
| Agent Workflow Memory ([arXiv:2409.07429](https://arxiv.org/abs/2409.07429)) | Induced reusable workflows from experience | Workspace playbooks with preconditions, not free-form advice. |
| A-MEM ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110)) | Linked, Zettelkasten-style memory notes | Explicit `supports`, `contradicts`, `supersedes`, and `applies_to` links. |
| mem0 ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413), [mem0ai/mem0](https://github.com/mem0ai/mem0)) | ADD/UPDATE/DELETE/NOOP consolidation | A bounded consolidation vocabulary instead of rewriting the corpus. |
| Zep / Graphiti ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [getzep/graphiti](https://github.com/getzep/graphiti)) | Temporal validity and fact supersession | `valid_from` / `valid_to`, supersession, and point-in-time retrieval. |
| Agentic Context Engineering / ACE ([arXiv:2510.04618](https://arxiv.org/abs/2510.04618)) | Append-only evolving playbook with a curator; avoids context collapse | Delta-only lesson updates, curation budget, and anti-drift checks. |
| Self-Improving Coding Agent ([arXiv:2504.15228](https://arxiv.org/abs/2504.15228)) | Self-modification driven by benchmark feedback | Proposal → evaluation → promotion loop, limited to memory artifacts. |
| Darwin Gödel Machine ([arXiv:2505.22954](https://arxiv.org/abs/2505.22954)) | Archived variants and empirical selection | Immutable memory versions, canary, and rollback. |
| STOP ([arXiv:2310.02304](https://arxiv.org/abs/2310.02304)) | Recursive improvement with an external evaluator | The learning loop never owns its own evaluator or acceptance criteria. |
| Dynamic Cheatsheet ([arXiv:2504.07952](https://arxiv.org/abs/2504.07952)) | Test-time curated notes under a context budget | Strict retrieval budget and omission over dilution. |
| Repository agent practice (`CLAUDE.md`, `AGENTS.md`, repository rules) | Human-authored, reviewable conventions | The institutional tier is human-authored and never auto-learned. |

The common lesson across these systems is that memory quality comes from
lifecycle control — extraction, deduplication, contradiction handling,
validation, and retirement — not from adding a vector store. The RSI systems
that work keep an external evaluator and an archive; the ones that fail let
the optimizer define or contaminate its own objective.

## Decision

### Five tiers, two horizons

| Tier | Horizon | Scope and contents | Lifetime | Retrieval |
| --- | --- | --- | --- | --- |
| L0 working | Short-term | Current run's task brief, hypotheses, selected plan, tool observations, test output, open questions | One run attempt; not indexed | Always present, bounded by the run's context budget |
| L1 episodic | Short-term | Completed-run episode: problem, approach, outcome, failures, reviewer disposition, evidence pointers | Confirmed default 90 days; workspace-configurable within enterprise retention | Similarity to the current issue plus recency |
| L2 semantic | Long-term | Workspace facts: build/test commands, architecture notes, ownership, environment quirks, known flaky tests | Until superseded, contradicted, expired, or deleted | Hybrid keyword + vector search, scope-filtered |
| L3 procedural | Long-term | **Lessons** and playbooks: ordered steps with preconditions, anti-patterns, reviewer expectations | Versioned; reviewed or evidence-promoted | Applicability filter plus hybrid search |
| L4 institutional | Long-term | Enterprise/workspace policy, security rules, approval requirements | Human-authored, rarely changed | Always injected; never learned or rewritten by an agent |

Short-term memory is L0 + L1. Long-term memory is L2 + L3, with L4 as
non-negotiable policy. A **Lesson** is a durable L2/L3 item: a cited statement
or procedure learned from completed work in this workspace. A chat transcript
is not a Lesson. A single model assertion is not a Lesson.

Every tier is workspace-scoped. L4 may be inherited from an enterprise policy
set. There is no cross-workspace retrieval, shared embedding space, or
implicit enterprise-wide learning.

### Memory item contract

Every persisted item is immutable per version and carries:

| Field | Required meaning |
| --- | --- |
| `id`, `version` | Stable identity; every edit creates a new version |
| `enterprise_id`, `workspace_id` | Mandatory scope; never inferred from a request body |
| `kind` | `fact`, `lesson`, `playbook`, `anti_pattern`, `episode`, or `policy` |
| `scope` | Workspace, team, path prefix, language, or task family to which it applies |
| `statement` | The fact, lesson, or ordered playbook steps |
| `preconditions` | When the item is applicable; empty means broad and lowers the default trust weight |
| `evidence` | Run, issue, PR, commit, test, reviewer decision, or incident references; at least one for any active item |
| `provenance` | Author type, agent/model/config and prompt-template version, source run, trust class |
| `status` | `proposed`, `candidate`, `active`, `deprecated`, `retired`, or `quarantined` |
| `confidence` | Support and contradiction counts; not a self-reported model score |
| `valid_from`, `valid_to` | Temporal validity; supersession instead of destructive overwrite |
| `sensitivity` | Data class that constrains retrieval, export, and retention |
| `content_hash` | Canonical hash for idempotency and duplicate detection |
| `review` | Approver identity, timestamp, and the exact version approved |

The status machine is explicit:

- `proposed` → `candidate` after schema, evidence, redaction, and policy checks;
- `candidate` → `active` through the promotion rules below;
- `active` → `deprecated` on contradiction, staleness, or human decision;
- any state → `quarantined` on suspected poisoning, secret leakage, or a
  security report; quarantine removes the item from retrieval immediately;
- `retired` is terminal for normal use but retained for audit and for
  reproducing historical runs.

Contradiction never silently overwrites an item. A contradiction creates a
link, lowers confidence, and either supersedes the old item with a recorded
reason or leaves both visible as conflicting candidates.

### Authority and scope

Members may propose memory. Team leads or workspace owners promote, deprecate,
quarantine, and restore. Enterprise administrators own L4 policy and any
enterprise template publication. Agents may create `proposed` items and
retrieval feedback, but cannot approve, promote, delete, or alter policy.

Memory is advisory data. It cannot expand a capability grant, waive change
approval, approve a PR, change an evaluation, or modify its own access. The
dsh control plane remains the sole gate for tool actions. A lesson that says
"skip the test gate" is a policy violation and must be rejected or quarantined,
even if it was learned from a run that appeared successful.

### Enterprise template publication

The confirmed direction permits an enterprise administrator to publish a
scrubbed memory item as an enterprise template for other workspaces to adopt.
Publication is explicit and additive; it never creates a shared index or
implicit cross-workspace retrieval.

- Publication is an administrator action from one source workspace. There is
  no automatic propagation, background federation, or enterprise-wide
  similarity search.
- The item is scrubbed before publication: no raw source, repository names,
  issue or PR links, logs, credentials, customer or employee data, or
  workspace-specific identifiers. The template keeps its evidence class and a
  publication record, not the source evidence payload.
- Every template is immutable and versioned. Publishing a revision creates a
  new template version; adopting workspaces pin the version they adopted.
- Adoption is opt-in per workspace. It creates a local `candidate` copy with
  `provenance=enterprise_template`, which becomes `active` only through local
  validation and the promotion rule above, or by local human approval. An
  administrator's publication cannot make a template active in another
  workspace.
- Procedural templates require security review before publication and may not
  contain permission-expanding instructions, approval claims, or evaluator
  instructions.
- Revocation stops new adoption and marks adopted copies `deprecated` with a
  reason. It does not rewrite historical evidence or silently delete local
  copies; affected workspace owners are notified.
- An enterprise template is not L4 policy. Only an explicit enterprise policy
  publication can bind a workspace without local adoption.

### Write path: capture, distill, validate, promote, consolidate

**1. Capture outcomes, not narratives.** The orchestrator emits an outcome
envelope only when a run reaches a terminal state **and** the outcome is known:
change accepted/merged, rejected with a recorded reason, cancelled with a
reason, or failed with a classified cause. Timeouts, unknown delivery results,
and infrastructure failures are retained as episodes but are never used as
positive training evidence for a Lesson. Evidence comes from the dsh evidence
chain and delivery records, not from the agent's own success claim.

**2. Classify and redact before persistence.** Each item passes secret
scanning, PII minimization, and sensitivity classification. Store references
to sensitive artifacts and short, necessary excerpts rather than raw logs,
credentials, customer data, or full source files. Distillation model calls
follow ADR-0005 egress policy and receive only the current workspace's
material.

**3. Distill with a strict schema.** A reflection job extracts candidate
facts, lessons, anti-patterns, and playbooks. Every candidate must cite at
least one evidence reference and state its preconditions. Extractors cannot
invent test results, reviewer decisions, or merge state. Output is size-capped
and rejected if it contains instructions to expand permissions, bypass
approval, ignore policy, or address the evaluator.

**4. Validate before visibility.** Validation includes canonical dedupe,
semantic near-duplicate detection, contradiction search, scope consistency,
policy lint, prompt-injection and poisoning heuristics, and evidence
resolution. Failures keep the item as `proposed` for human review or discard
it; they never enter retrieval.

**5. Promote by risk.** The confirmed default for low-risk semantic `fact`
items is automatic promotion to `active` when there are at least two
independent supporting runs, no unresolved contradiction, passing validation,
and a non-negative offline evaluation delta. "Independent" means distinct runs
and evidence: a retried attempt or repackaged evidence does not count twice.
Automatic promotion does not apply to `lesson`, `playbook`, or `anti_pattern`
items; procedural content requires named human approval. Institutional policy
always requires human authorship and approval. A workspace can disable
automatic promotion, raise the evidence threshold, or require human approval
for every item without changing this ADR.

**6. Consolidate on a schedule.** A bounded background job merges duplicates,
recomputes support and contradiction counts, detects stale facts (for example,
a documented build command that no longer appears in the repository), expires
items past `valid_to`, decays unused candidates, and emits an auditable
consolidation report. Consolidation uses a small fixed operation vocabulary
(`merge`, `supersede`, `expire`, `deprecate`, `quarantine`), not free-form
rewriting of the corpus. This is the "sleep-time" phase: it runs outside a
remediation run and cannot advance delivery by itself.

**7. Delete and forget.** Workspace deletion, legal deletion, or a member's
verified erasure request removes the item and its embeddings, leaving only the
minimum non-sensitive tombstone required for audit. Deleted memory is never
silently re-derived from retained evidence without re-running this write path.

### Read path: retrieve, budget, cite, distrust

Before a run plans, the orchestrator requests a `MemoryBundle` from the memory
service. The bundle contains:

- mandatory L4 policy (always included, never counted against the retrieval
  budget);
- applicable active lessons and playbooks, ranked and deduplicated;
- relevant episodic summaries, with evidence pointers;
- workspace facts;
- the omitted-item count, the memory version, and a `degraded` flag.

Retrieval applies hard filters first — workspace, scope, status, sensitivity,
`valid_to`, and approval — then scores. A proposed score is:

```
relevance (hybrid BM25 + vector)
  + importance (support and reviewer salience)
  + recency (bounded half-life, not a recency takeover)
  + confidence (support minus contradiction)
  + provenance trust (human/QA evidence > test evidence > model inference)
  - contradiction penalty
```

Exact weights are configuration, stored as a versioned retrieval policy and
evaluated like any other memory change. Candidate items may appear only at
reduced weight, capped at two, and are labeled as unapproved.

The default context budget is **eight items or 1,500 tokens, whichever binds
first**, and never more than 15% of the model context. Omit rather than dilute:
if the best candidate is below the relevance floor, return fewer items. Every
item carries its id, version, trust class, applicability, and evidence links.

The prompt renders memory inside labeled data fences, with an explicit system
instruction that memory is untrusted reference material and never an
instruction. The agent must cite the lesson ids it used in its plan and change
summary, or state that no applicable lesson was used. A citation is a
provenance claim, not proof of correctness. Tool use remains governed by dsh
regardless of what memory says.

Conflicts are resolved conservatively: a newer human-approved item supersedes
an older one; an unresolved conflict injects neither item's contradictory
claim as fact but surfaces the conflict to the agent and reviewer. A lesson
that is expired, quarantined, or from another workspace is not eligible, even
if embedding search returns it.

### Bounded recursive self-improvement

RSI is a governed loop over memory and retrieval artifacts:

```
observe terminal outcomes
  → attribute success/failure/rework to evidence
  → propose memory, playbook, or retrieval changes
  → offline replay against a workspace golden set and hidden holdout
  → risk-based approval
  → canary on a small share of runs with the memory version pinned
  → promote or roll back
  → monitor for regressions, contradictions, and poisoning
```

The loop may improve only the targets allowed by its ladder:

| Risk | Target | Required gate |
| --- | --- | --- |
| A | Retrieval weights within configured bounds, ranking tie-breakers | Offline eval with no regression; automatic promotion allowed if the workspace enables it |
| B | Lesson promotion/deprecation, playbook content, prompt hint text | Offline eval plus named human approval |
| C | Retrieval-policy bounds, scope taxonomy, consolidation thresholds | Two-key approval: workspace owner plus security/quality reviewer |
| D | Capability grants, approval rules, evidence schema, evaluation definitions, safety policy, merge/deploy permissions | Forbidden to the loop; only a normal reviewed code/policy change can alter these |

Evaluation integrity is non-negotiable:

- the workspace has a curated golden set and a **hidden holdout** that the
  distiller and proposer cannot read;
- evaluation uses independent verifiers — tests, QA disposition, reviewer
  acceptance — not the agent's self-report;
- the learning loop cannot add its own evaluation cases to the acceptance
  set; eval changes follow normal review;
- promotions require a minimum sample and a confidence bound, not a single
  lucky run;
- holdouts rotate, and lessons that mention benchmark-specific fixtures are
  penalized;
- a candidate that improves success but increases rework, cost, or safety
  events is rejected.

The loop has a change budget (for example, a bounded number of promotions per
week and a token budget for reflection), a per-workspace kill switch, and an
automatic rollback trigger for a statistically meaningful regression or any
security event. Every run records the exact memory and retrieval-policy
version it used, so a bad promotion can be identified and reproduced.

### Guardrails against poisoning, injection, and collapse

- **Memory is data, never instruction.** Repository content, issue text, and
  prior model output are untrusted. Lessons derived from them inherit an
  untrusted provenance class until independent evidence and human review
  raise it. Rendering uses delimiters and instruction hierarchy; control and
  tool-call tokens are stripped.
- **The gate does not move.** A poisoned lesson cannot cause an out-of-grant
  action because dsh still denies it. Tests must prove this rather than assume
  it.
- **No self-approval.** An agent cannot approve its own memory, alter its own
  trust class, edit the evaluator, suppress evidence, or mark a failed run as
  successful.
- **Contradiction is visible.** Silent overwrites are prohibited. Confidence
  is derived from evidence counts, not model self-assessment.
- **Context collapse and drift are bounded.** Append-only versions, delta
  updates, size caps, dedupe, and periodic consolidation prevent the
  ever-growing, self-referential playbooks described in the ACE work.
- **Anomaly response.** A spike in candidates, repeated near-identical
  lessons, cross-workspace references, secret-scan hits, or lessons that
  mention approvals automatically quarantines the batch and notifies the
  workspace owner.
- **Rate limits.** Limits apply per run, per agent, and per workspace to
  prevent a single compromised run from flooding memory.

### Privacy, retention, and access

Memory inherits ADR-0008's content classes and retention controls. Raw content
capture is opt-in; metadata continuity does not imply raw replay. Sensitivity
classification constrains which roles and agents can retrieve an item,
whether it can be exported, and how long it is retained. Distillation never
sends another workspace's data to a model. Embeddings are treated as derived
sensitive data and are deleted with their source item. Access to quarantine
and evidence is separately authorized, mirroring ADR-0005.

### Storage, services, and API boundary

Memory is a control-plane service with its own transactional store; it is not
a table written directly by Pi. A practical implementation is PostgreSQL with
row-level workspace scoping, full-text search, and a vector index, plus an
immutable version/audit table and a transactional outbox for consolidation
events. Exact products remain implementation choices; the invariants do not.

The Node orchestrator calls the memory service and passes only the rendered
bundle to Pi. Pi receives no memory-admin credential and cannot write active
memory. dsh is unchanged and unaware of memory; it continues to enforce
capability grants independently.

Proposed `v1` surface (all authenticated and workspace-scoped):

| Operation | Purpose |
| --- | --- |
| `POST /v1/workspaces/{ws}/memory/search` | Internal retrieval; returns a bounded bundle with provenance |
| `POST /v1/workspaces/{ws}/memory/feedback` | Run outcome and per-item usefulness/contradiction feedback |
| `GET /v1/workspaces/{ws}/memory/items` | Human browse, filter, and diff by version |
| `POST /v1/workspaces/{ws}/memory/items/{id}/promote` | Human promotion with an explicit version |
| `POST /v1/workspaces/{ws}/memory/items/{id}/deprecate` | Human retirement with a reason |
| `POST /v1/workspaces/{ws}/memory/items/{id}/quarantine` | Security response |
| `GET /v1/workspaces/{ws}/memory/versions` | Retrieval-policy and corpus versions |
| `POST /v1/workspaces/{ws}/memory/eval-runs` | Offline replay and canary evaluation |

Writes are idempotent by content hash and carry optimistic concurrency
versions. Reads never accept an enterprise or workspace id from an
unauthenticated body. Pagination and export are bounded.

### Failure modes and degraded behavior

| Condition | Required behavior |
| --- | --- |
| Memory service unavailable | Remediation proceeds policy-only, marked `degraded`; no invented lessons; alert raised |
| Retrieval returns low-confidence items | Return fewer items and label the bundle sparse |
| Embedding model change | Versioned index, shadow reindex, dual-read comparison, then cut over; old runs remain reproducible |
| Contradictory or stale item | Exclude from factual injection, expose conflict, create a deprecation candidate |
| Suspected poisoning | Quarantine immediately, exclude from all bundles, notify owner, preserve audit |
| Deleted evidence or workspace | Tombstone and purge derived items; never reconstruct silently |
| Unknown delivery outcome | Episode only; never a positive lesson, never counted as success |
| Quota or rate limit | Shed candidate/background work first; mandatory policy and active lessons retain priority |

### Observability

Every retrieval, mutation, promotion, rollback, and quarantine is audited with
workspace, actor, item version, memory version, and run correlation. Metrics
include retrieval precision sampled by humans, citation rate, lesson reuse,
candidate acceptance, success-rate delta versus a control, rework and revert
rates, context and token cost, contradiction rate, quarantine count,
promotion and rollback counts, and cross-workspace access attempts. Dashboards
are workspace-scoped and label freshness and missing data; they never present
estimated or incomplete learning metrics as ground truth.

## Delivery plan

These are design-stage slices; none starts before this ADR is accepted and the
relevant contracts merge.

| Slice | Owner | Depends on | Acceptance focus |
| --- | --- | --- | --- |
| Memory schema, workspace isolation, immutable versions, audit | Backend Builder | ADR accepted | Cross-workspace substitution and deletion tests; row-level scope |
| Outcome capture, redaction, distillation, dedupe, consolidation | Backend Builder II | Schema | Known-outcome only; secret/PII tests; contradictory items never auto-active |
| Retrieval, ranking, budget, conflict handling, degraded mode, API contract | Backend Builder III | Schema | Contract fixtures; no cross-scope leakage; bundle reproducibility |
| RSI evaluation harness, approval gates, canary, rollback, budgets | Backend Builder | Retrieval + capture | Holdout isolation; no self-grading; regression blocks promotion |
| Memory governance UI: browse, diff, approve, quarantine, metrics | Frontend Builder | Contract merged into `main` | Contract checklist; no invented fields; workspace-scoped views |
| Documentation, runbook, and operator guidance | Doc Writer | ADR accepted | Explains retention, deletion, and incident response without claiming unimplemented controls |

## Consequences and rejected alternatives

The workspace gains cumulative, inspectable team memory and a measured
improvement loop, at the cost of a new service, evaluation work, privacy and
abuse handling, and ongoing curation. Memory can still be wrong; the design
therefore favors citation, conservative ranking, visible conflict, and easy
retirement over confident recall.

Rejected alternatives:

- **Fine-tuning workspace data into model weights.** Poor tenant isolation,
  no per-item provenance or deletion, expensive rollback, and no way to show
  a reviewer what was learned. Artifacts, not weights, are the unit of
  learning.
- **Per-user memory only.** The product is team-oriented; knowledge must
  survive reassignment and departure, with workspace authority.
- **A vector store plus chat history.** No lifecycle, no contradiction
  handling, no trust classes, no evaluation, and a large secret/PII surface.
- **Unrestricted self-modifying agents.** Violates ADR-0001/0005/0007 and
  makes evaluation and rollback impossible. The loop is bounded to memory and
  retrieval artifacts, with an external evaluator.
- **Learning from every model assertion.** Produces confident noise and
  poisoning. Only evidenced, terminal outcomes enter the write path.
- **Enterprise-wide memory by default.** Leaks one team's code and incidents
  into another workspace. Sharing requires explicit, scrubbed publication.

## Implementation acceptance

1. Substituting another workspace's id cannot read, search, export, or infer
   its memory; deletion purges items and embeddings and leaves only an
   auditable tombstone.
2. Short-term memory is bounded and expires at the confirmed 90-day default
   unless a workspace configures otherwise; raw secrets and unnecessary
   personal data never enter an item; content retention matches ADR-0008.
3. Automatic promotion applies only to `fact` items meeting the two-independent-
   run, no-unresolved-contradiction, passing-validation, and non-negative-
   evaluation rule; retries and repackaged evidence do not count as independent.
   `lesson`, `playbook`, `anti_pattern`, and policy items require human approval.
4. Enterprise template publication scrubs source-identifying content; adoption
   is opt-in, creates a local candidate, requires local promotion, and
   revocation deprecates adopted copies without rewriting history.
5. Every active long-term item has evidence, provenance, a version, and an
   explicit status; contradictory items are not silently overwritten.
6. A malicious or poisoned lesson cannot cause an out-of-grant tool action,
   cannot alter approval state, and cannot suppress evidence; quarantine
   removes it from all bundles.
7. Retrieval respects the token/item budget, cites item ids, labels unapproved
   candidates, and fails open for availability while policy remains
   fail-closed.
8. The RSI loop enforces the target ladder, separate evaluation, hidden
   holdout, human gates, canary, rollback, budgets, and a per-workspace kill
   switch; each run records the memory version it used.
9. Unknown or timed-out outcomes are never treated as success or used as
   positive evidence.
10. Memory outage degrades a run to policy-only with a visible label and does
    not block remediation or relax dsh.
11. Generated API contracts merge before dependent frontend work. Delivery
    uses main-based linked PRs, applicable checks, a new remote head,
    `in_review`, and an exact QA mention; done requires QA pass. This ADR
    certifies design only and creates no implemented memory service.
