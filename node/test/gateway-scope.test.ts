/**
 * Multi-tenant scope isolation and fail-closed scope semantics at the model
 * gateway (DAT-242).
 *
 * These tests run the real authoritative scope pipeline — DAT-241's
 * `resolveRequestScope` over live membership state — behind the gateway's
 * scope seam, and pin the multi-tenant enablement properties:
 *
 * - Two workspaces' policies and credentials are fully isolated: workspace
 *   A's identity resolves and executes only workspace A's policy.
 * - A cross-workspace binding is rejected with zero provider-adapter calls,
 *   and the denial is attributed to the authenticated scope.
 * - Membership revocation denies the next dispatch in the same request path.
 * - Missing, revoked, ambiguous, and unauthenticated scopes are denied
 *   `MODEL_EGRESS_DENIED` — never a default scope, never a fail-open path.
 */

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, test } from "vitest";

import type { AuthenticatedPrincipal, RequestScopeDeps } from "../src/control-plane/index.js";
import {
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
  ControlPlaneDb,
  ControlPlaneRepositories,
  IdentityRepositories,
  Membership,
  Workspace,
  WorkspaceRole,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import { createModelGateway, createScopeBackedPolicyResolver } from "../src/gateway/index.js";
import type {
  ApprovedEndpoint,
  GatewayAttemptEvent,
  GatewayBindingIdentity,
  GatewayCredentialStore,
  GatewayEventSink,
  GatewayPolicy,
  GatewayScope,
  GatewayScopeBinding,
  ModelGateway,
  ProviderAdapter,
  ScopedPolicyBinding,
} from "../src/gateway/index.js";
import { DATA_CLASSES } from "../src/gateway/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import { cleanTestScanner, securityStubs } from "./helpers/test-gateway.js";

const CONTEXT: Context = { messages: [] };
const ADMIN = "usr_admin";

let db: ControlPlaneDb;
let repos: ControlPlaneRepositories;
let identity: IdentityRepositories;
let deps: RequestScopeDeps;
let enterpriseId: string;
let workspaceA: Workspace;
let workspaceB: Workspace;
let workspaceC: Workspace;

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  migrate(db);
  repos = createRepositories(db);
  identity = createIdentityRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Gateway Scope Enterprise",
    enterprise_slug: "gateway-scope-ent",
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
  workspaceC = seedWorkspace(db, admin_scope, {
    name: "Workspace C",
    repository_id: "repo-c",
    provider_instance_id: provider.id,
  });
  deps = {
    sessions: identity.sessions,
    users: identity.users,
    memberships: repos.memberships,
    workspaces: repos.workspaces,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createUser(displayName: string): string {
  return identity.users.create({ display_name: displayName, actor_id: ADMIN }).id;
}

function signIn(userId: string): AuthenticatedPrincipal {
  const session = identity.sessions.create({
    user_id: userId,
    kind: "web",
    token_hash: hashToken(`token-${userId}-${Math.random()}`),
    csrf_token: `csrf-${userId}`,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  return principalFromSession({ session, user: { id: userId } });
}

function workspaceScope(workspaceId: string): WorkspaceScope {
  return { enterprise_id: enterpriseId, workspace_id: workspaceId, actor_id: ADMIN };
}

function grantMembership(userId: string, workspaceId: string, role: WorkspaceRole): Membership {
  return repos.memberships.create(workspaceScope(workspaceId), { user_id: userId, role });
}

/**
 * The production binding shape (DAT-242): the claim comes from the
 * authenticated request's helper resolution at bind time; the authority
 * re-resolves live membership state on every dispatch.
 */
function helperBinding(
  principal: AuthenticatedPrincipal,
  claim: { enterpriseId: string; workspaceId: string },
): GatewayBindingIdentity {
  return {
    ...claim,
    scopeAuthority: {
      resolve(): GatewayScope {
        const live = resolveRequestScope(deps, principal);
        return { enterpriseId: live.enterprise_id, workspaceId: live.workspace_id };
      },
    },
    issueId: "issue_scope_test",
    runId: "run_scope_test",
    traceId: "trace_scope_test",
  };
}

/** The binding a helper-resolved authenticated request produces at bind time. */
function boundHelperBinding(principal: AuthenticatedPrincipal): GatewayBindingIdentity {
  const resolved = resolveRequestScope(deps, principal);
  return helperBinding(principal, {
    enterpriseId: resolved.enterprise_id,
    workspaceId: resolved.workspace_id,
  });
}

function endpoint(endpointId: string, credentialRef: string, baseUrl: string): ApprovedEndpoint {
  return {
    endpointId,
    provider: TEST_MODEL.provider,
    api: TEST_MODEL.api,
    baseUrl,
    internal: false,
    credentialRef,
    models: [TEST_MODEL.id],
    permittedDataClasses: [...DATA_CLASSES],
  };
}

function policy(revision: string, endpoints: ApprovedEndpoint[]): GatewayPolicy {
  return { revision, endpoints, retry: { maxAttempts: 1 } };
}

/** One policy bound to a workspace's authenticated scope. */
function scoped(workspace: Workspace, entry: GatewayPolicy): ScopedPolicyBinding {
  return { scope: { enterpriseId, workspaceId: workspace.id }, policy: entry };
}

function okStream(text = "ok"): AssistantMessageEventStream {
  const message: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}

interface AdapterCall {
  model: Model<Api>;
}

function spyAdapter(): { adapter: ProviderAdapter; calls: AdapterCall[] } {
  const calls: AdapterCall[] = [];
  return {
    adapter: {
      stream(model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) {
        calls.push({ model });
        return okStream();
      },
    },
    calls,
  };
}

function recordingSink(): { sink: GatewayEventSink; events: GatewayAttemptEvent[] } {
  const events: GatewayAttemptEvent[] = [];
  return {
    sink: {
      record(event: GatewayAttemptEvent) {
        events.push(event);
      },
    },
    events,
  };
}

/** Credential store that records every lookup and serves per-scope secrets. */
function spyCredentials(): {
  store: GatewayCredentialStore;
  lookups: string[];
} {
  const secrets: Record<string, string> = {
    cred_a: "secret-a",
    cred_b: "secret-b",
  };
  const lookups: string[] = [];
  return {
    store: {
      get(credentialRef: string): string | undefined {
        lookups.push(credentialRef);
        return secrets[credentialRef];
      },
    },
    lookups,
  };
}

interface TestGateway {
  gateway: ModelGateway;
  calls: AdapterCall[];
  events: GatewayAttemptEvent[];
  lookups: string[];
}

function scopeGateway(bindings: ScopedPolicyBinding[]): TestGateway {
  const { adapter, calls } = spyAdapter();
  const { sink, events } = recordingSink();
  const { store, lookups } = spyCredentials();
  return {
    gateway: createModelGateway({
      policyResolver: createScopeBackedPolicyResolver(bindings),
      credentials: store,
      adapter,
      scanner: cleanTestScanner,
      sink,
      ...securityStubs(),
      newInvocationId: () => `inv_${calls.length + 1}`,
      now: () => new Date("2026-11-04T00:00:00Z"),
    }),
    calls,
    events,
    lookups,
  };
}

function denialEvents(
  events: GatewayAttemptEvent[],
): Extract<GatewayAttemptEvent, { phase: "outcome" }>[] {
  return events.filter(
    (event): event is Extract<GatewayAttemptEvent, { phase: "outcome" }> =>
      event.phase === "outcome" && event.outcome === "denied",
  );
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("multi-tenant policy and credential isolation (DAT-242)", () => {
  const policyA = policy("policy-a", [endpoint("ep_a", "cred_a", "https://a.example.test/v1")]);
  const policyB = policy("policy-b", [endpoint("ep_b", "cred_b", "https://b.example.test/v1")]);

  test("two workspaces' policies and credentials are fully isolated", async () => {
    const alice = createUser("Alice");
    grantMembership(alice, workspaceA.id, "member");
    const bob = createUser("Bob");
    grantMembership(bob, workspaceB.id, "member");
    const { gateway, calls, lookups } = scopeGateway([
      scoped(workspaceA, policyA),
      scoped(workspaceB, policyB),
    ]);

    // Workspace A's identity resolves and executes only workspace A's policy
    // and credential.
    await gateway.bind(boundHelperBinding(signIn(alice)))(TEST_MODEL, CONTEXT, undefined);
    expect(calls.map((call) => call.model.baseUrl)).toEqual(["https://a.example.test/v1"]);
    expect(lookups).toEqual(["cred_a"]);

    // Workspace B's identity uses workspace B's policy and credential; A's
    // credential is never touched on B's dispatches.
    calls.length = 0;
    lookups.length = 0;
    await gateway.bind(boundHelperBinding(signIn(bob)))(TEST_MODEL, CONTEXT, undefined);
    expect(calls.map((call) => call.model.baseUrl)).toEqual(["https://b.example.test/v1"]);
    expect(lookups).toEqual(["cred_b"]);
  });

  test("workspace A's identity never resolves or executes workspace B's policy", async () => {
    const alice = createUser("Alice");
    grantMembership(alice, workspaceA.id, "member");
    // B's policy approves a model A's policy does not; if A could execute B's
    // policy this dispatch would succeed.
    const bOnlyModel: Model<Api> = { ...TEST_MODEL, id: "b-only-model" };
    const policyBWithOwnModel = policy("policy-b", [
      { ...endpoint("ep_b", "cred_b", "https://b.example.test/v1"), models: [bOnlyModel.id] },
    ]);
    const { gateway, calls, events, lookups } = scopeGateway([
      scoped(workspaceA, policyA),
      scoped(workspaceB, policyBWithOwnModel),
    ]);

    await expect(
      Promise.resolve(
        gateway.bind(boundHelperBinding(signIn(alice)))(bOnlyModel, CONTEXT, undefined),
      ),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "MODEL_NOT_APPROVED" });
    expect(calls).toHaveLength(0);
    expect(lookups).toEqual([]);
    // The denial resolves no B policy: no B policy revision on the event.
    for (const event of denialEvents(events)) {
      expect(event.policyRevision).toBe("policy-a");
    }
  });

  test("a cross-workspace binding is rejected with zero adapter calls and authentic attribution", async () => {
    const alice = createUser("Alice");
    grantMembership(alice, workspaceA.id, "member");
    const { gateway, calls, events, lookups } = scopeGateway([
      scoped(workspaceA, policyA),
      scoped(workspaceB, policyB),
    ]);

    // The binding claims workspace B while the authenticated scope is
    // workspace A: rejected before any policy, credential, or adapter touch.
    const crossTenant = helperBinding(signIn(alice), {
      enterpriseId: enterpriseId,
      workspaceId: workspaceB.id,
    });
    await expect(
      Promise.resolve(gateway.bind(crossTenant)(TEST_MODEL, CONTEXT, undefined)),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "SCOPE_CROSS_TENANT" });
    expect(calls).toHaveLength(0);
    expect(lookups).toEqual([]);
    const denial = denialEvents(events)[0];
    // Attribution follows the authenticated scope, never the claim.
    expect(denial?.identity).toMatchObject({
      enterpriseId: enterpriseId,
      workspaceId: workspaceA.id,
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed scope semantics
// ---------------------------------------------------------------------------

describe("fail-closed scope resolution at dispatch (DAT-242)", () => {
  const policyA = policy("policy-a", [endpoint("ep_a", "cred_a", "https://a.example.test/v1")]);

  test("membership revocation denies the next dispatch in the same request path", async () => {
    const alice = createUser("Alice");
    const membership = grantMembership(alice, workspaceA.id, "member");
    const { gateway, calls, lookups, events } = scopeGateway([scoped(workspaceA, policyA)]);
    const streamFn = gateway.bind(boundHelperBinding(signIn(alice)));

    await streamFn(TEST_MODEL, CONTEXT, undefined);
    expect(calls).toHaveLength(1);

    // Revocation removes the live membership; the very next dispatch through
    // the same bound identity resolves no scope and is denied.
    repos.memberships.remove(workspaceScope(workspaceA.id), membership.id);
    await expect(Promise.resolve(streamFn(TEST_MODEL, CONTEXT, undefined))).rejects.toMatchObject({
      code: "MODEL_EGRESS_DENIED",
      reason: "SCOPE_UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
    expect(lookups).toEqual(["cred_a"]);
    const denial = denialEvents(events)[0];
    expect(denial?.denyReason).toBe("SCOPE_UNAVAILABLE");
  });

  test("missing and ambiguous scopes are denied, never a default scope", async () => {
    const { gateway, calls, events } = scopeGateway([scoped(workspaceA, policyA)]);

    // Never granted: the binding carries a claim, but no live membership
    // resolves — the dispatch denies, never a default scope.
    const stranger = createUser("Mallory");
    await expect(
      Promise.resolve(
        gateway.bind(helperBinding(signIn(stranger), { enterpriseId, workspaceId: workspaceA.id }))(
          TEST_MODEL,
          CONTEXT,
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "SCOPE_UNAVAILABLE" });

    // Ambiguous: two live memberships cannot resolve to one scope.
    const drifter = createUser("Dana");
    grantMembership(drifter, workspaceA.id, "member");
    grantMembership(drifter, workspaceB.id, "member");
    await expect(
      Promise.resolve(
        gateway.bind(helperBinding(signIn(drifter), { enterpriseId, workspaceId: workspaceA.id }))(
          TEST_MODEL,
          CONTEXT,
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "SCOPE_UNAVAILABLE" });

    expect(calls).toHaveLength(0);
    const denials = denialEvents(events);
    expect(denials).toHaveLength(2);
    expect(denials[1]?.detail).toContain("ambiguous");
  });

  test("a request without an authenticated scope dispatches nothing", async () => {
    const { gateway, calls, events } = scopeGateway([scoped(workspaceA, policyA)]);
    // The local-operator shape: no session-derived principal binds the
    // deny-everything scope (fail closed, never a deployment-config scope).
    const unauthenticated: GatewayScopeBinding = {
      enterpriseId: "",
      workspaceId: "",
      scopeAuthority: {
        resolve(): GatewayScope {
          throw new Error("this request carries no authenticated enterprise/workspace scope");
        },
      },
    };
    await expect(
      Promise.resolve(
        gateway.bind({
          ...unauthenticated,
          issueId: "issue_scope_test",
          runId: "run_scope_test",
          traceId: "trace_scope_test",
        })(TEST_MODEL, CONTEXT, undefined),
      ),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "SCOPE_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
    expect(denialEvents(events)[0]?.denyReason).toBe("SCOPE_UNAVAILABLE");
  });

  test("a scope with no policy resolves nothing and is denied (missing scope never fails open)", async () => {
    const carol = createUser("Carol");
    grantMembership(carol, workspaceC.id, "member");
    const { gateway, calls, events } = scopeGateway([scoped(workspaceA, policyA)]);

    await expect(
      Promise.resolve(
        gateway.bind(boundHelperBinding(signIn(carol)))(TEST_MODEL, CONTEXT, undefined),
      ),
    ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "POLICY_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
    const denial = denialEvents(events)[0];
    expect(denial?.identity).toMatchObject({
      enterpriseId: enterpriseId,
      workspaceId: workspaceC.id,
    });
  });
});
