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
      "http://127.0.0.1:4567/api/v1/tasks",
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
      fetchImpl,
    });

    await client.listTasks(undefined, "tsk_after_50");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/tasks?cursor=tsk_after_50",
      expect.any(Object),
    );
  });
});
