import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, AuthAppOptions, LoggedInSession } from "./helpers/auth-app.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  ProviderAccessRepositories,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import type { SecurityDuty, SecurityDutyDirectory } from "../src/security/index.js";

/**
 * DAT-278: the eight-module capability projection over the production HTTP
 * surface, alongside the routes that must actually enforce it. These tests use
 * real sessions and memberships, real provider roster rows and real memory
 * rows — a projection that says "denied" is checked against the request, and
 * a granted action is checked to work.
 */

const REPOSITORY_ID = "github:FoMo-Exp/AutoFixer";
const SUBJECT = "1001";
const BOOTSTRAP = "test-bootstrap-token-0123456789abcdef0123456789abcdef";

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

async function app(options: Partial<AuthAppOptions> = {}): Promise<AuthApp> {
  const created = await startAuthApp({ dsh, ...options });
  apps.push(created);
  return created;
}

function db(authApp: AuthApp): ControlPlaneDb {
  const value = authApp.orchestrator.controlPlane;
  if (value === undefined) {
    throw new Error("control plane missing");
  }
  return value;
}

function scope(authApp: AuthApp): WorkspaceScope {
  return {
    enterprise_id: authApp.enterpriseId,
    workspace_id: authApp.workspaceId,
    actor_id: "usr_seed",
  };
}

async function grantMembership(authApp: AuthApp, userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Bootstrap-Token": BOOTSTRAP },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

async function setRole(authApp: AuthApp, userId: string, role: string): Promise<void> {
  const repos = createRepositories(db(authApp));
  const workspaceScope = scope(authApp);
  const existing = repos.memberships.getByUser(workspaceScope, userId);
  if (existing === undefined) {
    repos.memberships.create(workspaceScope, { user_id: userId, role: role as never });
    return;
  }
  repos.memberships.updateRole(workspaceScope, existing.id, role as never, existing.version);
}

function installIntegration(
  authApp: AuthApp,
  userId: string,
  options: { providerRole?: string; permissionVisibility?: "full" | "partial" | "none" } = {},
): { access: ProviderAccessRepositories; integrationId: string } {
  const access = createProviderAccessRepositories(db(authApp));
  const workspaceScope = scope(authApp);
  const existing = access.integrations.listByWorkspace(workspaceScope);
  if (existing.length > 0) {
    throw new Error("workspace already has an integration");
  }
  const integration = access.integrations.create(workspaceScope, {
    provider_instance_id: authApp.providerInstanceId,
    repository_id: REPOSITORY_ID,
    repository_name: "FoMo-Exp/AutoFixer",
    source_credential_ref: "svc-source-1",
    checkout_credential_ref: "svc-checkout-1",
    delivery_credential_ref: "svc-delivery-1",
    permission_visibility: options.permissionVisibility ?? "full",
    actor_id: "usr_test_operator",
  });
  access.roster.applySnapshot(workspaceScope, integration.id, {
    roles: [
      {
        subject: SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: options.providerRole ?? "admin",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
    subject_users: { [SUBJECT]: userId },
  });
  authApp.orchestrator.providerAuthority?.epoch.bump();
  return { access, integrationId: integration.id };
}

interface ModuleAction {
  allowed: boolean;
  required: string;
  reason?: string;
}

interface ModuleView {
  visible: boolean;
  data_ceiling: string;
  reason: string | null;
  actions: Record<string, ModuleAction>;
}

interface Projection {
  schema_version: string;
  assigned_role: string | null;
  state: string;
  modules: Record<string, ModuleView>;
  freshness: {
    checked_at: string;
    expires_at: string;
    stale_after: string;
    state: string;
    invalidation: string[];
  };
  ceiling: { state: string | null; capabilities: string[] };
  actions: Record<string, { allowed: boolean; reason?: string }>;
}

async function projection(authApp: AuthApp, session: LoggedInSession): Promise<Projection> {
  const response = await getJson<Projection>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/capabilities`,
    { Cookie: `fp_session=${session.session}` },
  );
  expect(response.status).toBe(200);
  return response.body;
}

function allow(view: ModuleView, action: string): boolean {
  return view.actions[action]?.allowed ?? false;
}

describe("role × module projection over real HTTP", () => {
  test("viewer/member/admin/owner see their own modules, actions and data ceilings", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "admin" });

    await setRole(authApp, session.userId, "viewer");
    const viewer = await projection(authApp, session);
    expect(viewer.schema_version).toBe("workspace-capability-v2");
    expect(viewer.assigned_role).toBe("viewer");
    expect(viewer.modules["tasks"]).toMatchObject({ visible: true, data_ceiling: "repository" });
    expect(allow(viewer.modules["tasks"]!, "view")).toBe(true);
    expect(allow(viewer.modules["tasks"]!, "create")).toBe(false);
    expect(viewer.modules["memory"]!.data_ceiling).toBe("internal");
    expect(viewer.modules["rsi"]).toMatchObject({ visible: false, data_ceiling: "none" });
    expect(viewer.modules["dashboard"]!.data_ceiling).toBe("operational");
    expect(allow(viewer.modules["dashboard"]!, "view_financial")).toBe(false);
    expect(viewer.modules["members"]!.data_ceiling).toBe("roster");
    expect(viewer.modules["security"]!.visible).toBe(false);
    expect(viewer.modules["service_integration"]!.visible).toBe(false);

    await setRole(authApp, session.userId, "member");
    const member = await projection(authApp, session);
    expect(member.assigned_role).toBe("member");
    expect(allow(member.modules["tasks"]!, "create")).toBe(true);
    expect(allow(member.modules["issues"]!, "create")).toBe(true);
    expect(member.modules["rsi"]!.visible).toBe(true);
    expect(allow(member.modules["rsi"]!, "propose")).toBe(true);
    expect(allow(member.modules["rsi"]!, "approve")).toBe(false);
    expect(allow(member.modules["memory"]!, "view_confidential")).toBe(false);

    await setRole(authApp, session.userId, "admin");
    const admin = await projection(authApp, session);
    expect(admin.assigned_role).toBe("admin");
    expect(admin.modules["memory"]!.data_ceiling).toBe("confidential");
    expect(allow(admin.modules["memory"]!, "view_confidential")).toBe(true);
    expect(allow(admin.modules["memory"]!, "govern_workspace")).toBe(true);
    expect(admin.modules["dashboard"]!.data_ceiling).toBe("financial");
    expect(allow(admin.modules["dashboard"]!, "audit")).toBe(true);
    expect(allow(admin.modules["members"]!, "manage_members")).toBe(true);
    expect(allow(admin.modules["members"]!, "manage_roles")).toBe(false);
    expect(allow(admin.modules["rsi"]!, "approve")).toBe(true);
    expect(allow(admin.modules["rsi"]!, "evaluate")).toBe(false);

    await setRole(authApp, session.userId, "owner");
    const owner = await projection(authApp, session);
    expect(owner.assigned_role).toBe("owner");
    expect(allow(owner.modules["members"]!, "manage_roles")).toBe(true);
    for (const action of ["evaluate", "canary", "rollback", "kill_switch"]) {
      expect(allow(owner.modules["rsi"]!, action), action).toBe(true);
    }

    // Downgrade and recovery take effect on the next request: nothing is cached.
    await setRole(authApp, session.userId, "viewer");
    const downgraded = await projection(authApp, session);
    expect(downgraded.assigned_role).toBe("viewer");
    expect(allow(downgraded.modules["tasks"]!, "create")).toBe(false);
    await setRole(authApp, session.userId, "owner");
    expect((await projection(authApp, session)).assigned_role).toBe("owner");
  });

  test("the projection carries an explicit advisory lifetime and invalidation set", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "member")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "write" });
    const body = await projection(authApp, session);
    expect(Date.parse(body.freshness.expires_at)).toBeGreaterThan(
      Date.parse(body.freshness.checked_at),
    );
    expect(Date.parse(body.freshness.stale_after)).toBeGreaterThan(
      Date.parse(body.freshness.expires_at),
    );
    expect(body.freshness.state).toBe("fresh");
    expect(body.freshness.invalidation).toEqual(
      expect.arrayContaining([
        "membership_changed",
        "capability_ceiling_changed",
        "provider_reconciled",
        "session_revoked",
        "projection_expired",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Memory data ceiling over HTTP
// ---------------------------------------------------------------------------

function seedMemoryItem(
  authApp: AuthApp,
  sensitivity: "internal" | "confidential" | "restricted",
  statement: string,
): string {
  const memory = authApp.orchestrator.memoryRepositories;
  if (memory === undefined) {
    throw new Error("memory repositories are not wired");
  }
  const workspaceScope = scope(authApp);
  const created = memory.items.create(workspaceScope, {
    kind: "lesson",
    scope: { path_prefix: "node/src" },
    statement,
    preconditions: [],
    provenance: { author_type: "human" },
    trust: "human",
    sensitivity,
    valid_from: "2026-11-01T00:00:00.000Z",
    valid_to: null,
  });
  memory.items.reviewVersion(workspaceScope, created.item.id, 1, "usr_reviewer");
  memory.evidence.add(workspaceScope, created.item.id, {
    evidence_type: "reviewer_decision",
    reference: `pr:${statement}`,
  });
  memory.items.setStatus(workspaceScope, created.item.id, "candidate", 1);
  memory.items.setStatus(workspaceScope, created.item.id, "active", 1);
  return created.item.id;
}

describe("memory need-to-know really tightens over HTTP", () => {
  test("member sees internal only, admin sees confidential, restricted stays hidden", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "admin" });

    const internalId = seedMemoryItem(authApp, "internal", "internal lesson");
    const confidentialId = seedMemoryItem(authApp, "confidential", "confidential lesson");
    const restrictedId = seedMemoryItem(authApp, "restricted", "restricted lesson");
    const url = `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/memory/items`;
    const headers = { Cookie: `fp_session=${session.session}` };

    await setRole(authApp, session.userId, "member");
    const member = await getJson<{ items: Array<{ item_id: string; sensitivity: string }> }>(
      url,
      headers,
    );
    expect(member.status).toBe(200);
    const memberIds = member.body.items.map((item) => item.item_id);
    expect(memberIds).toContain(internalId);
    expect(memberIds).not.toContain(confidentialId);
    expect(memberIds).not.toContain(restrictedId);
    expect((await projection(authApp, session)).modules["memory"]!.data_ceiling).toBe("internal");

    await setRole(authApp, session.userId, "admin");
    const admin = await getJson<{ items: Array<{ item_id: string; sensitivity: string }> }>(
      url,
      headers,
    );
    expect(admin.status).toBe(200);
    const adminIds = admin.body.items.map((item) => item.item_id);
    expect(adminIds).toContain(internalId);
    expect(adminIds).toContain(confidentialId);
    expect(adminIds).not.toContain(restrictedId);
    expect((await projection(authApp, session)).modules["memory"]!.data_ceiling).toBe(
      "confidential",
    );

    // A governor cannot read `restricted` through the ordinary surface.
    const restricted = await getJson<{ error: { code: string } }>(
      `${url}/${restrictedId}`,
      headers,
    );
    expect(restricted.status).toBe(404);
    expect(restricted.body.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Team leadership
// ---------------------------------------------------------------------------

describe("team leader memory governance", () => {
  test("only the member leading a team gets the govern_team exception", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "member")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "write" });

    const before = await projection(authApp, session);
    expect(allow(before.modules["memory"]!, "govern_team")).toBe(false);
    expect(before.modules["memory"]!.actions["govern_team"]?.reason).toBe("team_leader");

    createRepositories(db(authApp)).teams.create(scope(authApp), {
      name: "Payments",
      leader_user_id: session.userId,
    });
    const after = await projection(authApp, session);
    expect(allow(after.modules["memory"]!, "govern_team")).toBe(true);
    expect(allow(after.modules["memory"]!, "govern_workspace")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security duties
// ---------------------------------------------------------------------------

function mutableDutyDirectory(): {
  directory: SecurityDutyDirectory;
  grant: (userId: string, duties: SecurityDuty[]) => void;
} {
  const assigned = new Map<string, SecurityDuty[]>();
  return {
    directory: {
      dutiesOf: (principalId: string) => assigned.get(principalId) ?? [],
      reviewersIn: () =>
        [...assigned.entries()]
          .filter(([, duties]) => duties.includes("independent_reviewer"))
          .map(([id]) => id),
    },
    grant: (userId, duties) => assigned.set(userId, duties),
  };
}

describe("security duties are not workspace roles", () => {
  test("a duty holder keeps stop/recovery actions through an ordinary demotion", async () => {
    const duties = mutableDutyDirectory();
    const authApp = await app({ securityDutyDirectory: duties.directory });
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "admin" });
    duties.grant(session.userId, ["security_handler", "independent_reviewer"]);

    const owner = await projection(authApp, session);
    expect(owner.modules["security"]).toMatchObject({
      visible: true,
      data_ceiling: "redacted",
    });
    expect(allow(owner.modules["security"]!, "case.handle")).toBe(true);
    expect(allow(owner.modules["security"]!, "case.terminate")).toBe(true);
    expect(allow(owner.modules["security"]!, "case.review_decide")).toBe(true);
    expect(allow(owner.modules["security"]!, "recovery.approve")).toBe(true);
    expect(allow(owner.modules["security"]!, "audit.export")).toBe(false);

    await setRole(authApp, session.userId, "viewer");
    const demoted = await projection(authApp, session);
    expect(allow(demoted.modules["tasks"]!, "create")).toBe(false);
    expect(demoted.modules["memory"]!.data_ceiling).toBe("internal");
    expect(allow(demoted.modules["security"]!, "case.terminate")).toBe(true);
    expect(allow(demoted.modules["security"]!, "recovery.approve")).toBe(true);
    expect(allow(demoted.modules["security"]!, "audit.export")).toBe(false);

    // Removing the duty removes the surface; the role never supplied it.
    duties.grant(session.userId, []);
    const removed = await projection(authApp, session);
    expect(removed.modules["security"]!.visible).toBe(false);
    expect(allow(removed.modules["security"]!, "case.handle")).toBe(false);
  });

  test("an enterprise security administrator duty never grants review authority", async () => {
    const duties = mutableDutyDirectory();
    const authApp = await app({ securityDutyDirectory: duties.directory });
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "admin" });
    duties.grant(session.userId, ["enterprise_security_admin"]);

    const body = await projection(authApp, session);
    expect(body.modules["security"]!.data_ceiling).toBe("audit");
    expect(allow(body.modules["security"]!, "audit.export")).toBe(true);
    expect(allow(body.modules["security"]!, "case.review_decide")).toBe(false);
    expect(allow(body.modules["security"]!, "rule.review")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enterprise-scoped projection
// ---------------------------------------------------------------------------

interface EnterpriseProjection {
  schema_version: string;
  member: { status: string; role: string };
  modules: Record<string, ModuleView>;
  workspace_data_access: { granted: boolean; reason: string };
}

describe("enterprise projection without workspace data access", () => {
  test("an enterprise admin with no workspace membership reaches metadata only", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    const cookie = { Cookie: `fp_session=${session.session}` };

    // Ordinary enterprise member: no administrator surface.
    const member = await getJson<EnterpriseProjection>(
      `${authApp.base}/api/v1/enterprises/${authApp.enterpriseId}/capabilities`,
      cookie,
    );
    expect(member.status).toBe(200);
    expect(member.body.schema_version).toBe("enterprise-capability-v1");
    expect(member.body.member).toMatchObject({ status: "active", role: "member" });
    expect(member.body.modules["enterprise_directory"]!.visible).toBe(false);
    expect(allow(member.body.modules["service_integration"]!, "configure")).toBe(false);
    expect(member.body.workspace_data_access.granted).toBe(false);

    // The same user as enterprise administrator.
    createIdentityRepositories(db(authApp)).enterpriseRoles.grant({
      enterprise_id: authApp.enterpriseId,
      user_id: session.userId,
      role: "admin",
      actor_id: "usr_seed",
    });
    const admin = await getJson<EnterpriseProjection>(
      `${authApp.base}/api/v1/enterprises/${authApp.enterpriseId}/capabilities`,
      cookie,
    );
    expect(admin.status).toBe(200);
    expect(admin.body.member.role).toBe("admin");
    expect(admin.body.modules["enterprise_directory"]).toMatchObject({
      visible: true,
      data_ceiling: "directory",
    });
    expect(admin.body.modules["identity_audit"]!.visible).toBe(true);
    expect(allow(admin.body.modules["service_integration"]!, "configure")).toBe(true);
    expect(admin.body.modules["workspace_data"]!.visible).toBe(false);
    expect(allow(admin.body.modules["workspace_data"]!, "view_tasks")).toBe(false);
    expect(admin.body.workspace_data_access).toMatchObject({
      granted: false,
      reason: "enterprise_administration_is_not_repository_authority",
    });

    // Enterprise administration is not a workspace membership: the workspace
    // projection stays indistinguishable from an unknown workspace.
    const workspace = await getJson(
      `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/capabilities`,
      cookie,
    );
    expect(workspace.status).toBe(404);

    // A substituted enterprise id is indistinguishable from a missing one.
    const other = await getJson(
      `${authApp.base}/api/v1/enterprises/ent_other/capabilities`,
      cookie,
    );
    expect(other.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Fail closed, direct URLs, and stale projections
// ---------------------------------------------------------------------------

describe("fail-closed and non-enumerable behavior", () => {
  test("missing provider permission hides all workspace data but keeps duty/metadata surfaces", async () => {
    const duties = mutableDutyDirectory();
    const authApp = await app({ securityDutyDirectory: duties.directory });
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { permissionVisibility: "none" });
    duties.grant(session.userId, ["security_handler"]);
    createIdentityRepositories(db(authApp)).enterpriseRoles.grant({
      enterprise_id: authApp.enterpriseId,
      user_id: session.userId,
      role: "admin",
      actor_id: "usr_seed",
    });

    const body = await projection(authApp, session);
    expect(body.state).toBe("unverified");
    for (const module of ["tasks", "issues", "memory", "rsi", "dashboard", "members"]) {
      expect(body.modules[module]!.data_ceiling, module).toBe("none");
      expect(body.modules[module]!.reason, module).not.toBeNull();
    }
    expect(allow(body.modules["security"]!, "case.handle")).toBe(true);
    expect(allow(body.modules["service_integration"]!, "view_metadata")).toBe(true);

    const read = await getJson<{ error: { code: string } }>(
      `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks`,
      { Cookie: `fp_session=${session.session}` },
    );
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("AUTHORITY_RECHECK_REQUIRED");
  });

  test("a stale projection cannot bypass a confirmed downgrade; direct URLs 404", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, session.userId, "member")).toBe(200);
    const fixture = installIntegration(authApp, session.userId, { providerRole: "write" });
    const cookie = cookieSessionHeaders(session);

    const before = await projection(authApp, session);
    expect(allow(before.modules["tasks"]!, "create")).toBe(true);
    const created = await postJson(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "module probe" },
      { "Content-Type": "application/json", ...cookie },
    );
    expect(created.status).toBe(201);

    fixture.access.roster.applySnapshot(scope(authApp), fixture.integrationId, {
      roles: [
        {
          subject: SUBJECT,
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: REPOSITORY_ID,
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
    });
    const denied = await postJson<{ error: { code: string } }>(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "denied" },
      { "Content-Type": "application/json", ...cookie },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    const after = await projection(authApp, session);
    expect(allow(after.modules["tasks"]!, "create")).toBe(false);
    expect(allow(after.modules["issues"]!, "create")).toBe(false);
    expect(allow(after.modules["memory"]!, "view")).toBe(true); // read-only remains

    const other = createRepositories(db(authApp)).workspaces.create(
      { enterprise_id: authApp.enterpriseId, actor_id: "usr_seed" },
      {
        name: "Other",
        repository_id: "github:acme/other",
        provider_instance_id: authApp.providerInstanceId,
      },
    );
    const otherProjection = await getJson(
      `${authApp.base}/api/v1/workspaces/${other.id}/capabilities`,
      { Cookie: `fp_session=${session.session}` },
    );
    expect(otherProjection.status).toBe(404);
    const otherTasks = await getJson(`${authApp.base}/api/v1/workspaces/${other.id}/tasks`, {
      Cookie: `fp_session=${session.session}`,
    });
    expect(otherTasks.status).toBe(404);
  });
});
