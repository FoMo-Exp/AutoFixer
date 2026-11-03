/**
 * Promotion, consolidation, and deletion lifecycle types (DAT-235).
 *
 * This slice implements the ADR-0009 write path's last three stages:
 * risk-graded promotion, the scheduled consolidation job, and the deletion
 * rules that keep deleted memory deleted. Everything here is workspace-scoped
 * and works only through the scoped memory repositories; there is no path
 * from this module to another workspace's rows.
 *
 * Three fixed vocabularies shape the surface:
 *
 * - `PROMOTION_BLOCK_REASONS` — why a promotion assessment did not promote.
 * - `CONSOLIDATION_OPS` — the closed set of corpus-changing operations the
 *   consolidation job may perform: `merge`, `supersede`, `expire`,
 *   `deprecate`, `quarantine`. Consolidation never rewrites the corpus in
 *   free form and never creates or restores an item.
 * - `CONSOLIDATION_OP_REASONS` — fixed reason codes for applied and skipped
 *   operations, so a consolidation report is auditable without persisting any
 *   memory content.
 *
 * External facts arrive through small injected seams (support ledger,
 * evaluation delta, fact verifier, usage stats, proposed operations). Each
 * seam is backed by another slice's records — the outcome-capture path, the
 * offline evaluation harness, retrieval citation tracking, the admission
 * gate's retirement proposals — and is never a caller's bare assertion of
 * trust.
 */

import type { MemoryEvidenceType, MemoryItemId, MemoryItemRecord, MemoryKind } from "../types.js";

// ---------------------------------------------------------------------------
// Workspace promotion policy
// ---------------------------------------------------------------------------

/**
 * Per-workspace promotion policy. A workspace may disable automatic
 * promotion, raise the evidence threshold, or require human approval for
 * every item. It can never weaken the ADR-0009 defaults: the threshold has
 * no lower setting than two independent runs, and procedural content is not
 * governed by this policy at all — it always requires named human approval.
 */
export interface MemoryPromotionPolicy {
  /** May low-risk `fact` items be promoted without a human at all. */
  auto_promote_facts: boolean;
  /** Independent supporting runs required for automatic fact promotion (≥ 2). */
  fact_min_independent_runs: number;
  /** Require named human approval for every item, including facts. */
  require_human_approval_all: boolean;
}

/** The ADR-0009 confirmed defaults. */
export const DEFAULT_PROMOTION_POLICY: MemoryPromotionPolicy = {
  auto_promote_facts: true,
  fact_min_independent_runs: 2,
  require_human_approval_all: false,
};

// ---------------------------------------------------------------------------
// Evidence identity and the support ledger seam
// ---------------------------------------------------------------------------

/**
 * One evidence citation, identified by its `(evidence_type, reference)` pair
 * and by nothing else: `pr:42` and `issue:42` are different pieces of
 * evidence that happen to share a reference string.
 */
export interface EvidenceCitation {
  evidence_type: MemoryEvidenceType;
  reference: string;
}

/**
 * What the outcome-capture path recorded about one run's support for an item.
 *
 * The gate never trusts a caller's assertion that support exists: the caller
 * supplies what capture recorded, one entry per contributing run, and the
 * independence rules below decide how much of it is independent.
 */
export interface RunSupport {
  run_id: string;
  /**
   * The run reached a known terminal outcome. A timeout, unknown delivery
   * result, or infrastructure failure never supports anything and is never
   * counted, whatever evidence it carries.
   */
  known_outcome: boolean;
  /** The evidence this run contributed to the item. */
  evidence: readonly EvidenceCitation[];
}

// ---------------------------------------------------------------------------
// Promotion assessment
// ---------------------------------------------------------------------------

/**
 * What the candidate-admission gate (DAT-234) decided about the item's
 * validation: `admitted` is the only standing that counts as "passing
 * validation" for automatic promotion.
 */
export interface ValidationStanding {
  disposition: "admitted" | "merged" | "held" | "discarded";
}

/**
 * The offline evaluation delta of promoting this item, as measured by the
 * workspace's replay harness. Absent means no evaluation ran — which is not
 * a non-negative delta and blocks automatic promotion (fail closed).
 */
export interface EvaluationStanding {
  /** Success-rate delta versus control; zero or positive passes. */
  delta: number;
  /** Opaque correlation id of the evaluation run, when one produced it. */
  eval_run_id?: string;
}

export const PROMOTION_BLOCK_REASONS = [
  /** The item is not in `candidate` state; only candidates auto-promote. */
  "not_candidate_status",
  /** lesson / playbook / anti_pattern: procedural content is never automatic. */
  "procedural_requires_human_approval",
  /** policy: institutional policy always requires named human approval. */
  "policy_requires_human_approval",
  /** episode or any other kind with no automatic promotion path. */
  "not_auto_promotable_kind",
  /** The workspace requires human approval for every item. */
  "human_approval_required",
  /** The workspace disabled automatic fact promotion. */
  "auto_promotion_disabled",
  /** Fewer independent supporting runs than the policy threshold. */
  "independent_support_below_threshold",
  /** A contradiction link whose other side is still open. */
  "unresolved_contradiction",
  /** The admission gate did not admit the item. */
  "validation_not_passed",
  /** No offline evaluation ran for this item. */
  "evaluation_missing",
  /** The offline evaluation delta was negative. */
  "evaluation_negative",
  /** The item has no stored evidence reference at all. */
  "evidence_missing",
] as const;

export type PromotionBlockReason = (typeof PROMOTION_BLOCK_REASONS)[number];

/** Reasons recorded on a promotion decision row. */
export type PromotionReason = PromotionBlockReason | "auto_promoted" | "human_approved";

export interface PromotionDecision {
  item_id: MemoryItemId;
  item_version: number;
  kind: MemoryKind;
  outcome: "promoted" | "blocked";
  /** All reasons in assessment order; empty only for a clean promotion. */
  reasons: PromotionReason[];
  /** Independent supporting runs counted from the support ledger. */
  independent_support_runs: number;
  /** The evaluation delta used, or null when none was supplied. */
  evaluation_delta: number | null;
}

// ---------------------------------------------------------------------------
// Consolidation: fixed operation vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of corpus-changing consolidation operations
 * (ADR-0009). Not free-form rewriting: a consolidation run either applies
 * one of these five operations or does nothing.
 */
export const CONSOLIDATION_OPS = [
  "merge",
  "supersede",
  "expire",
  "deprecate",
  "quarantine",
] as const;

export type ConsolidationOp = (typeof CONSOLIDATION_OPS)[number];

export const CONSOLIDATION_OP_REASONS = [
  /** merge: an exact content duplicate was absorbed into the canonical item. */
  "duplicate_content",
  /** expire: the current version's validity window has passed. */
  "past_valid_to",
  /** deprecate: an affirmative staleness verdict for an active fact. */
  "stale_fact",
  /** deprecate: an unused candidate aged past the decay window. */
  "unused_decay",
  /** supersede / deprecate: executing a recorded retirement proposal. */
  "retirement_proposal",
  /** quarantine: a security report named the item. */
  "security_report",
  /** Skipped: the target was deleted; deleted memory is never rebuilt. */
  "item_deleted",
  /** Skipped: the target does not exist (or exists in another workspace). */
  "item_missing",
  /** Skipped: the item's status makes the operation a no-op or forbidden. */
  "status_not_applicable",
] as const;

export type ConsolidationOpReason = (typeof CONSOLIDATION_OP_REASONS)[number];

/** One operation in a consolidation report: applied or skipped, never vague. */
export interface ConsolidationOpRecord {
  op: ConsolidationOp;
  item_id: MemoryItemId;
  /** Merge canonical, supersession successor, or null for single-item ops. */
  target_item_id: MemoryItemId | null;
  item_version: number | null;
  reason_code: ConsolidationOpReason;
  applied: boolean;
  /** Counts only: e.g. `{ evidence_folded: 2 }`. Never memory content. */
  detail: Record<string, number>;
}

export interface ConsolidationReport {
  run_id: string;
  /**
   * `running` is only ever seen by readers: a crashed run stays visibly
   * `running` rather than pretending to have completed.
   */
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string;
  items_scanned: number;
  /** Items whose derived confidence counters were recomputed. */
  counts_recomputed: number;
  ops: ConsolidationOpRecord[];
  ops_applied: number;
  ops_skipped: number;
  /** True when a bound stopped the run before the corpus was fully covered. */
  budget_exhausted: boolean;
}

// ---------------------------------------------------------------------------
// Consolidation seams and bounds
// ---------------------------------------------------------------------------

/**
 * A repository-backed probe that answers whether an active fact still holds
 * (for example, whether a documented build command still appears in the
 * repository). The job invents no staleness signals: absent a verifier — or
 * on `unknown` — nothing is deprecated.
 */
export interface FactVerifier {
  verify(record: MemoryItemRecord): "fresh" | "stale" | "unknown";
}

/** Retrieval-side usage of one item, for the unused-candidate decay rule. */
export interface UsageStat {
  item_id: MemoryItemId;
  use_count: number;
  /** Last citation or retrieval, RFC 3339; null when never used. */
  last_used_at: string | null;
}

/**
 * A recorded proposal the consolidation job may decide. Retirement proposals
 * come from the admission gate's contradiction handling; quarantine requests
 * come from a security report. Executing a proposal is an audited operation;
 * a proposal whose target was deleted is skipped, never re-derived.
 */
export interface ProposedOp {
  op: "supersede" | "deprecate" | "quarantine";
  item_id: MemoryItemId;
  /** Required for `supersede`; ignored otherwise. */
  successor_item_id?: MemoryItemId;
  reason_code: ConsolidationOpReason;
}

/** Hard bounds of one consolidation run. The job is bounded by construction. */
export interface ConsolidationOptions {
  /** Evaluation instant (RFC 3339); defaults to now. Tests pin it. */
  at?: string;
  /** Items inspected per run; default 500, hard cap 1000. */
  max_items_scanned?: number;
  /** Operations attempted per run; default 50, hard cap 200. */
  max_ops?: number;
  /** Candidate decay window in days; default 30. */
  decay_unused_days?: number;
  /** Staleness probe; absent means no item is ever reported stale. */
  verifier?: FactVerifier;
  /** Retrieval usage stats; absent means nothing counts as used. */
  usage?: readonly UsageStat[];
  /** Retirement and quarantine proposals to decide. */
  proposals?: readonly ProposedOp[];
}

export const DEFAULT_CONSOLIDATION_BOUNDS = {
  max_items_scanned: 500,
  max_ops: 50,
  decay_unused_days: 30,
} as const;

export const MAX_CONSOLIDATION_ITEMS_SCANNED = 1000;
export const MAX_CONSOLIDATION_OPS = 200;
