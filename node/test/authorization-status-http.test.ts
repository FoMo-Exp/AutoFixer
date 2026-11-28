/**
 * Workspace authorization status over real HTTP (DAT-296, ADR-0011).
 *
 * The operational view must be readable while authority is unverified — that
 * is the state it exists to explain — and it must disclose only scoped,
 * safe facts: build/database/gate/set versions, the caller's own evidence and
 * a denial trend by code. A refusal produced elsewhere on a protected path is
 * visible here; a viewer may not read it; a stranger cannot enumerate it; the
 * evidence survives a process restart because it is the append-only audit.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  CURRENT_SCHEMA_VERSION,
  createProviderAccessRepositories,
  createRepositories,
} from "../src/control-plane/index.js";
import { planningIssue } from "./helpers/collab.js";
import { REPOSITORY_ID } from "./helpers/auth-app.js";

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 180_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

function addMembership(
  app: AuthApp,
  userId: string,
  role: "owner" | "admin" | "member" | "viewer",
) {
  const db = app.orchestrator.controlPlane;
  if (db === undefined) {
    throw new Error("fixture requires the control-plane database");
  }
  createRepositories(db).memberships.create(
    {
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
      actor_id: "usr_seed",
    },
    { user_id: userId, role },
  );
}

function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = body.error;
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

interface StatusBody {
  schema_version: string;
  enterprise_id: string;
  workspace_id: string;
  build: { schema_version: number; database_schema_version: number; mixed_version: boolean };
  rollout: { gate: { state: string }; enforcement: string };
  repository_set: {
    readable: boolean;
    version: number | null;
    repository_count: number | null;
    multi_repository: boolean | null;
    usable: boolean | null;
  };
  caller: {
    evaluated: boolean;
    allowed: boolean;
    code: string | null;
    required_capability: string | null;
    context_schema_version: number | null;
    freshness: { state: string };
    repositories: Array<{ freshness: string }>;
  };
  denials: {
    total: number;
    by_code: Array<{ code: string; count: number }>;
    by_action: Array<{ action: string; count: number }>;
    series: Array<{ bucket_start: string; count: number }>;
  };
}

async function loginAs(app: AuthApp, id: number, login: string): Promise<LoggedInSession> {
  app.provider.profile = { id, login };
  return webLogin(app);
}

describe("workspace authorization status over HTTP (DAT-296)", () => {
  test("an admin sees versions, unverified evidence and the refusals that happened", async () => {
    const app = await startAuthApp({
      dsh,
      repositoryIntegration: true,
      multiRepositoryEnforcement: "complete",
    });
    apps.push(app);
    const owner = await webLogin(app);
    addMembership(app, owner.userId, "owner");
    const headers = cookieSessionHeaders(owner);

    // A protected read is refused because no provider evidence exists yet;
    // the refusal is what the admin then sees in the trend.
    const denied = await getJson(`${app.base}/api/v1/workspaces/${app.workspaceId}/tasks`, headers);
    expect(denied.status).toBe(403);

    const response = await getJson<StatusBody>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/authorization-status`,
      headers,
    );
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toMatchObject({
      schema_version: "1",
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
    });
    expect(body.build).toEqual({
      schema_version: CURRENT_SCHEMA_VERSION,
      database_schema_version: CURRENT_SCHEMA_VERSION,
      mixed_version: false,
    });
    expect(body.rollout.gate.state).toBe("disabled");
    expect(body.rollout.enforcement).toBe("complete");
    expect(body.repository_set).toMatchObject({
      readable: true,
      version: 1,
      repository_count: 1,
      multi_repository: false,
      usable: true,
    });
    expect(body.caller.evaluated).toBe(true);
    expect(body.caller.code).toBe("AUTHORITY_RECHECK_REQUIRED");
    expect(body.caller.context_schema_version).toBe(1);
    expect(body.caller.freshness.state).toBe("unknown");
    expect(body.denials.total).toBeGreaterThanOrEqual(1);
    expect(body.denials.by_code).toContainEqual({
      code: "AUTHORITY_RECHECK_REQUIRED",
      count: expect.any(Number),
    });
    expect(body.denials.by_action).toContainEqual({ action: "read", count: expect.any(Number) });
    expect(body.denials.series.length).toBeGreaterThanOrEqual(1);
    expect(body.denials.series[0]).toMatchObject({ bucket_start: expect.any(String) });

    // No credential, repository URL or content leaks through the evidence.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/token|secret|https?:\/\//i);

    // Evidence is durable: a restart keeps the audit trend and the guard.
    await app.restart();
    const after = await getJson<StatusBody>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/authorization-status`,
      headers,
    );
    expect(after.status).toBe(200);
    expect(after.body.denials.total).toBeGreaterThanOrEqual(body.denials.total);
    expect(after.body.build.database_schema_version).toBe(CURRENT_SCHEMA_VERSION);
  }, 120_000);

  test("a viewer cannot read the operator view, and a stranger cannot enumerate it", async () => {
    const app = await startAuthApp({
      dsh,
      repositoryIntegration: true,
      multiRepositoryEnforcement: "complete",
    });
    apps.push(app);
    const viewer = await loginAs(app, 2002, "viewer");
    addMembership(app, viewer.userId, "viewer");
    const viewerStatus = await getJson(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/authorization-status`,
      cookieSessionHeaders(viewer),
    );
    expect(viewerStatus.status).toBe(403);
    const refusal = errorCodeOf(viewerStatus.body);
    expect(refusal).toBe("WORKSPACE_ROLE_REQUIRED");

    const stranger = await loginAs(app, 3003, "stranger");
    const strangerStatus = await getJson(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/authorization-status`,
      cookieSessionHeaders(stranger),
    );
    expect(strangerStatus.status).toBe(404);
  }, 120_000);

  test("the denial window parameter is validated", async () => {
    const app = await startAuthApp({ dsh, repositoryIntegration: true });
    apps.push(app);
    const owner = await webLogin(app);
    addMembership(app, owner.userId, "owner");
    const response = await getJson(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/authorization-status?window_minutes=0`,
      cookieSessionHeaders(owner),
    );
    expect(response.status).toBe(400);
  }, 120_000);
});

describe("a refusal from the second delivery decision is audited (DAT-296)", () => {
  test("the collab delivery decision appends exactly one denial when authority changes between require and check", async () => {
    const app = await startAuthApp({
      dsh,
      repositoryIntegration: true,
      multiRepositoryEnforcement: "complete",
    });
    apps.push(app);
    const owner = await webLogin(app);
    addMembership(app, owner.userId, "owner");

    const db = app.orchestrator.controlPlane;
    if (db === undefined) {
      throw new Error("fixture requires the control-plane database");
    }
    const integration = app.integration;
    const authority = app.orchestrator.providerAuthority;
    const machine = app.orchestrator.collaboration;
    if (integration === undefined || authority === undefined || machine === undefined) {
      throw new Error("fixture requires the integration, authority and collaboration machine");
    }
    const scope = {
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
      actor_id: "usr_seed",
    };
    const access = createProviderAccessRepositories(db);
    access.roster.applySnapshot(scope, integration.id, {
      roles: [
        {
          subject: "1001",
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "admin",
          authority_ref: REPOSITORY_ID,
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
    });
    const issue = planningIssue(machine, {
      workspace: { enterprise_id: app.enterpriseId, workspace_id: app.workspaceId },
      repository: {
        repository_id: REPOSITORY_ID,
        url: "https://github.com/FoMo-Exp/AutoFixer.git",
        base_ref: "main",
        base_sha: "52081eaddca099967fd8be13b3060337fde50d3f",
      },
    });

    // The request-boundary `require` allows this delivery; then authority is
    // aged before the second, independent delivery decision. That refusal is
    // the decision QA flagged: it must append its own denial row.
    const originalRequire = authority.require.bind(authority);
    let flipped = false;
    authority.require = (userId, action, workspaceId, requestScope) => {
      originalRequire(userId, action, workspaceId, requestScope);
      if (action === "delivery" && !flipped) {
        flipped = true;
        access.roster.setAuthorityState(
          scope,
          integration.id,
          "1001",
          "stale",
          new Date().toISOString(),
        );
      }
    };

    const response = await postJson(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/issues/${issue.issue_id}/deliveries`,
      {},
      cookieSessionHeaders(owner),
    );
    // The handler refuses the unsigned delivery request; the status is not the
    // point — the audited refusal of the second decision is.
    expect(response.status).not.toBe(200);

    const rows = db
      .prepare(
        `SELECT details FROM auth_audit
          WHERE event = 'authorization.denied' AND workspace_id = ? AND action = 'delivery'`,
      )
      .all(app.workspaceId) as unknown as Array<{ details: string }>;
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0]!.details) as Record<string, unknown>;
    expect(details).toMatchObject({
      outcome: "denied",
      action: "delivery",
      code: "AUTHORITY_RECHECK_REQUIRED",
      repository_set_version: 1,
      target: { repository_id: REPOSITORY_ID },
    });
  }, 120_000);
});
