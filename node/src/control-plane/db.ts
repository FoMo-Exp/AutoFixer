/**
 * SQLite control-plane database: connection management, WAL mode, and
 * idempotent schema migrations.
 *
 * Migrations are plain SQL statements versioned in an ordered list. The
 * `schema_migrations` table records which versions have been applied; the
 * runner applies only un-applied versions, so re-running on an existing
 * database is a safe no-op.
 */

import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS enterprise (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS provider_instance (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        provider_type TEXT NOT NULL CHECK (provider_type IN ('github', 'gitlab')),
        origin_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_instance_enterprise
        ON provider_instance(enterprise_id)`,
      `CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        name TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL REFERENCES provider_instance(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      // Within one enterprise a repository has at most one active workspace.
      // The partial unique index enforces this at the storage level; archived
      // workspaces are free to share a repository_id with an active one.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_active_repo
        ON workspace(enterprise_id, repository_id)
        WHERE status = 'active'`,
      `CREATE INDEX IF NOT EXISTS idx_workspace_enterprise
        ON workspace(enterprise_id)`,
      `CREATE TABLE IF NOT EXISTS team (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        name TEXT NOT NULL,
        leader_user_id TEXT NOT NULL,
        responsibility TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_team_workspace
        ON team(workspace_id)`,
      `CREATE TABLE IF NOT EXISTS membership (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(workspace_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_membership_enterprise_user
        ON membership(enterprise_id, user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_membership_workspace
        ON membership(workspace_id)`,
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ControlPlaneDb = DatabaseSync;

export interface OpenOptions {
  /**
   * Filesystem path for a durable database, or `":memory:"` for tests.
   * Omit to use an anonymous in-memory database.
   */
  path?: string;
}

/**
 * Open (or create) a control-plane database with WAL journaling.
 *
 * WAL allows concurrent readers alongside a single writer, which matches the
 * control-plane access pattern: many scoped reads, occasional transactional
 * writes.
 */
export function openControlPlaneDb(options: OpenOptions = {}): ControlPlaneDb {
  const db = new DatabaseSync(options.path ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Apply all pending migrations. Idempotent: already-applied versions are
 * skipped, so calling this on an up-to-date database is a no-op and calling it
 * on an older database applies only the missing versions.
 */
export function migrate(db: ControlPlaneDb): void {
  // The schema_migrations table is created inside the first migration; create
  // it eagerly so the runner can query it before applying anything.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN");
    try {
      for (const sql of migration.statements) {
        db.exec(sql);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Generate a unique entity ID with a short type prefix.
 *
 * IDs are opaque strings; callers never parse them. The prefix aids debugging
 * and log correlation but carries no authority.
 */
export function newId(prefix: string): string {
  const uuid = crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${uuid}`;
}

/** Current UTC timestamp in ISO-8601 format. */
export function nowIso(): string {
  return new Date().toISOString();
}
