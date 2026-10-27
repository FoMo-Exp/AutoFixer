import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../api/client";
import {
  PI_SUMMARY_TEXT_DISPLAY_ALLOWED,
  piSummaryHeadline,
  piSummaryStateLabel,
  resolvePiSummary,
} from "./pi-summary";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/forgepilot-api-v1",
);

// Real responses captured from the merged contract (DAT-191/DAT-192).
const availableTask = (): Task =>
  JSON.parse(readFileSync(path.join(fixtureDir, "task-pi-summary-available.json"), "utf8")) as Task;
const availableEvents = (): TaskEvent[] =>
  JSON.parse(
    readFileSync(path.join(fixtureDir, "pi-summary-events-available.json"), "utf8"),
  ) as TaskEvent[];

function summaryEvent(summary: Record<string, unknown>, sequence: number): TaskEvent {
  return {
    event_id: `evt_${sequence}`,
    sequence,
    occurred_at: "2026-10-27T00:00:00Z",
    task_id: String(summary["task_id"] ?? "tsk_1"),
    task_version: sequence,
    type: "pi.summary.updated",
    data: { summary },
  };
}

describe("Pi summary resolution", () => {
  it("withholds the certified text of the merged contract fixture", () => {
    const view = resolvePiSummary(availableTask(), []);

    expect(PI_SUMMARY_TEXT_DISPLAY_ALLOWED).toBe(false);
    expect(view).toMatchObject({
      state: "available",
      withheld: true,
      runId: "run_00000000000000000000000000000001",
      turnId: "turn_1",
    });
    expect(view.text).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Checked the echo tool");
    expect(piSummaryStateLabel(view)).toBe("Available · text withheld");
  });

  it("applies the newest pi.summary.updated event over the projection", () => {
    const task = availableTask();
    task.pi_summary = null;

    const view = resolvePiSummary(task, availableEvents());

    expect(view.state).toBe("available");
    expect(view.withheld).toBe(true);
    expect(view.turnId).toBe("turn_1");
  });

  it("ignores another task's summary event", () => {
    const task = availableTask();
    task.pi_summary = null;
    const foreign = availableEvents()[1];
    const summary = foreign.data["summary"] as Record<string, unknown>;

    const view = resolvePiSummary(task, [
      { ...foreign, task_id: "tsk_other", data: { summary: { ...summary, task_id: "tsk_other" } } },
    ]);

    expect(view.state).toBe("none");
    expect(view.withheld).toBe(false);
  });

  it("ignores a summary from a previous run", () => {
    const task = availableTask();
    task.pi_summary = null;
    task.current_run_id = "run_00000000000000000000000000000002";
    const foreign = availableEvents()[1];
    const summary = foreign.data["summary"] as Record<string, unknown>;

    expect(resolvePiSummary(task, [foreign]).state).toBe("none");
    expect(summary["run_id"]).not.toBe(task.current_run_id);
  });

  it("renders pending without any text", () => {
    const view = resolvePiSummary(availableTask(), [
      summaryEvent(
        {
          task_id: "tsk_00000000000000000000000000000001",
          run_id: "run_00000000000000000000000000000001",
          turn_id: null,
          status: "pending",
          text: null,
          unavailable_reason: null,
          updated_at: "2026-10-27T00:00:00Z",
        },
        5,
      ),
    ]);

    expect(view).toMatchObject({ state: "pending", withheld: false });
    expect(view.text).toBeUndefined();
    expect(piSummaryHeadline(view)).toBe("The current Pi turn has not settled yet.");
  });

  it("renders contract reasons and keeps unknown reasons generic", () => {
    const task = availableTask();
    task.pi_summary = {
      ...task.pi_summary!,
      status: "unavailable",
      text: null,
      unavailable_reason: "unsafe_content",
    };
    expect(piSummaryHeadline(resolvePiSummary(task, []))).toBe(
      "Pi output was withheld because it contained unsafe material.",
    );

    const unknown = resolvePiSummary(task, [
      summaryEvent(
        {
          task_id: task.id,
          run_id: task.current_run_id,
          turn_id: "turn_2",
          status: "unavailable",
          text: null,
          unavailable_reason: "future_reason",
          updated_at: "2026-10-27T00:00:00Z",
        },
        6,
      ),
    ]);
    expect(unknown.reason).toBe("future_reason");
    expect(piSummaryHeadline(unknown)).toBe("Pi summary is unavailable.");
  });

  it("fails closed for an available summary without text and for unknown states", () => {
    const task = availableTask();
    task.pi_summary = { ...task.pi_summary!, text: null } as Task["pi_summary"];

    const missingText = resolvePiSummary(task, []);
    expect(missingText.state).toBe("unavailable");
    expect(missingText.reason).toBe("invalid_summary");
    expect(missingText.withheld).toBe(false);

    const unknownState = resolvePiSummary(availableTask(), [
      summaryEvent({ task_id: task.id, status: "settled", text: "certified" }, 7),
    ]);
    expect(unknownState.state).toBe("unavailable");
    expect(unknownState.reason).toBe("unknown_status");
    expect(unknownState.text).toBeUndefined();
  });

  it("never turns raw pi.text_delta content into summary text", () => {
    const task = availableTask();
    task.pi_summary = null;
    const delta: TaskEvent = {
      event_id: "evt_delta",
      sequence: 3,
      occurred_at: "2026-10-27T00:00:00Z",
      task_id: task.id,
      task_version: 3,
      type: "pi.text_delta",
      data: { delta: "node app succeeded." },
    };

    const view = resolvePiSummary(task, [delta]);
    expect(view.state).toBe("none");
    expect(JSON.stringify(view)).not.toContain("node app");
  });
});
