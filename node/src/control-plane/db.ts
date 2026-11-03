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
  {
    // Workspace memory (DAT-232): immutable versions, evidence, links, audit
    // events, embeddings, and erasure tombstones. Every content row carries
    // enterprise_id + workspace_id so scope filters hold at the row level;
    // memory content rows reference the workspace with ON DELETE CASCADE so a
    // deleted workspace can never leave items or embeddings behind.
    // memory_events and memory_tombstones intentionally carry plain scope IDs
    // without foreign keys: audit and tombstones must survive the deletion of
    // the rows they describe.
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (
          status IN ('proposed', 'candidate', 'active', 'deprecated', 'retired', 'quarantined')
        ),
        current_version INTEGER NOT NULL,
        support_count INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_items_scope
        ON memory_items(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_status
        ON memory_items(workspace_id, status)`,
      // One row per immutable content version. Everything the memory item
      // contract requires — kind, applicability scope, statement, provenance,
      // trust, sensitivity, temporal validity, content hash, review — lives on
      // the version so any historical run can be rebuilt exactly. Only
      // valid_to is ever written after creation, and it is set at most once
      // when a successor version or supersession closes the window.
      `CREATE TABLE IF NOT EXISTS memory_item_versions (
        item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (
          kind IN ('fact', 'lesson', 'playbook', 'anti_pattern', 'episode', 'policy')
        ),
        scope TEXT NOT NULL,
        statement TEXT NOT NULL,
        preconditions TEXT NOT NULL,
        provenance TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (
          trust IN ('human', 'agent', 'enterprise_template', 'system')
        ),
        sensitivity TEXT NOT NULL CHECK (
          sensitivity IN ('internal', 'confidential', 'restricted')
        ),
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        content_hash TEXT NOT NULL,
        source_run_id TEXT,
        review TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (item_id, version),
        UNIQUE (item_id, content_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_item_versions_run
        ON memory_item_versions(source_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_item_versions_scope
        ON memory_item_versions(enterprise_id, workspace_id)`,
      `CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL CHECK (
          evidence_type IN ('run', 'issue', 'pr', 'commit', 'test', 'reviewer_decision', 'incident')
        ),
        reference TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_evidence_item
        ON memory_evidence(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_evidence_scope
        ON memory_evidence(enterprise_id, workspace_id)`,
      // Links stay inside one workspace: both endpoints are scope-checked at
      // write time and the row itself carries the workspace, so a link can
      // never bridge two workspaces.
      `CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        target_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL CHECK (
          link_type IN ('supersedes', 'contradicts', 'related', 'derived_from')
        ),
        reason TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (item_id, target_item_id, link_type),
        CHECK (item_id <> target_item_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_links_item
        ON memory_links(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_links_target
        ON memory_links(target_item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_links_scope
        ON memory_links(enterprise_id, workspace_id)`,
      // Append-only audit trail. No foreign keys: the audit of a deletion or
      // erasure must outlive the rows it describes. Detail is metadata only —
      // opaque IDs, fixed enums, and counts; never statements, provenance
      // payloads, free-text reasons, or other memory content.
      `CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        item_id TEXT,
        item_version INTEGER,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'item_created', 'version_created', 'version_reviewed', 'evidence_added',
            'link_created', 'status_changed', 'embedding_written',
            'item_deleted', 'workspace_erased'
          )
        ),
        actor_id TEXT NOT NULL,
        run_id TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_events_scope
        ON memory_events(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_events_item
        ON memory_events(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_events_run
        ON memory_events(run_id)`,
      // Derived sensitive data: the composite foreign key ties every embedding
      // to the exact source version, and cascades keep the embedding lifecycle
      // identical to its source item.
      `CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        item_version INTEGER NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        FOREIGN KEY (item_id, item_version)
          REFERENCES memory_item_versions(item_id, version) ON DELETE CASCADE,
        UNIQUE (item_id, item_version, model)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_item
        ON memory_embeddings(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_scope
        ON memory_embeddings(enterprise_id, workspace_id)`,
      // Minimal non-sensitive tombstones kept after purge: opaque IDs, reason,
      // and who purged when. No content, hashes, or provenance.
      `CREATE TABLE IF NOT EXISTS memory_tombstones (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('item_deleted', 'workspace_erased')),
        purged_at TEXT NOT NULL,
        purged_by TEXT NOT NULL,
        UNIQUE (workspace_id, item_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_tombstones_scope
        ON memory_tombstones(enterprise_id, workspace_id)`,
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
