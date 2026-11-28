/**
 * Mixed-version protection, append-only authorization audit and denial
 * observability (DAT-296, ADR-0011).
 *
 * These are the storage/domain-level proofs the HTTP surface relies on:
 *
 * - a process serving a database migrated by a newer build refuses on its next
 *   authority read, instead of applying older rules to newer state;
 * - a binding state this build does not understand refuses the whole set
 *   rather than silently shrinking it;
 * - `auth_audit` is append-only at the storage layer and a denial record
 *   contains only identifiers, versions and safe codes;
 * - denial trends are workspace-scoped and report a mixed-version deployment
 *   as such.
 */

import { describe, expect, test } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  createAuthorizationAuditRepository,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  migrate,
  openControlPlaneDb,
  readSchemaVersion,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  EnterpriseScope,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import { createAuthorizationStatusService } from "../src/api/authorization-status.js";

const ACTOR = "usr_operator";
const REPOSITORY = "github:repo:4242";

interface Fixture {
  db: ControlPlaneDb;
  enterpriseScope: EnterpriseScope;
  workspaceScope: WorkspaceScope;
  providerId: string;
  workspaceId: string;
}

function seed(): Fixture {
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
    repository_id: REPOSITORY,
    provider_instance_id: provider.id,
  });
  return {
    db,
    enterpriseScope: admin_scope,
    workspaceScope: {
      enterprise_id: admin_scope.enterprise_id,
      workspace_id: workspace.id,
      actor_id: ACTOR,
    },
    providerId: provider.id,
    workspaceId: workspace.id,
  };
}

function migrationCount(db: ControlPlaneDb): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as
    { count: number } | undefined;
  return row?.count ?? 0;
}

function auditColumns(db: ControlPlaneDb): string[] {
  const rows = db.prepare("PRAGMA table_info(auth_audit)").all() as unknown as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function recordFakeNewerMigration(db: ControlPlaneDb): number {
  const version = CURRENT_SCHEMA_VERSION + 1;
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
    version,
    new Date().toISOString(),
  );
  return version;
}

describe("mixed-version protection (DAT-296)", () => {
  test("the audit migration is additive and re-running it is a no-op", () => {
    const { db } = seed();
    const before = migrationCount(db);
    migrate(db);
    expect(migrationCount(db)).toBe(before);
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(23),
    ).toBeDefined();
    expect(auditColumns(db)).toEqual(
      expect.arrayContaining(["workspace_id", "action", "decision_code"]),
    );
  });

  test("a running process refuses a database another build migrated past it", () => {
    const fixture = seed();
    const databaseVersion = recordFakeNewerMigration(fixture.db);
    const sets = createWorkspaceRepositorySetRepository(fixture.db);
    // The process was constructed when the database was current; the guard
    // re-reads the version on the next authority read, not only at startup.
    expect(() => sets.getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({
        code: "SCHEMA_VERSION_UNSUPPORTED",
        details: expect.objectContaining({
          database_schema_version: databaseVersion,
          build_schema_version: CURRENT_SCHEMA_VERSION,
        }),
      }),
    );
    expect(() => sets.gate()).toThrow(
      expect.objectContaining({ code: "SCHEMA_VERSION_UNSUPPORTED" }),
    );
    expect(() => sets.currentSetVersion(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "SCHEMA_VERSION_UNSUPPORTED" }),
    );
  });

  test("a binding state this build does not understand refuses the whole set", () => {
    const fixture = seed();
    const at = new Date().toISOString();
    fixture.db.exec("PRAGMA ignore_check_constraints = ON");
    fixture.db
      .prepare(
        `INSERT INTO workspace_repository_binding
           (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
            repository_id, repository_url, repository_name, position, status,
            created_at, updated_at, created_by, updated_by, version)
         VALUES ('wrb_future', ?, ?, ?, NULL, 'github:repo:9999', NULL, NULL, 2,
                 'pending_removal', ?, ?, ?, ?, 1)`,
      )
      .run(
        fixture.enterpriseScope.enterprise_id,
        fixture.workspaceId,
        fixture.providerId,
        at,
        at,
        ACTOR,
        ACTOR,
      );
    fixture.db.exec("PRAGMA ignore_check_constraints = OFF");
    const sets = createWorkspaceRepositorySetRepository(fixture.db);
    expect(() => sets.getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({
        code: "REPOSITORY_SET_STATE_UNSUPPORTED",
        details: expect.objectContaining({ binding_state: "pending_removal" }),
      }),
    );
  });
});

describe("append-only authorization audit and denial trends (DAT-296)", () => {
  test("a denial record carries identifiers, versions and safe codes only", () => {
    const fixture = seed();
    const audit = createAuthorizationAuditRepository(fixture.db);
    audit.recordDenial({
      enterprise_id: fixture.enterpriseScope.enterprise_id,
      workspace_id: fixture.workspaceId,
      actor_kind: "user",
      actor_user_id: "usr_member",
      action: "read",
      decision_code: "AUTHORITY_RECHECK_REQUIRED",
      reason: "capability_unverified",
      capability_reason: "repository_set_unsupported",
      required_capability: "code_read",
      requires_reconciliation: true,
      target: { provider_instance_id: fixture.providerId, repository_id: REPOSITORY },
      repository_set_version: 1,
      context_schema_version: 1,
      build_schema_version: CURRENT_SCHEMA_VERSION,
    });
    const row = fixture.db
      .prepare("SELECT * FROM auth_audit WHERE event = 'authorization.denied'")
      .get() as {
      workspace_id: string;
      action: string;
      decision_code: string;
      details: string;
      provider_instance_id: string;
    };
    expect(row).toMatchObject({
      workspace_id: fixture.workspaceId,
      action: "read",
      decision_code: "AUTHORITY_RECHECK_REQUIRED",
      provider_instance_id: fixture.providerId,
    });
    const details = JSON.parse(row.details) as Record<string, unknown>;
    expect(details).toMatchObject({
      outcome: "denied",
      repository_set_version: 1,
      context_schema_version: 1,
      build_schema_version: CURRENT_SCHEMA_VERSION,
      database_schema_version: CURRENT_SCHEMA_VERSION,
      target: { provider_instance_id: fixture.providerId, repository_id: REPOSITORY },
    });
    // No credential, URL, content or free-form provider text.
    expect(row.details).not.toMatch(/token|secret|https?:|BEGIN|diff|body/i);
  });

  test("auth_audit rejects updates and deletes at the storage layer", () => {
    const fixture = seed();
    const audit = createAuthorizationAuditRepository(fixture.db);
    audit.recordDenial({
      enterprise_id: fixture.enterpriseScope.enterprise_id,
      workspace_id: fixture.workspaceId,
      actor_kind: "user",
      actor_user_id: "usr_member",
      action: "read",
      decision_code: "FORBIDDEN",
      reason: "workspace_role",
      capability_reason: null,
      required_capability: "code_read",
      requires_reconciliation: false,
      target: null,
      repository_set_version: null,
      context_schema_version: null,
      build_schema_version: CURRENT_SCHEMA_VERSION,
    });
    expect(() => fixture.db.exec("UPDATE auth_audit SET decision_code = 'ALLOWED'")).toThrow(
      /append-only/,
    );
    expect(() => fixture.db.exec("DELETE FROM auth_audit")).toThrow(/append-only/);
  });

  test("denial trends are bounded to one workspace and one window", () => {
    const fixture = seed();
    const audit = createAuthorizationAuditRepository(fixture.db);
    const now = new Date("2026-11-28T12:00:00.000Z");
    const base = {
      enterprise_id: fixture.enterpriseScope.enterprise_id,
      actor_kind: "user" as const,
      actor_user_id: "usr_member",
      reason: "capability_unverified",
      required_capability: "code_read",
      requires_reconciliation: true,
      target: null,
      repository_set_version: 1,
      context_schema_version: 1,
      build_schema_version: CURRENT_SCHEMA_VERSION,
    };
    audit.recordDenial({
      ...base,
      workspace_id: fixture.workspaceId,
      action: "read",
      decision_code: "AUTHORITY_RECHECK_REQUIRED",
      capability_reason: "repository_set_unsupported",
      at: "2026-11-28T11:30:00.000Z",
    });
    audit.recordDenial({
      ...base,
      workspace_id: fixture.workspaceId,
      action: "write",
      decision_code: "AUTHORITY_RECHECK_REQUIRED",
      capability_reason: "repository_set_unsupported",
      at: "2026-11-28T11:31:00.000Z",
    });
    audit.recordDenial({
      ...base,
      workspace_id: fixture.workspaceId,
      action: "read",
      decision_code: "CAPABILITY_LOSS",
      capability_reason: "no_code_read",
      requires_reconciliation: false,
      at: "2026-11-27T11:00:00.000Z",
    });
    audit.recordDenial({
      ...base,
      workspace_id: "ws_other",
      action: "read",
      decision_code: "FORBIDDEN",
      capability_reason: null,
      at: "2026-11-28T11:30:00.000Z",
    });
    const trend = audit.denialTrend(fixture.workspaceScope, {
      since: "2026-11-28T11:00:00.000Z",
      until: now.toISOString(),
    });
    expect(trend.total).toBe(2);
    expect(trend.by_code).toEqual([{ code: "AUTHORITY_RECHECK_REQUIRED", count: 2 }]);
    expect(trend.by_action).toEqual([
      { action: "read", count: 1 },
      { action: "write", count: 1 },
    ]);
    expect(trend.by_capability_reason).toEqual([{ code: "repository_set_unsupported", count: 2 }]);
    expect(audit.recentDenials(fixture.workspaceScope)).toHaveLength(3);
  });
});

describe("workspace authorization status (DAT-296)", () => {
  function statusFor(fixture: Fixture) {
    const audit = createAuthorizationAuditRepository(fixture.db);
    return createAuthorizationStatusService({
      enterprise_id: fixture.enterpriseScope.enterprise_id,
      repositorySets: createWorkspaceRepositorySetRepository(fixture.db),
      audit,
      buildSchemaVersion: CURRENT_SCHEMA_VERSION,
      databaseSchemaVersion: () => readSchemaVersion(fixture.db),
    });
  }

  test("reports the gate, set version and build/database versions", () => {
    const fixture = seed();
    // A real member exists for the caller block, but evidence is unknown
    // until a roster is observed; the status must still be readable.
    createRepositories(fixture.db).memberships.create(fixture.workspaceScope, {
      user_id: "usr_member",
      role: "owner",
    });
    const status = statusFor(fixture).view(fixture.workspaceId, "usr_member");
    expect(status.build).toEqual({
      schema_version: CURRENT_SCHEMA_VERSION,
      database_schema_version: CURRENT_SCHEMA_VERSION,
      mixed_version: false,
    });
    expect(status.rollout.gate.state).toBe("disabled");
    expect(status.rollout.enforcement).toBe("none");
    expect(status.repository_set).toMatchObject({
      readable: true,
      version: 1,
      repository_count: 1,
      multi_repository: false,
      usable: true,
      blocked_reason: null,
    });
    expect(status.caller.evaluated).toBe(false);
    expect(status.denials.total).toBe(0);
  });

  test("reports a database migrated by a newer build as mixed-version", () => {
    const fixture = seed();
    recordFakeNewerMigration(fixture.db);
    const status = statusFor(fixture).view(fixture.workspaceId, "usr_member");
    expect(status.build.mixed_version).toBe(true);
    expect(status.build.database_schema_version).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(status.repository_set).toMatchObject({
      readable: false,
      unreadable_reason: "SCHEMA_VERSION_UNSUPPORTED",
      usable: false,
    });
    expect(status.rollout.gate.state).toBe("unreadable");
    expect(status.rollout.gate.unreadable_code).toBe("SCHEMA_VERSION_UNSUPPORTED");
  });
});
