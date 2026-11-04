import { describe, expect, it, vi } from "vitest";
import { ForgePilotClient } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: code,
        request_id: "req_1",
        retryable: false,
        details: {},
      },
    },
    status,
  );
}

const task = {
  id: "tsk_1",
  version: 1,
  created_at: "2026-11-03T00:00:00Z",
  updated_at: "2026-11-03T00:00:00Z",
  current_run_id: null,
  run_history_url: "",
  status: "executing",
  status_reason: null,
  repository: { id: "repo", display_name: "owner/repo", base_ref: "main", base_sha: "abc1234" },
  request: { summary: "Repair", source_reference: null },
  association: {
    task_id: "tsk_1",
    run_id: null,
    repository_id: "repo",
    base_sha: "abc1234",
    head_sha: null,
  },
  revision: { base_sha: "abc1234", head_sha: null },
  risk: null,
  progress: { phase: "Executing", actions_completed: 0, actions_total: null },
  pi_summary: null,
  governance: { current_head_sha: null, observations_valid: false, merge_queue_eligible: false },
  artifacts: { patch: null, report: null, evidence_bundle_available: false, index: [] },
};

describe("ForgePilotClient cookie sessions", () => {
  it("uses the cookie and sends the CSRF token only on mutating requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [], next_cursor: null }));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "",
      workspaceId: "wsp_1",
      csrfToken: () => "csrf-1",
      fetchImpl,
    });

    await client.listTasks();
    const getInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(getInit.credentials).toBe("include");
    expect(getInit.headers).not.toHaveProperty("Authorization");
    expect(getInit.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("echoes the CSRF token on a cookie-authenticated write", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(task, 201));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "",
      workspaceId: "wsp_1",
      csrfToken: () => "csrf-1",
      fetchImpl,
    });

    await client.createTask(
      { repository_id: "repo", base_ref: "main", summary: "Repair" },
      "create-key",
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-1" });
  });

  it("refreshes a rotated CSRF token and retries the write once", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(403, "FORBIDDEN"))
      .mockResolvedValueOnce(jsonResponse(task, 201));
    const refresh = vi.fn().mockResolvedValue("csrf-2");
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "",
      workspaceId: "wsp_1",
      csrfToken: () => "csrf-1",
      refreshCsrfToken: refresh,
      fetchImpl,
    });

    await client.createTask({ repository_id: "repo", base_ref: "main", summary: "Repair" }, "key");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-2" });
  });

  it("does not loop when the refreshed token is unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(403, "FORBIDDEN"));
    const refresh = vi.fn().mockResolvedValue("csrf-1");
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "",
      workspaceId: "wsp_1",
      csrfToken: () => "csrf-1",
      refreshCsrfToken: refresh,
      fetchImpl,
    });

    await expect(
      client.createTask({ repository_id: "repo", base_ref: "main", summary: "Repair" }, "key"),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports 401 and 403 responses to the auth surface", async () => {
    const onUnauthorized = vi.fn();
    const onForbidden = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401, "UNAUTHENTICATED"))
      .mockResolvedValueOnce(errorResponse(403, "FORBIDDEN"));
    const client = new ForgePilotClient({
      baseUrl: "http://127.0.0.1:4567",
      token: "",
      workspaceId: "wsp_1",
      onUnauthorized,
      onForbidden,
      fetchImpl,
    });

    await expect(client.getTask("tsk_1")).rejects.toMatchObject({ status: 401 });
    await expect(client.getTask("tsk_1")).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onForbidden).toHaveBeenCalledTimes(1);
  });
});
