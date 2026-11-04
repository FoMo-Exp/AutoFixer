/**
 * Workspace memory governance surface (DAT-251): detail, per-version content,
 * the item audit timeline, and the four named human transitions. See
 * `docs/contracts/memory-governance-v1.md`.
 */

export { createMemoryGovernanceService } from "./service.js";
export type {
  MemoryGovernanceService,
  MemoryGovernanceServiceDeps,
  MemoryTeamDirectory,
} from "./service.js";

export {
  MEMORY_EVENT_SOURCES,
  MEMORY_GOVERNANCE_ACTIONS,
  MEMORY_GOVERNANCE_REASON_CODES,
  MEMORY_RESTORE_TARGET_STATUSES,
} from "./types.js";
export type {
  DeprecateMemoryItemRequest,
  MemoryEventSource,
  MemoryGovernanceAction,
  MemoryGovernanceActor,
  MemoryGovernanceReasonCode,
  MemoryGovernanceResult,
  MemoryItemEventView,
  MemoryItemEventsView,
  MemoryItemVersionView,
  MemoryItemVersionsView,
  MemoryRestoreTargetStatus,
  PromoteMemoryItemRequest,
  QuarantineMemoryItemRequest,
  RestoreMemoryItemRequest,
} from "./types.js";
