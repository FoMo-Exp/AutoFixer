/**
 * Bounded retrieval public surface (DAT-236).
 *
 * Handlers get a service backed by scoped repositories and a scoped retrieval
 * store; they never touch SQL or the raw database handle.
 */

export { createRetrievalStore } from "./store.js";
export type {
  CorpusEntry,
  CorpusSummary,
  MemoryRetrievalRunRecord,
  RecordRetrievalRunInput,
  RetrievalStore,
} from "./store.js";

export { createMemoryRetrievalService } from "./service.js";
export type { MemoryRetrievalService, MemoryRetrievalServiceDeps } from "./service.js";

export {
  DEFAULT_RETRIEVAL_POLICY,
  canonicalRetrievalPolicy,
  parseRetrievalPolicy,
  retrievalPolicyHash,
  validateRetrievalPolicy,
} from "./policy.js";

export {
  allowedSensitivities,
  applicabilityMatches,
  approvalSatisfied,
  assessEligibility,
  isApproved,
  isEligiblePolicy,
  itemTokenEstimate,
  scoreMemoryItem,
  sensitivityCeiling,
  withinSensitivityCeiling,
} from "./rank.js";
export type { EligibilityContext, EligibilityResult, ScoreInput } from "./rank.js";

export {
  bm25Scores,
  computeMemoryVersion,
  cosineSimilarity,
  describeApplicability,
  estimateTokens,
  recencyScore,
  sanitizeMemoryText,
  tokenize,
} from "./text.js";

export {
  MEMORY_EVIDENCE_TYPES,
  MEMORY_KINDS,
  MEMORY_LINK_TYPES,
  MEMORY_SENSITIVITIES,
  MEMORY_STATUSES,
  MEMORY_TRUSTS,
} from "./constants.js";

export * from "./types.js";
