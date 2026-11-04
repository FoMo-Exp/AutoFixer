# Workspace memory lifecycle v1 (DAT-235)

Contract for the last three stages of the ADR-0009 write path: **risk-graded
promotion**, **scheduled consolidation** (decay, staleness, expiration), and
the **deletion rules** that keep deleted memory deleted. It builds on the
storage contract (`docs/contracts/memory-schema-v1.md`, DAT-232) and composes
with the capture/distillation contract (`docs/contracts/memory-distillation-v1.md`,
DAT-233) and the candidate-admission gate (DAT-234).

Implementation lives in `node/src/memory/lifecycle/`. This document is a
documentation contract, not an HTTP API: promotion, consolidation, and
deletion are invoked by the memory service surface (DAT-236) and by the
scheduled job, never by an unauthenticated caller.

## 1. Risk-graded promotion

Status promotion to `active` is graded by the risk of what the memory says.
The confirmed default: low-risk semantic `fact` items may be promoted
automatically; everything procedural or institutional never is.

| Kind | Path to `active` |
| --- | --- |
| `fact` | Automatic when all gates pass, or named human approval |
| `lesson`, `playbook`, `anti_pattern` | Named human approval of the exact version, always |
| `policy` | Human authorship **and** named human approval, always |
| `episode` | Never promoted through this path; episodes are captured |

The automatic rule for `fact` items is a conjunction, fail closed on every
term:

1. the item is in `candidate` state (it passed admission);
2. at least **two independent supporting runs** (below threshold is never
   `active`);
3. no **unresolved contradiction** — no `contradicts` link whose other
   endpoint is still `proposed`, `candidate`, or `active`;
4. **passing validation** — the admission gate's disposition is `admitted`;
5. a **non-negative offline evaluation delta** — an evaluation that never ran
   is not a non-negative delta, and neither is a non-finite one: a `NaN` or
   `Infinity` delta is rejected with `evaluation_invalid` rather than slipping
   through a comparison, and it is recorded as a null delta in the audit row.

Every assessment is persisted in `memory_promotion_decisions` — promoted or
blocked, with the fixed reason codes in `PROMOTION_BLOCK_REASONS`, the
independent-run count, the evaluation delta, and a digest of the promotion
policy in force. "Below threshold stays inactive" is therefore auditable, not
silent.

### 1.1 Independent supporting runs

"A retried attempt or repackaged evidence does not count twice." The single
definition is `assessIndependentSupport` over a **support ledger** supplied
by the outcome-capture path (one entry per contributing run):

1. only a run with a **known terminal outcome** supports anything —
   `timeout`, `unknown`, and `infra_failure` outcomes are never support;
2. observations naming the same `run_id` are one run;
3. a run counts only if it contributes at least one evidence citation —
   identified by its `(evidence_type, reference)` pair — that no earlier
   supporting run contributed: a retry over the same work repackages the same
   citations and collapses, while two distinct runs bring their own `run`
   evidence and both count;
4. a run with no citations is not support.

### 1.2 Workspace promotion policy

`memory_promotion_policy` holds per-workspace settings: disable automatic
fact promotion (`auto_promote_facts: false`), raise the evidence threshold
(`fact_min_independent_runs > 2`), or require human approval for every item
(`require_human_approval_all: true`). A workspace can only tighten the ADR
defaults: the threshold has no setting below 2, and procedural content is not
governed by this policy at all.

### 1.3 Named human approval

`approveAndPromote` stamps the approving actor on the exact content version
(`review`, set-once) and then activates. The storage layer enforces the rule
independently: `setStatus` to `active` refuses a `lesson`, `playbook`,
`anti_pattern`, or `policy` item whose current version carries no approval
stamp, and a `policy` version whose author is not human is refused at
creation. A caller bypassing the service gains nothing.

## 2. Scheduled consolidation

`runConsolidation` is the bounded "sleep-time" job; `scheduleMemoryConsolidation`
is the fixed-interval trigger around it. It runs outside a remediation run,
never promotes an item, touches only the memory store, and cannot advance
delivery by itself.

### 2.1 Fixed operation vocabulary

Every corpus change is exactly one of:

| Op | Meaning |
| --- | --- |
| `merge` | Absorb an exact content duplicate into its canonical item |
| `supersede` | Record succession: link, close the previous window, deprecate |
| `expire` | Deprecate an item whose validity window has passed |
| `deprecate` | Retire from active use (staleness, decay, retirement proposal) |
| `quarantine` | Remove from retrieval on a security report |

There is no free-form rewriting and no sixth operation. A consolidation run
either applies one of these five or does nothing; each applied or skipped
operation is recorded with a fixed reason code from
`CONSOLIDATION_OP_REASONS`. The job **never creates or restores an item or a
content version** — merge folds evidence between live items and retires the
absorbed duplicates, so nothing in this slice can resurrect deleted memory.

### 2.2 Duties, in fixed pass order

1. **Merge duplicates.** Items whose current versions share one
   `content_hash` (exact duplicates; the hash covers kind, scope, statement,
   preconditions, sensitivity). The canonical survivor is chosen
   deterministically (status rank, then age, then id). Missing evidence
   citations are folded into the canonical by `(evidence_type, reference)`,
   the pair is linked (`related`, reason `duplicate_content`), and the
   absorbed duplicate is retired through `deprecated`. Absorbed duplicates
   keep their rows for audit; deletion is a separate, explicit path.
2. **Recompute confidence counters.** `support_count` is the number of
   distinct evidence citations; `contradiction_count` is the number of
   unresolved contradictions. Derived metadata: the audit is the
   consolidation run record (`counts_recomputed`), not a per-item event.
3. **Detect stale facts.** An `active` `fact` item is deprecated only when an
   injected `FactVerifier` reports `stale` (for example, a documented build
   command that no longer appears in the repository). No verifier, or
   `unknown`, means nothing is touched — consolidation invents no staleness
   signals.
4. **Expire.** An item whose current version's `valid_to` has passed is
   deprecated (reason `past_valid_to`). Validity is set-once, so an expired
   item never silently returns; a human may still retire or restore it.
5. **Decay unused candidates.** A `candidate` older than the decay window
   (default 30 days) with no evidence added and no recorded use in the window
   is deprecated (reason `unused_decay`). Usage arrives as retrieval citation
   stats (seam); absent stats, nothing counts as used.
6. **Decide proposals.** Recorded retirement proposals (the admission gate's
   contradiction handling) and security-report quarantine requests are
   executed as `supersede` / `deprecate` / `quarantine` operations.

Quarantined and retired items are never touched by any pass. Every pass
re-reads the item at operation time, so a run is safe against its own earlier
passes.

### 2.3 Bounds and the report

One run scans at most `max_items_scanned` items (default 500, hard cap 1000)
and attempts at most `max_ops` operations (default 50, hard cap 200). A
budget stop is recorded (`budget_exhausted`), never silently truncated.

The report is persisted in `memory_consolidation_runs` (status, times, scan
and op counts) and `memory_consolidation_ops` (op, item, target, reason code,
applied flag, counts-only detail). Together with the standard `memory_events`
trail written by the underlying mutations, every consolidation action is
auditable without persisting any memory content. Columns hold opaque ids,
fixed enums, counts, and timestamps only.

### 2.4 Production trigger

`createMemoryConsolidationRunner` is the deployment's trigger and is
registered by the orchestrator whenever the identity control plane is
enabled: `createOrchestrator` builds the runner, `start()` begins the
schedule after the service is listening, and `stop()` ends it before the
control-plane database closes. Each tick consolidates every **active**
workspace of the enterprise under its own `WorkspaceScope`, and archived
workspaces are skipped. A failed workspace pass is reported through
`onError` and never blocks the remaining workspaces; a failed tick never ends
the schedule. The cadence is `FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS`
(default six hours, positive integer). The timer never holds the process
open.

## 3. Deletion and the no-rebuild rule

- `deleteItem` purges the item with its versions, evidence, links, and
  embeddings and leaves one minimal `item_deleted` tombstone; `eraseWorkspace`
  does the same per item. Tombstones and audit events never carry statements,
  hashes, or provenance.
- **Deleted memory is never silently rebuilt from retained evidence.**
  Re-deriving content requires re-running the full write path — capture,
  distill, validation, admission — which yields a new `proposed` item with a
  full audit trail, never an `active` one. No lifecycle code path creates,
  restores, or re-activates content as a side effect of retained evidence:
  consolidation proposals naming a deleted identity are recorded as skipped
  (`item_deleted`) and nothing is re-derived; merge only folds evidence
  between live items; promotion only moves existing items along the state
  machine.
- `MemoryTombstoneRepository.getByItem` lets callers distinguish "deleted"
  from "never existed" for exactly this purpose.

## 4. Seams to adjacent slices

External facts arrive through injected interfaces, never bare assertions:

| Seam | Backed by | Used for |
| --- | --- | --- |
| `RunSupport[]` (support ledger) | outcome capture (DAT-233) | independent-run counting |
| `ValidationStanding` | candidate admission (DAT-234) | the "passing validation" gate |
| `EvaluationStanding` | offline replay harness (RSI slice) | the non-negative delta gate |
| `FactVerifier` | repository probes | stale-fact detection |
| `UsageStat[]` | retrieval citation tracking | unused-candidate decay |
| `ProposedOp[]` | admission retirement proposals, security reports | supersede / deprecate / quarantine |

## 5. Tables (control-plane migration version 8)

| Table | Purpose | Lifetime |
| --- | --- | --- |
| `memory_promotion_policy` | Per-workspace promotion settings | Cascades with the workspace |
| `memory_promotion_decisions` | Every promotion assessment, promoted or blocked | Audit; outlives items |
| `memory_consolidation_runs` | Consolidation run summary | Audit; outlives items |
| `memory_consolidation_ops` | Applied or skipped operations | Audit; outlives items |

Migration version 8: main already carries v5 (DAT-247), v6 (DAT-204), and v7
(the candidate-admission gate DAT-234, renumbered when it merged), so this
unmerged block takes the next free version immediately after the admission
gate it builds on. Renumbering an unmerged block costs nothing and no merged
migration is touched; a duplicate version would silently skip this schema.
All four tables are additive; nothing existing is rebuilt.

## 6. Bounds

Policy fields are closed booleans plus one integer (≥ 2). Reason codes and
operations are closed enums checked at the persistence boundary. Consolidation
scan and op budgets are capped as in §2.3. Decision and report rows are
counts, enums, digests, and opaque ids — no memory content crosses into the
surviving audit surface.
