import { describe, expect, it } from "vitest";
import { parseSseFrame, takeSseFrames } from "./client";

const eventJson = JSON.stringify({
  event_id: "evt_1",
  sequence: 1,
  occurred_at: "2026-10-27T00:00:00Z",
  task_id: "tsk_1",
  task_version: 2,
  type: "task.status_changed",
  data: { status: "executing" },
});

describe("SSE contract parsing", () => {
  it("keeps partial frames for the next network chunk", () => {
    expect(takeSseFrames(`id: evt_1\ndata: ${eventJson}\n\npartial`)).toEqual({
      frames: [`id: evt_1\ndata: ${eventJson}`],
      rest: "partial",
    });
  });

  it("parses the event envelope and preserves the sequence", () => {
    expect(
      parseSseFrame(`id: evt_1\nevent: task.status_changed\ndata: ${eventJson}`),
    ).toMatchObject({
      event_id: "evt_1",
      sequence: 1,
      type: "task.status_changed",
      data: { status: "executing" },
    });
  });
});
