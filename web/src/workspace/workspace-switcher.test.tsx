// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ApiError, ForgePilotClient } from "../api/client";
import type { Task, Workspace } from "../api/client";
import type { DesktopAuthState } from "../../electron/auth";

const providers = [
  {
    provider_instance_id: "pi_github",
    provider_type: "github" as const,
    display_origin: "https://github.com",
  },
];

const session = {
  user: { id: "usr_1", display_name: "Ada Lovelace", status: "active" as const },
  kind: "desktop" as const,
  expires_at: "2099-01-01T00:00:00Z",
  enterprise_roles: [],
  memberships: [
    { enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" as const },
    { enterprise_id: "ent_1", workspace_id: "ws_beta", role: "admin" as const },
  ],
};

function workspace(id: string, name: string, role: Workspace["role"] = "member"): Workspace {
  return {
    id,
    enterprise_id: "ent_1",
    name,
    status: "active",
    repository: {
      repository_id: `github:Luthiel/${name}`,
      provider_instance_id: "pi_github",
      provider_type: "github",
    },
    role,
    version: 1,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function task(id: string, workspaceId: string, summary: string): Task {
  return {
    id,
    workspace_id: workspaceId,
    version: 1,
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    current_run_id: null,
    run_history_url: "",
    status: "executing",
    status_reason: null,
    repository: { id: "repo", display_name: "owner/repo", base_ref: "main", base_sha: "abc1234" },
    request: { summary, source_reference: null },
    association: {
      task_id: id,
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
}

function installDesktopAuth() {
  window.forgePilotConfig = { apiBaseUrl: "http://127.0.0.1:4567" };
  window.forgePilotAuth = {
    getState: vi.fn(async (): Promise<DesktopAuthState> => ({
      status: "signed_in",
      providers,
      session,
    })),
    signIn: vi.fn(async () => ({ status: "signed_in" as const, providers, session })),
    cancelSignIn: vi.fn(async () => ({ status: "signed_out" as const, providers })),
    signOut: vi.fn(async () => ({ status: "signed_out" as const, providers })),
    expire: vi.fn(async () => ({ status: "expired" as const, providers })),
    retry: vi.fn(async () => ({ status: "signed_in" as const, providers, session })),
    onStateChanged: () => () => undefined,
  };
}

const alpha = workspace("ws_alpha", "Alpha");
const beta = workspace("ws_beta", "Beta", "admin");

const storedKey = "fp-workspace:usr_1";

beforeEach(() => {
  installDesktopAuth();
  window.localStorage.setItem(storedKey, "ws_alpha");
  vi.spyOn(ForgePilotClient.prototype, "listWorkspaces").mockResolvedValue([alpha, beta]);
  vi.spyOn(ForgePilotClient.prototype, "listTasks").mockResolvedValue({
    items: [],
    next_cursor: null,
  });
  vi.spyOn(ForgePilotClient.prototype, "getTask").mockImplementation(async (id) =>
    id === "beta-task" ? task(id, "ws_beta", "Beta repair") : task(id, "ws_alpha", "Alpha repair"),
  );
  vi.spyOn(ForgePilotClient.prototype, "getRuns").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "getTimeline").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "streamTaskEvents").mockImplementation(
    () => new Promise(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem(storedKey);
  delete window.forgePilotConfig;
  delete window.forgePilotAuth;
  delete window.forgePilotApi;
});

describe("workspace switcher", () => {
  it("restores the stored workspace and shows its binding and role", async () => {
    render(<App />);

    const switcher = await screen.findByRole("combobox", { name: "Workspace" });
    expect(switcher.textContent).toContain("Alpha");
    expect(screen.getByText("github:Luthiel/Alpha")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });

  it("asks for a workspace when more than one is accessible and none is stored", async () => {
    window.localStorage.removeItem(storedKey);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose a workspace" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Beta/ }));

    expect(await screen.findByRole("combobox", { name: "Workspace" })).toBeTruthy();
    expect(window.localStorage.getItem(storedKey)).toBe("ws_beta");
    expect(screen.getByText("github:Luthiel/Beta")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  it("switches workspace data and drops the previous selection", async () => {
    const listTasks = vi.mocked(ForgePilotClient.prototype.listTasks);
    listTasks
      .mockResolvedValueOnce({
        items: [task("alpha-task", "ws_alpha", "Alpha repair")],
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        items: [task("beta-task", "ws_beta", "Beta repair")],
        next_cursor: null,
      });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Alpha repair/ }));
    expect(await screen.findByRole("heading", { name: "Alpha repair" })).toBeTruthy();

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));

    expect(await screen.findByRole("button", { name: /Beta repair/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha repair/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Alpha repair" })).toBeNull();
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("closes the old workspace stream on switch", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(ForgePilotClient.prototype.streamTaskEvents).mockImplementation(
      (_taskId, options) => {
        signals.push(options.signal);
        return new Promise(() => undefined);
      },
    );
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [task("alpha-task", "ws_alpha", "Alpha repair")],
      next_cursor: null,
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Alpha repair/ }));
    await waitFor(() => expect(signals).toHaveLength(1));

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));

    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });

  it("clears a revoked workspace and returns to the chooser", async () => {
    const listWorkspaces = vi.mocked(ForgePilotClient.prototype.listWorkspaces);
    listWorkspaces
      .mockResolvedValueOnce([alpha, beta])
      .mockResolvedValueOnce([beta, workspace("ws_gamma", "Gamma")]);
    vi.mocked(ForgePilotClient.prototype.listTasks).mockRejectedValue(
      new ApiError(
        404,
        {
          error: {
            envelope_version: 1,
            code: "NOT_FOUND",
            stage: "authorization",
            category: "denial",
            message: "Workspace was not found",
            retryable: false,
            retry_after_seconds: null,
            request_id: "req_1",
            details: {},
            next_action: "reauthenticate",
          },
        },
        "Workspace was not found",
      ),
    );
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose a workspace" })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(storedKey)).toBeNull());
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("selects a sole workspace without asking and without persisting a guess", async () => {
    window.localStorage.removeItem(storedKey);
    vi.mocked(ForgePilotClient.prototype.listWorkspaces).mockResolvedValue([
      workspace("ws_one", "Solo"),
    ]);
    render(<App />);

    expect(await screen.findByRole("combobox", { name: "Workspace" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose a workspace" })).toBeNull();
    expect(window.localStorage.getItem(storedKey)).toBeNull();
  });

  it("re-reads memberships when the window regains focus", async () => {
    vi.mocked(ForgePilotClient.prototype.listWorkspaces)
      .mockResolvedValueOnce([alpha])
      .mockResolvedValueOnce([beta]);
    render(<App />);

    const switcher = await screen.findByRole("combobox", { name: "Workspace" });
    expect(switcher.textContent).toContain("Alpha");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Workspace" }).textContent).toContain("Beta"),
    );
    expect(window.localStorage.getItem(storedKey)).toBeNull();
  });

  it("keeps a viewer read-only", async () => {
    vi.mocked(ForgePilotClient.prototype.listWorkspaces).mockResolvedValue([
      workspace("ws_view", "Viewer Team", "viewer"),
    ]);
    window.localStorage.setItem(storedKey, "ws_view");
    render(<App />);

    expect(await screen.findByText("Viewer access is read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start a task" })).toBeNull();
    expect(screen.getByText("Viewer")).toBeTruthy();
  });
});
