// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ForgePilotClient } from "../api/client";
import type { Task } from "../api/client";
import { IdentityClient } from "../api/identity";
import type { Workspace, WorkspaceCapabilityProjection } from "../api/identity";
import type { DesktopAuthState } from "../../electron/auth";
import { capabilityProjection } from "./test-projection";

const providers = [
  {
    provider_instance_id: "pi_github",
    provider_type: "github" as const,
    display_origin: "https://github.com",
  },
];

function workspace(id: string, name: string, role: Workspace["role"]): Workspace {
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

const alpha = workspace("ws_alpha", "Alpha", "member");

const task: Task = {
  id: "task_approval",
  workspace_id: "ws_alpha",
  version: 1,
  created_at: "2026-10-30T00:00:00Z",
  updated_at: "2026-10-30T00:00:00Z",
  current_run_id: null,
  run_history_url: "",
  status: "awaiting_approval",
  status_reason: null,
  repository: { id: "repo", display_name: "owner/repo", base_ref: "main", base_sha: "abc1234" },
  request: { summary: "Repair approval gate", source_reference: null },
  association: {
    task_id: "task_approval",
    run_id: null,
    repository_id: "repo",
    base_sha: "abc1234",
    head_sha: null,
  },
  revision: { base_sha: "abc1234", head_sha: null },
  risk: null,
  progress: { phase: "Awaiting approval", actions_completed: 1, actions_total: 2 },
  pi_summary: null,
  memory: null,
  governance: { current_head_sha: null, observations_valid: false, merge_queue_eligible: false },
  artifacts: { patch: null, report: null, evidence_bundle_available: false, index: [] },
};

function session(role: Workspace["role"] = "member") {
  return {
    user: { id: "usr_1", display_name: "Ada Lovelace", status: "active" as const },
    kind: "desktop" as const,
    expires_at: "2099-01-01T00:00:00Z",
    enterprise_roles: [],
    memberships: [{ enterprise_id: "ent_1", workspace_id: "ws_alpha", role }],
  };
}

function installDesktopAuth(activeSession = session()) {
  window.forgePilotConfig = { apiBaseUrl: "http://127.0.0.1:4567" };
  window.forgePilotAuth = {
    getState: vi.fn(async (): Promise<DesktopAuthState> => ({
      status: "signed_in",
      providers,
      session: activeSession,
    })),
    signIn: vi.fn(async () => ({
      status: "signed_in" as const,
      providers,
      session: activeSession,
    })),
    cancelSignIn: vi.fn(async () => ({ status: "signed_out" as const, providers })),
    signOut: vi.fn(async () => ({ status: "signed_out" as const, providers })),
    expire: vi.fn(async () => ({ status: "expired" as const, providers })),
    retry: vi.fn(async () => ({
      status: "signed_in" as const,
      providers,
      session: activeSession,
    })),
    onStateChanged: () => () => undefined,
  };
}

async function renderApp(): Promise<void> {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /Continue with organization/ }));
  await screen.findByRole("heading", { name: "Alpha" });
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Workbench views" });
}

beforeEach(() => {
  installDesktopAuth();
  window.localStorage.setItem("fp-workspace:usr_1", "ws_alpha");
  vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([alpha]);
  vi.spyOn(IdentityClient.prototype, "getWorkspaceCapabilities").mockResolvedValue(
    capabilityProjection({ role: "member", workspaceId: "ws_alpha", enterpriseId: "ent_1" }),
  );
  vi.spyOn(ForgePilotClient.prototype, "listTasks").mockResolvedValue({
    items: [task],
    next_cursor: null,
  });
  vi.spyOn(ForgePilotClient.prototype, "getTask").mockResolvedValue(task);
  vi.spyOn(ForgePilotClient.prototype, "getRuns").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "getTimeline").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "streamTaskEvents").mockImplementation(
    () => new Promise(() => undefined),
  );
  vi.spyOn(ForgePilotClient.prototype, "listSecurityCases").mockResolvedValue({
    items: [],
    next_cursor: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem("fp-workspace:usr_1");
  delete window.forgePilotConfig;
  delete window.forgePilotAuth;
  delete window.forgePilotApi;
});

describe("capability-driven module navigation", () => {
  it("draws only the modules a viewer can enter and keeps task writes hidden", async () => {
    installDesktopAuth(session("viewer"));
    vi.mocked(IdentityClient.prototype.getWorkspaceCapabilities).mockResolvedValue(
      capabilityProjection({ role: "viewer", workspaceId: "ws_alpha", enterpriseId: "ent_1" }),
    );
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    await renderApp();

    const tabs = within(nav());
    expect(tabs.getByRole("button", { name: "Tasks" })).toBeTruthy();
    expect(tabs.getByRole("button", { name: "Issues" })).toBeTruthy();
    expect(tabs.getByRole("button", { name: "Memory" })).toBeTruthy();
    expect(tabs.getByRole("button", { name: "Dashboard" })).toBeTruthy();
    expect(tabs.getByRole("button", { name: "Members & teams" })).toBeTruthy();
    expect(tabs.queryByRole("button", { name: "RSI" })).toBeNull();
    expect(tabs.queryByRole("button", { name: "Security" })).toBeNull();
    expect(tabs.queryByRole("button", { name: "Service integration" })).toBeNull();

    await userEvent.click(tabs.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByText("Viewer access is read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("gates a task approval by the projection action, not by the task state", async () => {
    await renderApp();
    await userEvent.click(within(nav()).getByRole("button", { name: "Tasks" }));
    await userEvent.click(await screen.findByRole("button", { name: /Repair approval gate/ }));

    expect(await screen.findByText("Viewer access cannot record an approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
    expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
  });

  it("shows the security module only with an explicit duty and unmounts it when the duty is lost", async () => {
    vi.mocked(IdentityClient.prototype.getWorkspaceCapabilities)
      .mockResolvedValueOnce(
        capabilityProjection({
          role: "security_handler",
          workspaceId: "ws_alpha",
          enterpriseId: "ent_1",
        }),
      )
      .mockResolvedValue(
        capabilityProjection({ role: "member", workspaceId: "ws_alpha", enterpriseId: "ent_1" }),
      );
    await renderApp();

    await userEvent.click(within(nav()).getByRole("button", { name: "Security" }));
    expect(await screen.findByRole("navigation", { name: "Security views" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(within(nav()).queryByRole("button", { name: "Security" })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Security views" })).toBeNull(),
    );
    expect(await screen.findByRole("heading", { name: "Security" })).toBeTruthy();
  });

  it("keeps an unverified module visible with no data and issues no read request", async () => {
    vi.mocked(IdentityClient.prototype.getWorkspaceCapabilities).mockResolvedValue(
      capabilityProjection({
        role: "unverified",
        workspaceId: "ws_alpha",
        enterpriseId: "ent_1",
      }),
    );
    vi.mocked(ForgePilotClient.prototype.listTasks).mockClear();
    await renderApp();

    const tab = within(nav()).getByRole("button", { name: "Tasks" });
    await userEvent.click(tab);
    expect(await screen.findByRole("heading", { name: "Tasks", level: 1 })).toBeTruthy();
    expect(
      screen.getByText(/could not be verified, so no workspace data is available/),
    ).toBeTruthy();
    expect(ForgePilotClient.prototype.listTasks).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("fails closed and offers a retry when the projection contract is unknown", async () => {
    vi.mocked(IdentityClient.prototype.getWorkspaceCapabilities).mockRejectedValue(
      Object.assign(new Error("bad shape"), { name: "CapabilityProjectionError" }),
    );
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Continue with organization/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Workspace capabilities are unavailable" }),
    ).toBeTruthy();
    expect(within(nav()).queryByRole("button", { name: "Tasks" })).toBeNull();
    expect(ForgePilotClient.prototype.listTasks).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry capability check" })).toBeTruthy();
  });

  it("re-reads the projection after a workspace switch and drops the previous modules", async () => {
    const beta = workspace("ws_beta", "Beta", "member");
    vi.mocked(IdentityClient.prototype.listAllWorkspaces).mockResolvedValue([alpha, beta]);
    vi.mocked(IdentityClient.prototype.getWorkspaceCapabilities).mockImplementation(
      async (workspaceId): Promise<WorkspaceCapabilityProjection> =>
        capabilityProjection({
          role: workspaceId === "ws_alpha" ? "security_handler" : "member",
          workspaceId,
          enterpriseId: "ent_1",
        }),
    );
    await renderApp();
    expect(within(nav()).getByRole("button", { name: "Security" })).toBeTruthy();

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));

    await waitFor(() =>
      expect(within(nav()).queryByRole("button", { name: "Security" })).toBeNull(),
    );
    expect(screen.queryByRole("navigation", { name: "Security views" })).toBeNull();
  });
});
