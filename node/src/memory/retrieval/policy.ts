/**
 * Versioned retrieval policy (DAT-236).
 *
 * A policy is a small, validated bundle of weights and bounds. It is stored
 * immutably with a monotonic version number and a canonical hash so every
 * bundle can name exactly the policy that produced it. Hard ceilings live in
 * code and are applied on top of any stored policy: a policy can be stricter,
 * never looser.
 */

import { createHash } from "node:crypto";

import { ValidationError } from "../../control-plane/errors.js";
import type { MemoryEvidenceType, MemoryTrust } from "../types.js";
import { MEMORY_EVIDENCE_TYPES } from "./constants.js";
import type { RetrievalPolicy, RetrievalWeights } from "./types.js";
import { RETRIEVAL_DEFAULTS, RETRIEVAL_HARD_LIMITS } from "./types.js";

/** ADR-0009 defaults: relevance dominates, contradiction is a real penalty. */
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = Object.freeze({
  weights: Object.freeze({
    relevance: 0.45,
    importance: 0.15,
    recency: 0.15,
    confidence: 0.1,
    trust: 0.15,
    contradiction: 0.35,
  }),
  hybrid_weights: Object.freeze({ lexical: 0.6, vector: 0.4 }),
  bounds: Object.freeze({
    max_items: RETRIEVAL_DEFAULTS.max_items,
    max_tokens: RETRIEVAL_DEFAULTS.max_tokens,
    max_context_share: RETRIEVAL_DEFAULTS.max_context_share,
    context_window_tokens: RETRIEVAL_DEFAULTS.context_window_tokens,
    relevance_floor: RETRIEVAL_DEFAULTS.relevance_floor,
    candidate_weight: RETRIEVAL_DEFAULTS.candidate_weight,
    candidate_max: RETRIEVAL_DEFAULTS.candidate_max,
    recency_half_life_days: RETRIEVAL_DEFAULTS.recency_half_life_days,
    trust_class_weights: Object.freeze({
      human: 1,
      enterprise_template: 0.85,
      system: 0.7,
      agent: 0.5,
    }),
    evidence_class_boost: Object.freeze({
      reviewer_decision: 0.1,
      test: 0.05,
      pr: 0.04,
      incident: 0.04,
      issue: 0.02,
      commit: 0.02,
      run: 0.01,
    }),
  }) as RetrievalPolicy["bounds"],
}) as RetrievalPolicy;

const TRUST_CLASSES: readonly MemoryTrust[] = ["human", "agent", "enterprise_template", "system"];

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function bounded(label: string, value: unknown, min: number, max: number): number {
  const parsed = finite(value, label);
  if (parsed < min || parsed > max) {
    throw new ValidationError(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function integerBounded(label: string, value: unknown, min: number, max: number): number {
  const parsed = bounded(label, value, min, max);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`${label} must be an integer`);
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate and bound a policy. Anything outside the hard ceilings is rejected
 * rather than silently clamped, so a policy change cannot quietly become a
 * different policy than the one an operator reviewed.
 */
export function validateRetrievalPolicy(input: unknown): RetrievalPolicy {
  const root = record(input, "retrieval_policy");
  const weightsIn = record(root["weights"], "retrieval_policy.weights");
  const hybridIn = record(root["hybrid_weights"], "retrieval_policy.hybrid_weights");
  const boundsIn = record(root["bounds"], "retrieval_policy.bounds");

  const weights: RetrievalWeights = {
    relevance: bounded("weights.relevance", weightsIn["relevance"], 0, 2),
    importance: bounded("weights.importance", weightsIn["importance"], 0, 2),
    recency: bounded("weights.recency", weightsIn["recency"], 0, 2),
    confidence: bounded("weights.confidence", weightsIn["confidence"], 0, 2),
    trust: bounded("weights.trust", weightsIn["trust"], 0, 2),
    contradiction: bounded("weights.contradiction", weightsIn["contradiction"], 0, 2),
  };
  if (weights.relevance <= 0) {
    throw new ValidationError("weights.relevance must be positive");
  }

  const trustIn = record(boundsIn["trust_class_weights"], "bounds.trust_class_weights");
  const trustClassWeights = {} as Record<MemoryTrust, number>;
  for (const trust of TRUST_CLASSES) {
    trustClassWeights[trust] = bounded(`bounds.trust_class_weights.${trust}`, trustIn[trust], 0, 1);
  }

  const boostIn = record(boundsIn["evidence_class_boost"], "bounds.evidence_class_boost");
  const evidenceClassBoost = {} as Record<MemoryEvidenceType, number>;
  for (const evidence of MEMORY_EVIDENCE_TYPES) {
    evidenceClassBoost[evidence] = bounded(
      `bounds.evidence_class_boost.${evidence}`,
      boostIn[evidence],
      0,
      0.5,
    );
  }

  const hybridLexical = bounded("hybrid_weights.lexical", hybridIn["lexical"], 0, 1);
  const hybridVector = bounded("hybrid_weights.vector", hybridIn["vector"], 0, 1);
  if (hybridLexical + hybridVector <= 0) {
    throw new ValidationError("hybrid_weights must give relevance some weight");
  }
  const hybridWeights = {
    lexical: hybridLexical / (hybridLexical + hybridVector),
    vector: hybridVector / (hybridLexical + hybridVector),
  };

  return {
    weights,
    hybrid_weights: hybridWeights,
    bounds: {
      max_items: integerBounded(
        "bounds.max_items",
        boundsIn["max_items"],
        1,
        RETRIEVAL_HARD_LIMITS.max_items,
      ),
      max_tokens: integerBounded(
        "bounds.max_tokens",
        boundsIn["max_tokens"],
        1,
        RETRIEVAL_HARD_LIMITS.max_tokens,
      ),
      max_context_share: bounded(
        "bounds.max_context_share",
        boundsIn["max_context_share"],
        0.01,
        RETRIEVAL_HARD_LIMITS.max_context_share,
      ),
      context_window_tokens: integerBounded(
        "bounds.context_window_tokens",
        boundsIn["context_window_tokens"],
        1_000,
        2_000_000,
      ),
      relevance_floor: bounded("bounds.relevance_floor", boundsIn["relevance_floor"], 0, 1),
      candidate_weight: bounded("bounds.candidate_weight", boundsIn["candidate_weight"], 0, 1),
      candidate_max: integerBounded(
        "bounds.candidate_max",
        boundsIn["candidate_max"],
        0,
        RETRIEVAL_HARD_LIMITS.candidate_max,
      ),
      recency_half_life_days: bounded(
        "bounds.recency_half_life_days",
        boundsIn["recency_half_life_days"],
        0.5,
        365,
      ),
      trust_class_weights: trustClassWeights,
      evidence_class_boost: evidenceClassBoost,
    },
  };
}

/** Parse a stored policy JSON row; corrupt rows fail closed. */
export function parseRetrievalPolicy(json: string): RetrievalPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new ValidationError("stored retrieval policy is not valid JSON");
  }
  return validateRetrievalPolicy(parsed);
}

/**
 * Canonical policy JSON: fixed key order and ordered nested maps, so an
 * unchanged policy always hashes identically across processes.
 */
export function canonicalRetrievalPolicy(policy: RetrievalPolicy): string {
  const w = policy.weights;
  const b = policy.bounds;
  const trustPairs = TRUST_CLASSES.map(
    (trust) => `${JSON.stringify(trust)}:${JSON.stringify(b.trust_class_weights[trust])}`,
  ).join(",");
  const boostPairs = MEMORY_EVIDENCE_TYPES.map(
    (evidence) => `${JSON.stringify(evidence)}:${JSON.stringify(b.evidence_class_boost[evidence])}`,
  ).join(",");
  return (
    `{"bounds":{"candidate_max":${JSON.stringify(b.candidate_max)},` +
    `"candidate_weight":${JSON.stringify(b.candidate_weight)},` +
    `"context_window_tokens":${JSON.stringify(b.context_window_tokens)},` +
    `"evidence_class_boost":{${boostPairs}},` +
    `"max_context_share":${JSON.stringify(b.max_context_share)},` +
    `"max_items":${JSON.stringify(b.max_items)},` +
    `"max_tokens":${JSON.stringify(b.max_tokens)},` +
    `"recency_half_life_days":${JSON.stringify(b.recency_half_life_days)},` +
    `"relevance_floor":${JSON.stringify(b.relevance_floor)},` +
    `"trust_class_weights":{${trustPairs}}},` +
    `"hybrid_weights":{"lexical":${JSON.stringify(policy.hybrid_weights.lexical)},` +
    `"vector":${JSON.stringify(policy.hybrid_weights.vector)}},` +
    `"weights":{"confidence":${JSON.stringify(w.confidence)},` +
    `"contradiction":${JSON.stringify(w.contradiction)},` +
    `"importance":${JSON.stringify(w.importance)},` +
    `"recency":${JSON.stringify(w.recency)},` +
    `"relevance":${JSON.stringify(w.relevance)},` +
    `"trust":${JSON.stringify(w.trust)}}}`
  );
}

export function retrievalPolicyHash(policy: RetrievalPolicy): string {
  return createHash("sha256").update(canonicalRetrievalPolicy(policy), "utf8").digest("hex");
}
