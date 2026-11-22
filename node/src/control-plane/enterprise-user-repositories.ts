/**
 * Enterprise user storage (DAT-275, ADR-0011).
 *
 * Every state change that can affect authorization writes its audit row in the
 * same SQLite transaction as the change: a failed required audit rolls the
 * change back instead of leaving an unaudited membership. The last active
 * enterprise administrator is protected inside `BEGIN IMMEDIATE` transactions,
 * so concurrent suspensions/demotions cannot remove every administrator.
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso, runInTransaction } from "./db.js";
import { NotFoundError } from "./errors.js";
import type {
  AddEnterpriseUserInput,
  AddEnterpriseUserResult,
  EnterpriseUser,
  EnterpriseUserIdentity,
  EnterpriseUserStatus,
  EnterpriseUserUpdateResult,
  EnsureEnterpriseUserResult,
} from "./enterprise-user-types.js";
import type { EnterpriseId, ProviderInstanceId, UserId } from "./types.js";

const PAGE_SIZE = 50;

export interface EnterpriseUserListFilter {
  status?: EnterpriseUserStatus;
  cursor?: string | null;
}

export interface EnterpriseUserPage {
  items: EnterpriseUser[];
  next_cursor: string | null;
  /** True when the supplied opaque cursor is not a row in this scope. */
  invalid_cursor?: boolean;
}

export interface EnterpriseUserRepository {
  getById(enterpriseId: EnterpriseId, id: string): EnterpriseUser | undefined;
  getByUser(enterpriseId: EnterpriseId, userId: UserId): EnterpriseUser | undefined;
  list(enterpriseId: EnterpriseId, filter?: EnterpriseUserListFilter): EnterpriseUserPage;
  listIdentities(enterpriseUserId: string): EnterpriseUserIdentity[];
  /**
   * Idempotently add an approved provider subject. If the subject already has
   * a signed-in user, the membership is created active and bound at once;
   * otherwise it is `pending_claim` and no login secret is stored.
   */
  add(input: AddEnterpriseUserInput): AddEnterpriseUserResult;
  /**
   * Bind every pending membership for this (provider instance, subject) to the
   * user a matching OAuth login resolved. Atomic and concurrency-safe; a
   * suspended membership stays suspended (login is not reactivation).
   */
  claim(providerInstanceId: ProviderInstanceId, subject: string, userId: UserId): EnterpriseUser[];
  /** Suspend or restore one membership, guarded by version and last admin. */
  setStatus(
    enterpriseId: EnterpriseId,
    id: string,
    status: "active" | "suspended",
    expectedVersion: number,
    actorId: UserId,
  ): EnterpriseUserUpdateResult;
  /** Grant or revoke enterprise administration for a claimed member. */
  setRole(
    enterpriseId: EnterpriseId,
    id: string,
    role: "admin" | "member",
    expectedVersion: number,
    actorId: UserId,
  ): EnterpriseUserUpdateResult;
  /**
   * Explicit administrator action (workspace grant or invitation redemption)
   * that requires an active enterprise membership. Never reactivates a
   * suspended membership; the caller decides how to surface that.
   */
  ensureActive(
    enterpriseId: EnterpriseId,
    userId: UserId,
    actorId: UserId,
    providerBinding?: { provider_instance_id: ProviderInstanceId; subject: string },
  ): EnsureEnterpriseUserResult;
  /** Active memberships with enterprise administration, for the last-admin guard. */
  countActiveAdmins(enterpriseId: EnterpriseId): number;
}

interface EnterpriseUserRow {
  id: string;
  enterprise_id: string;
  user_id: string | null;
  status: string;
  version: number;
  claimed_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

interface EnterpriseUserIdentityRow {
  id: string;
  enterprise_id: string;
  enterprise_user_id: string;
  provider_instance_id: string;
  subject: string;
  created_at: string;
  created_by: string;
}

function toEnterpriseUser(row: EnterpriseUserRow): EnterpriseUser {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    user_id: row.user_id,
    status: row.status as EnterpriseUserStatus,
    version: row.version,
    claimed_at: row.claimed_at,
    suspended_at: row.suspended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function toIdentity(row: EnterpriseUserIdentityRow): EnterpriseUserIdentity {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    enterprise_user_id: row.enterprise_user_id,
    provider_instance_id: row.provider_instance_id,
    subject: row.subject,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

class SqliteEnterpriseUserRepository implements EnterpriseUserRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  getById(enterpriseId: EnterpriseId, id: string): EnterpriseUser | undefined {
    const row = this.db
      .prepare("SELECT * FROM enterprise_user WHERE enterprise_id = ? AND id = ?")
      .get(enterpriseId, id) as EnterpriseUserRow | undefined;
    return row ? toEnterpriseUser(row) : undefined;
  }

  getByUser(enterpriseId: EnterpriseId, userId: UserId): EnterpriseUser | undefined {
    const row = this.db
      .prepare("SELECT * FROM enterprise_user WHERE enterprise_id = ? AND user_id = ?")
      .get(enterpriseId, userId) as EnterpriseUserRow | undefined;
    return row ? toEnterpriseUser(row) : undefined;
  }

  list(enterpriseId: EnterpriseId, filter: EnterpriseUserListFilter = {}): EnterpriseUserPage {
    const rows = (filter.status === undefined
      ? this.db
          .prepare(
            `SELECT * FROM enterprise_user WHERE enterprise_id = ?
               ORDER BY created_at, id`,
          )
          .all(enterpriseId)
      : this.db
          .prepare(
            `SELECT * FROM enterprise_user WHERE enterprise_id = ? AND status = ?
               ORDER BY created_at, id`,
          )
          .all(enterpriseId, filter.status)) as unknown as EnterpriseUserRow[];
    const items = rows.map(toEnterpriseUser);
    let start = 0;
    if (filter.cursor !== undefined && filter.cursor !== null) {
      const index = items.findIndex((item) => item.id === filter.cursor);
      if (index === -1) {
        return { items: [], next_cursor: null, invalid_cursor: true };
      }
      start = index + 1;
    }
    const page = items.slice(start, start + PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      items: page,
      next_cursor: last !== undefined && start + page.length < items.length ? last.id : null,
    };
  }

  listIdentities(enterpriseUserId: string): EnterpriseUserIdentity[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM enterprise_user_identity WHERE enterprise_user_id = ? ORDER BY created_at, id",
      )
      .all(enterpriseUserId) as unknown as EnterpriseUserIdentityRow[];
    return rows.map(toIdentity);
  }

  add(input: AddEnterpriseUserInput): AddEnterpriseUserResult {
    return runInTransaction(this.db, () => {
      const existing = this.#findByIdentity(
        input.enterprise_id,
        input.provider_instance_id,
        input.subject,
      );
      if (existing !== undefined) {
        return { user: existing, created: false };
      }
      // The user_identity table is the only "has signed in" evidence, and it
      // is read in this transaction so a concurrent login cannot race the
      // add into a pending row.
      const identity = this.db
        .prepare("SELECT user_id FROM user_identity WHERE provider_instance_id = ? AND subject = ?")
        .get(input.provider_instance_id, input.subject) as { user_id: string } | undefined;
      let membership =
        identity !== undefined ? this.getByUser(input.enterprise_id, identity.user_id) : undefined;
      let created = false;
      const at = nowIso();
      if (membership === undefined) {
        const id = newId("eum");
        this.db
          .prepare(
            `INSERT INTO enterprise_user
               (id, enterprise_id, user_id, status, version, claimed_at, suspended_at,
                created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.enterprise_id,
            identity?.user_id ?? null,
            identity !== undefined ? "active" : "pending_claim",
            identity !== undefined ? at : null,
            at,
            at,
            input.actor_id,
            input.actor_id,
          );
        membership = this.getById(input.enterprise_id, id);
        created = true;
      }
      if (membership === undefined) {
        throw new NotFoundError("enterprise user", input.subject);
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO enterprise_user_identity
             (id, enterprise_id, enterprise_user_id, provider_instance_id, subject,
              created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("eui"),
          input.enterprise_id,
          membership.id,
          input.provider_instance_id,
          input.subject,
          at,
          input.actor_id,
        );
      if (created) {
        this.#audit({
          event: "enterprise_user.added",
          enterprise_id: input.enterprise_id,
          actor_user_id: input.actor_id,
          subject_user_id: membership.user_id ?? undefined,
          provider_instance_id: input.provider_instance_id,
          details: { enterprise_user_id: membership.id, status: membership.status },
        });
      }
      return { user: membership, created };
    });
  }

  claim(providerInstanceId: ProviderInstanceId, subject: string, userId: UserId): EnterpriseUser[] {
    return runInTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT eu.*, eui.id AS binding_id
           FROM enterprise_user_identity eui
           JOIN enterprise_user eu ON eu.id = eui.enterprise_user_id
           WHERE eui.provider_instance_id = ? AND eui.subject = ?`,
        )
        .all(providerInstanceId, subject) as unknown as Array<
        EnterpriseUserRow & { binding_id: string }
      >;
      const claimed: EnterpriseUser[] = [];
      const at = nowIso();
      for (const row of rows) {
        if (row.user_id === userId) {
          continue;
        }
        if (row.user_id !== null) {
          // A provider subject maps to exactly one app_user; a different bound
          // user here is inconsistent state. Never rebind silently.
          continue;
        }
        const existing = this.getByUser(row.enterprise_id, userId);
        if (existing !== undefined && existing.id !== row.id) {
          // The person already holds a membership in this enterprise under
          // another provider identity: move the binding, never merge accounts.
          this.db
            .prepare("UPDATE enterprise_user_identity SET enterprise_user_id = ? WHERE id = ?")
            .run(existing.id, row.binding_id);
          this.db.prepare("DELETE FROM enterprise_user WHERE id = ?").run(row.id);
          this.#audit({
            event: "enterprise_user.claimed",
            enterprise_id: row.enterprise_id,
            actor_user_id: userId,
            subject_user_id: userId,
            provider_instance_id: providerInstanceId,
            details: { enterprise_user_id: existing.id, merged_binding: row.binding_id },
          });
          claimed.push(existing);
          continue;
        }
        const result = this.db
          .prepare(
            `UPDATE enterprise_user
             SET user_id = ?, status = CASE WHEN status = 'pending_claim' THEN 'active' ELSE status END,
                 claimed_at = ?, updated_at = ?, updated_by = ?, version = version + 1
             WHERE id = ? AND user_id IS NULL`,
          )
          .run(userId, at, at, userId, row.id);
        if (Number(result.changes) !== 1) {
          continue;
        }
        const updated = this.getById(row.enterprise_id, row.id);
        if (updated === undefined) {
          continue;
        }
        this.#audit({
          event: "enterprise_user.claimed",
          enterprise_id: row.enterprise_id,
          actor_user_id: userId,
          subject_user_id: userId,
          provider_instance_id: providerInstanceId,
          details: { enterprise_user_id: row.id, status: updated.status },
        });
        claimed.push(updated);
      }
      return claimed;
    });
  }

  setStatus(
    enterpriseId: EnterpriseId,
    id: string,
    status: "active" | "suspended",
    expectedVersion: number,
    actorId: UserId,
  ): EnterpriseUserUpdateResult {
    return runInTransaction(this.db, () => {
      const row = this.getById(enterpriseId, id);
      if (row === undefined) {
        throw new NotFoundError("enterprise user", id);
      }
      if (row.status === status) {
        return { status: "ok", user: row };
      }
      if (row.version !== expectedVersion) {
        return { status: "version_conflict", actual_version: row.version };
      }
      if (
        status === "suspended" &&
        row.user_id !== null &&
        this.#holdsAdminRole(enterpriseId, row.user_id) &&
        this.#countActiveAdmins(enterpriseId, row.user_id) === 0
      ) {
        return { status: "last_admin" };
      }
      const at = nowIso();
      const nextStatus =
        status === "suspended" ? "suspended" : row.user_id === null ? "pending_claim" : "active";
      this.db
        .prepare(
          `UPDATE enterprise_user
           SET status = ?, suspended_at = ?, updated_at = ?, updated_by = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(nextStatus, status === "suspended" ? at : null, at, actorId, id, expectedVersion);
      const updated = this.getById(enterpriseId, id);
      if (updated === undefined) {
        throw new NotFoundError("enterprise user", id);
      }
      this.#audit({
        event: status === "suspended" ? "enterprise_user.suspended" : "enterprise_user.restored",
        enterprise_id: enterpriseId,
        actor_user_id: actorId,
        subject_user_id: row.user_id ?? undefined,
        details: { enterprise_user_id: id, status: nextStatus },
      });
      return { status: "ok", user: updated };
    });
  }

  setRole(
    enterpriseId: EnterpriseId,
    id: string,
    role: "admin" | "member",
    expectedVersion: number,
    actorId: UserId,
  ): EnterpriseUserUpdateResult {
    return runInTransaction(this.db, () => {
      const row = this.getById(enterpriseId, id);
      if (row === undefined) {
        throw new NotFoundError("enterprise user", id);
      }
      if (row.user_id === null) {
        return { status: "not_claimed" };
      }
      const current = this.#holdsAdminRole(enterpriseId, row.user_id);
      if (role === "admin" && current) {
        return { status: "ok", user: row };
      }
      if (role === "member" && !current) {
        return { status: "ok", user: row };
      }
      if (row.version !== expectedVersion) {
        return { status: "version_conflict", actual_version: row.version };
      }
      if (
        role === "member" &&
        current &&
        this.#countActiveAdmins(enterpriseId, row.user_id) === 0
      ) {
        return { status: "last_admin" };
      }
      const at = nowIso();
      if (role === "admin") {
        this.db
          .prepare(
            `INSERT INTO enterprise_role
               (id, enterprise_id, user_id, role, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)`,
          )
          .run(newId("erl"), enterpriseId, row.user_id, at, at, actorId, actorId);
      } else {
        this.db
          .prepare("DELETE FROM enterprise_role WHERE enterprise_id = ? AND user_id = ?")
          .run(enterpriseId, row.user_id);
      }
      this.db
        .prepare(
          `UPDATE enterprise_user SET updated_at = ?, updated_by = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(at, actorId, id, expectedVersion);
      const updated = this.getById(enterpriseId, id);
      if (updated === undefined) {
        throw new NotFoundError("enterprise user", id);
      }
      this.#audit({
        event: "enterprise_user.role_changed",
        enterprise_id: enterpriseId,
        actor_user_id: actorId,
        subject_user_id: row.user_id,
        details: { enterprise_user_id: id, role },
      });
      return { status: "ok", user: updated };
    });
  }

  ensureActive(
    enterpriseId: EnterpriseId,
    userId: UserId,
    actorId: UserId,
    providerBinding?: { provider_instance_id: ProviderInstanceId; subject: string },
  ): EnsureEnterpriseUserResult {
    return runInTransaction(this.db, () => {
      const existing = this.getByUser(enterpriseId, userId);
      if (existing !== undefined) {
        if (existing.status === "suspended") {
          return { user: existing, created: false, suspended: true };
        }
        return { user: existing, created: false, suspended: false };
      }
      const at = nowIso();
      const id = newId("eum");
      this.db
        .prepare(
          `INSERT INTO enterprise_user
             (id, enterprise_id, user_id, status, version, claimed_at, suspended_at,
              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, 'active', 1, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(id, enterpriseId, userId, at, at, at, actorId, actorId);
      if (providerBinding !== undefined) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO enterprise_user_identity
               (id, enterprise_id, enterprise_user_id, provider_instance_id, subject,
                created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId("eui"),
            enterpriseId,
            id,
            providerBinding.provider_instance_id,
            providerBinding.subject,
            at,
            actorId,
          );
      }
      const created = this.getById(enterpriseId, id);
      if (created === undefined) {
        throw new NotFoundError("enterprise user", id);
      }
      this.#audit({
        event: "enterprise_user.added",
        enterprise_id: enterpriseId,
        actor_user_id: actorId,
        subject_user_id: userId,
        ...(providerBinding !== undefined
          ? { provider_instance_id: providerBinding.provider_instance_id }
          : {}),
        details: { enterprise_user_id: id, status: "active" },
      });
      return { user: created, created: true, suspended: false };
    });
  }

  countActiveAdmins(enterpriseId: EnterpriseId): number {
    return this.#countActiveAdmins(enterpriseId, null);
  }

  #countActiveAdmins(enterpriseId: EnterpriseId, excludeUserId: UserId | null): number {
    const row =
      excludeUserId === null
        ? (this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM enterprise_role er
               JOIN enterprise_user eu
                 ON eu.enterprise_id = er.enterprise_id AND eu.user_id = er.user_id
               WHERE er.enterprise_id = ? AND eu.status = 'active'`,
            )
            .get(enterpriseId) as { count: number } | undefined)
        : (this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM enterprise_role er
               JOIN enterprise_user eu
                 ON eu.enterprise_id = er.enterprise_id AND eu.user_id = er.user_id
               WHERE er.enterprise_id = ? AND eu.status = 'active' AND er.user_id <> ?`,
            )
            .get(enterpriseId, excludeUserId) as { count: number } | undefined);
    return row?.count ?? 0;
  }

  #holdsAdminRole(enterpriseId: EnterpriseId, userId: UserId): boolean {
    const row = this.db
      .prepare("SELECT role FROM enterprise_role WHERE enterprise_id = ? AND user_id = ?")
      .get(enterpriseId, userId) as { role: string } | undefined;
    return row?.role === "admin";
  }

  #findByIdentity(
    enterpriseId: EnterpriseId,
    providerInstanceId: ProviderInstanceId,
    subject: string,
  ): EnterpriseUser | undefined {
    const row = this.db
      .prepare(
        `SELECT eu.* FROM enterprise_user eu
         JOIN enterprise_user_identity eui ON eui.enterprise_user_id = eu.id
         WHERE eui.enterprise_id = ? AND eui.provider_instance_id = ? AND eui.subject = ?`,
      )
      .get(enterpriseId, providerInstanceId, subject) as EnterpriseUserRow | undefined;
    return row ? toEnterpriseUser(row) : undefined;
  }

  #audit(input: {
    event: string;
    enterprise_id: EnterpriseId;
    actor_user_id: UserId;
    subject_user_id?: UserId;
    provider_instance_id?: ProviderInstanceId;
    details: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_audit
           (id, at, event, enterprise_id, actor_kind, actor_user_id, subject_user_id,
            provider_instance_id, details)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
      )
      .run(
        newId("aud"),
        nowIso(),
        input.event,
        input.enterprise_id,
        input.actor_user_id,
        input.subject_user_id ?? null,
        input.provider_instance_id ?? null,
        JSON.stringify(input.details),
      );
  }
}

export function createEnterpriseUserRepository(db: ControlPlaneDb): EnterpriseUserRepository {
  return new SqliteEnterpriseUserRepository(db);
}
