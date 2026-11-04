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
  ApproverAuthorityFacts,
  ArtifactInput,
  BaseAdvanceResult,
  CollabMachineOptions,
  CommandBase,
  CreateIssueInput,
  DecideApprovalInput,
  DeliveryAuthorityFacts,
  FreezeCandidateInput,
  GrantInput,
  InvalidateApprovalInput,
  InvalidateCandidateInput,
  LeaseInput,
  OpenRunInput,
  ReconcileDeliveryInput,
  RecordBaseAdvanceInput,
  RecordDeliveryStateInput,
  RecordGrantInput,
  RecordTestPlanInput,
  RegisterTestPolicyInput,
  RecordHandoffInput,
  RecordRunStateInput,
  RenewLeaseInput,
  RequestApprovalInput,
  RequestDeliveryInput,
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
export {
  grantStateAt,
  GRANT_STATES,
  RISK_CLASSES,
  ROLES,
  TASK_STATES,
  testPolicyScopeKey,
} from "./types.js";
export {
  assertCandidateCurrent,
  candidateFreshness,
  candidateNotification,
  candidateReviewCard,
  validationEvidenceDigest,
} from "./candidate.js";
export type {
  CandidateCardValidation,
  CandidateFreshness,
  CandidateNotification,
  CandidateNotificationOptions,
  CandidateReviewCard,
  CandidateStaleReason,
} from "./candidate.js";
export { CandidateContentStore, diffDigest } from "./candidate-store.js";
export {
  approvalStateAt,
  bindingForCandidate,
  bindingMismatch,
  compareApprovals,
  compareDeliveries,
  userRef,
} from "./approval.js";
export type { BindingMismatch } from "./approval.js";
export { ApprovalService, isEligibleApprover } from "./approval-service.js";
export type {
  ApprovalDirectory,
  ApprovalMemberFact,
  ApprovalPage,
  ApprovalServiceOptions,
  DecideApprovalOptions,
  ReassignApprovalOptions,
  RequestApprovalOptions,
} from "./approval-service.js";
export {
  DELIVERY_TRANSITIONS,
  RECONCILABLE_STATES,
  canTransitionDelivery,
  deliveryBranchProblem,
  deliveryView,
  isTerminalDeliveryState,
  providerMatchesRepository,
} from "./delivery.js";
export type { DeliveryView } from "./delivery.js";
export { DeliveryBroker, DeliveryProviderError } from "./delivery-broker.js";
export type {
  DeliverOptions,
  DeliveryBrokerOptions,
  DeliveryProvider,
  DeliveryProviderCapabilities,
  OpenPullRequestInput,
  ProviderBranchEvidence,
  ProviderPullRequestEvidence,
  PushBranchInput,
  PushBranchOutcome,
  ReconcileOptions,
  RequestDeliveryOptions,
} from "./delivery-broker.js";
export {
  RUN_EVIDENCE_PREFIX,
  VALIDATION_ARTIFACT_KINDS,
  artifactEvidenceRef,
  grantEvidenceRef,
  planEvidenceRef,
  resolveRevisionEvidence,
  resolveRunEvidence,
  resolveValidationEvidence,
  runEvidenceIndex,
} from "./evidence.js";
export type { ResolvedEvidence, RunEvidenceContext } from "./evidence.js";
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
  ApprovalBinding,
  ApprovalDecision,
  ApprovalRecord,
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateTestPolicy,
  CandidateValidation,
  CandidateValidationResult,
  CapabilityGrant,
  ChangeRisk,
  CollabState,
  DeliveryRecord,
  DigestRef,
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
  TestPlanRecord,
  TestPolicyRecord,
  UserRef,
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
export { AUTOFIXER_BRANCH_PREFIX, autofixerBranchFor } from "./types.js";
export { auditChainProblem, canonicalJson, digestOf } from "./audit.js";
export type { AuditCommand, AuditOutcome, AuditRecord } from "./audit.js";
