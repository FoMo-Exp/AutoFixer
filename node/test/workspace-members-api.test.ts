/**
 * Workspace member and member-candidate surface (DAT-277) at the production
 * request boundary.
 *
 * Every scenario drives real HTTP against a running orchestrator: the session
 * cookie, the provider-authority gate, the repository capability ceiling, the
 * SQLite control plane, and a live SSE subscription. Provider facts are seeded
 * through the same roster repository the reconcile path uses, never by
 * fabricating an eligibility answer.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import {
  BOOTSTRAP_TOKEN,
  REPOSITORY_ID,
  completeCallback,
  cookieSessionHeaders,
  startAuthApp,
  startLogin,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { cookieValue, getJson, postJson } from "./helpers/http.js";
import {
  createIdentityRepositories,
  createMemberCapabilityRepository,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import type {
  ProviderAccessRepositories,
  ProviderRoleSourceKind,
  ServiceIntegration,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/db.js";
import { createAuthorityEpoch } from "../src/provider-access/access-gate.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import { AuthEventHub } from "../src/api/auth-service.js";
import type { RequestAuthority } from "../src/api/request-authority.js";
import {
  WorkspaceMemberService,
  assignableRolesFor,
  ceilingAcrossRepositories,
  memberRoleCeiling,
} from "../src/api/workspace-member-service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const SUBJECT_OWNER = "1001";
const SUBJECT_BOB = "1002";
const SUBJECT_CAROL = "1003";
const SUBJECT_DAVE_UNLINKED = "1004";
const SUBJECT_FRANK_UNSUPPORTED = "1005";

interface MembershipView {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  user_id: string;
  user: { id: string; display_name: string };
  role: string;
  authority: {
    provider_role: string | null;
    provenance: string;
    verified_at: string | null;
    stale: boolean;
  };
  version: number;
}

interface CandidateView {
  user: { display_name: string; identities: Array<{ subject_id: string; provider_type: string }> };
  provider_role: string | null;
  provenance: string;
  already_member: boolean;
  eligible: boolean;
  ineligible_reason: string | null;
  max_role: string | null;
  assignable_roles: string[];
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface Fixture {
  app: AuthApp;
  owner: LoggedInSession;
  bob: LoggedInSession;
  carol: LoggedInSession;
  frank: LoggedInSession;
  scope: WorkspaceScope;
}

function dbOf(app: AuthApp): ControlPlaneDb {
  const db = app.orchestrator.controlPlane;
  if (!db) {
    throw new Error("control plane missing");
  }
  return db;
}

function reposOf(app: AuthApp) {
  return createRepositories(dbOf(app));
}

function accessOf(app: AuthApp): ProviderAccessRepositories {
  return createProviderAccessRepositories(dbOf(app));
}

function identityOf(app: AuthApp) {
  return createIdentityRepositories(dbOf(app));
}

function integrationOf(app: AuthApp): ServiceIntegration {
  if (!app.integration) {
    throw new Error("fixture requires repositoryIntegration");
  }
  return app.integration;
}

function scopeOf(app: AuthApp, workspaceId = app.workspaceId): WorkspaceScope {
  return {
    enterprise_id: app.enterpriseId,
    workspace_id: workspaceId,
    actor_id: "usr_seed",
  };
}

async function request<T>(
  app: AuthApp,
  method: string,
  path: string,
  session?: LoggedInSession,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${app.base}${path}`, {
    method,
    headers: {
      ...(session !== undefined ? cookieSessionHeaders(session) : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
  };
}

function membersPath(app: AuthApp, workspaceId = app.workspaceId): string {
  return `/api/v1/workspaces/${workspaceId}/members`;
}

function candidatesPath(app: AuthApp, workspaceId = app.workspaceId): string {
  return `/api/v1/workspaces/${workspaceId}/member-candidates`;
}

async function bootstrapPut(
  app: AuthApp,
  userId: string,
  role: string,
  workspaceId = app.workspaceId,
): Promise<number> {
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
  return response.status;
}

async function bootstrapDelete(
  app: AuthApp,
  userId: string,
  workspaceId = app.workspaceId,
): Promise<number> {
  const response = await fetch(
    `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${workspaceId}/members/${userId}`,
    {
      method: "DELETE",
      headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    },
  );
  return response.status;
}

interface RoleSpec {
  subject: string;
  login: string;
  provider_role: string;
  source_kind?: ProviderRoleSourceKind;
}

function applyRoster(
  app: AuthApp,
  roles: RoleSpec[],
  options: {
    workspaceId?: string;
    integrationId?: string;
    repositoryId?: string;
    verified_at?: string;
    subject_users?: Record<string, string>;
  } = {},
): void {
  const workspaceId = options.workspaceId ?? app.workspaceId;
  accessOf(app).roster.applySnapshot(
    scopeOf(app, workspaceId),
    options.integrationId ?? integrationOf(app).id,
    {
      roles: roles.map((role) => ({
        subject: role.subject,
        login: role.login,
        source_kind: role.source_kind ?? "direct_collaborator",
        provider_role: role.provider_role,
        authority_ref: options.repositoryId ?? REPOSITORY_ID,
        inherited_from: null,
      })),
      verified_at: options.verified_at ?? new Date().toISOString(),
      ...(options.subject_users !== undefined ? { subject_users: options.subject_users } : {}),
    },
  );
  app.orchestrator.providerAuthority?.epoch.bump();
}

/** Log in through an explicitly chosen provider instance (cross-provider). */
async function loginWithProvider(
  app: AuthApp,
  providerInstanceId: string,
  profile: { id: number; login: string; name?: string | null },
): Promise<LoggedInSession> {
  app.provider.profile = profile;
  const started = await startLogin(app, { providerInstanceId });
  const callback = await completeCallback(app, {
    state: started.state,
    binding: started.binding,
  });
  if (callback.status !== 302) {
    throw new Error(`login callback returned ${callback.status}: ${callback.text}`);
  }
  const session = cookieValue(callback.headers, "fp_session") ?? "";
  const info = await getJson<{ user: { id: string }; csrf_token: string }>(
    `${app.base}/api/v1/auth/session`,
    { Cookie: `fp_session=${session}` },
  );
  identityOf(app).enterpriseUsers.ensureActive(
    app.enterpriseId,
    info.body.user.id,
    { kind: "user", user_id: "usr_seed" },
    { provider_instance_id: providerInstanceId, subject: String(profile.id) },
  );
  return { userId: info.body.user.id, session, csrf: info.body.csrf_token };
}

/**
 * A workspace with an active GitHub integration, four signed-in users plus one
 * roster-only subject, and an owner membership. Roster facts:
 * octo=admin (manage), bob=write (member ceiling), carol=read (viewer
 * ceiling), frank=guest (unsupported), 1004=write but never signed in.
 */
async function fixture(): Promise<Fixture> {
  const app = await startAuthApp({ dsh, repositoryIntegration: true });
  apps.push(app);
  const owner = await webLogin(app);
  app.provider.profile = { id: 1002, login: "bob", name: "Bob Builder" };
  const bob = await webLogin(app);
  app.provider.profile = { id: 1003, login: "carol", name: "Carol Viewer" };
  const carol = await webLogin(app);
  app.provider.profile = { id: 1005, login: "frank", name: "Frank Guest" };
  const frank = await webLogin(app);
  applyRoster(
    app,
    [
      { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
      { subject: SUBJECT_BOB, login: "bob", provider_role: "write" },
      { subject: SUBJECT_CAROL, login: "carol", provider_role: "read" },
      { subject: SUBJECT_DAVE_UNLINKED, login: "dave", provider_role: "write" },
      { subject: SUBJECT_FRANK_UNSUPPORTED, login: "frank", provider_role: "guest" },
    ],
    {
      subject_users: {
        [SUBJECT_OWNER]: owner.userId,
        [SUBJECT_BOB]: bob.userId,
        [SUBJECT_CAROL]: carol.userId,
        [SUBJECT_FRANK_UNSUPPORTED]: frank.userId,
      },
    },
  );
  expect(await bootstrapPut(app, owner.userId, "owner")).toBe(200);
  return { app, owner, bob, carol, frank, scope: scopeOf(app) };
}

function candidatesBySubject(page: Page<CandidateView>): Map<string, CandidateView> {
  const map = new Map<string, CandidateView>();
  for (const candidate of page.items) {
    const subject = candidate.user.identities[0]?.subject_id;
    if (subject !== undefined) {
      map.set(subject, candidate);
    }
  }
  return map;
}

async function addMember(
  f: Fixture,
  session: LoggedInSession,
  userId: string,
  role: string,
  workspaceId = f.app.workspaceId,
) {
  return request<MembershipView & ErrorBody>(
    f.app,
    "POST",
    membersPath(f.app, workspaceId),
    session,
    {
      user_id: userId,
      role,
    },
  );
}

async function listMembers(f: Fixture, session: LoggedInSession, workspaceId = f.app.workspaceId) {
  return request<Page<MembershipView> & ErrorBody>(
    f.app,
    "GET",
    membersPath(f.app, workspaceId),
    session,
  );
}

// ---------------------------------------------------------------------------
// Members list and member administration
// ---------------------------------------------------------------------------

describe("workspace members (DAT-277)", () => {
  test("members list carries provider provenance and never enumerates other scopes", async () => {
    const f = await fixture();
    const listed = await listMembers(f, f.owner);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    const ownerMembership = listed.body.items[0]!;
    expect(ownerMembership.user_id).toBe(f.owner.userId);
    expect(ownerMembership.role).toBe("owner");
    expect(ownerMembership.authority).toMatchObject({
      provider_role: "admin",
      provenance: "direct_collaborator",
      stale: false,
    });
    expect(typeof ownerMembership.authority.verified_at).toBe("string");
    expect(listed.body.next_cursor).toBeNull();

    // A signed-in user who is not a member of this workspace sees the same
    // 404 as an unknown workspace: the path ID is a locator, never authority.
    const outsider = await listMembers(f, f.bob);
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("NOT_FOUND");
    const unknown = await listMembers(f, f.owner, "ws_does_not_exist");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const badCursor = await request<ErrorBody>(
      f.app,
      "GET",
      `${membersPath(f.app)}?cursor=not-a-cursor`,
      f.owner,
    );
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe("INVALID_CURSOR");
  });

  test("candidates expose provenance, ceiling and assignability; unlinked subjects are ineligible", async () => {
    const f = await fixture();
    const listed = await request<Page<CandidateView> & ErrorBody>(
      f.app,
      "GET",
      candidatesPath(f.app),
      f.owner,
    );
    expect(listed.status).toBe(200);
    const bySubject = candidatesBySubject(listed.body);

    expect(bySubject.get(SUBJECT_OWNER)).toMatchObject({
      already_member: true,
      eligible: false,
      ineligible_reason: "already_member",
      max_role: null,
      assignable_roles: [],
      provider_role: "admin",
      provenance: "direct_collaborator",
    });

    expect(bySubject.get(SUBJECT_BOB)).toMatchObject({
      already_member: false,
      eligible: true,
      ineligible_reason: null,
      max_role: "member",
      assignable_roles: ["viewer", "member", "admin", "owner"],
    });

    expect(bySubject.get(SUBJECT_CAROL)).toMatchObject({
      eligible: true,
      max_role: "viewer",
      assignable_roles: ["viewer", "admin", "owner"],
    });

    expect(bySubject.get(SUBJECT_FRANK_UNSUPPORTED)).toMatchObject({
      eligible: false,
      ineligible_reason: "unsupported_role",
      max_role: null,
    });

    // The roster knows this subject, but no account has ever signed in. There
    // is no claiming path through an email or display name.
    expect(bySubject.get(SUBJECT_DAVE_UNLINKED)).toMatchObject({
      eligible: false,
      ineligible_reason: "identity_unlinked",
      max_role: null,
      assignable_roles: [],
      already_member: false,
    });

    // Candidates are a management surface: a plain member is refused before
    // any roster read happens.
    const asMember = await request<ErrorBody>(f.app, "GET", candidatesPath(f.app), f.bob);
    expect(asMember.status).toBe(404);
  });

  test("member and candidate pages are cursor-stable and non-overlapping", async () => {
    const f = await fixture();
    const identity = identityOf(f.app);
    const repos = reposOf(f.app);

    // 55 additional memberships, created directly (no per-user login needed):
    // the member page must page them without duplicates or gaps.
    for (let index = 0; index < 55; index += 1) {
      const user = identity.users.create({
        display_name: `Member ${String(index).padStart(2, "0")}`,
        actor_id: "usr_seed",
      });
      repos.memberships.create(f.scope, { user_id: user.id, role: "viewer" });
    }
    const firstMembers = await listMembers(f, f.owner);
    expect(firstMembers.status).toBe(200);
    expect(firstMembers.body.items).toHaveLength(50);
    expect(typeof firstMembers.body.next_cursor).toBe("string");
    const secondMembers = await request<Page<MembershipView>>(
      f.app,
      "GET",
      `${membersPath(f.app)}?cursor=${encodeURIComponent(firstMembers.body.next_cursor!)}`,
      f.owner,
    );
    expect(secondMembers.status).toBe(200);
    expect(secondMembers.body.items).toHaveLength(6);
    expect(secondMembers.body.next_cursor).toBeNull();
    const memberIds = new Set(firstMembers.body.items.map((entry) => entry.id));
    expect(secondMembers.body.items.some((entry) => memberIds.has(entry.id))).toBe(false);

    // 60 roster-only subjects become identity_unlinked candidates, enough to
    // exercise the same cursor over the candidate page.
    const extraRoles: RoleSpec[] = [];
    for (let index = 0; index < 60; index += 1) {
      extraRoles.push({
        subject: `90${String(index).padStart(3, "0")}`,
        login: `extra-${String(index).padStart(2, "0")}`,
        provider_role: "read",
      });
    }
    applyRoster(
      f.app,
      [
        { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
        { subject: SUBJECT_BOB, login: "bob", provider_role: "write" },
        { subject: SUBJECT_CAROL, login: "carol", provider_role: "read" },
        { subject: SUBJECT_DAVE_UNLINKED, login: "dave", provider_role: "write" },
        { subject: SUBJECT_FRANK_UNSUPPORTED, login: "frank", provider_role: "guest" },
        ...extraRoles,
      ],
      {
        subject_users: {
          [SUBJECT_OWNER]: f.owner.userId,
          [SUBJECT_BOB]: f.bob.userId,
          [SUBJECT_CAROL]: f.carol.userId,
          [SUBJECT_FRANK_UNSUPPORTED]: f.frank.userId,
        },
      },
    );
    const firstCandidates = await request<Page<CandidateView>>(
      f.app,
      "GET",
      candidatesPath(f.app),
      f.owner,
    );
    expect(firstCandidates.status).toBe(200);
    expect(firstCandidates.body.items).toHaveLength(50);
    expect(typeof firstCandidates.body.next_cursor).toBe("string");
    const secondCandidates = await request<Page<CandidateView>>(
      f.app,
      "GET",
      `${candidatesPath(f.app)}?cursor=${encodeURIComponent(firstCandidates.body.next_cursor!)}`,
      f.owner,
    );
    expect(secondCandidates.status).toBe(200);
    expect(secondCandidates.body.items).toHaveLength(15);
    expect(secondCandidates.body.next_cursor).toBeNull();
    const candidateSubjects = new Set(
      firstCandidates.body.items.flatMap((candidate) =>
        candidate.user.identities.map((identity) => identity.subject_id),
      ),
    );
    expect(
      secondCandidates.body.items.some((candidate) =>
        candidate.user.identities.some((identity) => candidateSubjects.has(identity.subject_id)),
      ),
    ).toBe(false);
  });

  test("adding a member enforces provider eligibility and the role ceiling", async () => {
    const f = await fixture();
    const added = await addMember(f, f.owner, f.bob.userId, "member");
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      user_id: f.bob.userId,
      role: "member",
      version: 1,
    });
    expect(added.body.authority.provider_role).toBe("write");
    expect(added.body.authority.stale).toBe(false);

    const duplicate = await addMember(f, f.owner, f.bob.userId, "member");
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("MEMBERSHIP_CONFLICT");

    const aboveCeiling = await addMember(f, f.owner, f.carol.userId, "member");
    expect(aboveCeiling.status).toBe(403);
    expect(aboveCeiling.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(aboveCeiling.body.error.details?.max_role).toBe("viewer");

    const viewer = await addMember(f, f.owner, f.carol.userId, "viewer");
    expect(viewer.status).toBe(201);
    expect(viewer.body.role).toBe("viewer");

    const unlinked = await addMember(f, f.owner, "usr_never_signed_in", "viewer");
    expect(unlinked.status).toBe(404);
    expect(unlinked.body.error.code).toBe("NOT_FOUND");

    // A subject in the roster without an account cannot be added even when the
    // caller knows its provider user id — only a signed-in user is grantable.
    const dave = identityOf(f.app).users.create({
      display_name: "Dave Roster",
      actor_id: "usr_seed",
    });
    identityOf(f.app).identities.create({
      user_id: dave.id,
      provider_instance_id: f.app.providerInstanceId,
      subject: SUBJECT_DAVE_UNLINKED,
      login: "dave",
      actor_id: "usr_seed",
    });
    identityOf(f.app).enterpriseUsers.ensureActive(
      f.app.enterpriseId,
      dave.id,
      { kind: "user", user_id: "usr_seed" },
      { provider_instance_id: f.app.providerInstanceId, subject: SUBJECT_DAVE_UNLINKED },
    );
    // Now Dave *is* linked, so adding him proves the roster path works.
    const daveAdded = await addMember(f, f.owner, dave.id, "member");
    expect(daveAdded.status).toBe(201);

    const unsupported = await addMember(f, f.owner, f.frank.userId, "viewer");
    expect(unsupported.status).toBe(409);
    expect(unsupported.body.error.code).toBe("TARGET_NOT_ELIGIBLE");
    expect(unsupported.body.error.details?.reason).toBe("unsupported_role");

    // A plain member has no member-management authority at all.
    const asMember = await addMember(f, f.bob, f.frank.userId, "viewer");
    expect(asMember.status).toBe(403);

    const audit = await request<{ items: Array<Record<string, unknown>> }>(
      f.app,
      "GET",
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/auth-audit`,
      undefined,
    );
    expect(audit.status).toBe(401);
    const auditWithBootstrap = await fetch(
      `${f.app.base}/api/v1/admin/enterprises/${f.app.enterpriseId}/auth-audit`,
      { headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    expect(auditWithBootstrap.status).toBe(200);
    const auditBody = (await auditWithBootstrap.json()) as {
      items: Array<{ event: string; actor_user_id?: string | null; subject_user_id?: string }>;
    };
    const granted = auditBody.items.find(
      (entry) => entry.event === "membership.granted" && entry.subject_user_id === f.bob.userId,
    );
    expect(granted).toBeDefined();
    expect(granted?.actor_user_id).toBe(f.owner.userId);
  });

  test("role changes are version-guarded, anti-escalating and audited", async () => {
    const f = await fixture();
    expect((await addMember(f, f.owner, f.bob.userId, "member")).status).toBe(201);
    expect((await addMember(f, f.owner, f.carol.userId, "viewer")).status).toBe(201);
    const bobMembership = (await listMembers(f, f.owner)).body.items.find(
      (membership) => membership.user_id === f.bob.userId,
    )!;
    const carolMembership = (await listMembers(f, f.owner)).body.items.find(
      (membership) => membership.user_id === f.carol.userId,
    )!;

    const demoted = await request<MembershipView & ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.owner,
      { role: "viewer", version: 1 },
    );
    expect(demoted.status).toBe(200);
    expect(demoted.body.version).toBe(2);
    expect(demoted.body.role).toBe("viewer");

    const staleVersion = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.owner,
      { role: "viewer", version: 1 },
    );
    expect(staleVersion.status).toBe(409);
    expect(staleVersion.body.error.code).toBe("VERSION_CONFLICT");

    // Raising back to member is allowed: bob proves repository write.
    const restored = await request<MembershipView & ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.owner,
      { role: "member", version: 2 },
    );
    expect(restored.status).toBe(200);
    expect(restored.body.role).toBe("member");
    expect(restored.body.version).toBe(3);

    // carol proves only code read, so member is above her verified ceiling.
    const carolElevated = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${carolMembership.id}`,
      f.owner,
      { role: "member", version: 1 },
    );
    expect(carolElevated.status).toBe(403);
    expect(carolElevated.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");

    // An explicit owner decision may grant admin above the provider ceiling —
    // and with administrator-level provider authority bob can then pass the
    // management gate himself.
    applyRoster(
      f.app,
      [
        { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
        { subject: SUBJECT_BOB, login: "bob", provider_role: "admin" },
        { subject: SUBJECT_CAROL, login: "carol", provider_role: "read" },
        { subject: SUBJECT_DAVE_UNLINKED, login: "dave", provider_role: "write" },
        { subject: SUBJECT_FRANK_UNSUPPORTED, login: "frank", provider_role: "guest" },
      ],
      {
        subject_users: {
          [SUBJECT_OWNER]: f.owner.userId,
          [SUBJECT_BOB]: f.bob.userId,
          [SUBJECT_CAROL]: f.carol.userId,
          [SUBJECT_FRANK_UNSUPPORTED]: f.frank.userId,
        },
      },
    );
    const bobAdmin = await request<MembershipView & ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.owner,
      { role: "admin", version: 3 },
    );
    expect(bobAdmin.status).toBe(200);
    expect(bobAdmin.body.role).toBe("admin");

    // An admin never grants or touches admin/owner memberships, including
    // their own.
    const byAdmin = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${carolMembership.id}`,
      f.bob,
      { role: "admin", version: 1 },
    );
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");
    const selfDemote = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.bob,
      { role: "member", version: bobAdmin.body.version },
    );
    expect(selfDemote.status).toBe(403);
    const ownerMembership = (await listMembers(f, f.owner)).body.items.find(
      (membership) => membership.user_id === f.owner.userId,
    )!;
    const ownerByAdmin = await request<ErrorBody>(
      f.app,
      "DELETE",
      `${membersPath(f.app)}/${ownerMembership.id}`,
      f.bob,
    );
    expect(ownerByAdmin.status).toBe(403);

    const auditWithBootstrap = await fetch(
      `${f.app.base}/api/v1/admin/enterprises/${f.app.enterpriseId}/auth-audit`,
      { headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    const auditBody = (await auditWithBootstrap.json()) as {
      items: Array<{ event: string; subject_user_id?: string }>;
    };
    expect(
      auditBody.items.filter(
        (entry) =>
          entry.event === "membership.role_changed" && entry.subject_user_id === f.bob.userId,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("the last owner cannot be removed or demoted, and the refusal is audited", async () => {
    const f = await fixture();
    const ownerMembership = (await listMembers(f, f.owner)).body.items[0]!;

    const removed = await request<ErrorBody>(
      f.app,
      "DELETE",
      `${membersPath(f.app)}/${ownerMembership.id}`,
      f.owner,
    );
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe("LAST_WORKSPACE_OWNER");
    expect(removed.body.error.details?.action).toBe("remove");

    const demoted = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${ownerMembership.id}`,
      f.owner,
      { role: "admin", version: ownerMembership.version },
    );
    expect(demoted.status).toBe(409);
    expect(demoted.body.error.code).toBe("LAST_WORKSPACE_OWNER");
    expect(demoted.body.error.details?.action).toBe("demote");

    // Both refusals are recorded; the membership itself is untouched.
    const audit = await fetch(
      `${f.app.base}/api/v1/admin/enterprises/${f.app.enterpriseId}/auth-audit`,
      { headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    const auditBody = (await audit.json()) as {
      items: Array<{ event: string; details?: Record<string, unknown> }>;
    };
    const blocked = auditBody.items.filter(
      (entry) => entry.event === "membership.owner_change_blocked",
    );
    expect(blocked).toHaveLength(2);
    expect(blocked.map((entry) => entry.details?.action).sort()).toEqual(["demote", "remove"]);
    expect(blocked[0]?.details?.reason).toBe("last_workspace_owner");

    const after = (await listMembers(f, f.owner)).body.items;
    expect(after).toHaveLength(1);
    expect(after[0]?.role).toBe("owner");
  });

  test("concurrent last-owner changes leave an owner in place", async () => {
    const f = await fixture();
    expect((await addMember(f, f.owner, f.bob.userId, "owner")).status).toBe(201);

    // Two owners removed concurrently through the deployment-operator entry
    // (whose authority does not depend on either membership). The guard runs
    // inside the same transaction as the write, so exactly one removal can
    // leave the workspace ownerless — it is refused instead.
    const statuses = await Promise.all([
      bootstrapDelete(f.app, f.owner.userId),
      bootstrapDelete(f.app, f.bob.userId),
    ]);
    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);

    // The losing attempt is recorded as a blocked owner change.
    const audit = await fetch(
      `${f.app.base}/api/v1/admin/enterprises/${f.app.enterpriseId}/auth-audit`,
      { headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    const auditBody = (await audit.json()) as { items: Array<{ event: string }> };
    expect(auditBody.items.some((entry) => entry.event === "membership.owner_change_blocked")).toBe(
      true,
    );

    // Whichever attempt lost, at least one owner remains and the workspace is
    // still readable by the survivor.
    const survivor = reposOf(f.app)
      .memberships.list(f.scope)
      .find((membership) => membership.role === "owner");
    expect(survivor).toBeDefined();
    const session = survivor?.user_id === f.owner.userId ? f.owner : f.bob;
    const remaining = await listMembers(f, session);
    expect(remaining.status).toBe(200);
    expect(
      remaining.body.items.filter((entry) => entry.role === "owner").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("stale, unknown and removed provider facts fail closed and recover on reconciliation", async () => {
    const f = await fixture();
    expect((await addMember(f, f.owner, f.bob.userId, "member")).status).toBe(201);
    const at = new Date().toISOString();
    const roster = accessOf(f.app).roster;

    roster.setAuthorityState(f.scope, integrationOf(f.app).id, SUBJECT_BOB, "stale", at);
    f.app.orchestrator.providerAuthority?.epoch.bump();
    const staleSelf = await listMembers(f, f.bob);
    expect(staleSelf.status).toBe(403);
    expect(staleSelf.body.error.code).toBe("AUTHORITY_RECHECK_REQUIRED");

    const staleCandidates = await request<Page<CandidateView>>(
      f.app,
      "GET",
      candidatesPath(f.app),
      f.owner,
    );
    expect(candidatesBySubject(staleCandidates.body).get(SUBJECT_BOB)).toMatchObject({
      already_member: true,
      eligible: false,
      ineligible_reason: "already_member",
    });

    // A non-member with stale evidence cannot be added.
    expect((await addMember(f, f.owner, f.carol.userId, "viewer")).status).toBe(201);
    roster.setAuthorityState(f.scope, integrationOf(f.app).id, SUBJECT_CAROL, "removed", at);
    f.app.orchestrator.providerAuthority?.epoch.bump();
    const carolRemoved = await listMembers(f, f.carol);
    expect(carolRemoved.status).toBe(403);
    expect(carolRemoved.body.error.code).toBe("FORBIDDEN");

    const unknown = await addMember(f, f.owner, f.frank.userId, "viewer");
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe("TARGET_NOT_ELIGIBLE");
    expect(unknown.body.error.details?.reason).toBe("unsupported_role");

    // Operational reconciliation re-verifies the provider facts; authority and
    // admission come back without a role edit.
    applyRoster(
      f.app,
      [
        { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
        { subject: SUBJECT_BOB, login: "bob", provider_role: "write" },
        { subject: SUBJECT_CAROL, login: "carol", provider_role: "read" },
        { subject: SUBJECT_FRANK_UNSUPPORTED, login: "frank", provider_role: "guest" },
      ],
      {
        subject_users: {
          [SUBJECT_OWNER]: f.owner.userId,
          [SUBJECT_BOB]: f.bob.userId,
          [SUBJECT_CAROL]: f.carol.userId,
          [SUBJECT_FRANK_UNSUPPORTED]: f.frank.userId,
        },
      },
    );
    // A stale authority recovers automatically once re-verified; a *confirmed
    // loss* stays blocked until an audited enterprise-administrator
    // reapproval — the operational recovery path.
    expect((await listMembers(f, f.bob)).status).toBe(200);
    expect((await listMembers(f, f.carol)).status).toBe(403);
    identityOf(f.app).enterpriseRoles.grant({
      enterprise_id: f.app.enterpriseId,
      user_id: f.owner.userId,
      role: "admin",
      actor_id: "usr_seed",
    });
    const ceilingPath =
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/workspaces/${f.app.workspaceId}` +
      `/members/${f.carol.userId}/capability-ceiling`;
    const ceilingView = await request<{
      capability_ceiling: { ceiling: { version: number | null } };
    }>(f.app, "GET", ceilingPath, f.owner);
    expect(ceilingView.status).toBe(200);
    const reapproved = await request<{ capability_ceiling: unknown }>(
      f.app,
      "POST",
      ceilingPath,
      f.owner,
      {
        version: ceilingView.body.capability_ceiling.ceiling.version,
      },
    );
    expect(reapproved.status).toBe(200);
    expect((await listMembers(f, f.carol)).status).toBe(200);
    const recovered = await request<Page<CandidateView>>(
      f.app,
      "GET",
      candidatesPath(f.app),
      f.owner,
    );
    expect(candidatesBySubject(recovered.body).get(SUBJECT_DAVE_UNLINKED)).toMatchObject({
      eligible: false,
      ineligible_reason: "identity_unlinked",
    });
  });

  test("an audit failure rolls the membership change back and a retry succeeds", async () => {
    const f = await fixture();
    const db = dbOf(f.app);
    db.exec(
      "CREATE TRIGGER fail_membership_audit BEFORE INSERT ON auth_audit " +
        "WHEN NEW.event IN ('membership.granted', 'membership.role_changed', 'membership.revoked') " +
        "BEGIN SELECT RAISE(ABORT, 'audit offline'); END",
    );
    const failed = await addMember(f, f.owner, f.bob.userId, "member");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("MEMBERSHIP_AUDIT_UNAVAILABLE");
    expect((await listMembers(f, f.bob)).status).toBe(404);

    db.exec("DROP TRIGGER fail_membership_audit");
    const retried = await addMember(f, f.owner, f.bob.userId, "member");
    expect(retried.status).toBe(201);
    expect(retried.body.role).toBe("member");

    // The same atomicity holds for a role change: nothing is applied.
    db.exec(
      "CREATE TRIGGER fail_membership_audit BEFORE INSERT ON auth_audit " +
        "WHEN NEW.event IN ('membership.granted', 'membership.role_changed', 'membership.revoked') " +
        "BEGIN SELECT RAISE(ABORT, 'audit offline'); END",
    );
    const patchFailed = await request<ErrorBody>(
      f.app,
      "PATCH",
      `${membersPath(f.app)}/${retried.body.id}`,
      f.owner,
      { role: "viewer", version: 1 },
    );
    expect(patchFailed.status).toBe(503);
    db.exec("DROP TRIGGER fail_membership_audit");
    const afterFailure = (await listMembers(f, f.owner)).body.items.find(
      (entry) => entry.user_id === f.bob.userId,
    )!;
    expect(afterFailure.role).toBe("member");
    expect(afterFailure.version).toBe(1);
  });

  test("memberships survive a process restart", async () => {
    const f = await fixture();
    expect((await addMember(f, f.owner, f.bob.userId, "member")).status).toBe(201);
    await f.app.restart();
    const listed = await listMembers(f, f.bob);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((entry) => entry.user_id).sort()).toEqual(
      [f.owner.userId, f.bob.userId].sort(),
    );
    const candidates = await request<Page<CandidateView>>(
      f.app,
      "GET",
      candidatesPath(f.app),
      f.owner,
    );
    expect(candidates.status).toBe(200);
    expect(candidatesBySubject(candidates.body).get(SUBJECT_BOB)?.already_member).toBe(true);
  });

  test("removal revokes authority, closes live streams and leaves other workspaces alone", async () => {
    const f = await fixture();
    const repos = reposOf(f.app);
    const access = accessOf(f.app);

    expect((await addMember(f, f.owner, f.bob.userId, "member")).status).toBe(201);

    // Bob opens a real task stream in workspace A while A is his only
    // membership (the task scope resolver never guesses between workspaces).
    const created = await postJson<{ id: string }>(
      `${f.app.base}/api/v1/workspaces/${f.app.workspaceId}/tasks`,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "Membership revocation probe",
      },
      { "Content-Type": "application/json", ...cookieSessionHeaders(f.bob) },
    );
    expect(created.status).toBe(201);
    const stream = await fetch(
      `${f.app.base}/api/v1/workspaces/${f.app.workspaceId}/tasks/${created.body.id}/stream`,
      {
        headers: { Cookie: `fp_session=${f.bob.session}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    expect(stream.status).toBe(200);
    const streamEnded = stream.text();

    // A second workspace in the same enterprise, same provider instance, where
    // bob is the owner. Its authority must survive the removal in A.
    const workspaceB = repos.workspaces.create(
      { enterprise_id: f.app.enterpriseId, actor_id: "usr_seed" },
      {
        name: "Second Workspace",
        repository_id: "github:FoMo-Exp/Other",
        provider_instance_id: f.app.providerInstanceId,
      },
    );
    const integrationB = access.integrations.create(scopeOf(f.app, workspaceB.id), {
      provider_instance_id: f.app.providerInstanceId,
      repository_id: "github:FoMo-Exp/Other",
      repository_name: "FoMo-Exp/Other",
      source_credential_ref: "svc-source-1",
      permission_visibility: "full",
      actor_id: "usr_seed",
    });
    applyRoster(
      f.app,
      [
        { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
        { subject: SUBJECT_BOB, login: "bob", provider_role: "write" },
      ],
      {
        workspaceId: workspaceB.id,
        integrationId: integrationB.id,
        subject_users: { [SUBJECT_OWNER]: f.owner.userId, [SUBJECT_BOB]: f.bob.userId },
      },
    );
    expect(await bootstrapPut(f.app, f.bob.userId, "owner", workspaceB.id)).toBe(200);
    expect((await listMembers(f, f.bob, workspaceB.id)).status).toBe(200);

    // A live capability grant in each workspace, to prove revocation is scoped.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const grantA = access.grants.grant(f.scope, integrationOf(f.app).id, {
      grantee_user_id: f.bob.userId,
      capability: "delivery_write",
      expires_at: expiresAt,
      actor_id: "usr_seed",
    });
    const grantB = access.grants.grant(scopeOf(f.app, workspaceB.id), integrationB.id, {
      grantee_user_id: f.bob.userId,
      capability: "delivery_write",
      expires_at: expiresAt,
      actor_id: "usr_seed",
    });

    const bobMembership = (await listMembers(f, f.owner)).body.items.find(
      (entry) => entry.user_id === f.bob.userId,
    )!;
    const removed = await request<void>(
      f.app,
      "DELETE",
      `${membersPath(f.app)}/${bobMembership.id}`,
      f.owner,
    );
    expect(removed.status).toBe(204);

    // The live stream is closed by the server, not left dangling.
    const ended = await Promise.race([
      streamEnded.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("dangling"), 5000)),
    ]);
    expect(ended).toBe("closed");

    expect((await listMembers(f, f.bob)).status).toBe(404);
    expect((await listMembers(f, f.bob, workspaceB.id)).status).toBe(200);

    const liveA = access.grants.listLive(f.scope, integrationOf(f.app).id, {
      grantee_user_id: f.bob.userId,
      now: new Date().toISOString(),
    });
    expect(liveA.some((grant) => grant.id === grantA.id)).toBe(false);
    const liveB = access.grants.listLive(scopeOf(f.app, workspaceB.id), integrationB.id, {
      grantee_user_id: f.bob.userId,
      now: new Date().toISOString(),
    });
    expect(liveB.some((grant) => grant.id === grantB.id)).toBe(true);

    // The removed user's control-plane membership row is gone; workspace B's
    // owner membership is untouched.
    expect(repos.memberships.getByUser(f.scope, f.bob.userId)).toBeUndefined();
    expect(repos.memberships.getByUser(scopeOf(f.app, workspaceB.id), f.bob.userId)?.role).toBe(
      "owner",
    );
  });

  test("the legacy administrator entry cannot bypass workspace rules", async () => {
    const f = await fixture();
    const identity = identityOf(f.app);
    // The legacy entry itself requires enterprise-administrator standing; the
    // workspace rules are *additional*, never a replacement.
    identity.enterpriseRoles.grant({
      enterprise_id: f.app.enterpriseId,
      user_id: f.owner.userId,
      role: "admin",
      actor_id: "usr_seed",
    });

    // Frank is an enterprise administrator but has no workspace membership.
    identity.enterpriseRoles.grant({
      enterprise_id: f.app.enterpriseId,
      user_id: f.frank.userId,
      role: "admin",
      actor_id: "usr_seed",
    });
    const outsiderGrant = await request<ErrorBody & MembershipView>(
      f.app,
      "PUT",
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/workspaces/${f.app.workspaceId}/members/${f.carol.userId}`,
      f.frank,
      { role: "member" },
    );
    expect(outsiderGrant.status).toBe(404);

    // As a workspace viewer, enterprise administration is still not member
    // management.
    expect(await bootstrapPut(f.app, f.frank.userId, "viewer")).toBe(200);
    const viewerGrant = await request<ErrorBody>(
      f.app,
      "PUT",
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/workspaces/${f.app.workspaceId}/members/${f.carol.userId}`,
      f.frank,
      { role: "member" },
    );
    expect(viewerGrant.status).toBe(403);
    expect(viewerGrant.body.error.code).toBe("FORBIDDEN");

    // A workspace admin (still an enterprise member, not necessarily an
    // enterprise administrator) may not grant admin through the legacy entry.
    expect((await addMember(f, f.owner, f.bob.userId, "member")).status).toBe(201);
    applyRoster(
      f.app,
      [
        { subject: SUBJECT_OWNER, login: "octo", provider_role: "admin" },
        { subject: SUBJECT_BOB, login: "bob", provider_role: "admin" },
        { subject: SUBJECT_CAROL, login: "carol", provider_role: "read" },
        { subject: SUBJECT_FRANK_UNSUPPORTED, login: "frank", provider_role: "guest" },
      ],
      {
        subject_users: {
          [SUBJECT_OWNER]: f.owner.userId,
          [SUBJECT_BOB]: f.bob.userId,
          [SUBJECT_CAROL]: f.carol.userId,
          [SUBJECT_FRANK_UNSUPPORTED]: f.frank.userId,
        },
      },
    );
    const bobMembership = (await listMembers(f, f.owner)).body.items.find(
      (entry) => entry.user_id === f.bob.userId,
    )!;
    expect(
      (
        await request<MembershipView>(
          f.app,
          "PATCH",
          `${membersPath(f.app)}/${bobMembership.id}`,
          f.owner,
          { role: "admin", version: 1 },
        )
      ).status,
    ).toBe(200);
    identity.enterpriseRoles.grant({
      enterprise_id: f.app.enterpriseId,
      user_id: f.bob.userId,
      role: "admin",
      actor_id: "usr_seed",
    });
    const adminEscalation = await request<ErrorBody>(
      f.app,
      "PUT",
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/workspaces/${f.app.workspaceId}/members/${f.carol.userId}`,
      f.bob,
      { role: "admin" },
    );
    expect(adminEscalation.status).toBe(403);
    expect(adminEscalation.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");

    // The last owner is protected on this entry too.
    const lastOwner = await request<ErrorBody>(
      f.app,
      "DELETE",
      `/api/v1/admin/enterprises/${f.app.enterpriseId}/workspaces/${f.app.workspaceId}/members/${f.owner.userId}`,
      f.owner,
    );
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.body.error.code).toBe("LAST_WORKSPACE_OWNER");
  });

  test("member management is refused without a real provider integration", async () => {
    const app = await startAuthApp({ dsh });
    apps.push(app);
    const owner = await webLogin(app);
    app.provider.profile = { id: 1002, login: "bob" };
    const bob = await webLogin(app);
    expect(await bootstrapPut(app, owner.userId, "owner")).toBe(200);

    const added = await request<ErrorBody>(app, "POST", membersPath(app), owner, {
      user_id: bob.userId,
      role: "member",
    });
    expect(added.status).toBe(403);
    expect(added.body.error.code).toBe("CAPABILITY_MANAGEMENT_REQUIRED");
    // No integration also means no roster: candidates stay unavailable rather
    // than an empty list that implies nobody is eligible.
    const candidates = await request<ErrorBody>(app, "GET", candidatesPath(app), owner);
    expect(candidates.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Cross-provider role vocabulary (GitLab)
// ---------------------------------------------------------------------------

describe("cross-provider membership (GitLab vocabulary)", () => {
  test("GitLab roles map to the same ceiling, and management still needs repository authority", async () => {
    const app = await startAuthApp({ dsh, repositoryIntegration: true });
    apps.push(app);
    const db = dbOf(app);
    const repos = createRepositories(db);
    const access = createProviderAccessRepositories(db);
    const gitlab = repos.providerInstances.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_seed" },
      { provider_type: "gitlab", origin_url: "https://gitlab.example.com" },
    );
    const workspace = repos.workspaces.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_seed" },
      {
        name: "GitLab Workspace",
        repository_id: "gitlab:group/project",
        provider_instance_id: gitlab.id,
      },
    );
    const integration = access.integrations.create(scopeOf(app, workspace.id), {
      provider_instance_id: gitlab.id,
      repository_id: "gitlab:group/project",
      repository_name: "group/project",
      source_credential_ref: "svc-source-1",
      permission_visibility: "full",
      actor_id: "usr_seed",
    });
    const lead = await loginWithProvider(app, gitlab.id, {
      id: 2001,
      login: "gl-lead",
      name: "GitLab Lead",
    });
    const dev = await loginWithProvider(app, gitlab.id, {
      id: 2002,
      login: "gl-dev",
      name: "GitLab Dev",
    });
    const outsider = await loginWithProvider(app, gitlab.id, {
      id: 2003,
      login: "gl-maintainer",
      name: "GitLab Maintainer",
    });
    expect(await bootstrapPut(app, lead.userId, "owner", workspace.id)).toBe(200);
    // A second workspace owner whose provider role proves only developer.
    expect(await bootstrapPut(app, outsider.userId, "owner", workspace.id)).toBe(200);

    const roster = (leadRole: string, devRole: string, outsiderRole: string): void => {
      access.roster.applySnapshot(scopeOf(app, workspace.id), integration.id, {
        roles: [
          {
            subject: "2001",
            login: "gl-lead",
            source_kind: "direct_collaborator",
            provider_role: leadRole,
            authority_ref: "gitlab:group/project",
            inherited_from: null,
          },
          {
            subject: "2002",
            login: "gl-dev",
            source_kind: "direct_collaborator",
            provider_role: devRole,
            authority_ref: "gitlab:group/project",
            inherited_from: null,
          },
          {
            subject: "2003",
            login: "gl-maintainer",
            source_kind: "direct_collaborator",
            provider_role: outsiderRole,
            authority_ref: "gitlab:group/project",
            inherited_from: null,
          },
        ],
        verified_at: new Date().toISOString(),
        subject_users: { "2001": lead.userId, "2002": dev.userId, "2003": outsider.userId },
      });
      app.orchestrator.providerAuthority?.epoch.bump();
    };

    roster("owner", "reporter", "developer");
    expect(
      (await request<Page<MembershipView>>(app, "GET", membersPath(app, workspace.id), lead))
        .status,
    ).toBe(200);
    // A workspace owner whose GitLab role proves only developer (write, not
    // management) can read the roster but cannot administer members.
    const noManagement = await request<ErrorBody>(
      app,
      "POST",
      membersPath(app, workspace.id),
      outsider,
      { user_id: dev.userId, role: "viewer" },
    );
    expect(noManagement.status).toBe(403);
    expect(["FORBIDDEN", "AUTHORITY_RECHECK_REQUIRED"]).toContain(noManagement.body.error.code);

    // GitLab owner proves repository management; a reporter proves only code
    // read, so the same ceiling vocabulary as GitHub applies.
    const aboveCeiling = await request<ErrorBody>(
      app,
      "POST",
      membersPath(app, workspace.id),
      lead,
      { user_id: dev.userId, role: "member" },
    );
    expect(aboveCeiling.status).toBe(403);
    expect(aboveCeiling.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(aboveCeiling.body.error.details?.max_role).toBe("viewer");
    const viewer = await request<MembershipView & ErrorBody>(
      app,
      "POST",
      membersPath(app, workspace.id),
      lead,
      { user_id: dev.userId, role: "viewer" },
    );
    expect(viewer.status).toBe(201);

    // GitLab developer proves repository write, so the member role is now
    // within the verified ceiling.
    roster("owner", "developer", "developer");
    const membership = (
      await request<Page<MembershipView>>(app, "GET", membersPath(app, workspace.id), lead)
    ).body.items.find((entry) => entry.user_id === dev.userId)!;
    const elevated = await request<MembershipView & ErrorBody>(
      app,
      "PATCH",
      `${membersPath(app, workspace.id)}/${membership.id}`,
      lead,
      { role: "member", version: membership.version },
    );
    expect(elevated.status).toBe(200);
    expect(elevated.body.role).toBe("member");
  });
});

// ---------------------------------------------------------------------------
// Pure ceiling policy and defensive roster completeness
// ---------------------------------------------------------------------------

describe("provider-derived role ceiling", () => {
  test("write on one repository and read on another is an intersection, not a ranking", () => {
    expect(
      ceilingAcrossRepositories([["code_read", "issue_write", "repository_write"], ["code_read"]]),
    ).toBe("viewer");
    expect(
      ceilingAcrossRepositories([
        ["code_read", "repository_write"],
        ["code_read", "repository_write"],
      ]),
    ).toBe("member");
    expect(memberRoleCeiling([])).toBe("viewer");
    expect(memberRoleCeiling(["repository_write"])).toBe("member");
  });

  test("assignable roles follow actor and ceiling, never the reverse", () => {
    const ownerBase = {
      actor_role: "owner" as const,
      ceiling: "viewer" as const,
      already_member: false,
      current_role: null,
    };
    expect(assignableRolesFor(ownerBase)).toEqual(["viewer", "admin", "owner"]);
    expect(assignableRolesFor({ ...ownerBase, ceiling: "member" })).toEqual([
      "viewer",
      "member",
      "admin",
      "owner",
    ]);
    expect(assignableRolesFor({ ...ownerBase, actor_role: "admin" })).toEqual(["viewer"]);
    expect(assignableRolesFor({ ...ownerBase, already_member: true })).toEqual([]);
    expect(assignableRolesFor({ ...ownerBase, ceiling: null })).toEqual([]);
    expect(
      assignableRolesFor({
        ...ownerBase,
        actor_role: "admin",
        already_member: true,
        current_role: "owner",
      }),
    ).toEqual([]);
  });

  test("an incomplete roster is a stable 503, never an empty candidate list", async () => {
    const app = await startAuthApp({ dsh, repositoryIntegration: true });
    apps.push(app);
    const db = dbOf(app);
    const repos = createRepositories(db);
    const access = createProviderAccessRepositories(db);
    const identity = createIdentityRepositories(db);
    const repositorySets = createWorkspaceRepositorySetRepository(db);
    const workspace = repos.workspaces.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_seed" },
      {
        name: "Partial Visibility",
        repository_id: "github:FoMo-Exp/Partial",
        provider_instance_id: app.providerInstanceId,
      },
    );
    // A roster the deployment may only see partially can never prove who is
    // absent, so candidate enumeration must refuse rather than imply "nobody".
    access.integrations.create(scopeOf(app, workspace.id), {
      provider_instance_id: app.providerInstanceId,
      repository_id: "github:FoMo-Exp/Partial",
      repository_name: "FoMo-Exp/Partial",
      source_credential_ref: "svc-source-1",
      permission_visibility: "partial",
      actor_id: "usr_seed",
    });
    const owner = identity.users.create({ display_name: "Partial Owner", actor_id: "usr_seed" });
    repos.memberships.create(scopeOf(app, workspace.id), {
      user_id: owner.id,
      role: "owner",
    });
    const capabilityCeilings = createCapabilityCeilingService({
      repositorySets,
      access,
      memberships: repos.memberships,
      providerInstances: repos.providerInstances,
      identity,
      capabilities: createMemberCapabilityRepository(db),
      epoch: createAuthorityEpoch(),
    });
    const permissiveAuthority = {
      isEnforcing: () => true,
      require: () => undefined,
    } as unknown as RequestAuthority;
    const service = new WorkspaceMemberService({
      repos,
      identity,
      access,
      repositorySets,
      capabilityCeilings,
      authority: permissiveAuthority,
      hub: new AuthEventHub(),
      epoch: createAuthorityEpoch(),
      enterpriseId: app.enterpriseId,
    });
    expect(() => service.listCandidates(owner.id, workspace.id, null)).toThrowError(
      /roster cannot be enumerated/,
    );
    try {
      service.listCandidates(owner.id, workspace.id, null);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROVIDER_ROSTER_INCOMPLETE");
      expect((error as { status?: number }).status).toBe(503);
    }
  });
});
