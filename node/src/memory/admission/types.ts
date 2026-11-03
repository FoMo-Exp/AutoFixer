/**
 * Candidate admission types (DAT-234).
 *
 * The admission gate runs on a candidate memory item **before** it can become
 * visible to retrieval. It answers one question — may this candidate be
 * remembered, and if so how may it be used — and it answers it with a fixed
 * vocabulary of reason codes so the result is auditable without persisting any
 * candidate content.
 *
 * Two independent axes come out of a verdict, because the ADR separates them:
 *
 * - `retrieval_eligible` — may the item appear in a bundle at all. Anything
 *   that failed validation is false, so it appears in no bundle, in no form.
 * - `factual_injection_allowed` — may the item be presented as fact. A
 *   contradicting item stays visible (as a conflict) but is never injected as
 *   a fact, and it never reaches `active` on its own.
 */

import type {
  MemoryApplicability,
  MemoryEvidenceType,
  MemoryItemId,
  MemoryKind,
  MemoryProvenance,
  MemorySensitivity,
  MemoryTrust,
} from "../types.js";

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/**
 * Every finding the gate can report. Fixed enum, safe to persist: a reason
 * code never carries the text that triggered it.
 */
export const ADMISSION_REASONS = [
  // shape
  "shape_missing_statement",
  "shape_statement_too_long",
  "shape_too_many_preconditions",
  "shape_precondition_too_long",
  "shape_invalid_temporality",
  // policy lint
  "policy_privilege_expansion",
  "policy_approval_claim",
  "policy_approval_bypass",
  "policy_test_gate_bypass",
  "policy_ignore",
  "policy_evaluator_directed",
  // injection and poisoning
  "injection_role_marker",
  "injection_instruction_override",
  "injection_control_token",
  "injection_instruction_shaped",
  "injection_self_reference",
  "benchmark_fixture_reference",
  // provenance and trust
  "trust_mismatch_with_author",
  "trust_self_raised",
  "trust_untrusted_origin",
  "policy_kind_requires_human",
  // scope consistency
  "scope_malformed_value",
  "scope_foreign_reference",
  "scope_kind_inconsistent",
  // evidence
  "evidence_missing",
  "evidence_unresolved",
  "evidence_no_known_outcome",
  // dedupe
  "dedupe_exact_duplicate",
  "dedupe_near_duplicate",
  "dedupe_scope_disjoint",
  // contradiction
  "contradiction_detected",
] as const;

export type AdmissionReason = (typeof ADMISSION_REASONS)[number];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export const ADMISSION_CHECKS = [
  "shape",
  "policy_lint",
  "injection_heuristics",
  "provenance_trust",
  "scope_consistency",
  "evidence_resolution",
  "dedupe",
  "contradiction",
] as const;

export type AdmissionCheck = (typeof ADMISSION_CHECKS)[number];

/**
 * `pass` — nothing found. `fail` — blocks admission or holds the candidate.
 * `flag` — a real finding that does not by itself block, such as a detected
 * contradiction, which blocks factual injection but keeps the item visible.
 */
export type AdmissionCheckStatus = "pass" | "fail" | "flag";

export interface AdmissionCheckResult {
  check: AdmissionCheck;
  status: AdmissionCheckStatus;
  reasons: AdmissionReason[];
}

// ---------------------------------------------------------------------------
// Candidate under evaluation
// ---------------------------------------------------------------------------

/** One evidence citation attached to a candidate. */
export interface CandidateEvidenceRef {
  evidence_type: MemoryEvidenceType;
  reference: string;
}

/**
 * A candidate memory item as the gate sees it: the memory-item contract plus
 * its evidence citations. Distillation output, a human proposal, and an
 * adopted enterprise template all arrive in this shape, so the gate is
 * source-agnostic and nothing can skip it by arriving through another writer.
 */
export interface AdmissionCandidate {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  valid_from?: string;
  valid_to?: string | null;
  source_run_id?: string | null;
  evidence: CandidateEvidenceRef[];
}

// ---------------------------------------------------------------------------
// Evidence resolution
// ---------------------------------------------------------------------------

/** What the gate learns about one cited piece of evidence. */
export interface EvidenceResolution {
  evidence_type: MemoryEvidenceType;
  reference: string;
  /** The source outcome was a known terminal outcome, not episode-only. */
  known: boolean;
  /** The source outcome was positive (accepted/merged). */
  positive: boolean;
}

/**
 * Resolves a candidate's citations against the workspace's captured evidence.
 *
 * The gate never trusts a caller's assertion that evidence exists: it asks
 * this resolver, which is backed by what the outcome-capture path actually
 * recorded. An unresolved citation is a validation failure.
 */
export interface EvidenceResolver {
  resolve(
    refs: readonly CandidateEvidenceRef[],
  ): Map<CandidateEvidenceRef["reference"], EvidenceResolution | undefined>;
}

// ---------------------------------------------------------------------------
// Findings the gate hands back for the caller to act on
// ---------------------------------------------------------------------------

export interface DuplicateFinding {
  item_id: MemoryItemId;
  kind: "exact" | "near";
  /** Content hash of the version the candidate duplicated. */
  matched_hash: string;
}

export interface ContradictionFinding {
  item_id: MemoryItemId;
  reason: AdmissionReason;
  /** Whether the two applicability scopes can cover the same situation. */
  scope_overlap: boolean;
}

export type RetirementAction = "deprecate" | "supersede";

/**
 * A proposal to retire an item. Never executed by the gate: a contradiction
 * produces the proposal and a human or the consolidation job decides.
 */
export interface RetirementCandidate {
  item_id: MemoryItemId;
  successor_item_id: MemoryItemId | null;
  proposed_action: RetirementAction;
  reason: AdmissionReason;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * What happens to the candidate.
 *
 * - `admitted` — clean. Becomes a `candidate` item and may proceed to the
 *   promotion rules; it is never promoted by the gate itself.
 * - `merged` — a duplicate of an existing item. Its evidence is folded into
 *   that item; no second item is created.
 * - `held` — a quality failure (weak evidence, malformed scope). The item
 *   stays `proposed` for human review and is never retrieval-eligible.
 * - `discarded` — a security failure (policy, injection, poisoning, trust).
 *   Not persisted as visible memory at all.
 */
export type AdmissionDisposition = "admitted" | "merged" | "held" | "discarded";

export interface AdmissionVerdict {
  disposition: AdmissionDisposition;
  /** Canonical content hash of the candidate, for idempotency and audit. */
  candidate_hash: string;
  checks: AdmissionCheckResult[];
  /** Every reason across every check, deduplicated, in check order. */
  reasons: AdmissionReason[];
  duplicate: DuplicateFinding | null;
  contradictions: ContradictionFinding[];
  /**
   * May this item appear in a memory bundle in any form. False for anything
   * that did not pass validation, so a failed candidate appears in no bundle.
   */
  retrieval_eligible: boolean;
  /**
   * May this item be presented as fact. False when the item contradicts
   * something: the conflict is surfaced instead, and neither side is injected
   * as a claim.
   */
  factual_injection_allowed: boolean;
}
