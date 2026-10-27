import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import { buildTimelineRows, eventSummary, piTurnSummary } from "./format";
import type { PiTurnRow } from "./format";

function piDelta(delta: string, sequence: number): TaskEvent {
  return {
    event_id: `evt_pi_${sequence}`,
    sequence,
    occurred_at: "2026-10-27T00:00:00Z",
    task_id: "tsk_1",
    task_version: 1,
    type: "pi.text_delta",
    data: { delta },
  };
}

function event(
  type: TaskEvent["type"],
  sequence: number,
  data: Record<string, unknown> = {},
): TaskEvent {
  return {
    event_id: `evt_${sequence}`,
    sequence,
    occurred_at: "2026-10-27T00:00:00Z",
    task_id: "tsk_1",
    task_version: sequence,
    type,
    data,
  };
}

describe("timeline summaries", () => {
  it("never exposes Pi stream text through a row summary", () => {
    const secretFragment = "ghp_sensitive-secret-fragment";

    const summary = eventSummary(piDelta(secretFragment, 1));
    expect(summary).not.toContain(secretFragment);
    expect(summary).not.toContain("ghp_");
    expect(summary).toBe("Pi text (withheld) recorded.");
  });

  it("groups a Pi turn but keeps actions in their original position", () => {
    const events = [
      piDelta("before action", 1),
      piDelta("still before", 2),
      event("tool.completed", 3),
      piDelta("after action", 4),
      event("pi.turn_settled", 5),
    ];

    const rows = buildTimelineRows(events);

    expect(rows.map((row) => (row.kind === "pi_turn" ? "pi_turn" : row.event.type))).toEqual([
      "pi_turn",
      "tool.completed",
      "pi_turn",
    ]);
    const [first, second] = rows.filter((row): row is PiTurnRow => row.kind === "pi_turn");
    expect(first.updates).toBe(2);
    expect(first.settled).toBe(false);
    expect(second.updates).toBe(1);
    expect(second.settled).toBe(true);
  });

  it("summarizes a Pi turn as counts only and never reads raw text", () => {
    const events = [
      piDelta("run git status in /srv/forgepilot", 1),
      piDelta("Bearer ghp_secret", 2),
      event("pi.turn_settled", 3),
    ];

    const [turn] = buildTimelineRows(events);
    if (turn?.kind !== "pi_turn") throw new Error("expected a Pi turn row");
    expect(piTurnSummary(turn)).toBe("2 Pi text updates · turn settled · text withheld");
    expect(piTurnSummary(turn)).not.toMatch(/git|ghp_|\/srv/);
  });

  it("describes pi.summary.updated events without echoing summary text", () => {
    const summaryEvent = event("pi.summary.updated", 9, {
      summary: {
        task_id: "tsk_1",
        run_id: "run_1",
        turn_id: "turn_1",
        status: "available",
        text: "node app succeeded.",
        unavailable_reason: null,
        updated_at: "2026-10-27T00:00:00Z",
      },
    });

    const summary = eventSummary(summaryEvent);
    expect(summary).toBe("Pi published a certified summary for this turn.");
    expect(summary).not.toContain("node app");

    const unavailable = eventSummary(
      event("pi.summary.updated", 10, {
        summary: { status: "unavailable", unavailable_reason: "unsafe_content", text: null },
      }),
    );
    expect(unavailable).toBe("Pi summary unavailable (unsafe_content).");
  });
});
