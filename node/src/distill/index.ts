/**
 * Known terminal outcome capture, redaction, and structured distillation
 * (DAT-233) — public API.
 *
 * The write path of ADR-0009: capture attributable terminal outcomes from the
 * dsh evidence/delivery envelope as episodes with evidence, redact and
 * minimize everything before persistence, distill structured candidates
 * through the ADR-0005 gateway, and validate them against the captured
 * evidence ledger before they become `proposed` memory items.
 *
 * Invariants this module enforces:
 *
 * - `timeout`, `unknown`, and `infra_failure` outcomes are episode-only: never
 *   counted as success, never positive evidence, never distilled from.
 * - A candidate without resolvable captured evidence is dropped; the extractor
 *   cannot fabricate test results, reviewer decisions, or merge states.
 * - Secrets and personal data never enter an item; prohibited instructions
 *   (privilege expansion, approval bypass, policy ignore, evaluator-directed)
 *   reject the whole batch.
 * - Distillation sends current-workspace material only, through the gateway.
 */

export {
  buildDistillationContext,
  captureAll,
  dispatchDistillation,
  distillAndPersist,
  DISTILL_INSTRUCTIONS,
  extractText,
  persistCandidates,
} from "./distill.js";
export type { DistillRunInput, DistillRunResult, DistillationDispatch } from "./distill.js";

export { captureEvidence, captureOutcome } from "./capture.js";

export { classifyOutcome, parseOutcomeEnvelope } from "./outcome.js";

export {
  assertNoSecretOrPii,
  detectSecretOrPii,
  redactText,
  sensitivityFor,
  snippet,
} from "./redact.js";

export {
  candidateEvidenceSchema,
  distillationCandidateSchema,
  distillationOutputSchema,
  parseDistillationOutput,
} from "./schema.js";

export { detectOutcomeClaims } from "./claims.js";

export { lintForPolicyInstructions } from "./policy.js";

export { buildEvidenceLedger, ledgerKey, validateCandidates } from "./validate.js";

export type {
  CandidateDropReason,
  CandidateEvidenceRef,
  CandidateValidationResult,
  CapturedOutcome,
  DistillKind,
  DistillScope,
  DistillationCandidate,
  DistillationContextInput,
  DistillationMaterial,
  DistillationOutput,
  DroppedCandidate,
  EvidenceLedger,
  EvidenceLedgerEntry,
  FailureCause,
  OutcomeClaimKind,
  OutcomeClassification,
  OutcomeClass,
  OutcomeDelivery,
  OutcomeEnvelope,
  OutcomeEnvelopeInput,
  OutcomeEvidenceRef,
  OutcomeValidationEvidence,
  PatchStatus,
  PersistedDistillKind,
  PolicyViolation,
  PolicyViolationKind,
  RedactionKind,
  RedactionReport,
  StopDisposition,
  TerminalState,
  ValidatedCandidate,
} from "./types.js";

export {
  DISTILL_CANDIDATES_MAX,
  DISTILL_EVIDENCE_MAX,
  DISTILL_KINDS,
  DISTILL_PRECONDITION_MAX,
  DISTILL_PRECONDITIONS_MAX,
  DISTILL_PROMPT_VERSION,
  DISTILL_STATEMENT_MAX,
  FAILURE_CAUSES,
  OUTCOME_CLASSES,
  OUTCOME_CLAIM_KINDS,
  OUTCOME_ENVELOPE_CONTRACT_VERSION,
  OUTCOME_EVIDENCE_TYPES,
  PATCH_STATUSES,
  POLICY_VIOLATION_KINDS,
  REDACTION_KINDS,
  STOP_DISPOSITIONS,
  TERMINAL_STATES,
} from "./types.js";
