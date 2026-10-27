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

  it("extracts every complete frame from one network chunk", () => {
    const second = eventJson
      .replaceAll('"evt_1"', '"evt_2"')
      .replaceAll('"sequence":1', '"sequence":2');
    expect(takeSseFrames(`data: ${eventJson}\n\ndata: ${second}\n\npartial`)).toEqual({
      frames: [`data: ${eventJson}`, `data: ${second}`],
      rest: "partial",
    });
  });

  it("preserves CRLF when the pair is split between network chunks", () => {
    const first = takeSseFrames(`id: evt_1\r\ndata: ${eventJson}\r\n\r`);
    expect(first.frames).toEqual([]);

    const second = takeSseFrames(
      `${first.rest}\ndata: ${eventJson.replaceAll('"evt_1"', '"evt_2"').replaceAll('"sequence":1', '"sequence":2')}\r\n\r\n`,
      true,
    );
    expect(second.frames).toEqual([
      `id: evt_1\ndata: ${eventJson}`,
      `data: ${eventJson.replaceAll('"evt_1"', '"evt_2"').replaceAll('"sequence":1', '"sequence":2')}`,
    ]);
    expect(second.rest).toBe("");
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
