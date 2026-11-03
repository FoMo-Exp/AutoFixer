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

export { SecurityNotifier, mintCaseReference, verifyCaseReference } from "./notify.js";
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
