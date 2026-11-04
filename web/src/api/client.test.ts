import { describe, expect, it, vi } from "vitest";
import { ApiConfigurationError, ForgePilotClient } from "./client";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ForgePilotClient", () => {
  it("sends the contract body, bearer token, and idempotency key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "tsk_1" }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567/",
      token: "local-secret",
      workspaceId: "wsp_1",
      fetchImpl,
    });

    await client.createTask(
      {
        repository_id: "github:Luthiel/AutoFixer",
        base_ref: "main",
        summary: "Repair the export path",
        acceptance_criteria: ["Tests pass"],
      },
      "create-key",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_1/tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer local-secret",
          "Content-Type": "application/json",
          "Idempotency-Key": "create-key",
        }),
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({
      repository_id: "github:Luthiel/AutoFixer",
      base_ref: "main",
      summary: "Repair the export path",
      acceptance_criteria: ["Tests pass"],
    });
  });

  it("surfaces the contract error envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          error: {
            code: "TASK_NOT_FOUND",
            message: "Task is not available.",
            request_id: "req_1",
            retryable: false,
            details: {},
          },
        },
        404,
      ),
    );
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: "wsp_1",
      fetchImpl,
    });

    await expect(client.getTask("tsk_missing")).rejects.toMatchObject({
      status: 404,
      code: "TASK_NOT_FOUND",
      message: "Task is not available.",
    });
  });

  it("refuses to send bearer credentials to a non-loopback URL", async () => {
    const fetchImpl = vi.fn();
    const client = new ForgePilotClient({
      baseUrl: "https://example.invalid",
      token: "local-secret",
      workspaceId: "wsp_1",
      fetchImpl,
    });

    await expect(client.getTask("tsk_1")).rejects.toBeInstanceOf(ApiConfigurationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the contract cursor when loading another task page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ items: [], next_cursor: null }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: "wsp_1",
      fetchImpl,
    });

    await client.listTasks(undefined, "tsk_after_50");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_1/tasks?cursor=tsk_after_50",
      expect.any(Object),
    );
  });

  it("routes every task call through the selected workspace", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response({ items: [] }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: "wsp two/one",
      fetchImpl,
    });

    await client.getTimeline("tsk_1");
    await client.getArtifact("tsk_1", "artifact_1");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp%20two%2Fone/tasks/tsk_1/timeline",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp%20two%2Fone/tasks/tsk_1/artifacts/artifact_1",
    );
  });

  it("keeps the legacy family only when no workspace is selected", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ items: [], next_cursor: null }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: null,
      fetchImpl,
    });

    await client.listTasks();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/api/v1/tasks");
  });

  it("streams through the selected workspace and the legacy seam", async () => {
    const streaming = () =>
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      });
    const scopedFetch = streaming();
    const scoped = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: "wsp_1",
      fetchImpl: scopedFetch,
    });
    const legacyFetch = streaming();
    const legacy = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "token",
      workspaceId: null,
      fetchImpl: legacyFetch,
    });

    await scoped.streamTaskEvents("tsk_1", { onEvent: () => undefined });
    await legacy.streamTaskEvents("tsk_1", { onEvent: () => undefined });

    expect(scopedFetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/workspaces/wsp_1/tasks/tsk_1/stream",
    );
    expect(legacyFetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/api/v1/tasks/tsk_1/stream");
  });

  it("sends the session cookie and CSRF echo when the workbench and API differ in origin", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => response({ items: [], next_cursor: null }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4599",
      token: "",
      csrfToken: () => "csrf_1",
      fetchImpl,
    });

    // The Vite dev server runs on another loopback port, so the browser must
    // opt into cross-origin credentials or `fp_session` is never attached.
    await client.listTasks();
    await client.cancelTask("tsk_1");

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      credentials: "include",
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf_1" }),
    });
  });
});
