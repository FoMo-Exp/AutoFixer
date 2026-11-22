import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createRepositories,
  migrate,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";

/**
 * Enterprise user storage and migration (DAT-275, ADR-0011).
 *
 * Backfill is limited to authoritative prior evidence — existing workspace
 * memberships and enterprise administrator grants — and never to a bare
 * provider identity. A global suspension stays on `app_user.status`.
 */

function openAt(version: number): ControlPlaneDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, { upTo: version });
  return db;
}

interface Seeded {
  db: ControlPlaneDb;
  enterpriseId: string;
  providerInstanceId: string;
  workspaceId: string;
  memberId: string;
  adminId: string;
  identityOnlyId: string;
  suspendedMemberId: string;
}

/** A database at schema 18 with the authoritative prior data DAT-275 migrates. */
function seedPreMigration(): Seeded {
  const db = openAt(18);
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Legacy Enterprise",
    enterprise_slug: "legacy-ent",
    admin_user_id: "usr_bootstrap",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Legacy Workspace",
    repository_id: "github:FoMo-Exp/AutoFixer",
    provider_instance_id: provider.id,
  });
  const makeUser = (name: string, subject: string, status: "active" | "suspended" = "active") => {
    const user = identity.users.create({ display_name: name, actor_id: "usr_bootstrap" });
    if (status === "suspended") {
      identity.users.setStatus(user.id, "suspended", "usr_bootstrap");
    }
    identity.identities.create({
      user_id: user.id,
      provider_instance_id: provider.id,
      subject,
      login: name.toLowerCase(),
      actor_id: "usr_bootstrap",
    });
    return user.id;
  };
  const memberId = makeUser("Member", "1001");
  const adminId = makeUser("Admin", "1002");
  const identityOnlyId = makeUser("IdentityOnly", "1003");
  const suspendedMemberId = makeUser("Suspended", "1004", "suspended");

  const scope = {
    enterprise_id: enterprise.id,
    workspace_id: workspace.id,
    actor_id: "usr_bootstrap",
  };
  repos.memberships.create(scope, { user_id: memberId, role: "member" });
  repos.memberships.create(scope, { user_id: suspendedMemberId, role: "viewer" });
  identity.enterpriseRoles.grant({
    enterprise_id: enterprise.id,
    user_id: adminId,
    role: "admin",
    actor_id: "usr_bootstrap",
  });

  return {
    db,
    enterpriseId: enterprise.id,
    providerInstanceId: provider.id,
    workspaceId: workspace.id,
    memberId,
    adminId,
    identityOnlyId,
    suspendedMemberId,
  };
}

describe("enterprise user migration", () => {
  test("backfills workspace members and enterprise admins, never a bare identity", () => {
    const seeded = seedPreMigration();
    migrate(seeded.db);
    const identity = createIdentityRepositories(seeded.db);

    const member = identity.enterpriseUsers.getByUser(seeded.enterpriseId, seeded.memberId);
    expect(member?.status).toBe("active");
    expect(member?.claimed_at).not.toBeNull();
    expect(identity.enterpriseUsers.listIdentities(member?.id ?? "")[0]?.subject).toBe("1001");

    const admin = identity.enterpriseUsers.getByUser(seeded.enterpriseId, seeded.adminId);
    expect(admin?.status).toBe("active");
    expect(identity.enterpriseRoles.getByUser(seeded.enterpriseId, seeded.adminId)?.role).toBe(
      "admin",
    );

    const suspended = identity.enterpriseUsers.getByUser(
      seeded.enterpriseId,
      seeded.suspendedMemberId,
    );
    expect(suspended?.status).toBe("active");
    // The historical global suspension is preserved as a global fact.
    expect(identity.users.getById(seeded.suspendedMemberId)?.status).toBe("suspended");

    // Login (provider identity) alone is not enterprise membership.
    expect(
      identity.enterpriseUsers.getByUser(seeded.enterpriseId, seeded.identityOnlyId),
    ).toBeUndefined();
    seeded.db.close();
  });

  test("re-running the migration is a no-op and never duplicates rows", () => {
    const seeded = seedPreMigration();
    migrate(seeded.db);
    const identity = createIdentityRepositories(seeded.db);
    const first = identity.enterpriseUsers.list(seeded.enterpriseId);
    migrate(seeded.db);
    migrate(seeded.db);
    const second = identity.enterpriseUsers.list(seeded.enterpriseId);
    expect(second.items.map((row) => row.id)).toEqual(first.items.map((row) => row.id));
    seeded.db.close();
  });
});

describe("enterprise user repository", () => {
  function fresh() {
    const db = openAt(19);
    const repos = createRepositories(db);
    const identity = createIdentityRepositories(db);
    const { enterprise, admin_scope } = seedEnterprise(db, {
      enterprise_name: "Enterprise A",
      enterprise_slug: "ent-a",
      admin_user_id: "usr_bootstrap",
    });
    const provider = seedProviderInstance(db, admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const admin = identity.users.create({ display_name: "Admin", actor_id: "usr_bootstrap" });
    identity.identities.create({
      user_id: admin.id,
      provider_instance_id: provider.id,
      subject: "9001",
      login: "admin",
      actor_id: "usr_bootstrap",
    });
    identity.enterpriseUsers.ensureActive(enterprise.id, admin.id, "usr_bootstrap", {
      provider_instance_id: provider.id,
      subject: "9001",
    });
    identity.enterpriseUsers.setRole(
      enterprise.id,
      identity.enterpriseUsers.getByUser(enterprise.id, admin.id)?.id ?? "",
      "admin",
      1,
      "usr_bootstrap",
    );
    return {
      db,
      repos,
      identity,
      enterpriseId: enterprise.id,
      providerInstanceId: provider.id,
      adminId: admin.id,
    };
  }

  test("add is idempotent, pending until claimed, and claim binds once", () => {
    const w = fresh();
    const first = w.identity.enterpriseUsers.add({
      enterprise_id: w.enterpriseId,
      provider_instance_id: w.providerInstanceId,
      subject: "4242",
      actor_id: w.adminId,
    });
    expect(first.created).toBe(true);
    expect(first.user.status).toBe("pending_claim");
    expect(first.user.user_id).toBeNull();

    const second = w.identity.enterpriseUsers.add({
      enterprise_id: w.enterpriseId,
      provider_instance_id: w.providerInstanceId,
      subject: "4242",
      actor_id: w.adminId,
    });
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.version).toBe(first.user.version);

    const user = w.identity.users.create({ display_name: "Claimer", actor_id: w.adminId });
    w.identity.identities.create({
      user_id: user.id,
      provider_instance_id: w.providerInstanceId,
      subject: "4242",
      login: "claimer",
      actor_id: w.adminId,
    });
    const claimed = w.identity.enterpriseUsers.claim(w.providerInstanceId, "4242", user.id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("active");
    expect(claimed[0]?.user_id).toBe(user.id);
    // A replayed login never claims or bumps again.
    expect(w.identity.enterpriseUsers.claim(w.providerInstanceId, "4242", user.id)).toHaveLength(0);
    expect(w.identity.enterpriseUsers.getByUser(w.enterpriseId, user.id)?.version).toBe(
      first.user.version + 1,
    );
    const audits = w.identity.authAudit.list({
      enterprise_id: w.enterpriseId,
      event: "enterprise_user.claimed",
    });
    expect(audits).toHaveLength(1);
    w.db.close();
  });

  test("a suspended pending membership is claimed but stays suspended", () => {
    const w = fresh();
    const added = w.identity.enterpriseUsers.add({
      enterprise_id: w.enterpriseId,
      provider_instance_id: w.providerInstanceId,
      subject: "4243",
      actor_id: w.adminId,
    });
    const suspended = w.identity.enterpriseUsers.setStatus(
      w.enterpriseId,
      added.user.id,
      "suspended",
      added.user.version,
      w.adminId,
    );
    expect(suspended.status).toBe("ok");

    const user = w.identity.users.create({ display_name: "Claimer", actor_id: w.adminId });
    const claimed = w.identity.enterpriseUsers.claim(w.providerInstanceId, "4243", user.id);
    expect(claimed[0]?.user_id).toBe(user.id);
    expect(claimed[0]?.status).toBe("suspended");
    w.db.close();
  });

  test("the last active administrator cannot be suspended or demoted", () => {
    const w = fresh();
    const adminRow = w.identity.enterpriseUsers.getByUser(w.enterpriseId, w.adminId);
    expect(adminRow).not.toBeUndefined();
    const suspended = w.identity.enterpriseUsers.setStatus(
      w.enterpriseId,
      adminRow?.id ?? "",
      "suspended",
      adminRow?.version ?? 0,
      w.adminId,
    );
    expect(suspended.status).toBe("last_admin");
    const demoted = w.identity.enterpriseUsers.setRole(
      w.enterpriseId,
      adminRow?.id ?? "",
      "member",
      adminRow?.version ?? 0,
      w.adminId,
    );
    expect(demoted.status).toBe("last_admin");

    // With a second active administrator, the same transitions are allowed.
    const second = w.identity.users.create({ display_name: "Second", actor_id: w.adminId });
    const ensured = w.identity.enterpriseUsers.ensureActive(w.enterpriseId, second.id, w.adminId);
    expect(
      w.identity.enterpriseUsers.setRole(
        w.enterpriseId,
        ensured.user.id,
        "admin",
        ensured.user.version,
        w.adminId,
      ).status,
    ).toBe("ok");
    expect(
      w.identity.enterpriseUsers.setStatus(
        w.enterpriseId,
        adminRow?.id ?? "",
        "suspended",
        adminRow?.version ?? 0,
        w.adminId,
      ).status,
    ).toBe("ok");
    w.db.close();
  });

  test("a required audit write failure rolls the status change back", () => {
    const w = fresh();
    const member = w.identity.users.create({ display_name: "Member", actor_id: w.adminId });
    const ensured = w.identity.enterpriseUsers.ensureActive(w.enterpriseId, member.id, w.adminId);
    const before = w.identity.enterpriseUsers.getByUser(w.enterpriseId, member.id);
    w.db.exec("ALTER TABLE auth_audit RENAME TO auth_audit_unavailable");
    expect(() =>
      w.identity.enterpriseUsers.setStatus(
        w.enterpriseId,
        ensured.user.id,
        "suspended",
        ensured.user.version,
        w.adminId,
      ),
    ).toThrow();
    w.db.exec("ALTER TABLE auth_audit_unavailable RENAME TO auth_audit");
    const after = w.identity.enterpriseUsers.getByUser(w.enterpriseId, member.id);
    expect(after).toEqual(before);
    w.db.close();
  });
});
