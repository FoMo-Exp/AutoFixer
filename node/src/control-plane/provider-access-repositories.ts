/**
 * Provider access repositories (DAT-203): service integrations, normalized
 * roster rows, subject authority, capability grants, provider events, and
 * reconciliation runs.
 *
 * Same conventions as the scoped control-plane repositories: every read and
 * write embeds an explicit {@link EnterpriseScope} or {@link WorkspaceScope},
 * handlers never write SQL, and records outside the caller's scope are
 * indistinguishable from missing ones. Credential values never appear in any
 * entity — integrations store credential references only.
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso } from "./db.js";
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from "./errors.js";
import type {
  AppendProviderEventInput,
  AuthorityState,
  CapabilityGrant,
  CapabilityKind,
  CreateCapabilityGrantInput,
  CreateServiceIntegrationInput,
  FinishReconcileRunInput,
  ProviderEvent,
  ProviderEventType,
  ProviderMemberRole,
  ProviderRoleSourceKind,
  ReconcileRun,
  ReconcileRunStatus,
  RenameIntegrationInput,
  ReplaceRosterInput,
  ServiceIntegration,
  ServiceIntegrationId,
  SetInstallStatusInput,
  StartReconcileRunInput,
  SubjectAuthority,
  TransferIntegrationInput,
} from "./provider-access-types.js";
import type { EnterpriseScope, UserId, WorkspaceScope } from "./types.js";

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface ServiceIntegrationRepository {
  create(scope: WorkspaceScope, input: CreateServiceIntegrationInput): ServiceIntegration;
  getById(scope: WorkspaceScope, id: ServiceIntegrationId): ServiceIntegration | undefined;
  /** The active integration bound to a repository within the scope's enterprise. */
  getByRepository(scope: EnterpriseScope, repositoryId: string): ServiceIntegration | undefined;
  listByWorkspace(scope: WorkspaceScope): ServiceIntegration[];
  /** Rename is metadata only: authority and credentials are untouched. */
  rename(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: RenameIntegrationInput,
    expectedVersion: number,
  ): ServiceIntegration;
  /**
   * Rebind after a repository transfer. Never expands credentials and never
   * changes the enterprise: authority must be revalidated separately and is
   * reset to `unknown` by the caller.
   */
  transfer(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: TransferIntegrationInput,
    expectedVersion: number,
  ): ServiceIntegration;
  setStatus(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: SetInstallStatusInput,
    expectedVersion: number,
  ): ServiceIntegration;
}

export interface ProviderRosterRepository {
  /**
   * Atomically replace the roster snapshot of one integration and (re)verify
   * the authority of every subject present. Subjects previously recorded but
   * absent from `input.roles` keep their rows untouched — absence from a
   * partial snapshot is never treated as removal; removal detection belongs
   * to the reconcile diff, which only runs on complete rosters.
   */
  applySnapshot(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: ReplaceRosterInput,
  ): {
    roles: ProviderMemberRole[];
    authority: SubjectAuthority[];
    added: number;
    changed: number;
  };
  listRoles(scope: WorkspaceScope, integrationId: ServiceIntegrationId): ProviderMemberRole[];
  getAuthority(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
  ): SubjectAuthority | undefined;
  listAuthority(scope: WorkspaceScope, integrationId: ServiceIntegrationId): SubjectAuthority[];
  /** Explicit state transition (e.g. stale, removed) recorded on the authority row. */
  setAuthorityState(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
    state: AuthorityState,
    at: string,
    userId?: UserId | null,
  ): SubjectAuthority;
  /** Bind the app user for a provider subject (identity linking at sync time). */
  bindUser(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
    userId: UserId,
    at: string,
  ): SubjectAuthority;
  /** Reset every subject to `unknown` (repository transfer). Returns the count. */
  resetAuthority(scope: WorkspaceScope, integrationId: ServiceIntegrationId, at: string): number;
  /** Drop roster rows and authority of one subject (member removal). */
  removeSubject(scope: WorkspaceScope, integrationId: ServiceIntegrationId, subject: string): void;
}

export interface CapabilityGrantRepository {
  grant(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: CreateCapabilityGrantInput,
  ): CapabilityGrant;
  getById(scope: WorkspaceScope, id: string): CapabilityGrant | undefined;
  /** Live = not revoked and not expired at `now`. */
  listLive(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    filter: { grantee_user_id?: UserId | null; capability?: CapabilityKind; now: string },
  ): CapabilityGrant[];
  revoke(scope: WorkspaceScope, id: string, reason: string, at: string): CapabilityGrant;
  /** Revoke every live grant matching a grantee (authority loss). Returns count. */
  revokeForGrantee(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    granteeUserId: UserId,
    reason: string,
    at: string,
  ): number;
}

export interface ProviderEventRepository {
  /**
   * Append a provider event. Idempotent on (provider instance, delivery id):
   * a replayed delivery returns the stored row with `duplicate: true` and
   * applies nothing.
   */
  append(
    scope: EnterpriseScope,
    input: AppendProviderEventInput,
  ): { event: ProviderEvent; duplicate: false } | { event: ProviderEvent; duplicate: true };
  list(
    scope: EnterpriseScope,
    filter: {
      integration_id?: ServiceIntegrationId;
      repository_id?: string;
      event_type?: ProviderEventType;
    },
  ): ProviderEvent[];
  markProcessed(scope: EnterpriseScope, id: string, at: string): void;
}

export interface ReconcileRunRepository {
  start(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: StartReconcileRunInput,
  ): ReconcileRun;
  finish(scope: WorkspaceScope, id: string, input: FinishReconcileRunInput): ReconcileRun;
  list(scope: WorkspaceScope, integrationId: ServiceIntegrationId, limit?: number): ReconcileRun[];
}

export interface ProviderAccessRepositories {
  integrations: ServiceIntegrationRepository;
  roster: ProviderRosterRepository;
  grants: CapabilityGrantRepository;
  events: ProviderEventRepository;
  reconcileRuns: ReconcileRunRepository;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface IntegrationRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  provider_instance_id: string;
  repository_id: string;
  repository_name: string;
  install_status: string;
  source_credential_ref: string;
  checkout_credential_ref: string | null;
  delivery_credential_ref: string | null;
  permission_visibility: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toIntegration(row: IntegrationRow): ServiceIntegration {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    provider_instance_id: row.provider_instance_id,
    repository_id: row.repository_id,
    repository_name: row.repository_name,
    install_status: row.install_status as ServiceIntegration["install_status"],
    source_credential_ref: row.source_credential_ref,
    checkout_credential_ref: row.checkout_credential_ref,
    delivery_credential_ref: row.delivery_credential_ref,
    permission_visibility: row.permission_visibility as ServiceIntegration["permission_visibility"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface RoleRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  integration_id: string;
  subject: string;
  login: string;
  source_kind: string;
  provider_role: string;
  authority_ref: string;
  inherited_from: string | null;
  observed_at: string;
  last_verified_at: string;
}

function toRole(row: RoleRow): ProviderMemberRole {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    subject: row.subject,
    login: row.login,
    source_kind: row.source_kind as ProviderRoleSourceKind,
    provider_role: row.provider_role,
    authority_ref: row.authority_ref,
    inherited_from: row.inherited_from,
    observed_at: row.observed_at,
    last_verified_at: row.last_verified_at,
  };
}

interface AuthorityRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  integration_id: string;
  subject: string;
  user_id: string | null;
  state: string;
  last_verified_at: string | null;
  updated_at: string;
}

function toAuthority(row: AuthorityRow): SubjectAuthority {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    subject: row.subject,
    user_id: row.user_id,
    state: row.state as AuthorityState,
    last_verified_at: row.last_verified_at,
    updated_at: row.updated_at,
  };
}

interface GrantRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  integration_id: string;
  grantee_user_id: string | null;
  capability: string;
  branch_scope: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

function toGrant(row: GrantRow): CapabilityGrant {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    grantee_user_id: row.grantee_user_id,
    capability: row.capability as CapabilityKind,
    branch_scope: row.branch_scope,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

interface EventRow {
  id: string;
  enterprise_id: string;
  provider_instance_id: string;
  integration_id: string | null;
  repository_id: string | null;
  event_type: string;
  payload: string;
  delivery_id: string | null;
  received_at: string;
  processed_at: string | null;
}

function toEvent(row: EventRow): ProviderEvent {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    provider_instance_id: row.provider_instance_id,
    integration_id: row.integration_id,
    repository_id: row.repository_id,
    event_type: row.event_type as ProviderEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    delivery_id: row.delivery_id,
    received_at: row.received_at,
    processed_at: row.processed_at,
  };
}

interface RunRow {
  id: string;
  enterprise_id: string;
  integration_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  pages_seen: number;
  roster_size: number;
  members_added: number;
  members_removed: number;
  roles_changed: number;
  authority_reset: number;
  failure_code: string | null;
}

function toRun(row: RunRow): ReconcileRun {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    integration_id: row.integration_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status as ReconcileRunStatus,
    pages_seen: row.pages_seen,
    roster_size: row.roster_size,
    members_added: row.members_added,
    members_removed: row.members_removed,
    roles_changed: row.roles_changed,
    authority_reset: row.authority_reset,
    failure_code: row.failure_code,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireRow<T>(entity: string, id: string, row: T | undefined | null): T {
  if (row === undefined || row === null) {
    throw new NotFoundError(entity, id);
  }
  return row;
}

function requireVersionMatch(
  entity: string,
  id: string,
  result: { changes: number | bigint },
  expectedVersion: number,
  db: ControlPlaneDb,
  table: string,
): void {
  if (result.changes === 0) {
    const row = db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as
      { version: number } | undefined;
    const actual = row?.version ?? -1;
    if (actual === -1) {
      throw new NotFoundError(entity, id);
    }
    throw new VersionConflictError(entity, id, expectedVersion, actual);
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

class SqliteServiceIntegrationRepository implements ServiceIntegrationRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: WorkspaceScope, input: CreateServiceIntegrationInput): ServiceIntegration {
    if (!input.repository_id || !input.source_credential_ref) {
      throw new ValidationError("repository_id and source_credential_ref are required");
    }
    const id = newId("sint");
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO service_integration (
             id, enterprise_id, workspace_id, provider_instance_id, repository_id,
             repository_name, install_status, source_credential_ref,
             checkout_credential_ref, delivery_credential_ref, permission_visibility,
             created_at, updated_at, created_by, updated_by, version
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          input.provider_instance_id,
          input.repository_id,
          input.repository_name,
          input.source_credential_ref,
          input.checkout_credential_ref ?? null,
          input.delivery_credential_ref ?? null,
          input.permission_visibility,
          now,
          now,
          input.actor_id,
          input.actor_id,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(
          `repository ${input.repository_id} already has an active service integration`,
          { repository_id: input.repository_id },
        );
      }
      throw error;
    }
    return requireRow("ServiceIntegration", id, this.getById(scope, id));
  }

  getById(scope: WorkspaceScope, id: ServiceIntegrationId): ServiceIntegration | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM service_integration
         WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(id, scope.enterprise_id, scope.workspace_id) as IntegrationRow | undefined;
    return row ? toIntegration(row) : undefined;
  }

  getByRepository(scope: EnterpriseScope, repositoryId: string): ServiceIntegration | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM service_integration
         WHERE enterprise_id = ? AND repository_id = ? AND install_status != 'uninstalled'`,
      )
      .get(scope.enterprise_id, repositoryId) as IntegrationRow | undefined;
    return row ? toIntegration(row) : undefined;
  }

  listByWorkspace(scope: WorkspaceScope): ServiceIntegration[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM service_integration
         WHERE enterprise_id = ? AND workspace_id = ?
         ORDER BY created_at`,
      )
      .all(scope.enterprise_id, scope.workspace_id) as unknown as IntegrationRow[];
    return rows.map(toIntegration);
  }

  rename(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: RenameIntegrationInput,
    expectedVersion: number,
  ): ServiceIntegration {
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE service_integration
         SET repository_name = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(
        input.repository_name,
        now,
        input.actor_id,
        id,
        scope.enterprise_id,
        scope.workspace_id,
        expectedVersion,
      );
    requireVersionMatch(
      "ServiceIntegration",
      id,
      result,
      expectedVersion,
      this.db,
      "service_integration",
    );
    return requireRow("ServiceIntegration", id, this.getById(scope, id));
  }

  transfer(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: TransferIntegrationInput,
    expectedVersion: number,
  ): ServiceIntegration {
    // Transfer rebinds the repository identifier only. Credential refs are
    // deliberately not part of this UPDATE: a transfer must never expand or
    // replace credentials — that requires a separate, audited installation.
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE service_integration
         SET repository_id = ?, repository_name = ?, provider_instance_id = ?,
             updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(
        input.repository_id,
        input.repository_name,
        input.provider_instance_id,
        now,
        input.actor_id,
        id,
        scope.enterprise_id,
        scope.workspace_id,
        expectedVersion,
      );
    requireVersionMatch(
      "ServiceIntegration",
      id,
      result,
      expectedVersion,
      this.db,
      "service_integration",
    );
    return requireRow("ServiceIntegration", id, this.getById(scope, id));
  }

  setStatus(
    scope: WorkspaceScope,
    id: ServiceIntegrationId,
    input: SetInstallStatusInput,
    expectedVersion: number,
  ): ServiceIntegration {
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE service_integration
         SET install_status = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(
        input.install_status,
        now,
        input.actor_id,
        id,
        scope.enterprise_id,
        scope.workspace_id,
        expectedVersion,
      );
    requireVersionMatch(
      "ServiceIntegration",
      id,
      result,
      expectedVersion,
      this.db,
      "service_integration",
    );
    return requireRow("ServiceIntegration", id, this.getById(scope, id));
  }
}

class SqliteProviderRosterRepository implements ProviderRosterRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  applySnapshot(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: ReplaceRosterInput,
  ): {
    roles: ProviderMemberRole[];
    authority: SubjectAuthority[];
    added: number;
    changed: number;
  } {
    const integration = this.db
      .prepare(
        `SELECT id FROM service_integration WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(integrationId, scope.enterprise_id, scope.workspace_id) as { id: string } | undefined;
    if (!integration) {
      throw new NotFoundError("ServiceIntegration", integrationId);
    }

    let added = 0;
    let changed = 0;
    this.db.exec("BEGIN");
    try {
      for (const role of input.roles) {
        const existing = this.db
          .prepare(
            `SELECT * FROM provider_member_role
             WHERE integration_id = ? AND subject = ? AND source_kind = ? AND authority_ref = ?`,
          )
          .get(integrationId, role.subject, role.source_kind, role.authority_ref) as
          RoleRow | undefined;
        if (!existing) {
          added += 1;
          this.db
            .prepare(
              `INSERT INTO provider_member_role (
                 id, enterprise_id, workspace_id, integration_id, subject, login,
                 source_kind, provider_role, authority_ref, inherited_from,
                 observed_at, last_verified_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              newId("prole"),
              scope.enterprise_id,
              scope.workspace_id,
              integrationId,
              role.subject,
              role.login,
              role.source_kind,
              role.provider_role,
              role.authority_ref,
              role.inherited_from,
              input.verified_at,
              input.verified_at,
            );
        } else if (existing.provider_role !== role.provider_role || existing.login !== role.login) {
          changed += 1;
          this.db
            .prepare(
              `UPDATE provider_member_role
               SET provider_role = ?, login = ?, observed_at = ?, last_verified_at = ?
               WHERE id = ?`,
            )
            .run(role.provider_role, role.login, input.verified_at, input.verified_at, existing.id);
        } else {
          this.db
            .prepare(
              `UPDATE provider_member_role SET observed_at = ?, last_verified_at = ? WHERE id = ?`,
            )
            .run(input.verified_at, input.verified_at, existing.id);
        }

        // (Re)verify authority for every subject present in the snapshot.
        const authority = this.db
          .prepare(`SELECT * FROM subject_authority WHERE integration_id = ? AND subject = ?`)
          .get(integrationId, role.subject) as AuthorityRow | undefined;
        const userId = input.subject_users?.[role.subject] ?? authority?.user_id ?? null;
        if (!authority) {
          this.db
            .prepare(
              `INSERT INTO subject_authority (
                 id, enterprise_id, workspace_id, integration_id, subject, user_id,
                 state, last_verified_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            )
            .run(
              newId("auth"),
              scope.enterprise_id,
              scope.workspace_id,
              integrationId,
              role.subject,
              userId,
              input.verified_at,
              input.verified_at,
            );
        } else {
          this.db
            .prepare(
              `UPDATE subject_authority
               SET state = 'active', last_verified_at = ?, updated_at = ?, user_id = ?
               WHERE id = ?`,
            )
            .run(input.verified_at, input.verified_at, userId, authority.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      roles: this.listRoles(scope, integrationId),
      authority: this.listAuthority(scope, integrationId),
      added,
      changed,
    };
  }

  listRoles(scope: WorkspaceScope, integrationId: ServiceIntegrationId): ProviderMemberRole[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_member_role
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ?
         ORDER BY subject, source_kind, authority_ref`,
      )
      .all(scope.enterprise_id, scope.workspace_id, integrationId) as unknown as RoleRow[];
    return rows.map(toRole);
  }

  getAuthority(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
  ): SubjectAuthority | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM subject_authority
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ? AND subject = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, integrationId, subject) as
      AuthorityRow | undefined;
    return row ? toAuthority(row) : undefined;
  }

  listAuthority(scope: WorkspaceScope, integrationId: ServiceIntegrationId): SubjectAuthority[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM subject_authority
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ?
         ORDER BY subject`,
      )
      .all(scope.enterprise_id, scope.workspace_id, integrationId) as unknown as AuthorityRow[];
    return rows.map(toAuthority);
  }

  setAuthorityState(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
    state: AuthorityState,
    at: string,
    userId?: UserId | null,
  ): SubjectAuthority {
    const existing = this.db
      .prepare(
        `SELECT * FROM subject_authority
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ? AND subject = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, integrationId, subject) as
      AuthorityRow | undefined;
    if (!existing) {
      const id = newId("auth");
      this.db
        .prepare(
          `INSERT INTO subject_authority (
             id, enterprise_id, workspace_id, integration_id, subject, user_id,
             state, last_verified_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          integrationId,
          subject,
          userId ?? null,
          state,
          state === "active" ? at : null,
          at,
        );
      return requireRow("SubjectAuthority", id, this.getAuthority(scope, integrationId, subject));
    }
    this.db
      .prepare(
        `UPDATE subject_authority
         SET state = ?, updated_at = ?, user_id = COALESCE(?, user_id),
             last_verified_at = CASE WHEN ? = 'active' THEN ? ELSE last_verified_at END
         WHERE id = ?`,
      )
      .run(state, at, userId ?? null, state, at, existing.id);
    return requireRow(
      "SubjectAuthority",
      existing.id,
      this.getAuthority(scope, integrationId, subject),
    );
  }

  bindUser(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    subject: string,
    userId: UserId,
    at: string,
  ): SubjectAuthority {
    const existing = requireRow(
      "SubjectAuthority",
      subject,
      this.getAuthority(scope, integrationId, subject),
    );
    this.db
      .prepare(`UPDATE subject_authority SET user_id = ?, updated_at = ? WHERE id = ?`)
      .run(userId, at, existing.id);
    return requireRow(
      "SubjectAuthority",
      existing.id,
      this.getAuthority(scope, integrationId, subject),
    );
  }

  resetAuthority(scope: WorkspaceScope, integrationId: ServiceIntegrationId, at: string): number {
    const result = this.db
      .prepare(
        `UPDATE subject_authority
         SET state = 'unknown', updated_at = ?
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ? AND state != 'removed'`,
      )
      .run(at, scope.enterprise_id, scope.workspace_id, integrationId);
    return Number(result.changes);
  }

  removeSubject(scope: WorkspaceScope, integrationId: ServiceIntegrationId, subject: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `DELETE FROM provider_member_role
           WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ? AND subject = ?`,
        )
        .run(scope.enterprise_id, scope.workspace_id, integrationId, subject);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteCapabilityGrantRepository implements CapabilityGrantRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  grant(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: CreateCapabilityGrantInput,
  ): CapabilityGrant {
    const integration = this.db
      .prepare(
        `SELECT id FROM service_integration WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(integrationId, scope.enterprise_id, scope.workspace_id) as { id: string } | undefined;
    if (!integration) {
      throw new NotFoundError("ServiceIntegration", integrationId);
    }
    const id = newId("cgr");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO capability_grant (
           id, enterprise_id, workspace_id, integration_id, grantee_user_id,
           capability, branch_scope, expires_at, created_at, updated_at, created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        integrationId,
        input.grantee_user_id,
        input.capability,
        input.branch_scope ?? null,
        input.expires_at,
        now,
        now,
        input.actor_id,
        input.actor_id,
      );
    return requireRow("CapabilityGrant", id, this.getById(scope, id));
  }

  getById(scope: WorkspaceScope, id: string): CapabilityGrant | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM capability_grant WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(id, scope.enterprise_id, scope.workspace_id) as GrantRow | undefined;
    return row ? toGrant(row) : undefined;
  }

  listLive(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    filter: { grantee_user_id?: UserId | null; capability?: CapabilityKind; now: string },
  ): CapabilityGrant[] {
    const clauses = [
      "enterprise_id = ?",
      "workspace_id = ?",
      "integration_id = ?",
      "revoked_at IS NULL",
      "expires_at > ?",
    ];
    const params: unknown[] = [scope.enterprise_id, scope.workspace_id, integrationId, filter.now];
    if (filter.grantee_user_id !== undefined) {
      if (filter.grantee_user_id === null) {
        clauses.push("grantee_user_id IS NULL");
      } else {
        clauses.push("grantee_user_id = ?");
        params.push(filter.grantee_user_id);
      }
    }
    if (filter.capability) {
      clauses.push("capability = ?");
      params.push(filter.capability);
    }
    const rows = this.db
      .prepare(`SELECT * FROM capability_grant WHERE ${clauses.join(" AND ")} ORDER BY created_at`)
      .all(...(params as never[])) as unknown as GrantRow[];
    return rows.map(toGrant);
  }

  revoke(scope: WorkspaceScope, id: string, reason: string, at: string): CapabilityGrant {
    const existing = requireRow("CapabilityGrant", id, this.getById(scope, id));
    if (existing.revoked_at) {
      return existing;
    }
    this.db
      .prepare(
        `UPDATE capability_grant SET revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(at, reason, at, id);
    return requireRow("CapabilityGrant", id, this.getById(scope, id));
  }

  revokeForGrantee(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    granteeUserId: UserId,
    reason: string,
    at: string,
  ): number {
    const result = this.db
      .prepare(
        `UPDATE capability_grant
         SET revoked_at = ?, revoked_reason = ?, updated_at = ?
         WHERE enterprise_id = ? AND workspace_id = ? AND integration_id = ?
           AND grantee_user_id = ? AND revoked_at IS NULL`,
      )
      .run(at, reason, at, scope.enterprise_id, scope.workspace_id, integrationId, granteeUserId);
    return Number(result.changes);
  }
}

class SqliteProviderEventRepository implements ProviderEventRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  append(
    scope: EnterpriseScope,
    input: AppendProviderEventInput,
  ): { event: ProviderEvent; duplicate: false } | { event: ProviderEvent; duplicate: true } {
    if (input.delivery_id) {
      const existing = this.db
        .prepare(`SELECT * FROM provider_event WHERE provider_instance_id = ? AND delivery_id = ?`)
        .get(input.provider_instance_id, input.delivery_id) as EventRow | undefined;
      if (existing) {
        return { event: toEvent(existing), duplicate: true };
      }
    }
    const id = newId("pev");
    try {
      this.db
        .prepare(
          `INSERT INTO provider_event (
             id, enterprise_id, provider_instance_id, integration_id, repository_id,
             event_type, payload, delivery_id, received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope.enterprise_id,
          input.provider_instance_id,
          input.integration_id ?? null,
          input.repository_id ?? null,
          input.event_type,
          JSON.stringify(input.payload ?? {}),
          input.delivery_id ?? null,
          input.received_at,
        );
    } catch (error) {
      // Unique (provider_instance_id, delivery_id) race: the concurrent
      // delivery wins; return its row as a duplicate.
      if (input.delivery_id && String(error).includes("UNIQUE")) {
        const existing = this.db
          .prepare(
            `SELECT * FROM provider_event WHERE provider_instance_id = ? AND delivery_id = ?`,
          )
          .get(input.provider_instance_id, input.delivery_id) as EventRow | undefined;
        if (existing) {
          return { event: toEvent(existing), duplicate: true };
        }
      }
      throw error;
    }
    return {
      event: toEvent(
        requireRow(
          "ProviderEvent",
          id,
          this.db.prepare(`SELECT * FROM provider_event WHERE id = ?`).get(id) as
            EventRow | undefined,
        ),
      ),
      duplicate: false,
    };
  }

  list(
    scope: EnterpriseScope,
    filter: {
      integration_id?: ServiceIntegrationId;
      repository_id?: string;
      event_type?: ProviderEventType;
    },
  ): ProviderEvent[] {
    const clauses = ["enterprise_id = ?"];
    const params: unknown[] = [scope.enterprise_id];
    if (filter.integration_id) {
      clauses.push("integration_id = ?");
      params.push(filter.integration_id);
    }
    if (filter.repository_id) {
      clauses.push("repository_id = ?");
      params.push(filter.repository_id);
    }
    if (filter.event_type) {
      clauses.push("event_type = ?");
      params.push(filter.event_type);
    }
    const rows = this.db
      .prepare(`SELECT * FROM provider_event WHERE ${clauses.join(" AND ")} ORDER BY received_at`)
      .all(...(params as never[])) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  markProcessed(scope: EnterpriseScope, id: string, at: string): void {
    this.db
      .prepare(`UPDATE provider_event SET processed_at = ? WHERE id = ? AND enterprise_id = ?`)
      .run(at, id, scope.enterprise_id);
  }
}

class SqliteReconcileRunRepository implements ReconcileRunRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  start(
    scope: WorkspaceScope,
    integrationId: ServiceIntegrationId,
    input: StartReconcileRunInput,
  ): ReconcileRun {
    const integration = this.db
      .prepare(
        `SELECT id FROM service_integration WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(integrationId, scope.enterprise_id, scope.workspace_id) as { id: string } | undefined;
    if (!integration) {
      throw new NotFoundError("ServiceIntegration", integrationId);
    }
    const id = newId("rrun");
    this.db
      .prepare(
        `INSERT INTO reconcile_run (id, enterprise_id, integration_id, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(id, scope.enterprise_id, integrationId, input.started_at);
    return requireRow("ReconcileRun", id, this.getById(scope, id));
  }

  private getById(scope: WorkspaceScope, id: string): ReconcileRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM reconcile_run WHERE id = ? AND enterprise_id = ? AND integration_id IN (
        SELECT id FROM service_integration WHERE workspace_id = ?)`,
      )
      .get(id, scope.enterprise_id, scope.workspace_id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  finish(scope: WorkspaceScope, id: string, input: FinishReconcileRunInput): ReconcileRun {
    requireRow("ReconcileRun", id, this.getById(scope, id));
    this.db
      .prepare(
        `UPDATE reconcile_run
         SET status = ?, pages_seen = ?, roster_size = ?, members_added = ?,
             members_removed = ?, roles_changed = ?, authority_reset = ?,
             failure_code = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.pages_seen,
        input.roster_size,
        input.members_added ?? 0,
        input.members_removed ?? 0,
        input.roles_changed ?? 0,
        input.authority_reset ?? 0,
        input.failure_code ?? null,
        input.finished_at,
        id,
      );
    return requireRow("ReconcileRun", id, this.getById(scope, id));
  }

  list(scope: WorkspaceScope, integrationId: ServiceIntegrationId, limit = 20): ReconcileRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reconcile_run
         WHERE enterprise_id = ? AND integration_id = ?
           AND integration_id IN (SELECT id FROM service_integration WHERE workspace_id = ?)
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(scope.enterprise_id, integrationId, scope.workspace_id, limit) as unknown as RunRow[];
    return rows.map(toRun);
  }
}

/**
 * Build the provider access repositories over one control-plane database.
 */
export function createProviderAccessRepositories(db: ControlPlaneDb): ProviderAccessRepositories {
  return {
    integrations: new SqliteServiceIntegrationRepository(db),
    roster: new SqliteProviderRosterRepository(db),
    grants: new SqliteCapabilityGrantRepository(db),
    events: new SqliteProviderEventRepository(db),
    reconcileRuns: new SqliteReconcileRunRepository(db),
  };
}
