/**
 * Member admission and capability intersection (DAT-283, ADR-0011).
 *
 * Store-level tests over a real control-plane database: the per-repository
 * capability intersection across providers, the distinction between unknown,
 * expired, truncated, provider-unavailable and confirmed-revocation evidence
 * (none of which proves admission), the protection set of *current effective
 * members*, effective-owner determination across enterprises, and the
 * repository-addition preview that never grants anything.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  createRepositories,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import { LastOwnerError } from "../src/control-plane/errors.js";
import { AdmissionPreviewError } from "../src/provider-access/member-admission.js";
import type { RepositoryCapability, WorkspaceRole } from "../src/control-plane/index.js";
import type { WorkspaceScope } from "../src/control-plane/index.js";
import { NOW, REPO_ID, addMember, setupFixture, type Fixture } from "./helpers/provider-access.js";

const HOUR_MS = 60 * 60 * 1000;
const REPO_B = "gitlab:repo:9100";
const REPO_NAME_B = "acme/service-b";

let fixture: Fixture;

beforeEach(() => {
  fixture = setupFixture();
});

interface RosterEntry {
  subject: string;
  userId: string | null;
  provider_role: string;
  source_kind?: "direct_collaborator" | "org_member" | "org_owner";
}

/** One complete roster snapshot for the fixture's repository (repo A). */
function applyRoster(entries: readonly RosterEntry[], at = NOW): void {
  const subjectUsers: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.userId !== null) {
      subjectUsers[entry.subject] = entry.userId;
    }
  }
  fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
    roles: entries.map((entry) => ({
      subject: entry.subject,
      login: `login-${entry.subject}`,
      source_kind: entry.source_kind ?? "direct_collaborator",
      provider_role: entry.provider_role,
      authority_ref: REPO_ID,
      inherited_from: null,
    })),
    verified_at: at,
    ...(Object.keys(subjectUsers).length > 0 ? { subject_users: subjectUsers } : {}),
  });
}

function evaluate(userId: string, options: { persist?: boolean } = {}) {
  return fixture.admission.evaluate(fixture.scope, userId, options);
}

function caps(evaluation: { capabilities: readonly RepositoryCapability[] }): string[] {
  return [...evaluation.capabilities];
}

function suspendEnterpriseUser(enterpriseId: string, userId: string): void {
  const membership = fixture.identity.enterpriseUsers.getByUser(enterpriseId, userId);
  expect(membership).toBeDefined();
  fixture.identity.enterpriseUsers.setStatus(
    enterpriseId,
    membership!.id,
    "suspended",
    membership!.version,
    { kind: "deployment" },
  );
}

function incompleteRun(failureCode: string, at = NOW): void {
  const run = fixture.access.reconcileRuns.start(fixture.scope, fixture.integration.id, {
    integration_id: fixture.integration.id,
    started_at: at,
  });
  fixture.access.reconcileRuns.finish(fixture.scope, run.id, {
    status: "incomplete",
    pages_seen: 0,
    roster_size: 0,
    failure_code: failureCode,
    finished_at: at,
  });
}

// ---------------------------------------------------------------------------
// Admission from verified capabilities
// ---------------------------------------------------------------------------

describe("admission from verified provider capabilities", () => {
  test("verified code read on every repository admits; write supports the member ceiling", () => {
    const { userId } = addMember(fixture, { subject: "7101", login: "ana", role: "member" });
    applyRoster([{ subject: "7101", userId, provider_role: "write" }]);

    const admission = evaluate(userId);
    expect(admission.state).toBe("admitted");
    expect(admission.admitted).toBe(true);
    expect(caps(admission)).toEqual(["code_read", "issue_write", "repository_write"]);
    expect(admission.role_ceiling).toBe("member");
    expect(admission.assigned_role).toBe("member");
    expect(admission.evidence_complete).toBe(true);
    expect(admission.evidence_classes).toEqual(["verified"]);
    expect(admission.repository_count).toBe(1);
    expect(admission.set_version).toBe(1);
  });

  test("a read-only provider fact admits but caps the ceiling at viewer", () => {
    const { userId } = addMember(fixture, { subject: "7102", login: "bo", role: "member" });
    applyRoster([{ subject: "7102", userId, provider_role: "read" }]);

    const admission = evaluate(userId);
    expect(admission.state).toBe("admitted");
    expect(caps(admission)).toEqual(["code_read"]);
    // The assigned role is preserved; the ceiling is what the provider proves.
    expect(admission.assigned_role).toBe("member");
    expect(admission.role_ceiling).toBe("viewer");
  });

  test("a verified fact without code read is a confirmed refusal, not an outage", () => {
    const { userId } = addMember(fixture, { subject: "7103", login: "cy", role: "viewer" });
    // GitHub organization membership is a supported fact that proves no
    // repository access: exactly the "verified, but not eligible" case.
    applyRoster([
      {
        subject: "7103",
        userId,
        provider_role: "member",
        source_kind: "org_member",
      },
    ]);

    const admission = evaluate(userId);
    expect(admission.state).toBe("confirmed_revoked");
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("no_code_read");
    expect(caps(admission)).toEqual([]);
    expect(admission.role_ceiling).toBe("viewer");
  });
});

// ---------------------------------------------------------------------------
// Evidence classes
// ---------------------------------------------------------------------------

describe("evidence classes stay distinguishable and none proves admission", () => {
  test("unknown: no provider verification yet", () => {
    const { userId } = addMember(fixture, { subject: "7201", login: "di", role: "member" });
    const admission = evaluate(userId);
    expect(admission.state).toBe("unverifiable");
    expect(admission.reason).toBe("authority_unknown");
    expect(admission.evidence_classes).toEqual(["unknown"]);
    expect(admission.admitted).toBe(false);
  });

  test("expired: the verification aged out of the freshness bound", () => {
    const { userId } = addMember(fixture, { subject: "7202", login: "ed", role: "member" });
    applyRoster([{ subject: "7202", userId, provider_role: "write" }]);

    fixture.clock.now = new Date(Date.parse(NOW) + 25 * HOUR_MS);
    const admission = evaluate(userId);
    expect(admission.state).toBe("unverifiable");
    expect(admission.reason).toBe("verification_expired");
    expect(admission.evidence_classes).toEqual(["expired"]);
  });

  test("truncated: a partially visible roster cannot prove anything", () => {
    const partial = setupFixture({ permission_visibility: "partial" });
    const { userId } = addMember(partial, { subject: "7203", login: "fi", role: "member" });
    partial.access.roster.applySnapshot(partial.scope, partial.integration.id, {
      roles: [
        {
          subject: "7203",
          login: "fi",
          source_kind: "direct_collaborator",
          provider_role: "write",
          authority_ref: REPO_ID,
          inherited_from: null,
        },
      ],
      verified_at: NOW,
      subject_users: { "7203": userId },
    });

    const admission = partial.admission.evaluate(partial.scope, userId);
    expect(admission.state).toBe("unverifiable");
    expect(admission.reason).toBe("permission_visibility_partial");
    expect(admission.evidence_classes).toEqual(["truncated"]);
  });

  test("provider_unavailable is not an expired verification", () => {
    const { userId } = addMember(fixture, { subject: "7204", login: "gu", role: "member" });
    applyRoster([{ subject: "7204", userId, provider_role: "write" }]);
    // Reconciliation could not reach the provider: authority degrades to
    // `stale`, and the run records why. That is not "the fact got old".
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7204",
      "stale",
      NOW,
    );
    incompleteRun("PROVIDER_UNAVAILABLE");

    const admission = evaluate(userId);
    expect(admission.state).toBe("unverifiable");
    expect(admission.reason).toBe("authority_stale");
    expect(admission.evidence_classes).toEqual(["provider_unavailable"]);
  });

  test("a truncated roster fetch is reported as truncated, not as unknown", () => {
    const { userId } = addMember(fixture, { subject: "7205", login: "hy", role: "member" });
    applyRoster([{ subject: "7205", userId, provider_role: "write" }]);
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7205",
      "stale",
      NOW,
    );
    incompleteRun("PROVIDER_ROSTER_INCOMPLETE");

    const admission = evaluate(userId);
    expect(admission.state).toBe("unverifiable");
    expect(admission.evidence_classes).toEqual(["truncated"]);
  });

  test("confirmed revocation: the provider positively says access is gone", () => {
    const { userId } = addMember(fixture, { subject: "7206", login: "jo", role: "member" });
    applyRoster([{ subject: "7206", userId, provider_role: "write" }]);
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7206",
      "removed",
      NOW,
    );

    const admission = evaluate(userId);
    expect(admission.state).toBe("confirmed_revoked");
    expect(admission.reason).toBe("repository_access_removed");
    expect(admission.evidence_classes).toEqual(["confirmed_revocation"]);
  });
});

// ---------------------------------------------------------------------------
// The protection set
// ---------------------------------------------------------------------------

describe("current effective members", () => {
  test("an unverifiable member stays in the protection set, a revoked one does not", () => {
    const unknown = addMember(fixture, { subject: "7301", login: "ka", role: "member" });
    const liveRevoked = addMember(fixture, { subject: "7302", login: "lu", role: "member" });
    const suspended = addMember(fixture, { subject: "7303", login: "mo", role: "member" });
    const persistedRevoked = addMember(fixture, {
      subject: "7305",
      login: "ny",
      role: "member",
    });
    applyRoster([
      { subject: "7302", userId: liveRevoked.userId, provider_role: "write" },
      { subject: "7303", userId: suspended.userId, provider_role: "write" },
      { subject: "7305", userId: persistedRevoked.userId, provider_role: "write" },
    ]);
    suspendEnterpriseUser(fixture.scope.enterprise_id, suspended.userId);

    // A live confirmed revocation stays in the protection set: a precheck must
    // see the confirmed denial instead of silently dropping the member.
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7302",
      "removed",
      NOW,
    );
    // A persisted one is the durable mark: the member is no longer current.
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7305",
      "removed",
      NOW,
    );
    fixture.capabilityCeilings.evaluate(fixture.scope, persistedRevoked.userId);

    const report = fixture.admission.workspace(fixture.scope);
    const ids = report.members.map((member) => member.user_id);
    expect(ids).toContain(unknown.userId);
    expect(ids).toContain(liveRevoked.userId);
    expect(ids).not.toContain(suspended.userId);
    expect(ids).not.toContain(persistedRevoked.userId);

    const unknownMember = report.members.find((member) => member.user_id === unknown.userId)!;
    expect(unknownMember.protected).toBe(true);
    expect(unknownMember.state).toBe("unverifiable");

    const liveMember = report.members.find((member) => member.user_id === liveRevoked.userId)!;
    expect(liveMember.protected).toBe(true);
    expect(liveMember.state).toBe("confirmed_revoked");
    expect(liveMember.reason).toBe("repository_access_removed");

    expect(report.excluded.map((member) => member.user_id)).toContain(suspended.userId);
    expect(
      report.excluded.find((member) => member.user_id === suspended.userId)?.excluded_reason,
    ).toBe("enterprise_inactive");
    expect(
      report.excluded.find((member) => member.user_id === persistedRevoked.userId)?.excluded_reason,
    ).toBe("confirmed_revoked");

    const counts = report.counts;
    expect(counts.members).toBe(4);
    expect(counts.protected).toBe(2);
    expect(counts.effective_owners).toBe(0);
    expect(report.evidence_complete).toBe(false);
  });

  test("a persisted confirmed revocation is excluded, and recovery does not re-admit", () => {
    const { userId } = addMember(fixture, { subject: "7304", login: "na", role: "member" });
    applyRoster([{ subject: "7304", userId, provider_role: "write" }]);
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7304",
      "removed",
      NOW,
    );
    // A normal request-path evaluation persists the confirmed loss.
    fixture.capabilityCeilings.evaluate(fixture.scope, userId);

    const revokedReport = fixture.admission.workspace(fixture.scope);
    const entry = revokedReport.excluded.find((member) => member.user_id === userId);
    expect(entry?.excluded_reason).toBe("confirmed_revoked");
    expect(revokedReport.members).toHaveLength(0);

    // The provider recovers; the persisted reduction is observed but not raised.
    applyRoster([{ subject: "7304", userId, provider_role: "write" }]);
    const after = evaluate(userId, { persist: true });
    expect(after.state).toBe("confirmed_revoked");
    expect(caps(after)).toEqual([]);
    expect(after.ceiling.promotion_available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Effective owners
// ---------------------------------------------------------------------------

describe("effective owners", () => {
  test("an owner assignment alone is not an effective owner", () => {
    const owning = addMember(fixture, { subject: "7401", login: "ow", role: "owner" });
    const onPaper = addMember(fixture, { subject: "7402", login: "pa", role: "owner" });
    applyRoster([
      { subject: "7401", userId: owning.userId, provider_role: "admin" },
      // `write` administers nothing: the workspace admin needs repository
      // management authority across every repository.
      { subject: "7402", userId: onPaper.userId, provider_role: "write" },
    ]);

    const owners = fixture.admission.effectiveOwners(fixture.scope);
    expect(owners.map((owner) => owner.user_id)).toEqual([owning.userId]);
    const paperOwner = fixture.admission
      .workspace(fixture.scope)
      .effective_owners.find((owner) => owner.user_id === onPaper.userId)!;
    expect(paperOwner.effective).toBe(false);
    expect(paperOwner.reason).toBe("management_missing");
    expect(paperOwner.management_proven).toBe(false);

    // The effective owner is the last one: the on-paper owner does not count.
    expect(fixture.admission.hasOtherEffectiveOwner(fixture.scope, owning.userId)).toBe(false);
    expect(fixture.admission.hasOtherEffectiveOwner(fixture.scope, onPaper.userId)).toBe(true);
  });

  test("unverifiable authority is neither proof of an owner nor a revocation", () => {
    const owning = addMember(fixture, { subject: "7403", login: "qu", role: "owner" });
    const unverified = addMember(fixture, { subject: "7404", login: "ra", role: "owner" });
    applyRoster([
      { subject: "7403", userId: owning.userId, provider_role: "admin" },
      { subject: "7404", userId: unverified.userId, provider_role: "admin" },
    ]);
    fixture.access.roster.setAuthorityState(
      fixture.scope,
      fixture.integration.id,
      "7404",
      "stale",
      NOW,
    );

    const owner = fixture.admission
      .workspace(fixture.scope)
      .effective_owners.find((entry) => entry.user_id === unverified.userId)!;
    expect(owner.effective).toBe(false);
    expect(owner.reason).toBe("admission_unverifiable");
    expect(owner.evidence_class).toBe("expired");

    // Unprovable is not effective: the workspace must not be left with only
    // this owner, so the effective owner is still the last effective one.
    expect(fixture.admission.hasOtherEffectiveOwner(fixture.scope, owning.userId)).toBe(false);
  });

  test("an inactive enterprise membership or suspended account is not an effective owner", () => {
    const suspendedEnterprise = addMember(fixture, { subject: "7405", login: "sa", role: "owner" });
    const suspendedUser = addMember(fixture, {
      subject: "7406",
      login: "su",
      role: "owner",
      user_status: "suspended",
    });
    applyRoster([
      { subject: "7405", userId: suspendedEnterprise.userId, provider_role: "admin" },
      { subject: "7406", userId: suspendedUser.userId, provider_role: "admin" },
    ]);
    suspendEnterpriseUser(fixture.scope.enterprise_id, suspendedEnterprise.userId);

    const owners = fixture.admission.workspace(fixture.scope).effective_owners;
    const enterpriseOwner = owners.find((owner) => owner.user_id === suspendedEnterprise.userId);
    const userOwner = owners.find((owner) => owner.user_id === suspendedUser.userId);
    expect(enterpriseOwner?.reason).toBe("enterprise_inactive");
    expect(userOwner?.reason).toBe("user_inactive");
    expect(fixture.admission.effectiveOwners(fixture.scope)).toHaveLength(0);
  });

  test("owners are isolated per enterprise and per workspace", () => {
    const owning = addMember(fixture, { subject: "7407", login: "to", role: "owner" });
    applyRoster([{ subject: "7407", userId: owning.userId, provider_role: "admin" }]);
    expect(fixture.admission.effectiveOwners(fixture.scope)).toHaveLength(1);

    // The same person is an owner in another enterprise's workspace, whose
    // provider instance is not bound to any identity they hold.
    const { enterprise: other } = seedEnterprise(fixture.db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: "other-ent",
      admin_user_id: "usr_other_admin",
    });
    const otherAdminScope = {
      enterprise_id: other.id,
      actor_id: "usr_other_admin",
    };
    const otherInstance = seedProviderInstance(fixture.db, otherAdminScope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    const otherWorkspace = seedWorkspace(fixture.db, otherAdminScope, {
      name: "Other",
      repository_id: REPO_B,
      provider_instance_id: otherInstance.id,
    });
    const otherScope: WorkspaceScope = {
      enterprise_id: other.id,
      workspace_id: otherWorkspace.id,
      actor_id: "usr_other_admin",
    };
    fixture.identity.enterpriseUsers.ensureActive(
      other.id,
      owning.userId,
      { kind: "deployment" },
      { provider_instance_id: otherInstance.id, subject: "7407" },
    );
    createRepositories(fixture.db).memberships.create(otherScope, {
      user_id: owning.userId,
      role: "owner",
    });

    // The other enterprise's workspace cannot prove anything about this
    // person, and that neither promotes nor revokes them in the first one.
    const otherOwners = fixture.admission.workspace(otherScope).effective_owners;
    expect(otherOwners).toHaveLength(1);
    expect(otherOwners[0]?.effective).toBe(false);
    expect(otherOwners[0]?.reason).toBe("admission_unverifiable");
    expect(fixture.admission.effectiveOwners(fixture.scope).map((o) => o.user_id)).toEqual([
      owning.userId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The last effective owner
// ---------------------------------------------------------------------------

/** One audited demotion through the store, with the admission probe wired. */
function demote(userId: string, role: WorkspaceRole) {
  const membership = fixture.memberships.getByUser(fixture.scope, userId)!;
  return fixture.memberships.updateRoleAudited(
    fixture.scope,
    membership.id,
    role,
    membership.version,
    {
      event: "membership.role_changed",
      enterprise_id: fixture.scope.enterprise_id,
      actor_kind: "user",
      actor_user_id: "usr_operator",
      subject_user_id: userId,
      details: { role },
    },
    {
      blockedAudit: {
        enterprise_id: fixture.scope.enterprise_id,
        actor_kind: "user",
        actor_user_id: "usr_operator",
        action: "demote",
      },
      verifyOwnerRemoval: (scope, target) =>
        fixture.admission.verifyOwnerRemoval(scope, target.user_id),
    },
  );
}

describe("last effective owner protection", () => {
  test("an owner row that proves nothing does not unblock the last effective owner", () => {
    const owning = addMember(fixture, { subject: "7701", login: "aa", role: "owner" });
    const onPaper = addMember(fixture, { subject: "7702", login: "ab", role: "owner" });
    applyRoster([
      { subject: "7701", userId: owning.userId, provider_role: "admin" },
      { subject: "7702", userId: onPaper.userId, provider_role: "write" },
    ]);

    const check = fixture.admission.verifyOwnerRemoval(fixture.scope, owning.userId);
    expect(check).toEqual({ target_effective: true, other_effective: false });

    try {
      demote(owning.userId, "admin");
      throw new Error("expected the last effective owner to be protected");
    } catch (error) {
      expect(error).toBeInstanceOf(LastOwnerError);
      expect((error as LastOwnerError).details.reason).toBe("last_effective_owner");
    }

    // The on-paper owner can go: removing him costs no effective ownership, so
    // the deployment recovery path is not blocked by a permission that never
    // existed.
    const paperCheck = fixture.admission.verifyOwnerRemoval(fixture.scope, onPaper.userId);
    expect(paperCheck).toEqual({ target_effective: false, other_effective: true });
    expect(demote(onPaper.userId, "member").role).toBe("member");

    // The remaining owner is now the only role assignment too.
    const membership = fixture.memberships.getByUser(fixture.scope, owning.userId)!;
    expect(() => demote(owning.userId, "admin")).toThrow(LastOwnerError);
    expect(fixture.memberships.getById(fixture.scope, membership.id)?.role).toBe("owner");
  });

  test("two effective owners may change; the last one may not", () => {
    const first = addMember(fixture, { subject: "7703", login: "ac", role: "owner" });
    const second = addMember(fixture, { subject: "7704", login: "ad", role: "owner" });
    applyRoster([
      { subject: "7703", userId: first.userId, provider_role: "admin" },
      { subject: "7704", userId: second.userId, provider_role: "admin" },
    ]);

    expect(fixture.admission.verifyOwnerRemoval(fixture.scope, first.userId)).toEqual({
      target_effective: true,
      other_effective: true,
    });
    expect(demote(first.userId, "admin").role).toBe("admin");
    // The survivor is now the last role assignment as well, so the role-count
    // floor refuses the demotion with its own distinguishable reason.
    try {
      demote(second.userId, "member");
      throw new Error("expected the survivor to be protected");
    } catch (error) {
      expect(error).toBeInstanceOf(LastOwnerError);
      expect((error as LastOwnerError).details.reason).toBe("last_workspace_owner");
    }
  });
});

// ---------------------------------------------------------------------------
// Versioning, persistence and no silent promotion
// ---------------------------------------------------------------------------

describe("set version changes and reduced ceilings", () => {
  test("a set version change is recorded without raising a confirmed reduction", () => {
    const { userId } = addMember(fixture, { subject: "7501", login: "ve", role: "admin" });
    applyRoster([{ subject: "7501", userId, provider_role: "admin" }]);
    const initial = evaluate(userId, { persist: true });
    expect(initial.capabilities).toContain("repository_manage");

    applyRoster([{ subject: "7501", userId, provider_role: "write" }]);
    const reduced = evaluate(userId, { persist: true });
    expect(reduced.state).toBe("admitted");
    expect(reduced.capabilities).not.toContain("repository_manage");

    // The provider upgrades again, and the repository set version moves.
    applyRoster([{ subject: "7501", userId, provider_role: "admin" }]);
    fixture.db
      .prepare(
        "UPDATE workspace SET repository_set_version = repository_set_version + 1 WHERE id = ?",
      )
      .run(fixture.workspaceId);

    const afterSetChange = evaluate(userId, { persist: true });
    expect(afterSetChange.set_version).toBe(2);
    expect(afterSetChange.capabilities).not.toContain("repository_manage");
    expect(afterSetChange.ceiling.state).toBe("downgraded");
    expect(afterSetChange.ceiling.promotion_available).toBe(true);
    // The assigned role is untouched by any provider fact.
    expect(afterSetChange.assigned_role).toBe("admin");
  });

  test("a multi-repository stored set authorizes nothing while the gate is closed", () => {
    const { userId } = addMember(fixture, { subject: "7502", login: "we", role: "owner" });
    applyRoster([{ subject: "7502", userId, provider_role: "admin" }]);
    // A stored second binding with a valid installation for its own repository:
    // only the closed gate keeps this combination unreachable in production.
    const cross = crossProvider([]);
    const now = new Date().toISOString();
    fixture.db
      .prepare(
        `INSERT INTO workspace_repository_binding
           (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
            repository_id, repository_url, repository_name, position, status,
            created_at, updated_at, created_by, updated_by, version)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 2, 'active', ?, ?, ?, ?, 1)`,
      )
      .run(
        "wrb_second",
        fixture.scope.enterprise_id,
        fixture.workspaceId,
        cross.gitlabInstanceId,
        cross.integrationB,
        REPO_B,
        REPO_NAME_B,
        now,
        now,
        "usr_operator",
        "usr_operator",
      );

    const report = fixture.admission.workspace(fixture.scope);
    expect(report.set_blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_DISABLED");
    expect(report.multi_repository).toBe(true);
    expect(report.gate).toBe("disabled");
    // Every member is unverifiable for the scope, even with verified facts.
    for (const member of report.members) {
      expect(member.state).toBe("unverifiable");
      expect(member.reason).toBe("repository_set_unsupported");
    }
    expect(report.counts.effective_owners).toBe(0);

    // A preview can still be formed (that is the question a repository-set
    // change asks), and it reports the closed gate instead of pretending the
    // scope is usable.
    const preview = fixture.admission.previewProposedSet(fixture.scope, {
      additional_repositories: [],
    });
    expect(preview.authorizes_access).toBe(false);
    expect(preview.current_set_blocked_reason).toBe("repository_set_unsupported");
    expect(preview.multi_repository_gate).toBe("disabled");
    const entry = preview.members.find((member) => member.user_id === userId)!;
    expect(entry.retains_admission).toBe(false);
    expect(entry.blockers).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Repository addition preview
// ---------------------------------------------------------------------------

interface CrossProvider {
  gitlabInstanceId: string;
  integrationB: string;
}

/** A GitLab instance, repo B's integration, and identities for each member. */
function crossProvider(members: ReadonlyArray<{ userId: string; subject: string }>): CrossProvider {
  const gitlab = seedProviderInstance(fixture.db, fixture.adminScope, {
    provider_type: "gitlab",
    origin_url: "https://gitlab.com",
  });
  const integrationB = fixture.access.integrations.create(fixture.scope, {
    provider_instance_id: gitlab.id,
    repository_id: REPO_B,
    repository_name: REPO_NAME_B,
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    permission_visibility: "full",
    actor_id: "usr_operator",
  });
  for (const member of members) {
    fixture.identity.identities.create({
      user_id: member.userId,
      provider_instance_id: gitlab.id,
      subject: member.subject,
      login: `gitlab-${member.subject}`,
      actor_id: "usr_operator",
    });
  }
  return { gitlabInstanceId: gitlab.id, integrationB: integrationB.id };
}

function applyGitlabRoster(
  integrationB: string,
  entries: ReadonlyArray<{ subject: string; userId: string; provider_role: string }>,
): void {
  const subjectUsers: Record<string, string> = {};
  for (const entry of entries) {
    subjectUsers[entry.subject] = entry.userId;
  }
  fixture.access.roster.applySnapshot(fixture.scope, integrationB, {
    roles: entries.map((entry) => ({
      subject: entry.subject,
      login: `gitlab-${entry.subject}`,
      source_kind: "direct_collaborator",
      provider_role: entry.provider_role,
      authority_ref: REPO_B,
      inherited_from: null,
    })),
    verified_at: NOW,
    subject_users: subjectUsers,
  });
}

function propose(cross: CrossProvider) {
  return fixture.admission.previewProposedSet(fixture.scope, {
    additional_repositories: [
      {
        provider_instance_id: cross.gitlabInstanceId,
        installation_ref: cross.integrationB,
        repository_id: REPO_B,
      },
    ],
  });
}

describe("repository addition preview", () => {
  test("write on A and read-only on B retains admission with a reduced ceiling", () => {
    const owner = addMember(fixture, { subject: "7601", login: "xo", role: "owner" });
    const member = addMember(fixture, { subject: "7602", login: "ya", role: "member" });
    applyRoster([
      { subject: "7601", userId: owner.userId, provider_role: "admin" },
      { subject: "7602", userId: member.userId, provider_role: "write" },
    ]);
    const cross = crossProvider([
      { userId: owner.userId, subject: "8601" },
      { userId: member.userId, subject: "8602" },
    ]);
    applyGitlabRoster(cross.integrationB, [
      // GitLab `owner` proves management on repo B, so the owner keeps it.
      { subject: "8601", userId: owner.userId, provider_role: "owner" },
      // GitLab `reporter` proves read only: the member is admitted, read-only.
      { subject: "8602", userId: member.userId, provider_role: "reporter" },
    ]);

    const preview = propose(cross);
    expect(preview.preview).toBe(true);
    expect(preview.authorizes_access).toBe(false);
    expect(preview.proposed_repository_count).toBe(2);
    expect(preview.current_set_version).toBe(1);
    expect(preview.set_version_current).toBe(true);
    expect(preview.multi_repository_gate).toBe("disabled");

    const memberAfter = preview.members.find((entry) => entry.user_id === member.userId)!;
    expect(memberAfter.retains_admission).toBe(true);
    expect(memberAfter.evidence_complete).toBe(true);
    expect(memberAfter.blockers).toEqual([]);
    expect(memberAfter.proposed_capabilities).toEqual(["code_read"]);
    expect(memberAfter.reduction).toEqual(["issue_write", "repository_write"]);

    const ownerAfter = preview.owners_after.find((entry) => entry.user_id === owner.userId)!;
    expect(ownerAfter.effective).toBe(true);
    expect(preview.last_owner_survives).toBe(true);
    expect(preview.all_members_retain_admission).toBe(true);
    expect(preview.reductions_confirmed_by_impact).toBe(true);
  });

  test("an owner who would lose management on the new repository blocks the addition", () => {
    const owner = addMember(fixture, { subject: "7603", login: "ze", role: "owner" });
    applyRoster([{ subject: "7603", userId: owner.userId, provider_role: "admin" }]);
    const cross = crossProvider([{ userId: owner.userId, subject: "8603" }]);
    applyGitlabRoster(cross.integrationB, [
      { subject: "8603", userId: owner.userId, provider_role: "reporter" },
    ]);

    const preview = propose(cross);
    const ownerAfter = preview.owners_after.find((entry) => entry.user_id === owner.userId)!;
    expect(ownerAfter.effective).toBe(false);
    expect(ownerAfter.reason).toBe("management_missing");
    expect(preview.last_owner_survives).toBe(false);

    const memberAfter = preview.members.find((entry) => entry.user_id === owner.userId)!;
    expect(memberAfter.retains_admission).toBe(true);
    expect(memberAfter.proposed_capabilities).toEqual(["code_read"]);
  });

  test("unverifiable evidence for the new repository blocks instead of denying", () => {
    const member = addMember(fixture, { subject: "7604", login: "ad", role: "member" });
    applyRoster([{ subject: "7604", userId: member.userId, provider_role: "write" }]);
    const cross = crossProvider([{ userId: member.userId, subject: "8604" }]);
    // No roster facts on repo B: the proposal cannot prove anything there.

    const preview = propose(cross);
    const entry = preview.members.find((item) => item.user_id === member.userId)!;
    expect(entry.retains_admission).toBe(false);
    expect(entry.evidence_complete).toBe(false);
    expect(entry.blockers).toEqual(["unknown"]);
    expect(entry.proposed_capabilities).toEqual([]);
    expect(preview.all_members_retain_admission).toBe(false);
    expect(preview.last_owner_survives).toBe(false);
  });

  test("a proposal without an approved installation fails closed", () => {
    const member = addMember(fixture, { subject: "7605", login: "be", role: "member" });
    applyRoster([{ subject: "7605", userId: member.userId, provider_role: "write" }]);
    const cross = crossProvider([{ userId: member.userId, subject: "8605" }]);

    const preview = fixture.admission.previewProposedSet(fixture.scope, {
      additional_repositories: [
        {
          provider_instance_id: cross.gitlabInstanceId,
          installation_ref: null,
          repository_id: REPO_B,
        },
      ],
    });
    const entry = preview.members.find((item) => item.user_id === member.userId)!;
    expect(entry.retains_admission).toBe(false);
    expect(entry.reason).toBe("installation_not_approved");
    expect(entry.blockers).toEqual(["unknown"]);
  });

  test("the preview refuses a duplicate repository and a stale set version", () => {
    const cross = crossProvider([]);
    expect(() =>
      fixture.admission.previewProposedSet(fixture.scope, {
        additional_repositories: [
          {
            provider_instance_id: cross.gitlabInstanceId,
            installation_ref: cross.integrationB,
            repository_id: REPO_ID,
          },
        ],
      }),
    ).toThrow(AdmissionPreviewError);

    try {
      fixture.admission.previewProposedSet(fixture.scope, {
        additional_repositories: [],
        expected_set_version: 9,
      });
      throw new Error("expected a set-version conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(AdmissionPreviewError);
      expect((error as AdmissionPreviewError).code).toBe("ADMISSION_PROPOSAL_SET_VERSION_CONFLICT");
    }
  });
});
