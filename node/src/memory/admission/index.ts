/**
 * Candidate admission public API (DAT-234).
 *
 * The gate that keeps duplicates, contradictions, and hostile content out of
 * retrieval. Everything here is workspace-scoped by the caller's authenticated
 * membership: no function takes a workspace id from a request body, and the
 * existing-item corpus it compares against is whatever the scoped repositories
 * return — which never includes another workspace.
 */

export { evaluateCandidate } from "./gate.js";
export type { EvaluateContext } from "./gate.js";

export { admitCandidate } from "./service.js";
export type { AdmissionOutcome, AdmitOptions } from "./service.js";

export { allowsFactualInjection, isRetrievalEligible } from "./eligibility.js";
export type { EligibilityInput } from "./eligibility.js";

export {
  checkProvenanceTrust,
  checkScopeConsistency,
  checkShape,
  scopeContains,
  scopesComparableForDedupe,
  scopesMayOverlap,
  MAX_PRECONDITIONS,
  MAX_PRECONDITION_LENGTH,
  MAX_STATEMENT_LENGTH,
} from "./consistency.js";

export { findContradictions, retirementProposalsFor } from "./contradiction.js";
export { findDuplicate, isDuplicate } from "./dedupe.js";
export { checkEvidence, emptyEvidenceResolver, ledgerEvidenceResolver } from "./evidence.js";
export type { EvidenceCheckResult } from "./evidence.js";
export { isFloodingShape, scanForInjection } from "./poisoning.js";
export type { InjectionReason } from "./poisoning.js";
export { lintForPolicyInstructions } from "./policy.js";
export type { PolicyReason } from "./policy.js";
export {
  CONTRADICTION_THRESHOLD,
  NEAR_DUPLICATE_THRESHOLD,
  hasNegation,
  isPolarityFlip,
  normalizeTokens,
  statementSimilarity,
  tokenSimilarity,
} from "./normalize.js";

export { createMemoryAdmissionRepository } from "./repositories.js";
export type {
  MemoryAdmissionDecision,
  MemoryAdmissionRepository,
  MemoryRetirementCandidate,
  ProposeRetirementInput,
  RecordAdmissionDecisionInput,
  RetirementListFilter,
} from "./repositories.js";

export { ADMISSION_CHECKS, ADMISSION_REASONS } from "./types.js";
export type {
  AdmissionCandidate,
  AdmissionCheck,
  AdmissionCheckResult,
  AdmissionCheckStatus,
  AdmissionDisposition,
  AdmissionReason,
  AdmissionVerdict,
  CandidateEvidenceRef,
  ContradictionFinding,
  DuplicateFinding,
  EvidenceResolution,
  EvidenceResolver,
  RetirementAction,
  RetirementCandidate,
} from "./types.js";
