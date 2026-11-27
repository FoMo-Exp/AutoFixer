/**
 * Task target resolution with provider-verified baselines (DAT-293).
 *
 * The acceptance boundary these tests pin down:
 *
 * - a workspace-scoped create binds one immutable target at the set version the
 *   caller observed, with a **trusted baseline**: the deployment's own pin for
 *   its repository, a checkout-capability read for any other repository;
 * - a missing approved installation, checkout/delivery capability, resolvable
 *   ref or a provider outage refuses with a stable code — it never falls back
 *   to the deployment's repository, another binding or a fabricated SHA;
 * - a target may not be resolved from another tenant's workspace, and a set
 *   change racing the provider read makes the decision unrepresentable;
 * - the synchronous legacy single-repository behavior is unchanged.
 */

import { describe, expect, test, afterEach } from "vitest";

import { createAsyncWorkspaceRunBindingResolver } from "../src/api/workspace-bindings.js";
import { createTrustedBaselineResolver } from "../src/api/trusted-baselines.js";
import type { TrustedBaselineResolver } from "../src/api/task-targets.js";

/**
 * A deployment with no provider read path: the only baseline it can pin is its
 * own configured repository. Used to prove that every other target is refused
 * rather than guessed.
 */
function noProviderBaselines(): TrustedBaselineResolver {
  return {
    async resolve() {
      return {
        state: "unavailable",
        base_ref: null,
        base_sha: null,
        reason: "baseline_not_pinned",
      };
    },
  };
}
import type { OrchestratorConfig } from "../src/config.js";
import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import { bumpRepositorySetVersion } from "../src/control-plane/workspace-repository-repositories.js";
import type {
  ControlPlaneDb,
  EnterpriseScope,
  ProviderAccessRepositories,
  ProviderInstance,
  ServiceIntegration,
  Workspace,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import { resolveRepositoryRef } from "../src/provider-access/adapter.js";
import { createGitHubAdapter } from "../src/provider-access/adapters/github.js";
import { createGitLabAdapter } from "../src/provider-access/adapters/gitlab.js";
import { exactRoutes, startFakeProvider } from "./helpers/fake-provider.js";
import type { FakeProvider } from "./helpers/fake-provider.js";

const ACTOR = "usr_operator";
const REPO_A = "github:acme/payments";
const REPO_A_SHA = "a".repeat(40);
const REPO_A_URL = "https://github.com/acme/payments.git";
const REPO_B = "github:acme/service-b";
const REPO_B_SHA = "b".repeat(40);
const REPO_B_URL = "https://github.com/acme/service-b.git";
const CHECKOUT_SECRET = "checkout-token-should-never-leak";

const CONFIG = {
  repositoryId: REPO_A,
  repositoryUrl: REPO_A_URL,
  baseRef: "main",
  baseSha: REPO_A_SHA,
  actorId: ACTOR,
  enterpriseId: "ent_placeholder",
  maxWallClockSeconds: 900,
} as unknown as OrchestratorConfig;

interface Fixture {
  db: ControlPlaneDb;
  enterpriseScope: EnterpriseScope;
  scope: WorkspaceScope;
  provider: ProviderInstance;
  workspace: Workspace;
  access: ProviderAccessRepositories;
  integrationA: ServiceIntegration;
  integrationB: ServiceIntegration;
  config: OrchestratorConfig;
}

const providers: FakeProvider[] = [];

afterEach(async () => {
  while (providers.length > 0) {
    await providers.pop()?.close();
  }
});

function enableGate(db: ControlPlaneDb, minSchemaVersion = CURRENT_SCHEMA_VERSION): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', 'test rollout', ?, ?)`,
  ).run(MULTI_REPOSITORY_GATE_KEY, minSchemaVersion, new Date().toISOString(), ACTOR);
}

function insertBinding(
  db: ControlPlaneDb,
  scope: WorkspaceScope,
  input: {
    id: string;
    position: number;
    repository_id: string;
    provider_instance_id: string;
    installation_ref: string | null;
    repository_url: string | null;
    repository_name: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_repository_binding
       (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
        repository_id, repository_url, repository_name, position, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    input.id,
    scope.enterprise_id,
    scope.workspace_id,
    input.provider_instance_id,
    input.installation_ref,
    input.repository_id,
    input.repository_url,
    input.repository_name,
    input.position,
    now,
    now,
    ACTOR,
    ACTOR,
  );
}

/** Two active repositories, each behind its own approved installation. */
function setup(options: { multi?: boolean; gate?: boolean } = {}): Fixture {
  const db = openControlPlaneDb();
  const { admin_scope } = seedEnterprise(db, {
    enterprise_name: "Acme",
    enterprise_slug: "acme",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: REPO_A,
    provider_instance_id: provider.id,
  });
  const scope: WorkspaceScope = {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: ACTOR,
  };
  const access = createProviderAccessRepositories(db);
  const integrationA = access.integrations.create(scope, {
    provider_instance_id: provider.id,
    repository_id: REPO_A,
    repository_name: "acme/payments",
    source_credential_ref: "svc-source-a",
    checkout_credential_ref: "svc-checkout-a",
    delivery_credential_ref: "svc-delivery-a",
    permission_visibility: "full",
    actor_id: ACTOR,
  });
  // The seeded binding precedes the integration, so its installation link is
  // established here — exactly the state the migration produces for an
  // already-installed workspace.
  db.prepare(
    `UPDATE workspace_repository_binding SET installation_ref = ?, repository_url = ?
      WHERE workspace_id = ? AND position = 1`,
  ).run(integrationA.id, REPO_A_URL, workspace.id);

  const integrationB = access.integrations.create(scope, {
    provider_instance_id: provider.id,
    repository_id: REPO_B,
    repository_name: "acme/service-b",
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: ACTOR,
  });
  if (options.multi !== false) {
    insertBinding(db, scope, {
      id: "wrb_b",
      position: 2,
      repository_id: REPO_B,
      provider_instance_id: provider.id,
      installation_ref: integrationB.id,
      repository_url: REPO_B_URL,
      repository_name: "acme/service-b",
    });
    bumpRepositorySetVersion(db, admin_scope, workspace.id);
  }
  if (options.gate === true) {
    enableGate(db);
  }
  return {
    db,
    enterpriseScope: admin_scope,
    scope,
    provider,
    workspace,
    access,
    integrationA,
    integrationB,
    config: { ...CONFIG, enterpriseId: admin_scope.enterprise_id } as OrchestratorConfig,
  };
}

function credentials() {
  return createStaticServiceCredentialStore({
    "svc-checkout-a": CHECKOUT_SECRET,
    "svc-checkout-b": CHECKOUT_SECRET,
  });
}

function resolverFor(
  fixture: Fixture,
  options: {
    apiBaseUrl?: string;
    trustedBaselines?: TrustedBaselineResolver;
  } = {},
) {
  const repos = createRepositories(fixture.db);
  const baselines =
    options.trustedBaselines ??
    createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: repos.providerInstances,
      credentials: credentials(),
      ...(options.apiBaseUrl !== undefined ? { api_base_url: options.apiBaseUrl } : {}),
    });
  return createAsyncWorkspaceRunBindingResolver({
    config: fixture.config,
    workspaces: repos.workspaces,
    providerInstances: repos.providerInstances,
    repositorySets: createWorkspaceRepositorySetRepository(fixture.db, {
      multiRepositoryRuntime: "complete",
    }),
    trustedBaselines: baselines,
    integrations: fixture.access.integrations,
  });
}

function selection(
  fixture: Fixture,
  overrides: Partial<{
    repository_id: string;
    provider_instance_id: string;
    installation_ref: string | null;
    base_ref: string;
    expected_set_version: number;
    expected_base_sha: string;
  }> = {},
) {
  const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
  return {
    repository_id: REPO_B,
    provider_instance_id: fixture.provider.id,
    installation_ref: fixture.integrationB.id,
    base_ref: "main",
    expected_set_version: set.set_version,
    ...overrides,
  };
}

describe("provider-verified trusted baselines (DAT-293)", () => {
  test("the deployment's own repository keeps its pin without a provider call", async () => {
    const fixture = setup();
    const http = () => {
      throw new Error("the deployment pin must not be read through the provider");
    };
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: createRepositories(fixture.db).providerInstances,
      credentials: credentials(),
      http: http as never,
    });
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingA = set.bindings.find((binding) => binding.repository_id === REPO_A)!;

    const resolved = await baselines.resolve(bindingA, "main");
    expect(resolved).toMatchObject({
      state: "trusted",
      base_ref: "main",
      base_sha: REPO_A_SHA,
      integration_id: fixture.integrationA.id,
    });
  });

  test("another repository's baseline is the commit its checkout capability resolves", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 200, body: { sha: REPO_B_SHA } },
      }),
    );
    providers.push(provider);
    const fixture = setup();
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: createRepositories(fixture.db).providerInstances,
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;

    const resolved = await baselines.resolve(bindingB, "main");
    expect(resolved).toEqual({
      state: "trusted",
      base_ref: "main",
      base_sha: REPO_B_SHA,
      repository_url: REPO_B_URL,
      integration_id: fixture.integrationB.id,
    });
    // The read went through the checkout credential, never the source one.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.headers["authorization"]).toBe(`Bearer ${CHECKOUT_SECRET}`);
  });

  test("a ref the provider does not know is unavailable, never a guess", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/release`]: { status: 404, body: { message: "Not Found" } },
      }),
    );
    providers.push(provider);
    const fixture = setup();
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: createRepositories(fixture.db).providerInstances,
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;

    expect(await baselines.resolve(bindingB, "release")).toMatchObject({
      state: "unavailable",
      reason: "ref_not_found",
    });
  });

  test("a provider outage is unavailable and never a fabricated commit", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 500, body: { message: "boom" } },
      }),
    );
    providers.push(provider);
    const fixture = setup();
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: createRepositories(fixture.db).providerInstances,
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;

    expect(await baselines.resolve(bindingB, "main")).toMatchObject({
      state: "unavailable",
      reason: "provider_unavailable",
    });
  });

  test("an answer that is not a full commit id is refused", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 200, body: { sha: "abc123" } },
      }),
    );
    providers.push(provider);
    const fixture = setup();
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: createRepositories(fixture.db).providerInstances,
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;

    expect(await baselines.resolve(bindingB, "main")).toMatchObject({
      state: "unavailable",
      reason: "provider_unavailable",
    });
  });

  test("a withdrawn checkout credential or installation refuses before any provider call", async () => {
    const fixture = setup();
    const repos = createRepositories(fixture.db);
    const scope = fixture.scope;
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(scope);
    const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;

    // Credential reference still on the row, but the boundary cannot
    // materialize it (rotation/withdrawal): not an approved credential.
    const withdrawn = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: repos.providerInstances,
      credentials: createStaticServiceCredentialStore({}),
    });
    expect(await withdrawn.resolve(bindingB, "main")).toMatchObject({
      state: "unavailable",
      reason: "checkout_credential_missing",
    });

    // A suspended installation is never approval.
    fixture.access.integrations.setStatus(
      scope,
      fixture.integrationB.id,
      { install_status: "suspended", actor_id: ACTOR },
      fixture.integrationB.version,
    );
    const withLiveCredentials = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: repos.providerInstances,
      credentials: credentials(),
    });
    expect(await withLiveCredentials.resolve(bindingB, "main")).toMatchObject({
      state: "unavailable",
      reason: "integration_missing",
    });
  });

  test("a binding with no recorded installation is never proven by an integration", async () => {
    const fixture = setup();
    const repos = createRepositories(fixture.db);
    const set = createWorkspaceRepositorySetRepository(fixture.db).getSet(fixture.scope);
    const bindingB = {
      ...set.bindings.find((b) => b.repository_id === REPO_B)!,
      installation_ref: null,
    };
    const baselines = createTrustedBaselineResolver({
      config: fixture.config,
      integrations: fixture.access.integrations,
      providerInstances: repos.providerInstances,
      credentials: credentials(),
    });

    expect(await baselines.resolve(bindingB, "main")).toMatchObject({
      state: "unavailable",
      reason: "installation_not_approved",
    });
  });
});

describe("runtime target resolution (DAT-293)", () => {
  test("a two-repository workspace binds the selected target with a verified baseline", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 200, body: { sha: REPO_B_SHA } },
      }),
    );
    providers.push(provider);
    const fixture = setup({ multi: true, gate: true });
    const binding = await resolverFor(fixture, { apiBaseUrl: provider.base_url }).resolve(
      fixture.workspace.id,
      selection(fixture),
    );

    expect(binding).toMatchObject({
      enterpriseId: fixture.scope.enterprise_id,
      workspaceId: fixture.workspace.id,
      repositoryId: REPO_B,
      repositoryUrl: REPO_B_URL,
      baseRef: "main",
      baseSha: REPO_B_SHA,
      setVersion: 2,
    });
    expect(binding.target).toMatchObject({
      binding_id: "wrb_b",
      repository_id: REPO_B,
      provider_instance_id: fixture.provider.id,
      installation_ref: fixture.integrationB.id,
      base_ref: "main",
      base_sha: REPO_B_SHA,
      set_version: 2,
    });
  });

  test("an unauthorized repository, identity or version refuses instead of falling back", async () => {
    const fixture = setup({ multi: true, gate: true });
    const resolver = resolverFor(fixture, {
      trustedBaselines: noProviderBaselines(),
    });
    await expect(
      resolver.resolve(
        fixture.workspace.id,
        selection(fixture, { repository_id: "github:acme/nope" }),
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_IN_WORKSPACE", status: 400 });
    await expect(
      resolver.resolve(fixture.workspace.id, selection(fixture, { provider_instance_id: "pri_x" })),
    ).rejects.toMatchObject({ code: "TARGET_IDENTITY_MISMATCH", status: 409 });
    await expect(
      resolver.resolve(fixture.workspace.id, selection(fixture, { installation_ref: null })),
    ).rejects.toMatchObject({ code: "TARGET_IDENTITY_MISMATCH", status: 409 });
    await expect(
      resolver.resolve(fixture.workspace.id, selection(fixture, { expected_set_version: 1 })),
    ).rejects.toMatchObject({ code: "REPOSITORY_SET_VERSION_CONFLICT", status: 409 });
  });

  test("a workspace with no selection and two repositories asks for one", async () => {
    const fixture = setup({ multi: true, gate: true });
    const resolver = resolverFor(fixture, {
      trustedBaselines: noProviderBaselines(),
    });
    await expect(resolver.resolve(fixture.workspace.id)).rejects.toMatchObject({
      code: "TARGET_REPOSITORY_REQUIRED",
      status: 400,
    });
  });

  test("the rollout gate and this build's runtime capability both bound the shape", async () => {
    const closed = setup({ multi: true, gate: false });
    await expect(
      resolverFor(closed, { trustedBaselines: noProviderBaselines() }).resolve(
        closed.workspace.id,
        selection(closed),
      ),
    ).rejects.toMatchObject({ code: "MULTI_REPOSITORY_SCOPE_DISABLED", status: 403 });

    const open = setup({ multi: true, gate: true });
    const runtimeLimited = createAsyncWorkspaceRunBindingResolver({
      config: open.config,
      workspaces: createRepositories(open.db).workspaces,
      providerInstances: createRepositories(open.db).providerInstances,
      // A build without the runtime consumer: gate enabled is not enough.
      repositorySets: createWorkspaceRepositorySetRepository(open.db),
      trustedBaselines: noProviderBaselines(),
    });
    await expect(runtimeLimited.resolve(open.workspace.id, selection(open))).rejects.toMatchObject({
      code: "MULTI_REPOSITORY_SCOPE_UNSUPPORTED",
      status: 403,
    });
  });

  test("a missing checkout capability refuses with its own code", async () => {
    const fixture = setup({ multi: true, gate: true });
    fixture.db
      .prepare(`UPDATE service_integration SET checkout_credential_ref = NULL WHERE id = ?`)
      .run(fixture.integrationB.id);
    const resolver = resolverFor(fixture);
    await expect(resolver.resolve(fixture.workspace.id, selection(fixture))).rejects.toMatchObject({
      code: "CHECKOUT_CREDENTIAL_UNAVAILABLE",
      status: 409,
    });
  });

  test("a multi-repository run needs its target's own delivery capability", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 200, body: { sha: REPO_B_SHA } },
      }),
    );
    providers.push(provider);
    const fixture = setup({ multi: true, gate: true });
    fixture.db
      .prepare(`UPDATE service_integration SET delivery_credential_ref = NULL WHERE id = ?`)
      .run(fixture.integrationB.id);
    await expect(
      resolverFor(fixture, { apiBaseUrl: provider.base_url }).resolve(
        fixture.workspace.id,
        selection(fixture),
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_CREDENTIAL_UNAVAILABLE", status: 409 });
  });

  test("a trusted baseline the provider cannot prove refuses the create", async () => {
    const fixture = setup({ multi: true, gate: true });
    await expect(
      resolverFor(fixture, { trustedBaselines: noProviderBaselines() }).resolve(
        fixture.workspace.id,
        selection(fixture),
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_BINDING_UNAVAILABLE", status: 409 });
  });

  test("an observed baseline that no longer matches refuses the create", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        [`/repos/acme/service-b/commits/main`]: { status: 200, body: { sha: REPO_B_SHA } },
      }),
    );
    providers.push(provider);
    const fixture = setup({ multi: true, gate: true });
    await expect(
      resolverFor(fixture, { apiBaseUrl: provider.base_url }).resolve(
        fixture.workspace.id,
        selection(fixture, { expected_base_sha: "c".repeat(40) }),
      ),
    ).rejects.toMatchObject({ code: "TARGET_BASELINE_MISMATCH", status: 409 });
  });

  test("a set change racing the provider read makes the decision unrepresentable", async () => {
    const fixture = setup({ multi: true, gate: true });
    const staleVersion = createWorkspaceRepositorySetRepository(fixture.db).getSet(
      fixture.scope,
    ).set_version;
    // The provider answers, and in the meantime the set moves: the resolved
    // decision is formed against a version that no longer exists.
    const racing: TrustedBaselineResolver = {
      async resolve() {
        bumpRepositorySetVersion(fixture.db, fixture.enterpriseScope, fixture.workspace.id);
        return {
          state: "trusted",
          base_ref: "main",
          base_sha: REPO_B_SHA,
          repository_url: REPO_B_URL,
          integration_id: fixture.integrationB.id,
        };
      },
    };
    await expect(
      resolverFor(fixture, { trustedBaselines: racing }).resolve(
        fixture.workspace.id,
        selection(fixture, { expected_set_version: staleVersion }),
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_SET_VERSION_CONFLICT", status: 409 });
  });

  test("another tenant's workspace is indistinguishable from a missing one", async () => {
    const fixture = setup({ multi: true, gate: true });
    const resolver = resolverFor(fixture);
    await expect(resolver.resolve("wsp_other_tenant", selection(fixture))).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  test("a single-repository workspace keeps its pinned binding and baseline", async () => {
    const fixture = setup({ multi: false, gate: false });
    const binding = await resolverFor(fixture).resolve(fixture.workspace.id);
    expect(binding).toMatchObject({
      repositoryId: REPO_A,
      baseRef: "main",
      baseSha: REPO_A_SHA,
      setVersion: 1,
    });
    expect(binding.target).toMatchObject({ repository_id: REPO_A, base_sha: REPO_A_SHA });
  });
});

describe("provider ref resolution (DAT-293)", () => {
  test("github resolves the ref through the checkout credential on the exact path", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        "/repos/acme/service-b/commits/release%2F1.0": {
          status: 200,
          body: { sha: REPO_B_SHA.toUpperCase() },
        },
        "/repos/acme/service-b/commits/gone": { status: 404, body: { message: "Not Found" } },
        "/repos/acme/service-b/commits/forbidden": { status: 403, body: { message: "nope" } },
      }),
    );
    providers.push(provider);
    const adapter = createGitHubAdapter({
      canonical_repository_id: REPO_B,
      credential_ref: "svc-checkout-b",
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const repository = {
      repository_id: REPO_B,
      repository_name: "acme/service-b",
      provider_type: "github" as const,
    };
    const ctx = {
      enterprise_id: "ent_test",
      workspace_id: "wsp_test",
      integration_id: "sint_test",
    };

    expect(await resolveRepositoryRef(adapter, ctx, repository, "release/1.0")).toEqual({
      ref: "release/1.0",
      sha: REPO_B_SHA,
    });
    expect(await resolveRepositoryRef(adapter, ctx, repository, "gone")).toBeNull();
    await expect(resolveRepositoryRef(adapter, ctx, repository, "forbidden")).rejects.toThrow(
      /not permitted/,
    );
    for (const request of provider.requests) {
      expect(request.headers["authorization"]).toBe(`Bearer ${CHECKOUT_SECRET}`);
    }
  });

  test("gitlab resolves the ref by encoded project path", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        "/projects/acme%2Fservice-b/repository/commits/main": {
          status: 200,
          body: { id: REPO_B_SHA },
        },
      }),
    );
    providers.push(provider);
    const adapter = createGitLabAdapter({
      canonical_repository_id: "gitlab:acme/service-b",
      credential_ref: "svc-checkout-b",
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    const resolved = await resolveRepositoryRef(
      adapter,
      { enterprise_id: "ent_test", workspace_id: "wsp_test", integration_id: "sint_test" },
      { repository_id: REPO_B, repository_name: "acme/service-b", provider_type: "gitlab" },
      "main",
    );
    expect(resolved).toEqual({ ref: "main", sha: REPO_B_SHA });
    expect(provider.urls()).toEqual(["/projects/acme%2Fservice-b/repository/commits/main"]);
  });

  test("a ref that resolves to something other than a commit is never a baseline", async () => {
    const provider = await startFakeProvider(
      exactRoutes({
        "/repos/acme/service-b/commits/weird": { status: 200, body: { sha: "main" } },
      }),
    );
    providers.push(provider);
    const adapter = createGitHubAdapter({
      canonical_repository_id: REPO_B,
      credential_ref: "svc-checkout-b",
      credentials: credentials(),
      api_base_url: provider.base_url,
    });
    await expect(
      resolveRepositoryRef(
        adapter,
        { enterprise_id: "ent_test", workspace_id: "wsp_test", integration_id: "sint_test" },
        { repository_id: REPO_B, repository_name: "acme/service-b", provider_type: "github" },
        "weird",
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
