import { describe, expect, it } from "vitest";
import type { TaskEvent } from "./client";
import { sanitizeStreamEvent } from "./hooks";

describe("stream event privacy", () => {
  it("removes raw Pi text before an event enters UI state", () => {
    const event: TaskEvent = {
      event_id: "evt_pi_1",
      sequence: 1,
      occurred_at: "2026-10-27T00:00:00Z",
      task_id: "tsk_1",
      task_version: 1,
      type: "pi.text_delta",
      data: { delta: "ghp_sensitive-fragment" },
    };

    const safeEvent = sanitizeStreamEvent(event);

    expect(safeEvent.data["delta"]).toBe("");
    expect(event.data["delta"]).toBe("ghp_sensitive-fragment");
  });
});
