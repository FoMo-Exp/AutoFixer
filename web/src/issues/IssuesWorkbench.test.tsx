// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgePilotClient } from "../api/client";
import type {
  Approval,
  Candidate,
  Issue,
  IssueEvent,
  IssuePage,
  IssueRunPage,
  IssueStage,
  IssueTaskPage,
  Workspace,
} from "../api/client";
import { IssuesWorkbench } from "./IssuesWorkbench";

const repoFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(repoFixtureDir, name), "utf8")) as T;
}

const issuePage = fixture<IssuePage>("collab-api-v1/issue-page.json");
const issue: Issue = issuePage.items[0];
const stage = fixture<IssueStage>("collab-api-v1/issue-stage.json");
const taskPage = fixture<IssueTaskPage>("collab-api-v1/task-page.json");
const runPage = fixture<IssueRunPage>("collab-api-v1/run-page.json");
const stageEvent = fixture<IssueEvent>("collab-api-v1/issue-event.json");
const workspaces = fixture<{ items: Workspace[]; next_cursor: string | null }>(
  "identity-api-v1/workspace-page.json",
).items;

const activeWorkspace = workspaces.find((workspace) => workspace.status === "active")!;

function makeClient(): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

function mockDetail(client: ForgePilotClient): void {
  vi.spyOn(client, "getIssue").mockResolvedValue(issue);
  vi.spyOn(client, "getIssueStage").mockResolvedValue(stage);
  vi.spyOn(client, "listIssueTasks").mockResolvedValue(taskPage);
  vi.spyOn(client, "listIssueRuns").mockResolvedValue(runPage);
  vi.spyOn(client, "listIssueCandidates").mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(client, "listIssueApprovals").mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(client, "listIssueDeliveries").mockResolvedValue({ items: [], next_cursor: null });
}

function streamReplay(client: ForgePilotClient, events: IssueEvent[]): void {
  vi.spyOn(client, "streamIssueEvents").mockImplementation(async (_workspace, _issue, options) => {
    for (const event of events) options.onEvent(event);
    return { lastEventId: events.at(-1)?.event_id, terminal: true };
  });
}

async function openIssue(): Promise<void> {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(issue.summary.slice(0, 30)) }),
  );
  await screen.findByRole("heading", { name: issue.summary, level: 2 });
}

beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "listWorkspaces").mockResolvedValue(workspaces);
  vi.spyOn(ForgePilotClient.prototype, "listIssues").mockResolvedValue(issuePage);
  vi.spyOn(ForgePilotClient.prototype, "streamIssueEvents").mockImplementation(
    () => new Promise(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("issue workbench", () => {
  it("loads the frozen candidate review for the named human approver", async () => {
    const client = makeClient();
    mockDetail(client);
    const candidate = fixture<Candidate>("collab-api-v1/candidate.json");
    const approval = fixture<Approval>("collab-api-v1/approval.json");
    vi.spyOn(client, "listIssueCandidates").mockResolvedValue({
      items: [candidate],
      next_cursor: null,
    });
    vi.spyOn(client, "listIssueApprovals").mockResolvedValue({
      items: [approval],
      next_cursor: null,
    });
    vi.spyOn(client, "listIssueDeliveries").mockResolvedValue({
      items: [],
      next_cursor: null,
    });

    render(<IssuesWorkbench client={client} currentUserId="usr_luthiel" />);
    await openIssue();

    expect(await screen.findByText(candidate.summary)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Approve candidate" })).toBeTruthy();
    expect(screen.getByText(/No delivery operation exists yet/)).toBeTruthy();
  });

  it("renders the issue, its product stage, harness run, and replayed event", async () => {
    const client = makeClient();
    mockDetail(client);
    streamReplay(client, [stageEvent]);

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(screen.getAllByText("Awaiting change approval").length).toBeGreaterThan(0);
    expect(screen.getByText(/No remote branch or PR exists/)).toBeTruthy();
    expect(screen.getByText("Harness: Stopped")).toBeTruthy();
    expect(
      screen.getByText(
        "Local preparation complete; candidate frozen and awaiting human change approval.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/A stopped run never resumes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /resume run/i })).toBeNull();
    expect(screen.getByText("Approval requested")).toBeTruthy();
    expect(screen.getByText(/Deduplicated on event_id, ordered by sequence/)).toBeTruthy();
  });

  it("records a reason before a needs-human transition", async () => {
    const client = makeClient();
    mockDetail(client);
    const transition = vi
      .spyOn(client, "transitionIssueStage")
      .mockResolvedValue({ ...stage, product_state: "needs_human" });

    render(<IssuesWorkbench client={client} />);
    await openIssue();
    await userEvent.click(screen.getByRole("button", { name: /Move to Needs human disposition/ }));

    const dialog = await screen.findByRole("dialog", { name: "Move to Needs human disposition" });
    const submit = within(dialog).getByRole("button", { name: "Apply transition" });
    expect(submit).toHaveProperty("disabled", true);

    await userEvent.type(
      within(dialog).getByLabelText(/Reason \(required/),
      "Validation failed twice",
    );
    expect(submit).toHaveProperty("disabled", false);
    await userEvent.click(submit);

    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        activeWorkspace.id,
        issue.issue_id,
        { to: "needs_human", reason: "Validation failed twice" },
        expect.stringMatching(/^forgepilot-ui-/),
      ),
    );
  });

  it("requires a disposition reference when leaving needs_human", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIssue").mockResolvedValue({ ...issue, product_state: "needs_human" });
    vi.spyOn(client, "getIssueStage").mockResolvedValue({
      ...stage,
      product_state: "needs_human",
      state_reason: "Validation stopped; human decision required.",
      allowed_transitions: ["planning", "cancelled"],
    });
    vi.spyOn(client, "listIssueTasks").mockResolvedValue(taskPage);
    vi.spyOn(client, "listIssueRuns").mockResolvedValue(runPage);
    const transition = vi
      .spyOn(client, "transitionIssueStage")
      .mockResolvedValue({ ...stage, product_state: "planning" });

    render(<IssuesWorkbench client={client} />);
    await openIssue();
    await userEvent.click(screen.getByRole("button", { name: /Record disposition → Planning/ }));

    const dialog = await screen.findByRole("dialog", { name: "Move to Planning" });
    const submit = within(dialog).getByRole("button", { name: "Apply transition" });
    expect(submit).toHaveProperty("disabled", true);
    expect(within(dialog).queryByLabelText(/Reason \(required/)).toBeNull();

    await userEvent.type(
      within(dialog).getByLabelText(/Human disposition reference/),
      "DAT-999 triage note",
    );
    await userEvent.click(submit);

    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(
        activeWorkspace.id,
        issue.issue_id,
        { to: "planning", disposition: { reference: "DAT-999 triage note" } },
        expect.stringMatching(/^forgepilot-ui-/),
      ),
    );
  });

  it("shows a cancelled issue as terminal with no transitions", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIssue").mockResolvedValue({
      ...issue,
      product_state: "cancelled",
      state_reason: "Duplicate of DAT-1",
    });
    vi.spyOn(client, "getIssueStage").mockResolvedValue({
      ...stage,
      product_state: "cancelled",
      state_reason: "Duplicate of DAT-1",
      allowed_transitions: [],
    });
    vi.spyOn(client, "listIssueTasks").mockResolvedValue(taskPage);
    vi.spyOn(client, "listIssueRuns").mockResolvedValue(runPage);

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(screen.getByText(/Cancelled is terminal for this issue/)).toBeTruthy();
    expect(screen.getByText(/no allowed transition from this stage/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Move to / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record disposition →/ })).toBeNull();
  });

  it("disables stage and task changes for a viewer role", async () => {
    const client = makeClient();
    const viewerWorkspace = {
      ...activeWorkspace,
      id: "ws_viewer",
      name: "Acme Read Only",
      role: "viewer" as const,
    };
    vi.mocked(ForgePilotClient.prototype.listWorkspaces).mockResolvedValue([viewerWorkspace]);
    mockDetail(client);

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(screen.getByText(/viewer · read-only/)).toBeTruthy();
    expect(screen.getByText(/Your workspace role is read-only/)).toBeTruthy();
    const transitions = screen.getAllByRole("button", { name: /^Move to / });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
  });

  it("resolves task dependencies from every task page", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIssue").mockResolvedValue({ ...issue, product_state: "implementing" });
    vi.spyOn(client, "getIssueStage").mockResolvedValue({
      ...stage,
      product_state: "implementing",
    });
    vi.spyOn(client, "listIssueTasks")
      .mockResolvedValueOnce({
        items: [
          {
            ...taskPage.items[0],
            state: "open",
            depends_on: ["tsk_analysis_01"],
          },
        ],
        next_cursor: "cur_tasks",
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...taskPage.items[0],
            task_id: "tsk_analysis_01",
            role: "analysis",
            state: "done",
            depends_on: [],
          },
        ],
        next_cursor: null,
      });
    vi.spyOn(client, "listIssueRuns").mockResolvedValue(runPage);

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(await screen.findAllByText(/tsk_analysis_0/)).not.toHaveLength(0);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText(/Blocked:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start task" })).toHaveProperty("disabled", false);
  });

  it("shows stop outcomes from runs on later pages", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIssue").mockResolvedValue(issue);
    vi.spyOn(client, "getIssueStage").mockResolvedValue(stage);
    vi.spyOn(client, "listIssueTasks").mockResolvedValue(taskPage);
    vi.spyOn(client, "listIssueRuns")
      .mockResolvedValueOnce({
        items: [{ ...runPage.items[0], run_id: "run_first", state: "running", stop_reason: null }],
        next_cursor: "cur_runs",
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...runPage.items[0],
            run_id: "run_second",
            state: "stopped",
            stop_reason: "Second attempt stopped by policy.",
          },
        ],
        next_cursor: null,
      });

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(await screen.findAllByText("Second attempt stopped by policy.")).not.toHaveLength(0);
    expect(screen.getByText("Harness: Stopped")).toBeTruthy();
    expect(screen.getByText("2 runs")).toBeTruthy();
  });

  it("names an unknown harness state instead of mapping it", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIssue").mockResolvedValue(issue);
    vi.spyOn(client, "getIssueStage").mockResolvedValue(stage);
    vi.spyOn(client, "listIssueTasks").mockResolvedValue(taskPage);
    vi.spyOn(client, "listIssueRuns").mockResolvedValue({
      items: [{ ...runPage.items[0], state: "paused" as IssueRunPage["items"][number]["state"] }],
      next_cursor: null,
    });

    render(<IssuesWorkbench client={client} />);
    await openIssue();

    expect(screen.getByText("Harness: Unknown harness state (paused)")).toBeTruthy();
  });

  it("labels the scope selector and issue filters for assistive technology", async () => {
    const client = makeClient();
    mockDetail(client);
    const second = { ...activeWorkspace, id: "ws_second", name: "Acme Infra" };
    vi.mocked(ForgePilotClient.prototype.listWorkspaces).mockResolvedValue([
      activeWorkspace,
      second,
    ]);

    render(<IssuesWorkbench client={client} />);

    expect(await screen.findByRole("group", { name: "Workspace scope" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Product stage filters" })).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
