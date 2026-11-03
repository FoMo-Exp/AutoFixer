/**
 * Security disposal case domain (DAT-210, ADR-0005 §2): case lifecycle,
 * precise dependent-work pause, redacted notification with non-transferable
 * case references, and encrypted quarantine.
 */

export {
  CASE_STATES,
  CASE_TRANSITIONS,
  SecurityError,
  canTransitionCase,
  isHumanOrService,
  isRunItself,
  isTerminalCaseState,
  requireNonEmpty,
} from "./types.js";
export type {
  BlockAssociation,
  BlockIdentity,
  CaseEvent,
  CaseEventType,
  CaseScope,
  CaseState,
  SecurityActor,
  SecurityActorKind,
  SecurityCase,
} from "./types.js";

export { SecurityCaseStore } from "./case-store.js";
export type { CaseStoreOptions, OpenBlockInput, OpenBlockResult } from "./case-store.js";

export { DependentWorkPauseLedger } from "./pause.js";
export type { PauseLedgerOptions, RunPause } from "./pause.js";

export {
  SecurityNotifier,
  createFileNotificationSink,
  mintCaseReference,
  verifyCaseReference,
} from "./notify.js";
export type {
  NotifierDeps,
  NotificationSink,
  NotifyResult,
  SecurityNotification,
  SecurityRecipient,
  SecurityRole,
  SecurityRoleDirectory,
} from "./notify.js";

export { EncryptedQuarantine } from "./quarantine.js";
export type {
  QuarantineAccessGrant,
  QuarantineAuditEvent,
  QuarantineDeps,
  QuarantineEventType,
  QuarantineKeyProvider,
  QuarantineRecord,
  QuarantineRecordMeta,
  SealResult,
} from "./quarantine.js";

export { SecurityCaseService } from "./service.js";
export type {
  CaseServiceDeps,
  RecordBlockInput,
  RecordBlockResult,
  SecurityCaseIntake,
} from "./service.js";

export {
  SECURITY_DUTY_MATRIX,
  assertIndependentReview,
  assertSeparateAdministrator,
  requireDuty,
  requireScope,
  staticDutyDirectory,
} from "./duties.js";
export type {
  ReviewIndependence,
  SecurityAction,
  SecurityDuty,
  SecurityDutyDirectory,
  SecurityDutyScope,
} from "./duties.js";

export {
  constrainDetector,
  correctionLineage,
  findDisguisedExemptions,
  scanDisguisedExemptions,
  validateRuleCorrection,
} from "./rules.js";
export type {
  ActiveRuleCorrection,
  DetectorConstraints,
  DisguisedExemptionScan,
  RegressionEvidence,
  RuleCorrectionDraft,
  RuleEvent,
  RuleEventType,
  RuleRevision,
  RuleRevisionStatus,
  RuleReview,
  TrueSecretSample,
} from "./rules.js";

export {
  corpusDigest,
  defaultRegressionSamples,
  ruleDigest,
  runRegressionEvidence,
} from "./regression.js";

export { RuleCorrectionService } from "./rule-service.js";
export type { RuleServiceDeps } from "./rule-service.js";

export { RecoveryAuthorizationStore } from "./recovery-authorization.js";
export type {
  ConsumeResult,
  RecoveryApproval,
  RecoveryAuthorization,
  RecoveryAuthorizationState,
  RecoveryAuthorizationStatus,
  RecoveryAuthorizationStoreOptions,
  RecoveryDestination,
  RecoveryDispatchOutcome,
  RecoveryDispatchOutcomeKind,
  RecoveryInvalidReason,
  RecoveryReconciliation,
  RecoveryReconciliationFinding,
  RecoveryScope,
} from "./recovery-authorization.js";

export {
  contextRevisionOf,
  deepFreezeRequest,
  fingerprintRequest,
  keyedIdentifier,
  rebuildCompleteRequest,
  requestDigestOf,
  requireCorrelationKey,
  rulesRevisionOf,
  scanPolicyRevisionOf,
} from "./recovery-request.js";
export type {
  RebuiltRequest,
  RecoveryRebuildInput,
  RecoveryRequestSource,
  RequestFingerprint,
} from "./recovery-request.js";

export {
  createFileRecoveryAuditSink,
  createMemoryRecoveryAuditSink,
  scrubAuditRecord,
  verifyRecoveryAuditLog,
} from "./recovery-audit.js";
export type {
  RecoveryAuditApproval,
  RecoveryAuditDestination,
  RecoveryAuditEventType,
  RecoveryAuditRecord,
  RecoveryAuditSink,
  RecoveryAuditSinkOptions,
} from "./recovery-audit.js";

export {
  RECOVERY_APPROVAL_INVALID,
  RecoveryApprovalInvalidError,
  RecoveryDispatchError,
  RecoveryEgressDeniedError,
  RecoveryService,
} from "./recovery.js";
export type {
  ApproveRecoveryInput,
  RecoverInput,
  RecoveryDispatchHandle,
  RecoveryIdentityStatus,
  RecoveryServiceDeps,
} from "./recovery.js";
