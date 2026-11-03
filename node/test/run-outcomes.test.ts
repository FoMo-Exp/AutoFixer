import { describe, expect, test } from "vitest";

import { createTaskRunOutcomes } from "../src/api/run-outcomes.js";
import { TaskStore, createTaskRecord } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";

/**
 * DAT-238 blocker 1: canary samples must come from the task projection. These
 * tests pin the mapping from a run's recorded task to a trusted outcome.
 */

function record(runId: string): { store: TaskStore; task: TaskRecord } {
  const store = new TaskStore();
  const task = createTaskRecord({
    id: `tsk_${runId}`,
    repository: {
      id: "github:test/repo",
      display_name: "test/repo",
      base_ref: "main",
      base_sha: "0".repeat(40),
    },
    summary: "outcome fixture",
    sourceReference: null,
    acceptanceCriteria: [],
  });
  task.runId = runId;
  store.put(task);
  return { store, task };
}

describe("trusted run outcomes", () => {
  test("an unknown run has no outcome", () => {
    const { store } = record("run_known");
    expect(createTaskRunOutcomes(store).outcomeFor("run_missing")).toBeNull();
  });

  test("a queued run is non-terminal and not counted", () => {
    const { store } = record("run_queued");
    const outcome = createTaskRunOutcomes(store).outcomeFor("run_queued");
    expect(outcome?.terminal).toBe(false);
    expect(outcome?.success).toBe(false);
  });

  test("merged is a success; rejected/stopped is rework", () => {
    const { store, task } = record("run_merged");
    task.status = "merged";
    task.terminal = true;
    task.progress = { phase: "validating", actions_completed: 7, actions_total: 7 };
    const source = createTaskRunOutcomes(store);

    expect(source.outcomeFor("run_merged")).toMatchObject({
      terminal: true,
      success: true,
      rework: false,
      actions: 7,
    });

    task.status = "rejected";
    expect(source.outcomeFor("run_merged")).toMatchObject({
      success: false,
      rework: true,
    });
  });

  test("only prohibited/policy denials count as safety events", () => {
    const { store, task } = record("run_denied");
    task.terminal = true;
    store.appendEvent(task, "tool.denied", { error_code: "DSH_POLICY_DENIED" });
    store.appendEvent(task, "tool.denied", { error_code: "DSH_RISK_PROHIBITED" });
    store.appendEvent(task, "tool.denied", { error_code: "DSH_SCOPE_DENIED" });
    const outcome = createTaskRunOutcomes(store).outcomeFor("run_denied");
    expect(outcome?.safety_events).toBe(2);
  });

  test("a historical run id on the task still resolves", () => {
    const { store, task } = record("run_current");
    task.runs.push({ run_id: "run_history", state: "rejected", created_at: task.createdAt });
    task.status = "merged";
    task.terminal = true;
    const outcome = createTaskRunOutcomes(store).outcomeFor("run_history");
    expect(outcome?.success).toBe(true);
  });
});
