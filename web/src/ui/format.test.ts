import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import {
  buildTimelineRows,
  eventSummary,
  piActivityText,
  piTurnSummary,
  summarizePiActivity,
} from "./format";
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

function event(type: TaskEvent["type"], sequence: number): TaskEvent {
  return {
    event_id: `evt_${sequence}`,
    sequence,
    occurred_at: "2026-10-27T00:00:00Z",
    task_id: "tsk_1",
    task_version: sequence,
    type,
    data: {},
  };
}

describe("timeline summaries", () => {
  it("never renders raw Pi stream text before it can be classified", () => {
    const secretFragment = "ghp_sensitive-secret-fragment";

    expect(eventSummary(piDelta(secretFragment, 1))).not.toContain(secretFragment);
    expect(eventSummary(piDelta(secretFragment, 1))).toContain("hidden for safety");
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

  it("summarizes a Pi turn and activity without reading raw text", () => {
    const events = [
      piDelta("run git status in /srv/forgepilot", 1),
      piDelta("Bearer ghp_secret", 2),
      event("pi.turn_settled", 3),
      event("tool.requested", 4),
      event("tool.completed", 5),
      event("tool.requested", 6),
      event("tool.denied", 7),
      piDelta("follow-up turn", 8),
    ];

    const [turn] = buildTimelineRows(events);
    expect(turn?.kind).toBe("pi_turn");
    if (turn?.kind !== "pi_turn") throw new Error("expected a Pi turn row");
    expect(piTurnSummary(turn)).toBe("2 Pi text updates · turn settled");

    const activity = summarizePiActivity(events);
    expect(activity).toEqual({
      turns: 2,
      updates: 3,
      requested: 2,
      completed: 1,
      denied: 1,
    });
    expect(piActivityText(activity)).toBe(
      "2 Pi turns · 3 text updates · actions 2 requested, 1 completed, 1 denied.",
    );
    expect(JSON.stringify([piTurnSummary(turn), piActivityText(activity)])).not.toMatch(
      /git|ghp_|\/srv/,
    );
  });

  it("reports an empty Pi summary before any Pi output arrives", () => {
    expect(piActivityText(summarizePiActivity([]))).toBe(
      "No Pi output recorded for this task yet.",
    );
  });
});
