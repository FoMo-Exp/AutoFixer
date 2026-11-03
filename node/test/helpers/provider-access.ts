/**
 * Shared fixtures for the DAT-203 provider access tests: a seeded
 * enterprise/workspace with a repository-scoped service integration, the
 * three repository layers wired together, and a scripted provider adapter.
 */

import {
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  IdentityRepositories,
  ProviderAccessRepositories,
} from "../../src/control-plane/index.js";
import type {
  EnterpriseScope,
  ProviderType,
  WorkspaceRole,
  WorkspaceScope,
} from "../../src/control-plane/types.js";
import type {
  MembershipRepository,
  WorkspaceRepository,
} from "../../src/control-plane/repositories.js";
import type {
  UserRepository,
  IdentityRepository,
} from "../../src/control-plane/identity-repositories.js";
import type { ServiceIntegration } from "../../src/control-plane/provider-access-types.js";
import {
  createAccessGate,
  createAuthorityEpoch,
  type AccessGate,
  type AuthorityEpoch,
} from "../../src/provider-access/access-gate.js";
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderCallContext,
  RawProviderRole,
  RepositoryRef,
  RosterPage,
} from "../../src/provider-access/types.js";

export const ACTOR = "usr_operator";
export const NOW = "2026-11-03T12:00:00.000Z";
export const REPO_ID = "github:repo:9001";
export const REPO_NAME = "Luthiel/AutoFixer";

export interface Fixture {
  db: ControlPlaneDb;
  adminScope: EnterpriseScope;
  scope: WorkspaceScope;
  providerInstanceId: string;
  workspaceId: string;
  integration: ServiceIntegration;
  memberships: MembershipRepository;
  workspaces: WorkspaceRepository;
  users: UserRepository;
  identities: IdentityRepository;
  access: ProviderAccessRepositories;
  identity: IdentityRepositories;
  epoch: AuthorityEpoch;
  gate: AccessGate;
  clock: { now: Date };
}

export function setupFixture(
  options: {
    provider_type?: ProviderType;
    permission_visibility?: "full" | "partial" | "none";
  } = {},
): Fixture {
  const db = openControlPlaneDb();
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const access = createProviderAccessRepositories(db);

  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const providerInstance = seedProviderInstance(db, admin_scope, {
    provider_type: options.provider_type ?? "github",
    origin_url: options.provider_type === "gitlab" ? "https://gitlab.com" : "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: REPO_ID,
    provider_instance_id: providerInstance.id,
  });

  const scope: WorkspaceScope = {
    enterprise_id: enterprise.id,
    workspace_id: workspace.id,
    actor_id: ACTOR,
  };
  const integration = access.integrations.create(scope, {
    provider_instance_id: providerInstance.id,
    repository_id: REPO_ID,
    repository_name: REPO_NAME,
    source_credential_ref: "svc-source-1",
    checkout_credential_ref: "svc-checkout-1",
    delivery_credential_ref: "svc-delivery-1",
    permission_visibility: options.permission_visibility ?? "full",
    actor_id: ACTOR,
  });

  const epoch = createAuthorityEpoch();
  const clock = { now: new Date(NOW) };
  const gate = createAccessGate({
    access,
    memberships: repos.memberships,
    workspaces: repos.workspaces,
    users: identity.users,
    identities: identity.identities,
    epoch,
    clock: () => clock.now,
    freshWindowMs: 15 * 60 * 1000,
    staleAfterMs: 24 * 60 * 60 * 1000,
  });

  return {
    db,
    adminScope: admin_scope,
    scope,
    providerInstanceId: providerInstance.id,
    workspaceId: workspace.id,
    integration,
    memberships: repos.memberships,
    workspaces: repos.workspaces,
    users: identity.users,
    identities: identity.identities,
    access,
    identity,
    epoch,
    gate,
    clock,
  };
}

/**
 * Create a user with a provider identity and a workspace membership — the
 * normal shape of someone who can act in a workspace.
 */
export function addMember(
  fixture: Fixture,
  options: {
    subject: string;
    login: string;
    role: WorkspaceRole;
    user_status?: "active" | "suspended";
  },
): { userId: string } {
  const user = fixture.identity.users.create({ display_name: options.login, actor_id: ACTOR });
  if (options.user_status === "suspended") {
    fixture.identity.users.setStatus(user.id, "suspended", ACTOR);
  }
  fixture.identity.identities.create({
    user_id: user.id,
    provider_instance_id: fixture.providerInstanceId,
    subject: options.subject,
    login: options.login,
    actor_id: ACTOR,
  });
  fixture.memberships.create(fixture.scope, { user_id: user.id, role: options.role });
  return { userId: user.id };
}

/** Verify a subject's authority directly (bypassing reconcile) for gate tests. */
export function verifyAuthority(
  fixture: Fixture,
  subject: string,
  userId: string | null,
  at: string,
): void {
  fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
    roles: [
      {
        subject,
        login: `login-${subject}`,
        source_kind: "direct_collaborator",
        provider_role: "write",
        authority_ref: REPO_ID,
        inherited_from: null,
      },
    ],
    verified_at: at,
    ...(userId ? { subject_users: { [subject]: userId } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Scripted provider adapter
// ---------------------------------------------------------------------------

export interface ScriptedAdapterOptions {
  provider_type?: ProviderType;
  /** Pages returned by successive fetchRosterPage calls (cursor = index). */
  pages?: RosterPage[];
  visibility?: "full" | "partial" | "none";
  pages_max?: number;
  required_token_scope?: string[];
  /** fetchEffectivePermission results keyed by subject. */
  effective?: Record<string, RawProviderRole | null>;
  /** Make fetchEffectivePermission throw MissingPermissionError. */
  denyPermissionQuery?: boolean;
}

export interface ScriptedAdapter extends ProviderAdapter {
  /** Number of roster page fetches observed. */
  fetchCount: number;
  capabilities: ProviderAdapterCapabilities;
}

export function scriptedAdapter(options: ScriptedAdapterOptions = {}): ScriptedAdapter {
  const pages = options.pages ?? [];
  const adapter: ScriptedAdapter = {
    provider_type: options.provider_type ?? "github",
    fetchCount: 0,
    capabilities: {
      effective_permission_visibility: options.visibility ?? "full",
      pagination: { per_page_max: 100, pages_max: options.pages_max ?? 10 },
      rate_limit: { requests_per_minute: 1000, retry_after_supported: true },
      required_token_scope: options.required_token_scope ?? ["repo:read"],
      checkout_capability: "read",
      delivery_capability: "scoped_write",
    },
    async fetchRosterPage(
      _ctx: ProviderCallContext,
      _repository: RepositoryRef,
      cursor: string | null,
    ): Promise<RosterPage> {
      adapter.fetchCount += 1;
      const index = cursor === null ? 0 : Number(cursor);
      const page = pages[index];
      if (!page) {
        return { entries: [], next_cursor: null, has_more: false };
      }
      return page;
    },
    async fetchEffectivePermission(
      _ctx: ProviderCallContext,
      _repository: RepositoryRef,
      subject: string,
    ): Promise<RawProviderRole | null> {
      if (options.denyPermissionQuery) {
        const { MissingPermissionError } = await import("../../src/provider-access/types.js");
        throw new MissingPermissionError("permission_query");
      }
      return options.effective?.[subject] ?? null;
    },
  };
  return adapter;
}

export function page(entries: RawProviderRole[], overrides: Partial<RosterPage> = {}): RosterPage {
  return {
    entries,
    next_cursor: null,
    has_more: false,
    ...overrides,
  };
}

export function role(
  subject: string,
  kind: RawProviderRole["kind"],
  providerRole: string,
  authorityRef: string,
  extra: { login?: string; inherited_from?: string | null } = {},
): RawProviderRole {
  return {
    subject,
    login: extra.login ?? `login-${subject}`,
    kind,
    provider_role: providerRole,
    authority_ref: authorityRef,
    inherited_from: extra.inherited_from ?? null,
  };
}
