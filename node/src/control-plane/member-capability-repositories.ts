/**
 * Persisted capability-ceiling storage (DAT-276, ADR-0011).
 *
 * Two writes matter and both are audited in the same transaction:
 *
 * 1. **Confirmed reduction or loss.** `applyDowngrade` moves `ceiling` down to
 *    the newly verified intersection (or to the empty set on confirmed loss)
 *    and records why. It refuses to raise the ceiling: a provider recovery is
 *    recorded in `available_ceiling` only, never applied. An optimistic
 *    `version` guard makes two concurrent evaluators converge on the stricter
 *    value instead of overwriting each other with a stale observation.
 * 2. **Administrator reapproval.** `reapprove` may raise the ceiling, but only
 *    up to the caller-supplied verified intersection — the ceiling service
 *    validates that bound before calling, and this layer re-checks that the
 *    stored `available_ceiling` matches the observed one so a concurrent
 *    provider change cannot be approved on stale facts.
 *
 * Every mutation writes its `auth_audit` row inside the same transaction: a
 * failed audit rolls the change back rather than leaving an unauditable
 * authorization decision. Denied reapprovals are audited too (failures are
 * evidence), in their own transaction.
 */

import type { ControlPlaneDb } from "./db.js";
import { SYSTEM_ACTOR, newId, nowIso, runInTransaction } from "./db.js";
import { CapabilityCeilingError, NotFoundError, VersionConflictError } from "./errors.js";
import type {
  ApplyMemberCapabilityDowngradeInput,
  InitializeMemberCapabilityInput,
  ObserveMemberCapabilityInput,
  MemberCapabilityCeiling,
  PersistedCeilingState,
  ReapproveMemberCapabilityInput,
  RepositoryCapability,
} from "./member-capability-types.js";
import {
  MEMBER_CAPABILITY_AUDIT_EVENTS,
  REPOSITORY_CAPABILITIES,
} from "./member-capability-types.js";
import type { WorkspaceScope } from "./types.js";

export interface CapabilityCeilingAuditActor {
  actor_id: string;
  /** `deployment` is the bootstrap/deployment credential, never a user grant. */
  actor_kind?: "user" | "deployment";
}

export interface MemberCapabilityRepository {
  get(scope: WorkspaceScope, userId: string): MemberCapabilityCeiling | undefined;
  list(scope: WorkspaceScope): MemberCapabilityCeiling[];
  /**
   * Record the first verified ceiling for a member. Idempotent racing is
   * handled by the unique index: a concurrent initializer re-reads the row.
   */
  initialize(
    scope: WorkspaceScope,
    userId: string,
    input: InitializeMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling;
  /** Apply a confirmed reduction (or loss) — never a raise. */
  applyDowngrade(
    scope: WorkspaceScope,
    userId: string,
    input: ApplyMemberCapabilityDowngradeInput,
    actor: CapabilityCeilingAuditActor,
  ): { record: MemberCapabilityCeiling; applied: boolean };
  /**
   * Record a *higher* verified intersection without raising the ceiling.
   *
   * This is the observability half of "a provider recovery never promotes on
   * its own": the ceiling stays where the confirmed downgrade left it, while
   * `available_ceiling` shows an administrator that a promotion is available
   * and which capabilities it would cover.
   */
  observeAvailability(
    scope: WorkspaceScope,
    userId: string,
    input: ObserveMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling;
  /** Administrator reapproval inside the verified bound. */
  reapprove(
    scope: WorkspaceScope,
    userId: string,
    input: ReapproveMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling;
  /** Audit a refused reapproval (the refusal is never silently dropped). */
  auditDenial(
    scope: WorkspaceScope,
    userId: string,
    actor: CapabilityCeilingAuditActor,
    input: { code: string; detail: string; requested?: readonly RepositoryCapability[] },
  ): void;
}

interface Row {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  user_id: string;
  ceiling: string;
  available_ceiling: string;
  state: string;
  reason: string | null;
  set_version: number;
  verified_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

/** Parse a stored capability array. Unknown entries are dropped, never trusted. */
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
  const out = parsed.filter(
    (value): value is RepositoryCapability => typeof value === "string" && known.has(value),
  );
  return REPOSITORY_CAPABILITIES.filter((capability) => out.includes(capability));
}

function serialize(capabilities: readonly RepositoryCapability[]): string {
  const known = new Set<string>(REPOSITORY_CAPABILITIES);
  return JSON.stringify(
    REPOSITORY_CAPABILITIES.filter(
      (capability) => known.has(capability) && capabilities.includes(capability),
    ),
  );
}

function toRecord(row: Row): MemberCapabilityCeiling {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    ceiling: parseCapabilities(row.ceiling),
    available_ceiling: parseCapabilities(row.available_ceiling),
    state: row.state as PersistedCeilingState,
    reason: row.reason,
    set_version: row.set_version,
    verified_at: row.verified_at,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

class SqliteMemberCapabilityRepository implements MemberCapabilityRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  get(scope: WorkspaceScope, userId: string): MemberCapabilityCeiling | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM workspace_member_capability
          WHERE enterprise_id = ? AND workspace_id = ? AND user_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, userId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(scope: WorkspaceScope): MemberCapabilityCeiling[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_member_capability
          WHERE enterprise_id = ? AND workspace_id = ?
          ORDER BY user_id`,
      )
      .all(scope.enterprise_id, scope.workspace_id) as unknown as Row[];
    return rows.map(toRecord);
  }

  initialize(
    scope: WorkspaceScope,
    userId: string,
    input: InitializeMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling {
    const existing = this.get(scope, userId);
    if (existing !== undefined) {
      return existing;
    }
    const now = nowIso();
    const id = newId("wmc");
    try {
      runInTransaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO workspace_member_capability
               (id, enterprise_id, workspace_id, user_id, ceiling, available_ceiling,
                state, reason, set_version, verified_at, version,
                created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            id,
            scope.enterprise_id,
            scope.workspace_id,
            userId,
            serialize(input.ceiling),
            serialize(input.available_ceiling),
            input.reason,
            input.set_version,
            input.verified_at,
            now,
            now,
            actor.actor_id,
            actor.actor_id,
          );
        this.#audit(scope, userId, actor, MEMBER_CAPABILITY_AUDIT_EVENTS.initialized, {
          ceiling: [...input.ceiling],
          available_ceiling: [...input.available_ceiling],
          set_version: input.set_version,
          verified_at: input.verified_at,
          reason: input.reason,
        });
      });
    } catch (error) {
      // A concurrent initializer won the unique index; its row is the truth.
      if (String(error).includes("UNIQUE")) {
        const row = this.get(scope, userId);
        if (row !== undefined) {
          return row;
        }
      }
      throw error;
    }
    return this.#require(scope, userId);
  }

  applyDowngrade(
    scope: WorkspaceScope,
    userId: string,
    input: ApplyMemberCapabilityDowngradeInput,
    actor: CapabilityCeilingAuditActor,
  ): { record: MemberCapabilityCeiling; applied: boolean } {
    const existing = this.#require(scope, userId);
    // Never raise here: a downgrade that would increase the ceiling is either a
    // provider recovery (record it as available, keep the ceiling) or a bug.
    const ceiling = existing.ceiling.filter((capability) => input.ceiling.includes(capability));
    const lowered = ceiling.length < existing.ceiling.length;
    const now = nowIso();
    let applied = false;
    try {
      runInTransaction(this.db, () => {
        const result = this.db
          .prepare(
            `UPDATE workspace_member_capability
                SET ceiling = ?, available_ceiling = ?, state = 'downgraded',
                    reason = ?, set_version = ?, verified_at = ?,
                    updated_at = ?, updated_by = ?, version = version + 1
              WHERE id = ? AND version = ?`,
          )
          .run(
            serialize(ceiling),
            serialize(input.available_ceiling),
            input.reason,
            input.set_version,
            input.verified_at,
            now,
            actor.actor_id,
            existing.id,
            input.expected_version,
          );
        if (Number(result.changes) === 0) {
          // A concurrent evaluator committed a stricter observation first. That is
          // the safe outcome: re-read and report that nothing new was applied.
          throw new ConcurrentObservationError();
        }
        applied = true;
        this.#audit(scope, userId, actor, MEMBER_CAPABILITY_AUDIT_EVENTS.downgraded, {
          before: existing.ceiling,
          after: ceiling,
          available_ceiling: [...input.available_ceiling],
          set_version: input.set_version,
          verified_at: input.verified_at,
          reason: input.reason,
          lowered,
        });
      });
    } catch (error) {
      if (!(error instanceof ConcurrentObservationError)) {
        throw error;
      }
    }
    return { record: this.#require(scope, userId), applied };
  }

  observeAvailability(
    scope: WorkspaceScope,
    userId: string,
    input: ObserveMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling {
    const existing = this.#require(scope, userId);
    const now = nowIso();
    runInTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE workspace_member_capability
              SET available_ceiling = ?, set_version = ?, verified_at = ?,
                  updated_at = ?, updated_by = ?, version = version + 1
            WHERE id = ? AND version = ?`,
        )
        .run(
          serialize(input.available_ceiling),
          input.set_version,
          input.verified_at,
          now,
          actor.actor_id,
          existing.id,
          input.expected_version,
        );
      if (Number(result.changes) === 0) {
        throw new ConcurrentObservationError();
      }
      this.#audit(scope, userId, actor, MEMBER_CAPABILITY_AUDIT_EVENTS.promotionObserved, {
        ceiling: existing.ceiling,
        available_ceiling: [...input.available_ceiling],
        set_version: input.set_version,
        verified_at: input.verified_at,
      });
    });
    return this.#require(scope, userId);
  }

  reapprove(
    scope: WorkspaceScope,
    userId: string,
    input: ReapproveMemberCapabilityInput,
    actor: CapabilityCeilingAuditActor,
  ): MemberCapabilityCeiling {
    const existing = this.#require(scope, userId);
    if (existing.version !== input.expected_version) {
      throw new VersionConflictError(
        "MemberCapabilityCeiling",
        existing.id,
        input.expected_version,
        existing.version,
      );
    }
    // The stored available ceiling must be the one the caller verified against:
    // a provider change between observation and approval invalidates the
    // decision instead of being silently approved on older facts.
    if (!sameCapabilities(existing.available_ceiling, input.available_ceiling)) {
      throw new CapabilityCeilingError(
        "CAPABILITY_CEILING_MISMATCH",
        "The member's verified capabilities changed since they were read; re-read before reapproving",
        409,
        {
          stored_available_ceiling: existing.available_ceiling,
          observed_available_ceiling: input.available_ceiling,
        },
      );
    }
    const now = nowIso();
    runInTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE workspace_member_capability
              SET ceiling = ?, available_ceiling = ?, state = 'approved',
                  reason = NULL, set_version = ?, verified_at = ?,
                  updated_at = ?, updated_by = ?, version = version + 1
            WHERE id = ? AND version = ?`,
        )
        .run(
          serialize(input.ceiling),
          serialize(input.available_ceiling),
          input.set_version,
          input.verified_at,
          now,
          actor.actor_id,
          existing.id,
          input.expected_version,
        );
      this.#audit(scope, userId, actor, MEMBER_CAPABILITY_AUDIT_EVENTS.reapproved, {
        before: existing.ceiling,
        after: [...input.ceiling],
        verified_available_ceiling: [...input.available_ceiling],
        set_version: input.set_version,
        verified_at: input.verified_at,
      });
    });
    return this.#require(scope, userId);
  }

  auditDenial(
    scope: WorkspaceScope,
    userId: string,
    actor: CapabilityCeilingAuditActor,
    input: { code: string; detail: string; requested?: readonly RepositoryCapability[] },
  ): void {
    this.#audit(scope, userId, actor, MEMBER_CAPABILITY_AUDIT_EVENTS.reapprovalDenied, {
      code: input.code,
      detail: input.detail,
      ...(input.requested !== undefined ? { requested: [...input.requested] } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #require(scope: WorkspaceScope, userId: string): MemberCapabilityCeiling {
    const row = this.get(scope, userId);
    if (row === undefined) {
      throw new NotFoundError("MemberCapabilityCeiling", `${scope.workspace_id}/${userId}`);
    }
    return row;
  }

  #audit(
    scope: WorkspaceScope,
    userId: string,
    actor: CapabilityCeilingAuditActor,
    event: string,
    details: Record<string, unknown>,
  ): void {
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
        event,
        scope.enterprise_id,
        actor.actor_kind ?? "user",
        actor.actor_kind === "deployment" ? null : (actor.actor_id ?? SYSTEM_ACTOR),
        userId,
        JSON.stringify({ workspace_id: scope.workspace_id, ...details }),
      );
  }
}

/** Thrown internally to roll back a losing concurrent observation. */
class ConcurrentObservationError extends Error {}

function sameCapabilities(
  a: readonly RepositoryCapability[],
  b: readonly RepositoryCapability[],
): boolean {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.length === sortedB.length && sortedA.every((value, i) => value === sortedB[i]);
}

export function createMemberCapabilityRepository(db: ControlPlaneDb): MemberCapabilityRepository {
  return new SqliteMemberCapabilityRepository(db);
}
