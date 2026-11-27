/**
 * Collaboration authority under complete-set enforcement (DAT-294, ADR-0011).
 *
 * Approval eligibility and the broker's per-write delivery permission are
 * protected paths too: both are re-observed from live control-plane and
 * provider facts at the moment of the decision / provider write. These tests
 * wire them exactly as the running service does — the request authority backed
 * by the versioned authorization context — over a workspace with **two**
 * active repositories, and pin:
 *
 * - an approval is the intersection over the whole set, named against the
 *   issue's repository: repository write on the issue's repository is not
 *   enough when another repository grants only read;
 * - a resource whose repository left the set is refused as a target, not
 *   silently downgraded to a workspace-wide decision;
 * - the approval authority digest is bound to the set version, so a decision
 *   formed under one set is distinguishable from one formed under another;
 * - the delivery permission asks the live requester capability against the
 *   delivery's own repository, so a confirmed reduction on any repository —
 *   or a target that left the set — stops the provider write.
 *
 * The gate row is appended exactly as a forward migration would; the shipped
 * deployment still passes no enforcement option and keeps the refusing
 * default. Nothing here enables a production switch.
 */

import { describe, expect, test } from "vitest";

import { createApprovalDirectory, createDeliveryPermission } from "../src/api/collab-authority.js";
import { HTTP_ACTION_POLICY, createRequestAuthority } from "../src/api/request-authority.js";
import type { CollabMachine } from "../src/collab/machine.js";
import type { WorkspaceScope } from "../src/collab/types.js";
import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  createIdentityRepositories,
  createMemberCapabilityRepository,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  seedProviderInstance,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import { bumpRepositorySetVersion } from "../src/control-plane/workspace-repository-repositories.js";
import { createAuthorizationContextService } from "../src/provider-access/authorization-context.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import type { RequestAuthority } from "../src/api/request-authority.js";
import {
  NOW,
  REPO_ID,
  addMember,
  setupFixture,
  verifyAuthority,
  type Fixture,
} from "./helpers/provider-access.js";

const REPO_B = "gitlab:acme/service";
const GITHUB_SUBJECT = "8101";
const GITLAB_SUBJECT = "8601";

function enableGate(db: ControlPlaneDb): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', ?, ?, ?)`,
  ).run(
    MULTI_REPOSITORY_GATE_KEY,
    CURRENT_SCHEMA_VERSION,
    "test fixture: a build that enforces the whole set",
    NOW,
    "usr_operator",
  );
}

function insertSecondBinding(
  fixture: Fixture,
  providerInstanceId: string,
  installationRef: string,
): void {
  fixture.db
    .prepare(
      `INSERT INTO workspace_repository_binding
         (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
          repository_id, repository_url, repository_name, position, status,
          created_at, updated_at, created_by, updated_by, version)
       VALUES ('wrb_second', ?, ?, ?, ?, ?, 'https://gitlab.com/acme/service.git', 'acme/service', 2, 'active', ?, ?, ?, ?, 1)`,
    )
    .run(
      fixture.scope.enterprise_id,
      fixture.workspaceId,
      providerInstanceId,
      installationRef,
      REPO_B,
      NOW,
      NOW,
      "usr_operator",
      "usr_operator",
    );
}

function removeBinding(fixture: Fixture, repositoryId: string): void {
  fixture.db
    .prepare(
      `DELETE FROM workspace_repository_binding WHERE workspace_id = ? AND repository_id = ?`,
    )
    .run(fixture.workspaceId, repositoryId);
  bumpRepositorySetVersion(fixture.db, fixture.adminScope, fixture.workspaceId);
}

interface CompleteSet {
  fixture: Fixture;
  memberId: string;
  integrationB: string;
  authority: RequestAuthority;
  directory: ReturnType<typeof createApprovalDirectory>;
  setVersion(): number;
}

/**
 * One member over two repositories, with the production wiring: the request
 * authority decides from the versioned complete-set context, the approval
 * directory asks it about the issue's repository, and the context names the
 * set version the decision was formed against.
 */
function setupCompleteSet(options: { githubRole?: string; gitlabRole?: string } = {}): CompleteSet {
  const fixture = setupFixture();
  const member = addMember(fixture, { subject: GITHUB_SUBJECT, login: "ada", role: "admin" });
  verifyAuthority(fixture, GITHUB_SUBJECT, member.userId, NOW, {
    provider_role: options.githubRole ?? "write",
  });

  const gitlab = seedProviderInstance(fixture.db, fixture.adminScope, {
    provider_type: "gitlab",
    origin_url: "https://gitlab.com",
  });
  const integrationB = fixture.access.integrations.create(fixture.scope, {
    provider_instance_id: gitlab.id,
    repository_id: REPO_B,
    repository_name: "acme/service",
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: "usr_operator",
  });
  createIdentityRepositories(fixture.db).identities.create({
    user_id: member.userId,
    provider_instance_id: gitlab.id,
    subject: GITLAB_SUBJECT,
    login: "ada-gl",
    actor_id: "usr_operator",
  });
  fixture.access.roster.applySnapshot(fixture.scope, integrationB.id, {
    roles: [
      {
        subject: GITLAB_SUBJECT,
        login: "ada-gl",
        source_kind: "direct_collaborator",
        provider_role: options.gitlabRole ?? "developer",
        authority_ref: REPO_B,
        inherited_from: null,
      },
    ],
    verified_at: NOW,
  });

  insertSecondBinding(fixture, gitlab.id, integrationB.id);
  enableGate(fixture.db);
  bumpRepositorySetVersion(fixture.db, fixture.adminScope, fixture.workspaceId);

  const repositorySets = createWorkspaceRepositorySetRepository(fixture.db, {
    multiRepositoryRuntime: "complete",
  });
  const capabilityCeilings = createCapabilityCeilingService({
    repositorySets,
    access: fixture.access,
    memberships: fixture.memberships,
    providerInstances: createRepositories(fixture.db).providerInstances,
    identity: fixture.identity,
    capabilities: createMemberCapabilityRepository(fixture.db),
    epoch: fixture.epoch,
    clock: () => fixture.clock.now,
    freshWindowMs: 15 * 60 * 1000,
    staleAfterMs: 24 * 60 * 60 * 1000,
    multiRepositoryEnforcement: "complete",
  });
  const contexts = createAuthorizationContextService({
    repositorySets,
    capabilityCeilings,
    memberships: fixture.memberships,
    enterpriseUsers: fixture.identity.enterpriseUsers,
    users: fixture.identity.users,
    access: fixture.access,
    policy: HTTP_ACTION_POLICY,
    clock: () => fixture.clock.now,
  });
  const authority = createRequestAuthority({
    access: fixture.access,
    memberships: fixture.memberships,
    workspaces: fixture.workspaces,
    users: fixture.identity.users,
    identities: fixture.identity.identities,
    enterpriseUsers: fixture.identity.enterpriseUsers,
    capabilityCeilings,
    contexts,
    epoch: fixture.epoch,
    enterpriseId: fixture.scope.enterprise_id,
    workspaceId: fixture.workspaceId,
    clock: () => fixture.clock.now,
  });
  const directory = createApprovalDirectory({
    enterprise_id: fixture.scope.enterprise_id,
    memberships: fixture.memberships,
    users: fixture.users,
    identities: fixture.identities,
    access: fixture.access,
    clock: () => fixture.clock.now,
    workspaceActionAllowed: (input) => {
      const decision = authority.check(input.user_id, "approval", input.workspace_id, {
        repository_id: input.repository_id,
      });
      return decision.allowed === true;
    },
    workspaceSetVersion: (input) => {
      try {
        return repositorySets.currentSetVersion({
          enterprise_id: fixture.scope.enterprise_id,
          workspace_id: input.workspace_id,
          actor_id: "usr_operator",
        });
      } catch {
        return null;
      }
    },
  });

  return {
    fixture,
    memberId: member.userId,
    integrationB: integrationB.id,
    authority,
    directory,
    setVersion: () =>
      repositorySets.currentSetVersion({
        enterprise_id: fixture.scope.enterprise_id,
        workspace_id: fixture.workspaceId,
        actor_id: "usr_operator",
      }),
  };
}

function collabScope(fixture: Fixture): WorkspaceScope {
  return { enterprise_id: fixture.scope.enterprise_id, workspace_id: fixture.workspaceId };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe("approval eligibility follows the complete set and the target", () => {
  test("repository write on the issue's repository is not enough when another repository grants only read", () => {
    // Write on A, read on B: the intersection lacks repository write, so the
    // admin's role and A's roster fact cannot make them an eligible approver
    // for an issue on A.
    const narrow = setupCompleteSet({ githubRole: "write", gitlabRole: "reporter" });
    const narrowScope = collabScope(narrow.fixture);
    const denied = narrow.directory.member(narrowScope, REPO_ID, narrow.memberId);
    expect(denied?.role).toBe("admin");
    expect(denied?.approval_authority).toBe(true);
    expect(denied?.repository_access).toBe(false);

    // The same roles, both granting repository write: the complete set allows.
    const full = setupCompleteSet({ githubRole: "write", gitlabRole: "developer" });
    expect(
      full.directory.member(collabScope(full.fixture), REPO_ID, full.memberId)?.repository_access,
    ).toBe(true);
  });

  test("the issue's repository that left the set is refused as a target", () => {
    const ctx = setupCompleteSet({ githubRole: "write", gitlabRole: "developer" });
    const scope = collabScope(ctx.fixture);
    expect(ctx.directory.member(scope, REPO_B, ctx.memberId)?.repository_access).toBe(true);

    // B is no longer an active binding of the workspace set. Its integration
    // and roster evidence still exist, so only the set check can stop this.
    removeBinding(ctx.fixture, REPO_B);

    const decision = ctx.authority.check(ctx.memberId, "approval", ctx.fixture.workspaceId, {
      repository_id: REPO_B,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TARGET_REPOSITORY_UNAVAILABLE");
    expect(ctx.directory.member(scope, REPO_B, ctx.memberId)?.repository_access).toBe(false);
  });

  test("the approval authority digest is bound to the set version", () => {
    const ctx = setupCompleteSet();
    const scope = collabScope(ctx.fixture);
    const before = ctx.directory.authorityVersion(scope, REPO_ID);

    // The digest is a fact about the same authority, not a timestamp.
    expect(ctx.directory.authorityVersion(scope, REPO_ID)).toBe(before);

    // The set moves: a decision formed earlier is a different authority fact.
    bumpRepositorySetVersion(ctx.fixture.db, ctx.fixture.adminScope, ctx.fixture.workspaceId);
    const afterSetChange = ctx.directory.authorityVersion(scope, REPO_ID);
    expect(afterSetChange).not.toBe(before);

    // A verified reduction also changes the facts the decision was formed on.
    verifyAuthority(ctx.fixture, GITHUB_SUBJECT, ctx.memberId, NOW, { provider_role: "read" });
    expect(ctx.directory.authorityVersion(scope, REPO_ID)).not.toBe(afterSetChange);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface DeliveryRoute {
  workspace_id: string;
  user_id: string;
  repository_id: string;
}

function deliveryMachine(
  fixture: Fixture,
  memberId: string,
  repositoryId: string,
  requestedBy = `user:${memberId}`,
) {
  const grantId = "grt_delivery";
  const issue = {
    issue_id: "iss_delivery_probe",
    workspace: {
      workspace_id: fixture.workspaceId,
      enterprise_id: fixture.scope.enterprise_id,
    },
    repository: { repository_id: repositoryId, url: "https://example.test/repo.git" },
  };
  const grant = {
    grant_id: grantId,
    run_id: "run_delivery",
    capability_grant_version: "rungrant/v1",
    policy_version: "policy/v1",
    issued_at: NOW,
    expires_at: "2026-11-03T13:00:00.000Z",
    permitted_paths: [],
    permitted_tools: [],
    network_destinations: [],
    max_wall_clock_seconds: 60,
    resource_limits: { max_memory_mb: 1, max_tokens: 1 },
    may_create_patch: true,
    may_create_or_update_pr: true,
    scope_digest: "digest",
    revoked_at: null,
    revoked_reason: null,
  };
  const run = {
    run_id: "run_delivery",
    issue_id: issue.issue_id,
    role: "delivery",
    head_sha: "head_sha",
    grants: [grant],
  };
  const delivery = {
    delivery_id: "del_delivery",
    operation_id: "op_delivery",
    issue_id: issue.issue_id,
    candidate_id: "cand_1",
    approval_id: "appa_1",
    repository: issue.repository,
    target_branch: "main",
    head_sha: "head_sha",
    provider: "github",
    state: "pending",
    branch: null,
    pr_id: null,
    pr_url: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    reconciled_at: null,
    grant_id: grantId,
    requested_by: requestedBy,
  };
  return {
    getIssue: () => issue,
    getDelivery: () => delivery,
    listRuns: () => [run],
  } as unknown as CollabMachine;
}

function requesterCheck(ctx: CompleteSet) {
  return (input: DeliveryRoute): boolean =>
    ctx.authority.check(input.user_id, "delivery", input.workspace_id, {
      repository_id: input.repository_id,
    }).allowed;
}

function deliveryPermission(
  ctx: CompleteSet,
  requesterCapability?: (input: DeliveryRoute) => boolean,
  options: { repositoryId?: string; requestedBy?: string } = {},
) {
  const permission = createDeliveryPermission({
    machine: deliveryMachine(
      ctx.fixture,
      ctx.memberId,
      options.repositoryId ?? REPO_ID,
      options.requestedBy,
    ),
    access: ctx.fixture.access,
    workspaces: ctx.fixture.workspaces,
    enterprise_id: ctx.fixture.scope.enterprise_id,
    clock: () => ctx.fixture.clock.now,
    ...(requesterCapability !== undefined ? { requesterCapability } : {}),
  });
  const repositoryId = options.repositoryId ?? REPO_ID;
  return () =>
    permission({
      issue_id: "iss_delivery_probe",
      repository_id: repositoryId,
      delivery_id: "del_delivery",
      grant_id: "grt_delivery",
    });
}

describe("delivery authority is re-observed against the delivery's target before the write", () => {
  test("the requester capability is asked against the delivery's repository", () => {
    const ctx = setupCompleteSet({ githubRole: "write", gitlabRole: "developer" });
    const seen: DeliveryRoute[] = [];
    const allowed = deliveryPermission(ctx, (input) => {
      seen.push(input);
      return requesterCheck(ctx)(input);
    });

    expect(allowed()).toBe(true);
    expect(seen).toEqual([
      {
        workspace_id: ctx.fixture.workspaceId,
        user_id: ctx.memberId,
        repository_id: REPO_ID,
      },
    ]);
  });

  test("a reduction on another repository stops a write to the delivery's repository", () => {
    const ctx = setupCompleteSet({ githubRole: "write", gitlabRole: "developer" });
    const allowed = deliveryPermission(ctx, requesterCheck(ctx));
    expect(allowed()).toBe(true);

    // B — not the delivery's repository — loses the requester's access. The
    // workspace-wide intersection no longer supports a repository write, so
    // the provider write to A must be refused.
    ctx.fixture.access.roster.setAuthorityState(
      ctx.fixture.scope,
      ctx.integrationB,
      GITLAB_SUBJECT,
      "removed",
      NOW,
    );
    expect(allowed()).toBe(false);
  });

  test("a delivery whose repository left the set is refused", () => {
    const ctx = setupCompleteSet({ githubRole: "write", gitlabRole: "developer" });
    const allowed = deliveryPermission(ctx, requesterCheck(ctx), { repositoryId: REPO_B });
    expect(allowed()).toBe(true);

    removeBinding(ctx.fixture, REPO_B);
    expect(allowed()).toBe(false);
  });

  test("the local-operator mode is unchanged", () => {
    // The member's intersection lacks repository write, but the deployment's
    // own credential keeps its pre-existing mode.
    const ctx = setupCompleteSet({ githubRole: "write", gitlabRole: "reporter" });
    const allowed = deliveryPermission(ctx, requesterCheck(ctx), {
      requestedBy: "local-operator",
    });
    expect(allowed()).toBe(true);
  });
});
