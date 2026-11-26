/**
 * Scoped control-plane repositories.
 *
 * Every method takes an explicit {@link EnterpriseScope} or
 * {@link WorkspaceScope} derived from authenticated membership — never from a
 * client-supplied identifier. The SQL queries embed the scope filter, so a
 * record outside the caller's scope is indistinguishable from a missing one.
 *
 * Handlers consume these interfaces and never write SQL directly.
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso, runInTransaction } from "./db.js";
import {
  ConflictError,
  LastOwnerError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from "./errors.js";
import {
  bumpRepositorySetVersion,
  insertPrimaryWorkspaceBinding,
  replacePrimaryWorkspaceBinding,
  repositorySetSchemaPresent,
  setWorkspaceBindingsStatus,
} from "./workspace-repository-repositories.js";
import type {
  CreateEnterpriseInput,
  CreateMembershipInput,
  CreateProviderInstanceInput,
  CreateTeamInput,
  CreateWorkspaceInput,
  Enterprise,
  EnterpriseScope,
  Membership,
  ProviderInstance,
  Team,
  TeamId,
  TransferWorkspaceInput,
  UpdateEnterpriseInput,
  UpdateTeamInput,
  Workspace,
  WorkspaceRole,
  WorkspaceScope,
  WorkspaceStatus,
  EnterpriseId,
  ProviderInstanceId,
  WorkspaceId,
  MembershipId,
  UserId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface EnterpriseRepository {
  create(input: CreateEnterpriseInput): Enterprise;
  getById(id: EnterpriseId): Enterprise | undefined;
  getBySlug(slug: string): Enterprise | undefined;
  list(): Enterprise[];
  update(id: EnterpriseId, input: UpdateEnterpriseInput, expectedVersion: number): Enterprise;
}

export interface ProviderInstanceRepository {
  create(scope: EnterpriseScope, input: CreateProviderInstanceInput): ProviderInstance;
  getById(scope: EnterpriseScope, id: ProviderInstanceId): ProviderInstance | undefined;
  list(scope: EnterpriseScope): ProviderInstance[];
}

export interface WorkspaceRepository {
  create(scope: EnterpriseScope, input: CreateWorkspaceInput): Workspace;
  getById(scope: EnterpriseScope, id: WorkspaceId): Workspace | undefined;
  /** Find the active workspace for a repository within the scope's enterprise. */
  getByRepositoryId(scope: EnterpriseScope, repositoryId: string): Workspace | undefined;
  list(scope: EnterpriseScope, status?: WorkspaceStatus): Workspace[];
  rename(scope: EnterpriseScope, id: WorkspaceId, name: string, expectedVersion: number): Workspace;
  archive(scope: EnterpriseScope, id: WorkspaceId, expectedVersion: number): Workspace;
  restore(scope: EnterpriseScope, id: WorkspaceId, expectedVersion: number): Workspace;
  transfer(
    scope: EnterpriseScope,
    id: WorkspaceId,
    input: TransferWorkspaceInput,
    expectedVersion: number,
  ): Workspace;
}

export interface TeamRepository {
  create(scope: WorkspaceScope, input: CreateTeamInput): Team;
  getById(scope: WorkspaceScope, id: TeamId): Team | undefined;
  list(scope: WorkspaceScope): Team[];
  update(scope: WorkspaceScope, id: TeamId, input: UpdateTeamInput, expectedVersion: number): Team;
  remove(scope: WorkspaceScope, id: TeamId): void;
}

/**
 * The append-only `auth_audit` row that must commit together with a workspace
 * membership change (DAT-277, ADR-0011). A failed audit write rolls the
 * change back; an unauditable authorization decision is never applied.
 */
export interface MembershipChangeAudit {
  event: "membership.granted" | "membership.role_changed" | "membership.revoked";
  enterprise_id: EnterpriseId;
  actor_kind: "user" | "deployment";
  /** Null/absent for the deployment credential. */
  actor_user_id?: UserId | null;
  subject_user_id: UserId;
  details: Record<string, unknown>;
}

/**
 * The audit row that must commit with a refused last-owner change: the refusal
 * is visible even though no membership row changed. Written inside the same
 * transaction as the guard, so an unauditable refusal fails closed instead of
 * silently blocking.
 */
export interface MembershipBlockedAudit {
  enterprise_id: EnterpriseId;
  actor_kind: "user" | "deployment";
  /** Null/absent for the deployment credential. */
  actor_user_id?: UserId | null;
  action: "remove" | "demote";
}

/**
 * Verified answer to "what would this owner change cost?" (DAT-283).
 *
 * `target_effective` is whether the membership being removed/demoted is an
 * effective owner right now; `other_effective` is whether another effective
 * owner remains. Both come from verified provider facts, never from the role
 * column alone.
 */
export interface OwnerRemovalVerdict {
  target_effective: boolean;
  other_effective: boolean;
}

export interface MembershipMutationOptions {
  /** Required: a last-owner refusal must be audited atomically. */
  blockedAudit: MembershipBlockedAudit;
  /**
   * Capability-grant revocation that belongs to the same authorization change.
   * Runs inside the membership transaction after the write and its audit row:
   * a failure rolls the membership change back, so no live grant outlives the
   * role that justified it.
   */
  applyEffects?: (membership: Membership) => void;
  /**
   * Verified effective-owner probe (DAT-283, ADR-0011).
   *
   * Called *inside* the transaction when the change would remove or demote an
   * `owner`. An effective owner has an active account, an active enterprise
   * membership, an owner assignment **and** verified repository management
   * capability across every active repository; unknown authority proves
   * nothing either way.
   *
   * The role-count guard stays in force as a floor, so this probe can only make
   * the refusal stricter, never weaker. A probe failure answers "no other
   * effective owner": an unprovable owner is not a proven one.
   */
  verifyOwnerRemoval?: (scope: WorkspaceScope, target: Membership) => OwnerRemovalVerdict;
}

export interface MembershipRepository {
  create(scope: WorkspaceScope, input: CreateMembershipInput): Membership;
  /**
   * Create a membership and its required audit row in one transaction. A
   * duplicate membership is a conflict and writes no audit row for the loser.
   */
  createAudited(
    scope: WorkspaceScope,
    input: CreateMembershipInput,
    audit: MembershipChangeAudit,
  ): Membership;
  getById(scope: WorkspaceScope, id: MembershipId): Membership | undefined;
  getByUser(scope: WorkspaceScope, userId: UserId): Membership | undefined;
  list(scope: WorkspaceScope): Membership[];
  /**
   * Number of memberships holding `role` that can still act: the user account
   * and its enterprise membership are both active, matching the session and
   * request-authority checks. Suspended owners do not keep a workspace alive.
   */
  countByRole(scope: WorkspaceScope, role: WorkspaceRole): number;
  /** Every membership of one user across the scope's enterprise. */
  listForUser(scope: EnterpriseScope, userId: UserId): Membership[];
  /**
   * Every membership of one user across all enterprises, keyed only by the
   * user. Request-scope resolution needs the complete set to reject ambiguous
   * and cross-tenant principals; the rows are evidence of the user's own
   * authority and grant no access to any other entity.
   */
  listAllForUser(userId: UserId): Membership[];
  updateRole(
    scope: WorkspaceScope,
    id: MembershipId,
    role: WorkspaceRole,
    expectedVersion: number,
  ): Membership;
  /**
   * Change a role with its audit row and revocation effects in one
   * transaction. Refuses (409 LAST_WORKSPACE_OWNER) when demoting the last
   * *effective* owner, evaluated inside the same transaction as the write.
   */
  updateRoleAudited(
    scope: WorkspaceScope,
    id: MembershipId,
    role: WorkspaceRole,
    expectedVersion: number,
    audit: MembershipChangeAudit,
    options: MembershipMutationOptions,
  ): Membership;
  remove(scope: WorkspaceScope, id: MembershipId): void;
  /**
   * Remove a membership with its audit row and revocation effects in one
   * transaction, refusing to remove the last *effective* owner. Returns the
   * removed row after the commit.
   */
  removeAudited(
    scope: WorkspaceScope,
    id: MembershipId,
    audit: MembershipChangeAudit,
    options: MembershipMutationOptions,
  ): Membership;
}

export interface ControlPlaneRepositories {
  enterprises: EnterpriseRepository;
  providerInstances: ProviderInstanceRepository;
  workspaces: WorkspaceRepository;
  teams: TeamRepository;
  memberships: MembershipRepository;
  /** Create a workspace and its initial owner membership as one transaction. */
  createWorkspaceWithOwner(
    scope: EnterpriseScope,
    input: CreateWorkspaceInput,
    ownerUserId: UserId,
  ): { workspace: Workspace; membership: Membership };
}

// ---------------------------------------------------------------------------
// Row → entity mappers
// ---------------------------------------------------------------------------

interface EnterpriseRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toEnterprise(row: EnterpriseRow): Enterprise {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface ProviderInstanceRow {
  id: string;
  enterprise_id: string;
  provider_type: string;
  origin_url: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toProviderInstance(row: ProviderInstanceRow): ProviderInstance {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    provider_type: row.provider_type as ProviderInstance["provider_type"],
    origin_url: row.origin_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface WorkspaceRow {
  id: string;
  enterprise_id: string;
  name: string;
  repository_id: string;
  provider_instance_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    name: row.name,
    repository_id: row.repository_id,
    provider_instance_id: row.provider_instance_id,
    status: row.status as WorkspaceStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface TeamRow {
  id: string;
  workspace_id: string;
  name: string;
  leader_user_id: string;
  responsibility: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    leader_user_id: row.leader_user_id,
    responsibility: row.responsibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface MembershipRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    role: row.role as WorkspaceRole,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Throw {@link NotFoundError} if `row` is null/undefined.
 *
 * When the SQL query embeds the scope filter, a record outside the caller's
 * scope produces the same `undefined` as a truly missing record — so this
 * single check serves both cases without leaking existence information.
 */
function requireRow<T>(entity: string, id: string, row: T | undefined | null): T {
  if (row === undefined || row === null) {
    throw new NotFoundError(entity, id);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Optimistic-concurrency helper
// ---------------------------------------------------------------------------

interface VersionedUpdateResult {
  changes: number;
}

function requireVersionMatch(
  entity: string,
  id: string,
  result: VersionedUpdateResult,
  expectedVersion: number,
  db: ControlPlaneDb,
  table: string,
): void {
  if (result.changes === 0) {
    // Probe the current version to distinguish "record not found" from
    // "version mismatch" and to report the actual observed version.
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
// Repository implementations
// ---------------------------------------------------------------------------

class SqliteEnterpriseRepository implements EnterpriseRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateEnterpriseInput): Enterprise {
    if (!input.name || !input.slug) {
      throw new ValidationError("Enterprise name and slug are required");
    }
    const id = newId("ent");
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO enterprise (id, name, slug, created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(id, input.name, input.slug, now, now, input.actor_id, input.actor_id);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(`Enterprise slug "${input.slug}" is already in use`, {
          slug: input.slug,
        });
      }
      throw error;
    }
    return requireRow("Enterprise", id, this.getById(id));
  }

  getById(id: EnterpriseId): Enterprise | undefined {
    const row = this.db.prepare("SELECT * FROM enterprise WHERE id = ?").get(id) as
      EnterpriseRow | undefined;
    return row ? toEnterprise(row) : undefined;
  }

  getBySlug(slug: string): Enterprise | undefined {
    const row = this.db.prepare("SELECT * FROM enterprise WHERE slug = ?").get(slug) as
      EnterpriseRow | undefined;
    return row ? toEnterprise(row) : undefined;
  }

  list(): Enterprise[] {
    const rows = this.db
      .prepare("SELECT * FROM enterprise ORDER BY created_at")
      .all() as unknown as EnterpriseRow[];
    return rows.map(toEnterprise);
  }

  update(id: EnterpriseId, input: UpdateEnterpriseInput, expectedVersion: number): Enterprise {
    const existing = requireRow("Enterprise", id, this.getById(id));
    const name = input.name ?? existing.name;
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE enterprise SET name = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(name, now, input.actor_id, id, expectedVersion) as unknown as VersionedUpdateResult;
    requireVersionMatch("Enterprise", id, result, expectedVersion, this.db, "enterprise");
    return requireRow("Enterprise", id, this.getById(id));
  }
}

class SqliteProviderInstanceRepository implements ProviderInstanceRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: EnterpriseScope, input: CreateProviderInstanceInput): ProviderInstance {
    if (input.provider_type !== "github" && input.provider_type !== "gitlab") {
      throw new ValidationError(`Unsupported provider type: ${input.provider_type}`);
    }
    if (!input.origin_url) {
      throw new ValidationError("origin_url is required");
    }
    // Validate origin_url is a well-formed HTTP(S) URL with no embedded
    // credentials, matching the ADR-0006 requirement that provider instance
    // origins are administrator-approved rather than arbitrary strings.
    try {
      const url = new URL(input.origin_url);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new ValidationError("origin_url must use HTTP or HTTPS");
      }
      if (url.username || url.password) {
        throw new ValidationError("origin_url must not contain embedded credentials");
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`origin_url is not a valid URL: ${input.origin_url}`);
    }
    const id = newId("pri");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO provider_instance
           (id, enterprise_id, provider_type, origin_url, created_at, updated_at, created_by, updated_by, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        scope.enterprise_id,
        input.provider_type,
        input.origin_url,
        now,
        now,
        scope.actor_id,
        scope.actor_id,
      );
    return requireRow("ProviderInstance", id, this.getById(scope, id));
  }

  getById(scope: EnterpriseScope, id: ProviderInstanceId): ProviderInstance | undefined {
    const row = this.db
      .prepare("SELECT * FROM provider_instance WHERE id = ? AND enterprise_id = ?")
      .get(id, scope.enterprise_id) as ProviderInstanceRow | undefined;
    return row ? toProviderInstance(row) : undefined;
  }

  list(scope: EnterpriseScope): ProviderInstance[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_instance WHERE enterprise_id = ? ORDER BY created_at")
      .all(scope.enterprise_id) as unknown as ProviderInstanceRow[];
    return rows.map(toProviderInstance);
  }
}

class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: EnterpriseScope, input: CreateWorkspaceInput): Workspace {
    if (!input.name) {
      throw new ValidationError("Workspace name is required");
    }
    if (!input.repository_id) {
      throw new ValidationError("repository_id is required");
    }
    // Verify the provider instance belongs to the same enterprise.
    const provider = this.db
      .prepare("SELECT id FROM provider_instance WHERE id = ? AND enterprise_id = ?")
      .get(input.provider_instance_id, scope.enterprise_id) as { id: string } | undefined;
    if (!provider) {
      throw new ValidationError(
        `Provider instance ${input.provider_instance_id} not found in enterprise ${scope.enterprise_id}`,
      );
    }
    const id = newId("wsp");
    const now = nowIso();
    const hasRepositorySet = repositorySetSchemaPresent(this.db);
    try {
      this.db
        .prepare(
          hasRepositorySet
            ? `INSERT INTO workspace
                 (id, enterprise_id, name, repository_id, provider_instance_id, status, repository_set_version, created_at, updated_at, created_by, updated_by, version)
               VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, 1)`
            : `INSERT INTO workspace
                 (id, enterprise_id, name, repository_id, provider_instance_id, status, created_at, updated_at, created_by, updated_by, version)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          scope.enterprise_id,
          input.name,
          input.repository_id,
          input.provider_instance_id,
          now,
          now,
          scope.actor_id,
          scope.actor_id,
        );
      // The workspace's repository set exists from the moment the workspace
      // does: binding #1 is the same immutable identity. There is no window in
      // which a workspace has no binding (DAT-281). A database pinned below the
      // repository-set schema (only ever a test fixture, since the service
      // always migrates on open) keeps the legacy column alone and is
      // backfilled when it is upgraded.
      if (hasRepositorySet) {
        insertPrimaryWorkspaceBinding(
          this.db,
          {
            id,
            enterprise_id: scope.enterprise_id,
            provider_instance_id: input.provider_instance_id,
            repository_id: input.repository_id,
          },
          {
            provider_instance_id: input.provider_instance_id,
            repository_id: input.repository_id,
            repository_url: input.repository_url ?? null,
            repository_name: input.repository_name ?? null,
          },
          scope,
        );
      }
    } catch (error) {
      // The partial unique index rejects a second active workspace for the
      // same repository in the same enterprise.
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(
          `An active workspace already exists for repository ${input.repository_id} in this enterprise`,
          { repository_id: input.repository_id },
        );
      }
      throw error;
    }
    return requireRow("Workspace", id, this.getById(scope, id));
  }

  getById(scope: EnterpriseScope, id: WorkspaceId): Workspace | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspace WHERE id = ? AND enterprise_id = ?")
      .get(id, scope.enterprise_id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  getByRepositoryId(scope: EnterpriseScope, repositoryId: string): Workspace | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM workspace WHERE enterprise_id = ? AND repository_id = ? AND status = 'active'",
      )
      .get(scope.enterprise_id, repositoryId) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  list(scope: EnterpriseScope, status?: WorkspaceStatus): Workspace[] {
    const sql = status
      ? "SELECT * FROM workspace WHERE enterprise_id = ? AND status = ? ORDER BY created_at"
      : "SELECT * FROM workspace WHERE enterprise_id = ? ORDER BY created_at";
    const params: string[] = status ? [scope.enterprise_id, status] : [scope.enterprise_id];
    const rows = this.db.prepare(sql).all(...params) as unknown as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  rename(
    scope: EnterpriseScope,
    id: WorkspaceId,
    name: string,
    expectedVersion: number,
  ): Workspace {
    if (!name) {
      throw new ValidationError("Workspace name is required");
    }
    requireRow("Workspace", id, this.getById(scope, id));
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE workspace SET name = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND enterprise_id = ? AND version = ?`,
      )
      .run(
        name,
        now,
        scope.actor_id,
        id,
        scope.enterprise_id,
        expectedVersion,
      ) as unknown as VersionedUpdateResult;
    requireVersionMatch("Workspace", id, result, expectedVersion, this.db, "workspace");
    return requireRow("Workspace", id, this.getById(scope, id));
  }

  archive(scope: EnterpriseScope, id: WorkspaceId, expectedVersion: number): Workspace {
    const existing = requireRow("Workspace", id, this.getById(scope, id));
    if (existing.status === "archived") {
      throw new ConflictError(`Workspace ${id} is already archived`);
    }
    const now = nowIso();
    const retiresBindings = repositorySetSchemaPresent(this.db);
    // The workspace status and its bindings are one state change: an archived
    // workspace must never be readable while its binding still reserves the
    // repository (or vice versa), so both updates commit or neither does.
    runInTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE workspace SET status = 'archived', updated_at = ?, updated_by = ?, version = version + 1
           WHERE id = ? AND enterprise_id = ? AND version = ?`,
        )
        .run(
          now,
          scope.actor_id,
          id,
          scope.enterprise_id,
          expectedVersion,
        ) as unknown as VersionedUpdateResult;
      requireVersionMatch("Workspace", id, result, expectedVersion, this.db, "workspace");
      // An archived workspace does not keep its repositories bound: the set
      // stays intact but is retired, so another workspace may take the
      // repository without deleting history (DAT-281).
      if (retiresBindings) {
        setWorkspaceBindingsStatus(this.db, scope, id, "retired");
      }
    });
    return requireRow("Workspace", id, this.getById(scope, id));
  }

  restore(scope: EnterpriseScope, id: WorkspaceId, expectedVersion: number): Workspace {
    const existing = requireRow("Workspace", id, this.getById(scope, id));
    if (existing.status === "active") {
      throw new ConflictError(`Workspace ${id} is already active`);
    }
    // Re-enforce repository uniqueness before restoring. If another active
    // workspace took the repository while this one was archived, restore must
    // fail — the partial unique index catches it on write, but a pre-check
    // gives a clearer error.
    const conflict = this.db
      .prepare(
        "SELECT id FROM workspace WHERE enterprise_id = ? AND repository_id = ? AND status = 'active'",
      )
      .get(scope.enterprise_id, existing.repository_id) as { id: string } | undefined;
    if (conflict) {
      throw new ConflictError(
        `An active workspace (${conflict.id}) already exists for repository ${existing.repository_id}`,
        { repository_id: existing.repository_id, conflicting_workspace_id: conflict.id },
      );
    }
    const now = nowIso();
    const reactivatesBindings = repositorySetSchemaPresent(this.db);
    try {
      // Symmetric with archive: reactivating the workspace and its bindings is
      // one state change, so a crash can never leave an active workspace whose
      // bindings are still retired (which a retry could not repair).
      runInTransaction(this.db, () => {
        const result = this.db
          .prepare(
            `UPDATE workspace SET status = 'active', updated_at = ?, updated_by = ?, version = version + 1
             WHERE id = ? AND enterprise_id = ? AND version = ?`,
          )
          .run(
            now,
            scope.actor_id,
            id,
            scope.enterprise_id,
            expectedVersion,
          ) as unknown as VersionedUpdateResult;
        requireVersionMatch("Workspace", id, result, expectedVersion, this.db, "workspace");
        if (reactivatesBindings) {
          setWorkspaceBindingsStatus(this.db, scope, id, "active");
        }
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        // Pre-check passed but a concurrent restore/create won the race on the
        // partial unique index between our check and this UPDATE.
        throw new ConflictError(
          `An active workspace already exists for repository ${existing.repository_id}`,
          { repository_id: existing.repository_id },
        );
      }
      throw error;
    }
    return requireRow("Workspace", id, this.getById(scope, id));
  }

  transfer(
    scope: EnterpriseScope,
    id: WorkspaceId,
    input: TransferWorkspaceInput,
    expectedVersion: number,
  ): Workspace {
    if (!input.repository_id) {
      throw new ValidationError("repository_id is required");
    }
    requireRow("Workspace", id, this.getById(scope, id));
    // Verify the new provider instance belongs to the same enterprise.
    const provider = this.db
      .prepare("SELECT id FROM provider_instance WHERE id = ? AND enterprise_id = ?")
      .get(input.provider_instance_id, scope.enterprise_id) as { id: string } | undefined;
    if (!provider) {
      throw new ValidationError(
        `Provider instance ${input.provider_instance_id} not found in enterprise ${scope.enterprise_id}`,
      );
    }
    const now = nowIso();
    // The workspace's single binding moves with it, and the set version moves
    // on: a decision formed against the old repository is invalid afterwards.
    return runInTransaction(this.db, () => {
      try {
        const result = this.db
          .prepare(
            `UPDATE workspace SET repository_id = ?, provider_instance_id = ?, updated_at = ?, updated_by = ?, version = version + 1
             WHERE id = ? AND enterprise_id = ? AND version = ?`,
          )
          .run(
            input.repository_id,
            input.provider_instance_id,
            now,
            scope.actor_id,
            id,
            scope.enterprise_id,
            expectedVersion,
          ) as unknown as VersionedUpdateResult;
        requireVersionMatch("Workspace", id, result, expectedVersion, this.db, "workspace");
        if (repositorySetSchemaPresent(this.db)) {
          replacePrimaryWorkspaceBinding(this.db, scope, id, {
            provider_instance_id: input.provider_instance_id,
            repository_id: input.repository_id,
          });
          bumpRepositorySetVersion(this.db, scope, id);
        }
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          throw new ConflictError(
            `An active workspace already exists for repository ${input.repository_id} in this enterprise`,
            { repository_id: input.repository_id },
          );
        }
        throw error;
      }
      return requireRow("Workspace", id, this.getById(scope, id));
    });
  }
}

class SqliteTeamRepository implements TeamRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: WorkspaceScope, input: CreateTeamInput): Team {
    if (!input.name) {
      throw new ValidationError("Team name is required");
    }
    if (!input.leader_user_id) {
      throw new ValidationError("leader_user_id is required");
    }
    // Verify the workspace belongs to the scope.
    const workspace = this.db
      .prepare("SELECT id FROM workspace WHERE id = ? AND enterprise_id = ?")
      .get(scope.workspace_id, scope.enterprise_id) as { id: string } | undefined;
    if (!workspace) {
      throw new NotFoundError("Workspace", scope.workspace_id);
    }
    const id = newId("tem");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO team
           (id, workspace_id, name, leader_user_id, responsibility, created_at, updated_at, created_by, updated_by, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        scope.workspace_id,
        input.name,
        input.leader_user_id,
        input.responsibility ?? null,
        now,
        now,
        scope.actor_id,
        scope.actor_id,
      );
    return requireRow("Team", id, this.getById(scope, id));
  }

  getById(scope: WorkspaceScope, id: TeamId): Team | undefined {
    const row = this.db
      .prepare(
        `SELECT t.* FROM team t JOIN workspace w ON t.workspace_id = w.id
         WHERE t.id = ? AND t.workspace_id = ? AND w.enterprise_id = ?`,
      )
      .get(id, scope.workspace_id, scope.enterprise_id) as TeamRow | undefined;
    return row ? toTeam(row) : undefined;
  }

  list(scope: WorkspaceScope): Team[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM team t JOIN workspace w ON t.workspace_id = w.id
         WHERE t.workspace_id = ? AND w.enterprise_id = ? ORDER BY t.created_at`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as TeamRow[];
    return rows.map(toTeam);
  }

  update(scope: WorkspaceScope, id: TeamId, input: UpdateTeamInput, expectedVersion: number): Team {
    const existing = requireRow("Team", id, this.getById(scope, id));
    const name = input.name ?? existing.name;
    const leader = input.leader_user_id ?? existing.leader_user_id;
    const responsibility =
      input.responsibility !== undefined ? input.responsibility : existing.responsibility;
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE team SET name = ?, leader_user_id = ?, responsibility = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND workspace_id = ? AND version = ?
           AND workspace_id IN (SELECT id FROM workspace WHERE enterprise_id = ?)`,
      )
      .run(
        name,
        leader,
        responsibility,
        now,
        scope.actor_id,
        id,
        scope.workspace_id,
        expectedVersion,
        scope.enterprise_id,
      ) as unknown as VersionedUpdateResult;
    requireVersionMatch("Team", id, result, expectedVersion, this.db, "team");
    return requireRow("Team", id, this.getById(scope, id));
  }

  remove(scope: WorkspaceScope, id: TeamId): void {
    requireRow("Team", id, this.getById(scope, id));
    this.db
      .prepare(
        `DELETE FROM team WHERE id = ? AND workspace_id = ?
           AND workspace_id IN (SELECT id FROM workspace WHERE enterprise_id = ?)`,
      )
      .run(id, scope.workspace_id, scope.enterprise_id);
  }
}

class SqliteMembershipRepository implements MembershipRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: WorkspaceScope, input: CreateMembershipInput): Membership {
    if (!input.user_id) {
      throw new ValidationError("user_id is required");
    }
    const validRoles: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
    if (!validRoles.includes(input.role)) {
      throw new ValidationError(`Invalid workspace role: ${input.role}`);
    }
    // Verify the workspace belongs to the scope.
    const workspace = this.db
      .prepare("SELECT id FROM workspace WHERE id = ? AND enterprise_id = ?")
      .get(scope.workspace_id, scope.enterprise_id) as { id: string } | undefined;
    if (!workspace) {
      throw new NotFoundError("Workspace", scope.workspace_id);
    }
    const id = newId("mbr");
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO membership
             (id, enterprise_id, workspace_id, user_id, role, created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          input.user_id,
          input.role,
          now,
          now,
          scope.actor_id,
          scope.actor_id,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(
          `User ${input.user_id} is already a member of workspace ${scope.workspace_id}`,
          { user_id: input.user_id },
        );
      }
      throw error;
    }
    return requireRow("Membership", id, this.getById(scope, id));
  }

  createAudited(
    scope: WorkspaceScope,
    input: CreateMembershipInput,
    audit: MembershipChangeAudit,
  ): Membership {
    return runInTransaction(this.db, () => {
      const membership = this.create(scope, input);
      this.#appendAudit(scope, audit);
      return membership;
    });
  }

  countByRole(scope: WorkspaceScope, role: WorkspaceRole): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM membership m
          JOIN workspace w ON m.workspace_id = w.id
          JOIN app_user u ON u.id = m.user_id AND u.status = 'active'
          JOIN enterprise_user eu ON eu.enterprise_id = m.enterprise_id
            AND eu.user_id = m.user_id AND eu.status = 'active'
          WHERE m.workspace_id = ? AND m.role = ? AND w.enterprise_id = ?`,
      )
      .get(scope.workspace_id, role, scope.enterprise_id) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getById(scope: WorkspaceScope, id: MembershipId): Membership | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM membership m JOIN workspace w ON m.workspace_id = w.id
         WHERE m.id = ? AND m.workspace_id = ? AND w.enterprise_id = ?`,
      )
      .get(id, scope.workspace_id, scope.enterprise_id) as MembershipRow | undefined;
    return row ? toMembership(row) : undefined;
  }

  getByUser(scope: WorkspaceScope, userId: UserId): Membership | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM membership m JOIN workspace w ON m.workspace_id = w.id
         WHERE m.workspace_id = ? AND m.user_id = ? AND w.enterprise_id = ?`,
      )
      .get(scope.workspace_id, userId, scope.enterprise_id) as MembershipRow | undefined;
    return row ? toMembership(row) : undefined;
  }

  list(scope: WorkspaceScope): Membership[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM membership m JOIN workspace w ON m.workspace_id = w.id
         WHERE m.workspace_id = ? AND w.enterprise_id = ? ORDER BY m.created_at`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as MembershipRow[];
    return rows.map(toMembership);
  }

  listForUser(scope: EnterpriseScope, userId: UserId): Membership[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM membership m JOIN workspace w ON m.workspace_id = w.id
         WHERE m.user_id = ? AND w.enterprise_id = ? ORDER BY m.created_at`,
      )
      .all(userId, scope.enterprise_id) as unknown as MembershipRow[];
    return rows.map(toMembership);
  }

  listAllForUser(userId: UserId): Membership[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM membership m JOIN workspace w ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY m.created_at`,
      )
      .all(userId) as unknown as MembershipRow[];
    return rows.map(toMembership);
  }

  updateRole(
    scope: WorkspaceScope,
    id: MembershipId,
    role: WorkspaceRole,
    expectedVersion: number,
  ): Membership {
    const validRoles: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
    if (!validRoles.includes(role)) {
      throw new ValidationError(`Invalid workspace role: ${role}`);
    }
    requireRow("Membership", id, this.getById(scope, id));
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE membership SET role = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND workspace_id = ? AND version = ?
           AND workspace_id IN (SELECT id FROM workspace WHERE enterprise_id = ?)`,
      )
      .run(
        role,
        now,
        scope.actor_id,
        id,
        scope.workspace_id,
        expectedVersion,
        scope.enterprise_id,
      ) as unknown as VersionedUpdateResult;
    requireVersionMatch("Membership", id, result, expectedVersion, this.db, "membership");
    return requireRow("Membership", id, this.getById(scope, id));
  }

  updateRoleAudited(
    scope: WorkspaceScope,
    id: MembershipId,
    role: WorkspaceRole,
    expectedVersion: number,
    audit: MembershipChangeAudit,
    options: MembershipMutationOptions,
  ): Membership {
    const outcome = runInTransaction(this.db, () => {
      const existing = requireRow("Membership", id, this.getById(scope, id));
      // Evaluated inside the transaction as the write: two concurrent
      // demotions cannot both see a second *effective* owner and both succeed.
      const refusal =
        existing.role === "owner" && role !== "owner"
          ? this.#lastOwnerRefusal(scope, existing, options)
          : null;
      if (refusal !== null) {
        this.#appendBlockedAudit(scope, existing, options.blockedAudit, refusal);
        return { blocked: true as const, membership: existing, reason: refusal };
      }
      const updated = this.updateRole(scope, id, role, expectedVersion);
      this.#appendAudit(scope, audit);
      options.applyEffects?.(updated);
      return { blocked: false as const, membership: updated };
    });
    if (outcome.blocked) {
      throw new LastOwnerError(scope.workspace_id, "demote", {
        membership_id: id,
        user_id: outcome.membership.user_id,
        reason: outcome.reason,
      });
    }
    return outcome.membership;
  }

  remove(scope: WorkspaceScope, id: MembershipId): void {
    requireRow("Membership", id, this.getById(scope, id));
    this.db
      .prepare(
        `DELETE FROM membership WHERE id = ? AND workspace_id = ?
           AND workspace_id IN (SELECT id FROM workspace WHERE enterprise_id = ?)`,
      )
      .run(id, scope.workspace_id, scope.enterprise_id);
  }

  removeAudited(
    scope: WorkspaceScope,
    id: MembershipId,
    audit: MembershipChangeAudit,
    options: MembershipMutationOptions,
  ): Membership {
    const outcome = runInTransaction(this.db, () => {
      const existing = requireRow("Membership", id, this.getById(scope, id));
      const refusal =
        existing.role === "owner" ? this.#lastOwnerRefusal(scope, existing, options) : null;
      if (refusal !== null) {
        this.#appendBlockedAudit(scope, existing, options.blockedAudit, refusal);
        return { blocked: true as const, membership: existing, reason: refusal };
      }
      this.remove(scope, id);
      this.#appendAudit(scope, audit);
      options.applyEffects?.(existing);
      return { blocked: false as const, membership: existing };
    });
    if (outcome.blocked) {
      throw new LastOwnerError(scope.workspace_id, "remove", {
        membership_id: id,
        user_id: outcome.membership.user_id,
        reason: outcome.reason,
      });
    }
    return outcome.membership;
  }

  /**
   * Would this change leave the workspace without an owner anyone can act as?
   *
   * Two independent refusals, both evaluated inside the transaction:
   *
   * - `last_workspace_owner` — the role-count floor: removing or demoting the
   *   only effective member holding `owner` is always refused.
   * - `last_effective_owner` — verified check (DAT-283): the target *is* an
   *   effective owner and no other one remains. Another `owner` row that proves
   *   nothing (no verified repository management capability, inactive account,
   *   inactive enterprise membership) is not a substitute, because ADR-0011
   *   protects the last *effective* owner, not the last role assignment.
   *
   * A target that is not an effective owner is governed by the role-count floor
   * only: removing an owner nobody could act as does not reduce effective
   * ownership, and the deployment recovery path must stay usable.
   *
   * A probe failure answers "no other effective owner": fail closed.
   */
  #lastOwnerRefusal(
    scope: WorkspaceScope,
    existing: Membership,
    options: MembershipMutationOptions,
  ): "last_workspace_owner" | "last_effective_owner" | null {
    if (!this.#isEffectiveMember(scope, existing.user_id)) {
      return null;
    }
    const count = this.countByRole(scope, "owner");
    if (options.verifyOwnerRemoval === undefined) {
      return count <= 1 ? "last_workspace_owner" : null;
    }
    let verdict: OwnerRemovalVerdict;
    try {
      verdict = options.verifyOwnerRemoval(scope, existing);
    } catch {
      // A failed probe cannot prove an effective owner, so it fails closed.
      return count <= 1 ? "last_workspace_owner" : "last_effective_owner";
    }
    if (count <= 1) {
      return "last_workspace_owner";
    }
    if (!verdict.target_effective) {
      return null;
    }
    return verdict.other_effective ? null : "last_effective_owner";
  }

  /**
   * A membership row only represents live authority while both the account
   * and its enterprise membership are active; the session and request-authority
   * gates refuse the same combinations.
   */
  #isEffectiveMember(scope: WorkspaceScope, userId: UserId): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM app_user u
          JOIN enterprise_user eu ON eu.user_id = u.id AND eu.enterprise_id = ?
          WHERE u.id = ? AND u.status = 'active' AND eu.status = 'active'`,
      )
      .get(scope.enterprise_id, userId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /**
   * Append the membership-change audit row inside the caller's transaction.
   * Secrets never enter it: the details are role identifiers and ids only.
   */
  #appendAudit(scope: WorkspaceScope, audit: MembershipChangeAudit): void {
    this.#insertAudit({
      event: audit.event,
      enterprise_id: audit.enterprise_id,
      actor_kind: audit.actor_kind,
      actor_user_id: audit.actor_user_id,
      subject_user_id: audit.subject_user_id,
      details: { workspace_id: scope.workspace_id, ...audit.details },
    });
  }

  /**
   * Record a refused last-owner change in the same transaction as the guard.
   * The change itself never commits; the refusal's audit row does.
   */
  #appendBlockedAudit(
    scope: WorkspaceScope,
    existing: Membership,
    blocked: MembershipBlockedAudit,
    reason: "last_workspace_owner" | "last_effective_owner" = "last_workspace_owner",
  ): void {
    this.#insertAudit({
      event: "membership.owner_change_blocked",
      enterprise_id: blocked.enterprise_id,
      actor_kind: blocked.actor_kind,
      actor_user_id: blocked.actor_user_id,
      subject_user_id: existing.user_id,
      details: {
        workspace_id: scope.workspace_id,
        membership_id: existing.id,
        action: blocked.action,
        reason,
        role: existing.role,
      },
    });
  }

  #insertAudit(input: {
    event: string;
    enterprise_id: EnterpriseId;
    actor_kind: "user" | "deployment";
    actor_user_id?: UserId | null;
    subject_user_id: UserId;
    details: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_audit
           (id, at, event, enterprise_id, actor_kind, actor_user_id,
            subject_user_id, provider_instance_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        newId("aud"),
        nowIso(),
        input.event,
        input.enterprise_id,
        input.actor_kind,
        input.actor_kind === "deployment" ? null : (input.actor_user_id ?? null),
        input.subject_user_id,
        JSON.stringify(input.details),
      );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create all control-plane repositories backed by a single database handle.
 *
 * The returned object is the single entry point for handlers; no handler
 * receives the raw `ControlPlaneDb` and none writes SQL.
 */
export function createRepositories(db: ControlPlaneDb): ControlPlaneRepositories {
  const workspaces = new SqliteWorkspaceRepository(db);
  const memberships = new SqliteMembershipRepository(db);
  return {
    enterprises: new SqliteEnterpriseRepository(db),
    providerInstances: new SqliteProviderInstanceRepository(db),
    workspaces,
    teams: new SqliteTeamRepository(db),
    memberships,
    createWorkspaceWithOwner(scope, input, ownerUserId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const workspace = workspaces.create(scope, input);
        const membership = memberships.create(
          { ...scope, workspace_id: workspace.id },
          { user_id: ownerUserId, role: "owner" },
        );
        db.exec("COMMIT");
        return { workspace, membership };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
