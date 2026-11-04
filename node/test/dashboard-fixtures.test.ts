/**
 * Real-response golden fixtures for the workspace dashboard (DAT-230).
 *
 * Captured from the live HTTP surface with the shared seed scenario, so a
 * frontend can build fixtures without standing up the stack. Only inherently
 * volatile values are normalized: the generated enterprise/workspace/user ids,
 * random audit ids and timestamps. Fields, enums, ordering and messages stay
 * exactly as served.
 *
 * Regenerate with: FORGEPILOT_UPDATE_FIXTURES=1 npm test
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "dashboard-api-v1");

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const AUDIT_ID = /aud_[0-9a-f]{8,}/g;
const REQUEST_ID = /req_[0-9a-f]{8,}/g;

let dsh: DshServerHandle;
let app: AuthApp;

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 120_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.stop();
  }
  await dsh.stop();
});

const VOLATILE_TIME_KEYS = new Set(["as_of", "at", "generated_at", "exported_at"]);

function normalize(
  value: unknown,
  ids: { enterpriseId: string; workspaceId: string; userId: string },
): unknown {
  const walk = (entry: unknown, key: string | null): unknown => {
    if (typeof entry === "string") {
      let out = entry
        .replaceAll(ids.enterpriseId, "ent_fixture")
        .replaceAll(ids.workspaceId, "ws_fixture")
        .replaceAll(ids.userId, "usr_fixture")
        .replace(AUDIT_ID, "aud_fixture")
        .replace(REQUEST_ID, "req_fixture");
      if (key !== null && VOLATILE_TIME_KEYS.has(key) && ISO_TIMESTAMP.test(out)) {
        out = "2099-01-01T00:00:00.000Z";
      }
      return out;
    }
    if (Array.isArray(entry)) {
      return entry.map((item) => walk(item, key));
    }
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([childKey, item]) => [
          childKey,
          walk(item, childKey),
        ]),
      );
    }
    return entry;
  };
  return walk(value, null);
}

function checkFixture(name: string, payload: unknown): void {
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  const fixturePath = path.join(fixtureDir, name);
  if (process.env["FORGEPILOT_UPDATE_FIXTURES"] === "1") {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixturePath, encoded, "utf8");
    return;
  }
  expect(
    readFileSync(fixturePath, "utf8"),
    `fixture ${name} diverged from the live response (regenerate with FORGEPILOT_UPDATE_FIXTURES=1)`,
  ).toBe(encoded);
}

describe("real-response fixtures for the workspace dashboard (DAT-230)", () => {
  test("summary, cost items, issue drilldown and audit trail", async () => {
    const auditFile = path.join(
      mkdtempSync(path.join(tmpdir(), "dashboard-fixture-")),
      "audit.jsonl",
    );
    app = await startAuthApp({
      dsh,
      configOverrides: { dashboardAuditFile: auditFile },
      dashboardSources: seedDashboard,
    });
    const session = await webLogin(app);
    const grant = await fetch(
      `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${app.workspaceId}/members/${session.userId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
        },
        body: JSON.stringify({ role: "owner" }),
      },
    );
    expect(grant.status).toBe(200);
    const headers = cookieSessionHeaders(session);

    const period = new URLSearchParams({
      from: DASHBOARD_FROM,
      to: DASHBOARD_TO,
      timezone: "UTC",
      bucket: "hour",
    });
    const base = `${app.base}/api/v1/workspaces/${app.workspaceId}/dashboard`;
    const ids = {
      enterpriseId: app.enterpriseId,
      workspaceId: app.workspaceId,
      userId: session.userId,
    };

    const summary = await getJson(`${base}/summary?${period.toString()}`, headers);
    expect(summary.status).toBe(200);
    checkFixture("summary.json", normalize(summary.body, ids));

    const costItems = await getJson(`${base}/cost-items?${period.toString()}`, headers);
    expect(costItems.status).toBe(200);
    checkFixture("cost-items.json", normalize(costItems.body, ids));

    const drilldown = await getJson(`${base}/issues/issue-1?${period.toString()}`, headers);
    expect(drilldown.status).toBe(200);
    checkFixture("issue-drilldown.json", normalize(drilldown.body, ids));

    const audit = await getJson(`${base}/audit?${period.toString()}`, headers);
    expect(audit.status).toBe(200);
    checkFixture("audit.json", normalize(audit.body, ids));
  });
});
