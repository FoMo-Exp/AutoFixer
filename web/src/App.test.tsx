// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ApiError, ForgePilotClient } from "./api/client";
import { IdentityClient } from "./api/identity";
import type { Task } from "./api/client";

function task(id: string, summary: string): Task {
  return {
    id,
    workspace_id: "wsp_test",
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
    memory: null,
    governance: { current_head_sha: null, observations_valid: false, merge_queue_eligible: false },
    artifacts: { patch: null, report: null, evidence_bundle_available: false, index: [] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tasks = [
  task("task-a", "Repair alpha"),
  task("task-b", "Repair beta"),
  task("task-c", "Repair gamma"),
];
const welcome = "Turn a reported problem into an auditable change.";
beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "listTasks").mockResolvedValue({
    items: tasks,
    next_cursor: null,
  });
  vi.spyOn(ForgePilotClient.prototype, "getTask").mockImplementation(async (id) =>
    tasks.find((item) => item.id === id)!,
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
  window.localStorage.removeItem("fp-scroll");
});

async function select(summary: string) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(summary) }));
}

describe("workspace navigation", () => {
  it("does not present a terminal task's closed event stream as live", async () => {
    const cancelled = { ...tasks[0], status: "cancelled" as const, archived: false };
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [cancelled],
      next_cursor: null,
    });
    vi.mocked(ForgePilotClient.prototype.getTask).mockResolvedValue(cancelled);
    render(<App />);
    await select("Repair alpha");
    expect(await screen.findByText("Finished")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });
  it("keeps Home visible after the initial task list arrives", async () => {
    const page = deferred<{ items: Task[]; next_cursor: null }>();
    vi.mocked(ForgePilotClient.prototype.listTasks).mockReturnValue(page.promise);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    await act(async () => page.resolve({ items: tasks, next_cursor: null }));
    expect(screen.getByRole("heading", { name: welcome })).toBeTruthy();
    expect(ForgePilotClient.prototype.getTask).not.toHaveBeenCalled();
    await select("Repair alpha");
    expect(screen.getByRole("heading", { name: "Repair alpha" })).toBeTruthy();
  });

  it("switches directly between task details while the next request is pending", async () => {
    const beta = deferred<Task>();
    vi.mocked(ForgePilotClient.prototype.getTask).mockImplementation(async (id) =>
      id === "task-b" ? beta.promise : tasks[0],
    );
    render(<App />);
    await select("Repair alpha");
    await screen.findByRole("heading", { name: "Repair alpha" });
    await select("Repair beta");
    expect(screen.queryByRole("heading", { name: welcome })).toBeNull();
    expect(screen.getByRole("heading", { name: "Repair beta" })).toBeTruthy();
    await act(async () =>
      beta.resolve({ ...tasks[1], progress: { ...tasks[1].progress, phase: "Validating" } }),
    );
    expect(await screen.findByText("Validating")).toBeTruthy();
  });

  it("ignores old responses during rapid switching and after returning Home", async () => {
    const beta = deferred<Task>();
    const gamma = deferred<Task>();
    vi.mocked(ForgePilotClient.prototype.getTask).mockImplementation(async (id) =>
      id === "task-b" ? beta.promise : id === "task-c" ? gamma.promise : tasks[0],
    );
    render(<App />);
    await select("Repair beta");
    await select("Repair gamma");
    await act(async () =>
      beta.resolve({
        ...tasks[1],
        request: { ...tasks[1].request, summary: "Late beta response" },
      }),
    );
    expect(screen.getByRole("heading", { name: "Repair gamma" })).toBeTruthy();
    expect(screen.queryByText("Late beta response")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    await act(async () => gamma.resolve(tasks[2]));
    expect(screen.getByRole("heading", { name: welcome })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Repair gamma" })).toBeNull();
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the selected task visible if its background refresh fails", async () => {
    vi.mocked(ForgePilotClient.prototype.getTask).mockRejectedValue(
      new Error("Detail unavailable"),
    );
    render(<App />);
    await select("Repair beta");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveProperty("textContent", "Detail unavailable×");
    // The action error is a toast inside the detail panel, not in the topbar.
    expect(alert.closest(".main-panel")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Repair beta" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: welcome })).toBeNull();
  });

  it("preserves a draft on reselect but clears it when switching to another task", async () => {
    render(<App />);
    await select("Repair alpha");
    const draft = screen.getByPlaceholderText("Add a bounded instruction for Pi…");
    await userEvent.type(draft, "Alpha instruction");
    await select("Repair alpha");
    expect(screen.getByDisplayValue("Alpha instruction")).toBeTruthy();
    await select("Repair beta");
    expect(screen.queryByDisplayValue("Alpha instruction")).toBeNull();
    expect(
      (screen.getByPlaceholderText("Add a bounded instruction for Pi…") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    await waitFor(() => expect(ForgePilotClient.prototype.getTask).toHaveBeenCalledWith("task-b"));
  });

  it("shows the animated hero logo inside the welcome panel", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: welcome });
    const logo = document.querySelector(".welcome-panel .hero-logo");
    expect(logo).not.toBeNull();
    expect(logo!.querySelectorAll(".hero-logo-pearl")).toHaveLength(1);
    expect(logo!.querySelector(".welcome-orbit")).toBeNull();
  });

  it("keeps cancelled tasks out of All and groups them under Cancelled", async () => {
    const cancelled = {
      ...task("task-cancelled", "Repair cancelled"),
      status: "cancelled" as const,
    };
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [...tasks, cancelled],
      next_cursor: null,
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Cancelled" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair cancelled owner/repo" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    expect(await screen.findByRole("button", { name: "Repair cancelled owner/repo" })).toBeTruthy();
    expect(document.querySelector(".task-recovery-pill")?.textContent).toBe("Recovery");
    expect(screen.queryByRole("button", { name: "Repair alpha owner/repo" })).toBeNull();
  });

  it("recovers the same cancelled task into All without creating a task", async () => {
    const cancelled = {
      ...task("task-cancelled", "Repair cancelled"),
      status: "cancelled" as const,
      archived: true,
    };
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({
      items: [...tasks, cancelled],
      next_cursor: null,
    });
    const recover = vi
      .spyOn(ForgePilotClient.prototype, "recoverTask")
      .mockResolvedValue({ ...cancelled, archived: false });
    const archive = vi
      .spyOn(ForgePilotClient.prototype, "archiveTask")
      .mockResolvedValue(cancelled);
    const create = vi.spyOn(ForgePilotClient.prototype, "createTask");
    render(<App />);
    await screen.findByRole("button", { name: "Cancelled" });
    await userEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    await userEvent.click(screen.getByRole("button", { name: "Recover task" }));
    const dialog = screen.getByRole("dialog", { name: "Recover task?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Recover task" }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith("task-cancelled"));
    expect(create).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Repair cancelled owner/repo" })).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: "Repair cancelled owner/repo" })).toBeTruthy();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(1);
    const card = screen
      .getByRole("button", { name: "Repair cancelled owner/repo" })
      .closest("article")!;
    await userEvent.click(within(card).getByRole("button", { name: "Archive task" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Archive task?" })).getByRole("button", {
        name: "Archive task",
      }),
    );
    await waitFor(() => expect(archive).toHaveBeenCalledWith("task-cancelled"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Repair cancelled owner/repo" })).toBeNull(),
    );
  });

  it("confirms quick archive and removes the cancelled card from All", async () => {
    vi.spyOn(ForgePilotClient.prototype, "cancelTask").mockResolvedValue({
      ...tasks[0],
      status: "cancelled",
    });
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });

    await userEvent.click(screen.getAllByRole("button", { name: "Archive task" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Archive task?" });
    expect(ForgePilotClient.prototype.cancelTask).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive task" }));
    expect(ForgePilotClient.prototype.cancelTask).toHaveBeenCalledWith("task-a");
    expect(await screen.findByRole("button", { name: "Cancelled" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    expect(await screen.findByRole("button", { name: "Repair alpha owner/repo" })).toBeTruthy();
  });

  it("dismisses the archive confirmation with Escape without cancelling", async () => {
    const cancel = vi.spyOn(ForgePilotClient.prototype, "cancelTask");
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });
    await userEvent.click(screen.getAllByRole("button", { name: "Archive task" })[0]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps stacked mode selected when fewer than eleven tasks are visible", async () => {
    window.localStorage.setItem("fp-scroll", "stacked");
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });
    expect(document.querySelector(".task-list")?.getAttribute("data-scroll")).toBe("stacked");
  });

  it("opens task creation from the Tasks title in the sidebar", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Repair alpha/ });

    const create = screen.getByRole("button", { name: "New task" });
    expect(create.closest(".sidebar-title-row")).not.toBeNull();

    await userEvent.click(create);
    expect(await screen.findByRole("dialog", { name: "Create a controlled task" })).toBeTruthy();
  });

  it("shows a creation failure as a toast outside the create-task dialog", async () => {
    vi.spyOn(ForgePilotClient.prototype, "createTask").mockRejectedValue(
      new ApiError(
        503,
        {
          error: {
            envelope_version: 1,
            code: "PI_UNAVAILABLE",
            stage: "execution",
            category: "stop",
            message: "No Pi model is configured",
            retryable: false,
            retry_after_seconds: null,
            request_id: "req_test",
            details: {},
            next_action: "contact_admin",
          },
        },
        "Create task failed.",
      ),
    );
    render(<App />);
    await screen.findByRole("button", { name: /Repair alpha/ });

    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a controlled task" });
    await userEvent.type(within(dialog).getByLabelText(/Task summary/), "Repair the grant flow");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("PI_UNAVAILABLE: No Pi model is configured");
    expect(alert.classList.contains("create-error-toast")).toBe(true);
    expect(dialog.contains(alert)).toBe(false);
    expect(document.querySelector(".main-panel > .inline-error")).toBeNull();
    // Same transient behavior as the task-action toast.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), {
      timeout: 2000,
    });
  });
});

describe("invitation landing", () => {
  const token = "inv_2ZxQ7mK9pR4tW8vY1uB6cD3eF5gH0jL";

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
    vi.unstubAllEnvs();
  });

  it("clears the fragment before every request and shows the join screen", async () => {
    vi.stubEnv("VITE_FORGEPILOT_API_URL", "http://127.0.0.1:4599");
    window.history.replaceState(null, "", `/#${token}`);
    const hashAtRequest: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      hashAtRequest.push(window.location.hash);
      return new Response(JSON.stringify({ items: [] }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Join a workspace" })).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(document.body.innerHTML).not.toContain(token);
    // Auth and invitation requests both run only after the fragment is gone.
    expect(hashAtRequest.length).toBeGreaterThan(0);
    expect(hashAtRequest.every((hash) => hash === "")).toBe(true);
  });
});

describe("surface navigation", () => {
  it("switches to the workspace-scoped issue surface", async () => {
    vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });

    await userEvent.click(screen.getByRole("button", { name: "Issues" }));
    expect(await screen.findByRole("heading", { name: "Issues" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Workbench views" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull();
  });

  it("switches to the workspace-scoped RSI surface", async () => {
    vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });

    await userEvent.click(screen.getByRole("button", { name: "RSI" }));
    expect(await screen.findByRole("heading", { name: "Bounded self-improvement" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull();
  });

  it("moves the shared tab indicator onto the adjacent surface", async () => {
    vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });

    const nav = screen.getByRole("navigation", { name: "Workbench views" });
    const tasksTab = within(nav).getByRole("button", { name: "Tasks" });
    const issuesTab = within(nav).getByRole("button", { name: "Issues" });
    Object.defineProperty(tasksTab, "offsetLeft", { configurable: true, value: 8 });
    Object.defineProperty(tasksTab, "offsetWidth", { configurable: true, value: 128 });
    Object.defineProperty(issuesTab, "offsetLeft", { configurable: true, value: 138 });
    Object.defineProperty(issuesTab, "offsetWidth", { configurable: true, value: 128 });

    await userEvent.click(issuesTab);

    const indicator = nav.querySelector<HTMLElement>(".surface-tab-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator!.getAttribute("aria-hidden")).toBe("true");
    expect(indicator!.style.transform).toBe("translateX(138px)");
    expect(indicator!.style.width).toBe("128px");
  });
});

describe("node connection status", () => {
  it("marks the connected wordmark and exposes the status label", async () => {
    vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("button", { name: "Repair alpha owner/repo" });

    const brand = document.querySelector(".brand-name");
    expect(brand?.className).toContain("brand-connected");
    expect(brand?.querySelectorAll(".brand-initial")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe("Node connected");
  });

  it("keeps the connecting state while the first task load is pending", () => {
    vi.spyOn(IdentityClient.prototype, "listAllWorkspaces").mockResolvedValue([]);
    vi.spyOn(ForgePilotClient.prototype, "listTasks").mockImplementation(
      () => new Promise(() => undefined),
    );
    render(<App />);

    const brand = document.querySelector(".brand-name");
    expect(brand?.className).toContain("brand-connecting");
    expect(screen.getByRole("status").textContent).toBe("Connecting");
  });
});
