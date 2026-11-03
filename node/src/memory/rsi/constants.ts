/**
 * Fixed RSI bounds (DAT-238).
 *
 * These are code constants, not workspace settings: the learning loop cannot
 * raise its own sample sizes, regression ceilings, or approval requirements.
 * A workspace may only tighten behaviour by disabling automatic promotion,
 * lowering its weekly budget, or using the kill switch.
 */

import type { RsiApprovalKey, RsiCanaryStage, RsiRisk } from "./types.js";

export const RSI_HARD_LIMITS = Object.freeze({
  title_chars: 160,
  summary_chars: 2_000,
  diff_chars: 20_000,
  reason_chars: 1_000,
  note_chars: 1_000,
  evidence_reference_chars: 300,
  query_chars: 2_000,
  item_id_chars: 200,
  expected_items_per_case: 50,
  cases_per_dataset: 1_000,
  proposals_returned: 200,
  evaluations_returned: 50,
  approvals_returned: 20,
  observations_returned: 100,
});

export const RSI_DEFAULTS = Object.freeze({
  weekly_change_budget: 3,
  weekly_reflection_token_budget: 200_000,
  auto_promote_low_risk: false,
  /** Canonical context window used when replaying an evaluation case. */
  replay_context_window_tokens: 32_000,
});

/** Minimum paired cases per arm before a verdict may pass. */
export const RSI_MIN_SAMPLE = 20;

/** Each canary stage needs this many candidate runs before it can advance. */
export const RSI_STAGE_MIN_SAMPLE: Readonly<Record<RsiCanaryStage, number>> = Object.freeze({
  10: 10,
  50: 25,
  100: 50,
});

/** A success-rate drop larger than this blocks promotion and triggers rollback. */
export const RSI_MAX_SUCCESS_REGRESSION = 0.02;
/** Rework may not grow by more than five percentage points. */
export const RSI_MAX_REWORK_GROWTH = 0.05;
/** Cost may not grow by more than 25%. */
export const RSI_MAX_COST_GROWTH = 0.25;
/** Deterministic canary bucketing resolution (basis points). */
export const RSI_BUCKET_COUNT = 10_000;

/** Ordered approval keys; C requires two distinct humans with both keys. */
export const RSI_RISK_APPROVALS: Readonly<Record<RsiRisk, readonly RsiApprovalKey[]>> =
  Object.freeze({
    A: ["single"],
    B: ["single"],
    C: ["owner", "reviewer"],
    D: [],
  });
