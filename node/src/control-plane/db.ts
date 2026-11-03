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
  {
    version: 2,
    statements: [
      // Identity: a user is a person; an identity binds one provider instance
      // plus a stable provider subject. Account matching is only ever by
      // (provider_instance_id, subject) — never by email or display name.
      `CREATE TABLE IF NOT EXISTS app_user (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS user_identity (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES app_user(id),
        provider_instance_id TEXT NOT NULL REFERENCES provider_instance(id),
        subject TEXT NOT NULL,
        login TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        UNIQUE (provider_instance_id, subject)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_identity_user
        ON user_identity(user_id)`,
      // Enterprise administration is separate from workspace membership:
      // holding it never grants repository data access by itself.
      `CREATE TABLE IF NOT EXISTS enterprise_role (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        user_id TEXT NOT NULL REFERENCES app_user(id),
        role TEXT NOT NULL CHECK (role IN ('admin')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        UNIQUE (enterprise_id, user_id)
      )`,
      // Server-side sessions: only the SHA-256 digest of the bearer token is
      // stored. The CSRF token is stored in the clear because possession of
      // it without the HttpOnly cookie is useless.
      `CREATE TABLE IF NOT EXISTS auth_session (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES app_user(id),
        kind TEXT NOT NULL CHECK (kind IN ('web', 'desktop')),
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT,
        user_agent TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_session_user
        ON auth_session(user_id)`,
      // One authorization-code flow: state and browser binding are compared
      // as digests, `consumed_at` makes the callback single-use.
      `CREATE TABLE IF NOT EXISTS oauth_flow (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('web', 'desktop')),
        provider_instance_id TEXT NOT NULL REFERENCES provider_instance(id),
        state_hash TEXT NOT NULL UNIQUE,
        binding_hash TEXT NOT NULL,
        pkce_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        return_to TEXT NOT NULL,
        desktop_flow_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_flow_desktop
        ON oauth_flow(desktop_flow_id)`,
      // Desktop system-browser binding: the desktop holds `secret` out of
      // band; the browser login marks the flow ready; one exchange consumes
      // it and mints the desktop session.
      `CREATE TABLE IF NOT EXISTS desktop_auth_flow (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'consumed')),
        user_id TEXT REFERENCES app_user(id),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`,
      // Append-only authentication/authorization audit. Details must never
      // carry bearer tokens, authorization codes, states, or verifiers.
      `CREATE TABLE IF NOT EXISTS auth_audit (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        enterprise_id TEXT,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'deployment', 'anonymous')),
        actor_user_id TEXT,
        subject_user_id TEXT,
        provider_instance_id TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_audit_at
        ON auth_audit(at)`,
      `CREATE INDEX IF NOT EXISTS idx_auth_audit_enterprise
        ON auth_audit(enterprise_id)`,
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
