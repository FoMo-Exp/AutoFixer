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
