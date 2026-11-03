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
