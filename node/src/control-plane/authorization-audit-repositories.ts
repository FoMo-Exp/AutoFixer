/**
 * Authorization denial audit and trend reads (DAT-296, ADR-0011).
 *
 * ## What this is
 *
 * Every authorization refusal on a protected runtime path appends exactly one
 * record to the existing append-only `auth_audit` trail. The row names the
 * operation's actor, the workspace, the action, the action's immutable target
 * identity (when one applied), the repository-set version the decision was
 * formed against, the authorization-context schema and this build's schema
 * version, and the stable safe refusal code. It never contains a credential, a
 * provider URL or name, a task/issue body, a diff or any other protected
 * content.
 *
 * ## Why denials only
 *
 * Successful sensitive mutations already commit their own required audit row
 * in the domain transaction that performs them (membership changes, ceiling
 * reapprovals, repository-set changes, deliveries). The authorization boundary
 * adds the facts those domains never see: requests that were *refused*, and
 * the reason. Recording every allowed read would add write amplification
 * without new evidence; recording the refusal is what makes an abnormal denial
 * trend observable.
 *
 * ## Append-only
 *
 * Migration v23 installs `BEFORE UPDATE` / `BEFORE DELETE` triggers on
 * `auth_audit`, so the trail is append-only at the storage layer, not only by
 * convention. A failed audit write propagates: a sensitive action whose
 * refusal cannot be recorded is still refused (the error is never swallowed
 * into an allow).
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso, readSchemaVersion } from "./db.js";
import type { WorkspaceScope } from "./types.js";

/** The one event this boundary appends. Other audit events keep their names. */
export const AUTHORIZATION_DENIED_EVENT = "authorization.denied";

export const AUTHORIZATION_DENIAL_WINDOW_MIN_MS = 60 * 1000;
export const AUTHORIZATION_DENIAL_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Immutable identity of the repository a refused action would have touched. */
export interface AuthorizationAuditTarget {
  provider_instance_id: string;
  repository_id: string;
}

/**
 * One refusal. Every field is a stable identifier, an enumerated code or a
 * numeric version — never free-form provider text or user content.
 */
export interface AuthorizationDenialInput {
  enterprise_id: string;
  workspace_id: string;
  /** A session user, or the deployment's own credential. */
  actor_kind: "user" | "deployment";
  actor_user_id: string | null;
  action: string;
  /** Safe decision code (`AUTHORITY_RECHECK_REQUIRED`, `CAPABILITY_LOSS`, ...). */
  decision_code: string;
  reason: string | null;
  capability_reason: string | null;
  required_capability: string | null;
  requires_reconciliation: boolean;
  target: AuthorizationAuditTarget | null;
  /** The repository-set version the decision was formed against, if readable. */
  repository_set_version: number | null;
  /** The versioned-context schema this build evaluated with. */
  context_schema_version: number | null;
  /** This build's known schema version. */
  build_schema_version: number;
  /** Override for tests/replay; defaults to the current time. */
  at?: string;
}

/** One recorded refusal, as read back for evidence. */
export interface AuthorizationDenialRecord {
  id: string;
  at: string;
  enterprise_id: string;
  workspace_id: string;
  actor_kind: "user" | "deployment";
  actor_user_id: string | null;
  action: string;
  decision_code: string;
  details: Record<string, unknown>;
}

export interface AuthorizationDenialCount {
  code: string;
  count: number;
}

export interface AuthorizationActionDenialCount {
  action: string;
  count: number;
}

export interface AuthorizationDenialBucket {
  /** UTC hour start, ISO-8601 (`2026-11-28T12:00:00.000Z`). */
  bucket_start: string;
  count: number;
}

export interface AuthorizationDenialTrend {
  since: string;
  until: string;
  window_ms: number;
  total: number;
  by_code: AuthorizationDenialCount[];
  by_action: AuthorizationActionDenialCount[];
  /** The precise capability-layer cause, safe to expose (e.g. `no_code_read`). */
  by_capability_reason: AuthorizationDenialCount[];
  /**
   * Sparse hourly counts, oldest first. Only hours with at least one refusal
   * appear; a gap is a zero, not missing evidence.
   */
  series: AuthorizationDenialBucket[];
}

export interface AuthorizationDenialTrendQuery {
  /** Oldest instant included. The caller clamps the window. */
  since: string;
  /** Newest instant included; defaults to "now" at read time. */
  until?: string;
}

export interface AuthorizationAuditRepository {
  /**
   * Append one denial. Throws when the append fails: a refusal whose evidence
   * could not be recorded is still a refusal, never an allow.
   */
  recordDenial(input: AuthorizationDenialInput): void;
  /**
   * Aggregate refusals for one workspace inside a bounded window. Scoped by
   * the caller's enterprise + workspace; another tenant's rows are not
   * reachable through this read.
   */
  denialTrend(
    scope: WorkspaceScope,
    query: AuthorizationDenialTrendQuery,
  ): AuthorizationDenialTrend;
  /** Newest-first refusals for one workspace, for an authorized evidence read. */
  recentDenials(scope: WorkspaceScope, limit?: number): AuthorizationDenialRecord[];
}

interface AuditRow {
  id: string;
  at: string;
  event: string;
  enterprise_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string | null;
  decision_code: string | null;
  details: string;
}

function parseDetails(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toRecord(row: AuditRow): AuthorizationDenialRecord {
  return {
    id: row.id,
    at: row.at,
    enterprise_id: row.enterprise_id ?? "",
    workspace_id: row.workspace_id ?? "",
    actor_kind: row.actor_kind === "deployment" ? "deployment" : "user",
    actor_user_id: row.actor_user_id,
    action: row.action ?? "unknown",
    decision_code: row.decision_code ?? "FORBIDDEN",
    details: parseDetails(row.details),
  };
}

class SqliteAuthorizationAuditRepository implements AuthorizationAuditRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  recordDenial(input: AuthorizationDenialInput): void {
    const at = input.at ?? nowIso();
    // Read at write time: a rolling deploy can migrate the database between
    // requests, and the evidence must name the schema the row was written
    // under, not the one this process saw at startup.
    const databaseSchemaVersion = readSchemaVersion(this.db);
    const details: Record<string, unknown> = {
      outcome: "denied",
      action: input.action,
      code: input.decision_code,
      reason: input.reason,
      capability_reason: input.capability_reason,
      required_capability: input.required_capability,
      requires_reconciliation: input.requires_reconciliation,
      target: input.target,
      repository_set_version: input.repository_set_version,
      context_schema_version: input.context_schema_version,
      build_schema_version: input.build_schema_version,
      database_schema_version: databaseSchemaVersion,
    };
    this.db
      .prepare(
        `INSERT INTO auth_audit
           (id, at, event, enterprise_id, actor_kind, actor_user_id, subject_user_id,
            provider_instance_id, details, workspace_id, action, decision_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("aud"),
        at,
        AUTHORIZATION_DENIED_EVENT,
        input.enterprise_id,
        input.actor_kind,
        input.actor_user_id,
        input.actor_user_id,
        input.target?.provider_instance_id ?? null,
        JSON.stringify(details),
        input.workspace_id,
        input.action,
        input.decision_code,
      );
  }

  denialTrend(
    scope: WorkspaceScope,
    query: AuthorizationDenialTrendQuery,
  ): AuthorizationDenialTrend {
    const until = query.until ?? nowIso();
    const byCode = this.db
      .prepare(
        `SELECT decision_code AS code, COUNT(*) AS count
           FROM auth_audit
          WHERE event = ? AND enterprise_id = ? AND workspace_id = ?
            AND at >= ? AND at <= ?
          GROUP BY decision_code
          ORDER BY count DESC, code ASC`,
      )
      .all(
        AUTHORIZATION_DENIED_EVENT,
        scope.enterprise_id,
        scope.workspace_id,
        query.since,
        until,
      ) as unknown as Array<{
      code: string | null;
      count: number;
    }>;
    const byAction = this.db
      .prepare(
        `SELECT action, COUNT(*) AS count
           FROM auth_audit
          WHERE event = ? AND enterprise_id = ? AND workspace_id = ?
            AND at >= ? AND at <= ?
          GROUP BY action
          ORDER BY count DESC, action ASC`,
      )
      .all(
        AUTHORIZATION_DENIED_EVENT,
        scope.enterprise_id,
        scope.workspace_id,
        query.since,
        until,
      ) as unknown as Array<{
      action: string | null;
      count: number;
    }>;
    const byCapabilityReason = this.db
      .prepare(
        `SELECT json_extract(details, '$.capability_reason') AS code, COUNT(*) AS count
           FROM auth_audit
          WHERE event = ? AND enterprise_id = ? AND workspace_id = ?
            AND at >= ? AND at <= ?
          GROUP BY json_extract(details, '$.capability_reason')
          ORDER BY count DESC, code ASC`,
      )
      .all(
        AUTHORIZATION_DENIED_EVENT,
        scope.enterprise_id,
        scope.workspace_id,
        query.since,
        until,
      ) as unknown as Array<{
      code: string | null;
      count: number;
    }>;
    const seriesRows = this.db
      .prepare(
        `SELECT substr(at, 1, 13) AS hour, COUNT(*) AS count
           FROM auth_audit
          WHERE event = ? AND enterprise_id = ? AND workspace_id = ?
            AND at >= ? AND at <= ?
          GROUP BY substr(at, 1, 13)
          ORDER BY hour ASC`,
      )
      .all(
        AUTHORIZATION_DENIED_EVENT,
        scope.enterprise_id,
        scope.workspace_id,
        query.since,
        until,
      ) as unknown as Array<{
      hour: string | null;
      count: number;
    }>;
    const by_code = byCode.map((row) => ({
      code: row.code ?? "FORBIDDEN",
      count: Number(row.count),
    }));
    const by_action = byAction.map((row) => ({
      action: row.action ?? "unknown",
      count: Number(row.count),
    }));
    const by_capability_reason = byCapabilityReason
      .filter((row): row is { code: string; count: number } => typeof row.code === "string")
      .map((row) => ({ code: row.code, count: Number(row.count) }));
    return {
      since: query.since,
      until,
      window_ms: Math.max(0, Date.parse(until) - Date.parse(query.since)),
      total: by_code.reduce((sum, row) => sum + row.count, 0),
      by_code,
      by_action,
      by_capability_reason,
      series: seriesRows.flatMap((row) =>
        typeof row.hour === "string"
          ? [{ bucket_start: `${row.hour}:00:00.000Z`, count: Number(row.count) }]
          : [],
      ),
    };
  }

  recentDenials(scope: WorkspaceScope, limit = 50): AuthorizationDenialRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT id, at, event, enterprise_id, actor_kind, actor_user_id,
                workspace_id, action, decision_code, details
           FROM auth_audit
          WHERE event = ? AND enterprise_id = ? AND workspace_id = ?
          ORDER BY at DESC, id DESC
          LIMIT ?`,
      )
      .all(
        AUTHORIZATION_DENIED_EVENT,
        scope.enterprise_id,
        scope.workspace_id,
        bounded,
      ) as unknown as AuditRow[];
    return rows.map(toRecord);
  }
}

export function createAuthorizationAuditRepository(
  db: ControlPlaneDb,
): AuthorizationAuditRepository {
  return new SqliteAuthorizationAuditRepository(db);
}
