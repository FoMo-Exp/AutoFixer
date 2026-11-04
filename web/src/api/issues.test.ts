import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  ForgePilotClient,
  parseIssueSseFrame,
  type IssueEvent,
  type JsonFetch,
  type IssuePage,
  type IssueRunPage,
  type IssueStage,
  type IssueTaskPage,
} from "./client";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/collab-api-v1",
);

// Real captures from the merged collaboration contract (DAT-221).
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: JsonFetch & Mock): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl,
  });
}

describe("issue API client", () => {
  it("lists workspace issues with the product-stage filter and opaque cursor", async () => {
    const page = fixture<IssuePage>("issue-page.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page));
    const client = clientWith(fetchImpl);

    const result = await client.listIssues("ws_payments", {
      productState: "awaiting_change_approval",
      cursor: "cur/next",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues?product_state=awaiting_change_approval&cursor=cur%2Fnext",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
    expect(result.items[0]?.issue_id).toBe(page.items[0]?.issue_id);
  });

  it("omits the query entirely when no issue filter is set", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(fixture<IssuePage>("issue-page.json")));
    const client = clientWith(fetchImpl);

    await client.listIssues("ws_payments");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues",
    );
  });

  it("posts a stage transition with the reason, disposition, and idempotency key", async () => {
    const stage = fixture<IssueStage>("issue-stage.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(stage));
    const client = clientWith(fetchImpl);

    await client.transitionIssueStage(
      "ws_payments",
      "iss_7f3c2a9e51b84d0fa1c6",
      { to: "cancelled", reason: "Duplicate report", disposition: { reference: "DAT-222" } },
      "stage-key",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/stage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer local-secret",
          "Idempotency-Key": "stage-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({
      to: "cancelled",
      reason: "Duplicate report",
      disposition: { reference: "DAT-222" },
    });
  });

  it("posts a child-task state change to the task's state endpoint", async () => {
    const tasks = fixture<IssueTaskPage>("task-page.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(tasks.items[0]));
    const client = clientWith(fetchImpl);

    await client.setIssueTaskState(
      "ws_payments",
      "iss_7f3c2a9e51b84d0fa1c6",
      "tsk_3b8e1c4a9d2f5067",
      "done",
      "task-key",
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/tasks/tsk_3b8e1c4a9d2f5067/state",
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({ to: "done" });
  });

  it("reads runs in creation order from the issue's run page", async () => {
    const runs = fixture<IssueRunPage>("run-page.json");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(runs));
    const client = clientWith(fetchImpl);

    const result = await client.listIssueRuns("ws_payments", "iss_7f3c2a9e51b84d0fa1c6");

    expect(result.items[0]?.state).toBe("stopped");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/runs",
    );
  });

  it("reads every child-task and run page instead of only the first", async () => {
    const tasks = fixture<IssueTaskPage>("task-page.json");
    const runs = fixture<IssueRunPage>("run-page.json");
    const secondTask = { ...tasks.items[0], task_id: "tsk_second" };
    const secondRun = { ...runs.items[0], run_id: "run_second" };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: tasks.items, next_cursor: "cur_task" }))
      .mockResolvedValueOnce(jsonResponse({ items: [secondTask], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: runs.items, next_cursor: "cur_run" }))
      .mockResolvedValueOnce(jsonResponse({ items: [secondRun], next_cursor: null }));
    const client = clientWith(fetchImpl);

    const allTasks = await client.listAllIssueTasks("ws_payments", "iss_7f3c2a9e51b84d0fa1c6");
    const allRuns = await client.listAllIssueRuns("ws_payments", "iss_7f3c2a9e51b84d0fa1c6");

    expect(allTasks.map((task) => task.task_id)).toEqual([tasks.items[0]?.task_id, "tsk_second"]);
    expect(allRuns.map((run) => run.run_id)).toEqual([runs.items[0]?.run_id, "run_second"]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/tasks?cursor=cur_task",
    );
    expect(fetchImpl.mock.calls[3]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/runs?cursor=cur_run",
    );
  });

  it("streams issue events with Last-Event-ID and parses the durable envelope", async () => {
    const event = fixture<IssueEvent>("issue-event.json");
    const body = `id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    const client = clientWith(fetchImpl);
    const onEvent = vi.fn();

    const result = await client.streamIssueEvents("ws_payments", "iss_7f3c2a9e51b84d0fa1c6", {
      lastEventId: "evt_previous",
      onEvent,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_payments/issues/iss_7f3c2a9e51b84d0fa1c6/stream",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: "text/event-stream",
      "Last-Event-ID": "evt_previous",
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: event.event_id, sequence: event.sequence }),
    );
    expect(result).toEqual({ lastEventId: event.event_id, terminal: false });
  });
});

describe("issue SSE frame parsing", () => {
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;

  it("rejects frames without a durable issue identity", () => {
    expect(
      parseIssueSseFrame(
        frame({
          event_id: "evt_1",
          sequence: 1,
          occurred_at: "2026-11-02T00:00:00Z",
          type: "x",
          data: {},
        }),
      ),
    ).toBeUndefined();
    expect(parseIssueSseFrame("data: not-json")).toBeUndefined();
  });

  it("keeps an unknown event type as an explicit unknown instead of dropping it", () => {
    const event = parseIssueSseFrame(
      frame({
        event_id: "evt_unknown",
        sequence: 9,
        occurred_at: "2026-11-02T00:00:00Z",
        issue_id: "iss_1",
        type: "future.signal",
        data: {},
      }),
    );
    expect(event?.type).toBe("future.signal");
  });
});
