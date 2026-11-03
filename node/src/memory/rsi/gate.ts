/**
 * RSI gate arithmetic (DAT-238).
 *
 * The verdict, the required approval keys, and the canary bucket are pure
 * functions of stored evidence and fixed bounds. Keeping them here means the
 * same rule decides an offline replay, a canary observation, and a rollback,
 * and that no workspace setting can relax a regression ceiling.
 */

import { createHash } from "node:crypto";

import type { RsiEvalMetrics } from "./types.js";
import type { RsiApprovalKey, RsiControls, RsiEvalVerdict, RsiRisk } from "./types.js";
import {
  RSI_BUCKET_COUNT,
  RSI_MAX_COST_GROWTH,
  RSI_MAX_REWORK_GROWTH,
  RSI_MAX_SUCCESS_REGRESSION,
  RSI_MIN_SAMPLE,
  RSI_RISK_APPROVALS,
} from "./constants.js";

export interface GateOutcome {
  verdict: RsiEvalVerdict;
  reasons: string[];
}

/**
 * Judge one arm comparison. `inconclusive` is a refusal, not a soft pass: it
 * blocks promotion until more evidence exists.
 */
export function verdictFor(metrics: RsiEvalMetrics, minSample = RSI_MIN_SAMPLE): GateOutcome {
  const reasons: string[] = [];
  if (metrics.sample_size < minSample) {
    return {
      verdict: "inconclusive",
      reasons: [`sample ${metrics.sample_size} is below the minimum ${minSample}`],
    };
  }
  if (
    metrics.baseline_successes > metrics.sample_size ||
    metrics.candidate_successes > metrics.sample_size
  ) {
    return { verdict: "fail", reasons: ["success counts exceed the sample size"] };
  }
  if (metrics.safety_events > 0) {
    reasons.push(`security events: ${metrics.safety_events} forbidden item injection(s)`);
  }
  if (metrics.success_delta < 0) {
    reasons.push(`success rate regressed by ${(-metrics.success_delta).toFixed(4)}`);
  }
  // The interval must not establish a regression beyond the margin. A whole
  // interval at or below -margin is a statistically meaningful regression,
  // while two identical arms cannot fail merely because the interval is wide.
  if (metrics.delta_ci_high < -RSI_MAX_SUCCESS_REGRESSION) {
    reasons.push(
      `confidence upper bound ${metrics.delta_ci_high.toFixed(4)} is below -${RSI_MAX_SUCCESS_REGRESSION}`,
    );
  }
  const reworkGrowth =
    (metrics.candidate_rework - metrics.baseline_rework) / Math.max(1, metrics.sample_size);
  if (reworkGrowth > RSI_MAX_REWORK_GROWTH) {
    reasons.push(`rework grew by ${reworkGrowth.toFixed(4)} per sample`);
  }
  const costGrowth =
    metrics.baseline_cost > 0
      ? (metrics.candidate_cost - metrics.baseline_cost) / metrics.baseline_cost
      : metrics.candidate_cost > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  if (costGrowth > RSI_MAX_COST_GROWTH) {
    reasons.push(`context cost grew by ${(costGrowth * 100).toFixed(1)}%`);
  }
  return reasons.length === 0 ? { verdict: "pass", reasons: [] } : { verdict: "fail", reasons };
}

/**
 * Approval keys the proposal needs. Class A is exempt only when the workspace
 * explicitly enabled automatic promotion; a disabled switch makes it human.
 */
export function requiredApprovalKeys(
  risk: RsiRisk,
  controls: RsiControls,
): readonly RsiApprovalKey[] {
  if (risk === "A" && controls.auto_promote_low_risk) {
    return [];
  }
  return RSI_RISK_APPROVALS[risk];
}

/**
 * Deterministic canary bucket for one run, stable across retries of the same
 * run id: 0 .. 9999.
 */
export function canaryBucket(workspaceId: string, runId: string): number {
  const digest = createHash("sha256").update(`${workspaceId}\u0000${runId}`).digest();
  return digest.readUInt32BE(0) % RSI_BUCKET_COUNT;
}
