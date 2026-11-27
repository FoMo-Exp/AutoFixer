/**
 * Versioned authorization context (DAT-291, ADR-0011).
 *
 * The context is the single, versioned answer to "what may this member do in
 * this workspace right now": enterprise membership, assigned role, the complete
 * active repository set at one version, per-repository verified capability
 * evidence, the intersected ceiling, freshness and the requested target.
 *
 * These tests pin the acceptance rules: write on A + read on B yields read
 * only, any repository without code read denies access, unknown/expired/
 * unavailable evidence never becomes a recorded loss, a confirmed downgrade
 * survives provider recovery until audited reapproval, GitHub and GitLab
 * evidence intersect across providers, another tenant is never visible, a
 * stale set version refuses, and the single-repository/local-prototype shapes
 * keep their existing behavior. The immutable rollout gate is never bypassed:
 * complete-set evaluation requires the gate to be enabled.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  createIdentityRepositories,
  createMemberCapabilityRepository,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
  type ControlPlaneDb,
  type ProviderRoleSourceKind,
  type ServiceIntegration,
  type WorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import { createAuthorityEpoch } from "../src/provider-access/access-gate.js";
import {
  AuthorizationContextError,
  AUTHORIZATION_CONTEXT_SCHEMA_VERSION,
  createAuthorizationContextService,
  type AuthorizationContextService,
} from "../src/provider-access/authorization-context.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import type { ActionKind } from "../src/provider-access/types.js";
import {
  ACTOR,
  NOW,
  REPO_ID,
  addMember,
  setupFixture,
  type Fixture,
} from "./helpers/provider-access.js";

const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
/** Two and a half days before NOW: past the stale bound. */
const OLD = "2026-11-01T00:00:00.000Z";
const ALL_WRITE = ["code_read", "issue_write", "repository_write"];

let fixture: Fixture;

beforeEach(() => {
  fixture = setupFixture();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  context: AuthorizationContextService;
  ceilings: ReturnType<typeof createCapabilityCeilingService>;
  sets: WorkspaceRepositorySetRepository;
}

/**
 * A context service over the fixture database. `enforcement: "complete"` is the
 * DAT-291 engine mode; the immutable gate remains the outer decision.
 */
function harness(options: { enforcement?: "complete" | "none" } = {}): Harness {
  const repos = createRepositories(fixture.db);
  const identity = createIdentityRepositories(fixture.db);
  const sets = createWorkspaceRepositorySetRepository(fixture.db);
  const ceilings = createCapabilityCeilingService({
    repositorySets: sets,
    access: fixture.access,
    memberships: repos.memberships,
    providerInstances: repos.providerInstances,
    identity,
    capabilities: createMemberCapabilityRepository(fixture.db),
    epoch: createAuthorityEpoch(),
    clock: () => fixture.clock.now,
    freshWindowMs: FRESH_MS,
    staleAfterMs: STALE_MS,
    ...(options.enforcement === "complete"
      ? { multiRepositoryEnforcement: "complete" as const }
      : {}),
  });
  const context = createAuthorizationContextService({
    repositorySets: sets,
    capabilityCeilings: ceilings,
    memberships: repos.memberships,
    enterpriseUsers: identity.enterpriseUsers,
    users: identity.users,
    access: fixture.access,
    clock: () => fixture.clock.now,
    freshWindowMs: FRESH_MS,
    staleAfterMs: STALE_MS,
  });
  return { context, ceilings, sets };
}

let bindingSequence = 0;

/** Bind one more repository through its own active installation. */
function addRepository(
  options: {
    repositoryId?: string;
    providerInstanceId?: string;
    providerType?: "github" | "gitlab";
  } = {},
): ServiceIntegration {
  bindingSequence += 1;
  const providerInstanceId = options.providerInstanceId ?? fixture.providerInstanceId;
  const repositoryId = options.repositoryId ?? `github:repo:${9100 + bindingSequence}`;
  const integration = fixture.access.integrations.create(fixture.scope, {
    provider_instance_id: providerInstanceId,
    repository_id: repositoryId,
    repository_name: repositoryId,
    source_credential_ref: `svc-source-${bindingSequence}`,
    checkout_credential_ref: `svc-checkout-${bindingSequence}`,
    delivery_credential_ref: `svc-delivery-${bindingSequence}`,
    permission_visibility: "full",
    actor_id: ACTOR,
  });
  const count = (
    fixture.db
      .prepare("SELECT COUNT(*) AS n FROM workspace_repository_binding WHERE workspace_id = ?")
      .get(fixture.workspaceId) as { n: number }
  ).n;
  fixture.db
    .prepare(
      `INSERT INTO workspace_repository_binding
         (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
          repository_id, repository_url, repository_name, position, status,
          created_at, updated_at, created_by, updated_by, version)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?, 1)`,
    )
    .run(
      `wrb_ctx_${bindingSequence}`,
      fixture.scope.enterprise_id,
      fixture.workspaceId,
      integration.provider_instance_id,
      integration.id,
      integration.repository_id,
      integration.repository_name,
      count + 1,
      NOW,
      NOW,
      ACTOR,
      ACTOR,
    );
  return integration;
}

/** Enable the immutable multi-repository gate in this test database only. */
function enableGate(db: ControlPlaneDb): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', 'authorization-context test rollout', ?, ?)`,
  ).run(MULTI_REPOSITORY_GATE_KEY, CURRENT_SCHEMA_VERSION, NOW, ACTOR);
}

/** Record one verified provider role for a subject on one installation. */
function verify(
  integration: ServiceIntegration,
  subject: string,
  userId: string,
  providerRole: string,
  options: { at?: string; kind?: ProviderRoleSourceKind } = {},
): void {
  fixture.access.roster.applySnapshot(fixture.scope, integration.id, {
    roles: [
      {
        subject,
        login: `login-${subject}`,
        source_kind: options.kind ?? "direct_collaborator",
        provider_role: providerRole,
        authority_ref: integration.repository_id,
        inherited_from: null,
      },
    ],
    verified_at: options.at ?? NOW,
    subject_users: { [subject]: userId },
  });
}

function addGitlabIdentity(userId: string, subject: string, providerInstanceId: string): void {
  fixture.identity.identities.create({
    user_id: userId,
    provider_instance_id: providerInstanceId,
    subject,
    login: `gl-${subject}`,
    actor_id: ACTOR,
  });
}

function grantDeliveryWrite(integration: ServiceIntegration, userId: string): void {
  fixture.access.grants.grant(fixture.scope, integration.id, {
    grantee_user_id: userId,
    capability: "delivery_write",
    expires_at: new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString(),
    actor_id: ACTOR,
  });
}

function decision(
  h: Harness,
  userId: string,
  action: ActionKind,
  extra: { target?: { provider_instance_id: string; repository_id: string } | null } = {},
) {
  return h.context.evaluate({
    scope: fixture.scope,
    user_id: userId,
    action,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Single-repository compatibility
// ---------------------------------------------------------------------------

describe("single-repository compatibility", () => {
  test("the context reproduces the request gate decision for every action", () => {
    const { userId } = addMember(fixture, { subject: "6001", login: "sam", role: "member" });
    verify(fixture.integration, "6001", userId, "write");
    const h = harness();

    const context = decision(h, userId, "read");
    expect(context.schema_version).toBe(AUTHORIZATION_CONTEXT_SCHEMA_VERSION);
    expect(context.repository_authority).toBe("verified");
    expect(context.repository_set).toMatchObject({
      version: 1,
      readable: true,
      repository_count: 1,
      multi_repository: false,
      gate: "disabled",
      enforced: false,
      target: null,
      version_conflict: false,
    });
    expect(context.capabilities).toEqual(ALL_WRITE);
    expect(context.repositories).toHaveLength(1);
    expect(context.repositories[0]).toMatchObject({
      repository_id: REPO_ID,
      provider_instance_id: fixture.providerInstanceId,
      installation_id: fixture.integration.id,
      state: "verified",
      target: false,
    });
    expect(context.decision).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      status: 200,
      required_capability: "code_read",
    });
    expect(context.freshness.fresh).toBe(true);
    expect(context.repository_set.version).toBe(h.sets.currentSetVersion(fixture.scope));

    // Same facts, same answer as the request gate the deployment already runs.
    for (const action of [
      "read",
      "stream",
      "artifact_read",
      "issue_sync",
      "approval",
      "manage",
      "write",
      "delivery",
    ] as ActionKind[]) {
      const fromContext = decision(h, userId, action).decision.allowed;
      const fromGate = fixture.gate.authorize({
        scope: fixture.scope,
        user_id: userId,
        action,
      }).allowed;
      expect({ action, allowed: fromContext }).toEqual({ action, allowed: fromGate });
    }
  });

  test("a live delivery grant enables a write for both the gate and the context", () => {
    const { userId } = addMember(fixture, { subject: "6002", login: "tess", role: "member" });
    verify(fixture.integration, "6002", userId, "write");
    const h = harness();

    expect(decision(h, userId, "write").decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_GRANT_REQUIRED",
      reason: "capability_grant",
    });

    grantDeliveryWrite(fixture.integration, userId);

    expect(decision(h, userId, "write").decision.allowed).toBe(true);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "write" }).allowed,
    ).toBe(true);
  });

  test("the assigned role and action policy still bound the verified ceiling", () => {
    const { userId } = addMember(fixture, { subject: "6003", login: "vic", role: "viewer" });
    verify(fixture.integration, "6003", userId, "admin");
    const h = harness();

    // The provider proves management, but the assigned role is a viewer.
    expect(decision(h, userId, "read").decision.allowed).toBe(true);
    expect(decision(h, userId, "issue_sync").decision).toMatchObject({
      allowed: false,
      code: "WORKSPACE_ROLE_REQUIRED",
      reason: "workspace_role",
    });
    expect(decision(h, userId, "manage").decision.code).toBe("WORKSPACE_ROLE_REQUIRED");
  });

  test("GitLab roles map through the same explicit capability policy", () => {
    const gitlab = setupFixture({ provider_type: "gitlab" });
    const member = addMember(gitlab, { subject: "6101", login: "gia", role: "member" });
    gitlab.access.roster.applySnapshot(gitlab.scope, gitlab.integration.id, {
      roles: [
        {
          subject: "6101",
          login: "gia",
          source_kind: "direct_collaborator",
          provider_role: "reporter",
          authority_ref: REPO_ID,
          inherited_from: null,
        },
      ],
      verified_at: NOW,
      subject_users: { "6101": member.userId },
    });
    const context = createAuthorizationContextService({
      repositorySets: createWorkspaceRepositorySetRepository(gitlab.db),
      capabilityCeilings: gitlab.capabilityCeilings,
      memberships: createRepositories(gitlab.db).memberships,
      enterpriseUsers: gitlab.identity.enterpriseUsers,
      users: gitlab.identity.users,
      access: gitlab.access,
      clock: () => gitlab.clock.now,
      freshWindowMs: FRESH_MS,
      staleAfterMs: STALE_MS,
    });

    const read = context.evaluate({
      scope: gitlab.scope,
      user_id: member.userId,
      action: "read",
    });
    expect(read.capabilities).toEqual(["code_read"]);
    expect(read.decision.allowed).toBe(true);

    const issue = context.evaluate({
      scope: gitlab.scope,
      user_id: member.userId,
      action: "issue_sync",
    });
    expect(issue.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
      reason: "capability_ceiling",
    });
  });

  test("the local-prototype shape stays bounded by role and policy, not provider facts", () => {
    const workspace = seedWorkspace(fixture.db, fixture.adminScope, {
      name: "Prototype",
      repository_id: "github:repo:7777",
      provider_instance_id: fixture.providerInstanceId,
    });
    const scope = {
      enterprise_id: fixture.scope.enterprise_id,
      workspace_id: workspace.id,
      actor_id: ACTOR,
    };
    const user = fixture.identity.users.create({ display_name: "proto", actor_id: ACTOR });
    fixture.identity.enterpriseUsers.ensureActive(
      fixture.scope.enterprise_id,
      user.id,
      { kind: "user", user_id: ACTOR },
      { provider_instance_id: fixture.providerInstanceId, subject: "6201" },
    );
    createRepositories(fixture.db).memberships.create(scope, {
      user_id: user.id,
      role: "member",
    });
    const h = harness();

    const context = h.context.evaluate({ scope, user_id: user.id, action: "write" });
    expect(context.repository_authority).toBe("not_applicable");
    expect(context.repositories).toEqual([]);
    expect(context.repository_set).toMatchObject({ readable: true, multi_repository: false });
    // No integration row: the legacy role-only boundary is unchanged, and no
    // capability grant is invented or required.
    expect(context.decision).toMatchObject({ allowed: true, code: "ALLOWED" });
  });
});

// ---------------------------------------------------------------------------
// Complete-set intersection
// ---------------------------------------------------------------------------

describe("complete-set intersection", () => {
  test("write on A and read on B yields read only", () => {
    const { userId } = addMember(fixture, { subject: "7001", login: "zoe", role: "member" });
    verify(fixture.integration, "7001", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9002" });
    verify(second, "7001", userId, "read");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const context = decision(h, userId, "read");
    expect(context.repository_authority).toBe("verified");
    expect(context.repository_set).toMatchObject({
      repository_count: 2,
      multi_repository: true,
      gate: "enabled",
      enforced: true,
    });
    expect(context.available_capabilities).toEqual(["code_read"]);
    expect(context.capabilities).toEqual(["code_read"]);
    expect(context.repositories.map((repository) => repository.state)).toEqual([
      "verified",
      "verified",
    ]);
    expect(context.decision.allowed).toBe(true);

    // Write on A cannot compensate for read on B — nor can a grant.
    expect(decision(h, userId, "write").decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
      reason: "capability_ceiling",
      required_capability: "repository_write",
    });
    expect(decision(h, userId, "issue_sync").decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
    });
    expect(decision(h, userId, "stream").decision.allowed).toBe(true);
  });

  test("a repository with confirmed no code read denies admission", () => {
    const { userId } = addMember(fixture, { subject: "7002", login: "yan", role: "member" });
    verify(fixture.integration, "7002", userId, "write");
    const gitlabInstance = seedProviderInstance(fixture.db, fixture.adminScope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    addGitlabIdentity(userId, "gl-7002", gitlabInstance.id);
    const second = addRepository({
      repositoryId: "gitlab:repo:7002",
      providerInstanceId: gitlabInstance.id,
    });
    verify(second, "gl-7002", userId, "guest");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const context = decision(h, userId, "read");
    expect(context.repository_authority).toBe("confirmed_loss");
    expect(context.repositories.map((repository) => repository.state)).toEqual([
      "verified",
      "verified",
    ]);
    // The verified intersection lacks code read: confirmed, not unknown.
    expect(context.available_capabilities).toEqual([]);
    expect(context.capabilities).toEqual([]);
    expect(context.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_LOSS",
      reason: "capability_loss",
      requires_reconciliation: false,
    });
    expect(context.decision.capability_reason).toBe("no_code_read");
  });

  test("GitHub and GitLab evidence intersect across providers", () => {
    const { userId } = addMember(fixture, { subject: "7003", login: "ada", role: "admin" });
    verify(fixture.integration, "7003", userId, "maintain"); // no management capability
    const gitlabInstance = seedProviderInstance(fixture.db, fixture.adminScope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    addGitlabIdentity(userId, "gl-7003", gitlabInstance.id);
    const second = addRepository({
      repositoryId: "gitlab:repo:7003",
      providerInstanceId: gitlabInstance.id,
    });
    verify(second, "gl-7003", userId, "owner"); // would prove management on its own
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const read = decision(h, userId, "read");
    expect(read.repository_authority).toBe("verified");
    expect(read.available_capabilities).toEqual(ALL_WRITE);

    // GitLab `owner` cannot compensate for GitHub `maintain`: management needs
    // it on *every* repository, and the admin role alone is not enough.
    expect(decision(h, userId, "manage").decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
      reason: "capability_ceiling",
    });

    // Losing code read on the GitLab repository denies even ordinary reads.
    verify(second, "gl-7003", userId, "guest");
    expect(decision(h, userId, "read").decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_LOSS",
    });
  });

  test("an unverified repository denies without being recorded as a confirmed loss", () => {
    const { userId } = addMember(fixture, { subject: "7004", login: "nils", role: "member" });
    verify(fixture.integration, "7004", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9004" });
    verify(second, "7004", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const verified = decision(h, userId, "read");
    expect(verified.decision.allowed).toBe(true);
    const record = verified.ceiling;
    expect(record.state).toBe("approved");
    expect(record.capabilities).toEqual(ALL_WRITE);

    // The provider cannot be observed on one repository. That is an outage,
    // not a removal: access fails closed and nothing is persisted.
    fixture.access.roster.setAuthorityState(fixture.scope, second.id, "7004", "unknown", NOW);

    const unverified = decision(h, userId, "read");
    expect(unverified.repository_authority).toBe("unverified");
    expect(unverified.decision).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
      reason: "capability_unverified",
      requires_reconciliation: true,
    });
    expect(unverified.decision.capability_reason).toBe("authority_unknown");

    const persisted = createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId);
    expect(persisted?.state).toBe("approved");
    expect(persisted?.ceiling).toEqual(ALL_WRITE);
    expect(
      fixture.identity.authAudit.list({
        enterprise_id: fixture.scope.enterprise_id,
        event: "capability_ceiling.downgraded",
      }),
    ).toHaveLength(0);

    // The same facts verify again: access unblocks, no promotion is involved.
    verify(second, "7004", userId, "write", { at: NOW });
    expect(decision(h, userId, "read").decision.allowed).toBe(true);
  });

  test("an expired verification is a recheck, not a downgrade", () => {
    const { userId } = addMember(fixture, { subject: "7005", login: "opal", role: "member" });
    verify(fixture.integration, "7005", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9005" });
    verify(second, "7005", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });
    expect(decision(h, userId, "read").decision.allowed).toBe(true);

    verify(second, "7005", userId, "write", { at: OLD });

    const expired = decision(h, userId, "read");
    expect(expired.repository_authority).toBe("unverified");
    expect(expired.decision.capability_reason).toBe("verification_expired");
    expect(expired.decision.requires_reconciliation).toBe(true);
    expect(
      createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId)?.ceiling,
    ).toEqual(ALL_WRITE);

    verify(second, "7005", userId, "write", { at: NOW });
    expect(decision(h, userId, "read").decision.allowed).toBe(true);
  });

  test("a stale authority is a recheck, not a loss", () => {
    const { userId } = addMember(fixture, { subject: "7008", login: "sol", role: "member" });
    verify(fixture.integration, "7008", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9008" });
    verify(second, "7008", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });
    expect(decision(h, userId, "read").decision.allowed).toBe(true);

    fixture.access.roster.setAuthorityState(fixture.scope, second.id, "7008", "stale", NOW);

    const stale = decision(h, userId, "read");
    expect(stale.decision).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
      requires_reconciliation: true,
    });
    expect(stale.decision.capability_reason).toBe("authority_stale");
    expect(createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId)?.state).toBe(
      "approved",
    );
  });

  test("a suspended installation is unavailable, not a removed repository", () => {
    const { userId } = addMember(fixture, { subject: "7009", login: "taj", role: "member" });
    verify(fixture.integration, "7009", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9009" });
    verify(second, "7009", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });
    expect(decision(h, userId, "read").decision.allowed).toBe(true);

    const current = fixture.access.integrations.getById(fixture.scope, second.id)!;
    fixture.access.integrations.setStatus(
      fixture.scope,
      second.id,
      { install_status: "suspended", actor_id: ACTOR },
      current.version,
    );

    const blocked = decision(h, userId, "read");
    expect(blocked.decision).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_UNAVAILABLE",
      reason: "capability_unverified",
      requires_reconciliation: false,
    });
    expect(blocked.decision.capability_reason).toBe("installation_not_approved");

    const persisted = createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId);
    expect(persisted?.state).toBe("approved");
    expect(persisted?.ceiling).toEqual(ALL_WRITE);
  });

  test("an installation paired with another provider instance is ambiguous evidence", () => {
    const { userId } = addMember(fixture, { subject: "7010", login: "uma", role: "member" });
    verify(fixture.integration, "7010", userId, "write");

    // An installation created for this repository on provider instance A,
    // then named by a binding that claims provider instance B: the roster of B
    // must never be read as A's evidence.
    const instanceB = seedProviderInstance(fixture.db, fixture.adminScope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    const installation = fixture.access.integrations.create(fixture.scope, {
      provider_instance_id: fixture.providerInstanceId,
      repository_id: "github:repo:9010",
      repository_name: "github:repo:9010",
      source_credential_ref: "svc-source-9010",
      permission_visibility: "full",
      actor_id: ACTOR,
    });
    fixture.db
      .prepare(
        `INSERT INTO workspace_repository_binding
           (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
            repository_id, repository_url, repository_name, position, status,
            created_at, updated_at, created_by, updated_by, version)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 2, 'active', ?, ?, ?, ?, 1)`,
      )
      .run(
        "wrb_ctx_ambiguous",
        fixture.scope.enterprise_id,
        fixture.workspaceId,
        instanceB.id,
        installation.id,
        "github:repo:9010",
        "github:repo:9010",
        NOW,
        NOW,
        ACTOR,
        ACTOR,
      );
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const context = decision(h, userId, "read");
    expect(context.decision).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_UNAVAILABLE",
    });
    expect(context.decision.capability_reason).toBe("installation_not_approved");
    expect(createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId)).toBeUndefined();
  });

  test("a confirmed downgrade persists and provider recovery still needs reapproval", () => {
    const target = addMember(fixture, { subject: "7006", login: "rae", role: "member" });
    verify(fixture.integration, "7006", target.userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9006" });
    verify(second, "7006", target.userId, "write");

    const admin = addMember(fixture, { subject: "7007", login: "abe", role: "admin" });
    verify(fixture.integration, "7007", admin.userId, "admin");
    verify(second, "7007", admin.userId, "admin");
    fixture.identity.enterpriseRoles.grant({
      enterprise_id: fixture.scope.enterprise_id,
      user_id: admin.userId,
      role: "admin",
      actor_id: ACTOR,
    });
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    expect(decision(h, target.userId, "issue_sync").decision.allowed).toBe(true);

    // A positively confirmed reduction: B drops to read.
    verify(second, "7006", target.userId, "read");
    const reduced = decision(h, target.userId, "issue_sync");
    expect(reduced.repository_authority).toBe("verified");
    expect(reduced.available_capabilities).toEqual(["code_read"]);
    expect(reduced.ceiling.state).toBe("downgraded");
    expect(reduced.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
    });

    // Provider recovery is observable but is not a promotion.
    verify(second, "7006", target.userId, "write");
    const recovered = decision(h, target.userId, "issue_sync");
    expect(recovered.available_capabilities).toEqual(ALL_WRITE);
    expect(recovered.capabilities).toEqual(["code_read"]);
    expect(recovered.ceiling.promotion_available).toBe(true);
    expect(recovered.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
    });

    // Only an audited administrator reapproval, inside the verified bound,
    // raises the ceiling again.
    const record = createMemberCapabilityRepository(fixture.db).get(fixture.scope, target.userId)!;
    h.ceilings.reapprove(fixture.scope, admin.userId, {
      workspace_id: fixture.scope.workspace_id,
      user_id: target.userId,
      capabilities: null,
      version: record.version,
    });

    const approved = decision(h, target.userId, "issue_sync");
    expect(approved.capabilities).toEqual(ALL_WRITE);
    expect(approved.ceiling.state).toBe("approved");
    expect(approved.decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rollout gate and enforcement
// ---------------------------------------------------------------------------

describe("rollout gate", () => {
  test("complete-set enforcement cannot override a disabled gate", () => {
    const { userId } = addMember(fixture, { subject: "7101", login: "ida", role: "member" });
    verify(fixture.integration, "7101", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9101" });
    verify(second, "7101", userId, "write");
    const h = harness({ enforcement: "complete" });

    const context = decision(h, userId, "read");
    expect(context.repository_set).toMatchObject({
      multi_repository: true,
      gate: "disabled",
      enforced: false,
    });
    expect(context.repository_authority).toBe("unverified");
    expect(context.decision).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_UNAVAILABLE",
      reason: "capability_unverified",
      requires_reconciliation: false,
    });
    expect(context.decision.capability_reason).toBe("repository_set_unsupported");
  });

  test("an enabled gate still refuses when the build has no complete-set enforcement", () => {
    const { userId } = addMember(fixture, { subject: "7102", login: "joe", role: "member" });
    verify(fixture.integration, "7102", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9102" });
    verify(second, "7102", userId, "write");
    enableGate(fixture.db);
    const h = harness();

    const context = decision(h, userId, "read");
    expect(context.repository_set).toMatchObject({ gate: "enabled", enforced: false });
    expect(context.decision).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_UNAVAILABLE",
    });
    expect(h.context.enforcement()).toBe("none");
  });

  test("enabled gate plus complete-set enforcement authorizes the whole set", () => {
    const { userId } = addMember(fixture, { subject: "7103", login: "kai", role: "member" });
    verify(fixture.integration, "7103", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9103" });
    verify(second, "7103", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const context = decision(h, userId, "read");
    expect(h.context.enforcement()).toBe("complete");
    expect(context.repository_set).toMatchObject({
      multi_repository: true,
      gate: "enabled",
      enforced: true,
      repository_count: 2,
    });
    expect(context.repository_authority).toBe("verified");
    expect(context.capabilities).toEqual(ALL_WRITE);
    expect(context.decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

describe("versioned decisions", () => {
  test("a stale observed set version refuses with a 409 conflict", () => {
    const { userId } = addMember(fixture, { subject: "7201", login: "liv", role: "member" });
    verify(fixture.integration, "7201", userId, "write");
    const h = harness();

    const fresh = h.context.evaluate({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
      expected_set_version: 1,
    });
    expect(fresh.decision.allowed).toBe(true);

    const stale = h.context.evaluate({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
      expected_set_version: 99,
    });
    expect(stale.repository_set.version_conflict).toBe(true);
    expect(stale.decision).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_VERSION_CONFLICT",
      status: 409,
      reason: "repository_set_version",
    });
    expect(() =>
      h.context.assert({
        scope: fixture.scope,
        user_id: userId,
        action: "read",
        expected_set_version: 99,
      }),
    ).toThrow(AuthorizationContextError);
    try {
      h.context.assert({
        scope: fixture.scope,
        user_id: userId,
        action: "read",
        expected_set_version: 99,
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "REPOSITORY_SET_VERSION_CONFLICT",
        status: 409,
      });
    }
  });

  test("isCurrent refuses a context formed before a set change", () => {
    const { userId } = addMember(fixture, { subject: "7202", login: "max", role: "member" });
    verify(fixture.integration, "7202", userId, "write");
    const h = harness();

    const before = decision(h, userId, "read");
    expect(h.context.isCurrent(before)).toBe(true);

    fixture.db
      .prepare(
        "UPDATE workspace SET repository_set_version = repository_set_version + 1 WHERE id = ?",
      )
      .run(fixture.workspaceId);

    expect(h.context.isCurrent(before)).toBe(false);
    expect(before.repository_set.version).toBe(1);

    const after = h.context.evaluate({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
      expected_set_version: before.repository_set.version,
    });
    expect(after.repository_set.version).toBe(2);
    expect(after.decision.code).toBe("REPOSITORY_SET_VERSION_CONFLICT");
  });

  test("every evaluation re-reads evidence; nothing is cached", () => {
    const { userId } = addMember(fixture, { subject: "7203", login: "noor", role: "member" });
    verify(fixture.integration, "7203", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9203" });
    verify(second, "7203", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    expect(decision(h, userId, "issue_sync").decision.allowed).toBe(true);

    // A concurrent provider change tightens one repository. The next
    // evaluation sees it without any invalidation call.
    verify(second, "7203", userId, "read");

    const tightened = decision(h, userId, "issue_sync");
    expect(tightened.available_capabilities).toEqual(["code_read"]);
    expect(tightened.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_REQUIRED",
    });
    // The set version did not move: freshness of *evidence* is a per-decision
    // fact, so a context is re-evaluated for each sensitive action.
    expect(tightened.repository_set.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("immutability", () => {
  test("the context and every nested decision fact are deeply frozen", () => {
    const { userId } = addMember(fixture, { subject: "7501", login: "ivy", role: "member" });
    verify(fixture.integration, "7501", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9501" });
    verify(second, "7501", userId, "read");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const denied = decision(h, userId, "issue_sync", {
      target: {
        provider_instance_id: second.provider_instance_id,
        repository_id: second.repository_id,
      },
    });
    expect(denied.decision).toMatchObject({ allowed: false, code: "CAPABILITY_REQUIRED" });

    // Every container a consumer could reach is frozen, not just the root.
    expect(Object.isFrozen(denied)).toBe(true);
    expect(Object.isFrozen(denied.decision)).toBe(true);
    expect(Object.isFrozen(denied.repository_set)).toBe(true);
    expect(Object.isFrozen(denied.repository_set.target)).toBe(true);
    expect(Object.isFrozen(denied.freshness)).toBe(true);
    expect(Object.isFrozen(denied.enterprise)).toBe(true);
    expect(Object.isFrozen(denied.workspace)).toBe(true);
    expect(Object.isFrozen(denied.ceiling)).toBe(true);
    expect(Object.isFrozen(denied.ceiling.capabilities)).toBe(true);
    expect(Object.isFrozen(denied.repositories)).toBe(true);
    expect(Object.isFrozen(denied.repositories[0])).toBe(true);
    expect(Object.isFrozen(denied.capabilities)).toBe(true);
    expect(Object.isFrozen(denied.available_capabilities)).toBe(true);

    // A denied decision cannot be rewritten into an allow, and the facts
    // behind it cannot be edited after evaluation.
    expect(() => {
      (denied.decision as { allowed: boolean }).allowed = true;
    }).toThrow(TypeError);
    expect(denied.decision.allowed).toBe(false);

    expect(() => {
      (denied.capabilities as unknown as string[]).push("repository_write");
    }).toThrow(TypeError);
    expect(denied.capabilities).toEqual(["code_read"]);

    expect(() => {
      (denied.repositories[0] as { state: string }).state = "removed";
    }).toThrow(TypeError);
    expect(denied.repositories[0]!.state).toBe("verified");

    // An allowed context is frozen the same way.
    const allowed = decision(h, userId, "read");
    expect(Object.isFrozen(allowed.decision)).toBe(true);
    expect(() => {
      (allowed.decision as { allowed: boolean }).allowed = false;
    }).toThrow(TypeError);
    expect(allowed.decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Target repository and grants
// ---------------------------------------------------------------------------

describe("target repository", () => {
  test("the target must be exactly one active binding of the set", () => {
    const { userId } = addMember(fixture, { subject: "7301", login: "oz", role: "member" });
    verify(fixture.integration, "7301", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9301" });
    verify(second, "7301", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    const bound = decision(h, userId, "issue_sync", {
      target: {
        provider_instance_id: second.provider_instance_id,
        repository_id: second.repository_id,
      },
    });
    expect(bound.decision.allowed).toBe(true);
    expect(bound.repositories.filter((repository) => repository.target)).toHaveLength(1);
    expect(bound.repositories.find((repository) => repository.target)?.repository_id).toBe(
      second.repository_id,
    );

    // Unknown repository: never resolved to "the first repository".
    const foreign = decision(h, userId, "issue_sync", {
      target: {
        provider_instance_id: fixture.providerInstanceId,
        repository_id: "github:repo:does-not-exist",
      },
    });
    expect(foreign.decision).toMatchObject({
      allowed: false,
      code: "TARGET_REPOSITORY_UNAVAILABLE",
      reason: "target_repository",
    });

    // Right repository id, wrong provider instance is a different identity.
    const wrongInstance = decision(h, userId, "issue_sync", {
      target: {
        provider_instance_id: "pinst_other",
        repository_id: second.repository_id,
      },
    });
    expect(wrongInstance.decision.code).toBe("TARGET_REPOSITORY_UNAVAILABLE");
  });

  test("a capability grant is scoped to the target repository", () => {
    const { userId } = addMember(fixture, { subject: "7302", login: "paz", role: "member" });
    verify(fixture.integration, "7302", userId, "write");
    const second = addRepository({ repositoryId: "github:repo:9302" });
    verify(second, "7302", userId, "write");
    enableGate(fixture.db);
    const h = harness({ enforcement: "complete" });

    grantDeliveryWrite(fixture.integration, userId);

    const targetA = decision(h, userId, "write", {
      target: {
        provider_instance_id: fixture.providerInstanceId,
        repository_id: fixture.integration.repository_id,
      },
    });
    expect(targetA.decision.allowed).toBe(true);

    const targetB = decision(h, userId, "write", {
      target: {
        provider_instance_id: second.provider_instance_id,
        repository_id: second.repository_id,
      },
    });
    expect(targetB.decision).toMatchObject({
      allowed: false,
      code: "CAPABILITY_GRANT_REQUIRED",
    });

    // Without a target the action may touch the whole set, so the grant must
    // hold on every repository.
    expect(decision(h, userId, "write").decision.code).toBe("CAPABILITY_GRANT_REQUIRED");

    grantDeliveryWrite(second, userId);
    expect(decision(h, userId, "write").decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  test("another tenant's member cannot obtain a context for this workspace", () => {
    const { userId } = addMember(fixture, { subject: "7401", login: "quinn", role: "member" });
    verify(fixture.integration, "7401", userId, "write");

    const other = seedEnterprise(fixture.db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: "other-ent",
      admin_user_id: "usr_other",
    });
    const otherProvider = seedProviderInstance(fixture.db, other.admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const otherWorkspace = seedWorkspace(fixture.db, other.admin_scope, {
      name: "Other Workspace",
      repository_id: "github:repo:9999",
      provider_instance_id: otherProvider.id,
    });
    const otherUser = fixture.identity.users.create({
      display_name: "other",
      actor_id: "usr_other",
    });
    fixture.identity.identities.create({
      user_id: otherUser.id,
      provider_instance_id: otherProvider.id,
      subject: "7402",
      login: "other",
      actor_id: "usr_other",
    });
    fixture.identity.enterpriseUsers.ensureActive(
      other.enterprise.id,
      otherUser.id,
      { kind: "user", user_id: "usr_other" },
      { provider_instance_id: otherProvider.id, subject: "7402" },
    );
    createRepositories(fixture.db).memberships.create(
      {
        enterprise_id: other.enterprise.id,
        workspace_id: otherWorkspace.id,
        actor_id: "usr_other",
      },
      { user_id: otherUser.id, role: "owner" },
    );

    const h = harness();
    const crossTenant = h.context.evaluate({
      scope: fixture.scope,
      user_id: otherUser.id,
      action: "read",
    });
    expect(crossTenant.enterprise.member).toBe(false);
    expect(crossTenant.decision).toMatchObject({
      allowed: false,
      code: "ENTERPRISE_MEMBERSHIP_REQUIRED",
    });

    // The set is not even readable from the other enterprise's scope.
    expect(() =>
      h.sets.getSet({
        enterprise_id: other.enterprise.id,
        workspace_id: fixture.workspaceId,
        actor_id: ACTOR,
      }),
    ).toThrow(/not found/i);

    // A target from another workspace is never "close enough".
    const foreignTarget = h.context.evaluate({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
      target: {
        provider_instance_id: otherProvider.id,
        repository_id: "github:repo:9999",
      },
    });
    expect(foreignTarget.decision.code).toBe("TARGET_REPOSITORY_UNAVAILABLE");
  });
});
