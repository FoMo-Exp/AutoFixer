/**
 * Dashboard HTTP boundary tests (DAT-230).
 *
 * The service tests cover the read model; these cover the surface that makes
 * it safe: a session and live membership decide the scope, a substituted
 * workspace is a 404, financial and audit reads are owner/admin only, content
 * and quarantine are refused with their own codes, and every denial leaves an
 * audit entry with zero records.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DashboardSummary } from "../src/dashboard/index.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  cookieSessionHeaders,
  startAuthApp,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp } from "./helpers/auth-app.js";
import { DASHBOARD_FROM, DASHBOARD_TO, seedDashboard } from "./helpers/dashboard-fixtures.js";

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 120_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

async function startDashboardApp(): Promise<AuthApp> {
  const auditFile = path.join(mkdtempSync(path.join(tmpdir(), "dashboard-audit-")), "audit.jsonl");
  const app = await startAuthApp({
    dsh,
    configOverrides: { dashboardAuditFile: auditFile },
    dashboardSources: seedDashboard,
  });
  apps.push(app);
  return app;
}

async function grant(
  app: AuthApp,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<void> {
  const response = await fetch(
    `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ role }),
    },
  );
  expect(response.status).toBe(200);
}

function dashboardUrl(app: AuthApp, leaf: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams({
    from: DASHBOARD_FROM,
    to: DASHBOARD_TO,
    timezone: "UTC",
    bucket: "hour",
    ...query,
  });
  return `${app.base}/api/v1/workspaces/${app.workspaceId}/dashboard/${leaf}?${search.toString()}`;
}

describe("dashboard HTTP surface authorization", () => {
  test("requires a session", async () => {
    const app = await startDashboardApp();
    const response = await getJson(dashboardUrl(app, "summary"));
    expect(response.status).toBe(401);
  });

  test("an owner reads a workspace-scoped summary and the audit trail", async () => {
    const app = await startDashboardApp();
    const session = await webLogin(app);
    await grant(app, app.workspaceId, session.userId, "owner");
    const headers = cookieSessionHeaders(session);

    const summary = await getJson<DashboardSummary>(
      dashboardUrl(app, "summary", { breakdown: "task" }),
      headers,
    );
    expect(summary.status).toBe(200);
    expect(summary.body.workspace_id).toBe(app.workspaceId);
    expect(summary.body.enterprise_id).toBe(app.enterpriseId);
    expect(summary.body.access).toEqual({
      financial: "granted",
      content: "separate_authorization_required",
      quarantine: "separate_authorization_required",
    });
    expect(summary.body.totals.requests).toEqual({
      status: "ok",
      source: "invocation_ledger",
      value: 1,
    });
    expect(summary.body.totals.cost.status).toBe("ok");
    expect(summary.body.breakdown.rows[0]?.key).toBe("issue-1");
    // The fixture's newest record predates the period end by more than the
    // default hour, so the source is honestly stale rather than "ok".
    expect(
      summary.body.sources.find((source) => source.source === "invocation_ledger"),
    ).toMatchObject({
      status: "stale",
      record_count: 1,
    });

    const costItems = await getJson<{ items: unknown[]; ledger_lookup: string }>(
      dashboardUrl(app, "cost-items"),
      headers,
    );
    expect(costItems.status).toBe(200);
    expect(costItems.body.ledger_lookup).toBe("ok");
    expect(costItems.body.items).toHaveLength(1);

    const audit = await getJson<{ items: Array<{ resource: string; record_count: number }> }>(
      dashboardUrl(app, "audit"),
      headers,
    );
    expect(audit.status).toBe(200);
    expect(audit.body.items.map((entry) => entry.resource)).toEqual(
      expect.arrayContaining(["summary", "cost_items"]),
    );
  });

  test("export is an attachment and is audited as its own operation", async () => {
    const app = await startDashboardApp();
    const session = await webLogin(app);
    await grant(app, app.workspaceId, session.userId, "owner");
    const headers = cookieSessionHeaders(session);

    const response = await fetch(dashboardUrl(app, "export"), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="dashboard-export.json"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      cost_items_truncated: boolean;
      summary: DashboardSummary;
    };
    expect(body.cost_items_truncated).toBe(false);
    expect(body.summary.workspace_id).toBe(app.workspaceId);

    const audit = await getJson<{ items: Array<{ operation: string; resource: string }> }>(
      dashboardUrl(app, "audit", { operation: "export" }),
      headers,
    );
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({ operation: "export", resource: "export" });
  });

  test("a member gets restricted financial sections and is denied exports", async () => {
    const app = await startDashboardApp();
    const member = await webLogin(app);
    await grant(app, app.workspaceId, member.userId, "member");
    const headers = cookieSessionHeaders(member);

    const summary = await getJson<DashboardSummary>(dashboardUrl(app, "summary"), headers);
    expect(summary.status).toBe(200);
    expect(summary.body.access.financial).toBe("restricted");
    expect(summary.body.totals.cost.status).toBe("restricted");
    expect(summary.body.totals.cost.lines).toBeNull();
    expect(summary.body.totals.budget.status).toBe("restricted");
    // Operational data stays readable.
    expect(summary.body.totals.requests.value).toBe(1);

    const costItems = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "cost-items"),
      headers,
    );
    expect(costItems.status).toBe(403);
    expect(costItems.body.error.code).toBe("FINANCIAL_ACCESS_DENIED");

    const exportResponse = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "export"),
      headers,
    );
    expect(exportResponse.status).toBe(403);
    expect(exportResponse.body.error.code).toBe("FINANCIAL_ACCESS_DENIED");

    const audit = await getJson<{ error: { code: string } }>(dashboardUrl(app, "audit"), headers);
    expect(audit.status).toBe(403);
    expect(audit.body.error.code).toBe("AUDIT_ACCESS_DENIED");

    // Denials leave evidence. A separate owner account reads the trail (the
    // member's role cannot be promoted in place by this surface).
    app.provider.profile = {
      id: 2002,
      login: "owner-user",
      name: "Owner User",
      email: "owner@example.com",
    };
    const owner = await webLogin(app);
    await grant(app, app.workspaceId, owner.userId, "owner");
    const ownerAudit = await getJson<{
      items: Array<{ resource: string; record_count: number; role: string }>;
    }>(dashboardUrl(app, "audit"), cookieSessionHeaders(owner));
    expect(ownerAudit.status).toBe(200);
    const denied = ownerAudit.body.items.filter(
      (entry) => entry.role === "member" && entry.record_count === 0,
    );
    expect(denied.map((entry) => entry.resource)).toEqual(
      expect.arrayContaining(["cost_items", "export"]),
    );
  });

  test("another workspace is indistinguishable from a missing one", async () => {
    const app = await startDashboardApp();
    const session = await webLogin(app);
    await grant(app, app.workspaceId, session.userId, "owner");
    const headers = cookieSessionHeaders(session);

    const response = await getJson<{ error: { code: string } }>(
      `${app.base}/api/v1/workspaces/ws_other/dashboard/summary?from=${DASHBOARD_FROM}&to=${DASHBOARD_TO}`,
      headers,
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  test("content, quarantine and scope claims are refused with their own codes", async () => {
    const app = await startDashboardApp();
    const session = await webLogin(app);
    await grant(app, app.workspaceId, session.userId, "owner");
    const headers = cookieSessionHeaders(session);

    const contentSecret = "sk-live-prompt-content-must-not-persist";
    const quarantineSecret = "quarantined-artifact-must-not-persist";
    const unknownSecret = "unknown-parameter-value-must-not-persist";

    const content = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "summary", { include_content: contentSecret }),
      headers,
    );
    expect(content.status).toBe(403);
    expect(content.body.error.code).toBe("CONTENT_ACCESS_DENIED");

    const quarantine = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "summary", { include_quarantine: quarantineSecret }),
      headers,
    );
    expect(quarantine.status).toBe(403);
    expect(quarantine.body.error.code).toBe("QUARANTINE_ACCESS_DENIED");

    const scopeClaim = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "summary", { workspace_id: "ws_other" }),
      headers,
    );
    expect(scopeClaim.status).toBe(400);
    expect(scopeClaim.body.error.code).toBe("INVALID_REQUEST");

    const unknown = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "summary", { group_by: unknownSecret }),
      headers,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");

    const badLimit = await getJson<{ error: { code: string } }>(
      dashboardUrl(app, "cost-items", { limit: "501" }),
      headers,
    );
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.code).toBe("LIMIT_OUT_OF_RANGE");

    // A path locator is audited metadata too, so free-form caller text is
    // rejected before any audit record can hold it.
    const issueSecret = "payload~prompt~secret";
    const badIssue = await getJson<{ error: { code: string } }>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/dashboard/issues/${issueSecret}?from=${DASHBOARD_FROM}&to=${DASHBOARD_TO}`,
      headers,
    );
    expect(badIssue.status).toBe(400);
    expect(badIssue.body.error.code).toBe("INVALID_REQUEST");

    // Denials are audited, but never with caller-supplied values: a content
    // probe must not write its payload into the audit trail it is denied from.
    const audit = await getJson<{
      items: Array<{
        resource: string;
        issue_id: string | null;
        record_count: number;
        query: Record<string, string | number | null>;
      }>;
    }>(dashboardUrl(app, "audit"), headers);
    expect(audit.status).toBe(200);
    const serialized = JSON.stringify(audit.body.items);
    expect(serialized).not.toContain(contentSecret);
    expect(serialized).not.toContain(quarantineSecret);
    expect(serialized).not.toContain(unknownSecret);
    expect(serialized).not.toContain(issueSecret);

    const deniedContent = audit.body.items.find(
      (entry) => entry.query["denial_code"] === "CONTENT_ACCESS_DENIED",
    );
    expect(deniedContent).toMatchObject({
      resource: "summary",
      record_count: 0,
      query: {
        denial_code: "CONTENT_ACCESS_DENIED",
        parameter_names: "bucket,from,include_content,timezone,to",
      },
    });
    const deniedQuarantine = audit.body.items.find(
      (entry) => entry.query["denial_code"] === "QUARANTINE_ACCESS_DENIED",
    );
    expect(deniedQuarantine?.query).toEqual({
      denial_code: "QUARANTINE_ACCESS_DENIED",
      parameter_names: "bucket,from,include_quarantine,timezone,to",
    });
    // An unknown parameter contributes no name at all, because a name is
    // caller-supplied text too.
    const deniedUnknown = audit.body.items.find(
      (entry) => entry.resource === "summary" && entry.query["denial_code"] === "INVALID_REQUEST",
    );
    expect(deniedUnknown?.query).toEqual({
      denial_code: "INVALID_REQUEST",
      parameter_names: "bucket,from,timezone,to",
    });
    const deniedScopeClaim = audit.body.items.find((entry) =>
      String(entry.query["parameter_names"]).includes("workspace_id"),
    );
    expect(deniedScopeClaim?.query).toEqual({
      denial_code: "INVALID_REQUEST",
      parameter_names: "bucket,from,timezone,to,workspace_id",
    });
    expect(serialized).not.toContain("group_by");

    // The invalid path locator is a refusal like any other: it is audited,
    // with the rejected value itself omitted.
    const deniedIssue = audit.body.items.find((entry) => entry.resource === "issue_drilldown");
    expect(deniedIssue).toMatchObject({
      resource: "issue_drilldown",
      issue_id: null,
      record_count: 0,
      query: { denial_code: "INVALID_REQUEST", parameter_names: "from,to" },
    });
  });

  test("a non-GET request has no dashboard route", async () => {
    const app = await startDashboardApp();
    const session = await webLogin(app);
    await grant(app, app.workspaceId, session.userId, "owner");
    const headers = cookieSessionHeaders(session);

    const response = await fetch(dashboardUrl(app, "summary"), { method: "POST", headers });
    expect(response.status).toBe(404);
  });
});
