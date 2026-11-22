/**
 * Repository capability ceiling (DAT-276, ADR-0011).
 *
 * Store-level tests over a real control-plane database: per-repository
 * verification, intersection, confirmed downgrade and its persistence,
 * temporary fail-closed states that clear themselves, administrator
 * reapproval inside the verified bound, last-owner loss, restart durability,
 * concurrency and audit evidence.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createMemberCapabilityRepository,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import {
  CapabilityCeilingError,
  WorkspaceRepositorySetError,
} from "../src/control-plane/errors.js";
import { createAuthorityEpoch } from "../src/provider-access/access-gate.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import { createDeliveryPermission } from "../src/api/collab-authority.js";
import type { CollabMachine } from "../src/collab/machine.js";
import type { CapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import {
  NOW,
  REPO_ID,
  addMember,
  setupFixture,
  verifyAuthority,
  type Fixture,
} from "./helpers/provider-access.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = setupFixture();
});

function changeRole(subject: string, role: string, at: string): void {
  verifyAuthority(fixture, subject, null, at, { provider_role: role });
}

function auditEvents(event: string): Array<Record<string, unknown>> {
  return fixture.identity.authAudit
    .list({ enterprise_id: fixture.scope.enterprise_id, event, limit: 100 })
    .map((row) => row.details);
}

function makeEnterpriseAdmin(userId: string): void {
  fixture.identity.enterpriseRoles.grant({
    enterprise_id: fixture.scope.enterprise_id,
    user_id: userId,
    role: "admin",
    actor_id: "usr_operator",
  });
}

describe("verified ceilings", () => {
  test("the ceiling is the verified intersection and is persisted on first use", () => {
    const { userId } = addMember(fixture, { subject: "7001", login: "nina", role: "member" });
    verifyAuthority(fixture, "7001", userId, NOW);

    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.state).toBe("verified");
    expect(evaluation.capabilities).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(evaluation.record?.state).toBe("approved");
    expect(evaluation.record?.reason).toBe("initial");
    expect(evaluation.repositories).toHaveLength(1);

    const persisted = createMemberCapabilityRepository(fixture.db).get(fixture.scope, userId);
    expect(persisted?.ceiling).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(auditEvents("capability_ceiling.initialized")).toHaveLength(1);

    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);

    // A second evaluation of unchanged facts writes nothing new.
    const again = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(again.record?.version).toBe(evaluation.record?.version);
    expect(auditEvents("capability_ceiling.initialized")).toHaveLength(1);
  });

  test("the assigned role is not the ceiling: a viewer cannot gain a write from the provider", () => {
    const { userId } = addMember(fixture, { subject: "7002", login: "omar", role: "viewer" });
    verifyAuthority(fixture, "7002", userId, NOW);

    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.capabilities).toContain("repository_write");
    const write = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "write",
    });
    expect(write.allowed).toBe(false);
    expect(write.reason).toBe("workspace_role");
  });

  test("management needs the management capability, not a role name", () => {
    // A workspace admin with only `write` on the repository: role rank is
    // sufficient, repository management capability is not.
    const { userId } = addMember(fixture, { subject: "7003", login: "pia", role: "admin" });
    verifyAuthority(fixture, "7003", userId, NOW, { provider_role: "write" });
    const denied = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "manage",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("capability_ceiling");

    // A provider upgrade does NOT raise an approved ceiling on its own: the
    // same session still denies management until an administrator reapproves.
    changeRole("7003", "admin", "2026-11-03T12:05:00.000Z");
    const stillDenied = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "manage",
    });
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.reason).toBe("capability_ceiling");

    // A member whose ceiling was established with administrator-level
    // repository authority is allowed the management action.
    const manager = addMember(fixture, { subject: "7004", login: "mira", role: "owner" });
    verifyAuthority(fixture, "7004", manager.userId, NOW, { provider_role: "admin" });
    const allowed = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: manager.userId,
      action: "manage",
    });
    expect(allowed.allowed).toBe(true);
  });
});

describe("verified reductions", () => {
  test("a verified downgrade tightens read/write and delivery grants but keeps the role", () => {
    const { userId } = addMember(fixture, { subject: "7101", login: "quinn", role: "member" });
    verifyAuthority(fixture, "7101", userId, NOW);
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    const grant = fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });

    // The provider now reports `read` only.
    changeRole("7101", "read", NOW);
    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.state).toBe("verified");
    expect(evaluation.capabilities).toEqual(["code_read"]);
    expect(evaluation.record?.state).toBe("downgraded");
    expect(evaluation.record?.reason).toBe("provider_downgrade");

    // The downgrade is durable, audited and the granted write is revoked.
    const persisted = fixture.capabilityCeilings.evaluate(fixture.scope, userId).record;
    expect(persisted?.ceiling).toEqual(["code_read"]);
    expect(auditEvents("capability_ceiling.downgraded").length).toBeGreaterThanOrEqual(1);
    // An automatic consequence of provider facts is audited as the deployment,
    // never as the member whose ceiling changed.
    const downgradeAudit = fixture.identity.authAudit.list({
      enterprise_id: fixture.scope.enterprise_id,
      event: "capability_ceiling.downgraded",
    })[0];
    expect(downgradeAudit?.actor_kind).toBe("deployment");
    expect(downgradeAudit?.subject_user_id).toBe(userId);
    expect(
      fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
        grantee_user_id: userId,
        now: NOW,
      }),
    ).toEqual([]);
    expect(grant.capability).toBe("delivery_write");

    // The assigned role is untouched: only the ceiling tightened.
    expect(fixture.memberships.getByUser(fixture.scope, userId)?.role).toBe("member");
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
    const write = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "write",
    });
    expect(write.allowed).toBe(false);
    expect(write.reason).toBe("capability_ceiling");
  });

  test("a provider recovery is observable but never raises the ceiling", () => {
    const { userId } = addMember(fixture, { subject: "7102", login: "rosa", role: "member" });
    verifyAuthority(fixture, "7102", userId, NOW);
    const before = fixture.capabilityCeilings.evaluate(fixture.scope, userId).record;

    changeRole("7102", "read", NOW);
    const downgraded = fixture.capabilityCeilings.evaluate(fixture.scope, userId).record;
    expect(downgraded?.ceiling).toEqual(["code_read"]);

    // Provider grants write again — no automatic promotion.
    changeRole("7102", "write", "2026-11-03T12:05:00.000Z");
    const recovered = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(recovered.state).toBe("verified");
    expect(recovered.capabilities).toEqual(["code_read"]);
    expect(recovered.promotion_available).toBe(true);
    expect(recovered.record?.available_ceiling).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
    ]);
    expect(recovered.record?.version).toBeGreaterThan(downgraded!.version);
    expect(before).toBeDefined();
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "write" }).allowed,
    ).toBe(false);
  });
});

describe("temporary verification failures fail closed and clear themselves", () => {
  test("unknown authority blocks every action and records no downgrade", () => {
    const { userId } = addMember(fixture, { subject: "7201", login: "sasha", role: "admin" });
    verifyAuthority(fixture, "7201", userId, NOW);
    const before = fixture.capabilityCeilings.evaluate(fixture.scope, userId).record;

    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7201",
      "unknown",
      "2026-11-03T12:01:00.000Z",
    );
    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.state).toBe("unverified");
    expect(evaluation.reason).toBe("authority_unknown");
    expect(evaluation.capabilities).toEqual([]);
    // Nothing was rewritten: a temporary failure is not a confirmed downgrade.
    expect(evaluation.record?.version).toBe(before?.version);
    expect(evaluation.record?.state).toBe("approved");

    for (const action of ["read", "stream", "artifact_read", "approval", "write"] as const) {
      const decision = fixture.gate.authorize({
        scope: fixture.scope,
        user_id: userId,
        action,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("authority_unknown");
      expect(decision.requires_reconciliation).toBe(true);
    }
    expect(auditEvents("capability_ceiling.downgraded")).toHaveLength(0);
  });

  test("an aged verification is fail-closed without being recorded as a loss", () => {
    const { userId } = addMember(fixture, { subject: "7202", login: "tarek", role: "member" });
    verifyAuthority(fixture, "7202", userId, NOW);
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);

    fixture.clock.now = new Date("2026-11-04T13:00:00.000Z"); // 25 hours later
    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.state).toBe("unverified");
    expect(evaluation.reason).toBe("verification_expired");
    const read = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(read.allowed).toBe(false);
    expect(read.reason).toBe("capability_unverified");
    expect(read.capability_reason).toBe("verification_expired");
  });

  test("recovering the same facts unblocks access without a promotion", () => {
    const { userId } = addMember(fixture, { subject: "7203", login: "umar", role: "member" });
    verifyAuthority(fixture, "7203", userId, NOW);
    const before = fixture.capabilityCeilings.evaluate(fixture.scope, userId).record;

    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7203",
      "stale",
      "2026-11-03T12:01:00.000Z",
    );
    expect(fixture.capabilityCeilings.evaluate(fixture.scope, userId).state).toBe("unverified");
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(false);

    verifyAuthority(fixture, "7203", userId, "2026-11-03T12:02:00.000Z");
    const recovered = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(recovered.state).toBe("verified");
    expect(recovered.capabilities).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(recovered.record?.version).toBe(before?.version);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
  });

  test("incomplete visibility, missing roles and unsupported roles fail closed", () => {
    const { userId } = addMember(fixture, { subject: "7204", login: "vera", role: "member" });
    verifyAuthority(fixture, "7204", userId, NOW);

    // No roster row for the subject: nothing can be proven.
    fixture.access.roster.removeSubject(fixture.scope, fixture.integration.id, "7204");
    const missing = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(missing.reason).toBe("role_missing");
    expect(missing.state).toBe("unverified");
    expect(missing.capabilities).toEqual([]);

    // A role vocabulary AutoFixer has no policy for is never inferred.
    fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
      roles: [
        {
          subject: "7204",
          login: "vera",
          source_kind: "direct_collaborator",
          provider_role: "maintainer", // GitLab vocabulary on GitHub: unsupported
          authority_ref: REPO_ID,
          inherited_from: null,
        },
      ],
      verified_at: NOW,
      subject_users: { "7204": userId },
    });
    const unsupported = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(unsupported.reason).toBe("unsupported_role");
    expect(unsupported.state).toBe("unverified");
  });
});

describe("confirmed loss", () => {
  test("removed repository access blocks even the last owner and persists the loss", () => {
    const { userId } = addMember(fixture, { subject: "7301", login: "willa", role: "owner" });
    verifyAuthority(fixture, "7301", userId, NOW, { provider_role: "admin" });
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);

    fixture.gate.revoke(
      fixture.scope,
      { integration_id: fixture.integration.id, subject: "7301", user_id: userId },
      "provider removal",
      "2026-11-03T12:01:00.000Z",
    );

    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.state).toBe("confirmed_loss");
    expect(evaluation.reason).toBe("repository_access_removed");
    expect(evaluation.record?.state).toBe("downgraded");
    expect(evaluation.record?.ceiling).toEqual([]);

    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
    // The provider's own removal fact is the more specific denial; the ceiling
    // independently records the confirmed loss and stays empty.
    expect(decision.reason).toBe("repository_access");
    // The owner role is retained; it is not an authorization bypass.
    expect(fixture.memberships.getByUser(fixture.scope, userId)?.role).toBe("owner");

    // Reapproval cannot reinstate what the provider no longer proves.
    makeEnterpriseAdmin(userId);
    expect(() =>
      fixture.capabilityCeilings.reapprove(fixture.scope, userId, {
        workspace_id: fixture.scope.workspace_id,
        user_id: userId,
        capabilities: ["code_read"],
        version: evaluation.record!.version,
      }),
    ).toThrow(CapabilityCeilingError);
  });

  test("a verified intersection without code read is not eligible", () => {
    // Guest-equivalent: a supported GitLab fact that proves no capability.
    const gitlab = setupFixture({ provider_type: "gitlab" });
    const member = addMember(gitlab, { subject: "7302", login: "xena", role: "member" });
    verifyAuthority(gitlab, "7302", member.userId, NOW, { provider_role: "guest" });
    const evaluation = gitlab.capabilityCeilings.evaluate(gitlab.scope, member.userId);
    expect(evaluation.state).toBe("confirmed_loss");
    expect(evaluation.reason).toBe("no_code_read");
    expect(evaluation.record?.ceiling).toEqual([]);
    expect(
      gitlab.gate.authorize({
        scope: gitlab.scope,
        user_id: member.userId,
        action: "read",
      }).reason,
    ).toBe("capability_loss");
  });
});

describe("administrator reapproval", () => {
  /**
   * A member whose provider authority was reduced to `read` (confirmed
   * downgrade), then recovered to `write` without an automatic promotion: the
   * persisted ceiling is read, `available_ceiling` is write. This is the state
   * an administrator reapproval exists for.
   */
  function downgradedMember(): { userId: string } {
    const { userId } = addMember(fixture, { subject: "7401", login: "yara", role: "member" });
    verifyAuthority(fixture, "7401", userId, NOW);
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    changeRole("7401", "read", NOW);
    expect(fixture.capabilityCeilings.evaluate(fixture.scope, userId).record?.state).toBe(
      "downgraded",
    );
    changeRole("7401", "write", "2026-11-03T12:05:00.000Z");
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    return { userId };
  }

  function managingAdmin(role: "admin" | "owner"): { userId: string } {
    const actor = addMember(fixture, {
      subject: `74${role === "admin" ? "02" : "03"}`,
      login: `admin-${role}`,
      role,
    });
    verifyAuthority(fixture, `74${role === "admin" ? "02" : "03"}`, actor.userId, NOW, {
      provider_role: "admin",
    });
    makeEnterpriseAdmin(actor.userId);
    return { userId: actor.userId };
  }

  test("only an enterprise administrator may reapprove", () => {
    const target = downgradedMember();
    const plain = addMember(fixture, { subject: "7404", login: "member-only", role: "owner" });
    verifyAuthority(fixture, "7404", plain.userId, NOW, { provider_role: "admin" });
    const record = fixture.capabilityCeilings.evaluate(fixture.scope, target.userId).record!;
    expect(() =>
      fixture.capabilityCeilings.reapprove(fixture.scope, plain.userId, {
        workspace_id: fixture.scope.workspace_id,
        user_id: target.userId,
        capabilities: ["code_read", "issue_write", "repository_write"],
        version: record.version,
      }),
    ).toThrow(/enterprise administrator/);
    expect(auditEvents("capability_ceiling.reapproval_denied").length).toBeGreaterThanOrEqual(1);
  });

  test("enterprise administration alone cannot bypass repository management capability", () => {
    const target = downgradedMember();
    const readOnlyAdmin = addMember(fixture, {
      subject: "7405",
      login: "read-admin",
      role: "admin",
    });
    verifyAuthority(fixture, "7405", readOnlyAdmin.userId, NOW, { provider_role: "read" });
    makeEnterpriseAdmin(readOnlyAdmin.userId);
    const record = fixture.capabilityCeilings.evaluate(fixture.scope, target.userId).record!;
    expect(() =>
      fixture.capabilityCeilings.reapprove(fixture.scope, readOnlyAdmin.userId, {
        workspace_id: fixture.scope.workspace_id,
        user_id: target.userId,
        capabilities: ["code_read"],
        version: record.version,
      }),
    ).toThrow(/repository management capability/);
  });

  test("a managing administrator restores exactly the verified capabilities, never more", () => {
    const target = downgradedMember();
    const admin = managingAdmin("owner");
    const record = fixture.capabilityCeilings.evaluate(fixture.scope, target.userId).record!;

    // More than the providers prove is refused.
    expect(() =>
      fixture.capabilityCeilings.reapprove(fixture.scope, admin.userId, {
        workspace_id: fixture.scope.workspace_id,
        user_id: target.userId,
        capabilities: ["code_read", "issue_write", "repository_write", "repository_manage"],
        version: record.version,
      }),
    ).toThrow(/exceed/);

    const approved = fixture.capabilityCeilings.reapprove(fixture.scope, admin.userId, {
      workspace_id: fixture.scope.workspace_id,
      user_id: target.userId,
      capabilities: ["code_read", "issue_write", "repository_write"],
      version: record.version,
    });
    expect(approved.state).toBe("approved");
    expect(approved.ceiling).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(approved.version).toBe(record.version + 1);
    expect(auditEvents("capability_ceiling.reapproved")).toHaveLength(1);
    const reapprovalAudit = fixture.identity.authAudit.list({
      enterprise_id: fixture.scope.enterprise_id,
      event: "capability_ceiling.reapproved",
    })[0];
    expect(reapprovalAudit?.actor_kind).toBe("user");
    expect(reapprovalAudit?.actor_user_id).toBe(admin.userId);
    expect(reapprovalAudit?.subject_user_id).toBe(target.userId);

    // The target's workspace role is unchanged by the ceiling approval.
    expect(fixture.memberships.getByUser(fixture.scope, target.userId)?.role).toBe("member");
    expect(
      fixture.gate.authorize({
        scope: fixture.scope,
        user_id: target.userId,
        action: "write",
      }).reason,
    ).toBe("capability_grant");
  });

  test("a stale version is a conflict, not an approval", () => {
    const target = downgradedMember();
    const admin = managingAdmin("admin");
    const record = fixture.capabilityCeilings.evaluate(fixture.scope, target.userId).record!;
    expect(() =>
      fixture.capabilityCeilings.reapprove(fixture.scope, admin.userId, {
        workspace_id: fixture.scope.workspace_id,
        user_id: target.userId,
        capabilities: ["code_read"],
        version: record.version + 5,
      }),
    ).toThrow(/concurrently/);
  });
});

describe("multi-repository intersection", () => {
  function addSecondRepository(): string {
    const otherRepo = "github:FoMo-Exp/Other";
    const integration = fixture.access.integrations.create(fixture.scope, {
      provider_instance_id: fixture.providerInstanceId,
      repository_id: otherRepo,
      repository_name: "FoMo-Exp/Other",
      source_credential_ref: "svc-source-2",
      permission_visibility: "full",
      actor_id: "usr_operator",
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
        `wrb_test_${integration.id}`,
        fixture.scope.enterprise_id,
        fixture.scope.workspace_id,
        fixture.providerInstanceId,
        integration.id,
        otherRepo,
        "FoMo-Exp/Other",
        NOW,
        NOW,
        "usr_operator",
        "usr_operator",
      );
    return integration.id;
  }

  test("write on A and read on B yields read only, and the scope fails closed", () => {
    const { userId } = addMember(fixture, { subject: "7501", login: "zoe", role: "member" });
    verifyAuthority(fixture, "7501", userId, NOW, { provider_role: "write" });
    const second = addSecondRepository();
    // Second repository: read only, same subject.
    fixture.access.roster.applySnapshot(fixture.scope, second, {
      roles: [
        {
          subject: "7501",
          login: "zoe",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: "github:FoMo-Exp/Other",
          inherited_from: null,
        },
      ],
      verified_at: NOW,
      subject_users: { "7501": userId },
    });

    const evaluation = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    expect(evaluation.repository_count).toBe(2);
    // The intersection is read even though repository A grants write.
    expect(evaluation.available_capabilities).toEqual(["code_read"]);
    // The multi-repository scope is not usable yet (DAT-281), so it fails closed.
    expect(evaluation.state).toBe("unverified");
    expect(evaluation.reason).toBe("repository_set_unsupported");
    expect(evaluation.capabilities).toEqual([]);
    expect(evaluation.record).toBeNull();
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(false);
    expect(() =>
      createWorkspaceRepositorySetRepository(fixture.db).requireSingleRepository(fixture.scope),
    ).toThrow(WorkspaceRepositorySetError);
  });
});

describe("durability and concurrency", () => {
  test("a confirmed reduction survives a reopen and still needs reapproval", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "autofixer-ceiling-"));
    const dbPath = path.join(dir, "control.sqlite");
    const NOW_ISO = NOW;

    function serviceFor(db: ControlPlaneDb): CapabilityCeilingService {
      return createCapabilityCeilingService({
        repositorySets: createWorkspaceRepositorySetRepository(db),
        access: createProviderAccessRepositories(db),
        memberships: createRepositories(db).memberships,
        providerInstances: createRepositories(db).providerInstances,
        identity: createIdentityRepositories(db),
        capabilities: createMemberCapabilityRepository(db),
        epoch: createAuthorityEpoch(),
        clock: () => new Date(NOW_ISO),
      });
    }

    // Seed once, on a durable file database.
    const first = openControlPlaneDb({ path: dbPath });
    const repos = createRepositories(first);
    const identity = createIdentityRepositories(first);
    const access = createProviderAccessRepositories(first);
    const { enterprise, admin_scope } = seedEnterprise(first, {
      enterprise_name: "Durable Enterprise",
      enterprise_slug: "durable-ent",
      admin_user_id: "usr_operator",
    });
    const instance = seedProviderInstance(first, admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const workspace = seedWorkspace(first, admin_scope, {
      name: "Durable",
      repository_id: REPO_ID,
      provider_instance_id: instance.id,
    });
    const scope = {
      enterprise_id: enterprise.id,
      workspace_id: workspace.id,
      actor_id: "usr_operator",
    };
    const integration = access.integrations.create(scope, {
      provider_instance_id: instance.id,
      repository_id: REPO_ID,
      repository_name: "FoMo-Exp/AutoFixer",
      source_credential_ref: "svc-source-1",
      permission_visibility: "full",
      actor_id: "usr_operator",
    });
    const user = identity.users.create({ display_name: "durable", actor_id: "usr_operator" });
    identity.identities.create({
      user_id: user.id,
      provider_instance_id: instance.id,
      subject: "8001",
      login: "durable",
      actor_id: "usr_operator",
    });
    identity.enterpriseUsers.ensureActive(enterprise.id, user.id, {
      kind: "user",
      user_id: "usr_operator",
    });
    repos.memberships.create(scope, { user_id: user.id, role: "member" });
    access.roster.applySnapshot(scope, integration.id, {
      roles: [
        {
          subject: "8001",
          login: "durable",
          source_kind: "direct_collaborator",
          provider_role: "write",
          authority_ref: REPO_ID,
          inherited_from: null,
        },
      ],
      verified_at: NOW_ISO,
      subject_users: { "8001": user.id },
    });

    const firstService = serviceFor(first);
    expect(firstService.evaluate(scope, user.id).record?.state).toBe("approved");

    // The provider reports `read` only; the reduction is persisted.
    access.roster.applySnapshot(scope, integration.id, {
      roles: [
        {
          subject: "8001",
          login: "durable",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: REPO_ID,
          inherited_from: null,
        },
      ],
      verified_at: NOW_ISO,
    });
    expect(firstService.evaluate(scope, user.id).record?.ceiling).toEqual(["code_read"]);
    first.close();

    // Restart: the reduction is still effective even though the stored
    // verification timestamp has not moved.
    const second = openControlPlaneDb({ path: dbPath });
    const reopened = serviceFor(second);
    const after = reopened.evaluate(scope, user.id);
    expect(after.state).toBe("verified");
    expect(after.capabilities).toEqual(["code_read"]);
    expect(after.record?.state).toBe("downgraded");
    expect(after.record?.ceiling).toEqual(["code_read"]);
    second.close();
  });

  test("a concurrent stale observation cannot raise or duplicate a reduction", () => {
    const { userId } = addMember(fixture, { subject: "7601", login: "amir", role: "member" });
    verifyAuthority(fixture, "7601", userId, NOW);
    const first = fixture.capabilityCeilings.evaluate(fixture.scope, userId);
    const store = createMemberCapabilityRepository(fixture.db);
    const record = store.get(fixture.scope, userId)!;

    changeRole("7601", "read", NOW);
    const applied = store.applyDowngrade(
      fixture.scope,
      userId,
      {
        ceiling: ["code_read"],
        available_ceiling: ["code_read"],
        expected_version: record.version,
        set_version: first.set_version,
        verified_at: NOW,
        reason: "provider_downgrade",
      },
      { actor_id: userId },
    );
    expect(applied.applied).toBe(true);

    // A second writer holding the now-stale version observes the stricter
    // value instead of overwriting it.
    const stale = store.applyDowngrade(
      fixture.scope,
      userId,
      {
        ceiling: ["code_read"],
        available_ceiling: ["code_read"],
        expected_version: record.version,
        set_version: first.set_version,
        verified_at: NOW,
        reason: "provider_downgrade",
      },
      { actor_id: userId },
    );
    expect(stale.applied).toBe(false);
    expect(stale.record.ceiling).toEqual(["code_read"]);
    expect(stale.record.version).toBe(record.version + 1);
  });
});

describe("schema", () => {
  test("the capability table is a forward migration and re-running is a no-op", () => {
    const db = openControlPlaneDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workspace_member_capability");
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.at(-1)?.version).toBe(21);
    migrate(db);
    const again = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(again).toEqual(versions);
    db.close();
  });
});

describe("incomplete evidence and enterprise isolation", () => {
  test("a partial roster cannot establish admission or a ceiling", () => {
    const partial = setupFixture({ permission_visibility: "partial" });
    const { userId } = addMember(partial, { subject: "7801", login: "cleo", role: "member" });
    verifyAuthority(partial, "7801", userId, NOW);
    const evaluation = partial.capabilityCeilings.evaluate(partial.scope, userId);
    // An incomplete roster is not "the last known role is probably fine".
    expect(evaluation.state).toBe("unverified");
    expect(evaluation.reason).toBe("permission_visibility_partial");
    expect(evaluation.capabilities).toEqual([]);
    expect(evaluation.record).toBeNull();
    expect(
      partial.gate.authorize({ scope: partial.scope, user_id: userId, action: "read" }).reason,
    ).toBe("capability_unverified");
  });

  test("one enterprise's reduction never changes another enterprise", () => {
    const { userId } = addMember(fixture, { subject: "7901", login: "dev", role: "member" });
    verifyAuthority(fixture, "7901", userId, NOW);

    // A second enterprise with its own provider instance and workspace.
    const other = seedEnterprise(fixture.db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: "other-ent",
      admin_user_id: "usr_other",
    });
    const otherInstance = seedProviderInstance(fixture.db, other.admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const otherWorkspace = seedWorkspace(fixture.db, other.admin_scope, {
      name: "Other",
      repository_id: "github:Other/Repo",
      provider_instance_id: otherInstance.id,
    });
    const otherScope = {
      enterprise_id: other.enterprise.id,
      workspace_id: otherWorkspace.id,
      actor_id: "usr_other",
    };
    fixture.identity.identities.create({
      user_id: userId,
      provider_instance_id: otherInstance.id,
      subject: "7901",
      login: "dev",
      actor_id: "usr_other",
    });
    fixture.identity.enterpriseUsers.ensureActive(other.enterprise.id, userId, {
      kind: "deployment",
    });
    fixture.memberships.create(otherScope, { user_id: userId, role: "member" });
    const otherIntegration = fixture.access.integrations.create(otherScope, {
      provider_instance_id: otherInstance.id,
      repository_id: "github:Other/Repo",
      repository_name: "Other/Repo",
      source_credential_ref: "svc-other-1",
      permission_visibility: "full",
      actor_id: "usr_other",
    });
    fixture.access.roster.applySnapshot(otherScope, otherIntegration.id, {
      roles: [
        {
          subject: "7901",
          login: "dev",
          source_kind: "direct_collaborator",
          provider_role: "admin",
          authority_ref: "github:Other/Repo",
          inherited_from: null,
        },
      ],
      verified_at: NOW,
      subject_users: { "7901": userId },
    });

    const before = fixture.capabilityCeilings.evaluate(otherScope, userId);
    expect(before.capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
      "repository_manage",
    ]);

    // Reduce the first enterprise only.
    changeRole("7901", "read", NOW);
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);

    const after = fixture.capabilityCeilings.evaluate(otherScope, userId);
    expect(after.state).toBe("verified");
    expect(after.capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
      "repository_manage",
    ]);
    expect(after.record?.state).toBe("approved");
    // The stored ceilings are enterprise-scoped rows, not a global preference.
    const store = createMemberCapabilityRepository(fixture.db);
    expect(store.get(fixture.scope, userId)?.ceiling).toEqual(["code_read"]);
    expect(store.get(otherScope, userId)?.ceiling).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
      "repository_manage",
    ]);
  });
});

describe("delivery is re-checked immediately before each provider write", () => {
  interface DeliveryStubOptions {
    revoked_at?: string | null;
    expires_at?: string;
    may_create_or_update_pr?: boolean;
    role?: string;
    requested_by?: string;
    grant_id?: string;
  }

  function machineFor(options: DeliveryStubOptions = {}) {
    const grantId = options.grant_id ?? "grt_delivery";
    const issue = {
      issue_id: "iss_delivery_probe",
      workspace: {
        workspace_id: fixture.scope.workspace_id,
        enterprise_id: fixture.scope.enterprise_id,
      },
      repository: { repository_id: REPO_ID, url: "https://github.com/FoMo-Exp/AutoFixer.git" },
    };
    const grant = {
      grant_id: grantId,
      run_id: "run_delivery",
      capability_grant_version: "rungrant/v1",
      policy_version: "policy/v1",
      issued_at: NOW,
      expires_at: options.expires_at ?? "2026-11-03T13:00:00.000Z",
      permitted_paths: [],
      permitted_tools: [],
      network_destinations: [],
      max_wall_clock_seconds: 60,
      resource_limits: { max_memory_mb: 1, max_tokens: 1 },
      may_create_patch: true,
      may_create_or_update_pr: options.may_create_or_update_pr ?? true,
      scope_digest: "digest",
      revoked_at: options.revoked_at ?? null,
      revoked_reason: null,
    };
    const run = {
      run_id: "run_delivery",
      issue_id: issue.issue_id,
      role: options.role ?? "delivery",
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
      requested_by: options.requested_by ?? "user:usr_grantee",
    };
    return { issue, grant, run, delivery };
  }

  function permission(
    options: DeliveryStubOptions = {},
    requesterCapability?: (input: { workspace_id: string; user_id: string }) => boolean,
  ) {
    const machine = machineFor(options);
    return createDeliveryPermission({
      machine: {
        getIssue: () => machine.issue,
        getDelivery: () => machine.delivery,
        listRuns: () => [machine.run],
      } as unknown as CollabMachine,
      access: fixture.access,
      workspaces: fixture.workspaces,
      enterprise_id: fixture.scope.enterprise_id,
      clock: () => new Date(NOW),
      ...(requesterCapability !== undefined ? { requesterCapability } : {}),
    });
  }

  const input = (grant_id = "grt_delivery") => ({
    issue_id: "iss_delivery_probe",
    repository_id: REPO_ID,
    delivery_id: "del_delivery",
    grant_id,
  });

  test("a live delivery grant and a permitted requester authorize the write", () => {
    // No control-plane `capability_grant` row is involved: the broker's grant
    // is the recorded collaboration delivery grant, and it is validated on its
    // own terms plus the live capability check.
    const seen: string[] = [];
    const allowed = permission({}, (request) => {
      seen.push(request.user_id);
      return true;
    });
    expect(allowed(input())).toBe(true);
    expect(seen).toEqual(["usr_grantee"]);
  });

  test("a revoked, expired, non-PR or non-delivery grant blocks the write", () => {
    expect(permission({ revoked_at: "2026-11-03T11:30:00.000Z" })(input())).toBe(false);
    expect(permission({ expires_at: "2026-11-03T11:59:59.000Z" })(input())).toBe(false);
    expect(permission({ may_create_or_update_pr: false })(input())).toBe(false);
    expect(permission({ role: "diagnose" })(input())).toBe(false);
    // A different grant id than the one recorded on the delivery.
    expect(permission()(input("grt_other"))).toBe(false);
  });

  test("the requester's live repository capability is required before the write", () => {
    // The provider was downgraded after the delivery request was recorded:
    // the recorded "was authorized" flag is not revisited, the live check is.
    expect(permission({}, () => false)(input())).toBe(false);
    // The deployment operator keeps the local-operator mode.
    expect(permission({ requested_by: "local-operator" }, () => false)(input())).toBe(true);
    // An actor label that names no requester fails closed.
    expect(permission({ requested_by: "someone" }, () => true)(input())).toBe(false);
  });

  test("a delivery for another repository never authorizes this repository", () => {
    const allowed = permission({}, () => true);
    expect(allowed({ ...input(), repository_id: "github:FoMo-Exp/Other" })).toBe(false);
  });
});
