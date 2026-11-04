/**
 * Migration v5: `provider_member_role.source_kind` gains `effective_access`
 * (DAT-247).
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt. What this
 * test pins down: an existing v4 database keeps every row through the rebuild,
 * the new vocabulary value becomes writable, the constraint still rejects
 * inventions, and running the migration again is a no-op.
 */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  createProviderAccessRepositories,
  createRepositories,
  migrate,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";

function appliedVersions(db: ControlPlaneDb): number[] {
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => (row as { version: number }).version);
}

/** A database at the pre-DAT-247 schema (v4) with one roster row in place. */
function seedV4Database(): {
  db: ControlPlaneDb;
  scope: WorkspaceScope;
  integrationId: string;
} {
  const db = new DatabaseSync(":memory:") as ControlPlaneDb;
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, { upTo: 4 });
  expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);

  const { admin_scope } = seedEnterprise(db, {
    enterprise_name: "Migration Enterprise",
    enterprise_slug: "migration-ent",
    admin_user_id: "usr_operator",
  });
  const providerInstance = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: "github:repo:9001",
    provider_instance_id: providerInstance.id,
  });
  const scope: WorkspaceScope = {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: "usr_operator",
  };
  // Touch the unrelated repositories so the migration test also proves the
  // control plane still works on a v4 database.
  createRepositories(db);
  const access = createProviderAccessRepositories(db);
  const integration = access.integrations.create(scope, {
    provider_instance_id: providerInstance.id,
    repository_id: "github:repo:9001",
    repository_name: "Luthiel/AutoFixer",
    source_credential_ref: "svc-source-1",
    checkout_credential_ref: "svc-checkout-1",

    permission_visibility: "full",
    actor_id: "usr_operator",
  });
  access.roster.applySnapshot(scope, integration.id, {
    roles: [
      {
        subject: "4242",
        login: "octocat",
        source_kind: "direct_collaborator",
        provider_role: "write",
        authority_ref: "repository:Luthiel/AutoFixer",
        inherited_from: null,
      },
    ],
    verified_at: "2026-11-03T12:00:00.000Z",
  });

  return { db, scope, integrationId: integration.id };
}

describe("provider roster migration v5", () => {
  test("upgrading a v4 database preserves every existing row", () => {
    const { db, scope, integrationId } = seedV4Database();
    const before = createProviderAccessRepositories(db).roster.listRoles(scope, integrationId);
    expect(before).toHaveLength(1);
    const beforeRow = before[0];

    migrate(db);

    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const after = createProviderAccessRepositories(db).roster.listRoles(scope, integrationId);
    expect(after).toHaveLength(1);
    // Ids and timestamps survive verbatim — the rebuild copies, not re-keys.
    expect(after[0]).toEqual(beforeRow);
    expect(after[0]?.source_kind).toBe("direct_collaborator");
  });

  test("the rebuilt constraint accepts effective_access and still rejects inventions", () => {
    const { db, scope, integrationId } = seedV4Database();
    migrate(db);

    const access = createProviderAccessRepositories(db);
    access.roster.applySnapshot(scope, integrationId, {
      roles: [
        {
          subject: "4242",
          login: "octocat",
          source_kind: "effective_access",
          provider_role: "write",
          authority_ref: "repository:Luthiel/AutoFixer",
          inherited_from: null,
        },
      ],
      verified_at: "2026-11-03T13:00:00.000Z",
    });

    const rows = access.roster.listRoles(scope, integrationId);
    const kinds = rows.map((row) => row.source_kind).sort();
    expect(kinds).toEqual(["direct_collaborator", "effective_access"]);

    // The CHECK is not loosened into "any string".
    expect(() =>
      db
        .prepare(
          `INSERT INTO provider_member_role (
             id, enterprise_id, workspace_id, integration_id, subject, login,
             source_kind, provider_role, authority_ref, inherited_from,
             observed_at, last_verified_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "prole_bogus",
          scope.enterprise_id,
          scope.workspace_id,
          integrationId,
          "9999",
          "bogus",
          "made_up_source",
          "read",
          "repository:Luthiel/AutoFixer",
          null,
          "2026-11-03T13:00:00.000Z",
          "2026-11-03T13:00:00.000Z",
        ),
    ).toThrow();
  });

  test("running the migration again is a no-op", () => {
    const { db, scope, integrationId } = seedV4Database();
    migrate(db);
    const afterFirst = createProviderAccessRepositories(db).roster.listRoles(scope, integrationId);
    migrate(db);
    migrate(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(createProviderAccessRepositories(db).roster.listRoles(scope, integrationId)).toEqual(
      afterFirst,
    );
  });

  test("a fresh database ends on the same schema as an upgraded one", () => {
    const fresh = new DatabaseSync(":memory:") as ControlPlaneDb;
    fresh.exec("PRAGMA foreign_keys = ON");
    migrate(fresh);
    expect(appliedVersions(fresh)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const upgraded = seedV4Database();
    migrate(upgraded.db);

    const shape = (db: ControlPlaneDb) =>
      (
        db
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_member_role'`,
          )
          .get() as { sql: string }
      ).sql;
    expect(shape(fresh)).toBe(shape(upgraded.db));
  });
});
