import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { ApiError } from "../src/api/errors.js";
import { createWorkspaceRunBindingResolver } from "../src/api/workspace-bindings.js";
import type { OrchestratorConfig } from "../src/config.js";
import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  SchemaVersionMismatchError,
  WorkspaceRepositorySetError,
  assertSchemaSupported,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  EnterpriseScope,
  ProviderInstance,
  Workspace,
  WorkspaceScope,
} from "../src/control-plane/index.js";

/**
 * Workspace repository set: forward migration, versioned read boundary and the
 * fail-closed multi-repository gate (DAT-281, ADR-0011).
 *
 * The acceptance boundary is what these tests pin down: existing
 * single-repository workspaces keep exactly the access they had, the set is
 * versioned and authoritative, and *nothing* — not a read, not the legacy run
 * binding, not a mixed-version process — can turn a set of several
 * repositories into authority before every access path enforces the whole set.
 */

function openAt(version: number): ControlPlaneDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, { upTo: version });
  return db;
}

function appliedVersions(db: ControlPlaneDb): number[] {
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => (row as { version: number }).version);
}

interface Fixture {
  db: ControlPlaneDb;
  enterpriseScope: EnterpriseScope;
  workspaceScope: WorkspaceScope;
  provider: ProviderInstance;
  workspace: Workspace;
}

const REPOSITORY = "github:repo:4242";
const ACTOR = "usr_operator";

/** An enterprise, its approved provider instance and one single-repo workspace. */
function seedSingleRepositoryWorkspace(db: ControlPlaneDb): Fixture {
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
      actor_id: ACTOR,
      workspace_id: workspace.id,
    },
    provider,
    workspace,
  };
}

function allBindings(db: ControlPlaneDb): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM workspace_repository_binding ORDER BY workspace_id, position")
    .all() as unknown as Array<Record<string, unknown>>;
}

function insertSecondBinding(
  db: ControlPlaneDb,
  fixture: Fixture,
  overrides: {
    repository_id?: string;
    provider_instance_id?: string;
    installation_ref?: string | null;
  } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_repository_binding
       (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
        repository_id, repository_url, repository_name, position, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 2, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    `wrb_manual_${Math.random().toString(36).slice(2)}`,
    fixture.enterpriseScope.enterprise_id,
    fixture.workspace.id,
    overrides.provider_instance_id ?? fixture.provider.id,
    overrides.installation_ref ?? null,
    overrides.repository_id ?? "github:repo:9999",
    now,
    now,
    ACTOR,
    ACTOR,
  );
}

/** The legacy single-repository run-binding resolver over the real stores. */
function resolverFor(db: ControlPlaneDb, fixture: Fixture) {
  const repos = createRepositories(db);
  const config = {
    repositoryId: fixture.workspace.repository_id,
    repositoryUrl: "https://github.com/acme/AutoFixer.git",
    baseRef: "main",
    baseSha: "a".repeat(40),
    actorId: ACTOR,
    enterpriseId: fixture.enterpriseScope.enterprise_id,
  } as unknown as OrchestratorConfig;
  return createWorkspaceRunBindingResolver({
    config,
    workspaces: repos.workspaces,
    providerInstances: repos.providerInstances,
    repositorySets: createWorkspaceRepositorySetRepository(db),
  });
}

// ---------------------------------------------------------------------------
// Forward migration and backfill
// ---------------------------------------------------------------------------

describe("workspace repository set migration (v20)", () => {
  test("a v19 database has no repository set; the migration backfills binding #1", () => {
    const db = openAt(19);
    expect(appliedVersions(db)).not.toContain(20);
    const fixture = seedSingleRepositoryWorkspace(db);
    // Below v20 the legacy column is the only evidence; nothing is invented.
    expect(() => db.prepare("SELECT * FROM workspace_repository_binding").all()).toThrow();

    migrate(db);
    expect(appliedVersions(db)).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    );

    const bindings = allBindings(db);
    expect(bindings).toHaveLength(1);
    const binding = bindings[0]!;
    expect(binding["workspace_id"]).toBe(fixture.workspace.id);
    expect(binding["enterprise_id"]).toBe(fixture.enterpriseScope.enterprise_id);
    expect(binding["provider_instance_id"]).toBe(fixture.provider.id);
    expect(binding["repository_id"]).toBe(REPOSITORY);
    expect(binding["position"]).toBe(1);
    expect(binding["status"]).toBe("active");
    expect(binding["installation_ref"]).toBeNull();
    expect(binding["created_at"]).toBe(fixture.workspace.created_at);
  });

  test("the migration links an existing approved installation and copies no other authority", () => {
    const db = openAt(19);
    const fixture = seedSingleRepositoryWorkspace(db);
    const integration = createProviderAccessRepositories(db).integrations.create(
      fixture.workspaceScope,
      {
        provider_instance_id: fixture.provider.id,
        repository_id: REPOSITORY,
        repository_name: "acme/AutoFixer",
        source_credential_ref: "svc-source-1",
        permission_visibility: "full",
        actor_id: ACTOR,
      },
    );

    migrate(db);
    const bindings = allBindings(db);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!["installation_ref"]).toBe(integration.id);

    const set = createWorkspaceRepositorySetRepository(db).getSet(fixture.workspaceScope);
    expect(set.bindings).toHaveLength(1);
    expect(set.set_version).toBe(1);
    expect(set.multi_repository).toBe(false);
    expect(set.usable).toBe(true);
    expect(set.gate.state).toBe("disabled");
  });

  test("re-running the migration neither duplicates bindings nor the gate row", () => {
    const db = openAt(19);
    seedSingleRepositoryWorkspace(db);
    migrate(db);
    const before = allBindings(db);

    migrate(db);
    migrate(db);

    expect(allBindings(db)).toEqual(before);
    const gateRows = db
      .prepare("SELECT * FROM deployment_feature_gate WHERE key = ?")
      .all(MULTI_REPOSITORY_GATE_KEY);
    expect(gateRows).toHaveLength(1);
  });

  test("a restart preserves the set on a durable database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "workspace-repository-set-"));
    const file = path.join(dir, "control-plane.db");
    try {
      const first = openControlPlaneDb({ path: file });
      const fixture = seedSingleRepositoryWorkspace(first);
      const created = createWorkspaceRepositorySetRepository(first).getSet(fixture.workspaceScope);
      first.close();

      const second = openControlPlaneDb({ path: file });
      const reopened = createWorkspaceRepositorySetRepository(second).getSet(
        fixture.workspaceScope,
      );
      expect(reopened).toEqual(created);
      expect(reopened.set_version).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing migration rolls back completely and can be retried", () => {
    const db = openAt(19);
    seedSingleRepositoryWorkspace(db);
    // A view with the binding table's name makes the v20 CREATE TABLE fail.
    db.exec("CREATE VIEW workspace_repository_binding AS SELECT 1 AS id");
    expect(() => migrate(db)).toThrow();

    // Nothing from the failed migration stuck: no column, no version, no gate.
    const columns = (
      db.prepare("PRAGMA table_info(workspace)").all() as unknown as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).not.toContain("repository_set_version");
    expect(appliedVersions(db)).not.toContain(20);
    expect(() => db.prepare("SELECT * FROM deployment_feature_gate").all()).toThrow();

    // Retrying on a healthy database applies it once.
    db.exec("DROP VIEW workspace_repository_binding");
    migrate(db);
    expect(appliedVersions(db)).toContain(20);
    expect(allBindings(db)).toHaveLength(1);
  });

  test("a workspace created after the migration is born with its binding", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const repos = createRepositories(db);
    const { workspace, membership } = repos.createWorkspaceWithOwner(
      fixture.enterpriseScope,
      {
        name: "Second",
        repository_id: "github:repo:7777",
        provider_instance_id: fixture.provider.id,
      },
      ACTOR,
    );
    expect(membership.role).toBe("owner");
    const bindings = allBindings(db).filter((row) => row["workspace_id"] === workspace.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!["repository_id"]).toBe("github:repo:7777");
  });
});

// ---------------------------------------------------------------------------
// Legacy single-repository compatibility
// ---------------------------------------------------------------------------

describe("legacy single-repository path", () => {
  test("the workspace run binding resolves exactly as before", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const resolved = resolverFor(db, fixture).resolve(fixture.workspace.id);
    expect(resolved.repositoryId).toBe(REPOSITORY);
    expect(resolved.workspaceId).toBe(fixture.workspace.id);
    expect(resolved.baseSha).toBe("a".repeat(40));
  });

  test("archive retires the binding and restore reactivates it", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const repos = createRepositories(db);
    const sets = createWorkspaceRepositorySetRepository(db);

    repos.workspaces.archive(fixture.enterpriseScope, fixture.workspace.id, 1);
    expect(sets.listBindings(fixture.workspaceScope)).toHaveLength(0);
    expect(sets.listBindings(fixture.workspaceScope, { include_retired: true })).toHaveLength(1);
    const archivedSet = sets.getSet(fixture.workspaceScope);
    expect(archivedSet.usable).toBe(false);
    expect(archivedSet.blocked_reason).toBe("WORKSPACE_ARCHIVED");
    expect(() => sets.requireSingleRepository(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_ARCHIVED" }),
    );

    repos.workspaces.restore(fixture.enterpriseScope, fixture.workspace.id, 2);
    expect(sets.listBindings(fixture.workspaceScope)).toHaveLength(1);
    expect(sets.getSet(fixture.workspaceScope).usable).toBe(true);
  });

  test("a transfer moves the binding and advances the set version", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const sets = createWorkspaceRepositorySetRepository(db);
    const before = sets.getSet(fixture.workspaceScope);

    createRepositories(db).workspaces.transfer(
      fixture.enterpriseScope,
      fixture.workspace.id,
      { repository_id: "github:repo:5150", provider_instance_id: fixture.provider.id },
      1,
    );

    const after = sets.getSet(fixture.workspaceScope);
    expect(after.bindings).toHaveLength(1);
    expect(after.bindings[0]!.repository_id).toBe("github:repo:5150");
    expect(after.set_version).toBe(before.set_version + 1);
    expect(() => sets.getSetAtVersion(fixture.workspaceScope, before.set_version)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_SET_VERSION_CONFLICT" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fail closed: missing, inconsistent and unapproved binding evidence
// ---------------------------------------------------------------------------

describe("fail-closed binding evidence", () => {
  test("a workspace without a binding is refused, not treated as single-repository", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    db.prepare("DELETE FROM workspace_repository_binding WHERE workspace_id = ?").run(
      fixture.workspace.id,
    );
    const sets = createWorkspaceRepositorySetRepository(db);
    expect(() => sets.getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_MISSING" }),
    );
    expect(() => resolverFor(db, fixture).resolve(fixture.workspace.id)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_MISSING" }),
    );
  });

  test("a binding that disagrees with the workspace's immutable identity is reported", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    db.prepare(
      "UPDATE workspace_repository_binding SET repository_id = ? WHERE workspace_id = ?",
    ).run("github:repo:6666", fixture.workspace.id);

    const sets = createWorkspaceRepositorySetRepository(db);
    expect(() => sets.getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_INCONSISTENT" }),
    );
    expect(() => resolverFor(db, fixture).resolve(fixture.workspace.id)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_INCONSISTENT" }),
    );
  });

  test("a binding through an unapproved provider instance is refused", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    // An approved instance — but of a different enterprise.
    const other = seedEnterprise(db, {
      enterprise_name: "Other",
      enterprise_slug: "other",
      admin_user_id: ACTOR,
    });
    const foreignProvider = seedProviderInstance(db, other.admin_scope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    db.prepare(
      "UPDATE workspace_repository_binding SET provider_instance_id = ? WHERE workspace_id = ?",
    ).run(foreignProvider.id, fixture.workspace.id);

    expect(() => createWorkspaceRepositorySetRepository(db).getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_UNAPPROVED" }),
    );
  });

  test("a binding through an installation that does not cover it is refused", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const access = createProviderAccessRepositories(db);
    const other = seedWorkspace(db, fixture.enterpriseScope, {
      name: "Elsewhere",
      repository_id: "github:repo:1234",
      provider_instance_id: fixture.provider.id,
    });
    const foreignIntegration = access.integrations.create(
      {
        enterprise_id: fixture.enterpriseScope.enterprise_id,
        actor_id: ACTOR,
        workspace_id: other.id,
      },
      {
        provider_instance_id: fixture.provider.id,
        repository_id: "github:repo:1234",
        repository_name: "acme/Elsewhere",
        source_credential_ref: "svc-source-1",
        permission_visibility: "full",
        actor_id: ACTOR,
      },
    );
    db.prepare(
      "UPDATE workspace_repository_binding SET installation_ref = ? WHERE workspace_id = ?",
    ).run(foreignIntegration.id, fixture.workspace.id);

    expect(() => createWorkspaceRepositorySetRepository(db).getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "INSTALLATION_NOT_APPROVED" }),
    );
  });

  test("an uninstalled installation no longer approves the binding", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const access = createProviderAccessRepositories(db);
    const integration = access.integrations.create(fixture.workspaceScope, {
      provider_instance_id: fixture.provider.id,
      repository_id: REPOSITORY,
      repository_name: "acme/AutoFixer",
      source_credential_ref: "svc-source-1",
      permission_visibility: "full",
      actor_id: ACTOR,
    });
    db.prepare(
      "UPDATE workspace_repository_binding SET installation_ref = ? WHERE workspace_id = ?",
    ).run(integration.id, fixture.workspace.id);
    const sets = createWorkspaceRepositorySetRepository(db);
    expect(sets.getSet(fixture.workspaceScope).bindings[0]!.installation_ref).toBe(integration.id);

    db.prepare("UPDATE service_integration SET install_status = 'uninstalled' WHERE id = ?").run(
      integration.id,
    );
    expect(() => sets.getSet(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "INSTALLATION_NOT_APPROVED" }),
    );
  });

  test("a stale observed set version is a conflict, never a silent re-read", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const sets = createWorkspaceRepositorySetRepository(db);
    const set = sets.getSet(fixture.workspaceScope);
    expect(sets.getSetAtVersion(fixture.workspaceScope, set.set_version).set_version).toBe(
      set.set_version,
    );
    expect(() => sets.getSetAtVersion(fixture.workspaceScope, set.set_version + 1)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_SET_VERSION_CONFLICT" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The multi-repository gate
// ---------------------------------------------------------------------------

describe("multi-repository gate", () => {
  test("the gate is stored disabled and immutable", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const sets = createWorkspaceRepositorySetRepository(db);
    const gate = sets.gate();
    expect(gate.key).toBe(MULTI_REPOSITORY_GATE_KEY);
    expect(gate.state).toBe("disabled");
    expect(gate.min_schema_version).toBe(20);

    // No code path flips it, and the storage itself refuses to rewrite history:
    // enabling is a new forward migration that appends a row.
    expect(() =>
      db
        .prepare("UPDATE deployment_feature_gate SET state = 'enabled' WHERE key = ?")
        .run(MULTI_REPOSITORY_GATE_KEY),
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare("DELETE FROM deployment_feature_gate WHERE key = ?")
        .run(MULTI_REPOSITORY_GATE_KEY),
    ).toThrow(/immutable/);
  });

  test("two repositories in one workspace are visible but unusable", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    insertSecondBinding(db, fixture);

    const sets = createWorkspaceRepositorySetRepository(db);
    const set = sets.getSet(fixture.workspaceScope);
    expect(set.bindings).toHaveLength(2);
    expect(set.multi_repository).toBe(true);
    expect(set.usable).toBe(false);
    expect(set.blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_DISABLED");

    expect(() => sets.requireSingleRepository(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "MULTI_REPOSITORY_SCOPE_DISABLED", status: 403 }),
    );
  });

  test("the legacy run binding refuses a multi-repository workspace instead of picking one", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    insertSecondBinding(db, fixture);
    expect(() => resolverFor(db, fixture).resolve(fixture.workspace.id)).toThrow(
      expect.objectContaining({ code: "MULTI_REPOSITORY_SCOPE_DISABLED" }),
    );
  });

  test("creating or removing a binding is refused while the gate is closed", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const sets = createWorkspaceRepositorySetRepository(db);
    expect(() =>
      sets.addBinding(fixture.workspaceScope, {
        provider_instance_id: fixture.provider.id,
        repository_id: "github:repo:8888",
      }),
    ).toThrow(expect.objectContaining({ code: "SCOPE_MUTATION_DISABLED", status: 403 }));
    expect(() =>
      sets.removeBinding(
        fixture.workspaceScope,
        sets.getSet(fixture.workspaceScope).bindings[0]!.id,
      ),
    ).toThrow(expect.objectContaining({ code: "SCOPE_MUTATION_DISABLED", status: 403 }));
    expect(allBindings(db)).toHaveLength(1);
  });

  test("a gate decided by a newer schema is unreadable, so authority fails closed", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    seedSingleRepositoryWorkspace(db);
    db.prepare(
      `INSERT INTO deployment_feature_gate
         (key, min_schema_version, state, reason, created_at, created_by)
       VALUES (?, ?, 'enabled', 'future rollout', ?, ?)`,
    ).run(MULTI_REPOSITORY_GATE_KEY, CURRENT_SCHEMA_VERSION + 1, new Date().toISOString(), ACTOR);

    expect(() => createWorkspaceRepositorySetRepository(db).gate()).toThrow(
      expect.objectContaining({ code: "FEATURE_GATE_UNREADABLE" }),
    );
  });

  test("even an enabled gate does not grant a multi-repository scope this build cannot enforce", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    insertSecondBinding(db, fixture);
    // The shape a future migration would create: the disabled row stays, an
    // enabled row is appended at a higher schema version.
    db.prepare(
      `INSERT INTO deployment_feature_gate
         (key, min_schema_version, state, reason, created_at, created_by)
       VALUES (?, ?, 'enabled', 'future rollout', ?, ?)`,
    ).run(MULTI_REPOSITORY_GATE_KEY, CURRENT_SCHEMA_VERSION + 1, new Date().toISOString(), ACTOR);

    // A build that does not know that schema refuses to read the gate at all.
    expect(() => createWorkspaceRepositorySetRepository(db).gate()).toThrow(
      expect.objectContaining({ code: "FEATURE_GATE_UNREADABLE" }),
    );

    // The build that *does* know it reads `enabled` and still refuses the
    // scope: a gate row is a rollout decision, not an implementation.
    const future = createWorkspaceRepositorySetRepository(db, {
      supportedSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
    });
    expect(future.gate().state).toBe("enabled");
    const set = future.getSet(fixture.workspaceScope);
    expect(set.blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_UNSUPPORTED");
    expect(() => future.requireSingleRepository(fixture.workspaceScope)).toThrow(
      expect.objectContaining({ code: "MULTI_REPOSITORY_SCOPE_UNSUPPORTED" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Mixed-version rollout
// ---------------------------------------------------------------------------

describe("mixed-version rollout", () => {
  test("a build older than the database schema refuses to serve it", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    expect(() => assertSchemaSupported(db, CURRENT_SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSchemaSupported(db, 19)).toThrow(SchemaVersionMismatchError);
    try {
      assertSchemaSupported(db, 19);
    } catch (error) {
      expect(error).toMatchObject({
        code: "SCHEMA_VERSION_UNSUPPORTED",
        database_version: CURRENT_SCHEMA_VERSION,
        supported_version: 19,
      });
    }
  });

  test("the service refuses to open a database written by a newer build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "workspace-repository-mixed-"));
    const file = path.join(dir, "control-plane.db");
    try {
      const current = openControlPlaneDb({ path: file });
      // Simulate a future build's migration.
      current
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
      current.close();
      expect(() => openControlPlaneDb({ path: file })).toThrow(SchemaVersionMismatchError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Uniqueness: concurrent, cross-enterprise and cross-repository
// ---------------------------------------------------------------------------

describe("binding uniqueness", () => {
  test("the same repository cannot be bound actively twice in one enterprise", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const second = seedWorkspace(db, fixture.enterpriseScope, {
      name: "Other",
      repository_id: "github:repo:2222",
      provider_instance_id: fixture.provider.id,
    });
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workspace_repository_binding
             (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
              repository_id, repository_url, repository_name, position, status,
              created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 1, 'active', ?, ?, ?, ?, 1)`,
        )
        .run(
          "wrb_duplicate",
          fixture.enterpriseScope.enterprise_id,
          second.id,
          fixture.provider.id,
          REPOSITORY,
          now,
          now,
          ACTOR,
          ACTOR,
        ),
    ).toThrow(/UNIQUE/);
  });

  test("two connections cannot both bind the same repository", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "workspace-repository-race-"));
    const file = path.join(dir, "control-plane.db");
    try {
      const first = openControlPlaneDb({ path: file });
      const fixture = seedSingleRepositoryWorkspace(first);
      const second = seedWorkspace(first, fixture.enterpriseScope, {
        name: "Racer",
        repository_id: "github:repo:3333",
        provider_instance_id: fixture.provider.id,
      });

      const other = new DatabaseSync(file);
      other.exec("PRAGMA foreign_keys = ON");
      const now = new Date().toISOString();
      const insert = (db: ControlPlaneDb, id: string) =>
        db
          .prepare(
            `INSERT INTO workspace_repository_binding
               (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
                repository_id, repository_url, repository_name, position, status,
                created_at, updated_at, created_by, updated_by, version)
             VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 1, 'active', ?, ?, ?, ?, 1)`,
          )
          .run(
            id,
            fixture.enterpriseScope.enterprise_id,
            second.id,
            fixture.provider.id,
            "github:repo:4444",
            now,
            now,
            ACTOR,
            ACTOR,
          );

      insert(other, "wrb_race_a");
      expect(() => insert(first, "wrb_race_b")).toThrow(/UNIQUE/);
      other.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two enterprises may bind the same repository id independently", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const acme = seedSingleRepositoryWorkspace(db);
    const other = seedEnterprise(db, {
      enterprise_name: "Other",
      enterprise_slug: "other",
      admin_user_id: ACTOR,
    });
    const otherProvider = seedProviderInstance(db, other.admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const otherWorkspace = seedWorkspace(db, other.admin_scope, {
      name: "Mirror",
      repository_id: REPOSITORY,
      provider_instance_id: otherProvider.id,
    });

    const sets = createWorkspaceRepositorySetRepository(db);
    expect(sets.getSet(acme.workspaceScope).bindings[0]!.repository_id).toBe(REPOSITORY);
    const mirrored = sets.getSet({
      enterprise_id: other.admin_scope.enterprise_id,
      actor_id: ACTOR,
      workspace_id: otherWorkspace.id,
    });
    expect(mirrored.bindings[0]!.repository_id).toBe(REPOSITORY);
    // Cross-tenant scope never resolves the other enterprise's workspace.
    expect(() =>
      sets.getSet({ ...acme.workspaceScope, enterprise_id: other.admin_scope.enterprise_id }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  test("one workspace binds one repository once", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workspace_repository_binding
             (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
              repository_id, repository_url, repository_name, position, status,
              created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 2, 'retired', ?, ?, ?, ?, 1)`,
        )
        .run(
          "wrb_same_workspace",
          fixture.enterpriseScope.enterprise_id,
          fixture.workspace.id,
          fixture.provider.id,
          REPOSITORY,
          now,
          now,
          ACTOR,
          ACTOR,
        ),
    ).toThrow(/UNIQUE/);
  });
});

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

describe("refusal surface", () => {
  test("refusals are typed, mapped to a status, and never leak another tenant", () => {
    const db = openAt(CURRENT_SCHEMA_VERSION);
    const fixture = seedSingleRepositoryWorkspace(db);
    insertSecondBinding(db, fixture);
    const resolver = resolverFor(db, fixture);
    try {
      resolver.resolve(fixture.workspace.id);
      throw new Error("expected the resolver to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(403);
      expect(apiError.code).toBe("MULTI_REPOSITORY_SCOPE_DISABLED");
      expect(JSON.stringify(apiError.details ?? {})).not.toContain("github:");
    }
    expect(new WorkspaceRepositorySetError("SCOPE_MUTATION_DISABLED", "x").status).toBe(409);
  });
});
