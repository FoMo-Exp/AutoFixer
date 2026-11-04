/**
 * Workspace memory public API (DAT-232).
 *
 * Re-exports the entity types, the content-hash contract, and the repository
 * factory. The raw database handle stays inside the repository
 * implementations — handlers receive only the scoped repository interfaces.
 */

export { memoryContentHash } from "./hash.js";
export type { MemoryContentInput } from "./hash.js";

export type {
  MemoryAuditRepository,
  MemoryEmbeddingRepository,
  MemoryTimelineEntry,
  MemoryTimelinePosition,
  MemoryEvidenceRepository,
  MemoryItemRepository,
  MemoryLinkRepository,
  MemoryRepositories,
  MemoryTombstoneRepository,
} from "./repositories.js";
export { createMemoryRepositories } from "./repositories.js";

export type {
  AddMemoryEvidenceInput,
  AddMemoryVersionInput,
  CreateMemoryItemInput,
  CreateMemoryLinkInput,
  MemoryApplicability,
  MemoryEmbedding,
  MemoryEmbeddingId,
  MemoryEvent,
  MemoryEventFilter,
  MemoryEventId,
  MemoryEvidence,
  MemoryEvidenceId,
  MemoryEvidenceType,
  MemoryExport,
  MemoryExportItem,
  MemoryItem,
  MemoryItemId,
  MemoryItemRecord,
  MemoryItemVersion,
  MemoryKind,
  MemoryLink,
  MemoryLinkId,
  MemoryLinkType,
  MemoryListFilter,
  MemoryProvenance,
  MemoryReview,
  MemorySensitivity,
  MemorySearchFilter,
  MemoryStatus,
  MemoryTombstone,
  MemoryTombstoneId,
  MemoryTombstoneReason,
  MemoryTrust,
  PutMemoryEmbeddingInput,
} from "./types.js";
export { MEMORY_SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Candidate admission (DAT-234)
// ---------------------------------------------------------------------------

export {
  admitCandidate,
  allowsFactualInjection,
  createMemoryAdmissionRepository,
  emptyEvidenceResolver,
  evidenceKey,
  evaluateCandidate,
  findContradictions,
  findDuplicate,
  isDuplicate,
  isRetrievalEligible,
  ledgerEvidenceResolver,
  lintForPolicyInstructions,
  retirementProposalsFor,
  scanForInjection,
  ADMISSION_CHECKS,
  ADMISSION_REASONS,
} from "./admission/index.js";
export type {
  AdmissionCandidate,
  AdmissionCheck,
  AdmissionCheckResult,
  AdmissionCheckStatus,
  AdmissionDisposition,
  AdmissionOutcome,
  AdmissionReason,
  AdmissionVerdict,
  AdmitOptions,
  CandidateEvidenceRef,
  ContradictionFinding,
  DuplicateFinding,
  EligibilityInput,
  EvidenceResolution,
  EvidenceResolver,
  MemoryAdmissionDecision,
  MemoryAdmissionRepository,
  MemoryRetirementCandidate,
  PolicyReason,
  RetirementAction,
  RetirementCandidate,
} from "./admission/index.js";

// Lifecycle surface (DAT-235): risk-graded promotion, named human approval,
// scheduled consolidation, and deletion rules. See
// `docs/contracts/memory-lifecycle-v1.md`.
export * from "./lifecycle/index.js";

// Bounded retrieval, ranking, budget, conflict and degraded-mode surface
// (DAT-236). Re-exported here so callers depend on one memory module.
export * from "./retrieval/index.js";

// Bounded RSI (DAT-238): proposals, offline replay, approvals, canary,
// rollback, weekly budgets, run version pins, and the workspace kill switch.
export * from "./rsi/index.js";

// Workspace memory governance (DAT-251): item detail, per-version content,
// the audit timeline, and promote/deprecate/quarantine/restore. See
// `docs/contracts/memory-governance-v1.md`.
export * from "./governance/index.js";

// Quarantine redaction shared by browse and governance (DAT-251).
export {
  REDACTED_EVIDENCE_PREFIX,
  isQuarantined,
  opaqueEvidenceReference,
  servedEvidence,
  servedPreconditions,
  servedStatement,
} from "./redact.js";
export type { ServedEvidence } from "./redact.js";
