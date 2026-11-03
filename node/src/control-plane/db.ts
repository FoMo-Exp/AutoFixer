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
  {
    // Provider access (DAT-203): repository-scoped service integrations,
    // normalized provider roster rows with provenance, per-subject authority
    // state, capability grants, provider event sync, and reconciliation runs.
    //
    // Credential rules enforced at the storage level: integration rows carry
    // only credential *references* — secret values live in the server
    // credential boundary and never in the control-plane database, logs, or
    // any renderer-visible payload. Authority rows key on the provider's
    // stable subject (never email or display name), and every row is scoped by
    // enterprise_id + workspace_id so ID substitution stays detectable.
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS service_integration (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        provider_instance_id TEXT NOT NULL REFERENCES provider_instance(id),
        -- Immutable provider-assigned repository identifier; a transfer
        -- replaces it only through an authority-revalidated operation.
        repository_id TEXT NOT NULL,
        -- Display metadata only; renames update this without touching
        -- authority or credentials.
        repository_name TEXT NOT NULL,
        install_status TEXT NOT NULL DEFAULT 'active'
          CHECK (install_status IN ('active', 'suspended', 'uninstalled')),
        -- Credential *references*. The secrets they name live in the server
        -- credential boundary (a protected file or injected store), never in
        -- this database or any application payload.
        source_credential_ref TEXT NOT NULL,
        checkout_credential_ref TEXT,
        delivery_credential_ref TEXT,
        -- What the provider adapter declared at install time: whether the
        -- integration can see effective permissions at all.
        permission_visibility TEXT NOT NULL
          CHECK (permission_visibility IN ('full', 'partial', 'none')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_integration_repo
        ON service_integration(enterprise_id, repository_id)
        WHERE install_status != 'uninstalled'`,
      `CREATE INDEX IF NOT EXISTS idx_service_integration_workspace
        ON service_integration(workspace_id)`,
      // Normalized provider roster rows with explicit provenance. A subject
      // may appear through several sources at once (org owner + direct
      // collaborator); every source is its own row so admins can inspect
      // exactly where authority came from. source_kind records the
      // normalization decision — GitHub repositories never get a fabricated
      // 'owner' user; organization authority stays org_owner with the org as
      // authority_ref.
      `CREATE TABLE IF NOT EXISTS provider_member_role (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        integration_id TEXT NOT NULL REFERENCES service_integration(id),
        subject TEXT NOT NULL,
        login TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (
          source_kind IN ('org_owner', 'org_member', 'group', 'inherited_role', 'direct_collaborator')
        ),
        provider_role TEXT NOT NULL,
        authority_ref TEXT NOT NULL,
        inherited_from TEXT,
        observed_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        UNIQUE (integration_id, subject, source_kind, authority_ref)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_member_role_subject
        ON provider_member_role(integration_id, subject)`,
      // Current repository authority per provider subject. The state machine:
      //   active  — verified present in the provider roster
      //   stale   — verification aged out; sensitive actions are blocked
      //   unknown — never verified or authority source moved (e.g. transfer);
      //             everything is blocked pending reconciliation
      //   removed — provider says the subject lost access; every action is
      //             blocked and capability grants are revoked
      `CREATE TABLE IF NOT EXISTS subject_authority (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        integration_id TEXT NOT NULL REFERENCES service_integration(id),
        subject TEXT NOT NULL,
        user_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'unknown', 'removed')),
        last_verified_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (integration_id, subject)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_subject_authority_user
        ON subject_authority(integration_id, user_id)`,
      // Execution capabilities, narrowly scoped and expiring. Checkout gets
      // read; delivery gets a short-lived write grant. Revocation on authority
      // loss sets revoked_at/revoked_reason; expiry is enforced on every read.
      `CREATE TABLE IF NOT EXISTS capability_grant (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        integration_id TEXT NOT NULL REFERENCES service_integration(id),
        grantee_user_id TEXT,
        capability TEXT NOT NULL CHECK (capability IN ('checkout_read', 'delivery_write')),
        branch_scope TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_capability_grantee
        ON capability_grant(integration_id, grantee_user_id)`,
      // Provider event sync log. Payloads are secret-free metadata; delivery
      // ids make event application idempotent under provider retries.
      `CREATE TABLE IF NOT EXISTS provider_event (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        provider_instance_id TEXT NOT NULL REFERENCES provider_instance(id),
        integration_id TEXT,
        repository_id TEXT,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'member_added', 'member_removed', 'role_changed',
            'repository_renamed', 'repository_transferred',
            'integration_suspended', 'permission_changed'
          )
        ),
        payload TEXT NOT NULL DEFAULT '{}',
        delivery_id TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE (provider_instance_id, delivery_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_provider_event_repo
        ON provider_event(provider_instance_id, repository_id)`,
      // Reconciliation runs. An incomplete run (missing permissions,
      // truncated pagination, rate limits) is recorded as such and applies
      // nothing — an incomplete roster is an error, never an empty roster.
      `CREATE TABLE IF NOT EXISTS reconcile_run (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        integration_id TEXT NOT NULL REFERENCES service_integration(id),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'incomplete')),
        pages_seen INTEGER NOT NULL DEFAULT 0,
        roster_size INTEGER NOT NULL DEFAULT 0,
        members_added INTEGER NOT NULL DEFAULT 0,
        members_removed INTEGER NOT NULL DEFAULT 0,
        roles_changed INTEGER NOT NULL DEFAULT 0,
        authority_reset INTEGER NOT NULL DEFAULT 0,
        failure_code TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reconcile_run_integration
        ON reconcile_run(integration_id, started_at)`,
    ],
  },
  {
    // DAT-247: `effective_access` joins the provenance vocabulary. GitHub's
    // collaborator list mixes direct collaborators, team inheritance,
    // organization default permissions, and organization owners without
    // saying which — the provider has no way to attribute the row, so the
    // schema must be able to say exactly that instead of forcing every row to
    // claim a direct grant.
    //
    // SQLite cannot alter a CHECK constraint, so the table is rebuilt:
    // create the new shape, copy every row verbatim (ids, timestamps and all),
    // drop the old table, then recreate the index and UNIQUE constraint. The
    // migration runner records the version, so this runs once per database
    // and repeating `migrate()` is a no-op.
    version: 5,
    statements: [
      `CREATE TABLE provider_member_role_v5 (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        integration_id TEXT NOT NULL REFERENCES service_integration(id),
        subject TEXT NOT NULL,
        login TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (
          source_kind IN (
            'org_owner', 'org_member', 'group', 'inherited_role',
            'direct_collaborator', 'effective_access'
          )
        ),
        provider_role TEXT NOT NULL,
        authority_ref TEXT NOT NULL,
        inherited_from TEXT,
        observed_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        UNIQUE (integration_id, subject, source_kind, authority_ref)
      )`,
      `INSERT INTO provider_member_role_v5 (
         id, enterprise_id, workspace_id, integration_id, subject, login,
         source_kind, provider_role, authority_ref, inherited_from,
         observed_at, last_verified_at
       )
       SELECT
         id, enterprise_id, workspace_id, integration_id, subject, login,
         source_kind, provider_role, authority_ref, inherited_from,
         observed_at, last_verified_at
       FROM provider_member_role`,
      `DROP TABLE provider_member_role`,
      `ALTER TABLE provider_member_role_v5 RENAME TO provider_member_role`,
      `CREATE INDEX IF NOT EXISTS idx_provider_member_role_subject
        ON provider_member_role(integration_id, subject)`,
    ],
  },
  {
    // Owner-created invitations (DAT-204): one opaque bearer per row. Only the
    // HMAC-SHA-256 keyed digest of the bearer is stored, so a leaked database
    // never yields a redeemable token. Single use: `redeemed_at`/`redeemed_by`
    // record the one redemption (and the idempotent-replay subject);
    // `revoked_at`/`revoked_by` record owner revocation. The bound subject, when
    // set, restricts redemption to that verified provider subject. Rows die
    // with their workspace; the audit of an invitation outlives it in auth_audit.
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS invitation (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('member')),
        token_digest TEXT NOT NULL UNIQUE,
        bound_provider_subject TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT,
        redeemed_at TEXT,
        redeemed_by TEXT,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_invitation_workspace
        ON invitation(workspace_id)`,
    ],
  },
  {
    // Candidate admission gate (DAT-234): the record of every validation
    // decision and every retirement candidate a contradiction produced.
    //
    // Both tables are purely additive — no existing table is rebuilt, so the
    // migration is safe to run against a populated database. Like
    // `memory_events`, they carry plain scope IDs without foreign keys: the
    // record of a decision must outlive the item it describes, and it must
    // survive workspace erasure the same way the rest of the audit trail does.
    //
    // Every column here holds an opaque id, a fixed enum, a one-way content
    // digest, or a count. Candidate statements, matched lint text, and
    // free-text reasons are never persisted — the reason code is the reason.
    //
    // Numbering: DAT-247 took v5 and DAT-204 took v6 on main before this
    // branch merged, so this block is v7 rather than colliding with them.
    // Renumbering an unmerged block costs nothing; a merged one is never
    // touched. It stays purely additive, so it is safe on a database that has
    // already applied v6.
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_admission_decisions (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        candidate_hash TEXT NOT NULL,
        item_id TEXT,
        item_version INTEGER,
        disposition TEXT NOT NULL CHECK (
          disposition IN ('admitted', 'held', 'discarded', 'merged')
        ),
        reason_codes TEXT NOT NULL,
        check_results TEXT NOT NULL,
        duplicate_of_item_id TEXT,
        contradicts_item_ids TEXT NOT NULL,
        retrieval_eligible INTEGER NOT NULL CHECK (retrieval_eligible IN (0, 1)),
        factual_injection_allowed INTEGER NOT NULL CHECK (factual_injection_allowed IN (0, 1)),
        run_id TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_admission_decisions_scope
        ON memory_admission_decisions(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_admission_decisions_item
        ON memory_admission_decisions(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_admission_decisions_hash
        ON memory_admission_decisions(workspace_id, candidate_hash)`,
      // A contradiction never silently overwrites anything. It produces a
      // proposal to deprecate or supersede one exact item, which a human or
      // the consolidation job accepts or rejects. `status` is that decision.
      `CREATE TABLE IF NOT EXISTS memory_retirement_candidates (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        successor_item_id TEXT,
        proposed_action TEXT NOT NULL CHECK (proposed_action IN ('deprecate', 'supersede')),
        reason_code TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        resolved_at TEXT,
        resolved_by TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      // Idempotency for re-evaluated candidates. `successor_item_id` is NULL
      // for a plain deprecation, and SQLite treats NULLs as distinct in a
      // table-level UNIQUE — so the uniqueness lives in an expression index
      // that folds NULL to ''.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_retirement_candidates_unique
        ON memory_retirement_candidates(
          workspace_id, item_id, proposed_action, decision_id,
          COALESCE(successor_item_id, '')
        )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retirement_candidates_scope
        ON memory_retirement_candidates(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retirement_candidates_item
        ON memory_retirement_candidates(item_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retirement_candidates_status
        ON memory_retirement_candidates(workspace_id, status)`,
    ],
  },
  {
    // Promotion and consolidation lifecycle (DAT-235): per-workspace promotion
    // policy, the record of every promotion assessment, and the auditable
    // report of every scheduled consolidation run and the fixed-vocabulary
    // operations it applied.
    //
    // Numbering: main already took v5 (DAT-247), v6 (DAT-204), and v7
    // (DAT-234's admission gate, renumbered on merge), so this unmerged block
    // is v8 — the next free version, immediately after the admission gate it
    // builds on. Renumbering an unmerged block costs nothing and no merged
    // migration is touched; a duplicate version would silently skip this
    // schema.
    //
    // The policy row is workspace configuration and cascades with the
    // workspace. Decisions and consolidation reports are audit records: like
    // `memory_events` they carry plain scope IDs without foreign keys and
    // outlive the items they describe. Every column here holds an opaque id,
    // a fixed enum, a one-way digest, a count, or a timestamp — never memory
    // statements, provenance payloads, or free-text reasons.
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_promotion_policy (
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        auto_promote_facts INTEGER NOT NULL CHECK (auto_promote_facts IN (0, 1)),
        fact_min_independent_runs INTEGER NOT NULL CHECK (fact_min_independent_runs >= 2),
        require_human_approval_all INTEGER NOT NULL CHECK (require_human_approval_all IN (0, 1)),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (enterprise_id, workspace_id)
      )`,
      `CREATE TABLE IF NOT EXISTS memory_promotion_decisions (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_version INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('fact', 'lesson', 'playbook', 'anti_pattern', 'episode', 'policy')
        ),
        outcome TEXT NOT NULL CHECK (outcome IN ('promoted', 'blocked')),
        reasons TEXT NOT NULL,
        independent_support_runs INTEGER NOT NULL,
        evaluation_delta REAL,
        policy_digest TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_promotion_decisions_scope
        ON memory_promotion_decisions(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_promotion_decisions_item
        ON memory_promotion_decisions(item_id)`,
      `CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        items_scanned INTEGER NOT NULL DEFAULT 0,
        counts_recomputed INTEGER NOT NULL DEFAULT 0,
        ops_applied INTEGER NOT NULL DEFAULT 0,
        ops_skipped INTEGER NOT NULL DEFAULT 0,
        budget_exhausted INTEGER NOT NULL DEFAULT 0 CHECK (budget_exhausted IN (0, 1)),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_scope
        ON memory_consolidation_runs(enterprise_id, workspace_id, started_at)`,
      `CREATE TABLE IF NOT EXISTS memory_consolidation_ops (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        op TEXT NOT NULL CHECK (
          op IN ('merge', 'supersede', 'expire', 'deprecate', 'quarantine')
        ),
        item_id TEXT NOT NULL,
        target_item_id TEXT,
        item_version INTEGER,
        reason_code TEXT NOT NULL CHECK (
          reason_code IN (
            'duplicate_content', 'past_valid_to', 'stale_fact', 'unused_decay',
            'retirement_proposal', 'security_report',
            'item_deleted', 'item_missing', 'status_not_applicable'
          )
        ),
        applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_consolidation_ops_run
        ON memory_consolidation_ops(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_consolidation_ops_scope
        ON memory_consolidation_ops(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_consolidation_ops_item
        ON memory_consolidation_ops(item_id)`,
    ],
  },
  {
    // Bounded memory retrieval (DAT-236). The migration lineage is at v8
    // (DAT-235 promotion and consolidation lifecycle), so this slice takes the
    // next free number, v9.
    //
    // Retrieval policy is versioned and immutable: every run records the exact
    // policy version it used, so a bundle can be reproduced. Retrieval runs,
    // feedback, and evaluation records are append-only audit rows; none of them
    // can mutate memory items, trust classes, or capability grants.
    version: 9,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_retrieval_policies (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        policy TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (workspace_id, version)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retrieval_policies_scope
        ON memory_retrieval_policies(enterprise_id, workspace_id)`,
      // One row per assembled bundle. `injected` is a bounded JSON array of
      // {item_id, item_version, kind, tier, approved} so a run can be audited
      // and replayed against the exact memory it consumed.
      `CREATE TABLE IF NOT EXISTS memory_retrieval_runs (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        bundle_id TEXT NOT NULL,
        run_id TEXT,
        purpose TEXT NOT NULL,
        query TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        memory_version TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        degraded_reason TEXT,
        injected TEXT NOT NULL,
        omitted_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (workspace_id, bundle_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retrieval_runs_scope
        ON memory_retrieval_runs(enterprise_id, workspace_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_retrieval_runs_run
        ON memory_retrieval_runs(workspace_id, run_id)`,
      // Run outcome and per-item usefulness feedback. Append-only and
      // non-authoritative: it never promotes, demotes, or re-weights an item by
      // itself; consolidation consumes it later.
      `CREATE TABLE IF NOT EXISTS memory_feedback (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        bundle_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('accepted', 'merged', 'rejected', 'cancelled', 'failed', 'unknown')
        ),
        details TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_feedback_scope
        ON memory_feedback(enterprise_id, workspace_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_feedback_bundle
        ON memory_feedback(workspace_id, bundle_id)`,
      // Offline replay / canary evaluation results. Recording a result never
      // promotes anything: the RSI approval flow (DAT-238) owns that decision.
      // `holdout` records that the sample came from the hidden holdout; the
      // learning loop can never write evaluation cases through this surface.
      `CREATE TABLE IF NOT EXISTS memory_eval_runs (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('offline_replay', 'canary')),
        dataset_name TEXT NOT NULL,
        sample_size INTEGER NOT NULL CHECK (sample_size > 0),
        holdout INTEGER NOT NULL CHECK (holdout IN (0, 1)),
        policy_version INTEGER NOT NULL,
        memory_version TEXT NOT NULL,
        metrics TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
        notes TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_scope
        ON memory_eval_runs(enterprise_id, workspace_id, created_at)`,
    ],
  },
  {
    // Enterprise templates (DAT-237). Templates are deliberately stored in
    // their own tables, not in `memory_items`: the memory read path can then
    // never return one, and a workspace sees a template only after it adopts
    // it and a local candidate item is written. Publication records keep the
    // source workspace/item for administrator audit and are never read by an
    // adopting workspace. Template events carry metadata only and outlive the
    // rows they describe, like `memory_events`.
    //
    // This slice takes v10, directly after DAT-236's v9; v1-v9 are merged
    // and remain untouched.
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS enterprise_templates (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        status TEXT NOT NULL CHECK (status IN ('published', 'revoked')),
        current_version INTEGER NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_templates_scope
        ON enterprise_templates(enterprise_id, status)`,
      `CREATE TABLE IF NOT EXISTS enterprise_template_versions (
        template_id TEXT NOT NULL REFERENCES enterprise_templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'lesson', 'playbook', 'anti_pattern')),
        scope TEXT NOT NULL,
        statement TEXT NOT NULL,
        preconditions TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK (
          sensitivity IN ('internal', 'confidential', 'restricted')
        ),
        evidence_classes TEXT NOT NULL,
        security_review TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (template_id, version)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_versions_scope
        ON enterprise_template_versions(enterprise_id)`,
      // Administrator-only provenance. No workspace foreign key: the
      // publication record must survive workspace deletion as audit history,
      // and it never travels with a template version.
      `CREATE TABLE IF NOT EXISTS enterprise_template_publications (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        template_id TEXT NOT NULL REFERENCES enterprise_templates(id) ON DELETE CASCADE,
        template_version INTEGER NOT NULL,
        source_workspace_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        source_item_version INTEGER NOT NULL,
        source_evidence_count INTEGER NOT NULL,
        scrub_report TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        FOREIGN KEY (template_id, template_version)
          REFERENCES enterprise_template_versions(template_id, version) ON DELETE CASCADE,
        UNIQUE (enterprise_id, source_workspace_id, source_item_id, source_item_version)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_publications_template
        ON enterprise_template_publications(enterprise_id, template_id)`,
      // Adoption pins one exact template version and one local candidate item.
      // The local memory item itself lives in `memory_items`; this row is the
      // link that revocation follows, and it never stores template content.
      `CREATE TABLE IF NOT EXISTS enterprise_template_adoptions (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        template_id TEXT NOT NULL REFERENCES enterprise_templates(id),
        template_version INTEGER NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        adopted_at TEXT NOT NULL,
        adopted_by TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        revocation_outcome TEXT CHECK (
          revocation_outcome IN (
            'deprecated', 'already_deprecated', 'quarantined_untouched',
            'retired_untouched', 'item_missing', 'deprecation_failed'
          )
        ),
        UNIQUE (workspace_id, template_id, template_version),
        FOREIGN KEY (template_id, template_version)
          REFERENCES enterprise_template_versions(template_id, version)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_adoptions_scope
        ON enterprise_template_adoptions(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_adoptions_template
        ON enterprise_template_adoptions(enterprise_id, template_id)`,
      `CREATE TABLE IF NOT EXISTS enterprise_template_events (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL,
        workspace_id TEXT,
        template_id TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'template_published', 'template_version_published', 'template_revoked',
            'template_adopted', 'adoption_deprecated', 'adoption_revocation_skipped'
          )
        ),
        actor_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_events_scope
        ON enterprise_template_events(enterprise_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_enterprise_template_events_template
        ON enterprise_template_events(enterprise_id, template_id)`,

  {
    // Bounded recursive self-improvement (DAT-238). This slice takes v11,
    // directly after DAT-237's v10; v1-v10 are merged and remain untouched.
    //
    // Proposals are immutable records of a candidate artifact; evaluations,
    // approvals, rollout observations, and run pins are append-only. The
    // golden and holdout case tables are the *only* evaluation-case storage,
    // and they are deliberately separate: nothing in the retrieval, feedback,
    // or evaluation-record surface can read a holdout case. Every table is
    // workspace-scoped with the same composite predicates as the memory store,
    // so a foreign workspace's row is indistinguishable from a missing one.
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS rsi_controls (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
        kill_switch_reason TEXT,
        kill_switch_changed_at TEXT,
        kill_switch_changed_by TEXT,
        auto_promote_low_risk INTEGER NOT NULL DEFAULT 0
          CHECK (auto_promote_low_risk IN (0, 1)),
        weekly_change_budget INTEGER NOT NULL DEFAULT 3
          CHECK (weekly_change_budget >= 0),
        weekly_reflection_token_budget INTEGER NOT NULL DEFAULT 200000
          CHECK (weekly_reflection_token_budget >= 0),
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rsi_control_events (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('kill_switch', 'controls_updated')),
        enabled INTEGER,
        reason TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_control_events_scope
        ON rsi_control_events(workspace_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS rsi_budget_usage (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        week_start TEXT NOT NULL,
        changes_promoted INTEGER NOT NULL DEFAULT 0 CHECK (changes_promoted >= 0),
        reflection_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reflection_tokens >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, week_start)
      )`,
      `CREATE TABLE IF NOT EXISTS rsi_proposals (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        diff TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('A', 'B', 'C', 'D')),
        artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('retrieval_policy', 'memory_item')),
        baseline_policy_version INTEGER NOT NULL,
        baseline_memory_version TEXT NOT NULL,
        candidate_policy TEXT,
        candidate_policy_hash TEXT,
        candidate_item_id TEXT,
        candidate_item_version INTEGER,
        proposer_id TEXT NOT NULL,
        proposer_kind TEXT NOT NULL CHECK (proposer_kind IN ('agent', 'human')),
        proposer_model TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('proposed', 'awaiting_approval', 'ready', 'canary', 'promoted', 'rolled_back', 'blocked')
        ),
        status_reason TEXT,
        applied_policy_version INTEGER,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_proposals_scope
        ON rsi_proposals(enterprise_id, workspace_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_proposals_status
        ON rsi_proposals(workspace_id, status)`,
      `CREATE TABLE IF NOT EXISTS rsi_evaluations (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES rsi_proposals(id) ON DELETE CASCADE,
        proposal_version INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('offline_replay', 'canary')),
        dataset TEXT NOT NULL CHECK (dataset IN ('golden', 'holdout')),
        holdout_used INTEGER NOT NULL CHECK (holdout_used IN (0, 1)),
        sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
        baseline_successes INTEGER NOT NULL CHECK (baseline_successes >= 0),
        candidate_successes INTEGER NOT NULL CHECK (candidate_successes >= 0),
        baseline_rework INTEGER NOT NULL CHECK (baseline_rework >= 0),
        candidate_rework INTEGER NOT NULL CHECK (candidate_rework >= 0),
        baseline_cost REAL NOT NULL CHECK (baseline_cost >= 0),
        candidate_cost REAL NOT NULL CHECK (candidate_cost >= 0),
        safety_events INTEGER NOT NULL CHECK (safety_events >= 0),
        success_delta REAL NOT NULL,
        delta_ci_low REAL NOT NULL,
        delta_ci_high REAL NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
        verifier_kind TEXT NOT NULL,
        verifier_id TEXT NOT NULL,
        verifier_reference TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        memory_version TEXT NOT NULL,
        reflection_tokens INTEGER NOT NULL CHECK (reflection_tokens >= 0),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_evaluations_proposal
        ON rsi_evaluations(workspace_id, proposal_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS rsi_approvals (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES rsi_proposals(id) ON DELETE CASCADE,
        proposal_version INTEGER NOT NULL,
        approval_key TEXT NOT NULL CHECK (approval_key IN ('single', 'owner', 'reviewer')),
        approver_id TEXT NOT NULL,
        role TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (proposal_id, approver_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_approvals_proposal
        ON rsi_approvals(workspace_id, proposal_id)`,
      `CREATE TABLE IF NOT EXISTS rsi_rollouts (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES rsi_proposals(id) ON DELETE CASCADE,
        stage INTEGER NOT NULL CHECK (stage IN (10, 50, 100)),
        status TEXT NOT NULL CHECK (status IN ('canary', 'promoted', 'rolled_back')),
        baseline_policy_version INTEGER NOT NULL,
        candidate_policy TEXT,
        candidate_policy_hash TEXT NOT NULL,
        reason TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_rollouts_scope
        ON rsi_rollouts(enterprise_id, workspace_id, status)`,
      `CREATE TABLE IF NOT EXISTS rsi_canary_observations (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        rollout_id TEXT NOT NULL REFERENCES rsi_rollouts(id) ON DELETE CASCADE,
        stage INTEGER NOT NULL,
        sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
        baseline_successes INTEGER NOT NULL CHECK (baseline_successes >= 0),
        candidate_successes INTEGER NOT NULL CHECK (candidate_successes >= 0),
        baseline_rework INTEGER NOT NULL CHECK (baseline_rework >= 0),
        candidate_rework INTEGER NOT NULL CHECK (candidate_rework >= 0),
        baseline_cost REAL NOT NULL CHECK (baseline_cost >= 0),
        candidate_cost REAL NOT NULL CHECK (candidate_cost >= 0),
        safety_events INTEGER NOT NULL CHECK (safety_events >= 0),
        success_delta REAL NOT NULL,
        delta_ci_low REAL NOT NULL,
        delta_ci_high REAL NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
        evidence_reference TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_canary_observations_rollout
        ON rsi_canary_observations(workspace_id, rollout_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS rsi_golden_cases (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        case_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (workspace_id, case_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_golden_cases_scope
        ON rsi_golden_cases(workspace_id)`,
      `CREATE TABLE IF NOT EXISTS rsi_holdout_cases (
        id TEXT PRIMARY KEY,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        case_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (workspace_id, case_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_holdout_cases_scope
        ON rsi_holdout_cases(workspace_id)`,
      `CREATE TABLE IF NOT EXISTS rsi_run_pins (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
        run_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        memory_version TEXT NOT NULL,
        canary INTEGER NOT NULL CHECK (canary IN (0, 1)),
        proposal_id TEXT,
        rollout_id TEXT,
        stage INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, run_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rsi_run_pins_scope
        ON rsi_run_pins(enterprise_id, workspace_id, created_at)`,
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
export function migrate(db: ControlPlaneDb, options: { upTo?: number } = {}): void {
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
    if (options.upTo !== undefined && migration.version > options.upTo) {
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
