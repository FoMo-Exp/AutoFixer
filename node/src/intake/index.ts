/**
 * Log intake pipeline (DAT-216, ADR-0007 "Log intake and issue creation").
 *
 * The module turns controlled log-source alerts into deduplicated product
 * issues: a service-owned connector seam with one reference adapter, durable
 * cursors with persist-before-ack, provider-event and versioned-fingerprint
 * deduplication, explicit outcomes for backpressure, outages, retention gaps
 * and out-of-order arrivals, deterministic pre-model rules (severity,
 * service/environment, error signature, rate/window, suppression, repository
 * mapping) with audited suppression, triage for unresolved repository
 * mapping, source/workspace budgets and cooldowns with a bounded deferred
 * backlog, manual submission, and model-input minimization dispatched only
 * through the ADR-0005 gateway.
 */
export {
  ConnectorProtocolError,
  ConnectorUnavailableError,
  createHttpJsonPollConnector,
} from "./connector.js";
export type {
  ConnectorBatch,
  ConnectorCursor,
  ConnectorTransport,
  ConnectorTransportRequest,
  ConnectorTransportResponse,
  HttpJsonPollConnectorOptions,
  LogSourceConnector,
  ProviderLogEvent,
  RetentionGap,
} from "./connector.js";
export {
  SIGNAL_FINGERPRINT_VERSION,
  errorSignature,
  normalizeErrorClass,
  normalizeMessage,
  normalizeStackLocations,
  signalFingerprint,
} from "./fingerprint.js";
export type { ErrorShape, SignalIdentity } from "./fingerprint.js";
export { evaluateRules, fallbackSeverity } from "./rules.js";
export type {
  CanonicalSeverity,
  IntakeRule,
  RateObservation,
  RepositoryCandidate,
  RepositoryMapping,
  RepositoryMappingStatus,
  RuleConfig,
  RuleDecisionFields,
  RuleEvaluationInput,
  RuleMatch,
  SignalDecision,
  SuppressionDecision,
} from "./rules.js";
export { IntakeStore } from "./store.js";
export type { BudgetConfig, BudgetStatusView, IntakeStoreOptions } from "./store.js";
export { CURRENT_SCHEMA_VERSION, normalizePersistedState } from "./migration.js";
export type { NormalizedState } from "./migration.js";
export { LogIntake, MANUAL_SOURCE_ID, validateProviderEvent } from "./pipeline.js";
export type {
  BatchReport,
  DrainReport,
  EventOutcome,
  IssueSink,
  LogIntakeDeps,
  ManualSubmissionInput,
  PollReport,
  ResolveTriageInput,
  ResolveTriageResult,
  SourceConfig,
  SourceStatus,
} from "./pipeline.js";
export {
  BRIEFING_FIELD_MAX,
  BRIEFING_MESSAGE_MAX,
  BRIEFING_STACK_MAX,
  minimizeSignal,
} from "./minimize.js";
export type { MinimizeInput, ModelSignalBriefing } from "./minimize.js";
export { buildAnalysisContext, dispatchBriefing } from "./analysis.js";
export type { BriefingDispatch } from "./analysis.js";
export { IntakeError } from "./errors.js";
export { emptySourceCounts } from "./types.js";
export type {
  BudgetDenial,
  BudgetDenialReason,
  DeferredSignal,
  EventOutcomeKind,
  EventRecord,
  EvidenceRecord,
  GapRecord,
  SignalRecord,
  SourceConnection,
  SourceCounts,
  SourceState,
  SuppressionRecord,
  TriageReason,
  TriageRecord,
  WorkspaceScope,
} from "./types.js";
