/**
 * Repository-set change persistence (DAT-284, ADR-0011).
 *
 * ## What this module owns
 *
 * The durable half of a repository addition:
 *
 * - `workspace_repository_set_confirmation` (schema v22) stores the exact
 *   member impact an authorized actor confirmed, bound to the actor, the
 *   workspace, the proposed immutable repository identities and the repository
 *   set version. It is evidence of a decision, never an authorization grant:
 *   the commit re-derives every fact and refuses on any difference.
 * - Transaction-scoped writers for the change itself: the new bindings, the
 *   optimistic set-version bump, the approved ceiling reductions, and the
 *   append-only `auth_audit` row.
 *
 * ## Transactions
 *
 * Every writer here assumes the caller's `BEGIN IMMEDIATE` transaction and
 * writes no transaction of its own. The service layer (`provider-access/
 * repository-set-change.ts`) opens exactly one transaction around revalidation
 * and all writes, so a failure in any statement — including the required audit
 * insert — rolls back the bindings, the set version, the ceilings, the grant
 * revocations and the confirmation consumption together.
 *
 * ## What is never stored
 *
 * No credentials, provider subjects, repository URLs or repository names enter
 * the confirmation or the audit row: a confirmation holds the proposed
 * repositories' immutable identities only. The committed binding takes its
 * display name from the verified installation it references, so caller-supplied
 * metadata can neither leak into the decision record nor override the binding.
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso } from "./db.js";
import { RepositorySetChangeError, WorkspaceRepositorySetError } from "./errors.js";
import type { RepositoryCapability } from "./member-capability-types.js";
import { REPOSITORY_CAPABILITIES } from "./member-capability-types.js";
import type {
  ConfirmedMemberImpact,
  ConfirmedOwnerImpact,
  RepositorySetAdditionConfirmation,
  RepositorySetAdditionIdentity,
  RepositorySetChangeImpactSummary,
} from "./repository-set-change-types.js";
import type { UserId, WorkspaceScope } from "./types.js";

export interface RepositorySetChangeActor {
  actor_id: UserId;
  /** `deployment` is the system credential, never a user decision. */
  actor_kind?: "user" | "deployment";
}

/** The stored capability ceiling of one member, as needed by a set change. */
interface MemberCeilingSnapshot {
  id: string;
  ceiling: RepositoryCapability[];
  available_ceiling: RepositoryCapability[];
  state: string;
  reason: string | null;
  set_version: number;
  version: number;
}

/**
 * One binding to insert. Display metadata is not an input: the name is read
 * from the verified installation and the URL is not stored for a new addition,
 * so caller-supplied metadata can never reach the binding row.
 */
export interface InsertWorkspaceRepositoryBindingInput {
  provider_instance_id: string;
  installation_ref: string;
  repository_id: string;
  position: number;
}

export interface PersistCeilingReductionInput {
  user_id: UserId;
  /** The new effective ceiling (already intersected with the stored one). */
  ceiling: readonly RepositoryCapability[];
  /** The verified intersection over the proposed set. */
  available_ceiling: readonly RepositoryCapability[];
  set_version: number;
  verified_at: string;
  reason: string;
}

export interface RepositorySetChangeRepository {
  /**
   * Store one confirmation. Assumes the caller's transaction, so the row and
   * its required audit row either both commit or neither does.
   */
  record(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    confirmation: RepositorySetAdditionConfirmation,
  ): void;
  /**
   * The confirmation, only when it belongs to this actor and workspace. A
   * confirmation recorded by another actor is indistinguishable from a missing
   * one, so the refusal does not enumerate other decisions.
   */
  requireForActor(
    scope: WorkspaceScope,
    confirmationId: string,
    actorUserId: UserId,
  ): RepositorySetAdditionConfirmation;
  /** Mark the confirmation used exactly once. Assumes the caller's transaction. */
  consume(scope: WorkspaceScope, confirmationId: string, setVersionAfter: number, at: string): void;
  /**
   * Append the required audit row. Assumes the caller's transaction: a failed
   * insert throws `REPOSITORY_SET_CHANGE_AUDIT_FAILED` and rolls the change
   * back instead of committing it unaudited.
   */
  appendAudit(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    event: string,
    details: Record<string, unknown>,
  ): void;
  /**
   * Insert one active binding after validating that its instance is approved
   * for the enterprise and its installation is active for exactly this
   * workspace, instance and repository. The binding's display name is read
   * from that verified installation; no caller-supplied metadata is stored.
   * Assumes the caller's transaction.
   */
  insertBinding(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    input: InsertWorkspaceRepositoryBindingInput,
  ): string;
  /**
   * Conditionally advance the workspace's set version. Returns the new
   * version, or throws `REPOSITORY_SET_VERSION_CONFLICT` when the stored token
   * is not the caller's. Assumes the caller's transaction.
   */
  bumpSetVersion(scope: WorkspaceScope, expectedSetVersion: number, at: string): number;
  /**
   * Persist an approved ceiling reduction without ever raising it. Inserts a
   * `downgraded` row when the member never had one, guards an existing row by
   * its optimistic version, and records why the ceiling moved. Assumes the
   * caller's transaction.
   */
  persistCeilingReduction(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    input: PersistCeilingReductionInput,
  ): void;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ConfirmationRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  actor_user_id: string;
  set_version: number;
  proposed_bindings: string;
  members: string;
  owners: string;
  impact: string;
  last_owner_survives: number;
  all_members_retain_admission: number;
  evidence_complete: number;
  checked_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_set_version: number | null;
  created_at: string;
  created_by: string;
  version: number;
}

interface MemberCapabilityRow {
  id: string;
  ceiling: string;
  available_ceiling: string;
  state: string;
  reason: string | null;
  set_version: number;
  version: number;
}

function parseCapabilities(raw: string): RepositoryCapability[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const known = new Set<string>(REPOSITORY_CAPABILITIES);
  const present = new Set(
    parsed.filter((value): value is RepositoryCapability => {
      return typeof value === "string" && known.has(value);
    }),
  );
  return REPOSITORY_CAPABILITIES.filter((capability) => present.has(capability));
}

function serializeCapabilities(capabilities: readonly RepositoryCapability[]): string {
  return JSON.stringify(normalize(capabilities));
}

/**
 * Parse one stored JSON value. A row this build wrote is always valid; a
 * tampered or truncated row is refused as stale evidence rather than trusted.
 */
function parseStored<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RepositorySetChangeError(
      "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
      `the stored confirmation field ${field} is unreadable; record a fresh preview and confirmation`,
    );
  }
}

function toConfirmation(row: ConfirmationRow): RepositorySetAdditionConfirmation {
  const stored = parseStored<RepositorySetAdditionIdentity[]>(
    row.proposed_bindings,
    "proposed_bindings",
  );
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    actor_user_id: row.actor_user_id,
    set_version: row.set_version,
    // Re-project to the identity fields: a row written by any other build can
    // never smuggle display metadata (or anything else) into a decision.
    proposed_bindings: stored.map((binding) => ({
      provider_instance_id: binding.provider_instance_id,
      installation_ref: binding.installation_ref ?? null,
      repository_id: binding.repository_id,
    })),
    members: parseStored<ConfirmedMemberImpact[]>(row.members, "members"),
    owners: parseStored<ConfirmedOwnerImpact[]>(row.owners, "owners"),
    impact: parseStored<RepositorySetChangeImpactSummary>(row.impact, "impact"),
    last_owner_survives: row.last_owner_survives === 1,
    all_members_retain_admission: row.all_members_retain_admission === 1,
    evidence_complete: row.evidence_complete === 1,
    checked_at: row.checked_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    consumed_by_set_version: row.consumed_by_set_version,
    created_at: row.created_at,
    created_by: row.created_by,
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SqliteRepositorySetChangeRepository implements RepositorySetChangeRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  record(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    confirmation: RepositorySetAdditionConfirmation,
  ): void {
    this.db
      .prepare(
        `INSERT INTO workspace_repository_set_confirmation
           (id, enterprise_id, workspace_id, actor_user_id, set_version,
            proposed_bindings, members, owners, impact,
            last_owner_survives, all_members_retain_admission, evidence_complete,
            checked_at, expires_at, consumed_at, consumed_by_set_version,
            created_at, created_by, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`,
      )
      .run(
        confirmation.id,
        scope.enterprise_id,
        scope.workspace_id,
        confirmation.actor_user_id,
        confirmation.set_version,
        JSON.stringify(confirmation.proposed_bindings),
        JSON.stringify(confirmation.members),
        JSON.stringify(confirmation.owners),
        JSON.stringify(confirmation.impact),
        confirmation.last_owner_survives ? 1 : 0,
        confirmation.all_members_retain_admission ? 1 : 0,
        confirmation.evidence_complete ? 1 : 0,
        confirmation.checked_at,
        confirmation.expires_at,
        confirmation.created_at,
        actor.actor_id,
      );
  }

  requireForActor(
    scope: WorkspaceScope,
    confirmationId: string,
    actorUserId: UserId,
  ): RepositorySetAdditionConfirmation {
    const row = this.db
      .prepare(
        `SELECT * FROM workspace_repository_set_confirmation
          WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(confirmationId, scope.enterprise_id, scope.workspace_id) as ConfirmationRow | undefined;
    if (row === undefined || row.actor_user_id !== actorUserId) {
      // Never reveal whether another actor's confirmation exists.
      throw new RepositorySetChangeError(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED",
        "no usable repository-set change confirmation exists for this actor and workspace; preview and confirm the change first",
      );
    }
    return toConfirmation(row);
  }

  consume(
    scope: WorkspaceScope,
    confirmationId: string,
    setVersionAfter: number,
    at: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE workspace_repository_set_confirmation
            SET consumed_at = ?, consumed_by_set_version = ?, version = version + 1
          WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND consumed_at IS NULL`,
      )
      .run(at, setVersionAfter, confirmationId, scope.enterprise_id, scope.workspace_id);
    if (Number(result.changes) === 0) {
      throw new RepositorySetChangeError(
        "REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED",
        "the repository-set change confirmation was already consumed; a change commits at most once",
        409,
        { confirmation_id: confirmationId },
      );
    }
  }

  appendAudit(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    event: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO auth_audit
             (id, at, event, enterprise_id, actor_kind, actor_user_id,
              subject_user_id, provider_instance_id, details)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          newId("aud"),
          nowIso(),
          event,
          scope.enterprise_id,
          actor.actor_kind ?? "user",
          actor.actor_kind === "deployment" ? null : actor.actor_id,
          JSON.stringify({ workspace_id: scope.workspace_id, ...details }),
        );
    } catch (cause) {
      // Required audit evidence: an unauditable change is not committed.
      throw new RepositorySetChangeError(
        "REPOSITORY_SET_CHANGE_AUDIT_FAILED",
        "required audit evidence could not be written; the repository-set change was rolled back",
        500,
        { event },
        { cause },
      );
    }
  }

  insertBinding(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    input: InsertWorkspaceRepositoryBindingInput,
  ): string {
    if (input.repository_id.length === 0) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_INCONSISTENT",
        "a proposed repository binding has no repository identity",
        409,
        { workspace_id: scope.workspace_id },
      );
    }
    const provider = this.db
      .prepare("SELECT id FROM provider_instance WHERE id = ? AND enterprise_id = ?")
      .get(input.provider_instance_id, scope.enterprise_id) as { id: string } | undefined;
    if (provider === undefined) {
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_BINDING_UNAPPROVED",
        "the proposed repository uses a provider instance this enterprise has not approved",
        409,
        { workspace_id: scope.workspace_id },
      );
    }
    if (input.installation_ref === null || input.installation_ref === "") {
      throw new WorkspaceRepositorySetError(
        "INSTALLATION_NOT_APPROVED",
        "a new repository binding requires an approved, active installation for exactly that repository",
        409,
        { workspace_id: scope.workspace_id },
      );
    }
    // The installation must be live and observe exactly this binding's
    // workspace, instance and repository. This mirrors the read boundary and
    // the DAT-283 evidence rule, so a confirmation cannot smuggle a binding
    // that the authorization path would refuse.
    const installation = this.db
      .prepare(
        `SELECT id, repository_name FROM service_integration
          WHERE id = ? AND enterprise_id = ? AND workspace_id = ?
            AND provider_instance_id = ? AND repository_id = ?
            AND install_status = 'active'`,
      )
      .get(
        input.installation_ref,
        scope.enterprise_id,
        scope.workspace_id,
        input.provider_instance_id,
        input.repository_id,
      ) as { id: string; repository_name: string } | undefined;
    if (installation === undefined) {
      throw new WorkspaceRepositorySetError(
        "INSTALLATION_NOT_APPROVED",
        "the proposed repository binding references an installation that is not approved for it",
        409,
        { workspace_id: scope.workspace_id },
      );
    }

    const id = newId("wrb");
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO workspace_repository_binding
             (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
              repository_id, repository_url, repository_name, position, status,
              created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          input.provider_instance_id,
          input.installation_ref,
          input.repository_id,
          // No URL is invented for a new addition; the name is the verified
          // installation's display metadata.
          null,
          installation.repository_name,
          input.position,
          now,
          now,
          actor.actor_id,
          actor.actor_id,
        );
    } catch (cause) {
      if (String(cause).includes("UNIQUE")) {
        throw new RepositorySetChangeError(
          "REPOSITORY_SET_CHANGE_CONFLICT",
          "the repository was bound concurrently; re-read the set and preview again",
          409,
          { repository_id: input.repository_id },
          { cause },
        );
      }
      throw cause;
    }
    return id;
  }

  bumpSetVersion(scope: WorkspaceScope, expectedSetVersion: number, at: string): number {
    const result = this.db
      .prepare(
        `UPDATE workspace
            SET repository_set_version = repository_set_version + 1,
                updated_at = ?, updated_by = ?
          WHERE id = ? AND enterprise_id = ? AND repository_set_version = ?`,
      )
      .run(at, scope.actor_id, scope.workspace_id, scope.enterprise_id, expectedSetVersion);
    if (Number(result.changes) === 0) {
      const stored = this.db
        .prepare("SELECT repository_set_version FROM workspace WHERE id = ? AND enterprise_id = ?")
        .get(scope.workspace_id, scope.enterprise_id) as
        { repository_set_version: number } | undefined;
      throw new WorkspaceRepositorySetError(
        "REPOSITORY_SET_VERSION_CONFLICT",
        `the workspace repository set changed (expected version ${expectedSetVersion}, found ${
          stored?.repository_set_version ?? "unknown"
        }); re-read and preview again`,
        409,
        {
          expected_set_version: expectedSetVersion,
          actual_set_version: stored?.repository_set_version ?? null,
        },
      );
    }
    return expectedSetVersion + 1;
  }

  /** The stored ceiling row, if one exists. */
  private memberCeiling(scope: WorkspaceScope, userId: UserId): MemberCeilingSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT id, ceiling, available_ceiling, state, reason, set_version, version
           FROM workspace_member_capability
          WHERE enterprise_id = ? AND workspace_id = ? AND user_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, userId) as MemberCapabilityRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      ceiling: parseCapabilities(row.ceiling),
      available_ceiling: parseCapabilities(row.available_ceiling),
      state: row.state,
      reason: row.reason,
      set_version: row.set_version,
      version: row.version,
    };
  }

  persistCeilingReduction(
    scope: WorkspaceScope,
    actor: RepositorySetChangeActor,
    input: PersistCeilingReductionInput,
  ): void {
    const existing = this.memberCeiling(scope, input.user_id);
    // Never raise: a reduction may only remove capabilities.
    const ceiling = existing
      ? normalize(existing.ceiling.filter((capability) => input.ceiling.includes(capability)))
      : normalize(input.ceiling);
    const now = nowIso();
    if (existing === undefined) {
      // A member can be admitted without a persisted row (evaluations on the
      // request path are read-only). Persist the reduction as `downgraded` so
      // a later provider recovery cannot silently restore it.
      this.db
        .prepare(
          `INSERT INTO workspace_member_capability
             (id, enterprise_id, workspace_id, user_id, ceiling, available_ceiling,
              state, reason, set_version, verified_at, version,
              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, 'downgraded', ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          newId("wmc"),
          scope.enterprise_id,
          scope.workspace_id,
          input.user_id,
          serializeCapabilities(ceiling),
          serializeCapabilities(input.available_ceiling),
          input.reason,
          input.set_version,
          input.verified_at,
          now,
          now,
          actor.actor_id,
          actor.actor_id,
        );
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE workspace_member_capability
            SET ceiling = ?, available_ceiling = ?, state = 'downgraded',
                reason = ?, set_version = ?, verified_at = ?,
                updated_at = ?, updated_by = ?, version = version + 1
          WHERE id = ? AND version = ?`,
      )
      .run(
        serializeCapabilities(ceiling),
        serializeCapabilities(input.available_ceiling),
        input.reason,
        input.set_version,
        input.verified_at,
        now,
        actor.actor_id,
        existing.id,
        existing.version,
      );
    if (Number(result.changes) === 0) {
      throw new RepositorySetChangeError(
        "REPOSITORY_SET_CHANGE_CONFLICT",
        "the member's capability ceiling changed concurrently; re-preview and confirm again",
        409,
        { user_id: input.user_id },
      );
    }
  }
}

function normalize(capabilities: Iterable<RepositoryCapability>): RepositoryCapability[] {
  const set = new Set(capabilities);
  return REPOSITORY_CAPABILITIES.filter((capability) => set.has(capability));
}

export function createRepositorySetChangeRepository(
  db: ControlPlaneDb,
): RepositorySetChangeRepository {
  return new SqliteRepositorySetChangeRepository(db);
}
