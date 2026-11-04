// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ForgePilotClient } from "../api/client";
import type { MemoryItemPage, Workspace } from "../api/client";
import { MemoryWorkbench } from "./MemoryWorkbench";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const firstPage = fixture<MemoryItemPage>("memory-api-v1/items-page.json");
const secondPage = fixture<MemoryItemPage>("memory-api-v1/items-page-next.json");
const lessonPage = fixture<MemoryItemPage>("memory-api-v1/items-filtered-lesson.json");
const emptyPage = fixture<MemoryItemPage>("memory-api-v1/items-empty.json");
const notFound = fixture<{ error: { code: string; message: string } }>(
  "memory-api-v1/error-workspace-not-found.json",
);
const workspaces = fixture<{ items: Workspace[]; next_cursor: string | null }>(
  "identity-api-v1/workspace-page.json",
).items;
const workspace = workspaces.find((entry) => entry.status === "active")!;

function makeClient(): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

async function openFirstItem(): Promise<void> {
  const first = await screen.findByRole("button", {
    name: new RegExp(firstPage.items[0].statement),
  });
  await userEvent.click(first);
}

beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "listWorkspaces").mockResolvedValue(workspaces);
  vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(firstPage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory workbench", () => {
  it("browses workspace memory with status, tier, sensitivity, and citations", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    expect(await screen.findByText(firstPage.items[0].statement)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: new RegExp(firstPage.items[2].statement.slice(0, 40)),
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Confidential").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 citations").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Restricted item/)).toBeNull();
    expect(client.listMemoryItems).toHaveBeenCalledWith(workspace.id, {});
  });

  it("opens item detail from the list view data with evidence and applicability", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);
    await openFirstItem();

    const heading = await screen.findByRole("heading", { name: firstPage.items[0].statement });
    expect(heading).toBeTruthy();
    expect(screen.getByText("Path prefix")).toBeTruthy();
    expect(screen.getByText("web/src/memory")).toBeTruthy();
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.getByText("run:mem_02")).toBeTruthy();
    expect(screen.getByText(firstPage.items[0].content_hash)).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.getByText(/Memory is workspace reference data, not an instruction/)).toBeTruthy();
    expect(screen.getByText(/never fetches, expands, or rewrites them/)).toBeTruthy();
    expect(client.listMemoryItems).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "← Memory items" }));
    expect(await screen.findByRole("heading", { name: "Memory", level: 1 })).toBeTruthy();
  });

  it("renders every precondition of a long procedural item and only the set applicability fields", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    const item = firstPage.items.find((entry) => entry.preconditions.length > 1)!;
    await userEvent.click(
      await screen.findByRole("button", { name: new RegExp(item.statement.slice(0, 40)) }),
    );

    const section = (await screen.findByRole("heading", { name: "Preconditions" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(section).getAllByRole("listitem")).toHaveLength(item.preconditions.length);
    for (const condition of item.preconditions) {
      expect(within(section).getByText(condition)).toBeTruthy();
    }
    expect(screen.getByText("Task family")).toBeTruthy();
    expect(screen.getByText("retrieval")).toBeTruthy();
    expect(screen.queryByText("Path prefix")).toBeNull();
  });

  it("states broad applicability for an item that sets no scope", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    const item = firstPage.items.find((entry) => Object.keys(entry.applicability).length === 0)!;
    await userEvent.click(
      await screen.findByRole("button", { name: new RegExp(item.statement.slice(0, 40)) }),
    );

    expect(
      await screen.findByText(
        "Broad applicability: no team, path prefix, language, or task family is set.",
      ),
    ).toBeTruthy();
  });

  it("never renders the previous workspace's items while a new one loads", async () => {
    const client = makeClient();
    const twoWorkspaces = workspaces.map((entry) => ({ ...entry, status: "active" as const }));
    vi.spyOn(client, "listWorkspaces").mockResolvedValue(twoWorkspaces);
    let resolveSecond: ((page: MemoryItemPage) => void) | undefined;
    const pending = new Promise<MemoryItemPage>((resolve) => {
      resolveSecond = resolve;
    });
    const listMemoryItems = vi
      .spyOn(client, "listMemoryItems")
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(() => pending);

    render(<MemoryWorkbench client={client} />);
    await screen.findByText(firstPage.items[0].statement);

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme Infra · viewer" }));

    await waitFor(() => expect(listMemoryItems).toHaveBeenLastCalledWith(twoWorkspaces[1].id, {}));
    expect(screen.queryByText(firstPage.items[0].statement)).toBeNull();
    expect(await screen.findByText("Reading workspace memory…")).toBeTruthy();

    resolveSecond?.(secondPage);
    expect(await screen.findByText(secondPage.items[0].statement)).toBeTruthy();
    expect(screen.queryByText(firstPage.items[0].statement)).toBeNull();
  });

  it("hides an open item when the workspace changes", async () => {
    const client = makeClient();
    const twoWorkspaces = workspaces.map((entry) => ({ ...entry, status: "active" as const }));
    vi.spyOn(client, "listWorkspaces").mockResolvedValue(twoWorkspaces);
    vi.spyOn(client, "listMemoryItems")
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(emptyPage);

    render(<MemoryWorkbench client={client} />);
    await openFirstItem();
    expect(await screen.findByRole("heading", { name: firstPage.items[0].statement })).toBeTruthy();

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme Infra · viewer" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: firstPage.items[0].statement })).toBeNull(),
    );
    expect(
      await screen.findByText("This workspace has no memory item at your sensitivity ceiling yet."),
    ).toBeTruthy();
  });

  it("sends only contract filters and keeps them across a refresh", async () => {
    const client = makeClient();
    const listMemoryItems = vi
      .spyOn(ForgePilotClient.prototype, "listMemoryItems")
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(lessonPage);
    render(<MemoryWorkbench client={client} />);
    await screen.findByText(firstPage.items[0].statement);

    await userEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    await userEvent.click(screen.getByRole("option", { name: "Lesson" }));

    await waitFor(() =>
      expect(listMemoryItems).toHaveBeenLastCalledWith(workspace.id, { kind: "lesson" }),
    );
    expect(await screen.findByText(lessonPage.items[0].statement)).toBeTruthy();

    listMemoryItems.mockResolvedValue(lessonPage);
    await userEvent.click(screen.getByRole("button", { name: "Refresh memory list" }));
    await waitFor(() => expect(listMemoryItems).toHaveBeenCalledTimes(3));
    expect(listMemoryItems).toHaveBeenLastCalledWith(workspace.id, { kind: "lesson" });
    expect(screen.getByRole("combobox", { name: "Kind" }).textContent).toContain("Lesson");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(listMemoryItems).toHaveBeenLastCalledWith(workspace.id, {}));
  });

  it("appends the next cursor page and states the end of the list", async () => {
    const client = makeClient();
    const listMemoryItems = vi
      .spyOn(ForgePilotClient.prototype, "listMemoryItems")
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    render(<MemoryWorkbench client={client} />);
    await screen.findByText(firstPage.items[0].statement);

    await userEvent.click(screen.getByRole("button", { name: "Load more items" }));

    expect(await screen.findByText(secondPage.items[0].statement)).toBeTruthy();
    expect(listMemoryItems).toHaveBeenLastCalledWith(workspace.id, {
      cursor: firstPage.next_cursor,
    });
    expect(
      await screen.findByText(
        `End of list · ${firstPage.items.length + secondPage.items.length} items`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more items" })).toBeNull();
  });

  it("explains an empty result without inventing hidden items", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(emptyPage);
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    expect(
      await screen.findByText("This workspace has no memory item at your sensitivity ceiling yet."),
    ).toBeTruthy();
    expect(screen.queryByText(/hidden/i)).toBeNull();
  });

  it("refuses to browse a workspace outside the credential", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockRejectedValue(
      new ApiError(404, { error: { ...notFound.error, retryable: false } } as never, "Not found"),
    );
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    expect(await screen.findByText(/never readable across workspaces/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("reports a role denial separately from a missing workspace", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockRejectedValue(
      new ApiError(
        403,
        { error: { code: "FORBIDDEN", message: "Denied", retryable: false } } as never,
        "Denied",
      ),
    );
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    const alert = await screen.findByText(/Your workspace role cannot browse memory/);
    expect(
      within(alert.closest(".empty-sidebar") as HTMLElement).getByText(/FORBIDDEN/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/no longer exists/)).toBeNull();
  });

  it("offers a retry for a transport failure and clears the error on success", async () => {
    const listMemoryItems = vi
      .spyOn(ForgePilotClient.prototype, "listMemoryItems")
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(firstPage);
    const client = makeClient();
    render(<MemoryWorkbench client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText(firstPage.items[0].statement)).toBeTruthy();
    expect(screen.queryByText(/socket closed/)).toBeNull();
    expect(listMemoryItems).toHaveBeenCalledTimes(2);
  });
});
