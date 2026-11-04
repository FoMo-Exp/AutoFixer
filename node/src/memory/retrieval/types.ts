/**
 * Bounded workspace-memory retrieval types (DAT-236).
 *
 * The retrieval path is read-only with respect to memory: it never promotes,
 * re-weights, or rewrites an item. What it produces is a `MemoryBundle` — a
 * bounded, cited, reproducible view of the workspace's eligible memory — plus
 * an audit row naming the policy version and the exact item versions it used.
 *
 * Memory is untrusted data (ADR-0009): nothing in a bundle may grant a
 * capability, approve a change, or instruct a tool. `dsh` remains the only
 * execution gate; the bundle only ever reaches a prompt inside a labeled data
 * fence.
 */

import type { WorkspaceRole, UserId } from "../../control-plane/types.js";
import type {
  MemoryApplicability,
  MemoryEvidenceType,
  MemoryKind,
  MemoryProvenance,
  MemoryReview,
  MemorySensitivity,
  MemoryStatus,
  MemoryTrust,
} from "../types.js";

// ---------------------------------------------------------------------------
// Contract version and hard ceilings
// ---------------------------------------------------------------------------

/** Bundle contract version; additive evolution only within a version. */
export const MEMORY_BUNDLE_VERSION = 1;

/**
 * Hard ceilings. A retrieval policy may be stricter, never looser: these are
 * enforced in code, not only in the versioned policy row, so a corrupt or
 * hostile policy version cannot turn retrieval into an unbounded context
 * stuffing channel.
 */
export const RETRIEVAL_HARD_LIMITS = Object.freeze({
  max_items: 24,
  max_tokens: 8_000,
  max_context_share: 0.2,
  candidate_max: 2,
  query_chars: 2_000,
  candidate_pool: 500,
  /** Mandatory L4 policy read bound; exceeding it fails closed. */
  policy_pool: 1_000,
  /** Smallest context window a caller may claim; smaller is rejected. */
  min_context_window_tokens: 1_000,
  max_context_window_tokens: 2_000_000,
});

/** ADR-0009 defaults: eight items or 1,500 tokens, never over 15% of context. */
export const RETRIEVAL_DEFAULTS = Object.freeze({
  max_items: 8,
  max_tokens: 1_500,
  max_context_share: 0.15,
  context_window_tokens: 32_000,
  relevance_floor: 0.08,
  candidate_weight: 0.5,
  candidate_max: 2,
  recency_half_life_days: 30,
});

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** ADR-0009 tiers reachable from stored kinds (L0 is the run's own context). */
export type MemoryTier = "L1" | "L2" | "L3" | "L4";

export function tierOf(kind: MemoryKind): MemoryTier {
  switch (kind) {
    case "episode":
      return "L1";
    case "fact":
      return "L2";
    case "lesson":
    case "playbook":
    case "anti_pattern":
      return "L3";
    case "policy":
      return "L4";
  }
}

// ---------------------------------------------------------------------------
// Versioned retrieval policy
// ---------------------------------------------------------------------------

export interface RetrievalWeights {
  /** Hybrid BM25 + vector relevance. */
  relevance: number;
  /** Support and reviewer salience. */
  importance: number;
  /** Bounded recency signal (half-life decay). */
  recency: number;
  /** Support minus contradiction, from evidence counts. */
  confidence: number;
  /** Provenance trust class plus evidence-class boost. */
  trust: number;
  /** Subtracted for each unresolved contradictory partner. */
  contradiction: number;
}

export interface RetrievalBounds {
  /** Effective budget ceiling for one bundle. */
  max_items: number;
  max_tokens: number;
  /** Share of the model context window memory may occupy. */
  max_context_share: number;
  /** Context window assumed when the caller does not state one. */
  context_window_tokens: number;
  /** Best item below this relevance is omitted rather than diluted. */
  relevance_floor: number;
  /** Multiplier applied to candidate (unapproved) items. */
  candidate_weight: number;
  /** Candidates that may appear in one bundle. */
  candidate_max: number;
  /** Recency half-life in days. */
  recency_half_life_days: number;
  /** Trust weight per provenance class. */
  trust_class_weights: Record<MemoryTrust, number>;
  /** Additional weight for the strongest evidence class present. */
  evidence_class_boost: Record<MemoryEvidenceType, number>;
}

export interface RetrievalPolicy {
  weights: RetrievalWeights;
  /** Relative weight of the lexical and vector halves of the hybrid score. */
  hybrid_weights: { lexical: number; vector: number };
  bounds: RetrievalBounds;
}

export interface RetrievalPolicyRecord {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  version: number;
  policy: RetrievalPolicy;
  policy_hash: string;
  created_at: string;
  created_by: UserId;
}

// ---------------------------------------------------------------------------
// Search request / response
// ---------------------------------------------------------------------------

/** Why the bundle is being requested; decides the sensitivity ceiling. */
export type MemoryRetrievalPurpose = "run_plan" | "review" | "browse" | "eval_replay";

export interface MemorySearchRequest {
  purpose: MemoryRetrievalPurpose;
  /** The task/issue text the run is planning against; never an instruction. */
  query: string;
  /** Run context used purely for applicability matching, not authority. */
  scope?: MemoryApplicability;
  /** Path/task context for matching; mirrors `scope` for older callers. */
  path_prefix?: string;
  run_id?: string;
  /** Caller's model context window; the 15% share is computed from it. */
  context_window_tokens?: number;
  /** Requested budget; clamped down to the policy and hard ceilings. */
  max_items?: number;
  max_tokens?: number;
  /** Query embedding from the gateway; absent means lexical-only scoring. */
  query_embedding?: MemoryQueryEmbedding;
  /** Pin the policy version (reproducing a historical run). */
  policy_version?: number;
  /** Caller role used for the sensitivity ceiling; never trusted as a grant. */
  role: WorkspaceRole;
  /**
   * Include unapproved candidates at reduced weight (default true). A caller
   * may disable them entirely; it cannot raise their weight or cap.
   */
  include_candidates?: boolean;
}

export interface MemoryQueryEmbedding {
  model: string;
  vector: number[];
}

export type MemoryDegradedReason =
  "memory_unavailable" | "policy_unavailable" | "retrieval_error" | null;

export interface MemoryScoreBreakdown {
  relevance: number;
  importance: number;
  recency: number;
  confidence: number;
  trust: number;
  contradiction_penalty: number;
  total: number;
}

export interface MemoryBundleEvidence {
  evidence_type: MemoryEvidenceType;
  reference: string;
}

/** One injected memory item: cited, bounded, and explicitly untrusted data. */
export interface MemoryBundleItem {
  item_id: string;
  item_version: number;
  kind: MemoryKind;
  tier: MemoryTier;
  status: MemoryStatus;
  statement: string;
  preconditions: string[];
  applicability: MemoryApplicability;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  /** Whether a named human approved this exact version. */
  approved: boolean;
  /** True when the item is injected at reduced weight as unapproved. */
  candidate: boolean;
  evidence: MemoryBundleEvidence[];
  valid_from: string;
  valid_to: string | null;
  content_hash: string;
  conflicts_with: string[];
  token_estimate: number;
  score: MemoryScoreBreakdown;
}

export interface MemoryConflictParty {
  item_id: string;
  item_version: number;
  statement: string;
  trust: MemoryTrust;
  approved: boolean;
}

/**
 * A visible conflict. Neither side is injected as fact; both are surfaced to
 * the agent and the reviewer with their citations intact.
 */
export interface MemoryConflict {
  item_ids: [string, string];
  reason: string;
  /** True when a newer approved item supersedes the older claim. */
  resolved: boolean;
  /** The winning item for a resolved conflict; null when unresolved. */
  winner_item_id: string | null;
  parties: MemoryConflictParty[];
}

export interface MemoryBundleBudget {
  max_items: number;
  max_tokens: number;
  context_window_tokens: number;
  max_context_share: number;
  used_items: number;
  used_tokens: number;
  /** Eligible items left out of this bundle. */
  omitted_count: number;
}

/**
 * The deterministic digest of the memory corpus a bundle was assembled from.
 * Two bundles with the same `memory_version` read the same item versions and
 * the same policy version.
 */
export interface MemoryVersionRef {
  memory_version: string;
  policy_version: number;
  policy_hash: string;
}

export interface MemoryBundle {
  bundle_id: string;
  schema_version: number;
  purpose: MemoryRetrievalPurpose;
  enterprise_id: string;
  workspace_id: string;
  version: MemoryVersionRef;
  degraded: boolean;
  degraded_reason: MemoryDegradedReason;
  /** True when the bundle is thin or empty relative to the eligible corpus. */
  sparse: boolean;
  budget: MemoryBundleBudget;
  /** Mandatory L4 policy; never counted against the retrieval budget. */
  policy_items: MemoryBundleItem[];
  /** Lessons, playbooks, and anti-patterns (L3), best first. */
  lessons: MemoryBundleItem[];
  /** Episodes (L1), best first. */
  episodes: MemoryBundleItem[];
  /** Facts (L2), best first. */
  facts: MemoryBundleItem[];
  /** Unapproved candidates at reduced weight, capped, clearly labeled. */
  candidates: MemoryBundleItem[];
  conflicts: MemoryConflict[];
  /** Signals available to this bundle, for honest evaluation. */
  signals: {
    lexical: boolean;
    vector: boolean;
    /** Why the vector half of the hybrid score was unavailable. */
    vector_unavailable_reason: string | null;
  };
  /**
   * The untrusted-data boundary. Memory never authorizes tool use, approval,
   * capability grants, or policy changes; dsh remains the sole gate.
   */
  trust_boundary: {
    memory_is_untrusted_data: true;
    instructions_allowed: false;
    tool_control_authority: "dsh";
    citations_required: true;
    render_fence: "memory";
  };
  created_at: string;
}

/**
 * One ranked item in a preview assembled under an unpublished policy.
 *
 * A preview exists for offline replay (DAT-238): the learning loop must be
 * able to measure a candidate policy against the stored corpus without making
 * that policy retrievable by any run. It is never recorded as a retrieval run
 * and never carries a version reference.
 */
export interface MemoryPreviewItem {
  item_id: string;
  item_version: number;
  kind: MemoryKind;
  tier: MemoryTier;
  candidate: boolean;
  approved: boolean;
  token_estimate: number;
  score: MemoryScoreBreakdown;
}

export interface MemoryPreview {
  /** Canonical hash of the policy used; never a stored policy version. */
  policy_hash: string;
  items: MemoryPreviewItem[];
  used_items: number;
  used_tokens: number;
  omitted_count: number;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const MEMORY_FEEDBACK_OUTCOMES = [
  "accepted",
  "merged",
  "rejected",
  "cancelled",
  "failed",
  "unknown",
] as const;
export type MemoryFeedbackOutcome = (typeof MEMORY_FEEDBACK_OUTCOMES)[number];

export interface MemoryFeedbackItem {
  item_id: string;
  item_version: number;
  useful?: boolean | null;
  contradicted?: boolean;
}

export interface MemoryFeedbackInput {
  bundle_id: string;
  run_id: string;
  outcome: MemoryFeedbackOutcome;
  items?: MemoryFeedbackItem[];
  note?: string;
}

export interface MemoryFeedbackRecord {
  feedback_id: string;
  bundle_id: string;
  run_id: string;
  outcome: MemoryFeedbackOutcome;
  items: MemoryFeedbackItem[];
  created_at: string;
  created_by: UserId;
}

// ---------------------------------------------------------------------------
// Human browse surface
// ---------------------------------------------------------------------------

export interface MemoryItemsFilter {
  kind?: MemoryKind;
  status?: MemoryStatus;
  tier?: MemoryTier;
  /**
   * Applicability filters (DAT-251). An item field that is set must match the
   * filter; an item field that is empty means broad applicability and matches
   * every value. Path prefixes match on segment boundaries.
   */
  team_id?: string;
  path_prefix?: string;
  language?: string;
  task_family?: string;
  /** Exact match on the current version's provenance trust class. */
  trust?: MemoryTrust;
  /**
   * Exact match on the current version's data class. The caller's own
   * sensitivity ceiling still applies first: a filter can narrow a browse, it
   * cannot widen what the role may read.
   */
  sensitivity?: MemorySensitivity;
  limit?: number;
  cursor?: string;
}

export interface MemoryItemView {
  item_id: string;
  status: MemoryStatus;
  current_version: number;
  versions_count: number;
  kind: MemoryKind;
  tier: MemoryTier;
  /**
   * The current statement. `null` exactly when `statement_redacted` is true:
   * a quarantined item's content is never served by this surface.
   */
  statement: string | null;
  preconditions: string[];
  applicability: MemoryApplicability;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  approved: boolean;
  valid_from: string;
  valid_to: string | null;
  content_hash: string;
  support_count: number;
  contradiction_count: number;
  evidence: MemoryBundleEvidence[];
  updated_at: string;
  /**
   * True when the statement and preconditions were withheld (quarantine).
   * Optional so DAT-236 clients that predate this field keep working; the
   * service always sets it.
   */
  statement_redacted?: boolean;
  /** Provenance of the current version (optional, additive since DAT-251). */
  provenance?: MemoryProvenance;
  /** Exact-version human approval, or null when none (optional, additive). */
  review?: MemoryReview | null;
}

export interface MemoryItemsPage {
  items: MemoryItemView[];
  next_cursor: string | null;
}

export interface MemoryVersionSummary {
  item_id: string;
  current_version: number;
  versions: Array<{ version: number; content_hash: string; created_at: string }>;
}

export interface MemoryVersionsView {
  schema_version: number;
  memory_version: string;
  retrieval_policy: {
    version: number;
    policy_hash: string;
    weights: RetrievalWeights;
    bounds: RetrievalBounds;
  };
  policy_versions: Array<{ version: number; policy_hash: string; created_at: string }>;
  corpus: {
    items: number;
    active_items: number;
    versions: number;
    last_updated_at: string | null;
  };
  /** Bounded per-item version index for diffing; never item content history. */
  items: MemoryVersionSummary[];
}

// ---------------------------------------------------------------------------
// Evaluation records (RSI owns proposal/approval; this surface only records)
// ---------------------------------------------------------------------------

export const MEMORY_EVAL_KINDS = ["offline_replay", "canary"] as const;
export type MemoryEvalKind = (typeof MEMORY_EVAL_KINDS)[number];

export const MEMORY_EVAL_VERDICTS = ["pass", "fail", "inconclusive"] as const;
export type MemoryEvalVerdict = (typeof MEMORY_EVAL_VERDICTS)[number];

export interface MemoryEvalMetrics {
  success_rate_delta?: number;
  rework_rate_delta?: number;
  cost_delta?: number;
  safety_events?: number;
  sample_size: number;
}

export interface MemoryEvalRunInput {
  kind: MemoryEvalKind;
  dataset: { name: string; sample_size: number; holdout: boolean };
  policy_version: number;
  memory_version: string;
  metrics: MemoryEvalMetrics;
  verdict: MemoryEvalVerdict;
  notes?: string;
}

export interface MemoryEvalRunRecord extends MemoryEvalRunInput {
  eval_run_id: string;
  created_at: string;
  created_by: UserId;
}
