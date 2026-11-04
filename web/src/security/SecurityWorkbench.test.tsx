// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ForgePilotClient } from "../api/client";
import type {
  SecurityAuditEntry,
  SecurityAuditPage,
  SecurityCase,
  SecurityCasePage,
  SecurityRecoveryApproval,
  SecurityRecoveryDispatch,
  SecurityRulePage,
  SecurityRuleRevision,
  Workspace,
} from "../api/client";
import type { WorkspaceSession } from "../api/identity";
import type { components } from "../api/contracts/schema";
import { SecurityWorkbench } from "./SecurityWorkbench";

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
const casePage = fixture<SecurityCasePage>("security-api-v1/case-page.json");
const caseRecord = fixture<SecurityCase>("security-api-v1/case.json");
const auditPage = fixture<SecurityAuditPage>("security-api-v1/audit-page.json");
const grant = fixture<components["schemas"]["SecurityQuarantineGrant"]>(
  "security-api-v1/quarantine-grant.json",
);
const approvalFixture = fixture<SecurityRecoveryApproval>("security-api-v1/recovery-approval.json");
const dispatchFixture = fixture<SecurityRecoveryDispatch>("security-api-v1/recovery-dispatch.json");
const rulePage = fixture<SecurityRulePage>("security-api-v1/rule-page.json");
const ruleRevision = fixture<SecurityRuleRevision>("security-api-v1/rule-revision.json");
const errorEnvelope = fixture<components["schemas"]["Error"]>(
  "security-api-v1/error-recovery-approval-invalid.json",
);

type ErrorPayload = ConstructorParameters<typeof ApiError>[1];

function apiError(code: string, status: number, message: string): ApiError {
  const payload = {
    error: { ...errorEnvelope.error, code, message },
  } as ErrorPayload;
  return new ApiError(status, payload, message);
}

function sessionFor(userId: string, admin = false): WorkspaceSession {
  return {
    user: { id: userId, display_name: userId, status: "active" },
    enterprise_roles: admin ? [{ enterprise_id: workspace.enterprise_id, role: "admin" }] : [],
    memberships: [
      { enterprise_id: workspace.enterprise_id, workspace_id: workspace.id, role: "member" },
    ],
  };
}

function historyEntry(
  seq: number,
  event: SecurityAuditEntry["event"]["event"],
  actorId: string,
): SecurityAuditEntry {
  const base = auditPage.items[0];
  return {
    seq,
    hash: `ah1.${seq}`,
    event: {
      ...base.event,
      event_id: `evt_${seq}`,
      event,
      action: event,
      actor: { actor_id: actorId, actor_kind: "human", role: null, independent_of: null },
      case_id: caseRecord.case_id,
      result: "recorded",
    },
  };
}

function auditPageWith(items: SecurityAuditEntry[]): SecurityAuditPage {
  return { items, next_cursor: null };
}

function approval(overrides: Partial<SecurityRecoveryApproval> = {}): SecurityRecoveryApproval {
  return {
    ...approvalFixture,
    case_id: caseRecord.case_id,
    scope: caseRecord.scope,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
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

async function openCase(): Promise<void> {
  const row = await screen.findByRole("button", { name: new RegExp(caseRecord.case_id) });
  await userEvent.click(row);
  await screen.findByRole("heading", { name: caseRecord.case_id });
}

async function openRules(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Rules" }));
}

async function openRule(version: number): Promise<void> {
  const row = await screen.findByRole("button", { name: new RegExp(`v${version}`) });
  await userEvent.click(row);
  await screen.findByRole("heading", { name: "openai_key" });
}

beforeEach(() => {
  vi.spyOn(ForgePilotClient.prototype, "listSecurityCases").mockResolvedValue(casePage);
  vi.spyOn(ForgePilotClient.prototype, "getSecurityCase").mockResolvedValue(caseRecord);
  vi.spyOn(ForgePilotClient.prototype, "readSecurityAuditTrail").mockResolvedValue(auditPage);
  vi.spyOn(ForgePilotClient.prototype, "listSecurityRuleRevisions").mockResolvedValue(rulePage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("security case inbox", () => {
  it("lists redacted cases and never renders quarantined content without an audited view", async () => {
    const client = makeClient();
    const view = vi
      .spyOn(ForgePilotClient.prototype, "viewQuarantinedContext")
      .mockRejectedValue(new Error("must not be called"));
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );

    expect(await screen.findByText(caseRecord.case_id)).toBeTruthy();
    await openCase();

    expect(screen.getAllByText("SENSITIVE_DATA_UNCERTAIN").length).toBeGreaterThan(0);
    expect(screen.getByText(/A suspected credential was found/)).toBeTruthy();
    expect(screen.getByText("q_3c1d")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect quarantined context" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(view).not.toHaveBeenCalled();
    expect(screen.queryByText(/sk-live/)).toBeNull();
  });

  it("offers no per-call bypass or override control anywhere in the case desk", async () => {
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openCase();

    expect(screen.queryByRole("button", { name: /send anyway/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /override/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /skip (checks|review)/i })).toBeNull();
    expect(screen.getByText(/There is no per-call exemption/)).toBeTruthy();
  });

  it("disables review for the handler of record and enables it for another reviewer", async () => {
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockResolvedValue(
      auditPageWith([
        historyEntry(1, "case.handled", "human_handler"),
        historyEntry(2, "case.submitted_for_review", "human_handler"),
      ]),
    );

    const handlerClient = makeClient();
    const first = render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={handlerClient}
        session={sessionFor("human_handler")}
      />,
    );
    await openCase();
    expect(await screen.findByRole("button", { name: "Approve & resolve" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Send back to handling" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getAllByText(/You handled this review round/).length).toBeGreaterThan(0);
    first.unmount();

    const reviewerClient = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={reviewerClient}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve & resolve" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(screen.getByRole("button", { name: "Send back to handling" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("fails closed when the append-only history is unavailable", async () => {
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockRejectedValue(
      apiError("SOD_DUTY_REQUIRED", 403, "no audit duty"),
    );
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();

    expect(
      await screen.findByText(/cannot prove who handled the current review round/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve & resolve" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getAllByText(/Independence cannot be verified/).length).toBeGreaterThan(0);
  });

  it("records a disposition through the duty-gated transition endpoint", async () => {
    const next = { ...caseRecord, state: "resolved" as const, allowed_transitions: [] };
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockResolvedValue(
      auditPageWith([
        historyEntry(1, "case.handled", "human_handler"),
        historyEntry(2, "case.submitted_for_review", "human_handler"),
      ]),
    );
    vi.spyOn(ForgePilotClient.prototype, "transitionSecurityCase").mockResolvedValue(next);
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();

    await userEvent.type(
      screen.getByLabelText(/Disposition note/),
      "Credential rotated; minimum context rebuilt.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve & resolve" }));

    await waitFor(() =>
      expect(client.transitionSecurityCase).toHaveBeenCalledWith(
        workspace.id,
        caseRecord.case_id,
        { to: "resolved", note: "Credential rotated; minimum context rebuilt." },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    expect(await screen.findByText(/Disposition recorded/)).toBeTruthy();
  });
});

describe("quarantine access", () => {
  it("requires an explicit grant id and acknowledgement before returning raw context", async () => {
    vi.spyOn(ForgePilotClient.prototype, "grantSecurityQuarantineAccess").mockResolvedValue(grant);
    vi.spyOn(ForgePilotClient.prototype, "viewQuarantinedContext").mockResolvedValue({
      quarantine_id: "q_3c1d",
      content: "sk-live-raw-context",
      viewed_at: new Date().toISOString(),
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_admin", true)}
      />,
    );
    await openCase();

    const section = screen
      .getByRole("heading", { name: "Quarantine" })
      .closest("section") as HTMLElement;
    await userEvent.click(within(section).getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "q_3c1d" }));
    await userEvent.type(within(section).getByLabelText("Grant subject"), "human_handler");
    await userEvent.click(within(section).getByRole("button", { name: "Issue grant" }));

    await waitFor(() =>
      expect(client.grantSecurityQuarantineAccess).toHaveBeenCalledWith(
        workspace.id,
        caseRecord.case_id,
        { quarantine_id: "q_3c1d", subject: "human_handler" },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    const inspect = within(section).getByRole("button", {
      name: "Inspect quarantined context",
    });
    expect(inspect).toHaveProperty("disabled", true);

    await userEvent.click(within(section).getByRole("checkbox"));
    expect(inspect).toHaveProperty("disabled", false);
    expect(screen.queryByText("sk-live-raw-context")).toBeNull();

    await userEvent.click(inspect);
    expect(await screen.findByText("sk-live-raw-context")).toBeTruthy();
    expect(client.viewQuarantinedContext).toHaveBeenCalledWith(
      workspace.id,
      "q_3c1d",
      grant.grant_id,
    );

    await userEvent.click(within(section).getByRole("button", { name: "Clear from screen" }));
    expect(screen.queryByText("sk-live-raw-context")).toBeNull();
  });

  it("surfaces an expired grant as an actionable refusal", async () => {
    vi.spyOn(ForgePilotClient.prototype, "viewQuarantinedContext").mockRejectedValue(
      apiError("QUARANTINE_ACCESS_GRANT_EXPIRED", 410, "expired"),
    );
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openCase();

    const section = screen
      .getByRole("heading", { name: "Quarantine" })
      .closest("section") as HTMLElement;
    await userEvent.type(within(section).getByLabelText(/Inspection grant id/), "qg_old");
    await userEvent.click(within(section).getByRole("checkbox"));
    await userEvent.click(
      within(section).getByRole("button", { name: "Inspect quarantined context" }),
    );

    expect(await screen.findByText(/inspection grant has expired/i)).toBeTruthy();
    expect(screen.getByText(/QUARANTINE_ACCESS_GRANT_EXPIRED/)).toBeTruthy();
  });
});

describe("recovery authorization", () => {
  it("records an approval bound to a destination and then dispatches it once", async () => {
    const approved = approval();
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockResolvedValue(
      auditPageWith([
        historyEntry(1, "case.handled", "human_handler"),
        historyEntry(2, "case.submitted_for_review", "human_handler"),
      ]),
    );
    vi.spyOn(ForgePilotClient.prototype, "approveSecurityRecovery").mockResolvedValue(approved);
    vi.spyOn(ForgePilotClient.prototype, "getSecurityRecoveryApproval").mockResolvedValue({
      ...approved,
      state: "consumed",
    });
    vi.spyOn(ForgePilotClient.prototype, "dispatchSecurityRecovery").mockResolvedValue(
      dispatchFixture,
    );
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();

    const section = screen
      .getByRole("heading", { name: "Recovery authorization" })
      .closest("section") as HTMLElement;
    await userEvent.type(
      within(section).getByLabelText("Destination endpoint id"),
      "ep_anthropic_primary",
    );
    await userEvent.type(
      within(section).getByLabelText("Destination model id"),
      "claude-sonnet-5-5",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Record approval" }));

    await waitFor(() =>
      expect(client.approveSecurityRecovery).toHaveBeenCalledWith(
        workspace.id,
        caseRecord.case_id,
        {
          destination: { endpoint_id: "ep_anthropic_primary", model_id: "claude-sonnet-5-5" },
          ttl_seconds: 900,
        },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );

    await userEvent.type(within(section).getByLabelText("Dispatch worker id"), "worker_1");
    await userEvent.click(within(section).getByRole("checkbox"));
    const dispatch = within(section).getByRole("button", {
      name: "Recheck complete request & dispatch once",
    });
    expect(dispatch).toHaveProperty("disabled", false);
    await userEvent.click(dispatch);

    await waitFor(() =>
      expect(client.dispatchSecurityRecovery).toHaveBeenCalledWith(
        workspace.id,
        approved.authorization_id,
        { worker_id: "worker_1" },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    expect(await screen.findByText("Dispatch outcome: dispatched")).toBeTruthy();
  });

  it("states an expired approval cannot dispatch and offers no bypass", async () => {
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockResolvedValue(
      auditPageWith([
        historyEntry(1, "case.handled", "human_handler"),
        historyEntry(2, "case.submitted_for_review", "human_handler"),
      ]),
    );
    vi.spyOn(ForgePilotClient.prototype, "approveSecurityRecovery").mockResolvedValue(
      approval({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    );
    const dispatch = vi.spyOn(ForgePilotClient.prototype, "dispatchSecurityRecovery");
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();

    const section = screen
      .getByRole("heading", { name: "Recovery authorization" })
      .closest("section") as HTMLElement;
    await userEvent.type(
      within(section).getByLabelText("Destination endpoint id"),
      "ep_anthropic_primary",
    );
    await userEvent.type(
      within(section).getByLabelText("Destination model id"),
      "claude-sonnet-5-5",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Record approval" }));

    expect(
      await screen.findByText(/Expired: this authorization can no longer dispatch/),
    ).toBeTruthy();
    expect(
      within(section).getByRole("button", { name: "Recheck complete request & dispatch once" }),
    ).toHaveProperty("disabled", true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports an unknown provider outcome without claiming the request was not sent", async () => {
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockResolvedValue(
      auditPageWith([
        historyEntry(1, "case.handled", "human_handler"),
        historyEntry(2, "case.submitted_for_review", "human_handler"),
      ]),
    );
    vi.spyOn(ForgePilotClient.prototype, "approveSecurityRecovery").mockResolvedValue(approval());
    vi.spyOn(ForgePilotClient.prototype, "getSecurityRecoveryApproval").mockResolvedValue(
      approval({ state: "consumed" }),
    );
    vi.spyOn(ForgePilotClient.prototype, "dispatchSecurityRecovery").mockResolvedValue({
      ...dispatchFixture,
      outcome: "unknown",
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openCase();

    const section = screen
      .getByRole("heading", { name: "Recovery authorization" })
      .closest("section") as HTMLElement;
    await userEvent.type(
      within(section).getByLabelText("Destination endpoint id"),
      "ep_anthropic_primary",
    );
    await userEvent.type(
      within(section).getByLabelText("Destination model id"),
      "claude-sonnet-5-5",
    );
    await userEvent.click(within(section).getByRole("button", { name: "Record approval" }));
    await userEvent.type(within(section).getByLabelText("Dispatch worker id"), "worker_1");
    await userEvent.click(within(section).getByRole("checkbox"));
    await userEvent.click(
      within(section).getByRole("button", {
        name: "Recheck complete request & dispatch once",
      }),
    );

    expect(await screen.findByText("Dispatch outcome: unknown")).toBeTruthy();
    expect(screen.getByText(/never automatically replayed/)).toBeTruthy();
  });
});

describe("rule corrections", () => {
  it("renders a bounded diff, computed evidence, and version history", async () => {
    const proposed: SecurityRuleRevision = {
      ...ruleRevision,
      version: 3,
      status: "proposed",
      review: null,
      activated_at: null,
      activated_by: null,
      constraints: { min_length: 24, min_shannon_entropy: 4 },
    };
    vi.mocked(ForgePilotClient.prototype.listSecurityRuleRevisions).mockResolvedValue({
      items: [proposed, ruleRevision],
      next_cursor: null,
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openRules();
    await openRule(3);

    expect(screen.getByRole("table")).toBeTruthy();
    const diff = screen.getByRole("table");
    expect(within(diff).getByText("Minimum length")).toBeTruthy();
    expect(within(diff).getByText("24")).toBeTruthy();
    expect(within(diff).getByText("20")).toBeTruthy();
    expect(screen.getByText("Classic sk- project key is still detected.")).toBeTruthy();
    expect(screen.getByText("pass")).toBeTruthy();
    expect(screen.getByText("Version history")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
  });

  it("blocks self-review of a correction the current principal authored", async () => {
    const proposed: SecurityRuleRevision = {
      ...ruleRevision,
      version: 3,
      status: "proposed",
      review: null,
      author_id: "human_handler",
      activated_at: null,
      activated_by: null,
    };
    vi.mocked(ForgePilotClient.prototype.listSecurityRuleRevisions).mockResolvedValue({
      items: [proposed],
      next_cursor: null,
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openRules();
    await openRule(3);

    expect(screen.getByText(/You authored this correction/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record review" })).toBeNull();
  });

  it("records an independent review and an administrator activation", async () => {
    const proposed: SecurityRuleRevision = {
      ...ruleRevision,
      version: 3,
      status: "proposed",
      review: null,
      author_id: "human_handler",
      activated_at: null,
      activated_by: null,
    };
    const approved: SecurityRuleRevision = {
      ...proposed,
      status: "approved",
      review: {
        reviewer_id: "human_reviewer",
        approved: true,
        reason: "Bounded and evidenced.",
        at: new Date().toISOString(),
      },
    };
    vi.mocked(ForgePilotClient.prototype.listSecurityRuleRevisions).mockResolvedValue({
      items: [proposed, ruleRevision],
      next_cursor: null,
    });
    vi.spyOn(ForgePilotClient.prototype, "reviewSecurityRuleCorrection").mockResolvedValue(
      approved,
    );
    vi.spyOn(ForgePilotClient.prototype, "activateSecurityRuleCorrection").mockResolvedValue({
      ...approved,
      status: "activated",
      activated_at: new Date().toISOString(),
      activated_by: "human_admin",
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_reviewer")}
      />,
    );
    await openRules();
    await openRule(3);

    await userEvent.type(screen.getByLabelText("Review reason"), "Bounded and evidenced.");
    await userEvent.click(screen.getByRole("button", { name: "Record review" }));
    await waitFor(() =>
      expect(client.reviewSecurityRuleCorrection).toHaveBeenCalledWith(
        workspace.id,
        proposed.lineage,
        3,
        { decision: "approve", reason: "Bounded and evidenced." },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    expect(await screen.findByText(/Review recorded/)).toBeTruthy();

    // The reviewer is not an administrator: activation stays hidden behind the duty note.
    expect(
      screen.getByText(/Activation and rollback require the enterprise security administrator/),
    ).toBeTruthy();
  });

  it("lets an administrator activate an approved revision and roll back an active lineage", async () => {
    const approved: SecurityRuleRevision = {
      ...ruleRevision,
      version: 3,
      status: "approved",
      review: {
        reviewer_id: "human_reviewer",
        approved: true,
        reason: "Bounded and evidenced.",
        at: new Date().toISOString(),
      },
      activated_at: null,
      activated_by: null,
    };
    vi.mocked(ForgePilotClient.prototype.listSecurityRuleRevisions).mockResolvedValue({
      items: [approved, ruleRevision],
      next_cursor: null,
    });
    vi.spyOn(ForgePilotClient.prototype, "activateSecurityRuleCorrection").mockResolvedValue({
      ...approved,
      status: "activated",
      activated_at: new Date().toISOString(),
      activated_by: "human_admin",
    });
    vi.spyOn(ForgePilotClient.prototype, "rollbackSecurityRuleCorrection").mockResolvedValue({
      ...ruleRevision,
      version: 4,
      kind: "rollback",
      status: "activated",
      rolls_back_version: 2,
    });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_admin", true)}
      />,
    );
    await openRules();
    await openRule(3);

    await userEvent.type(screen.getByLabelText("Activation note"), "Reviewed evidence.");
    await userEvent.click(screen.getByRole("button", { name: "Activate revision" }));
    await waitFor(() =>
      expect(client.activateSecurityRuleCorrection).toHaveBeenCalledWith(
        workspace.id,
        approved.lineage,
        3,
        { note: "Reviewed evidence." },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Roll back active correction" }));
    await waitFor(() =>
      expect(client.rollbackSecurityRuleCorrection).toHaveBeenCalledWith(
        workspace.id,
        approved.lineage,
        {},
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
  });

  it("submits only the bounded correction fields and lets the service compute evidence", async () => {
    const propose = vi
      .spyOn(ForgePilotClient.prototype, "proposeSecurityRuleCorrection")
      .mockResolvedValue({
        ...ruleRevision,
        version: 5,
        status: "proposed",
        review: null,
      });
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openRules();

    await userEvent.click(screen.getByRole("button", { name: "Propose correction" }));
    await userEvent.type(screen.getByLabelText("Detector id"), "openai_key");
    await userEvent.type(screen.getByLabelText("Minimum length"), "24");
    await userEvent.type(screen.getByLabelText("Minimum Shannon entropy"), "4.2");
    await userEvent.type(screen.getByLabelText("Required prefix"), "sk-proj-");
    await userEvent.type(
      screen.getByLabelText(/Reason/),
      "Documentation samples are false positives.",
    );
    fireEvent.change(screen.getByLabelText("Expires at"), {
      target: { value: "2027-02-01T00:00" },
    });
    const proposalForm = screen
      .getByRole("button", { name: "Submit proposal" })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(proposalForm);

    await waitFor(() =>
      expect(client.proposeSecurityRuleCorrection).toHaveBeenCalledWith(
        workspace.id,
        {
          detector_id: "openai_key",
          constraints: {
            min_length: 24,
            min_shannon_entropy: 4.2,
            required_prefix: "sk-proj-",
          },
          reason: "Documentation samples are false positives.",
          expires_at: new Date("2027-02-01T00:00").toISOString(),
        },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    expect(propose.mock.calls[0][1]).not.toHaveProperty("regression_evidence");
    expect(await screen.findByText(/Proposal recorded/)).toBeTruthy();
  });
});

describe("security audit trail", () => {
  async function openAudit(): Promise<void> {
    await userEvent.click(await screen.findByRole("button", { name: "Audit" }));
    await screen.findByRole("heading", { name: "Security audit trail" });
  }

  it("starts with an empty purpose and requires the operator to state one before reading", async () => {
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openAudit();

    const purpose = screen.getByLabelText(/Stated purpose/) as HTMLInputElement;
    expect(purpose.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Read trail" }));
    expect(await screen.findByText(/A non-secret stated purpose is required/)).toBeTruthy();
    expect(client.readSecurityAuditTrail).not.toHaveBeenCalled();

    await userEvent.type(purpose, "Quarterly access review for payments");
    await userEvent.click(screen.getByRole("button", { name: "Read trail" }));
    await waitFor(() =>
      expect(client.readSecurityAuditTrail).toHaveBeenCalledWith(workspace.id, {
        purpose: "Quarterly access review for payments",
      }),
    );
    expect(await screen.findByText("Recovery dispatch attempted")).toBeTruthy();
    expect(screen.getByText("evt_01JA7Y3K9Q")).toBeTruthy();
    expect(screen.getByText("ah1.9d3c8a6f2b1e")).toBeTruthy();
    expect(screen.getByText("recorded")).toBeTruthy();
  });

  it("refuses both read and export without an operator-supplied purpose", async () => {
    const exportAudit = vi.spyOn(ForgePilotClient.prototype, "exportSecurityAuditTrail");
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_admin", true)}
      />,
    );
    await openAudit();

    await userEvent.click(screen.getByRole("button", { name: "Read trail" }));
    expect(await screen.findByText(/A non-secret stated purpose is required/)).toBeTruthy();
    expect(client.readSecurityAuditTrail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Export filtered slice" }));
    expect(await screen.findByText(/A stated purpose is required for an export/)).toBeTruthy();
    expect(exportAudit).not.toHaveBeenCalled();
  });

  it("keeps exports administrator-only and exports only the stated purpose", async () => {
    vi.spyOn(ForgePilotClient.prototype, "exportSecurityAuditTrail").mockResolvedValue({
      exported_at: new Date().toISOString(),
      enterprise_id: workspace.enterprise_id,
      workspace_id: workspace.id,
      event_count: 1,
      entries: auditPage.items,
    });
    const nonAdmin = makeClient();
    const first = render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={nonAdmin}
        session={sessionFor("human_handler")}
      />,
    );
    await openAudit();
    expect(screen.getByRole("button", { name: "Export filtered slice" })).toHaveProperty(
      "disabled",
      true,
    );
    first.unmount();

    const admin = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={admin}
        session={sessionFor("human_admin", true)}
      />,
    );
    await openAudit();
    await userEvent.type(screen.getByLabelText(/Stated purpose/), "Incident INC-42 export");
    const exportButton = screen.getByRole("button", { name: "Export filtered slice" });
    expect(exportButton).toHaveProperty("disabled", false);
    await userEvent.click(exportButton);

    await waitFor(() =>
      expect(admin.exportSecurityAuditTrail).toHaveBeenCalledWith(
        workspace.id,
        { purpose: "Incident INC-42 export" },
        expect.stringContaining("forgepilot-ui-"),
      ),
    );
    expect(await screen.findByText(/Exported 1 events/)).toBeTruthy();
  });

  it("repeats the service's tamper refusal instead of showing unverified data", async () => {
    vi.mocked(ForgePilotClient.prototype.readSecurityAuditTrail).mockRejectedValue(
      apiError("SECURITY_AUDIT_LOG_TAMPERED", 503, "hash chain failed"),
    );
    const client = makeClient();
    render(
      <SecurityWorkbench
        loadWorkspaces={loadWorkspaceDirectory}
        client={client}
        session={sessionFor("human_handler")}
      />,
    );
    await openAudit();
    await userEvent.type(screen.getByLabelText(/Stated purpose/), "Verify trail integrity");
    await userEvent.click(screen.getByRole("button", { name: "Read trail" }));

    expect(await screen.findByText(/The audit hash chain failed verification/)).toBeTruthy();
    expect(screen.getByText(/SECURITY_AUDIT_LOG_TAMPERED/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
