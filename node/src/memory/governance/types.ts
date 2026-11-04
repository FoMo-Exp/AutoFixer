/**
 * Workspace memory governance contract types (DAT-251).
 *
 * ADR-0009 lists a governance surface — human promotion with an explicit
 * version, deprecation with a reason, and quarantine as a security response —
 * but DAT-236 deliberately served only retrieval, browse, and evaluation. This
 * module is that missing surface: item detail, per-version content for diffing,
 * an item audit timeline, and the four named human transitions.
 *
 * Two vocabularies are closed and versioned here because a client renders them
 * directly and the audit trail stores them:
 *
 * - `MEMORY_GOVERNANCE_ACTIONS` — the four transitions this surface performs.
 * - `MEMORY_GOVERNANCE_REASON_CODES` — the fixed reason set. It reuses the
 *   DAT-235 consolidation reason codes that describe a human decision and adds
 *   the governance-specific ones. Free-text reasons are not accepted and are
 *   not stored: `memory_events.detail` keeps its "no free text, no memory
 *   content" invariant.
 */

import type { MemoryProvenance, MemoryReview, MemoryStatus } from "../types.js";
import type { MemoryApplicability } from "../types.js";
import type { MemoryItemView } from "../retrieval/types.js";
import type { MemoryKind, MemorySensitivity, MemoryTrust } from "../types.js";
import type { MemoryTier } from "../retrieval/types.js";

// ---------------------------------------------------------------------------
// Transition and reason vocabularies
// ---------------------------------------------------------------------------

export const MEMORY_GOVERNANCE_ACTIONS = ["promote", "deprecate", "quarantine", "restore"] as const;

export type MemoryGovernanceAction = (typeof MEMORY_GOVERNANCE_ACTIONS)[number];

/**
 * Fixed reason codes. The first block is DAT-235's consolidation vocabulary
 * (the codes that describe a human decision); the second block is the
 * governance additions. Skipped-op codes (`item_deleted`, `item_missing`,
 * `status_not_applicable`) describe the consolidation job's own skips, not a
 * human act, and are therefore not accepted here.
 */
export const MEMORY_GOVERNANCE_REASON_CODES = [
  // DAT-235 consolidation reasons a human may also cite.
  "duplicate_content",
  "past_valid_to",
  "stale_fact",
  "unused_decay",
  "retirement_proposal",
  "security_report",
  // DAT-251 governance reasons.
  "human_decision",
  "contradiction",
  "incorrect_content",
  "policy_violation",
  "secret_leak",
  "poisoning_suspected",
  "restore_after_review",
  "false_positive",
] as const;

export type MemoryGovernanceReasonCode = (typeof MEMORY_GOVERNANCE_REASON_CODES)[number];

/** Statuses a quarantined item may be restored to. `active` is not one. */
export const MEMORY_RESTORE_TARGET_STATUSES = ["proposed", "candidate", "deprecated"] as const;

export type MemoryRestoreTargetStatus = (typeof MEMORY_RESTORE_TARGET_STATUSES)[number];

// ---------------------------------------------------------------------------
// Actor and request shapes
// ---------------------------------------------------------------------------

/**
 * Who is asking. `role` is resolved from the authenticated session's live
 * membership and team leadership from the workspace's team rows — never from
 * the request body.
 */
export interface MemoryGovernanceActor {
  user_id: string;
  role: "owner" | "admin" | "member" | "viewer";
}

interface GovernanceRequestBase {
  /** The exact content version the human reviewed or acted on. */
  version: number;
  /** Optimistic concurrency token; must equal the item's current version. */
  expected_version: number;
}

export type PromoteMemoryItemRequest = GovernanceRequestBase;

export interface DeprecateMemoryItemRequest extends GovernanceRequestBase {
  reason_code: MemoryGovernanceReasonCode;
}

export interface QuarantineMemoryItemRequest extends GovernanceRequestBase {
  reason_code: MemoryGovernanceReasonCode;
}

export interface RestoreMemoryItemRequest extends GovernanceRequestBase {
  target_status: MemoryRestoreTargetStatus;
  reason_code: MemoryGovernanceReasonCode;
}

// ---------------------------------------------------------------------------
// Read views
// ---------------------------------------------------------------------------

/** One immutable content version, served for content diffing. */
export interface MemoryItemVersionView {
  version: number;
  kind: MemoryKind;
  tier: MemoryTier;
  /** Null exactly when `statement_redacted` is true (quarantined item). */
  statement: string | null;
  statement_redacted: boolean;
  preconditions: string[];
  applicability: MemoryApplicability;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  valid_from: string;
  valid_to: string | null;
  content_hash: string;
  provenance: MemoryProvenance;
  review: MemoryReview | null;
  created_at: string;
  created_by: string;
}

export interface MemoryItemVersionsView {
  schema_version: number;
  item_id: string;
  status: MemoryStatus;
  current_version: number;
  /** Visible versions ascending by version; hidden versions are absent. */
  versions: MemoryItemVersionView[];
}

/** Which stored audit source an event row came from. */
export const MEMORY_EVENT_SOURCES = [
  "memory_event",
  "promotion_decision",
  "consolidation_op",
] as const;

export type MemoryEventSource = (typeof MEMORY_EVENT_SOURCES)[number];

/**
 * One normalized audit entry. `detail` only ever holds fixed enums, counts,
 * and opaque ids — the normalizer drops anything that could be free text or
 * memory content.
 */
export interface MemoryItemEventView {
  at: string;
  source: MemoryEventSource;
  action: string;
  actor: { type: "user" | "system"; id: string };
  item_version: number | null;
  from_status?: MemoryStatus;
  to_status?: MemoryStatus;
  reason_code?: string;
  detail?: Record<string, string | number | boolean>;
}

export interface MemoryItemEventsView {
  item_id: string;
  events: MemoryItemEventView[];
}

/** The post-transition state, with the same view the browse surface serves. */
export interface MemoryGovernanceResult {
  action: MemoryGovernanceAction;
  item_id: string;
  from_status: MemoryStatus;
  to_status: MemoryStatus;
  item_version: number;
  reason_code: MemoryGovernanceReasonCode | "human_approved" | null;
  item: MemoryItemView;
}
