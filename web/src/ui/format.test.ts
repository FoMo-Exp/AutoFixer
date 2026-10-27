import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import { collapsePiTextDeltas, eventSummary } from "./format";

function piDelta(delta: string): TaskEvent {
  return {
    event_id: "evt_pi_1",
    sequence: 1,
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

    expect(eventSummary(piDelta(secretFragment))).not.toContain(secretFragment);
    expect(eventSummary(piDelta(secretFragment))).toContain("hidden for safety");
  });

  it("keeps Pi text on either side of an action in its original order", () => {
    const events = [
      piDelta("before action"),
      event("tool.completed", 2),
      { ...piDelta("after action"), event_id: "evt_pi_3", sequence: 3 },
    ];

    expect(collapsePiTextDeltas(events).map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(collapsePiTextDeltas(events).map((item) => item.type)).toEqual([
      "pi.text_delta",
      "tool.completed",
      "pi.text_delta",
    ]);
  });
});
