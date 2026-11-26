/**
 * Repository-set change: durable confirmation, set-version validation and the
 * atomic audited commit (DAT-284, ADR-0011).
 *
 * The acceptance boundary is what these tests pin down:
 *
 * - a repository addition commits only against a confirmation the actor
 *   recorded for the same set version, workspace and exact member impact;
 * - the bindings, the set version, the approved ceiling reductions, the
 *   required grant revocations, the audit row and the confirmation's
 *   consumption are one transaction — any failure leaves *none* of them;
 * - concurrent membership, role, evidence and set-version changes invalidate
 *   the confirmation instead of committing a stale decision, and a fresh
 *   preview + confirmation retries cleanly;
 * - the commit stays internal: no route exists, the multi-repository gate
 *   remains closed, and the storage-level `addBinding` refusal is untouched.
 */

import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, test } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  RepositorySetChangeError,
  WorkspaceRepositorySetError,
  createRepositorySetChangeRepository,
  createWorkspaceRepositorySetRepository,
  migrate,
  openControlPlaneDb,
  seedProviderInstance,
} from "../src/control-plane/index.js";
import type {
  CommitRepositorySetAdditionResult,
  RepositorySetAdditionBinding,
  RepositorySetAdditionConfirmation,
  WorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import type { RepositorySetChangeService } from "../src/provider-access/index.js";
import { createRepositorySetChangeService } from "../src/provider-access/index.js";
import { NOW, REPO_ID, addMember, setupFixture, type Fixture } from "./helpers/provider-access.js";

const REPO_B = "gitlab:repo:9100";
const REPO_B_NAME = "acme/service-b";
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface AdditionFixture {
  base: Fixture;
  sets: WorkspaceRepositorySetRepository;
  service: RepositorySetChangeService;
  gitlabInstanceId: string;
  integrationB: string;
  actor: { userId: string };
  member: { userId: string };
  proposal: RepositorySetAdditionBinding[];
}

/** The shape a future enforcement build would ship: an enabled gate row. */
function enableMultiRepositoryGate(db: Fixture["db"]): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', ?, ?, ?)`,
  ).run(
    MULTI_REPOSITORY_GATE_KEY,
    CURRENT_SCHEMA_VERSION,
    "test fixture: enforcement build",
    NOW,
    "usr_auth_system",
  );
}

function applyRoster(
  fixture: Fixture,
  entries: ReadonlyArray<{ subject: string; userId: string; provider_role: string }>,
  integrationId = fixture.integration.id,
  repositoryId = REPO_ID,
): void {
  const subjectUsers: Record<string, string> = {};
  for (const entry of entries) {
    subjectUsers[entry.subject] = entry.userId;
  }
  fixture.access.roster.applySnapshot(fixture.scope, integrationId, {
    roles: entries.map((entry) => ({
      subject: entry.subject,
      login: `login-${entry.subject}`,
      source_kind: "direct_collaborator",
      provider_role: entry.provider_role,
      authority_ref: repositoryId,
      inherited_from: null,
    })),
    verified_at: NOW,
    subject_users: subjectUsers,
  });
}

/**
 * An owner who manages repository A (GitHub `admin`) and repository B
 * (GitLab `owner`), a member who writes on A and only reads B, and the
 * proposed GitLab binding for B.
 */
function setupAddition(
  options: { gate?: "enabled" | "disabled"; withMember?: boolean } = {},
): AdditionFixture {
  const base = setupFixture();
  if ((options.gate ?? "enabled") === "enabled") {
    enableMultiRepositoryGate(base.db);
  }
  const sets = createWorkspaceRepositorySetRepository(base.db);
  const service = createRepositorySetChangeService({
    db: base.db,
    repositorySets: sets,
    changes: createRepositorySetChangeRepository(base.db),
    access: base.access,
    memberships: base.memberships,
    identity: base.identity,
    capabilityCeilings: base.capabilityCeilings,
    admission: base.admission,
    epoch: base.epoch,
    clock: () => base.clock.now,
  });

  const actor = addMember(base, { subject: "8501", login: "owner", role: "owner" });
  const withMember = options.withMember ?? true;
  const member = withMember
    ? addMember(base, { subject: "8502", login: "developer", role: "member" })
    : null;

  applyRoster(base, [
    { subject: "8501", userId: actor.userId, provider_role: "admin" },
    ...(member ? [{ subject: "8502", userId: member.userId, provider_role: "write" }] : []),
  ]);

  const gitlab = seedProviderInstance(base.db, base.adminScope, {
    provider_type: "gitlab",
    origin_url: "https://gitlab.com",
  });
  const integrationB = base.access.integrations.create(base.scope, {
    provider_instance_id: gitlab.id,
    repository_id: REPO_B,
    repository_name: REPO_B_NAME,
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: "usr_operator",
  });
  base.identity.identities.create({
    user_id: actor.userId,
    provider_instance_id: gitlab.id,
    subject: "9501",
    login: "gitlab-owner",
    actor_id: "usr_operator",
  });
  if (member) {
    base.identity.identities.create({
      user_id: member.userId,
      provider_instance_id: gitlab.id,
      subject: "9502",
      login: "gitlab-developer",
      actor_id: "usr_operator",
    });
  }
  applyRoster(
    base,
    [
      { subject: "9501", userId: actor.userId, provider_role: "owner" },
      ...(member ? [{ subject: "9502", userId: member.userId, provider_role: "reporter" }] : []),
    ],
    integrationB.id,
    REPO_B,
  );

  return {
    base,
    sets,
    service,
    gitlabInstanceId: gitlab.id,
    integrationB: integrationB.id,
    actor,
    member: member ?? { userId: "usr_missing_member" },
    proposal: [
      {
        provider_instance_id: gitlab.id,
        installation_ref: integrationB.id,
        repository_id: REPO_B,
        repository_name: REPO_B_NAME,
      },
    ],
  };
}

function preview(fx: AdditionFixture) {
  return fx.base.admission.previewProposedSet(fx.base.scope, {
    additional_repositories: fx.proposal,
    expected_set_version: fx.sets.currentSetVersion(fx.base.scope),
  });
}

/**
 * The exact reductions a caller would confirm, derived from the preview it
 * showed the actor. Mirrors the later preview route rather than hard-coding
 * the fixture's expectation.
 */
function confirmedReductions(fx: AdditionFixture) {
  return preview(fx)
    .members.filter((member) => member.reduction.length > 0)
    .map((member) => ({
      membership_id: member.membership_id,
      user_id: member.user_id,
      capabilities: member.reduction,
    }));
}

function confirm(
  fx: AdditionFixture,
  overrides: Partial<{
    actor_user_id: string;
    expected_set_version: number;
    confirmed_reductions: ReturnType<typeof confirmedReductions>;
    ttl_ms: number;
  }> = {},
): RepositorySetAdditionConfirmation {
  return fx.service.recordAdditionConfirmation(fx.base.scope, {
    actor_user_id: overrides.actor_user_id ?? fx.actor.userId,
    expected_set_version: overrides.expected_set_version ?? 1,
    additional_repositories: fx.proposal,
    confirmed_reductions: overrides.confirmed_reductions ?? confirmedReductions(fx),
    ...(overrides.ttl_ms !== undefined ? { ttl_ms: overrides.ttl_ms } : {}),
  });
}

function commit(
  fx: AdditionFixture,
  confirmation: RepositorySetAdditionConfirmation,
  actorUserId = fx.actor.userId,
): CommitRepositorySetAdditionResult {
  return fx.service.commitAddition(fx.base.scope, {
    actor_user_id: actorUserId,
    confirmation_id: confirmation.id,
  });
}

function bindingRows(fx: AdditionFixture): Array<Record<string, unknown>> {
  return fx.base.db
    .prepare(
      `SELECT * FROM workspace_repository_binding
        WHERE enterprise_id = ? AND workspace_id = ?
        ORDER BY position, id`,
    )
    .all(fx.base.scope.enterprise_id, fx.base.scope.workspace_id) as Array<Record<string, unknown>>;
}

function setVersion(fx: AdditionFixture): number {
  const row = fx.base.db
    .prepare("SELECT repository_set_version FROM workspace WHERE id = ?")
    .get(fx.base.scope.workspace_id) as { repository_set_version: number };
  return row.repository_set_version;
}

function confirmationRows(fx: AdditionFixture): Array<Record<string, unknown>> {
  return fx.base.db
    .prepare(
      `SELECT * FROM workspace_repository_set_confirmation
        WHERE enterprise_id = ? AND workspace_id = ?
        ORDER BY created_at, id`,
    )
    .all(fx.base.scope.enterprise_id, fx.base.scope.workspace_id) as Array<Record<string, unknown>>;
}

function confirmationRow(fx: AdditionFixture, id: string): Record<string, unknown> | undefined {
  return confirmationRows(fx).find((row) => row["id"] === id);
}

function ceilingRow(fx: AdditionFixture, userId: string): Record<string, unknown> | undefined {
  return fx.base.db
    .prepare(
      `SELECT * FROM workspace_member_capability
        WHERE enterprise_id = ? AND workspace_id = ? AND user_id = ?`,
    )
    .get(fx.base.scope.enterprise_id, fx.base.scope.workspace_id, userId) as
    Record<string, unknown> | undefined;
}

function auditRows(fx: AdditionFixture, event: string): Array<Record<string, unknown>> {
  return fx.base.db
    .prepare("SELECT * FROM auth_audit WHERE event = ? ORDER BY at, id")
    .all(event) as Array<Record<string, unknown>>;
}

function auditDetails(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(row["details"])) as Record<string, unknown>;
}

function liveGrants(fx: AdditionFixture, userId: string, at = NOW) {
  return fx.base.access.grants.listLive(fx.base.scope, fx.base.integration.id, {
    grantee_user_id: userId,
    now: at,
  });
}

function grantDelivery(fx: AdditionFixture, userId: string) {
  return fx.base.access.grants.grant(fx.base.scope, fx.base.integration.id, {
    grantee_user_id: userId,
    capability: "delivery_write",
    expires_at: new Date(Date.parse(NOW) + HOUR_MS).toISOString(),
    actor_id: fx.actor.userId,
  });
}

function expectRefusal(fn: () => unknown, code: string): void {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

/** Nothing of a failed commit may survive. */
function expectUnchanged(fx: AdditionFixture, confirmationId: string): void {
  expect(bindingRows(fx)).toHaveLength(1);
  expect(setVersion(fx)).toBe(1);
  expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(0);
  expect(confirmationRow(fx, confirmationId)?.["consumed_at"]).toBeNull();
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("repository-set change schema", () => {
  test("the confirmation table is a forward migration and re-running is a no-op", () => {
    const db = openControlPlaneDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workspace_repository_set_confirmation");
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(22);

    const before = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    migrate(db);
    const after = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(after).toEqual(before);
    db.close();
  });

  test("upgrading a v21 database preserves the workspace binding and adds confirmations", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, { upTo: 21 });
    expect(() => db.prepare("SELECT * FROM workspace_repository_set_confirmation").all()).toThrow();

    // A v21 workspace and its binding must survive the forward migration.
    const setsBefore = createWorkspaceRepositorySetRepository(db);
    expect(() => setsBefore.gate()).not.toThrow();
    migrate(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workspace_repository_set_confirmation");
    const versions = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(versions.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe("repository addition confirmation", () => {
  let fx: AdditionFixture;

  beforeEach(() => {
    fx = setupAddition();
  });

  test("records the exact impact and its audit row for an authorized manager", () => {
    const previewReport = preview(fx);
    expect(previewReport.all_members_retain_admission).toBe(true);
    expect(previewReport.last_owner_survives).toBe(true);

    const confirmation = confirm(fx);

    expect(confirmation.id).toMatch(/^rsc_/);
    expect(confirmation.set_version).toBe(1);
    expect(confirmation.actor_user_id).toBe(fx.actor.userId);
    expect(confirmation.expires_at > confirmation.checked_at).toBe(true);
    expect(confirmation.consumed_at).toBeNull();
    expect(confirmation.impact).toMatchObject({
      proposed_repository_count: 2,
      protected_members: 2,
      reduced_members: 1,
      effective_owners: 1,
      last_owner_survives: true,
    });
    expect(confirmation.members.map((member) => member.user_id).sort()).toEqual(
      [fx.actor.userId, fx.member.userId].sort(),
    );
    const reduced = confirmation.members.find((member) => member.user_id === fx.member.userId)!;
    expect(reduced.reduction).toEqual(["issue_write", "repository_write"]);
    expect(reduced.proposed_capabilities).toEqual(["code_read"]);

    const rows = confirmationRows(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["proposed_bindings"]).toContain(REPO_B);

    const audit = auditRows(fx, "repository_set.addition_confirmed");
    expect(audit).toHaveLength(1);
    expect(audit[0]!["actor_kind"]).toBe("user");
    expect(audit[0]!["actor_user_id"]).toBe(fx.actor.userId);
    const details = auditDetails(audit[0]!);
    expect(details["workspace_id"]).toBe(fx.base.scope.workspace_id);
    expect(details["confirmation_id"]).toBe(confirmation.id);
    expect(details["set_version"]).toBe(1);
  });

  test("a member projected to lose admission rejects the whole addition", () => {
    // No GitLab identity/roster fact: repository B cannot prove read, so the
    // member must not be admitted to the proposed set.
    const stranger = addMember(fx.base, {
      subject: "8509",
      login: "unverified",
      role: "member",
    });
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "admin" },
      { subject: "8502", userId: fx.member.userId, provider_role: "write" },
      { subject: "8509", userId: stranger.userId, provider_role: "write" },
    ]);

    expectRefusal(() => confirm(fx), "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE");
    expect(confirmationRows(fx)).toHaveLength(0);
    expect(auditRows(fx, "repository_set.addition_confirmed")).toHaveLength(0);
  });

  test("an addition that leaves no effective owner rejects even when everyone keeps read", () => {
    // The only owner proves read on B but not management.
    applyRoster(
      fx.base,
      [{ subject: "9501", userId: fx.actor.userId, provider_role: "reporter" }],
      fx.integrationB,
      REPO_B,
    );

    expectRefusal(() => confirm(fx), "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE");
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("a reduction the caller did not confirm is refused", () => {
    expectRefusal(
      () => confirm(fx, { confirmed_reductions: [] }),
      "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
    );
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("a non-manager cannot record a confirmation even though the preview computes", () => {
    // A plain viewer: the preview itself is a read, but the confirmation is a
    // workspace-administration act.
    const viewer = addMember(fx.base, {
      subject: "8510",
      login: "viewer",
      role: "viewer",
    });
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "admin" },
      { subject: "8502", userId: fx.member.userId, provider_role: "write" },
      { subject: "8510", userId: viewer.userId, provider_role: "read" },
    ]);

    expectRefusal(
      () => confirm(fx, { actor_user_id: viewer.userId }),
      "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED",
    );
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("an owner without verified repository management cannot record a confirmation", () => {
    // `maintain` proves write, never management (ADR-0011 policy table).
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "maintain" },
      { subject: "8502", userId: fx.member.userId, provider_role: "write" },
    ]);

    expectRefusal(() => confirm(fx), "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED");
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("a stale set version is refused before any confirmation is written", () => {
    expectRefusal(
      () => confirm(fx, { expected_set_version: 0 }),
      "REPOSITORY_SET_VERSION_CONFLICT",
    );
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("the closed multi-repository gate refuses any binding change", () => {
    const closed = setupAddition({ gate: "disabled" });
    expectRefusal(() => confirm(closed), "SCOPE_MUTATION_DISABLED");
    expect(confirmationRows(closed)).toHaveLength(0);
  });

  test("an unapproved installation in the stored set is not silently repaired", () => {
    fx.base.db
      .prepare("UPDATE service_integration SET install_status = 'suspended' WHERE id = ?")
      .run(fx.base.integration.id);

    expectRefusal(() => confirm(fx), "INSTALLATION_NOT_APPROVED");
    expect(confirmationRows(fx)).toHaveLength(0);
  });

  test("a failed confirmation audit records no confirmation", () => {
    fx.base.db.exec(
      `CREATE TRIGGER fail_confirmation_audit
         BEFORE INSERT ON auth_audit
         BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END`,
    );

    expectRefusal(() => confirm(fx), "REPOSITORY_SET_CHANGE_AUDIT_FAILED");
    expect(confirmationRows(fx)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

describe("repository addition commit", () => {
  let fx: AdditionFixture;

  beforeEach(() => {
    fx = setupAddition();
  });

  test("commits bindings, set version, reductions, revocations, audit and consumption together", () => {
    // A persisted ceiling shows the reduction is a real tightening of stored
    // authority, not only a computed preview.
    fx.base.capabilityCeilings.evaluate(fx.base.scope, fx.member.userId);
    const before = ceilingRow(fx, fx.member.userId)!;
    expect(before["ceiling"]).toContain("repository_write");

    const delivery = grantDelivery(fx, fx.member.userId);
    const readGrant = fx.base.access.grants.grant(fx.base.scope, fx.base.integration.id, {
      grantee_user_id: fx.member.userId,
      capability: "checkout_read",
      expires_at: new Date(Date.parse(NOW) + HOUR_MS).toISOString(),
      actor_id: fx.actor.userId,
    });
    const confirmation = confirm(fx);
    const epochBefore = fx.base.epoch.current();

    const result = commit(fx, confirmation);

    expect(result.set_version_before).toBe(1);
    expect(result.set_version_after).toBe(2);
    expect(result.confirmation_id).toBe(confirmation.id);
    expect(result.binding_ids).toHaveLength(1);
    expect(result.repositories).toEqual([
      { provider_instance_id: fx.gitlabInstanceId, repository_id: REPO_B },
    ]);
    expect(result.members_reduced).toEqual([
      { user_id: fx.member.userId, capabilities: ["code_read"] },
    ]);
    expect(result.grants_revoked).toBe(1);
    expect(result.effective_owners).toEqual([fx.actor.userId]);

    // Storage: one new active binding at the next position, metadata stored,
    // authority bits untouched.
    const bindings = bindingRows(fx);
    expect(bindings).toHaveLength(2);
    const added = bindings.find((row) => row["repository_id"] === REPO_B)!;
    expect(added["status"]).toBe("active");
    expect(added["position"]).toBe(2);
    expect(added["provider_instance_id"]).toBe(fx.gitlabInstanceId);
    expect(added["installation_ref"]).toBe(fx.integrationB);
    expect(added["repository_name"]).toBe(REPO_B_NAME);
    expect(added["created_by"]).toBe(fx.actor.userId);
    expect(setVersion(fx)).toBe(2);

    // The reduced ceiling is persisted, never raised, and records the set
    // version it was approved against.
    const reduced = ceilingRow(fx, fx.member.userId)!;
    expect(JSON.parse(String(reduced["ceiling"]))).toEqual(["code_read"]);
    // The verified intersection is taken over the whole committed set
    // (repository A and the addition), never over the addition alone.
    expect(JSON.parse(String(reduced["available_ceiling"]))).toEqual(["code_read"]);
    expect(reduced["state"]).toBe("downgraded");
    expect(reduced["set_version"]).toBe(2);
    expect(String(reduced["reason"])).toContain("repository");

    // The unsupported delivery grant is gone; the read grant is untouched.
    expect(liveGrants(fx, fx.member.userId)).toHaveLength(1);
    expect(liveGrants(fx, fx.member.userId)[0]!.id).toBe(readGrant.id);
    expect(fx.base.access.grants.getById(fx.base.scope, delivery.id)?.["revoked_at"]).toBeTruthy();

    const audit = auditRows(fx, "repository_set.addition_committed");
    expect(audit).toHaveLength(1);
    expect(audit[0]!["actor_kind"]).toBe("user");
    expect(audit[0]!["actor_user_id"]).toBe(fx.actor.userId);
    const details = auditDetails(audit[0]!);
    expect(details).toMatchObject({
      workspace_id: fx.base.scope.workspace_id,
      confirmation_id: confirmation.id,
      result: "committed",
      set_version_before: 1,
      set_version_after: 2,
    });
    expect(details["repositories"]).toEqual([
      { provider_instance_id: fx.gitlabInstanceId, repository_id: REPO_B },
    ]);
    expect(details["members_reduced"]).toEqual([
      { user_id: fx.member.userId, capabilities: ["code_read"] },
    ]);
    // Disclosable impact, never credential material.
    const serialized = String(audit[0]!["details"]);
    for (const secret of ["svc-source-1", "svc-checkout-1", "svc-delivery-1", "svc-source-b"]) {
      expect(serialized).not.toContain(secret);
    }

    // The decision is consumed exactly once and the in-process epoch moved.
    const stored = confirmationRow(fx, confirmation.id)!;
    expect(stored["consumed_at"]).toBeTruthy();
    expect(stored["consumed_by_set_version"]).toBe(2);
    expect(fx.base.epoch.current()).toBeGreaterThan(epochBefore);

    // The stored set is multi-repository and this build still refuses to
    // authorize it: committing storage never opens the gate.
    const set = fx.sets.getSet(fx.base.scope);
    expect(set.multi_repository).toBe(true);
    expect(set.usable).toBe(false);
    expect(set.blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_UNSUPPORTED");
    expect(() => fx.sets.requireSingleRepository(fx.base.scope)).toThrow(
      expect.objectContaining({ code: "MULTI_REPOSITORY_SCOPE_UNSUPPORTED" }),
    );
  });

  test("replaying a consumed confirmation changes nothing", () => {
    const confirmation = confirm(fx);
    commit(fx, confirmation);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED");
    expect(bindingRows(fx)).toHaveLength(2);
    expect(setVersion(fx)).toBe(2);
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(1);
    expect(auditRows(fx, "repository_set.addition_confirmed")).toHaveLength(1);
  });

  test("an unknown or another actor's confirmation is not usable", () => {
    const confirmation = confirm(fx);
    const otherManager = addMember(fx.base, {
      subject: "8511",
      login: "other-owner",
      role: "owner",
    });
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "admin" },
      { subject: "8502", userId: fx.member.userId, provider_role: "write" },
      { subject: "8511", userId: otherManager.userId, provider_role: "admin" },
    ]);
    applyRoster(
      fx.base,
      [
        { subject: "9501", userId: fx.actor.userId, provider_role: "owner" },
        { subject: "9502", userId: fx.member.userId, provider_role: "reporter" },
        { subject: "9511", userId: otherManager.userId, provider_role: "owner" },
      ],
      fx.integrationB,
      REPO_B,
    );

    expectRefusal(
      () => commit(fx, confirmation, otherManager.userId),
      "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED",
    );
    expectRefusal(
      () =>
        fx.service.commitAddition(fx.base.scope, {
          actor_user_id: fx.actor.userId,
          confirmation_id: "rsc_does_not_exist",
        }),
      "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED",
    );
    expectUnchanged(fx, confirmation.id);
  });

  test("an expired confirmation is refused without touching the set", () => {
    const confirmation = confirm(fx, { ttl_ms: 1_000 });
    fx.base.clock.now = new Date(Date.parse(NOW) + 5_000);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED");
    expectUnchanged(fx, confirmation.id);
  });

  test("an actor who lost management authority between confirmation and commit is refused", () => {
    const confirmation = confirm(fx);
    const membership = fx.base.memberships.getByUser(fx.base.scope, fx.actor.userId)!;
    fx.base.memberships.updateRole(fx.base.scope, membership.id, "member", membership.version);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED");
    expectUnchanged(fx, confirmation.id);
  });

  test("a membership added after the confirmation invalidates it", () => {
    const confirmation = confirm(fx);
    const late = addMember(fx.base, {
      subject: "8512",
      login: "late-joiner",
      role: "member",
    });
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "admin" },
      { subject: "8502", userId: fx.member.userId, provider_role: "write" },
      { subject: "8512", userId: late.userId, provider_role: "write" },
    ]);
    fx.base.identity.identities.create({
      user_id: late.userId,
      provider_instance_id: fx.gitlabInstanceId,
      subject: "9512",
      login: "gitlab-late",
      actor_id: "usr_operator",
    });
    applyRoster(
      fx.base,
      [
        { subject: "9501", userId: fx.actor.userId, provider_role: "owner" },
        { subject: "9502", userId: fx.member.userId, provider_role: "reporter" },
        { subject: "9512", userId: late.userId, provider_role: "developer" },
      ],
      fx.integrationB,
      REPO_B,
    );

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE");
    expectUnchanged(fx, confirmation.id);
  });

  test("a role change after the confirmation invalidates it", () => {
    const confirmation = confirm(fx);
    const membership = fx.base.memberships.getByUser(fx.base.scope, fx.member.userId)!;
    fx.base.memberships.updateRole(fx.base.scope, membership.id, "viewer", membership.version);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE");
    expectUnchanged(fx, confirmation.id);
  });

  test("a membership removal after the confirmation invalidates it", () => {
    const confirmation = confirm(fx);
    const membership = fx.base.memberships.getByUser(fx.base.scope, fx.member.userId)!;
    fx.base.memberships.remove(fx.base.scope, membership.id);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE");
    expectUnchanged(fx, confirmation.id);
  });

  test("a provider capability change after the confirmation invalidates it", () => {
    const confirmation = confirm(fx);
    // Still admitted on B, but no longer writing on A: the confirmed
    // reduction no longer describes the proposed impact.
    applyRoster(fx.base, [
      { subject: "8501", userId: fx.actor.userId, provider_role: "admin" },
      { subject: "8502", userId: fx.member.userId, provider_role: "read" },
    ]);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE");
    expectUnchanged(fx, confirmation.id);
  });

  test("a repository-set version change after the confirmation invalidates it and a fresh attempt retries", () => {
    const confirmation = confirm(fx);
    // A concurrent workspace lifecycle change (transfer) bumps the token.
    fx.base.db
      .prepare(
        "UPDATE workspace SET repository_set_version = repository_set_version + 1 WHERE id = ?",
      )
      .run(fx.base.scope.workspace_id);

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE");
    expect(bindingRows(fx)).toHaveLength(1);
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(0);

    // Conflict retry: re-preview against the new version, confirm, commit.
    const retry = confirm(fx, { expected_set_version: 2 });
    const result = commit(fx, retry);
    expect(result.set_version_before).toBe(2);
    expect(result.set_version_after).toBe(3);
    expect(bindingRows(fx)).toHaveLength(2);
  });

  test("a failed commit audit rolls back bindings, version, ceilings, grants and consumption", () => {
    fx.base.capabilityCeilings.evaluate(fx.base.scope, fx.member.userId);
    const delivery = grantDelivery(fx, fx.member.userId);
    const confirmation = confirm(fx);
    const ceilingBefore = ceilingRow(fx, fx.member.userId)!;
    expect(ceilingBefore["ceiling"]).toContain("repository_write");

    fx.base.db.exec(
      `CREATE TRIGGER fail_commit_audit
         BEFORE INSERT ON auth_audit
         BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END`,
    );

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_AUDIT_FAILED");

    expectUnchanged(fx, confirmation.id);
    expect(ceilingRow(fx, fx.member.userId)!["ceiling"]).toBe(ceilingBefore["ceiling"]);
    expect(fx.base.access.grants.getById(fx.base.scope, delivery.id)?.["revoked_at"]).toBeNull();
  });

  test("a mid-transaction write failure rolls the whole change back", () => {
    fx.base.capabilityCeilings.evaluate(fx.base.scope, fx.member.userId);
    const delivery = grantDelivery(fx, fx.member.userId);
    const confirmation = confirm(fx);
    const ceilingBefore = ceilingRow(fx, fx.member.userId)!;

    fx.base.db.exec(
      `CREATE TRIGGER fail_capability_update
         BEFORE UPDATE ON workspace_member_capability
         BEGIN SELECT RAISE(ABORT, 'capability store unavailable'); END`,
    );

    expect(() => commit(fx, confirmation)).toThrow(/capability store unavailable/);

    expectUnchanged(fx, confirmation.id);
    expect(ceilingRow(fx, fx.member.userId)!["ceiling"]).toBe(ceilingBefore["ceiling"]);
    expect(fx.base.access.grants.getById(fx.base.scope, delivery.id)?.["revoked_at"]).toBeNull();
  });

  test("the storage-level addBinding refusal is untouched and no public route bypasses the confirmation", () => {
    // DAT-284 adds no route and no direct writer on the consumer interface:
    // the only commit path requires a recorded confirmation.
    expect(() =>
      fx.sets.addBinding(fx.base.scope, {
        provider_instance_id: fx.gitlabInstanceId,
        installation_ref: fx.integrationB,
        repository_id: REPO_B,
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_MUTATION_DISABLED" }));
    expect(bindingRows(fx)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("repository-set change scope isolation", () => {
  test("a confirmation cannot be replayed against another workspace", () => {
    const fx = setupAddition();
    const confirmation = confirm(fx);

    const other = setupFixture();
    enableMultiRepositoryGate(other.db);
    const otherSets = createWorkspaceRepositorySetRepository(other.db);
    const otherService = createRepositorySetChangeService({
      db: other.db,
      repositorySets: otherSets,
      changes: createRepositorySetChangeRepository(other.db),
      access: other.access,
      memberships: other.memberships,
      identity: other.identity,
      capabilityCeilings: other.capabilityCeilings,
      admission: other.admission,
      epoch: other.epoch,
      clock: () => other.clock.now,
    });

    expectRefusal(
      () =>
        otherService.commitAddition(other.scope, {
          actor_user_id: fx.actor.userId,
          confirmation_id: confirmation.id,
        }),
      "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED",
    );
    const otherBindings = other.db
      .prepare("SELECT * FROM workspace_repository_binding WHERE workspace_id = ?")
      .all(other.scope.workspace_id) as unknown[];
    expect(otherBindings).toHaveLength(1);
  });

  test("a malformed or foreign confirmation payload is rejected, not repaired", () => {
    const fx = setupAddition();
    const confirmation = confirm(fx);

    // The stored binding is the authority, not a caller-supplied proposal:
    // even a tampered confirmation cannot smuggle an unapproved instance,
    // because the commit re-evaluates and re-checks the binding.
    fx.base.db
      .prepare(
        `UPDATE workspace_repository_set_confirmation
            SET proposed_bindings = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify([
          {
            provider_instance_id: "pi_not_approved",
            installation_ref: null,
            repository_id: "github:repo:666",
          },
        ]),
        confirmation.id,
      );

    expectRefusal(() => commit(fx, confirmation), "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE");
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers that keep the type surface honest
// ---------------------------------------------------------------------------

describe("change error surface", () => {
  test("a change refusal is a typed 403/409 with safe details", () => {
    const fx = setupAddition({ gate: "disabled" });
    try {
      confirm(fx);
      expect.unreachable("the closed gate must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceRepositorySetError);
      expect((error as WorkspaceRepositorySetError).status).toBe(403);
    }

    const fx2 = setupAddition({ withMember: false });
    // Only the owner exists: last-owner protection passes, but the reduction
    // acknowledgement is empty and the owner's own management on B survives.
    const confirmation = confirm(fx2);
    expect(confirmation.members).toHaveLength(1);
    expect(confirmation.impact.reduced_members).toBe(0);

    try {
      fx2.service.commitAddition(fx2.base.scope, {
        actor_user_id: "usr_someone_else",
        confirmation_id: confirmation.id,
      });
      expect.unreachable("another actor must not use the confirmation");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySetChangeError);
      expect((error as RepositorySetChangeError).status).toBe(409);
    }
  });
});
