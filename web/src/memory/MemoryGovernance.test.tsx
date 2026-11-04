// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ForgePilotClient } from "../api/client";
import type {
  MemoryGovernanceResult,
  MemoryItem,
  MemoryItemEvents,
  MemoryItemPage,
  MemoryItemVersions,
  Workspace,
} from "../api/client";
import type { MemorySessionView } from "./memory-format";
import { MemoryWorkbench } from "./MemoryWorkbench";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const workspaces = fixture<{ items: Workspace[]; next_cursor: string | null }>(
  "identity-api-v1/workspace-page.json",
).items;
const workspace = workspaces.find((entry) => entry.status === "active")!;
const team = fixture<{
  id: string;
  workspace_id: string;
  name: string;
  leader_user_id: string;
}>("identity-api-v1/team.json");

const activeItem = fixture<MemoryItem>("memory-api-v1/item-detail.json");
const candidateItem = fixture<MemoryItem>("memory-api-v1/item-candidate.json");
const quarantinedItem = fixture<MemoryItem>("memory-api-v1/item-quarantined.json");
const versions = fixture<MemoryItemVersions>("memory-api-v1/versions.json");
const singleVersion = fixture<MemoryItemVersions>("memory-api-v1/versions-single.json");
const firstEvents = fixture<MemoryItemEvents>("memory-api-v1/events-page.json");
const nextEvents = fixture<MemoryItemEvents>("memory-api-v1/events-page-next.json");
const promoted = fixture<MemoryGovernanceResult>("memory-api-v1/governance-promote.json");
const conflict = fixture<{ error: Record<string, unknown> }>(
  "memory-api-v1/error-version-conflict.json",
);

function page(items: MemoryItem[]): MemoryItemPage {
  return { items, next_cursor: null };
}

function session(role: "owner" | "admin" | "member" | "viewer"): MemorySessionView {
  return {
    user: { id: team.leader_user_id },
    memberships: [{ workspace_id: workspace.id, role }],
  };
}

function makeClient(): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

async function openItem(item: MemoryItem): Promise<void> {
  const statement = item.statement;
  if (!statement) throw new Error("fixture item has no statement");
  const button = await screen.findByRole("button", { name: new RegExp(statement.slice(0, 40)) });
  await userEvent.click(button);
}

async function openQuarantinedItem(): Promise<void> {
  const button = await screen.findByRole("button", {
    name: /Content withheld while quarantined/,
  });
  await userEvent.click(button);
}

beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "listWorkspaces").mockResolvedValue(workspaces);
  vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(page([activeItem]));
  vi.spyOn(ForgePilotClient.prototype, "getMemoryItem").mockResolvedValue(activeItem);
  vi.spyOn(ForgePilotClient.prototype, "listMemoryItemVersions").mockResolvedValue(versions);
  vi.spyOn(ForgePilotClient.prototype, "listMemoryItemEvents").mockResolvedValue(firstEvents);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory version diff", () => {
  it("diffs two returned versions side by side with marked additions and removals", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(activeItem);

    expect(await screen.findByRole("heading", { name: "v2" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "v3" })).toBeTruthy();
    const diff = document.querySelector(".memory-diff") as HTMLElement;
    expect(diff).toBeTruthy();
    expect(diff.querySelectorAll(".memory-diff-removed").length).toBeGreaterThan(0);
    expect(diff.querySelectorAll(".memory-diff-added").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bundle at budget").length).toBeGreaterThan(0);
    expect(screen.getAllByText("policy item active").length).toBeGreaterThan(0);
    expect(client.listMemoryItemVersions).toHaveBeenCalledWith(workspace.id, activeItem.item_id);
  });

  it("states when a single returned version leaves nothing to compare", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItemVersions").mockResolvedValue(singleVersion);
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([candidateItem]),
    );
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(candidateItem);

    expect(
      await screen.findByText(
        "Only one version is available within your sensitivity ceiling, so there is nothing to compare yet.",
      ),
    ).toBeTruthy();
    expect(document.querySelector(".memory-diff")).toBeNull();
  });

  it("explains an empty returned history instead of inventing versions", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItemVersions").mockResolvedValue({
      schema_version: 1,
      item_id: activeItem.item_id,
      status: activeItem.status,
      current_version: activeItem.current_version,
      versions: [],
    });
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(activeItem);

    expect(
      await screen.findByText(/No version content is available within your sensitivity ceiling/),
    ).toBeTruthy();
  });
});

describe("memory governance", () => {
  it("shows owner/admin transitions, the exact version, and applies the server result", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([candidateItem]),
    );
    let resolvePromote: ((result: MemoryGovernanceResult) => void) | undefined;
    const pending = new Promise<MemoryGovernanceResult>((resolve) => {
      resolvePromote = resolve;
    });
    const client = makeClient();
    const promote = vi.spyOn(client, "promoteMemoryItem").mockReturnValue(pending);

    render(<MemoryWorkbench client={client} session={session("owner")} />);
    await openItem(candidateItem);

    const button = await screen.findByRole("button", { name: "Promote to active" });
    await userEvent.click(button);

    const form = screen.getByRole("form", { name: "Confirm promote" });
    expect(within(form).getByText("Candidate")).toBeTruthy();
    expect(within(form).getByText("Active")).toBeTruthy();
    expect(within(form).getAllByText("v2").length).toBeGreaterThan(0);

    await userEvent.click(within(form).getByRole("button", { name: "Confirm Promote" }));

    // No optimistic update: the item still reads Candidate until the response lands.
    expect(screen.getByText("Applying…")).toBeTruthy();
    expect(promote).toHaveBeenCalledWith(workspace.id, candidateItem.item_id, {
      version: 2,
      expected_version: 2,
    });

    resolvePromote?.(promoted);
    const banner = (await screen.findByText("Promote applied.")).closest(
      ".memory-governance-result",
    ) as HTMLElement;
    expect(within(banner).getByText(/Candidate → Active/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Promote to active" })).toBeNull();
  });

  it("reports a 409 as a stale view with an explicit refresh, never a silent retry", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([candidateItem]),
    );
    const refreshed = { ...activeItem, current_version: 3 };
    const client = makeClient();
    const promote = vi
      .spyOn(client, "promoteMemoryItem")
      .mockRejectedValue(new ApiError(409, conflict as never, "Conflict"));
    const getItem = vi
      .spyOn(ForgePilotClient.prototype, "getMemoryItem")
      .mockResolvedValue(refreshed);

    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(candidateItem);
    await userEvent.click(await screen.findByRole("button", { name: "Promote to active" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm Promote" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/VERSION_CONFLICT/)).toBeTruthy();
    expect(within(alert).getByText(/Refresh to load the current version/)).toBeTruthy();
    expect(promote).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Applying…")).toBeNull();

    await userEvent.click(within(alert).getByRole("button", { name: "Refresh item" }));

    await waitFor(() => expect(getItem).toHaveBeenCalledWith(workspace.id, candidateItem.item_id));
    expect(await screen.findByText("3 of 3")).toBeTruthy();
    expect(promote).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("denies governance to a member even when the workspace projection says admin", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("member")} />);
    await openItem(activeItem);

    expect(await screen.findByRole("heading", { name: "Governance" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deprecate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quarantine" })).toBeNull();
    expect(screen.getByText(/can read this item but not govern it/)).toBeTruthy();
  });

  it("hides governance from a viewer", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("viewer")} />);
    await openItem(activeItem);

    expect(await screen.findByRole("heading", { name: "Governance" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Quarantine|Deprecate|Promote/ })).toBeNull();
    expect(screen.getByText(/read-only for memory governance/)).toBeTruthy();
  });

  it("grants a team leader only items scoped to the team they lead", async () => {
    const otherTeamItem = {
      ...activeItem,
      item_id: "mem_other_team_item",
      statement: "Workspace-wide policy without a team scope",
      applicability: { task_family: "retrieval" },
    };
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([activeItem, otherTeamItem]),
    );
    const client = makeClient();
    const loadTeams = vi.fn().mockResolvedValue([team]);

    render(<MemoryWorkbench client={client} session={session("member")} loadTeams={loadTeams} />);

    await openItem(activeItem);
    expect(await screen.findByRole("button", { name: "Deprecate" })).toBeTruthy();
    expect(screen.getByText(/Team leadership grants governance for/)).toBeTruthy();
    expect(loadTeams).toHaveBeenCalledWith(workspace.id);

    await userEvent.click(screen.getByRole("button", { name: "← Memory items" }));
    await openItem(otherTeamItem);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Deprecate" })).toBeNull());
    expect(screen.getByText(/can read this item but not govern it/)).toBeTruthy();
  });

  it("refuses to verify team leadership on a failed teams read", async () => {
    const client = makeClient();
    const loadTeams = vi.fn().mockRejectedValue(new Error("teams offline"));
    render(<MemoryWorkbench client={client} session={session("member")} loadTeams={loadTeams} />);
    await openItem(activeItem);

    expect(await screen.findByText(/Team leadership could not be verified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deprecate" })).toBeNull();
  });
});

describe("quarantine redaction", () => {
  it("keeps original content out of the DOM even if the response wrongly carries it", async () => {
    const original = "Original poisoned statement about retrieval hints";
    const leaky = {
      ...quarantinedItem,
      statement: original,
      statement_redacted: false,
      preconditions: ["leaked precondition"],
      evidence: [{ evidence_type: "incident" as const, reference: "incident:raw-reference" }],
    };
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(page([leaky]));
    const versionsSpy = vi.spyOn(ForgePilotClient.prototype, "listMemoryItemVersions");
    const client = makeClient();
    const { container } = render(<MemoryWorkbench client={client} session={session("admin")} />);

    await openQuarantinedItem();

    expect(
      (await screen.findAllByText("Content withheld while quarantined")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Content withheld")).toBeTruthy();
    expect(screen.getAllByText("Quarantined").length).toBeGreaterThan(0);
    expect(container.innerHTML).not.toContain(original);
    expect(container.innerHTML).not.toContain("leaked precondition");
    expect(container.innerHTML).not.toContain("incident:raw-reference");
    expect(versionsSpy).not.toHaveBeenCalled();
  });

  it("shows the recorded quarantine reason code instead of free text", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([quarantinedItem]),
    );
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItemEvents").mockResolvedValue({
      item_id: quarantinedItem.item_id,
      events: [
        {
          at: "2026-11-04T10:05:00Z",
          source: "memory_event",
          action: "status_changed",
          actor: { type: "user", id: team.leader_user_id },
          item_version: 3,
          from_status: "active",
          to_status: "quarantined",
          reason_code: "security_report",
          detail: { reason_code: "security_report" },
        },
      ],
      next_cursor: null,
    });
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);

    await openQuarantinedItem();
    const card = (
      await screen.findByRole("heading", {
        name: "Quarantined content is withheld",
      })
    ).closest("section") as HTMLElement;
    expect(within(card).getByText("Security report")).toBeTruthy();
    expect(screen.queryByText(/Restore can return/)).toBeTruthy();
  });
});

describe("audit timeline and metadata", () => {
  it("renders actor, action, version, time, fixed reason, and paged detail", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(activeItem);

    const timeline = (await screen.findByRole("heading", { name: "Audit timeline" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(timeline).getByText("Item created")).toBeTruthy();
    expect(within(timeline).getAllByText("Promotion decision").length).toBeGreaterThan(0);
    expect(within(timeline).getAllByText(/Human actor/).length).toBe(5);
    expect(within(timeline).getAllByText("v1").length).toBeGreaterThan(0);
    expect(within(timeline).getAllByText("Human decision").length).toBeGreaterThan(0);
    expect(within(timeline).getByText("independent_support_runs")).toBeTruthy();

    vi.spyOn(ForgePilotClient.prototype, "listMemoryItemEvents").mockResolvedValue(nextEvents);
    await userEvent.click(
      within(timeline).getByRole("button", { name: "Load more audit entries" }),
    );

    expect(await screen.findByText("Consolidation merge")).toBeTruthy();
    expect(await screen.findByText("End of timeline · 7 entries")).toBeTruthy();
    expect(client.listMemoryItemEvents).toHaveBeenLastCalledWith(workspace.id, activeItem.item_id, {
      limit: 50,
      cursor: "cur_mem_audit_1",
    });
  });

  it("shows provenance and the named review stamp", async () => {
    const client = makeClient();
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(activeItem);

    const card = (await screen.findByRole("heading", { name: "Provenance and review" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(card).getByText("Human author")).toBeTruthy();
    expect(within(card).getByText(/usr_01J8Z5N4P7/)).toBeTruthy();
  });
});

describe("governance filters", () => {
  it("sends trust, sensitivity, and scope filters and clears them", async () => {
    const client = makeClient();
    const list = vi.spyOn(ForgePilotClient.prototype, "listMemoryItems");
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await screen.findByText(activeItem.statement as string);

    await userEvent.click(screen.getByRole("combobox", { name: "Trust" }));
    await userEvent.click(screen.getByRole("option", { name: "Human-authored" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(workspace.id, { trust: "human" }));

    await userEvent.click(screen.getByRole("combobox", { name: "Sensitivity" }));
    await userEvent.click(screen.getByRole("option", { name: "Confidential" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(workspace.id, {
        trust: "human",
        sensitivity: "confidential",
      }),
    );

    await userEvent.click(screen.getByText("Scope filters"));
    await userEvent.type(screen.getByLabelText("Team id"), team.id);
    await userEvent.type(screen.getByLabelText("Path prefix"), "web/src/memory");
    await userEvent.type(screen.getByLabelText("Language"), "ts");
    await userEvent.type(screen.getByLabelText("Task family"), "retrieval");
    await userEvent.click(screen.getByRole("button", { name: "Apply scope filters" }));

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(workspace.id, {
        trust: "human",
        sensitivity: "confidential",
        team_id: team.id,
        path_prefix: "web/src/memory",
        language: "ts",
        task_family: "retrieval",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(workspace.id, {}));
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});

describe("governance error surfaces", () => {
  it("reports a server 403 as a denial and offers no retry", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([candidateItem]),
    );
    const client = makeClient();
    vi.spyOn(client, "promoteMemoryItem").mockRejectedValue(
      new ApiError(
        403,
        {
          error: {
            envelope_version: 1,
            code: "FORBIDDEN",
            stage: "authorization",
            category: "stop",
            message: "denied",
            retryable: false,
            retry_after_seconds: null,
            request_id: "req_denied",
            details: {},
            next_action: null,
          },
        },
        "Denied",
      ),
    );
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openItem(candidateItem);
    await userEvent.click(await screen.findByRole("button", { name: "Promote to active" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm Promote" }));

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText(/Only workspace owners, admins, and the leading team/),
    ).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Refresh item" })).toBeNull();
  });

  it("restores a quarantined item to the chosen target with a fixed reason", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listMemoryItems").mockResolvedValue(
      page([quarantinedItem]),
    );
    const client = makeClient();
    const restore = vi.spyOn(client, "restoreMemoryItem").mockResolvedValue({
      action: "restore",
      item_id: quarantinedItem.item_id,
      from_status: "quarantined",
      to_status: "candidate",
      item_version: 3,
      reason_code: "restore_after_review",
      item: { ...candidateItem, item_id: quarantinedItem.item_id, current_version: 3 },
    });
    render(<MemoryWorkbench client={client} session={session("admin")} />);
    await openQuarantinedItem();

    await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
    const form = screen.getByRole("form", { name: "Confirm restore" });
    expect(within(form).getByText("Quarantined")).toBeTruthy();

    await userEvent.click(within(form).getAllByRole("combobox")[0]);
    await userEvent.click(screen.getByRole("option", { name: "Proposed" }));
    await userEvent.click(within(form).getByRole("button", { name: "Confirm Restore" }));

    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith(workspace.id, quarantinedItem.item_id, {
        version: 3,
        expected_version: 3,
        target_status: "proposed",
        reason_code: "restore_after_review",
      }),
    );
    expect(await screen.findByText("Restore applied.")).toBeTruthy();
  });
});
