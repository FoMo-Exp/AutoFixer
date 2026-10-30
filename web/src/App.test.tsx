// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ForgePilotClient } from "./api/client";
import type { Task } from "./api/client";

function task(id: string, summary: string): Task {
  return {
    id,
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
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Detail unavailable×");
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
    const cancelled = { ...task("task-cancelled", "Repair cancelled"), status: "cancelled" as const };
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
    const cancelled = { ...task("task-cancelled", "Repair cancelled"), status: "cancelled" as const, archived: true };
    vi.mocked(ForgePilotClient.prototype.listTasks).mockResolvedValue({ items: [...tasks, cancelled], next_cursor: null });
    const recover = vi.spyOn(ForgePilotClient.prototype, "recoverTask").mockResolvedValue({ ...cancelled, archived: false });
    const archive = vi.spyOn(ForgePilotClient.prototype, "archiveTask").mockResolvedValue(cancelled);
    const create = vi.spyOn(ForgePilotClient.prototype, "createTask");
    render(<App />);
    await screen.findByRole("button", { name: "Cancelled" });
    await userEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    await userEvent.click(screen.getByRole("button", { name: "Recover task" }));
    const dialog = screen.getByRole("dialog", { name: "Recover task?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Recover task" }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith("task-cancelled"));
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Repair cancelled owner/repo" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: "Repair cancelled owner/repo" })).toBeTruthy();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(1);
    const card = screen.getByRole("button", { name: "Repair cancelled owner/repo" }).closest("article")!;
    await userEvent.click(within(card).getByRole("button", { name: "Archive task" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Archive task?" })).getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("task-cancelled"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Repair cancelled owner/repo" })).toBeNull());
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
});
