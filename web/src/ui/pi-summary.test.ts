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

const TASK_ID = "tsk_00000000000000000000000000000001";
const RUN_ID = "run_00000000000000000000000000000001";

function summaryEvent(
  summary: Record<string, unknown>,
  options: { sequence: number; taskVersion: number; taskId?: string },
): TaskEvent {
  return {
    event_id: `evt_${options.sequence}`,
    sequence: options.sequence,
    occurred_at: "2026-10-27T00:00:00Z",
    task_id: options.taskId ?? TASK_ID,
    task_version: options.taskVersion,
    type: "pi.summary.updated",
    data: { summary },
  };
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: TASK_ID,
    run_id: RUN_ID,
    turn_id: "turn_1",
    status: "pending",
    text: null,
    unavailable_reason: null,
    updated_at: "2026-10-27T00:00:00Z",
    ...overrides,
  };
}

const untrustedTask = (): Task =>
  JSON.parse(
    readFileSync(
      path.join(fixtureDir, "task-pi-summary-unavailable-untrusted-source.json"),
      "utf8",
    ),
  ) as Task;

describe("Pi summary resolution", () => {
  it("renders the merged untrusted_source fixture as a plain unavailable state", () => {
    const view = resolvePiSummary(untrustedTask(), []);

    expect(view).toMatchObject({ state: "unavailable", reason: "untrusted_source" });
    expect(view.text).toBeUndefined();
    expect(piSummaryHeadline(view)).toBe(
      "Pi produced no validated structured report for this turn, so there is no trustworthy text to show.",
    );
  });

  it("withholds the certified text of the merged contract fixture", () => {
    const view = resolvePiSummary(availableTask(), []);

    expect(PI_SUMMARY_TEXT_DISPLAY_ALLOWED).toBe(false);
    expect(view).toMatchObject({ state: "available", withheld: true, turnId: "turn_1" });
    expect(view.text).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Pi reported that it");
    expect(piSummaryStateLabel(view)).toBe("Available · text withheld");
  });

  it("never lets a replayed timeline overwrite a newer task projection", () => {
    const task = availableTask();
    expect(task.version).toBe(9);

    // The captured timeline holds task_version 6 and 9, both already reflected
    // in the projection at version 9.
    const view = resolvePiSummary(task, availableEvents());

    expect(view).toMatchObject({ state: "available", withheld: true, turnId: "turn_1" });
  });

  it("applies only strictly newer events, in sequence order, regardless of arrival order", () => {
    const task = availableTask();
    const events = [
      summaryEvent(
        summary({ turn_id: "turn_2", status: "available", text: "The turn finished." }),
        {
          sequence: 24,
          taskVersion: 13,
        },
      ),
      summaryEvent(summary({ turn_id: "turn_2", status: "pending" }), {
        sequence: 21,
        taskVersion: 12,
      }),
    ];

    const view = resolvePiSummary(task, events);

    expect(view).toMatchObject({
      state: "available",
      withheld: true,
      turnId: "turn_2",
    });
  });

  it("builds the summary from newer events when the projection has none", () => {
    const task = availableTask();
    task.pi_summary = null;

    const view = resolvePiSummary(task, [
      summaryEvent(summary({ status: "available", text: "The turn finished." }), {
        sequence: 31,
        taskVersion: 12,
      }),
    ]);

    expect(view.state).toBe("available");
    expect(view.withheld).toBe(true);
  });

  it("ignores summaries of another task", () => {
    const task = availableTask();
    task.pi_summary = null;

    const view = resolvePiSummary(task, [
      summaryEvent(summary({ task_id: "tsk_other" }), {
        sequence: 41,
        taskVersion: 12,
        taskId: "tsk_other",
      }),
    ]);

    expect(view.state).toBe("none");
  });

  it("fails closed when the summary carries no run identity", () => {
    const task = availableTask();
    task.pi_summary = null;

    const view = resolvePiSummary(task, [
      summaryEvent(summary({ run_id: null, status: "available", text: "The turn finished." }), {
        sequence: 51,
        taskVersion: 12,
      }),
    ]);

    expect(view.state).toBe("none");
  });

  it("fails closed when the task has no current run to attribute to", () => {
    const task = availableTask();
    task.current_run_id = null;

    expect(resolvePiSummary(task, []).state).toBe("none");
    expect(
      resolvePiSummary(task, [
        summaryEvent(summary({ status: "available", text: "The turn finished." }), {
          sequence: 61,
          taskVersion: 12,
        }),
      ]).state,
    ).toBe("none");
  });

  it("ignores a newer event replayed from a previous run", () => {
    const task = availableTask();

    const view = resolvePiSummary(task, [
      summaryEvent(summary({ run_id: "run_00000000000000000000000000000002", turn_id: "turn_9" }), {
        sequence: 71,
        taskVersion: 20,
      }),
    ]);

    expect(view).toMatchObject({ state: "available", turnId: "turn_1", withheld: true });
  });

  it("renders pending without any text", () => {
    const view = resolvePiSummary(availableTask(), [
      summaryEvent(summary({ turn_id: null, status: "pending" }), {
        sequence: 81,
        taskVersion: 12,
      }),
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
        summary({ turn_id: "turn_2", status: "unavailable", unavailable_reason: "future_reason" }),
        { sequence: 91, taskVersion: 12 },
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

    const unknownState = resolvePiSummary(availableTask(), [
      summaryEvent(summary({ status: "settled", text: "certified" }), {
        sequence: 101,
        taskVersion: 12,
      }),
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
      task_version: 99,
      type: "pi.text_delta",
      data: { delta: "node app succeeded." },
    };

    const view = resolvePiSummary(task, [delta]);
    expect(view.state).toBe("none");
    expect(JSON.stringify(view)).not.toContain("node app");
  });
});
