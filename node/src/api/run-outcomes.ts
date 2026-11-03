/**
 * Trusted run outcomes for canary evaluation (DAT-238).
 *
 * The canary never accepts sample counts from a request. This adapter reads
 * the task projection, which is the product's own record of a run's terminal
 * status, executed actions, and tool denials, for exactly the run ids the RSI
 * pins selected.
 */

import type { RsiRunOutcome, RsiRunOutcomeSource } from "../memory/index.js";
import type { TaskStore } from "./task-store.js";
import { isTerminalStatus } from "./task-store.js";

/** Denials that indicate prohibited/policy-evading intent, not a normal refusal. */
const SAFETY_DENIAL_CODES = new Set(["DSH_RISK_PROHIBITED", "DSH_POLICY_DENIED"]);

export function createTaskRunOutcomes(store: TaskStore): RsiRunOutcomeSource {
  return {
    outcomeFor(runId: string): RsiRunOutcome | null {
      const task = store.getByRunId(runId);
      if (task === undefined) {
        return null;
      }
      return {
        run_id: runId,
        terminal: task.terminal || isTerminalStatus(task.status),
        success: task.status === "merged" || task.status === "approved_for_merge",
        rework: task.status === "rejected" || task.status === "stopped",
        safety_events: task.events.filter(
          (event) =>
            event.type === "tool.denied" &&
            SAFETY_DENIAL_CODES.has(String(event.data["error_code"] ?? "")),
        ).length,
        actions: task.progress.actions_completed,
        observed_at: task.updatedAt,
      };
    },
  };
}
