// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { ApiError, ForgePilotClient } from "../api/client";
import type { Task, TaskTargetList } from "../api/client";
import { IdentityClient } from "../api/identity";
import type { Workspace } from "../api/identity";
import { capabilityProjection } from "../capabilities/test-projection";
import type { DesktopAuthState } from "../../electron/auth";
import capturedTargets from "../../../docs/fixtures/task-target-api-v1/task-targets.json";
import capturedTaskWithTarget from "../../../docs/fixtures/task-target-api-v1/task-with-target.json";

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
  memberships: [{ enterprise_id: "ent_1", workspace_id: "ws_alpha", role: "member" as const }],
};

const alpha: Workspace = {
  id: "ws_alpha",
  enterprise_id: "ent_1",
  name: "Alpha",
  status: "active",
  repository: {
    repository_id: "github:FoMo-Exp/AutoFixer",
    provider_instance_id: "pi_github",
    provider_type: "github",
  },
  role: "member",
  version: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const TRUSTED = {
  binding_id: "wrb_alpha",
  repository_id: "github:FoMo-Exp/AutoFixer",
  provider_instance_id: "pi_github",
  installation_ref: "svi_1",
  repository_name: "FoMo-Exp/AutoFixer",
  position: 1,
  baseline: {
    state: "trusted" as const,
    base_ref: "main",
    base_sha: "52081eaddca099967fd8be13b3060337fde50d3f",
  },
};

const UNPINNED = {
  binding_id: "wrb_docs",
  repository_id: "github:FoMo-Exp/Docs",
  provider_instance_id: "pi_github",
  installation_ref: "svi_1",
  repository_name: "FoMo-Exp/Docs",
  position: 2,
  baseline: {
    state: "unavailable" as const,
    base_ref: null,
    base_sha: null,
    reason: "baseline_not_pinned" as const,
  },
};

function targetList(overrides: Partial<TaskTargetList> = {}): TaskTargetList {
  return {
    workspace_id: "ws_alpha",
    repository_set_version: 4,
    multi_repository: true,
    selection_required: true,
    usable: true,
    blocked_reason: null,
    targets: [TRUSTED, UNPINNED],
    ...overrides,
  };
}

const singleTargetList = targetList({
  multi_repository: false,
  selection_required: false,
  targets: [TRUSTED],
});

function taskWithTarget(setVersion = 4): Task {
  return {
    id: "tsk_1",
    workspace_id: "ws_alpha",
    version: 1,
    created_at: "2026-11-27T12:00:00.000Z",
    updated_at: "2026-11-27T12:00:00.000Z",
    current_run_id: null,
    run_history_url: "/api/v1/workspaces/ws_alpha/tasks/tsk_1/runs",
    repository: {
      id: TRUSTED.repository_id,
      display_name: TRUSTED.repository_name,
      base_ref: "main",
      base_sha: TRUSTED.baseline.base_sha,
    },
    target: {
      binding_id: TRUSTED.binding_id,
      repository_id: TRUSTED.repository_id,
      provider_instance_id: TRUSTED.provider_instance_id,
      installation_ref: TRUSTED.installation_ref,
      base_ref: "main",
      base_sha: TRUSTED.baseline.base_sha,
      set_version: setVersion,
      verified_at: "2026-11-27T12:00:00.000Z",
    },
    repository_set_version: setVersion,
    request: { summary: "Repair alpha", source_reference: null },
    association: {
      task_id: "tsk_1",
      run_id: null,
      repository_id: TRUSTED.repository_id,
      base_sha: TRUSTED.baseline.base_sha,
      head_sha: null,
    },
    revision: { base_sha: TRUSTED.baseline.base_sha, head_sha: null },
    status: "executing",
    status_reason: null,
    risk: null,
    progress: { phase: "Executing", actions_completed: 0, actions_total: null },
    pi_summary: null,
    memory: null,
    governance: { current_head_sha: null, observations_valid: false, merge_queue_eligible: false },
    artifacts: { patch: null, report: null, evidence_bundle_available: false, index: [] },
  };
}

function apiError(status: number, code: string, message: string): ApiError {
  return new ApiError(
    status,
    {
      error: {
        envelope_version: 1,
        code,
        stage: "authorization",
        category: "denial",
        message,
        retryable: false,
        retry_after_seconds: null,
        request_id: "req_test",
        details: {},
        next_action: "contact_admin",
      },
    },
    message,
  );
}

function installDesktopAuth(): void {
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

const storedKey = "fp-workspace:usr_1";

async function renderEnterpriseApp(): Promise<void> {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /Continue with organization/ }));
}

async function openCreateDialog(): Promise<HTMLElement> {
  await renderEnterpriseApp();
  await userEvent.click(await screen.findByRole("button", { name: "Open Tasks" }));
  await userEvent.click(await screen.findByRole("button", { name: "New task" }));
  return screen.findByRole("dialog", { name: "Create a controlled task" });
}

async function describeTarget(summary: string): Promise<void> {
  const dialog = await openCreateDialog();
  await userEvent.type(within(dialog).getByLabelText(/Task summary/), summary);
}

beforeEach(() => {
  installDesktopAuth();
  window.localStorage.setItem(storedKey, "ws_alpha");
  vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([alpha]);
  vi.spyOn(IdentityClient.prototype, "getWorkspaceCapabilities").mockResolvedValue(
    capabilityProjection({ role: "member", workspaceId: "ws_alpha", enterpriseId: "ent_1" }),
  );
  vi.spyOn(ForgePilotClient.prototype, "listTasks").mockResolvedValue({
    items: [],
    next_cursor: null,
  });
  vi.spyOn(ForgePilotClient.prototype, "getRuns").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "getTask").mockImplementation(async () => taskWithTarget());
  vi.spyOn(ForgePilotClient.prototype, "getTimeline").mockResolvedValue([]);
  vi.spyOn(ForgePilotClient.prototype, "streamTaskEvents").mockImplementation(
    () => new Promise(() => undefined),
  );
  vi.spyOn(ForgePilotClient.prototype, "listTaskTargets").mockResolvedValue(targetList());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem(storedKey);
  delete window.forgePilotConfig;
  delete window.forgePilotAuth;
  delete window.forgePilotApi;
});

describe("multi-repository task creation", () => {
  it("requires an explicit target and submits the immutable identity", async () => {
    const create = vi
      .spyOn(ForgePilotClient.prototype, "createTask")
      .mockResolvedValue(taskWithTarget());
    await describeTarget("Repair alpha");
    const dialog = screen.getByRole("dialog", { name: "Create a controlled task" });
    const submit = within(dialog).getByRole("button", { name: "Create task" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const chosen = await screen.findByRole("radio", { name: /FoMo-Exp\/AutoFixer/ });
    expect(screen.queryAllByRole("radio")).toHaveLength(2);
    expect(
      (screen.getByRole("radio", { name: /FoMo-Exp\/Docs/ }) as HTMLInputElement).disabled,
    ).toBe(true);

    await userEvent.click(chosen);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(submit);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      summary: "Repair alpha",
      target: {
        repository_id: TRUSTED.repository_id,
        provider_instance_id: TRUSTED.provider_instance_id,
        installation_ref: TRUSTED.installation_ref,
        base_ref: "main",
        expected_set_version: 4,
      },
    });
    expect(await screen.findByRole("heading", { name: "Repair alpha" })).toBeTruthy();
    expect(screen.getByText("Set version")).toBeTruthy();
  });

  it("invalidates the selection on a set-version conflict and requires reselection", async () => {
    const next = targetList({
      repository_set_version: 5,
      targets: [
        {
          ...TRUSTED,
          baseline: { ...TRUSTED.baseline, base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
      ],
    });
    vi.mocked(ForgePilotClient.prototype.listTaskTargets)
      .mockResolvedValueOnce(targetList())
      .mockResolvedValueOnce(next);
    const create = vi
      .spyOn(ForgePilotClient.prototype, "createTask")
      .mockRejectedValueOnce(apiError(409, "REPOSITORY_SET_VERSION_CONFLICT", "Set changed"))
      .mockResolvedValueOnce(taskWithTarget(5));
    await describeTarget("Repair alpha");
    const dialog = screen.getByRole("dialog", { name: "Create a controlled task" });
    await userEvent.click(await screen.findByRole("radio", { name: /FoMo-Exp\/AutoFixer/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "The repository set changed. Select the target again.",
    );
    await waitFor(() =>
      expect(ForgePilotClient.prototype.listTaskTargets).toHaveBeenCalledTimes(2),
    );
    const submit = within(dialog).getByRole("button", { name: "Create task" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    expect(
      screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);

    await userEvent.click(await screen.findByRole("radio", { name: /FoMo-Exp\/AutoFixer/ }));
    await userEvent.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      target: { base_ref: "main", expected_set_version: 5 },
    });
  });

  it("keeps creation closed when the target read is denied", async () => {
    vi.mocked(ForgePilotClient.prototype.listTaskTargets)
      .mockRejectedValueOnce(apiError(403, "FORBIDDEN", "No repository authority"))
      .mockResolvedValueOnce(singleTargetList);
    const create = vi.spyOn(ForgePilotClient.prototype, "createTask");
    await describeTarget("Repair alpha");
    const dialog = screen.getByRole("dialog", { name: "Create a controlled task" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("FORBIDDEN");
    expect(
      (within(dialog).getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry loading repository targets" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByLabelText("Repository")).toHaveProperty(
      "value",
      "FoMo-Exp/AutoFixer",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("single-repository task creation", () => {
  it("keeps the legacy body taken from the trusted baseline", async () => {
    vi.mocked(ForgePilotClient.prototype.listTaskTargets).mockResolvedValue(
      capturedTargets as TaskTargetList,
    );
    const create = vi
      .spyOn(ForgePilotClient.prototype, "createTask")
      .mockResolvedValue(taskWithTarget());
    await describeTarget("Repair alpha");
    const dialog = screen.getByRole("dialog", { name: "Create a controlled task" });
    expect(await screen.findByLabelText("Repository")).toHaveProperty(
      "value",
      "github:FoMo-Exp/AutoFixer",
    );
    expect(screen.getByLabelText("Base ref")).toHaveProperty("value", "main");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      summary: "Repair alpha",
      repository_id: "github:FoMo-Exp/AutoFixer",
      base_ref: "main",
    });
  });
});

describe("task detail target", () => {
  it("renders the captured immutable target response", async () => {
    const captured = capturedTaskWithTarget as Task;
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [captured],
      next_cursor: null,
    });
    vi.mocked(ForgePilotClient.prototype.getTask).mockResolvedValue(captured);
    await renderEnterpriseApp();
    await userEvent.click(await screen.findByRole("button", { name: "Open Tasks" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /legacy create records a target/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "legacy create records a target" }),
    ).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("Local prototype")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(
      screen.queryByText("Target unverified — recorded before the explicit target contract."),
    ).toBeNull();
  });

  it("reports an unverified target instead of backfilling the current binding", async () => {
    const legacy = { ...taskWithTarget(), target: null, repository_set_version: null };
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [legacy],
      next_cursor: null,
    });
    vi.mocked(ForgePilotClient.prototype.getTask).mockResolvedValue(legacy);
    await renderEnterpriseApp();
    await userEvent.click(await screen.findByRole("button", { name: "Open Tasks" }));
    await userEvent.click(await screen.findByRole("button", { name: /Repair alpha/ }));

    expect(
      await screen.findByText("Target unverified — recorded before the explicit target contract."),
    ).toBeTruthy();
    expect(screen.queryByText("Set version")).toBeNull();
  });
});
