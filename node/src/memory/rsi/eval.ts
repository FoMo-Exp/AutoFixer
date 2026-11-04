/**
 * Offline replay for RSI evaluation (DAT-238).
 *
 * Replay runs the real retrieval path against the workspace corpus under two
 * arms — the promoted policy or candidate-excluded corpus (baseline), and the
 * proposed policy or candidate-included corpus (candidate) — and compares them
 * on curated cases. No model is called, and no case content is returned: the
 * caller receives aggregate metrics only.
 *
 * The candidate policy goes through `preview`, which never stores a policy
 * version and never records a retrieval run. A proposal therefore cannot
 * become retrievable simply by being evaluated.
 */

import { ValidationError } from "../../control-plane/errors.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import type { MemoryRetrievalService, RetrievalPolicy } from "../retrieval/index.js";
import { RSI_DEFAULTS } from "./constants.js";
import { newcombeDifference } from "./stats.js";
import type { RsiStore } from "./store.js";
import { holdoutRead } from "./store.js";
import type { RsiArtifactKind, RsiDataset, RsiEvalCase, RsiEvalMetrics } from "./types.js";

export interface ReplayArtifact {
  kind: RsiArtifactKind;
  baseline_policy: RetrievalPolicy;
  /** Required for `retrieval_policy`; unused for `memory_item`. */
  candidate_policy: RetrievalPolicy | null;
}

export interface ReplayDatasetResult {
  dataset: RsiDataset;
  metrics: RsiEvalMetrics;
  /** Tokens spent assembling both arms, counted against the reflection budget. */
  reflection_tokens: number;
}

export interface RsiReplayDeps {
  store: RsiStore;
  retrieval: MemoryRetrievalService;
}

interface CaseOutcome {
  baseline_ok: boolean;
  candidate_ok: boolean;
  baseline_missing: number;
  candidate_missing: number;
  baseline_cost: number;
  candidate_cost: number;
  safety_events: number;
}

function loadCases(deps: RsiReplayDeps, scope: WorkspaceScope, dataset: RsiDataset) {
  return dataset === "holdout"
    ? deps.store.listHoldoutCases(scope, holdoutRead())
    : deps.store.listGoldenCases(scope);
}

function summarise(outcomes: readonly CaseOutcome[]): RsiEvalMetrics {
  const sample = outcomes.length;
  const baselineSuccesses = outcomes.filter((entry) => entry.baseline_ok).length;
  const candidateSuccesses = outcomes.filter((entry) => entry.candidate_ok).length;
  const estimate = newcombeDifference(candidateSuccesses, sample, baselineSuccesses, sample);
  return {
    sample_size: sample * 2,
    baseline_sample_size: sample,
    candidate_sample_size: sample,
    baseline_successes: baselineSuccesses,
    candidate_successes: candidateSuccesses,
    baseline_rework: outcomes.reduce((sum, entry) => sum + entry.baseline_missing, 0),
    candidate_rework: outcomes.reduce((sum, entry) => sum + entry.candidate_missing, 0),
    baseline_cost: outcomes.reduce((sum, entry) => sum + entry.baseline_cost, 0),
    candidate_cost: outcomes.reduce((sum, entry) => sum + entry.candidate_cost, 0),
    safety_events: outcomes.reduce((sum, entry) => sum + entry.safety_events, 0),
    success_delta: estimate.delta,
    delta_ci_low: estimate.low,
    delta_ci_high: estimate.high,
  };
}

function evaluateCase(
  deps: RsiReplayDeps,
  scope: WorkspaceScope,
  testCase: RsiEvalCase,
  artifact: ReplayArtifact,
): CaseOutcome {
  const baseRequest = {
    purpose: "eval_replay" as const,
    query: testCase.query,
    scope: testCase.scope,
    role: testCase.role,
    context_window_tokens: RSI_DEFAULTS.replay_context_window_tokens,
  };
  const candidatePolicy = artifact.candidate_policy ?? artifact.baseline_policy;
  // A memory-item proposal is measured with and without candidate injection:
  // the baseline arm must not see the unapproved candidate at all.
  const includeBaseline = artifact.kind !== "memory_item";
  const baseline = deps.retrieval.preview(
    scope,
    { ...baseRequest, include_candidates: includeBaseline },
    artifact.baseline_policy,
  );
  const candidate = deps.retrieval.preview(
    scope,
    { ...baseRequest, include_candidates: true },
    candidatePolicy,
  );

  const baselineIds = new Set(baseline.items.map((item) => item.item_id));
  const candidateIds = new Set(candidate.items.map((item) => item.item_id));
  const baselineMissing = testCase.expected_item_ids.filter((id) => !baselineIds.has(id)).length;
  const candidateMissing = testCase.expected_item_ids.filter((id) => !candidateIds.has(id)).length;
  const baselineForbidden = testCase.forbidden_item_ids.filter((id) => baselineIds.has(id)).length;
  const candidateForbidden = testCase.forbidden_item_ids.filter((id) =>
    candidateIds.has(id),
  ).length;
  return {
    baseline_ok: baselineMissing === 0 && baselineForbidden === 0,
    candidate_ok: candidateMissing === 0 && candidateForbidden === 0,
    baseline_missing: baselineMissing,
    candidate_missing: candidateMissing,
    baseline_cost: baseline.used_tokens,
    candidate_cost: candidate.used_tokens,
    safety_events: baselineForbidden + candidateForbidden,
  };
}

/**
 * Replay one dataset. An empty dataset is a hard refusal: a gate must never
 * fail open because the acceptance set happened to be missing.
 */
export function replayDataset(
  deps: RsiReplayDeps,
  scope: WorkspaceScope,
  dataset: RsiDataset,
  artifact: ReplayArtifact,
): ReplayDatasetResult {
  const cases = loadCases(deps, scope, dataset);
  if (cases.length === 0) {
    throw new ValidationError(`rsi ${dataset} dataset has no cases`);
  }
  const outcomes = cases.map((testCase) => evaluateCase(deps, scope, testCase, artifact));
  const metrics = summarise(outcomes);
  return {
    dataset,
    metrics,
    reflection_tokens: Math.ceil(metrics.baseline_cost + metrics.candidate_cost),
  };
}
