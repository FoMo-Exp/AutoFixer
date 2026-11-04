/**
 * Durable collaboration state machine (DAT-215, ADR-0007) and its immutable
 * candidate review-card surface (DAT-219, ADR-0007).
 *
 * The module owns the product issue/task/run domain model: product lifecycle
 * states, bounded runs with worktree/scope/limit/grant records, leases with
 * fencing tokens, operation-id idempotency, an append-only digest-chained
 * audit log, and bounded handoffs with immutable artifact references.
 *
 * It grants no authority: dsh remains the execution gate, and product states
 * stay strictly separate from harness (FP-01) run states.
 */
export { CollabMachine } from "./machine.js";
export type {
  AcquireLeaseInput,
  AddTaskInput,
  ArtifactInput,
  BaseAdvanceResult,
  CollabMachineOptions,
  CommandBase,
  CreateIssueInput,
  FreezeCandidateInput,
  GrantInput,
  InvalidateCandidateInput,
  LeaseInput,
  OpenRunInput,
  RecordBaseAdvanceInput,
  RecordGrantInput,
  RecordHandoffInput,
  RecordRunStateInput,
  RenewLeaseInput,
  RequestRunRestartInput,
  RevokeGrantInput,
  SetTaskStateInput,
  TransitionIssueInput,
} from "./machine.js";
export { CollabError, COLLAB_ERROR_CODES } from "./errors.js";
export type { CollabErrorCode } from "./errors.js";
export {
  PRODUCT_STATES,
  PRODUCT_TRANSITIONS,
  PRODUCT_RUN_RELATION,
  RUN_STATE_TRANSITIONS,
  canTransitionProduct,
  canTransitionRun,
  isTerminalProductState,
  isTerminalRunState,
  productRunConflict,
  runTransitionIssueConflict,
} from "./states.js";
export type { ProductState, ProductRelation, RunView } from "./states.js";
export { grantStateAt, GRANT_STATES, RISK_CLASSES, ROLES, TASK_STATES } from "./types.js";
export {
  assertCandidateCurrent,
  candidateFreshness,
  candidateNotification,
  candidateReviewCard,
  validationEvidenceDigest,
} from "./candidate.js";
export type {
  CandidateFreshness,
  CandidateNotification,
  CandidateNotificationOptions,
  CandidateReviewCard,
  CandidateStaleReason,
} from "./candidate.js";
export { CandidateContentStore, diffDigest } from "./candidate-store.js";
export {
  RUN_EVIDENCE_PREFIX,
  artifactEvidenceRef,
  grantEvidenceRef,
  resolveRevisionEvidence,
  resolveRunEvidence,
  runEvidenceIndex,
} from "./evidence.js";
export type { ResolvedEvidence } from "./evidence.js";
export type { StoredDiff } from "./candidate-store.js";
export { CandidateReviewService } from "./candidate-service.js";
export type { CandidateCardPage, CandidateDiffView } from "./candidate-service.js";
export {
  APPROVAL_INVALIDATION_REASONS,
  APPROVAL_STATES,
  DELIVERY_STATES,
  ISSUE_EVENT_TYPES,
  TASK_EVIDENCE_CONTRACT_VERSION,
} from "./contract.js";
export type {
  ApprovalInvalidationReason,
  ApprovalState,
  DeliveryState,
  IssueEventType,
} from "./contract.js";
export type {
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateValidation,
  CandidateValidationResult,
  CapabilityGrant,
  ChangeRisk,
  CollabState,
  Disposition,
  GrantState,
  GrantTool,
  HandoffRecord,
  IssueRecord,
  LeaseRecord,
  RepositoryRef,
  RiskClass,
  Role,
  RunLimits,
  RunRecord,
  RunScope,
  TaskRecord,
  TaskState,
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
export { auditChainProblem, canonicalJson, digestOf } from "./audit.js";
export type { AuditCommand, AuditOutcome, AuditRecord } from "./audit.js";
