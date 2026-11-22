/**
 * Workspace repository set storage and read boundary (DAT-281, ADR-0011).
 *
 * ## What this module is
 *
 * The authoritative answer to "which repositories does this workspace own?".
 * Later work (multi-repository membership, execution, access) consumes this
 * instead of the legacy single `workspace.repository_id` column. Storage is
 * versioned per workspace (`workspace.repository_set_version`) so an access
 * decision formed against set N is refused against set N+1.
 *
 * ## What this module deliberately is not
 *
 * Multi-repository support. The `multi_repository_workspace` gate row is
 * immutable and `disabled`; there is no code path that appends a binding,
 * removes one, or authorizes against a set with more than one repository.
 * Enabling it requires a forward migration plus enforcement in every
 * membership, execution, stream, artifact, memory and delivery path — none of
 * which exist yet. That is why the refusal branch for an enabled gate still
 * says `MULTI_REPOSITORY_SCOPE_UNSUPPORTED`: a gate row is a rollout decision,
 * never an implementation.
 *
 * ## Fail-closed rules
 *
 * Every read either produces a set whose bindings were all verified against
 * live `provider_instance` / `service_integration` rows in the same
 * enterprise, or throws. An empty set, a set that disagrees with the
 * workspace's immutable legacy pair, an unapproved instance, an unapproved
 * installation, a stale set version and a multi-repository set faced by
 * single-repository code all refuse. Nothing falls back to "the first
 * repository" or "the deployment's configured repository".
 */

import type { ControlPlaneDb } from "./db.js";
import { CURRENT_SCHEMA_VERSION, newId, nowIso } from "./db.js";
import { NotFoundError, WorkspaceRepositorySetError } from "./errors.js";
import type { EnterpriseScope, WorkspaceId, WorkspaceScope } from "./types.js";
import type {
  AddWorkspaceRepositoryBindingInput,
  DeploymentFeatureGate,
  DeploymentFeatureGateKey,
  SingleRepositoryWorkspaceScope,
  WorkspaceRepositoryBinding,
  WorkspaceRepositoryBindingStatus,
  WorkspaceRepositorySet,
  WritePrimaryBindingInput,
} from "./workspace-repository-types.js";

/** The one gate this storage layer knows about. */
export const MULTI_REPOSITORY_GATE_KEY: DeploymentFeatureGateKey = "multi_repository_workspace";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WorkspaceRepositorySetRepository {
  /**
   * The effective, immutable gate state. Throws `FEATURE_GATE_UNREADABLE`
   * when the row is missing, malformed, or was written by a newer schema.
   */
  gate(): DeploymentFeatureGate;
  /**
   * Storage rows for one workspace, as-is. Read-only reporting for audits and
   * migration checks; it grants nothing. Authorization must go through
   * {@link requireSingleRepository}.
   */
  listBindings(
    scope: WorkspaceScope,
    options?: { include_retired?: boolean },
  ): WorkspaceRepositoryBinding[];
  /** The validated, versioned set. Throws on every fail-closed condition. */
  getSet(scope: WorkspaceScope): WorkspaceRepositorySet;
  /** The set, but only if it is still at the caller's observed version. */
  getSetAtVersion(scope: WorkspaceScope, expectedSetVersion: number): WorkspaceRepositorySet;
  /**
   * The only shape authorization may consume today: exactly one verified
   * repository binding. Refuses a multi-repository set, and refuses when the
   * gate row is unreadable or from a newer schema.
   */
  requireSingleRepository(scope: WorkspaceScope): SingleRepositoryWorkspaceScope;
  /**
   * Binding another repository into a workspace. Refused unconditionally
   * while the multi-repository gate is closed; present so the refusal is
   * explicit, typed, and tested rather than an unimplemented route.
   */
  addBinding(scope: WorkspaceScope, input: AddWorkspaceRepositoryBindingInput): never;
  /** Removing a binding. Refused for the same reason as {@link addBinding}. */
  removeBinding(scope: WorkspaceScope, bindingId: string, expectedSetVersion?: number): never;
  /** Effective set version without materializing the whole set. */
  currentSetVersion(scope: WorkspaceScope): number;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  enterprise_id: string;
  repository_id: string;
  provider_instance_id: string;
  status: string;
  repository_set_version: number;
}

interface BindingRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  provider_instance_id: string;
  installation_ref: string | null;
  repository_id: string;
  repository_url: string | null;
  repository_name: string | null;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toBinding(row: BindingRow): WorkspaceRepositoryBinding {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    provider_instance_id: row.provider_instance_id,
    installation_ref: row.installation_ref,
    repository_id: row.repository_id,
    repository_url: row.repository_url,
    repository_name: row.repository_name,
    position: row.position,
    status: row.status as WorkspaceRepositoryBindingStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SqliteWorkspaceRepositorySetRepository implements WorkspaceRepositorySetRepository {
  /** The schema version this build can enforce; see `assertSchemaSupported`. */
  private readonly supportedSchemaVersion: number;

  constructor(
    private readonly db: ControlPlaneDb,
    options: { supportedSchemaVersion?: number } = {},
  ) {
    this.supportedSchemaVersion = options.supportedSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  }

  gate(): DeploymentFeatureGate {
    const rows = this.db
      .prepare(
        `SELECT key, state, reason, min_schema_version, created_at, created_by
           FROM deployment_feature_gate
          WHERE key = ?
          ORDER BY min_schema_version DESC, created_at DESC`,
      )
      .all(MULTI_REPOSITORY_GATE_KEY) as unknown as DeploymentFeatureGate[];
    const newest = rows[0];
    if (newest === undefined) {
      throw new WorkspaceRepositorySetError(
        "FEATURE_GATE_UNREADABLE",
        "The multi-repository feature gate has no recorded state; refusing to guess",
        403,
        { key: MULTI_REPOSITORY_GATE_KEY },
      );
    }
    if (
      (newest.state !== "enabled" && newest.state !== "disabled") ||
      typeof newest.min_schema_version !== "number"
    ) {
      throw new WorkspaceRepositorySetError(
        "FEATURE_GATE_UNREADABLE",
        "The multi-repository feature gate row is malformed; refusing to guess",
        403,
        { key: MULTI_REPOSITORY_GATE_KEY },
      );
    }
    if (newest.min_schema_version > this.supportedSchemaVersion) {
      throw new WorkspaceRepositorySetError(
        "FEATURE_GATE_UNREADABLE",
        `The feature gate was decided by schema ${newest.min_schema_version}, newer than this build's ${this.supportedSchemaVersion}; a mixed-version rollout fails closed`,
        403,
        {
          key: MULTI_REPOSITORY_GATE_KEY,
          gate_schema_version: newest.min_schema_version,
          build_schema_version: this.supportedSchemaVersion,
        },
      );
    }
    return newest;
  }

  listBindings(
    scope: WorkspaceScope,
    options: { include_retired?: boolean } = {},
  ): WorkspaceRepositoryBinding[] {
    this.requireWorkspace(scope);
    const statuses = options.include_retired === true ? ["active", "retired"] : ["active"];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_repository_binding
          WHERE enterprise_id = ? AND workspace_id = ? AND status IN (${placeholders})
          ORDER BY position, created_at, id`,
      )
      .all(scope.enterprise_id, scope.workspace_id, ...statuses) as unknown as BindingRow[];
    return rows.map(toBinding);
  }

  currentSetVersion(scope: WorkspaceScope): number {
    return this.requireWorkspace(scope).repository_set_version;
  }

  getSet(scope: WorkspaceScope): WorkspaceRepositorySet {
    const workspace = this.requireWorkspace(scope);
    const gate = this.gate();
    const archived = workspace.status !== "active";
    const bindings = this.listBindings(scope, { include_retired: archived });

    if (bindings.length === 0) {
      // Absence of evidence is never "a workspace with no repositories yet":
      // every workspace is created with, or migrated to, exactly one binding.
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_MISSING",
        `Workspace ${workspace.id} has no active repository binding; refusing to authorize without one`,
        409,
        { workspace_id: workspace.id },
      );
    }

    for (const binding of bindings) {
      this.assertBindingApproved(workspace, binding);
    }

    // The legacy columns remain the deployment's pinned binding. While the
    // gate is closed the set must agree with them; a disagreement is reported,
    // never resolved in favour of either side.
    const primary = bindings.find((binding) => binding.position === 1) ?? bindings[0]!;
    if (
      primary.repository_id !== workspace.repository_id ||
      primary.provider_instance_id !== workspace.provider_instance_id
    ) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_INCONSISTENT",
        `Workspace ${workspace.id} repository binding disagrees with its immutable repository identity; escalate this historical data instead of authorizing it`,
        409,
        {
          workspace_id: workspace.id,
          workspace_repository_id: workspace.repository_id,
          binding_repository_id: primary.repository_id,
          workspace_provider_instance_id: workspace.provider_instance_id,
          binding_provider_instance_id: primary.provider_instance_id,
        },
      );
    }

    const multi = bindings.length > 1;
    const blocked = archived
      ? ("WORKSPACE_ARCHIVED" as const)
      : multi
        ? gate.state === "enabled"
          ? ("MULTI_REPOSITORY_SCOPE_UNSUPPORTED" as const)
          : ("MULTI_REPOSITORY_SCOPE_DISABLED" as const)
        : null;

    return {
      enterprise_id: workspace.enterprise_id,
      workspace_id: workspace.id,
      set_version: workspace.repository_set_version,
      bindings,
      multi_repository: multi,
      usable: blocked === null,
      blocked_reason: blocked,
      gate,
    };
  }

  getSetAtVersion(scope: WorkspaceScope, expectedSetVersion: number): WorkspaceRepositorySet {
    const set = this.getSet(scope);
    if (set.set_version !== expectedSetVersion) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_SET_VERSION_CONFLICT",
        `Workspace ${set.workspace_id} repository set changed (expected version ${expectedSetVersion}, found ${set.set_version}); re-read before authorizing`,
        409,
        { expected_set_version: expectedSetVersion, actual_set_version: set.set_version },
      );
    }
    return set;
  }

  requireSingleRepository(scope: WorkspaceScope): SingleRepositoryWorkspaceScope {
    const set = this.getSet(scope);
    if (!set.usable || set.blocked_reason !== null) {
      throw new WorkspaceRepositorySetError(
        set.blocked_reason ?? "MULTI_REPOSITORY_SCOPE_DISABLED",
        blockedReasonMessage(set),
        403,
        {
          workspace_id: set.workspace_id,
          binding_count: set.bindings.length,
          set_version: set.set_version,
          gate_state: set.gate.state,
        },
      );
    }
    return {
      enterprise_id: set.enterprise_id,
      workspace_id: set.workspace_id,
      set_version: set.set_version,
      binding: set.bindings[0]!,
      gate: set.gate,
    };
  }

  addBinding(_scope: WorkspaceScope, _input: AddWorkspaceRepositoryBindingInput): never {
    throw new WorkspaceRepositorySetError(
      "SCOPE_MUTATION_DISABLED",
      "Adding a repository to a workspace is refused: multi-repository workspace scopes are disabled (ADR-0011, DAT-281)",
      403,
      { gate_key: MULTI_REPOSITORY_GATE_KEY },
    );
  }

  removeBinding(_scope: WorkspaceScope, _bindingId: string, _expectedSetVersion?: number): never {
    throw new WorkspaceRepositorySetError(
      "SCOPE_MUTATION_DISABLED",
      "Removing a repository from a workspace is refused: multi-repository workspace scopes are disabled (ADR-0011, DAT-281)",
      403,
      { gate_key: MULTI_REPOSITORY_GATE_KEY },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireWorkspace(scope: WorkspaceScope): WorkspaceRow {
    const row = this.db
      .prepare(
        `SELECT id, enterprise_id, repository_id, provider_instance_id, status, repository_set_version
           FROM workspace WHERE id = ? AND enterprise_id = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id) as WorkspaceRow | undefined;
    if (row === undefined) {
      throw new NotFoundError("Workspace", scope.workspace_id);
    }
    return row;
  }

  /**
   * A binding is approved only when its provider instance is registered for
   * the same enterprise and its installation reference (when present) is a
   * live integration for exactly this enterprise, workspace, instance and
   * repository. Anything else refuses instead of degrading.
   */
  private assertBindingApproved(
    workspace: WorkspaceRow,
    binding: WorkspaceRepositoryBinding,
  ): void {
    if (binding.repository_id.length === 0) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_INCONSISTENT",
        `Workspace ${workspace.id} has a binding without a repository identity`,
        409,
        { workspace_id: workspace.id, binding_id: binding.id },
      );
    }
    const provider = this.db
      .prepare("SELECT id FROM provider_instance WHERE id = ? AND enterprise_id = ?")
      .get(binding.provider_instance_id, workspace.enterprise_id) as { id: string } | undefined;
    if (provider === undefined) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_UNAPPROVED",
        `Workspace ${workspace.id} binds a repository through a provider instance this enterprise has not approved`,
        409,
        {
          workspace_id: workspace.id,
          binding_id: binding.id,
          provider_instance_id: binding.provider_instance_id,
        },
      );
    }
    if (binding.installation_ref === null) {
      return;
    }
    const installation = this.db
      .prepare(
        `SELECT id FROM service_integration
          WHERE id = ? AND enterprise_id = ? AND workspace_id = ?
            AND provider_instance_id = ? AND repository_id = ?
            AND install_status != 'uninstalled'`,
      )
      .get(
        binding.installation_ref,
        workspace.enterprise_id,
        workspace.id,
        binding.provider_instance_id,
        binding.repository_id,
      ) as { id: string } | undefined;
    if (installation === undefined) {
      throw new WorkspaceRepositorySetError(
        "INSTALLATION_NOT_APPROVED",
        `Workspace ${workspace.id} binds a repository through an installation that is not approved for it`,
        409,
        { workspace_id: workspace.id, binding_id: binding.id },
      );
    }
  }
}

/**
 * Safe explanation for a set that cannot be used. Never includes repository
 * names, URLs, credentials or other tenants' identifiers.
 */
function blockedReasonMessage(set: WorkspaceRepositorySet): string {
  switch (set.blocked_reason) {
    case "WORKSPACE_ARCHIVED":
      return `Workspace ${set.workspace_id} is archived, so its repository set authorizes nothing`;
    case "MULTI_REPOSITORY_SCOPE_UNSUPPORTED":
      return `Workspace ${set.workspace_id} has ${set.bindings.length} repositories and this build does not enforce a multi-repository scope`;
    default:
      return `Workspace ${set.workspace_id} has ${set.bindings.length} repositories; multi-repository scopes are disabled until every access path enforces the whole set`;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle writers
//
// These are module functions, not part of the consumer interface: workspace
// create/transfer/archive/restore own the set's lifecycle, and no caller may
// append a second binding. They assume the caller's transaction.
// ---------------------------------------------------------------------------

/**
 * Whether this database has the repository-set schema (v20+).
 *
 * The service always migrates on open, so this is only false for a database
 * deliberately pinned to an older version — a migration test fixture. Such a
 * database keeps the legacy `workspace.repository_id` column alone and is
 * backfilled when it is upgraded; it is never granted anything extra here.
 */
const repositorySetSchemaCache = new WeakSet<ControlPlaneDb>();

export function repositorySetSchemaPresent(db: ControlPlaneDb): boolean {
  if (repositorySetSchemaCache.has(db)) {
    return true;
  }
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_repository_binding'",
    )
    .get() as { name: string } | undefined;
  if (row === undefined) {
    return false;
  }
  repositorySetSchemaCache.add(db);
  return true;
}

/** Resolve the approved installation for a repository, if one is registered. */
function approvedInstallationRef(
  db: ControlPlaneDb,
  enterpriseId: string,
  workspaceId: string,
  providerInstanceId: string,
  repositoryId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM service_integration
        WHERE enterprise_id = ? AND workspace_id = ? AND provider_instance_id = ?
          AND repository_id = ? AND install_status != 'uninstalled'
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(enterpriseId, workspaceId, providerInstanceId, repositoryId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Write binding #1 for a freshly created workspace. Called inside the
 * workspace insert's transaction, so a workspace never exists without its
 * binding.
 */
export function insertPrimaryWorkspaceBinding(
  db: ControlPlaneDb,
  workspace: {
    id: WorkspaceId;
    enterprise_id: string;
    provider_instance_id: string;
    repository_id: string;
  },
  input: WritePrimaryBindingInput,
  actor: { actor_id: string },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO workspace_repository_binding
       (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
        repository_id, repository_url, repository_name, position, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    newId("wrb"),
    workspace.enterprise_id,
    workspace.id,
    input.provider_instance_id,
    input.installation_ref ??
      approvedInstallationRef(
        db,
        workspace.enterprise_id,
        workspace.id,
        input.provider_instance_id,
        input.repository_id,
      ),
    input.repository_id,
    input.repository_url ?? null,
    input.repository_name ?? null,
    now,
    now,
    actor.actor_id,
    actor.actor_id,
  );
}

/**
 * Replace the identity of a workspace's single binding (repository transfer).
 *
 * A transfer is not a set change: the workspace still owns exactly one
 * repository, so this rewrites binding #1 and bumps the set version, which
 * invalidates every decision formed against the previous repository.
 */
export function replacePrimaryWorkspaceBinding(
  db: ControlPlaneDb,
  scope: EnterpriseScope,
  workspaceId: WorkspaceId,
  input: WritePrimaryBindingInput,
): void {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE workspace_repository_binding
          SET provider_instance_id = ?, installation_ref = ?, repository_id = ?,
              repository_url = ?, repository_name = ?, updated_at = ?, updated_by = ?,
              version = version + 1
        WHERE enterprise_id = ? AND workspace_id = ? AND position = 1`,
    )
    .run(
      input.provider_instance_id,
      input.installation_ref ??
        approvedInstallationRef(
          db,
          scope.enterprise_id,
          workspaceId,
          input.provider_instance_id,
          input.repository_id,
        ),
      input.repository_id,
      input.repository_url ?? null,
      input.repository_name ?? null,
      now,
      scope.actor_id,
      scope.enterprise_id,
      workspaceId,
    ) as unknown as { changes: number };
  if (result.changes === 0) {
    throw new WorkspaceRepositorySetError(
      "REPOSITORY_BINDING_MISSING",
      `Workspace ${workspaceId} has no repository binding to transfer`,
      409,
      { workspace_id: workspaceId },
    );
  }
}

/**
 * Retire or reactivate a workspace's bindings with its archive state, so an
 * archived workspace does not keep a repository reserved (mirrors the
 * workspace-level unique index).
 */
export function setWorkspaceBindingsStatus(
  db: ControlPlaneDb,
  scope: EnterpriseScope,
  workspaceId: WorkspaceId,
  status: WorkspaceRepositoryBindingStatus,
): void {
  db.prepare(
    `UPDATE workspace_repository_binding
        SET status = ?, updated_at = ?, updated_by = ?, version = version + 1
      WHERE enterprise_id = ? AND workspace_id = ? AND status != ?`,
  ).run(status, nowIso(), scope.actor_id, scope.enterprise_id, workspaceId, status);
}

/** Bump the workspace's set version (the optimistic token for the whole set). */
export function bumpRepositorySetVersion(
  db: ControlPlaneDb,
  scope: EnterpriseScope,
  workspaceId: WorkspaceId,
): void {
  db.prepare(
    `UPDATE workspace SET repository_set_version = repository_set_version + 1,
        updated_at = ?, updated_by = ?
      WHERE id = ? AND enterprise_id = ?`,
  ).run(nowIso(), scope.actor_id, workspaceId, scope.enterprise_id);
}

/**
 * Create the workspace repository-set repository backed by one database
 * handle. Consumers get reads only; the binding writers above stay module
 * functions used by the workspace lifecycle.
 */
export function createWorkspaceRepositorySetRepository(
  db: ControlPlaneDb,
  options: { supportedSchemaVersion?: number } = {},
): WorkspaceRepositorySetRepository {
  return new SqliteWorkspaceRepositorySetRepository(db, options);
}
