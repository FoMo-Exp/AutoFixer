import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import type { AuthAuditRepository } from "../src/control-plane/identity-repositories.js";
import type { ProviderAccessRepositories } from "../src/control-plane/index.js";
import { createServiceIntegrationService } from "../src/api/service-integration-service.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import type { ServiceIntegrationService } from "../src/api/service-integration-service.js";
import { ApiError } from "../src/api/errors.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import {
  BOOTSTRAP_TOKEN,
  REPOSITORY_ID,
  cookieSessionHeaders,
  startAuthApp,
  webLogin,
} from "./helpers/auth-app.js";

/**
 * Administrator-controlled service integration surface (DAT-267).
 *
 * The HTTP cases exercise the real orchestrator: routing, administrator
 * authority, workspace-scoped binding resolution, replay/concurrency, and
 * fail-closed behavior after deactivation. The service-level cases cover the
 * boundary the API cannot show: an audit failure rolls the write back, and a
 * row written through the surface survives a process restart.
 */

const SUBJECT = "1001"; // fake provider profile id of the default login
const SOURCE_REF = "svc-source-1";
const CHECKOUT_REF = "svc-checkout-1";
const DELIVERY_REF = "svc-delivery-1";
const ALT_DELIVERY_REF = "svc-delivery-2";
const TEST_CREDENTIALS = createStaticServiceCredentialStore({
  [SOURCE_REF]: "source-secret-value",
  [CHECKOUT_REF]: "checkout-secret-value",
  [DELIVERY_REF]: "delivery-secret-value",
  [ALT_DELIVERY_REF]: "alternate-delivery-secret-value",
});

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

async function newApp(): Promise<AuthApp> {
  const app = await startAuthApp({ dsh, providerServiceCredentials: TEST_CREDENTIALS });
  apps.push(app);
  return app;
}

function routeOf(app: AuthApp, workspaceId = app.workspaceId): string {
  return `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${workspaceId}/service-integration`;
}

function bootstrapHeaders(): Record<string, string> {
  return { "X-Bootstrap-Token": BOOTSTRAP_TOKEN };
}

interface HttpResult {
  status: number;
  text: string;
  body: Record<string, unknown> | undefined;
}

async function request(
  app: AuthApp,
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
  workspaceId?: string,
): Promise<HttpResult> {
  const response = await fetch(routeOf(app, workspaceId), {
    method,
    headers: {
      ...bootstrapHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, body: parsed };
}

function errorCode(result: HttpResult): string | undefined {
  const error = result.body?.["error"] as { code?: string } | undefined;
  return error?.code;
}

function accessOf(app: AuthApp): ProviderAccessRepositories {
  const db = app.orchestrator.controlPlane;
  if (db === undefined) {
    throw new Error("control plane missing");
  }
  return createProviderAccessRepositories(db);
}

function integrationRows(app: AuthApp): number {
  const db = app.orchestrator.controlPlane;
  if (db === undefined) {
    throw new Error("control plane missing");
  }
  return createProviderAccessRepositories(db).integrations.listByWorkspace({
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "test",
  }).length;
}

async function grantMembership(app: AuthApp, userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${app.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...bootstrapHeaders(),
      },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

/** Verify the login's provider subject so the request gate has authority facts. */
function verifyLoginAuthority(app: AuthApp, userId: string, integrationId: string): void {
  const db = app.orchestrator.controlPlane;
  if (db === undefined) {
    throw new Error("control plane missing");
  }
  createProviderAccessRepositories(db).roster.applySnapshot(
    { enterprise_id: app.enterpriseId, workspace_id: app.workspaceId, actor_id: "test" },
    integrationId,
    {
      roles: [
        {
          subject: SUBJECT,
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "admin",
          authority_ref: REPOSITORY_ID,
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
      subject_users: { [SUBJECT]: userId },
    },
  );
}

async function taskListStatus(app: AuthApp, session: LoggedInSession): Promise<HttpResult> {
  const response = await fetch(`${app.base}/api/v1/tasks`, {
    headers: { Cookie: `fp_session=${session.session}` },
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, body: parsed };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe("service integration administrator surface", () => {
  test("initializes from the workspace binding, replays identically, and deactivates", async () => {
    const app = await newApp();
    const input = {
      source_credential_ref: SOURCE_REF,
      checkout_credential_ref: CHECKOUT_REF,
      delivery_credential_ref: DELIVERY_REF,
    };

    const created = await request(app, "PUT", input);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
      provider_instance_id: app.providerInstanceId,
      repository_id: REPOSITORY_ID,
      repository_name: "FoMo-Exp/AutoFixer",
      install_status: "active",
      permission_visibility: "full",
      credentials: { source: true, checkout: true, delivery: true },
      version: 1,
    });
    // The response reports presence, never the references or any secret.
    expect(created.text).not.toContain(SOURCE_REF);
    expect(created.text).not.toContain(CHECKOUT_REF);
    expect(created.text).not.toContain(DELIVERY_REF);

    const integrationId = created.body?.["id"] as string;
    const read = await request(app, "GET");
    expect(read.status).toBe(200);
    expect(read.body?.["id"]).toBe(integrationId);

    // Replay: identical PUT returns the same row and does not bump its version.
    const replay = await request(app, "PUT", input);
    expect(replay.status).toBe(200);
    expect(replay.body?.["id"]).toBe(integrationId);
    expect(replay.body?.["version"]).toBe(1);

    // A retry can never silently replace installed credentials.
    const conflicting = await request(app, "PUT", {
      ...input,
      delivery_credential_ref: ALT_DELIVERY_REF,
    });
    expect(conflicting.status).toBe(409);
    expect(errorCode(conflicting)).toBe("SERVICE_INTEGRATION_EXISTS");

    // Deactivation is idempotent and leaves the row as the fail-closed marker.
    expect((await request(app, "DELETE")).status).toBe(204);
    expect((await request(app, "DELETE")).status).toBe(204);
    expect((await request(app, "GET")).status).toBe(404);

    const rows = accessOf(app).integrations.listByWorkspace({
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
      actor_id: "test",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install_status).toBe("uninstalled");

    // Re-initialization is possible once the uniqueness guard is released.
    const reinstalled = await request(app, "PUT", input);
    expect(reinstalled.status).toBe(201);
    expect(reinstalled.body?.["id"]).not.toBe(integrationId);
  });

  test("concurrent identical initialization produces exactly one active row", async () => {
    const app = await newApp();
    const input = { source_credential_ref: SOURCE_REF, delivery_credential_ref: DELIVERY_REF };

    const results = await Promise.all([
      request(app, "PUT", input),
      request(app, "PUT", input),
      request(app, "PUT", input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((result) => result.body?.["id"])).size).toBe(1);
    expect(integrationRows(app)).toBe(1);
  });

  test("rejects missing, malformed, and secret-shaped references without echoing them", async () => {
    const app = await newApp();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    expect((await request(app, "PUT", {})).status).toBe(400);
    expect((await request(app, "PUT", { source_credential_ref: "" })).status).toBe(400);
    expect((await request(app, "PUT", { source_credential_ref: "has space" })).status).toBe(400);

    const secretShaped = await request(app, "PUT", { source_credential_ref: secret });
    expect(secretShaped.status).toBe(400);
    expect(secretShaped.text).not.toContain(secret);

    // The binding is server-resolved; a client cannot supply or override it.
    const unknownRef = await request(app, "PUT", { source_credential_ref: "svc-not-provisioned" });
    expect(unknownRef.status).toBe(400);
    expect(unknownRef.text).not.toContain("svc-not-provisioned");

    const bindingOverride = await request(app, "PUT", {
      source_credential_ref: SOURCE_REF,
      repository_id: "github:attacker/other",
      provider_instance_id: "pir_attacker",
      permission_visibility: "full",
    });
    expect(bindingOverride.status).toBe(400);
    expect(integrationRows(app)).toBe(0);
  });

  test("denies non-administrators and keeps workspaces isolated", async () => {
    const app = await newApp();
    const member = await webLogin(app);
    const sessionHeaders = { ...cookieSessionHeaders(member), "Content-Type": "application/json" };

    const deniedPut = await fetch(routeOf(app), {
      method: "PUT",
      headers: sessionHeaders,
      body: JSON.stringify({ source_credential_ref: SOURCE_REF }),
    });
    expect(deniedPut.status).toBe(403);
    const deniedGet = await fetch(routeOf(app), {
      headers: { Cookie: `fp_session=${member.session}` },
    });
    expect(deniedGet.status).toBe(403);

    expect((await request(app, "PUT", { source_credential_ref: SOURCE_REF })).status).toBe(201);

    const db = app.orchestrator.controlPlane;
    if (db === undefined) {
      throw new Error("control plane missing");
    }
    const other = createRepositories(db).workspaces.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_test_operator" },
      {
        name: "Other",
        repository_id: "github:FoMo-Exp/OtherDir",
        provider_instance_id: app.providerInstanceId,
      },
    );

    // Another workspace has no integration, and binding it names its own repo.
    expect((await request(app, "GET", undefined, other.id)).status).toBe(404);
    const otherCreated = await request(app, "PUT", { source_credential_ref: SOURCE_REF }, other.id);
    expect(otherCreated.status).toBe(201);
    expect(otherCreated.body?.["repository_id"]).toBe("github:FoMo-Exp/OtherDir");

    // A foreign enterprise locator is indistinguishable from unknown.
    const foreign = await fetch(
      `${app.base}/api/v1/admin/enterprises/ent_foreign/workspaces/${app.workspaceId}/service-integration`,
      { headers: bootstrapHeaders() },
    );
    expect(foreign.status).toBe(404);
  });

  test("deactivation fails closed while the administrator surface stays reachable", async () => {
    const app = await newApp();
    const member = await webLogin(app);
    expect(await grantMembership(app, member.userId, "member")).toBe(200);

    const created = await request(app, "PUT", {
      source_credential_ref: SOURCE_REF,
      checkout_credential_ref: CHECKOUT_REF,
      delivery_credential_ref: DELIVERY_REF,
    });
    expect(created.status).toBe(201);
    verifyLoginAuthority(app, member.userId, created.body?.["id"] as string);

    expect((await taskListStatus(app, member)).status).toBe(200);

    expect((await request(app, "DELETE")).status).toBe(204);

    const afterDeactivation = await taskListStatus(app, member);
    expect(afterDeactivation.status).toBe(403);
    expect(errorCode(afterDeactivation)).toBe("AUTHORITY_RECHECK_REQUIRED");

    // The administrator surface itself is not behind the authority gate.
    expect((await request(app, "GET")).status).toBe(404);
    expect((await request(app, "PUT", { source_credential_ref: SOURCE_REF })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Service boundary: audit blocking and restart persistence
// ---------------------------------------------------------------------------

interface Fixture {
  db: ControlPlaneDb;
  enterpriseId: string;
  providerInstanceId: string;
  workspaceId: string;
  service: ServiceIntegrationService;
  access: ProviderAccessRepositories;
  audit: AuthAuditRepository;
}

let seedCounter = 0;

function seedFixture(dbPath?: string): Fixture {
  seedCounter += 1;
  const db = openControlPlaneDb(dbPath !== undefined ? { path: dbPath } : {});
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Integration Enterprise",
    enterprise_slug: `integration-enterprise-${seedCounter}`,
    admin_user_id: "usr_seed",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: REPOSITORY_ID,
    provider_instance_id: provider.id,
  });
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const access = createProviderAccessRepositories(db);
  const service = createServiceIntegrationService({
    db,
    enterpriseId: enterprise.id,
    workspaces: repos.workspaces,
    providerInstances: repos.providerInstances,
    enterpriseRoles: identity.enterpriseRoles,
    integrations: access.integrations,
    credentials: TEST_CREDENTIALS,
    audit: identity.authAudit,
  });
  return {
    db,
    enterpriseId: enterprise.id,
    providerInstanceId: provider.id,
    workspaceId: workspace.id,
    service,
    access,
    audit: identity.authAudit,
  };
}

const INPUT = {
  source_credential_ref: SOURCE_REF,
  checkout_credential_ref: CHECKOUT_REF,
  delivery_credential_ref: DELIVERY_REF,
};

describe("service integration audit and persistence boundary", () => {
  test("an audit write failure rolls the mutation back", () => {
    const fixture = seedFixture();
    const brokenAudit: Pick<AuthAuditRepository, "append"> = {
      append() {
        throw new Error("audit store unavailable");
      },
    };
    const service = createServiceIntegrationService({
      db: fixture.db,
      enterpriseId: fixture.enterpriseId,
      workspaces: createRepositories(fixture.db).workspaces,
      providerInstances: createRepositories(fixture.db).providerInstances,
      enterpriseRoles: createIdentityRepositories(fixture.db).enterpriseRoles,
      integrations: fixture.access.integrations,
      credentials: TEST_CREDENTIALS,
      audit: brokenAudit,
    });

    let failure: unknown;
    try {
      service.initialize({ kind: "deployment" }, fixture.enterpriseId, fixture.workspaceId, INPUT);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("SERVICE_INTEGRATION_AUDIT_UNAVAILABLE");
    expect((failure as ApiError).status).toBe(503);

    expect(
      fixture.access.integrations.listByWorkspace({
        enterprise_id: fixture.enterpriseId,
        workspace_id: fixture.workspaceId,
        actor_id: "test",
      }),
    ).toHaveLength(0);
    fixture.db.close();
  });

  test("an audit failure during deactivation leaves the integration active", () => {
    const fixture = seedFixture();
    const created = fixture.service.initialize(
      { kind: "deployment" },
      fixture.enterpriseId,
      fixture.workspaceId,
      INPUT,
    );
    const brokenAudit: Pick<AuthAuditRepository, "append"> = {
      append() {
        throw new Error("audit store unavailable");
      },
    };
    const service = createServiceIntegrationService({
      db: fixture.db,
      enterpriseId: fixture.enterpriseId,
      workspaces: createRepositories(fixture.db).workspaces,
      providerInstances: createRepositories(fixture.db).providerInstances,
      enterpriseRoles: createIdentityRepositories(fixture.db).enterpriseRoles,
      integrations: fixture.access.integrations,
      credentials: TEST_CREDENTIALS,
      audit: brokenAudit,
    });

    let failure: unknown;
    try {
      service.deactivate({ kind: "deployment" }, fixture.enterpriseId, fixture.workspaceId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("SERVICE_INTEGRATION_AUDIT_UNAVAILABLE");

    const read = service.get({ kind: "deployment" }, fixture.enterpriseId, fixture.workspaceId);
    expect(read.id).toBe(created.integration.id);
    expect(read.install_status).toBe("active");
    fixture.db.close();
  });

  test("audit details and the view never carry credential references or secrets", () => {
    const fixture = seedFixture();
    fixture.service.initialize(
      { kind: "deployment" },
      fixture.enterpriseId,
      fixture.workspaceId,
      INPUT,
    );
    const record = fixture.audit.list({ event: "service_integration.initialized" })[0];
    expect(record).toBeDefined();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(SOURCE_REF);
    expect(serialized).not.toContain(CHECKOUT_REF);
    expect(serialized).not.toContain(DELIVERY_REF);
    expect(record?.details).toMatchObject({
      repository_id: REPOSITORY_ID,
      permission_visibility: "full",
      credentials: { source: true, checkout: true, delivery: true },
    });
    fixture.db.close();
  });

  test("a surface-created integration survives reopening the database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "autofixer-integration-"));
    const dbPath = path.join(dir, "control.sqlite");
    try {
      const first = seedFixture(dbPath);
      const created = first.service.initialize(
        { kind: "deployment" },
        first.enterpriseId,
        first.workspaceId,
        INPUT,
      );
      first.db.close();

      // Re-open exactly as a restarted process would.
      const reopened = openControlPlaneDb({ path: dbPath });
      const access = createProviderAccessRepositories(reopened);
      const rows = access.integrations.listByWorkspace({
        enterprise_id: first.enterpriseId,
        workspace_id: first.workspaceId,
        actor_id: "test",
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(created.integration.id);
      expect(rows[0]?.install_status).toBe("active");
      expect(rows[0]?.source_credential_ref).toBe(SOURCE_REF);
      expect(rows[0]?.delivery_credential_ref).toBe(DELIVERY_REF);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
