// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ForgePilotClient } from "../api/client";
import type {
  DashboardCostItemPage,
  DashboardIssueDrilldown,
  DashboardSummary,
  Workspace,
} from "../api/client";
import { DashboardWorkbench } from "./DashboardWorkbench";
import { formatRatio, trimDecimal } from "./dashboard-format";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const summaryFixture = fixture<DashboardSummary>("dashboard-api-v1/summary.json");
const costItemsFixture = fixture<DashboardCostItemPage>("dashboard-api-v1/cost-items.json");
const drilldownFixture = fixture<DashboardIssueDrilldown>("dashboard-api-v1/issue-drilldown.json");
const workspaces = fixture<{ items: Workspace[]; next_cursor: string | null }>(
  "identity-api-v1/workspace-page.json",
).items;
const workspace = workspaces.find((entry) => entry.status === "active")!;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    "dashboard request failed",
  );
}

function loadWorkspaceDirectory(): Promise<Workspace[]> {
  return Promise.resolve(workspaces);
}

function makeClient(): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

function metricCard(label: string): HTMLElement {
  const heading = screen.getAllByRole("heading", { name: label })[0];
  const card = heading.closest("article");
  if (!card) throw new Error(`metric card ${label} not found`);
  return card;
}

async function waitForOverview(): Promise<void> {
  await screen.findByRole("heading", { name: "Workspace dashboard" });
  await screen.findByRole("img", { name: /token chart/i });
}

beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "getDashboardSummary").mockResolvedValue(summaryFixture);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace dashboard", () => {
  it("renders known, estimated and unknown token figures separately with cost provenance", async () => {
    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();

    const tokenTable = screen.getByRole("table", { name: "Tokens by category" });
    const reasoningRow = within(tokenTable)
      .getByRole("rowheader", { name: "Reasoning" })
      .closest("tr") as HTMLElement;
    expect(within(reasoningRow).getAllByText("0").length).toBe(2);
    expect(within(reasoningRow).getByText("1")).toBeTruthy();

    const totalRow = within(tokenTable)
      .getByRole("rowheader", { name: "Total" })
      .closest("tr") as HTMLElement;
    expect(within(totalRow).getByText("1,500")).toBeTruthy();
    expect(within(tokenTable).getByText("Estimated (provisional)")).toBeTruthy();
    expect(screen.getByText(/Unknown attempts contribute to no sum/)).toBeTruthy();

    // Cost provenance: currency, rate revisions, completeness and update time.
    expect(screen.getAllByText("rev-input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USD").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Currencies are never merged/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 known · 0 estimated · 0 unknown/).length).toBeGreaterThan(0);

    // A stale source stays visible instead of being folded into a total.
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no connector-lag telemetry source/).length).toBeGreaterThan(0);

    expect(client.getDashboardSummary).toHaveBeenCalledWith(workspace.id, {
      from: expect.any(String),
      to: expect.any(String),
      timezone: expect.any(String),
      bucket: "hour",
      breakdown: "model",
    });
  });

  it("charts tokens accessibly and keeps the same figures in a table", async () => {
    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();

    const chart = screen.getByRole("img", { name: /token chart by known and estimated tokens/i });
    expect(chart.getAttribute("aria-label")).toContain("gpt-4o");
    const breakdownTable = screen.getByRole("table", {
      name: /Requests, tokens, latency and cost per model/,
    });
    const row = within(breakdownTable)
      .getByRole("rowheader", { name: "gpt-4o" })
      .closest("tr") as HTMLElement;
    expect(within(row).getByText("1,500")).toBeTruthy();
    expect(within(row).getByText("USD: known USD 0.0105, est. USD 0.00")).toBeTruthy();
  });

  it("never renders missing telemetry as a zero", async () => {
    const missing = clone(summaryFixture);
    missing.totals.requests = { status: "missing_source", source: null, value: null };
    missing.totals.tokens = { status: "missing_source", source: null, figures: null };
    missing.totals.latency_ms = {
      status: "missing_source",
      source: null,
      p50_ms: null,
      p95_ms: null,
      sample_size: null,
    };
    missing.breakdown.rows = missing.breakdown.rows.map((row) => ({
      ...row,
      tokens: null,
      cost: null,
      latency_ms: null,
      error_rate: null,
    }));
    vi.spyOn(ForgePilotClient.prototype, "getDashboardSummary").mockResolvedValue(missing);

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await screen.findByRole("img", { name: /token chart/i });

    expect(within(metricCard("Requests")).getByText("—")).toBeTruthy();
    expect(within(metricCard("Requests")).queryByText("0")).toBeNull();
    expect(within(metricCard("Requests")).getAllByText("Source not wired").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/No token figures are available/)).toBeTruthy();

    const breakdownTable = screen.getByRole("table", {
      name: /Requests, tokens, latency and cost per model/,
    });
    const row = within(breakdownTable)
      .getByRole("rowheader", { name: "gpt-4o" })
      .closest("tr") as HTMLElement;
    expect(within(row).getAllByText("—")).toHaveLength(6);
  });

  it("keeps financial figures behind the owner/admin gate without probing the ledger", async () => {
    const restricted = clone(summaryFixture);
    restricted.access.financial = "restricted";
    restricted.totals.cost = {
      status: "restricted",
      source: "cost_ledger",
      lines: null,
      currencies: null,
      rate_revision_ids: null,
      completeness: null,
      updated_at: null,
    };
    restricted.totals.budget = {
      status: "restricted",
      source: "budget_journal",
      reservations: null,
      outstanding_bound: null,
      settled_known: null,
      settled_estimated: null,
      unknown_money_accounts: null,
      updated_at: null,
    };
    restricted.unavailable_metrics = [
      ...restricted.unavailable_metrics,
      { metric: "cost", reason: "financial access requires the owner or admin role" },
      { metric: "budget", reason: "financial access requires the owner or admin role" },
    ];
    restricted.breakdown.rows = restricted.breakdown.rows.map((row) => ({
      ...row,
      cost: null,
    }));
    vi.spyOn(ForgePilotClient.prototype, "getDashboardSummary").mockResolvedValue(restricted);
    const ledger = vi
      .spyOn(ForgePilotClient.prototype, "listDashboardCostItems")
      .mockResolvedValue(costItemsFixture);

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await screen.findByText(
      (_, element) =>
        element?.tagName === "SPAN" && element.textContent === "Financial: restricted",
    );

    expect(
      screen.getByText(/Financial figures need the owner or admin role; cost is omitted/),
    ).toBeTruthy();
    expect(screen.queryByText(/USD 0\.0105/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Cost ledger" }));
    expect(await screen.findByText("Financial access restricted")).toBeTruthy();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("renders a service financial denial without retrying it", async () => {
    vi.spyOn(ForgePilotClient.prototype, "listDashboardCostItems").mockRejectedValue(
      apiError(403, "FINANCIAL_ACCESS_DENIED", "financial access requires the owner or admin role"),
    );

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();
    await userEvent.click(screen.getByRole("button", { name: "Cost ledger" }));

    expect(await screen.findByText(/FINANCIAL_ACCESS_DENIED · case req_test/)).toBeTruthy();
    expect(screen.getByText(/workspace owners and admins only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("cost ledger drill-down", () => {
  beforeEach(() => {
    vi.spyOn(ForgePilotClient.prototype, "listDashboardCostItems").mockResolvedValue(
      costItemsFixture,
    );
    vi.spyOn(ForgePilotClient.prototype, "getDashboardIssueDrilldown").mockResolvedValue(
      drilldownFixture,
    );
  });

  it("drills from a posting to its bound rate revision and invocation ledger entry", async () => {
    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();
    await userEvent.click(screen.getByRole("button", { name: "Cost ledger" }));

    const posting = await screen.findByRole("button", { name: /gpt-4o/ });
    await userEvent.click(posting);

    expect(await screen.findByText("cost-inv:inv-1:1")).toBeTruthy();
    expect(screen.getByText("rev-input")).toBeTruthy();
    expect(screen.getByText("USD 0.003")).toBeTruthy();
    expect(screen.getByText("USD 0.0075")).toBeTruthy();
    expect(screen.getByText(/inv-1 · attempt 1/)).toBeTruthy();
    expect(screen.getByText("transport_reported")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Open issue trace" }));
    expect(await screen.findByRole("heading", { name: "Trace viewer" })).toBeTruthy();
    expect(client.getDashboardIssueDrilldown).toHaveBeenCalledWith(
      workspace.id,
      "issue-1",
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });

  it("keeps an unknown component unknown and never merges currencies", async () => {
    const page = clone(costItemsFixture);
    page.items[0].components[0] = {
      ...page.items[0].components[0],
      cost: null,
      completeness: "unknown",
      unknown_reason: "provider did not report units",
    };
    page.items.push({
      ...clone(costItemsFixture.items[0]),
      posting_id: "cost-inf:infra:1",
      kind: "infrastructure",
      invocation_id: null,
      attempt: null,
      model_id: null,
      requested_model: null,
      target: "self_hosted",
      currency: "EUR",
      completeness: "estimated",
      ledger_entry: null,
      ledger_lookup: "infrastructure",
      adjustments: [],
    });
    vi.spyOn(ForgePilotClient.prototype, "listDashboardCostItems").mockResolvedValue(page);

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();
    await userEvent.click(screen.getByRole("button", { name: "Cost ledger" }));
    await userEvent.click(await screen.findByRole("button", { name: /gpt-4o/ }));

    expect(await screen.findByText("provider did not report units")).toBeTruthy();
    expect(screen.getAllByText(/Unknown/).length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole("button", { name: /self hosted/ }));
    expect(
      await screen.findByText(/infrastructure posting has no invocation attempt/i),
    ).toBeTruthy();
    expect(screen.getAllByText("EUR").length).toBeGreaterThan(0);
  });
});

describe("trace viewer", () => {
  it("labels late and truncated events and states the content boundary", async () => {
    const drilldown = clone(drilldownFixture);
    drilldown.trace.events = drilldown.trace.events.map((event) => ({
      ...event,
      late: true,
      truncated: true,
    }));
    vi.spyOn(ForgePilotClient.prototype, "getDashboardIssueDrilldown").mockResolvedValue(drilldown);

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();
    await userEvent.click(screen.getByRole("button", { name: "Trace" }));

    await userEvent.type(screen.getByLabelText("Issue"), "issue-1");
    await userEvent.click(screen.getByRole("button", { name: "Open trace" }));

    expect(await screen.findByText("delivery.finished")).toBeTruthy();
    expect(screen.getByText("Late")).toBeTruthy();
    expect(screen.getByText("Truncated")).toBeTruthy();
    expect(screen.getByText("Payload included: no")).toBeTruthy();
    expect(screen.getByText(/Trace events are metadata only/)).toBeTruthy();
    expect(screen.getByText("Content: separate grant required")).toBeTruthy();
    expect(screen.getByText("Quarantine: separate grant required")).toBeTruthy();
    expect(screen.getByText("art-1")).toBeTruthy();
    expect(screen.getByText("del-1")).toBeTruthy();
    expect(screen.getByText(/No run carries a trace event/)).toBeTruthy();
    expect(client.getDashboardIssueDrilldown).toHaveBeenCalledWith(
      workspace.id,
      "issue-1",
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });

  it("renders a quarantine refusal with its stable code and no retry", async () => {
    vi.spyOn(ForgePilotClient.prototype, "getDashboardIssueDrilldown").mockRejectedValue(
      apiError(403, "QUARANTINE_ACCESS_DENIED", "the dashboard never serves quarantine material"),
    );

    const client = makeClient();
    render(<DashboardWorkbench client={client} loadWorkspaces={loadWorkspaceDirectory} />);
    await waitForOverview();
    await userEvent.click(screen.getByRole("button", { name: "Trace" }));
    await userEvent.type(screen.getByLabelText("Issue"), "issue-1");
    await userEvent.click(screen.getByRole("button", { name: "Open trace" }));

    expect(await screen.findByText(/QUARANTINE_ACCESS_DENIED/)).toBeTruthy();
    expect(
      screen.getByText(/Captured content and quarantine material need separate grants/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("dashboard formatting", () => {
  it("never turns an unmeasured ratio into zero percent", () => {
    expect(formatRatio(0, 0, null)).toBe("— (0 of 0)");
    expect(formatRatio(null, null, null)).toBe("—");
    expect(formatRatio(3, 4, 0.75)).toBe("75.0%");
  });

  it("preserves monetary precision without rounding", () => {
    expect(trimDecimal("0.010500000000")).toBe("0.0105");
    expect(trimDecimal("0.000000000000")).toBe("0.00");
    expect(trimDecimal("12")).toBe("12");
  });
});
