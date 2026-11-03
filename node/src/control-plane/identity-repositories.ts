/**
 * Identity, session, flow, and audit repositories.
 *
 * Same conventions as the scoped control-plane repositories: handlers consume
 * the interfaces and never write SQL. Single-use resources (OAuth flows,
 * desktop flows) are consumed with an atomic `UPDATE … WHERE consumed_at IS
 * NULL` guard, so concurrent callbacks/exchanges yield exactly one winner.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso } from "./db.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type {
  AppendAuthAuditInput,
  AppUser,
  AuthAuditFilter,
  AuthAuditRecord,
  AuthSession,
  AuthActorKind,
  CreateDesktopFlowInput,
  CreateIdentityInput,
  CreateOauthFlowInput,
  CreateSessionInput,
  CreateUserInput,
  DesktopAuthFlow,
  DesktopFlowStatus,
  EnterpriseRole,
  EnterpriseRoleName,
  GrantEnterpriseRoleInput,
  LoginProvider,
  OauthFlow,
  SessionKind,
  UserIdentity,
  UserStatus,
} from "./identity-types.js";
import type { EnterpriseId, ProviderInstanceId, UserId } from "./types.js";

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface UserRepository {
  create(input: CreateUserInput): AppUser;
  getById(id: UserId): AppUser | undefined;
  setStatus(id: UserId, status: UserStatus, actorId: UserId): AppUser;
}

export interface IdentityRepository {
  create(input: CreateIdentityInput): UserIdentity;
  getById(id: string): UserIdentity | undefined;
  /** The only account-match key: (provider instance, stable subject). */
  getByProviderSubject(
    providerInstanceId: ProviderInstanceId,
    subject: string,
  ): UserIdentity | undefined;
  listByUser(userId: UserId): UserIdentity[];
  /**
   * Enterprise ids where this user holds a provider identity — used to scope
   * who may administer (e.g. suspend) the user.
   */
  enterprisesOf(userId: UserId): EnterpriseId[];
}

export interface EnterpriseRoleRepository {
  /** Idempotent: re-granting the same role returns the existing row. */
  grant(input: GrantEnterpriseRoleInput): EnterpriseRole;
  getByUser(enterpriseId: EnterpriseId, userId: UserId): EnterpriseRole | undefined;
  listByUser(userId: UserId): EnterpriseRole[];
  listByEnterprise(enterpriseId: EnterpriseId): EnterpriseRole[];
  revoke(enterpriseId: EnterpriseId, userId: UserId): void;
}

export interface SessionRepository {
  create(input: CreateSessionInput): AuthSession;
  findByTokenHash(tokenHash: string): AuthSession | undefined;
  getById(id: string): AuthSession | undefined;
  revoke(id: string, reason: string): AuthSession;
  /** Revoke every live session of a user (suspension); returns the count. */
  revokeAllForUser(userId: UserId, reason: string): number;
  listByUser(userId: UserId): AuthSession[];
}

export interface OauthFlowRepository {
  create(input: CreateOauthFlowInput): OauthFlow;
  findByStateHash(stateHash: string): OauthFlow | undefined;
  /** Single-use: true only for the caller that atomically consumed the flow. */
  consume(id: string): boolean;
}

export interface DesktopFlowRepository {
  create(input: CreateDesktopFlowInput): DesktopAuthFlow;
  getById(id: string): DesktopAuthFlow | undefined;
  /** Mark a pending flow ready with the user the browser login bound to it. */
  markReady(id: string, userId: UserId): DesktopAuthFlow;
  /** Single-use consume; true only for the winning caller. */
  consume(id: string): boolean;
  /** Record a failed exchange attempt; returns the total attempt count. */
  recordFailedAttempt(id: string): number;
}

export interface AuthAuditRepository {
  append(input: AppendAuthAuditInput): AuthAuditRecord;
  list(filter?: AuthAuditFilter): AuthAuditRecord[];
}

/**
 * Unscoped read model of admin-approved provider instances for the anonymous
 * login surface. See {@link LoginProvider} for why this directory is the one
 * lookup without a scope argument.
 */
export interface LoginProviderDirectory {
  get(id: ProviderInstanceId): LoginProvider | undefined;
  list(): LoginProvider[];
}

export interface IdentityRepositories {
  users: UserRepository;
  identities: IdentityRepository;
  enterpriseRoles: EnterpriseRoleRepository;
  sessions: SessionRepository;
  oauthFlows: OauthFlowRepository;
  desktopFlows: DesktopFlowRepository;
  authAudit: AuthAuditRepository;
  loginProviders: LoginProviderDirectory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time equality for hex digests or short secrets. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Compare against self so the timing profile does not reveal length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function requireRow<T>(entity: string, id: string, row: T | undefined | null): T {
  if (row === undefined || row === null) {
    throw new NotFoundError(entity, id);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Row → entity mappers
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

function toUser(row: UserRow): AppUser {
  return {
    id: row.id,
    display_name: row.display_name,
    status: row.status as UserStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    version: row.version,
  };
}

interface IdentityRow {
  id: string;
  user_id: string;
  provider_instance_id: string;
  subject: string;
  login: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

function toIdentity(row: IdentityRow): UserIdentity {
  return {
    id: row.id,
    user_id: row.user_id,
    provider_instance_id: row.provider_instance_id,
    subject: row.subject,
    login: row.login,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

interface EnterpriseRoleRow {
  id: string;
  enterprise_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

function toEnterpriseRole(row: EnterpriseRoleRow): EnterpriseRole {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    user_id: row.user_id,
    role: row.role as EnterpriseRoleName,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  kind: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  user_agent: string | null;
}

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind as SessionKind,
    token_hash: row.token_hash,
    csrf_token: row.csrf_token,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    user_agent: row.user_agent,
  };
}

interface OauthFlowRow {
  id: string;
  kind: string;
  provider_instance_id: string;
  state_hash: string;
  binding_hash: string;
  pkce_verifier: string;
  redirect_uri: string;
  return_to: string;
  desktop_flow_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function toOauthFlow(row: OauthFlowRow): OauthFlow {
  return {
    id: row.id,
    kind: row.kind as SessionKind,
    provider_instance_id: row.provider_instance_id,
    state_hash: row.state_hash,
    binding_hash: row.binding_hash,
    pkce_verifier: row.pkce_verifier,
    redirect_uri: row.redirect_uri,
    return_to: row.return_to,
    desktop_flow_id: row.desktop_flow_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

interface DesktopFlowRow {
  id: string;
  secret_hash: string;
  status: string;
  user_id: string | null;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function toDesktopFlow(row: DesktopFlowRow): DesktopAuthFlow {
  return {
    id: row.id,
    secret_hash: row.secret_hash,
    status: row.status as DesktopFlowStatus,
    user_id: row.user_id,
    attempts: row.attempts,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

interface AuditRow {
  id: string;
  at: string;
  event: string;
  enterprise_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  provider_instance_id: string | null;
  details: string;
}

function toAuditRecord(row: AuditRow): AuthAuditRecord {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(row.details) as Record<string, unknown>;
  } catch {
    details = {};
  }
  return {
    id: row.id,
    at: row.at,
    event: row.event,
    enterprise_id: row.enterprise_id,
    actor_kind: row.actor_kind as AuthActorKind,
    actor_user_id: row.actor_user_id,
    subject_user_id: row.subject_user_id,
    provider_instance_id: row.provider_instance_id,
    details,
  };
}

// ---------------------------------------------------------------------------
// Repository implementations
// ---------------------------------------------------------------------------

class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateUserInput): AppUser {
    const at = nowIso();
    const id = newId("usr");
    this.db
      .prepare(
        `INSERT INTO app_user (id, display_name, status, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(id, input.display_name, at, at, input.actor_id, input.actor_id);
    return requireRow("user", id, this.getById(id));
  }

  getById(id: UserId): AppUser | undefined {
    const row = this.db.prepare("SELECT * FROM app_user WHERE id = ?").get(id) as
      UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  setStatus(id: UserId, status: UserStatus, actorId: UserId): AppUser {
    const at = nowIso();
    const result = this.db
      .prepare(
        `UPDATE app_user SET status = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(status, at, actorId, id);
    if (result.changes === 0) {
      throw new NotFoundError("user", id);
    }
    return requireRow("user", id, this.getById(id));
  }
}

class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateIdentityInput): UserIdentity {
    const existing = this.getByProviderSubject(input.provider_instance_id, input.subject);
    if (existing) {
      throw new ConflictError("an identity already exists for this provider instance and subject", {
        provider_instance_id: input.provider_instance_id,
        subject: input.subject,
      });
    }
    const at = nowIso();
    const id = newId("idn");
    this.db
      .prepare(
        `INSERT INTO user_identity
           (id, user_id, provider_instance_id, subject, login, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.user_id,
        input.provider_instance_id,
        input.subject,
        input.login,
        at,
        at,
        input.actor_id,
        input.actor_id,
      );
    return requireRow("identity", id, this.getById(id));
  }

  getById(id: string): UserIdentity | undefined {
    const row = this.db.prepare("SELECT * FROM user_identity WHERE id = ?").get(id) as
      IdentityRow | undefined;
    return row ? toIdentity(row) : undefined;
  }

  getByProviderSubject(
    providerInstanceId: ProviderInstanceId,
    subject: string,
  ): UserIdentity | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_identity WHERE provider_instance_id = ? AND subject = ?")
      .get(providerInstanceId, subject) as IdentityRow | undefined;
    return row ? toIdentity(row) : undefined;
  }

  listByUser(userId: UserId): UserIdentity[] {
    const rows = this.db
      .prepare("SELECT * FROM user_identity WHERE user_id = ? ORDER BY created_at")
      .all(userId) as unknown as IdentityRow[];
    return rows.map(toIdentity);
  }

  enterprisesOf(userId: UserId): EnterpriseId[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT pi.enterprise_id AS enterprise_id
         FROM user_identity ui
         JOIN provider_instance pi ON pi.id = ui.provider_instance_id
         WHERE ui.user_id = ?`,
      )
      .all(userId) as Array<{ enterprise_id: string }>;
    return rows.map((row) => row.enterprise_id);
  }
}

class SqliteEnterpriseRoleRepository implements EnterpriseRoleRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  grant(input: GrantEnterpriseRoleInput): EnterpriseRole {
    const existing = this.getByUser(input.enterprise_id, input.user_id);
    if (existing) {
      if (existing.role === input.role) {
        return existing;
      }
      throw new ConflictError("enterprise role already granted with a different role", {
        enterprise_id: input.enterprise_id,
        user_id: input.user_id,
      });
    }
    const at = nowIso();
    const id = newId("erl");
    this.db
      .prepare(
        `INSERT INTO enterprise_role
           (id, enterprise_id, user_id, role, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.enterprise_id,
        input.user_id,
        input.role,
        at,
        at,
        input.actor_id,
        input.actor_id,
      );
    return requireRow("enterprise role", id, this.getByUser(input.enterprise_id, input.user_id));
  }

  getByUser(enterpriseId: EnterpriseId, userId: UserId): EnterpriseRole | undefined {
    const row = this.db
      .prepare("SELECT * FROM enterprise_role WHERE enterprise_id = ? AND user_id = ?")
      .get(enterpriseId, userId) as EnterpriseRoleRow | undefined;
    return row ? toEnterpriseRole(row) : undefined;
  }

  listByUser(userId: UserId): EnterpriseRole[] {
    const rows = this.db
      .prepare("SELECT * FROM enterprise_role WHERE user_id = ? ORDER BY created_at")
      .all(userId) as unknown as EnterpriseRoleRow[];
    return rows.map(toEnterpriseRole);
  }

  listByEnterprise(enterpriseId: EnterpriseId): EnterpriseRole[] {
    const rows = this.db
      .prepare("SELECT * FROM enterprise_role WHERE enterprise_id = ? ORDER BY created_at")
      .all(enterpriseId) as unknown as EnterpriseRoleRow[];
    return rows.map(toEnterpriseRole);
  }

  revoke(enterpriseId: EnterpriseId, userId: UserId): void {
    const result = this.db
      .prepare("DELETE FROM enterprise_role WHERE enterprise_id = ? AND user_id = ?")
      .run(enterpriseId, userId);
    if (result.changes === 0) {
      throw new NotFoundError("enterprise role", `${enterpriseId}:${userId}`);
    }
  }
}

class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateSessionInput): AuthSession {
    const at = nowIso();
    const id = newId("ses");
    this.db
      .prepare(
        `INSERT INTO auth_session
           (id, user_id, kind, token_hash, csrf_token, created_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.user_id,
        input.kind,
        input.token_hash,
        input.csrf_token,
        at,
        input.expires_at,
        input.user_agent ?? null,
      );
    return requireRow("session", id, this.getById(id));
  }

  findByTokenHash(tokenHash: string): AuthSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_session WHERE token_hash = ?")
      .get(tokenHash) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  getById(id: string): AuthSession | undefined {
    const row = this.db.prepare("SELECT * FROM auth_session WHERE id = ?").get(id) as
      SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  revoke(id: string, reason: string): AuthSession {
    const at = nowIso();
    const result = this.db
      .prepare(
        `UPDATE auth_session SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(at, reason, id);
    if (result.changes === 0) {
      // Either missing or already revoked; both end at a revoked session.
      return requireRow("session", id, this.getById(id));
    }
    return requireRow("session", id, this.getById(id));
  }

  revokeAllForUser(userId: UserId, reason: string): number {
    const at = nowIso();
    const result = this.db
      .prepare(
        `UPDATE auth_session SET revoked_at = ?, revoked_reason = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .run(at, reason, userId);
    return Number(result.changes);
  }

  listByUser(userId: UserId): AuthSession[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_session WHERE user_id = ? ORDER BY created_at")
      .all(userId) as unknown as SessionRow[];
    return rows.map(toSession);
  }
}

class SqliteOauthFlowRepository implements OauthFlowRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateOauthFlowInput): OauthFlow {
    const at = nowIso();
    const id = newId("oaf");
    this.db
      .prepare(
        `INSERT INTO oauth_flow
           (id, kind, provider_instance_id, state_hash, binding_hash, pkce_verifier,
            redirect_uri, return_to, desktop_flow_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.provider_instance_id,
        input.state_hash,
        input.binding_hash,
        input.pkce_verifier,
        input.redirect_uri,
        input.return_to,
        input.desktop_flow_id ?? null,
        at,
        input.expires_at,
      );
    return requireRow("oauth flow", id, this.findByStateHash(input.state_hash));
  }

  findByStateHash(stateHash: string): OauthFlow | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_flow WHERE state_hash = ?").get(stateHash) as
      OauthFlowRow | undefined;
    return row ? toOauthFlow(row) : undefined;
  }

  consume(id: string): boolean {
    const result = this.db
      .prepare("UPDATE oauth_flow SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(nowIso(), id);
    return Number(result.changes) === 1;
  }
}

class SqliteDesktopFlowRepository implements DesktopFlowRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(input: CreateDesktopFlowInput): DesktopAuthFlow {
    const at = nowIso();
    const id = newId("dsk");
    this.db
      .prepare(
        `INSERT INTO desktop_auth_flow (id, secret_hash, status, created_at, expires_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(id, input.secret_hash, at, input.expires_at);
    return requireRow("desktop flow", id, this.getById(id));
  }

  getById(id: string): DesktopAuthFlow | undefined {
    const row = this.db.prepare("SELECT * FROM desktop_auth_flow WHERE id = ?").get(id) as
      DesktopFlowRow | undefined;
    return row ? toDesktopFlow(row) : undefined;
  }

  markReady(id: string, userId: UserId): DesktopAuthFlow {
    const result = this.db
      .prepare(
        `UPDATE desktop_auth_flow SET status = 'ready', user_id = ?
         WHERE id = ? AND status = 'pending' AND consumed_at IS NULL`,
      )
      .run(userId, id);
    if (result.changes === 0) {
      throw new ConflictError("desktop auth flow is not pending", { desktop_flow_id: id });
    }
    return requireRow("desktop flow", id, this.getById(id));
  }

  consume(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE desktop_auth_flow SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND status = 'ready' AND consumed_at IS NULL`,
      )
      .run(nowIso(), id);
    return Number(result.changes) === 1;
  }

  recordFailedAttempt(id: string): number {
    this.db.prepare("UPDATE desktop_auth_flow SET attempts = attempts + 1 WHERE id = ?").run(id);
    const row = this.getById(id);
    return row?.attempts ?? 0;
  }
}

class SqliteAuthAuditRepository implements AuthAuditRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  append(input: AppendAuthAuditInput): AuthAuditRecord {
    const at = nowIso();
    const id = newId("aud");
    this.db
      .prepare(
        `INSERT INTO auth_audit
           (id, at, event, enterprise_id, actor_kind, actor_user_id, subject_user_id,
            provider_instance_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        at,
        input.event,
        input.enterprise_id ?? null,
        input.actor_kind,
        input.actor_user_id ?? null,
        input.subject_user_id ?? null,
        input.provider_instance_id ?? null,
        JSON.stringify(input.details ?? {}),
      );
    const row = this.db.prepare("SELECT * FROM auth_audit WHERE id = ?").get(id) as
      AuditRow | undefined;
    return requireRow("audit record", id, row ? toAuditRecord(row) : undefined);
  }

  list(filter: AuthAuditFilter = {}): AuthAuditRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.enterprise_id !== undefined) {
      clauses.push("enterprise_id = ?");
      params.push(filter.enterprise_id);
    }
    if (filter.event !== undefined) {
      clauses.push("event = ?");
      params.push(filter.event);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM auth_audit ${where} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as unknown as AuditRow[];
    return rows.map(toAuditRecord);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface LoginProviderRow {
  id: string;
  enterprise_id: string;
  provider_type: string;
  origin_url: string;
}

class SqliteLoginProviderDirectory implements LoginProviderDirectory {
  constructor(private readonly db: ControlPlaneDb) {}

  get(id: ProviderInstanceId): LoginProvider | undefined {
    const row = this.db.prepare("SELECT * FROM provider_instance WHERE id = ?").get(id) as
      LoginProviderRow | undefined;
    return row
      ? {
          id: row.id,
          enterprise_id: row.enterprise_id,
          provider_type: row.provider_type as LoginProvider["provider_type"],
          origin_url: row.origin_url,
        }
      : undefined;
  }

  list(): LoginProvider[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_instance ORDER BY created_at")
      .all() as unknown as LoginProviderRow[];
    return rows.map((row) => ({
      id: row.id,
      enterprise_id: row.enterprise_id,
      provider_type: row.provider_type as LoginProvider["provider_type"],
      origin_url: row.origin_url,
    }));
  }
}

export function createIdentityRepositories(db: ControlPlaneDb): IdentityRepositories {
  return {
    users: new SqliteUserRepository(db),
    identities: new SqliteIdentityRepository(db),
    enterpriseRoles: new SqliteEnterpriseRoleRepository(db),
    sessions: new SqliteSessionRepository(db),
    oauthFlows: new SqliteOauthFlowRepository(db),
    desktopFlows: new SqliteDesktopFlowRepository(db),
    authAudit: new SqliteAuthAuditRepository(db),
    loginProviders: new SqliteLoginProviderDirectory(db),
  };
}
