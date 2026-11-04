/**
 * Trusted run outcomes for canary evaluation (DAT-238).
 *
 * The canary never accepts sample counts from a request, and it never borrows
 * a task-level aggregate for one of several runs. A pinned run's terminal
 * state, success, rework, actions, and safety events all come from that run's
 * own `TaskRecord.runs` entry. Only a task with exactly one run can use the
 * task-level aggregates as an equivalent recording of that run; a multi-run
 * task without run-level evidence yields `null` and is excluded from the
 * sample (fail closed, never "missing as zero").
 */

import type { RsiRunOutcome, RsiRunOutcomeSource } from "../memory/index.js";
import type { TaskStore } from "./task-store.js";

/** Denials that indicate prohibited/policy-evading intent, not a normal refusal. */
export const SAFETY_DENIAL_CODES: ReadonlySet<string> = new Set([
  "DSH_RISK_PROHIBITED",
  "DSH_POLICY_DENIED",
]);

/** dsh run states that end a run; success/rework are derived from the same run. */
const TERMINAL_DSH_STATES: ReadonlySet<string> = new Set([
  "stopped",
  "timed_out",
  "expired",
  "rejected",
  "cancelled",
  "merged",
]);

export function createTaskRunOutcomes(store: TaskStore): RsiRunOutcomeSource {
  return {
    outcomeFor(runId: string): RsiRunOutcome | null {
      const task = store.getByRunId(runId);
      if (task === undefined) {
        return null;
      }
      const run = task.runs.find((entry) => entry.run_id === runId);
      if (run === undefined) {
        return null;
      }
      // Exactly one run on the task makes the task-level aggregates an
      // attributable recording; with several runs they belong to no single
      // run and must not be borrowed.
      const singleRun = task.runs.length === 1;
      const attributedActions =
        run.actions_completed ?? (singleRun ? task.progress.actions_completed : undefined);
      const attributedSafety =
        run.safety_events ??
        (singleRun
          ? task.events.filter(
              (event) =>
                event.type === "tool.denied" &&
                SAFETY_DENIAL_CODES.has(String(event.data["error_code"] ?? "")),
            ).length
          : undefined);
      if (attributedActions === undefined || attributedSafety === undefined) {
        return null;
      }
      return {
        run_id: runId,
        terminal: TERMINAL_DSH_STATES.has(run.state),
        success: run.state === "merged" || run.state === "approved_for_merge",
        rework: run.state === "rejected" || run.state === "stopped",
        safety_events: attributedSafety,
        actions: attributedActions,
        observed_at: run.updated_at ?? task.updatedAt,
      };
    },
  };
}
