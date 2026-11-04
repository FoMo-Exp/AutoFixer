import { describe, expect, test } from "vitest";

import { createTaskRunOutcomes } from "../src/api/run-outcomes.js";
import { TaskStore, createTaskRecord } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";

/**
 * DAT-238 run-level evidence. A pinned run's outcome comes only from its own
 * `runs` entry; task-level aggregates are usable only when the task has exactly
 * one run. Anything unattributable is `null`, never a borrowed number.
 */

function newTask(id = "tsk_multi"): { store: TaskStore; task: TaskRecord } {
  const store = new TaskStore();
  const task = createTaskRecord({
    id,
    workspaceId: "wsp_test",
    enterpriseId: "ent_test",
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
  store.put(task);
  return { store, task };
}

function twoRunTask(): { store: TaskStore; task: TaskRecord } {
  const { store, task } = newTask();
  task.runs.push(
    {
      run_id: "run_old",
      state: "rejected",
      created_at: "2026-11-01T00:00:00.000Z",
      actions_completed: 2,
      safety_events: 1,
      updated_at: "2026-11-01T00:10:00.000Z",
    },
    {
      run_id: "run_current",
      state: "merged",
      created_at: "2026-11-02T00:00:00.000Z",
      actions_completed: 7,
      safety_events: 0,
      updated_at: "2026-11-02T00:10:00.000Z",
    },
  );
  task.runId = "run_current";
  // Contaminated task-level facts: a correct adapter must ignore all of them.
  task.status = "merged";
  task.terminal = true;
  task.progress = { phase: "validating", actions_completed: 99, actions_total: null };
  store.appendEvent(task, "tool.denied", { error_code: "DSH_RISK_PROHIBITED" });
  store.appendEvent(task, "tool.denied", { error_code: "DSH_POLICY_DENIED" });
  return { store, task };
}

describe("trusted run outcomes", () => {
  test("an unknown run has no outcome", () => {
    const { store } = newTask();
    expect(createTaskRunOutcomes(store).outcomeFor("run_missing")).toBeNull();
  });

  test("terminal/success/rework come from the matching run, never the task status", () => {
    const { store } = twoRunTask();
    const outcomes = createTaskRunOutcomes(store);

    // The historical run was rejected even though the task finished merged.
    expect(outcomes.outcomeFor("run_old")).toMatchObject({
      terminal: true,
      success: false,
      rework: true,
    });
    expect(outcomes.outcomeFor("run_current")).toMatchObject({
      terminal: true,
      success: true,
      rework: false,
    });
  });

  test("actions and safety events are never cross-attributed", () => {
    const { store } = twoRunTask();
    const outcomes = createTaskRunOutcomes(store);
    const old = outcomes.outcomeFor("run_old");
    const current = outcomes.outcomeFor("run_current");
    expect(old?.actions).toBe(2);
    expect(old?.safety_events).toBe(1);
    expect(current?.actions).toBe(7);
    expect(current?.safety_events).toBe(0);
    // Neither run's totals include the other's, nor the task-level 99/2.
    expect(old?.actions).not.toBe(99);
    expect(current?.safety_events).not.toBe(2);
  });

  test("a multi-run task without run-level evidence is excluded, not zero-filled", () => {
    const { store, task } = newTask("tsk_legacy");
    task.runs.push(
      { run_id: "run_a", state: "rejected", created_at: "2026-11-01T00:00:00.000Z" },
      { run_id: "run_b", state: "merged", created_at: "2026-11-02T00:00:00.000Z" },
    );
    task.runId = "run_b";
    task.status = "merged";
    task.terminal = true;
    task.progress = { phase: "validating", actions_completed: 42, actions_total: null };
    store.appendEvent(task, "tool.denied", { error_code: "DSH_RISK_PROHIBITED" });

    const outcomes = createTaskRunOutcomes(store);
    expect(outcomes.outcomeFor("run_a")).toBeNull();
    expect(outcomes.outcomeFor("run_b")).toBeNull();
  });

  test("a single-run task may use the equivalent task-level aggregates", () => {
    const { store, task } = newTask("tsk_single");
    task.runs.push({ run_id: "run_only", state: "merged", created_at: "2026-11-01T00:00:00.000Z" });
    task.runId = "run_only";
    task.status = "merged";
    task.terminal = true;
    task.progress = { phase: "validating", actions_completed: 5, actions_total: null };
    store.appendEvent(task, "tool.denied", { error_code: "DSH_POLICY_DENIED" });

    const outcomes = createTaskRunOutcomes(store);
    expect(outcomes.outcomeFor("run_only")).toMatchObject({
      terminal: true,
      success: true,
      rework: false,
      actions: 5,
      safety_events: 1,
    });
  });

  test("a non-terminal run reports no terminal outcome", () => {
    const { store } = newTask("tsk_running");
    const task = store.get("tsk_running") as TaskRecord;
    task.runs.push({
      run_id: "run_running",
      state: "running",
      created_at: "2026-11-01T00:00:00.000Z",
      actions_completed: 3,
      safety_events: 0,
    });
    task.runId = "run_running";
    const outcome = createTaskRunOutcomes(store).outcomeFor("run_running");
    expect(outcome).toMatchObject({ terminal: false, success: false, rework: false, actions: 3 });
  });

  test("observing one run is stable across reads and updates of another run", () => {
    const { store, task } = twoRunTask();
    const outcomes = createTaskRunOutcomes(store);
    const before = outcomes.outcomeFor("run_old");
    const again = outcomes.outcomeFor("run_old");
    expect(again).toEqual(before);

    store.recordRunEvidence(task, "run_current", { action: true, safety_event: true });
    const after = outcomes.outcomeFor("run_old");
    expect(after).toEqual(before);
  });
});
