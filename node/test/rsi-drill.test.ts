import { describe, expect, test } from "vitest";

import { DRILL_NAME, runRsiDrill } from "../src/drill/rsi-drill.js";
import type { RsiDrillReport } from "../src/drill/rsi-drill.js";

/**
 * DAT-271: the offline RSI drill is an executable acceptance exercise, not a
 * fixture. It runs the real stores, retrieval path, canary pins, and task
 * outcome adapter twice in fresh in-memory databases and must reproduce the
 * same normalized transcript with every governance check passing.
 */

const report: RsiDrillReport = runRsiDrill({ repeats: 2 });

describe("DAT-271 RSI offline holdout/approval/rollback drill", () => {
  test("every governance check passes", () => {
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.ok).toBe(true);
    expect(report.drill).toBe(DRILL_NAME);
  });

  test("two fresh executions reproduce the same normalized transcript", () => {
    expect(report.reproducibility.runs).toBe(2);
    expect(report.reproducibility.identical).toBe(true);
    expect(report.reproducibility.normalized_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the drill is synthetic and claims no production use", () => {
    expect(report.scope.synthetic_data).toBe(true);
    expect(report.scope.production_enabled).toBe(false);
    expect(report.scope.real_model_calls).toBe(0);
    expect(report.scope.real_provider_calls).toBe(0);
    expect(report.scope.real_permissions_used).toBe(false);
    expect(report.synthetic.holdout_query_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toContain("HOLDOUT-DRILL-SECRET");
  });

  test("the required acceptance scenarios are covered", () => {
    const ids = new Set(report.checks.map((check) => check.id));
    for (const required of [
      "class_d_target_refused",
      "holdout_read_requires_evaluator_capability",
      "holdout_content_absent_from_learning_payloads",
      "no_http_holdout_read_or_provisioning",
      "proposer_cannot_self_evaluate",
      "member_cannot_evaluate",
      "holdout_required_before_canary",
      "human_approval_required_for_class_a",
      "named_approval_recorded",
      "canary_stages_advance_on_pinned_runs",
      "promotion_publishes_exactly_one_policy_version",
      "promoted_change_reverts_to_baseline_content",
      "class_b_named_human_activation",
      "baseline_drift_before_canary_refused",
      "baseline_drift_during_canary_rolls_back",
      "change_budget_blocks_canary",
      "reflection_budget_refuses_before_rows",
      "kill_switch_rolls_back_same_call",
      "kill_switch_restores_baseline_policy",
      "kill_switch_makes_new_runs_baseline",
      "kill_switch_refuses_rsi_actions",
      "every_run_pin_is_traceable_and_stable",
      "reproducible_across_fresh_in_memory_runs",
    ]) {
      expect(ids.has(required), `missing check ${required}`).toBe(true);
    }
  });
});
