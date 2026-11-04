/**
 * Known terminal outcomes, redaction, and structured distillation (DAT-233).
 *
 * The write path of ADR-0009 starts from an **outcome envelope**: the record
 * the orchestrator emits when a run reaches a terminal state and the delivery
 * outcome is known. The envelope consumed here mirrors the dsh evidence chain
 * and the delivery `patch_report` of `docs/contracts/task-evidence-contract-v1.md`
 * (`docs/contracts/memory-distillation-v1.md` pins the exact shape).
 *
 * The central invariant of this slice: **only attributable terminal outcomes
 * learn**. `accepted`/`merged`, `rejected` with a recorded reason, explicitly
 * `cancelled` with a reason, and `failed` with a classified cause are known
 * outcomes and may support a distilled candidate. `timeout`, `unknown`, and
 * `infra_failure` outcomes are stored as episodes only — they never become
 * positive evidence and never support a candidate claim.
 *
 * Nothing in this module reaches a model or a provider directly. The only
 * model path is the ADR-0005 gateway (see `distill.ts`), and the extractor can
 * never invent test, review, or merge results: every outcome claim in a
 * candidate must resolve to evidence captured from a known outcome.
 */

import type { WorkspaceScope } from "../control-plane/types.js";
import type {
  MemoryEvidenceType,
  MemoryItemRecord,
  MemoryKind,
  MemorySensitivity,
} from "../memory/index.js";

// ---------------------------------------------------------------------------
// Contract version and prompt version
// ---------------------------------------------------------------------------

/** Only envelope contract version accepted by the parser. */
export const OUTCOME_ENVELOPE_CONTRACT_VERSION = "1.0.0";

/** Version of the fixed distillation prompt; recorded on distilled provenance. */
export const DISTILL_PROMPT_VERSION = "memory-distill-v1";

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** dsh terminal states that can carry a delivery outcome (task-evidence §5). */
export const TERMINAL_STATES = [
  "merged",
  "rejected",
  "cancelled",
  "stopped",
  "timed_out",
  "expired",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** How a `stopped` run's outcome resolved once the run reached its end. */
export const STOP_DISPOSITIONS = ["failed", "infra_failure", "unknown"] as const;
export type StopDisposition = (typeof STOP_DISPOSITIONS)[number];

/** Classified causes for a `failed` disposition; a closed vocabulary. */
export const FAILURE_CAUSES = [
  "build_failure",
  "test_failure",
  "validation_failure",
  "merge_conflict",
  "policy_denied",
  "tool_failure",
  "resource_limit",
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

/** Patch outcome vocabulary of the delivery `patch_report` (task-evidence §4). */
export const PATCH_STATUSES = ["not_created", "prepared_no_pr", "proposed", "merged"] as const;
export type PatchStatus = (typeof PATCH_STATUSES)[number];

/**
 * The outcome classes of the write path. `known` classes may support a
 * distilled candidate; the rest are episode-only and never positive evidence.
 */
export const OUTCOME_CLASSES = [
  "accepted",
  "rejected",
  "cancelled",
  "failed",
  "timeout",
  "unknown",
  "infra_failure",
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** Evidence reference vocabulary (memory-item contract). */
export const OUTCOME_EVIDENCE_TYPES = [
  "run",
  "issue",
  "pr",
  "commit",
  "test",
  "reviewer_decision",
  "incident",
] as const;
export type OutcomeEvidenceType = MemoryEvidenceType;

/** Kinds a distillation candidate may take. Episodes capture; policy never learns. */
export const DISTILL_KINDS = ["fact", "lesson", "playbook", "anti_pattern"] as const;
export type DistillKind = (typeof DISTILL_KINDS)[number];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const OUTCOME_ID_MAX = 200;
export const OUTCOME_REASON_MAX = 400;
export const OUTCOME_CHANGE_SUMMARY_MAX = 2000;
export const OUTCOME_TOOL_MAX = 200;
export const OUTCOME_REFERENCE_MAX = 300;
export const OUTCOME_EVIDENCE_MAX = 24;
export const OUTCOME_VALIDATION_MAX = 16;

export const DISTILL_STATEMENT_MAX = 2000;
export const DISTILL_PRECONDITION_MAX = 300;
export const DISTILL_PRECONDITIONS_MAX = 8;
export const DISTILL_EVIDENCE_MAX = 10;
export const DISTILL_CANDIDATES_MAX = 20;
export const DISTILL_SCOPE_FIELD_MAX = 200;
export const DISTILL_MATERIAL_MAX = 16;
export const DISTILL_MATERIAL_TEXT_MAX = 4000;

// ---------------------------------------------------------------------------
// Outcome envelope
// ---------------------------------------------------------------------------

/** One immutable evidence reference from the dsh evidence chain. */
export interface OutcomeEvidenceRef {
  evidence_type: OutcomeEvidenceType;
  /** Opaque, access-controlled pointer into the retained evidence bundle. */
  reference: string;
}

/** One retained validation attempt of the delivery record. */
export interface OutcomeValidationEvidence {
  /** Redacted tool identity and arguments. */
  tool: string;
  /** Redacted exit status; `null` when the tool produced no status. */
  exit_status: number | null;
  event_reference: string;
}

/** Delivery facts of the outcome; mirrors the evidence contract's `patch_report`. */
export interface OutcomeDelivery {
  patch_status: PatchStatus;
  head_sha: string | null;
  pr_id: string | null;
  change_summary: string;
  validation: OutcomeValidationEvidence[];
}

/**
 * The envelope as produced by the orchestrator from the dsh evidence chain and
 * the delivery record. Free-text fields are bounded and redacted before
 * anything is persisted.
 */
export interface OutcomeEnvelopeInput {
  contract_version: string;
  task_id: string;
  run_id: string;
  issue_id: string;
  terminal_state: TerminalState;
  /** Required exactly when `terminal_state` is `stopped`. */
  stop_disposition?: StopDisposition | null;
  /** Required exactly when `stop_disposition` is `failed`. */
  failure_cause?: FailureCause | null;
  /** Required and non-empty exactly for `rejected` and `cancelled`. */
  reason?: string | null;
  delivery: OutcomeDelivery;
  evidence: OutcomeEvidenceRef[];
}

/** Normalized envelope: optional fields resolved, free text redacted. */
export interface OutcomeEnvelope {
  contract_version: string;
  task_id: string;
  run_id: string;
  issue_id: string;
  terminal_state: TerminalState;
  stop_disposition: StopDisposition | null;
  failure_cause: FailureCause | null;
  reason: string | null;
  delivery: OutcomeDelivery;
  evidence: OutcomeEvidenceRef[];
}

/** Derived outcome classification; nothing the producer claims is trusted. */
export interface OutcomeClassification {
  class: OutcomeClass;
  /** Known terminal outcome: may support a distilled candidate. */
  known: boolean;
  /** Positive (success) evidence: `accepted`/`merged` only. */
  positive: boolean;
  /** Stored as an episode only; never supports a candidate or a success claim. */
  episode_only: boolean;
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

/**
 * One evidence reference captured from a known outcome, with the attribution
 * a candidate claim must resolve against. The extractor can never fabricate a
 * test result, a review decision, or a merge state: a claim is supported only
 * by a ledger entry that carries exactly that kind of captured evidence.
 */
export interface EvidenceLedgerEntry {
  evidence_type: OutcomeEvidenceType;
  reference: string;
  outcome_class: OutcomeClass;
  /** True only for evidence captured from an `accepted`/`merged` outcome. */
  positive: boolean;
  /** True only for evidence captured from a known (learnable) outcome. */
  known: boolean;
  run_id: string;
  /**
   * For `test` evidence derived from a retained validation attempt: whether
   * that attempt exited 0. `null` when no validation status was retained.
   */
  test_passed: boolean | null;
}

/** Ledger of everything captured in one workspace; keyed by type + reference. */
export type EvidenceLedger = ReadonlyMap<string, EvidenceLedgerEntry>;

// ---------------------------------------------------------------------------
// Distillation output (strict schema)
// ---------------------------------------------------------------------------

/** Applicability scope of a candidate; empty fields mean broad applicability. */
export interface DistillScope {
  team_id?: string;
  path_prefix?: string;
  language?: string;
  task_family?: string;
}

/** One candidate evidence citation; must resolve in the captured ledger. */
export interface CandidateEvidenceRef {
  evidence_type: OutcomeEvidenceType;
  reference: string;
}

/** One structured candidate as produced by the extractor. */
export interface DistillationCandidate {
  kind: DistillKind;
  statement: string;
  preconditions: string[];
  scope: DistillScope;
  evidence: CandidateEvidenceRef[];
}

/** The complete, size-capped extractor output. */
export interface DistillationOutput {
  candidates: DistillationCandidate[];
}

// ---------------------------------------------------------------------------
// Candidate validation results
// ---------------------------------------------------------------------------

export type CandidateDropReason =
  | "missing_evidence"
  | "unresolved_evidence"
  | "no_known_outcome_evidence"
  | "unsupported_claim"
  | "policy_violation"
  | "secret_or_pii";

/** A candidate that will never be persisted, with the reason it was dropped. */
export interface DroppedCandidate {
  candidate: DistillationCandidate;
  reason: CandidateDropReason;
  detail: string;
}

/** A candidate that passed every check, with its resolved evidence. */
export interface ValidatedCandidate {
  /** Redacted candidate content; secrets and PII never survive into an item. */
  candidate: DistillationCandidate;
  sensitivity: MemorySensitivity;
  evidence: EvidenceLedgerEntry[];
}

/**
 * Outcome of the validation pipeline. A policy violation rejects the whole
 * output: `rejected` is true and nothing from the batch may be persisted.
 */
export interface CandidateValidationResult {
  accepted: ValidatedCandidate[];
  dropped: DroppedCandidate[];
  rejected: boolean;
}

// ---------------------------------------------------------------------------
// Capture results
// ---------------------------------------------------------------------------

/** One captured outcome: its episode item plus the evidence it can support. */
export interface CapturedOutcome {
  /** Normalized, redacted envelope. */
  envelope: OutcomeEnvelope;
  classification: OutcomeClassification;
  /** Ledger entries captured from this outcome (identity refs plus evidence). */
  evidence: EvidenceLedgerEntry[];
  /** The L1 episode persisted for the run, whatever the outcome class. */
  episode: MemoryItemRecord;
}

// ---------------------------------------------------------------------------
// Distillation materials (current workspace only)
// ---------------------------------------------------------------------------

/**
 * One piece of workspace material the distiller may read. Every material is
 * bound to a workspace; a material from another workspace is refused before
 * any context is composed or any model call is made.
 */
export interface DistillationMaterial {
  workspace_id: string;
  text: string;
}

export interface DistillationContextInput {
  scope: WorkspaceScope;
  /** Known-outcome captures; episode-only outcomes are never distilled from. */
  outcomes: readonly CapturedOutcome[];
  materials?: readonly DistillationMaterial[];
}

/** Kinds of instruction a candidate may never carry (ADR-0009 guardrails). */
export const POLICY_VIOLATION_KINDS = [
  "privilege_expansion",
  "approval_bypass",
  "policy_ignore",
  "evaluator_directed",
] as const;
export type PolicyViolationKind = (typeof POLICY_VIOLATION_KINDS)[number];

export interface PolicyViolation {
  kind: PolicyViolationKind;
  /** Bounded snippet of the matched text; never persisted. */
  match: string;
}

/** Outcome claim kinds the extractor may make; each needs captured evidence. */
export const OUTCOME_CLAIM_KINDS = ["merged", "tests_passed", "review_approved"] as const;
export type OutcomeClaimKind = (typeof OUTCOME_CLAIM_KINDS)[number];

/** Kinds of secret/PII material detected in text. */
export const REDACTION_KINDS = ["secret", "email", "phone", "payment_card", "user_path"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface RedactionReport {
  text: string;
  kinds: RedactionKind[];
}

/** Memory kinds that persist from capture or distillation. */
export type PersistedDistillKind = DistillKind | Extract<MemoryKind, "episode">;
