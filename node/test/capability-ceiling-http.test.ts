/**
 * Repository capability ceiling at the production request boundary (DAT-276).
 *
 * Real HTTP requests, a live SSE subscription, the worker-sensitive write
 * steps, the administrator reapproval contract and the legacy administrator
 * membership entry — all against the running service, not a gate helper.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  createIdentityRepositories,
  createMemberCapabilityRepository,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import { createAuthorityEpoch } from "../src/provider-access/access-gate.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import type { ProviderAccessRepositories, ServiceIntegration } from "../src/control-plane/index.js";
import type { WorkspaceScope } from "../src/control-plane/types.js";
import { applyProviderEvent } from "../src/provider-access/reconcile.js";

const REPOSITORY_ID = "github:FoMo-Exp/AutoFixer";
const SUBJECT = "1001"; // fakeProvider profile id of the default login

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

async function app(): Promise<AuthApp> {
  const created = await startAuthApp({ dsh });
  apps.push(created);
  return created;
}

function operatorHeaders(authApp: AuthApp): Record<string, string> {
  return { Authorization: `Bearer ${authApp.orchestrator.apiToken}` };
}

async function grantMembership(authApp: AuthApp, userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": "test-bootstrap-token-0123456789abcdef0123456789abcdef",
      },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

interface BoundaryFixture {
  access: ProviderAccessRepositories;
  integration: ServiceIntegration;
  scope: WorkspaceScope;
  identity: ReturnType<typeof createIdentityRepositories>;
}

/** Install the workspace integration and verify the login's subject role. */
function installIntegration(
  authApp: AuthApp,
  userId: string,
  options: { providerRole?: string } = {},
): BoundaryFixture {
  const db = authApp.orchestrator.controlPlane;
  if (!db) {
    throw new Error("control plane missing");
  }
  const access = createProviderAccessRepositories(db);
  const identity = createIdentityRepositories(db);
  const scope: WorkspaceScope = {
    enterprise_id: authApp.enterpriseId,
    workspace_id: authApp.workspaceId,
    actor_id: "usr_test_operator",
  };
  const integration = access.integrations.create(scope, {
    provider_instance_id: authApp.providerInstanceId,
    repository_id: REPOSITORY_ID,
    repository_name: "FoMo-Exp/AutoFixer",
    source_credential_ref: "svc-source-1",
    checkout_credential_ref: "svc-checkout-1",
    delivery_credential_ref: "svc-delivery-1",
    permission_visibility: "full",
    actor_id: "usr_test_operator",
  });
  access.roster.applySnapshot(scope, integration.id, {
    roles: [
      {
        subject: SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: options.providerRole ?? "write",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
    subject_users: { [SUBJECT]: userId },
  });
  return { access, integration, scope, identity };
}

function setProviderRole(authApp: AuthApp, fixture: BoundaryFixture, providerRole: string): void {
  fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
    roles: [
      {
        subject: SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: providerRole,
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
  });
  authApp.orchestrator.providerAuthority?.epoch.bump();
}

async function createTask(authApp: AuthApp, headers: Record<string, string>): Promise<number> {
  const created = await postJson(
    `${authApp.base}/api/v1/tasks`,
    { repository_id: REPOSITORY_ID, base_ref: "main", summary: "ceiling probe" },
    { "Content-Type": "application/json", ...headers },
  );
  return created.status;
}

interface CapabilityBody {
  schema_version: string;
  state: string;
  blocked_reason: string | null;
  capabilities: string[];
  assigned_role: string | null;
  actions: Record<string, { allowed: boolean; required: string; reason?: string }>;
  repositories: Array<{ state: string; capabilities: string[] }>;
  ceiling: { state: string | null; capabilities: string[]; promotion_available: boolean };
  authority: { verified_at: string | null; stale_after_ms: number; repository_count: number };
}

async function capabilityProjection(
  authApp: AuthApp,
  session: LoggedInSession,
): Promise<CapabilityBody> {
  const response = await getJson<CapabilityBody>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/capabilities`,
    { Cookie: `fp_session=${session.session}` },
  );
  expect(response.status).toBe(200);
  return response.body;
}

describe("capability ceiling over real HTTP", () => {
  test("the projection, read and worker-write steps follow the verified ceiling", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);

    const verified = await capabilityProjection(authApp, member);
    expect(verified.schema_version).toBe("workspace-capability-v1");
    expect(verified.state).toBe("verified");
    expect(verified.capabilities).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(verified.actions["read"]?.allowed).toBe(true);
    expect(verified.actions["write"]?.allowed).toBe(true);
    expect(verified.actions["manage"]?.allowed).toBe(false);
    expect(verified.ceiling.state).toBe("approved");
    expect(verified.authority.repository_count).toBe(1);

    const cookie = { Cookie: `fp_session=${member.session}` };
    expect(await createTask(authApp, cookieSessionHeaders(member))).toBe(201);

    // The provider now proves `read` only. A confirmed downgrade applies to
    // the very next request, with no cache to outlive it.
    setProviderRole(authApp, fixture, "read");
    const write = await postJson(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "denied" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({
      error: { code: "FORBIDDEN", details: { action: "write", reason: "capability_ceiling" } },
    });

    const downgraded = await capabilityProjection(authApp, member);
    expect(downgraded.state).toBe("verified");
    expect(downgraded.capabilities).toEqual(["code_read"]);
    expect(downgraded.ceiling.state).toBe("downgraded");
    expect(downgraded.actions["write"]?.allowed).toBe(false);
    // Reads remain: only the ceiling tightened, the role did not change.
    expect(downgraded.assigned_role).toBe("member");
    const list = await getJson(`${authApp.base}/api/v1/tasks`, cookie);
    expect(list.status).toBe(200);
  });

  test("unverifiable evidence fails the whole workspace closed and clears itself", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);
    const cookie = { Cookie: `fp_session=${member.session}` };

    expect((await getJson(`${authApp.base}/api/v1/tasks`, cookie)).status).toBe(200);

    // A provider outage / transfer resets authority to `unknown` (the real
    // reconcile path). Nothing is recorded as a downgrade.
    fixture.access.roster.resetAuthority(
      fixture.scope,
      fixture.integration.id,
      new Date().toISOString(),
    );
    authApp.orchestrator.providerAuthority?.epoch.bump();

    const read = await getJson(`${authApp.base}/api/v1/tasks`, cookie);
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({
      error: { code: "AUTHORITY_RECHECK_REQUIRED", details: { action: "read" } },
    });
    const blocked = await capabilityProjection(authApp, member);
    expect(blocked.state).toBe("unverified");
    expect(blocked.blocked_reason).toBe("authority_unknown");
    expect(blocked.actions["read"]?.allowed).toBe(false);
    expect(blocked.ceiling.state).toBe("approved");

    // The same facts verify again: access returns without a promotion.
    fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
      roles: [
        {
          subject: SUBJECT,
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "write",
          authority_ref: REPOSITORY_ID,
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
    });
    authApp.orchestrator.providerAuthority?.epoch.bump();
    expect((await getJson(`${authApp.base}/api/v1/tasks`, cookie)).status).toBe(200);
    const recovered = await capabilityProjection(authApp, member);
    expect(recovered.state).toBe("verified");
    expect(recovered.ceiling.state).toBe("approved");
  });

  test("a provider removal closes a live SSE stream", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "admin")).toBe(200);
    const fixture = installIntegration(authApp, member.userId, { providerRole: "admin" });

    const created = await postJson<{ id: string }>(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "stream probe" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    const connected = fetch(`${authApp.base}/api/v1/tasks/${taskId}/stream`, {
      headers: { Cookie: `fp_session=${member.session}` },
      signal: AbortSignal.timeout(10_000),
    });
    const ended = connected.then((response) => {
      expect(response.status).toBe(200);
      return response.text();
    });
    await connected;

    // The production provider-event path removes the subject; revocation bumps
    // the shared epoch, the stream re-checks `stream`, and closes.
    applyProviderEvent(
      {
        access: fixture.access,
        identities: fixture.identity.identities,
        epoch: authApp.orchestrator.providerAuthority!.epoch,
      },
      fixture.scope,
      fixture.integration,
      {
        id: "evt_ceiling_removed",
        enterprise_id: authApp.enterpriseId,
        provider_instance_id: authApp.providerInstanceId,
        integration_id: fixture.integration.id,
        repository_id: REPOSITORY_ID,
        event_type: "member_removed",
        payload: { subject: SUBJECT },
        delivery_id: "ceiling-removal-1",
        received_at: new Date().toISOString(),
        processed_at: null,
      },
    );

    const body = await ended;
    expect(body).toContain("task.");
    const after = await getJson(`${authApp.base}/api/v1/tasks`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(after.status).toBe(403);
  });
});

describe("administrator reapproval over HTTP", () => {
  function makeEnterpriseAdmin(authApp: AuthApp, userId: string): void {
    const db = authApp.orchestrator.controlPlane;
    if (!db) {
      throw new Error("control plane missing");
    }
    const identity = createIdentityRepositories(db);
    identity.enterpriseRoles.grant({
      enterprise_id: authApp.enterpriseId,
      user_id: userId,
      role: "admin",
      actor_id: "usr_seed",
    });
    identity.enterpriseUsers.ensureActive(authApp.enterpriseId, userId, {
      kind: "deployment",
    });
    createRepositories(db);
  }

  test("only an administrator with repository management can reapprove, within verified facts", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "owner")).toBe(200);
    const fixture = installIntegration(authApp, member.userId, { providerRole: "admin" });

    // A second member (the target) is downgraded, then the provider recovers.
    const targetUser = fixture.identity.users.create({
      display_name: "target",
      actor_id: "usr_seed",
    });
    fixture.identity.identities.create({
      user_id: targetUser.id,
      provider_instance_id: authApp.providerInstanceId,
      subject: "2002",
      login: "target",
      actor_id: "usr_seed",
    });
    fixture.identity.enterpriseUsers.ensureActive(authApp.enterpriseId, targetUser.id, {
      kind: "deployment",
    });
    createRepositories(authApp.orchestrator.controlPlane!).memberships.create(fixture.scope, {
      user_id: targetUser.id,
      role: "member",
    });
    fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
      roles: [
        {
          subject: "2002",
          login: "target",
          source_kind: "direct_collaborator",
          provider_role: "write",
          authority_ref: REPOSITORY_ID,
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
      subject_users: { "2002": targetUser.id },
    });

    const memberCookie = { Cookie: `fp_session=${member.session}` };
    const adminBase = `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${targetUser.id}/capability-ceiling`;
    // The member is an owner with repository management, but not an enterprise
    // administrator: refused.
    const notAdmin = await getJson(adminBase, memberCookie);
    expect(notAdmin.status).toBe(403);

    makeEnterpriseAdmin(authApp, member.userId);
    const seen = await getJson<{
      capability_ceiling: {
        evaluation: { record: { version: number } | null; available_capabilities: string[] };
        ceiling: { state: string; capabilities: string[] };
      };
    }>(adminBase, memberCookie);
    expect(seen.status).toBe(200);
    expect(seen.body.capability_ceiling.ceiling.capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
    ]);
    const version = seen.body.capability_ceiling.evaluation.record!.version;

    // A stale version is a conflict, not an approval.
    const stale = await postJson(
      adminBase,
      { version: version + 9, capabilities: ["code_read"] },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "CAPABILITY_CEILING_MISMATCH" } });

    // More than the providers prove is refused.
    const excessive = await postJson(
      adminBase,
      {
        version,
        capabilities: ["code_read", "issue_write", "repository_write", "repository_manage"],
      },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(excessive.status).toBe(403);
    expect(excessive.body).toMatchObject({
      error: { code: "CAPABILITY_CEILING_EXCEEDS_VERIFIED" },
    });

    // An administrator can narrow (never widen) inside the verified facts.
    const approved = await postJson(
      adminBase,
      { version, capabilities: ["code_read", "issue_write"] },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "approved" });

    // The target's workspace role is untouched by the ceiling approval.
    const membership = createRepositories(authApp.orchestrator.controlPlane!).memberships.getByUser(
      fixture.scope,
      targetUser.id,
    );
    expect(membership?.role).toBe("member");
    expect(operatorHeaders(authApp).Authorization).toContain("Bearer");
  });

  test("the legacy administrator membership route enforces management capability", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "owner")).toBe(200);
    // Repository management is not proven: `read` only.
    installIntegration(authApp, member.userId, { providerRole: "read" });

    const target = createRepositories(authApp.orchestrator.controlPlane!).memberships.list({
      enterprise_id: authApp.enterpriseId,
      workspace_id: authApp.workspaceId,
      actor_id: "usr_seed",
    });
    expect(target.length).toBeGreaterThan(0);

    const response = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${member.userId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...cookieSessionHeaders(member),
        },
        body: JSON.stringify({ role: "member" }),
      },
    );
    // A session administrator path is not a management-capability bypass.
    expect(response.status).toBe(403);
  });
});

describe("cross-process capability reduction and live streams", () => {
  test("another process's persisted loss closes this process's stream before it emits", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "owner")).toBe(200);
    const fixture = installIntegration(authApp, member.userId, { providerRole: "admin" });

    const created = await postJson<{ id: string }>(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "cross-process stream" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    const connected = fetch(`${authApp.base}/api/v1/tasks/${taskId}/stream`, {
      headers: { Cookie: `fp_session=${member.session}` },
      signal: AbortSignal.timeout(10_000),
    });
    const ended = connected.then((response) => {
      expect(response.status).toBe(200);
      return response.text();
    });
    await connected;
    const stillOpen = await Promise.race([
      ended.then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 300)),
    ]);
    expect(stillOpen).toBe("open");

    const authority = authApp.orchestrator.providerAuthority!;
    const epochBefore = authority.epoch.current();

    // The provider removal is observed by a *different* process: it persists
    // the confirmed loss through its own capability service and its own local
    // epoch. Nothing bumps this process's epoch.
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      SUBJECT,
      "removed",
      new Date().toISOString(),
    );
    const db = authApp.orchestrator.controlPlane!;
    const otherProcess = createCapabilityCeilingService({
      repositorySets: createWorkspaceRepositorySetRepository(db),
      access: createProviderAccessRepositories(db),
      memberships: createRepositories(db).memberships,
      providerInstances: createRepositories(db).providerInstances,
      identity: createIdentityRepositories(db),
      capabilities: createMemberCapabilityRepository(db),
      epoch: createAuthorityEpoch(),
    });
    const otherEvaluation = otherProcess.evaluate(fixture.scope, member.userId);
    expect(otherEvaluation.state).toBe("confirmed_loss");
    expect(otherEvaluation.record?.ceiling).toEqual([]);
    expect(authority.epoch.current()).toBe(epochBefore);

    // An event is emitted in this process (another actor cancels the task).
    // The stream must re-authorize against the shared persisted facts before
    // writing: it closes without delivering the event.
    await authApp.orchestrator.service.cancelTask(
      taskId,
      "cross-process capability loss",
      authApp.workspaceId,
    );

    const body = await ended;
    expect(body).not.toContain("task.terminal");
    expect(body).not.toContain("cross-process capability loss");

    const read = await getJson(`${authApp.base}/api/v1/tasks`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(403);
  });
});
