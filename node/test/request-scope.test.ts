import { beforeEach, describe, expect, test } from "vitest";

import { apiErrorFromControlPlane } from "../src/api/errors.js";
import {
  RequestScopeError,
  createIdentityRepositories,
  createRepositories,
  hashToken,
  migrate,
  openControlPlaneDb,
  principalFromSession,
  resolveRequestScope,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  AuthenticatedPrincipal,
  ControlPlaneDb,
  ControlPlaneRepositories,
  IdentityRepositories,
  Membership,
  RequestScopeDeps,
  Workspace,
  WorkspaceRole,
  WorkspaceScope,
} from "../src/control-plane/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let repos: ControlPlaneRepositories;
let identity: IdentityRepositories;
let deps: RequestScopeDeps;
let enterpriseId: string;
let workspaceA: Workspace;
let workspaceB: Workspace;

const ADMIN = "usr_admin";

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  migrate(db);
  repos = createRepositories(db);
  identity = createIdentityRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Scope Enterprise",
    enterprise_slug: "scope-ent",
    admin_user_id: ADMIN,
  });
  enterpriseId = enterprise.id;
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  workspaceA = seedWorkspace(db, admin_scope, {
    name: "Workspace A",
    repository_id: "repo-a",
    provider_instance_id: provider.id,
  });
  workspaceB = seedWorkspace(db, admin_scope, {
    name: "Workspace B",
    repository_id: "repo-b",
    provider_instance_id: provider.id,
  });
  deps = {
    sessions: identity.sessions,
    users: identity.users,
    memberships: repos.memberships,
    workspaces: repos.workspaces,
  };
});

function createUser(displayName: string) {
  return identity.users.create({ display_name: displayName, actor_id: ADMIN });
}

/** Create a live session for a user and return its session-derived principal. */
function signIn(userId: string, options: { expiresAt?: string } = {}) {
  const session = identity.sessions.create({
    user_id: userId,
    kind: "web",
    token_hash: hashToken(`token-${userId}-${Math.random()}`),
    csrf_token: `csrf-${userId}`,
    expires_at: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  return {
    session,
    principal: principalFromSession({ session, user: { id: userId } }),
  };
}

function workspaceScope(workspaceId: string, actorId = ADMIN): WorkspaceScope {
  return { enterprise_id: enterpriseId, workspace_id: workspaceId, actor_id: actorId };
}

function grantMembership(userId: string, workspaceId: string, role: WorkspaceRole): Membership {
  return repos.memberships.create(workspaceScope(workspaceId), { user_id: userId, role });
}

/** Assert the call fails closed with the expected status and stable code. */
function expectScopeError(fn: () => unknown, status: 401 | 403, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestScopeError);
    expect(error).toMatchObject({ status, code });
    return;
  }
  expect.fail("expected resolution to fail closed");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("request scope resolution (DAT-241)", () => {
  test("resolves the unique live membership as the authoritative scope", () => {
    const user = createUser("Alice");
    const membership = grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id);

    expect(resolveRequestScope(deps, principal)).toEqual({
      enterprise_id: enterpriseId,
      workspace_id: workspaceA.id,
      actor_id: user.id,
      membership_id: membership.id,
      role: "member",
    });
  });

  test("the resolved scope is a repository scope that scoped reads accept as-is", () => {
    const user = createUser("Alice");
    const membership = grantMembership(user.id, workspaceA.id, "viewer");
    const { principal } = signIn(user.id);

    const scope = resolveRequestScope(deps, principal);
    expect(repos.memberships.getByUser(scope, user.id)?.id).toBe(membership.id);
  });

  test("a role change takes effect on the next resolution in the same request path", () => {
    const user = createUser("Alice");
    const membership = grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id);
    expect(resolveRequestScope(deps, principal).role).toBe("member");

    repos.memberships.updateRole(
      workspaceScope(workspaceA.id),
      membership.id,
      "admin",
      membership.version,
    );
    expect(resolveRequestScope(deps, principal).role).toBe("admin");
  });

  test("a user without any membership gets no scope", () => {
    const user = createUser("Alice");
    const { principal } = signIn(user.id);
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_MISSING");
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated (401)
// ---------------------------------------------------------------------------

describe("unauthenticated callers are refused before any lookup", () => {
  test("a hand-built object carrying client-supplied IDs is not a principal", () => {
    // Acceptance: a path where the client provides IDs can never mint a
    // scope — not even for the user those IDs name.
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    const forged = { session_id: "sess_client_supplied", user_id: user.id };
    expectScopeError(
      () => resolveRequestScope(deps, forged as AuthenticatedPrincipal),
      401,
      "UNAUTHENTICATED",
    );
  });

  test("values without a session binding at all are refused", () => {
    for (const value of [undefined, null, "usr_alice", {}]) {
      expectScopeError(
        () => resolveRequestScope(deps, value as AuthenticatedPrincipal),
        401,
        "UNAUTHENTICATED",
      );
    }
  });

  test("an unknown session resolves nothing", () => {
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    const principal = principalFromSession({
      session: { id: "sess_missing" },
      user: { id: user.id },
    });
    expectScopeError(() => resolveRequestScope(deps, principal), 401, "UNAUTHENTICATED");
  });

  test("a revoked session resolves nothing", () => {
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    const { session, principal } = signIn(user.id);
    identity.sessions.revoke(session.id, "logout");
    expectScopeError(() => resolveRequestScope(deps, principal), 401, "UNAUTHENTICATED");
  });

  test("an expired session resolves nothing", () => {
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expectScopeError(() => resolveRequestScope(deps, principal), 401, "UNAUTHENTICATED");
  });

  test("a principal whose session belongs to another user resolves nothing", () => {
    const alice = createUser("Alice");
    const mallory = createUser("Mallory");
    grantMembership(alice.id, workspaceA.id, "member");
    const { principal } = signIn(alice.id);
    // Spreading copies the brand; the session↔user binding check is what
    // makes the swapped copy fail.
    const swapped = { ...principal, user_id: mallory.id };
    expectScopeError(() => resolveRequestScope(deps, swapped), 401, "UNAUTHENTICATED");
  });
});

// ---------------------------------------------------------------------------
// Revocation and suspension
// ---------------------------------------------------------------------------

describe("revocation and suspension fail the scope in the same request path", () => {
  test("a revoked membership denies the next resolution", () => {
    const user = createUser("Alice");
    const membership = grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id);
    expect(resolveRequestScope(deps, principal).workspace_id).toBe(workspaceA.id);

    repos.memberships.remove(workspaceScope(workspaceA.id), membership.id);
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_MISSING");
  });

  test("a suspended account loses its scope immediately", () => {
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id);
    expect(resolveRequestScope(deps, principal).role).toBe("member");

    identity.users.setStatus(user.id, "suspended", ADMIN);
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "ACCOUNT_SUSPENDED");
  });

  test("a revocation landing mid-request-path denies every later resolution", () => {
    // One request path performs several authorized actions with the same
    // principal. A concurrent admin revocation between any two of them must
    // kill the next one: nothing memoizes an earlier allow verdict.
    const user = createUser("Alice");
    const membership = grantMembership(user.id, workspaceA.id, "member");
    const { principal } = signIn(user.id);

    expect(resolveRequestScope(deps, principal).role).toBe("member"); // action 1
    expect(resolveRequestScope(deps, principal).role).toBe("member"); // action 2
    repos.memberships.remove(workspaceScope(workspaceA.id), membership.id); // concurrent revoke
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_MISSING"); // action 3
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_MISSING"); // action 4
  });
});

// ---------------------------------------------------------------------------
// Workspace and tenant boundaries
// ---------------------------------------------------------------------------

describe("workspace and tenant boundaries", () => {
  test("two workspaces resolve to their own scopes and never each other's", () => {
    const alice = createUser("Alice");
    const bob = createUser("Bob");
    grantMembership(alice.id, workspaceA.id, "member");
    grantMembership(bob.id, workspaceB.id, "admin");
    const aliceScope = resolveRequestScope(deps, signIn(alice.id).principal);
    const bobScope = resolveRequestScope(deps, signIn(bob.id).principal);

    expect(aliceScope.workspace_id).toBe(workspaceA.id);
    expect(bobScope.workspace_id).toBe(workspaceB.id);
    expect(aliceScope.workspace_id).not.toBe(bobScope.workspace_id);
  });

  test("a client-substituted workspace ID cannot reach another workspace's data", () => {
    const alice = createUser("Alice");
    const bob = createUser("Bob");
    grantMembership(bob.id, workspaceB.id, "member");
    grantMembership(alice.id, workspaceA.id, "member");
    const aliceScope = resolveRequestScope(deps, signIn(alice.id).principal);

    // Even with Alice's authoritative scope in hand, substituting workspace
    // B's client-supplied ID yields nothing at the storage layer.
    const substituted = { ...aliceScope, workspace_id: workspaceB.id };
    expect(repos.memberships.getByUser(substituted, alice.id)).toBeUndefined();
  });

  test("a user with two live memberships in one enterprise is rejected as ambiguous", () => {
    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    grantMembership(user.id, workspaceB.id, "viewer");
    const { principal } = signIn(user.id);
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_AMBIGUOUS");
  });

  test("live memberships spanning enterprises are rejected as cross-tenant", () => {
    const other = seedEnterprise(db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: "other-ent",
      admin_user_id: ADMIN,
    });
    const otherProvider = seedProviderInstance(db, other.admin_scope, {
      provider_type: "github",
      origin_url: "https://gitlab.com",
    });
    const workspaceC = seedWorkspace(db, other.admin_scope, {
      name: "Workspace C",
      repository_id: "repo-c",
      provider_instance_id: otherProvider.id,
    });

    const user = createUser("Alice");
    grantMembership(user.id, workspaceA.id, "member");
    repos.memberships.create(
      {
        enterprise_id: other.enterprise.id,
        workspace_id: workspaceC.id,
        actor_id: ADMIN,
      },
      { user_id: user.id, role: "member" },
    );
    const { principal } = signIn(user.id);
    expectScopeError(() => resolveRequestScope(deps, principal), 403, "SCOPE_CROSS_TENANT");
  });
});

// ---------------------------------------------------------------------------
// Error semantics
// ---------------------------------------------------------------------------

describe("401/403 semantics stay stable through the shared error envelope", () => {
  test("an authentication failure maps to 401 with reauthenticate guidance", () => {
    const mapped = apiErrorFromControlPlane(
      new RequestScopeError(401, "UNAUTHENTICATED", "no valid authenticated session"),
    );
    expect(mapped.status).toBe(401);
    expect(mapped.code).toBe("UNAUTHENTICATED");
    expect(mapped.stage).toBe("auth");
    expect(mapped.category).toBe("denial");
    expect(mapped.nextAction).toBe("reauthenticate");
  });

  test("authorization failures map to 403 with their stable codes", () => {
    const cases = [
      {
        code: "ACCOUNT_SUSPENDED",
        stage: "auth",
        category: "denial",
        nextAction: "contact_admin",
      },
      {
        code: "SCOPE_MISSING",
        stage: "authorization",
        category: "denial",
        nextAction: "request_review",
      },
      {
        code: "SCOPE_AMBIGUOUS",
        stage: "authorization",
        category: "stop",
        nextAction: "contact_admin",
      },
      {
        code: "SCOPE_CROSS_TENANT",
        stage: "authorization",
        category: "denial",
        nextAction: "request_review",
      },
    ] as const;
    for (const expected of cases) {
      const mapped = apiErrorFromControlPlane(
        new RequestScopeError(403, expected.code, "scope unavailable"),
      );
      expect(mapped.status).toBe(403);
      expect(mapped.code).toBe(expected.code);
      expect(mapped.stage).toBe(expected.stage);
      expect(mapped.category).toBe(expected.category);
      expect(mapped.nextAction).toBe(expected.nextAction);
    }
  });
});
