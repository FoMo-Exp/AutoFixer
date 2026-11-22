import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createRepositories,
  principalFromSession,
  resolveRequestScope,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieValue, getJson, postJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  completeCallback,
  cookieSessionHeaders,
  startAuthApp,
  startLogin,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";

/**
 * Enterprise user HTTP surface (DAT-275, ADR-0011).
 *
 * Administrator addition is keyed only by an approved provider instance and
 * its stable subject; an unclaimed subject is `pending_claim` until the
 * matching OAuth login binds it exactly once. Enterprise suspension is
 * enterprise-scoped and fails closed for tasks, streams, and enterprise
 * administration without touching another enterprise.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "identity-api-v1");

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

function dbOf(target: AuthApp): ControlPlaneDb {
  const db = target.orchestrator.controlPlane;
  if (db === undefined) throw new Error("no control plane");
  return db as ControlPlaneDb;
}

function usersUrl(target: AuthApp, suffix = ""): string {
  return `${target.base}/api/v1/admin/enterprises/${target.enterpriseId}/users${suffix}`;
}

interface EnterpriseUserBody {
  id: string;
  enterprise_id: string;
  user_id: string | null;
  status: "pending_claim" | "active" | "suspended";
  role: "admin" | "member";
  provider_instance_id: string;
  provider_type: "github" | "gitlab";
  subject: string;
  display_name: string | null;
  login: string | null;
  claimed_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface SessionBody {
  user: { id: string };
  csrf_token: string;
  enterprise_membership: {
    enterprise_id: string;
    status: "pending_claim" | "active" | "suspended";
    role: "admin" | "member";
    version: number;
  } | null;
}

/** A signed-in provider subject (the real login path; no harness shortcut). */
async function loginAs(
  target: AuthApp,
  profile: { id: number; login: string; email?: string },
): Promise<LoggedInSession> {
  target.provider.profile = profile;
  const started = await startLogin(target);
  const response = await completeCallback(target, {
    state: started.state,
    binding: started.binding,
  });
  expect(response.status).toBe(302);
  const session = cookieValue(response.headers, "fp_session") ?? "";
  const info = await getJson<SessionBody>(`${target.base}/api/v1/auth/session`, {
    Cookie: `fp_session=${session}`,
  });
  return { userId: info.body.user.id, session, csrf: info.body.csrf_token };
}

/** Login as the app's default subject, then bootstrap it as enterprise admin. */
async function loginAdmin(target: AuthApp): Promise<LoggedInSession> {
  const session = await webLogin(target);
  const response = await fetch(
    `${target.base}/api/v1/admin/enterprises/${target.enterpriseId}/bootstrap`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
      body: JSON.stringify({
        provider_instance_id: target.providerInstanceId,
        subject: String(target.provider.profile.id),
      }),
    },
  );
  expect(response.status).toBe(200);
  return session;
}

function adminHeaders(session: LoggedInSession): Record<string, string> {
  return { ...cookieSessionHeaders(session), "Content-Type": "application/json" };
}

async function addUser(
  target: AuthApp,
  admin: LoggedInSession,
  subject: string,
): Promise<{ status: number; body: { enterprise_user: EnterpriseUserBody; created: boolean } }> {
  return postJson(
    usersUrl(target),
    { provider_instance_id: target.providerInstanceId, subject },
    adminHeaders(admin),
  );
}

async function findUserBySubject(
  target: AuthApp,
  admin: LoggedInSession,
  subject: string,
): Promise<EnterpriseUserBody> {
  const list = await getJson<{ items: EnterpriseUserBody[] }>(usersUrl(target), {
    Cookie: `fp_session=${admin.session}`,
  });
  expect(list.status).toBe(200);
  const found = list.body.items.find((item) => item.subject === subject);
  if (found === undefined) throw new Error(`no enterprise user for subject ${subject}`);
  return found;
}

/** Deployment-token workspace grant (setup only; not the enterprise surface). */
async function grantWorkspaceMembership(target: AuthApp, userId: string): Promise<void> {
  const response = await fetch(
    `${target.base}/api/v1/admin/enterprises/${target.enterpriseId}/workspaces/${target.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
      body: JSON.stringify({ role: "member" }),
    },
  );
  expect(response.status).toBe(200);
}

function operatorHeaders(target: AuthApp): Record<string, string> {
  return { Authorization: `Bearer ${target.orchestrator.apiToken}` };
}

function openSessionStream(
  target: AuthApp,
  taskId: string,
  session: LoggedInSession,
): { connected: Promise<Response>; ended: Promise<string> } {
  const connected = fetch(`${target.base}/api/v1/tasks/${taskId}/stream`, {
    headers: { Cookie: `fp_session=${session.session}` },
    signal: AbortSignal.timeout(10_000),
  });
  const ended = connected.then(async (response) => {
    expect(response.status).toBe(200);
    return response.text();
  });
  return { connected, ended };
}

describe("administrator addition and identity claim", () => {
  test("an added subject is pending, idempotent, and visible in the directory", async () => {
    const target = await app();
    const admin = await loginAdmin(target);

    const created = await addUser(target, admin, "4242");
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.enterprise_user.status).toBe("pending_claim");
    expect(created.body.enterprise_user.user_id).toBeNull();
    expect(created.body.enterprise_user.subject).toBe("4242");
    expect(created.body.enterprise_user.role).toBe("member");

    const replay = await addUser(target, admin, "4242");
    expect(replay.status).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.enterprise_user.id).toBe(created.body.enterprise_user.id);
    expect(replay.body.enterprise_user.version).toBe(created.body.enterprise_user.version);

    const detail = await getJson<EnterpriseUserBody>(
      usersUrl(target, `/${created.body.enterprise_user.id}`),
      { Cookie: `fp_session=${admin.session}` },
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(created.body.enterprise_user);

    // The shipped fixture is a real-response exemplar: same field set.
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, "enterprise-user.json"), "utf8"),
    ) as EnterpriseUserBody;
    expect(Object.keys(detail.body).sort()).toEqual(Object.keys(fixture).sort());
  });

  test("a matching OAuth login claims once; replay never claims twice", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "5101");

    const member = await loginAs(target, { id: 5101, login: "claimer" });
    const claimed = await getJson<EnterpriseUserBody>(
      usersUrl(target, `/${added.body.enterprise_user.id}`),
      { Cookie: `fp_session=${admin.session}` },
    );
    expect(claimed.body.status).toBe("active");
    expect(claimed.body.user_id).toBe(member.userId);
    expect(claimed.body.claimed_at).not.toBeNull();

    const info = await getJson<SessionBody>(`${target.base}/api/v1/auth/session`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(info.body.enterprise_membership).toMatchObject({
      enterprise_id: target.enterpriseId,
      status: "active",
      role: "member",
    });

    // OAuth callback replay is refused and changes nothing.
    const started = await startLogin(target);
    const first = await completeCallback(target, {
      state: started.state,
      binding: started.binding,
    });
    const replay = await completeCallback(target, {
      state: started.state,
      binding: started.binding,
    });
    expect([first.status, replay.status].sort()).toEqual([302, 410]);
    expect(
      (
        await getJson<EnterpriseUserBody>(usersUrl(target, `/${added.body.enterprise_user.id}`), {
          Cookie: `fp_session=${admin.session}`,
        })
      ).body.version,
    ).toBe(claimed.body.version);

    const audits = await getJson<{ items: Array<{ event: string }> }>(
      `${target.base}/api/v1/admin/enterprises/${target.enterpriseId}/auth-audit`,
      { Cookie: `fp_session=${admin.session}` },
    );
    expect(audits.body.items.filter((row) => row.event === "enterprise_user.claimed")).toHaveLength(
      1,
    );
  });

  test("login alone enrolls nobody, and equal emails never merge subjects", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "5201");

    const stranger = await loginAs(target, {
      id: 5202,
      login: "stranger",
      email: "shared@example.com",
    });
    const info = await getJson<SessionBody>(`${target.base}/api/v1/auth/session`, {
      Cookie: `fp_session=${stranger.session}`,
    });
    expect(info.body.enterprise_membership).toBeNull();
    const tasks = await getJson(`${target.base}/api/v1/tasks`, {
      Cookie: `fp_session=${stranger.session}`,
    });
    expect(tasks.status).toBe(403);
    const workspaces = await getJson(`${target.base}/api/v1/workspaces`, {
      Cookie: `fp_session=${stranger.session}`,
    });
    expect(workspaces.status).toBe(403);

    expect(
      (
        await getJson<EnterpriseUserBody>(usersUrl(target, `/${added.body.enterprise_user.id}`), {
          Cookie: `fp_session=${admin.session}`,
        })
      ).body.status,
    ).toBe("pending_claim");
  });

  test("cross-enterprise access is not authority", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const repos = createRepositories(dbOf(target));
    const other = repos.enterprises.create({
      name: "Other Enterprise",
      slug: "other-ent",
      actor_id: "usr_seed",
    });
    const otherProvider = repos.providerInstances.create(
      { enterprise_id: other.id, actor_id: "usr_seed" },
      { provider_type: "github", origin_url: "https://gitlab.example.com" },
    );
    expect(otherProvider.enterprise_id).toBe(other.id);

    const list = await getJson(`${target.base}/api/v1/admin/enterprises/${other.id}/users`, {
      Cookie: `fp_session=${admin.session}`,
    });
    expect(list.status).toBe(403);
  });
});

describe("enterprise suspension boundary", () => {
  test("suspension fails closed for tasks and streams and leaves another enterprise intact", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "6101");
    const member = await loginAs(target, { id: 6101, login: "member" });
    await grantWorkspaceMembership(target, member.userId);

    // A second enterprise membership for the same person, plus one workspace
    // membership there — exactly the cross-tenant shape ADR-0011 protects.
    const db = dbOf(target);
    const repos = createRepositories(db);
    const identity = createIdentityRepositories(db);
    const other = repos.enterprises.create({
      name: "Tenant B",
      slug: "tenant-b",
      actor_id: "usr_seed",
    });
    const otherProvider = repos.providerInstances.create(
      { enterprise_id: other.id, actor_id: "usr_seed" },
      { provider_type: "github", origin_url: "https://github.com" },
    );
    const otherWorkspace = repos.workspaces.create(
      { enterprise_id: other.id, actor_id: "usr_seed" },
      {
        name: "Tenant B Workspace",
        repository_id: "github:tenant-b/repo",
        provider_instance_id: otherProvider.id,
      },
    );

    const task = await postJson<{ id: string }>(
      `${target.base}/api/v1/tasks`,
      {
        repository_id: "github:FoMo-Exp/AutoFixer",
        base_ref: "main",
        summary: "enterprise suspension stream probe",
      },
      { "Content-Type": "application/json", ...operatorHeaders(target) },
    );
    expect(task.status).toBe(201);
    const stream = openSessionStream(target, task.body.id, member);
    await stream.connected;

    const claimed = await findUserBySubject(target, admin, "6101");
    expect(claimed.status).toBe("active");
    const suspended = await postJson<EnterpriseUserBody>(
      usersUrl(target, `/${added.body.enterprise_user.id}/suspend`),
      { version: claimed.version },
      adminHeaders(admin),
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("suspended");

    // The live stream closes; the next requests fail closed with the
    // enterprise-scoped code, not a generic auth failure.
    await stream.ended;
    const read = await getJson<{ error: { code: string } }>(
      `${target.base}/api/v1/tasks/${task.body.id}`,
      { Cookie: `fp_session=${member.session}` },
    );
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("ENTERPRISE_MEMBERSHIP_SUSPENDED");
    const write = await postJson<{ error: { code: string } }>(
      `${target.base}/api/v1/tasks`,
      {
        repository_id: "github:FoMo-Exp/AutoFixer",
        base_ref: "main",
        summary: "must not run",
      },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("ENTERPRISE_MEMBERSHIP_SUSPENDED");

    // The session still exists so the client can explain the state.
    const info = await getJson<SessionBody>(`${target.base}/api/v1/auth/session`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(info.status).toBe(200);
    expect(info.body.enterprise_membership?.status).toBe("suspended");

    // Tenant B is untouched: a second person suspended in A but active in B
    // still resolves B's workspace scope (the executable-step entry), and
    // their A suspension is a separate row.
    const crossAdded = await addUser(target, admin, "6102");
    const crossUser = await loginAs(target, { id: 6102, login: "cross" });
    identity.enterpriseUsers.ensureActive(other.id, crossUser.userId, "usr_seed");
    repos.memberships.create(
      { enterprise_id: other.id, workspace_id: otherWorkspace.id, actor_id: "usr_seed" },
      { user_id: crossUser.userId, role: "member" },
    );
    const crossClaimed = await findUserBySubject(target, admin, "6102");
    const crossSuspended = await postJson<EnterpriseUserBody>(
      usersUrl(target, `/${crossAdded.body.enterprise_user.id}/suspend`),
      { version: crossClaimed.version },
      adminHeaders(admin),
    );
    expect(crossSuspended.status).toBe(200);
    expect(identity.enterpriseUsers.getByUser(other.id, crossUser.userId)?.status).toBe("active");
    const liveSession = identity.sessions.listByUser(crossUser.userId)[0];
    expect(liveSession).toBeDefined();
    const scope = resolveRequestScope(
      {
        sessions: identity.sessions,
        users: identity.users,
        memberships: repos.memberships,
        workspaces: repos.workspaces,
        enterpriseUsers: identity.enterpriseUsers,
      },
      principalFromSession({ session: liveSession!, user: { id: crossUser.userId } }),
    );
    expect(scope.enterprise_id).toBe(other.id);
    expect(scope.workspace_id).toBe(otherWorkspace.id);

    // Restore makes the same session work again.
    const restored = await postJson<EnterpriseUserBody>(
      usersUrl(target, `/${added.body.enterprise_user.id}/restore`),
      { version: suspended.body.version },
      adminHeaders(admin),
    );
    expect(restored.status).toBe(200);
    const readAgain = await getJson(`${target.base}/api/v1/tasks/${task.body.id}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(readAgain.status).toBe(200);
  }, 30_000);
});

describe("enterprise administration invariants", () => {
  test("role changes promote and demote a claimed member; pagination cursors are opaque", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "7301");
    await loginAs(target, { id: 7301, login: "future-admin" });
    const claimed = await findUserBySubject(target, admin, "7301");
    expect(claimed.role).toBe("member");

    const promotion = await fetch(usersUrl(target, `/${added.body.enterprise_user.id}/role`), {
      method: "PUT",
      headers: adminHeaders(admin),
      body: JSON.stringify({ role: "admin", version: claimed.version }),
    });
    expect(promotion.status).toBe(200);
    const promoted = (await promotion.json()) as EnterpriseUserBody;
    expect(promoted.role).toBe("admin");
    expect(promoted.version).toBe(claimed.version + 1);

    const demotion = await fetch(usersUrl(target, `/${added.body.enterprise_user.id}/role`), {
      method: "PUT",
      headers: adminHeaders(admin),
      body: JSON.stringify({ role: "member", version: promoted.version }),
    });
    expect(demotion.status).toBe(200);
    expect(((await demotion.json()) as EnterpriseUserBody).role).toBe("member");

    // A pending membership cannot take enterprise administration: there is no
    // account to hold it yet.
    const pending = await addUser(target, admin, "7302");
    const notClaimed = await fetch(usersUrl(target, `/${pending.body.enterprise_user.id}/role`), {
      method: "PUT",
      headers: adminHeaders(admin),
      body: JSON.stringify({ role: "admin", version: pending.body.enterprise_user.version }),
    });
    expect(notClaimed.status).toBe(409);
    expect(((await notClaimed.json()) as { error: { code: string } }).error.code).toBe(
      "USER_NOT_CLAIMED",
    );

    const badCursor = await getJson(`${usersUrl(target)}?cursor=eum_unknown`, {
      Cookie: `fp_session=${admin.session}`,
    });
    expect(badCursor.status).toBe(400);
    expect((badCursor.body as { error: { code: string } }).error.code).toBe("INVALID_CURSOR");
  });

  test("the last active administrator cannot be suspended or demoted", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const self = await findUserBySubject(target, admin, String(target.provider.profile.id));
    expect(self.role).toBe("admin");

    const suspend = await postJson<{ error: { code: string } }>(
      usersUrl(target, `/${self.id}/suspend`),
      { version: self.version },
      adminHeaders(admin),
    );
    expect(suspend.status).toBe(409);
    expect(suspend.body.error.code).toBe("LAST_ENTERPRISE_ADMIN");

    const demote = await fetch(usersUrl(target, `/${self.id}/role`), {
      method: "PUT",
      headers: adminHeaders(admin),
      body: JSON.stringify({ role: "member", version: self.version }),
    });
    expect(demote.status).toBe(409);
    expect((await demote.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "LAST_ENTERPRISE_ADMIN" },
    });
  });

  test("stale versions are rejected and unknown ids are non-enumerating", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "7101");

    const stale = await postJson<{ error: { code: string } }>(
      usersUrl(target, `/${added.body.enterprise_user.id}/suspend`),
      { version: added.body.enterprise_user.version + 5 },
      adminHeaders(admin),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");

    const missing = await getJson(usersUrl(target, "/eum_does_not_exist"), {
      Cookie: `fp_session=${admin.session}`,
    });
    expect(missing.status).toBe(404);
    const wrongEnterprise = await getJson(
      `${target.base}/api/v1/admin/enterprises/ent_other/users/${added.body.enterprise_user.id}`,
      { Cookie: `fp_session=${admin.session}` },
    );
    expect(wrongEnterprise.status).toBe(403);
  });

  test("global account suspension is deployment-only; enterprise suspension is not", async () => {
    const target = await app();
    const admin = await loginAdmin(target);
    const added = await addUser(target, admin, "7201");
    const member = await loginAs(target, { id: 7201, login: "member" });
    const claimed = await findUserBySubject(target, admin, "7201");
    expect(claimed.status).toBe("active");

    // A session administrator cannot reach the deployment-wide switch…
    const denied = await postJson(
      `${target.base}/api/v1/admin/users/${member.userId}/suspend`,
      {},
      adminHeaders(admin),
    );
    expect(denied.status).toBe(403);

    // …but the enterprise-scoped route is exactly theirs.
    const scoped = await postJson<EnterpriseUserBody>(
      usersUrl(target, `/${added.body.enterprise_user.id}/suspend`),
      { version: claimed.version },
      adminHeaders(admin),
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.status).toBe("suspended");

    // The deployment operator retains the global action.
    const operator = await fetch(`${target.base}/api/v1/admin/users/${member.userId}/suspend`, {
      method: "POST",
      headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    });
    expect(operator.status).toBe(200);
  });
});
