// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgePilotClient, IssueEvent } from "./client";
import { mergeIssueEvents, useIssueStream } from "./issue-hooks";

function event(sequence: number, id = `evt_${sequence}`, type = "run.state_changed"): IssueEvent {
  return {
    event_id: id,
    sequence,
    occurred_at: "2026-11-02T11:41:00Z",
    issue_id: "iss_1",
    type: type as IssueEvent["type"],
    data: { run_id: `run_${sequence}`, state: "running" },
  };
}

function fakeClient(): ForgePilotClient {
  return { streamIssueEvents: vi.fn() } as unknown as ForgePilotClient;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mergeIssueEvents", () => {
  it("drops replayed event ids and orders by sequence", () => {
    const merged = mergeIssueEvents([event(2), event(1)], [event(2), event(3)]);
    expect(merged.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(1);
    expect(merged.gap).toBe(false);
  });

  it("reports a sequence hole instead of silently keeping it", () => {
    expect(mergeIssueEvents([event(1)], [event(4)]).gap).toBe(true);
    expect(mergeIssueEvents([], [event(4)]).gap).toBe(false);
  });
});

describe("useIssueStream", () => {
  it("opens without an anchor and collapses replayed duplicates", async () => {
    const client = fakeClient();
    const stream = vi.mocked(client.streamIssueEvents);
    const anchors: Array<string | undefined> = [];
    stream.mockImplementation(async (_workspace, _issue, options) => {
      anchors.push(options.lastEventId);
      options.onEvent(event(1));
      options.onEvent(event(1));
      options.onEvent(event(2));
      return { lastEventId: "evt_2", terminal: true };
    });

    const { result } = renderHook(() => useIssueStream(client, "ws_1", "iss_1"));

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    await waitFor(() => expect(result.current.terminal).toBe(true));
    expect(anchors).toEqual([undefined]);
    expect(result.current.duplicates).toBe(1);
    expect(result.current.connection).toBe("connected");
    expect(result.current.events.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("reports a live connection once the service accepts the stream", async () => {
    const client = fakeClient();
    const stream = vi.mocked(client.streamIssueEvents);
    stream.mockImplementation((_workspace, _issue, options) => {
      options.onOpen?.();
      return new Promise(() => undefined);
    });

    const { result } = renderHook(() => useIssueStream(client, "ws_1", "iss_1"));

    await waitFor(() => expect(result.current.connection).toBe("connected"));
    expect(result.current.terminal).toBe(false);
  });

  it("reconnects with the newest delivered event id", async () => {
    const client = fakeClient();
    const stream = vi.mocked(client.streamIssueEvents);
    const anchors: Array<string | undefined> = [];
    stream.mockImplementationOnce(async (_workspace, _issue, options) => {
      anchors.push(options.lastEventId);
      options.onEvent(event(1));
      return { lastEventId: "evt_1", terminal: false };
    });
    stream.mockImplementationOnce(async (_workspace, _issue, options) => {
      anchors.push(options.lastEventId);
      return { lastEventId: "evt_1", terminal: true };
    });

    vi.useFakeTimers();
    const { result } = renderHook(() => useIssueStream(client, "ws_1", "iss_1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(anchors).toEqual([undefined]);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(anchors).toEqual([undefined, "evt_1"]);
    expect(result.current.connection).toBe("connected");
  });

  it("repairs a sequence hole with a full replay and keeps every unique event", async () => {
    const client = fakeClient();
    const stream = vi.mocked(client.streamIssueEvents);
    const anchors: Array<string | undefined> = [];
    stream.mockImplementationOnce(async (_workspace, _issue, options) => {
      anchors.push(options.lastEventId);
      options.onEvent(event(1));
      options.onEvent(event(3));
      return { lastEventId: "evt_3", terminal: false };
    });
    stream.mockImplementationOnce(async (_workspace, _issue, options) => {
      anchors.push(options.lastEventId);
      options.onEvent(event(1));
      options.onEvent(event(2));
      options.onEvent(event(3));
      return { lastEventId: "evt_3", terminal: true };
    });

    const { result } = renderHook(() => useIssueStream(client, "ws_1", "iss_1"));

    await waitFor(() => expect(result.current.gapRecoveries).toBe(1));
    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(anchors[1]).toBeUndefined();
    expect(result.current.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(result.current.duplicates).toBe(2);
    expect(result.current.terminal).toBe(true);
  });

  it("resets when the issue changes", async () => {
    const client = fakeClient();
    const stream = vi.mocked(client.streamIssueEvents);
    stream.mockImplementation(async (_workspace, issueId, options) => {
      options.onEvent({
        ...event(1),
        issue_id: issueId,
        event_id: `evt_${issueId}`,
      });
      return { lastEventId: `evt_${issueId}`, terminal: true };
    });

    const { result, rerender } = renderHook(
      ({ issueId }: { issueId: string }) => useIssueStream(client, "ws_1", issueId),
      { initialProps: { issueId: "iss_1" } },
    );
    await waitFor(() => expect(result.current.events[0]?.issue_id).toBe("iss_1"));

    rerender({ issueId: "iss_2" });
    await waitFor(() => expect(result.current.events[0]?.issue_id).toBe("iss_2"));
    expect(result.current.events).toHaveLength(1);
  });
});
