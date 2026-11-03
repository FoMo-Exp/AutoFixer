/**
 * Memory lifecycle surface (DAT-235): risk-graded promotion, named human
 * approval, scheduled consolidation with its fixed operation vocabulary, and
 * the deletion rules that keep deleted memory deleted. See
 * `docs/contracts/memory-lifecycle-v1.md` for the contract.
 */

export { assessIndependentSupport, citationKey } from "./independence.js";
export type { IndependentSupport } from "./independence.js";

export { approveAndPromote, assessAndAutoPromote, evaluatePromotion } from "./promotion.js";
export type { AutoPromoteInput, PromotionAssessment, PromotionServiceDeps } from "./promotion.js";

export { runConsolidation, scheduleMemoryConsolidation } from "./consolidation.js";
export type {
  ConsolidationDeps,
  ConsolidationScheduleHandle,
  ConsolidationScheduleOptions,
} from "./consolidation.js";

export {
  createMemoryConsolidationRunner,
  DEFAULT_MEMORY_CONSOLIDATION_INTERVAL_MS,
} from "./runner.js";
export type { MemoryConsolidationRunner, MemoryConsolidationRunnerOptions } from "./runner.js";

export { createMemoryLifecycleStore, promotionPolicyDigest } from "./repositories.js";
export type {
  MemoryLifecycleStore,
  MemoryPromotionPolicyRecord,
  PromotionDecisionInput,
  PromotionDecisionRecord,
} from "./repositories.js";

export {
  CONSOLIDATION_OPS,
  CONSOLIDATION_OP_REASONS,
  DEFAULT_CONSOLIDATION_BOUNDS,
  DEFAULT_PROMOTION_POLICY,
  MAX_CONSOLIDATION_ITEMS_SCANNED,
  MAX_CONSOLIDATION_OPS,
  PROMOTION_BLOCK_REASONS,
} from "./types.js";
export type {
  ConsolidationOp,
  ConsolidationOpReason,
  ConsolidationOpRecord,
  ConsolidationOptions,
  ConsolidationReport,
  EvaluationStanding,
  EvidenceCitation,
  FactVerifier,
  MemoryPromotionPolicy,
  ProposedOp,
  PromotionBlockReason,
  PromotionDecision,
  PromotionReason,
  RunSupport,
  UsageStat,
  ValidationStanding,
} from "./types.js";
