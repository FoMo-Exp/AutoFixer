/**
 * Finite enterprise retention for observability records (DAT-225).
 *
 * The enterprise configures finite retention for evidence, operational
 * traces, content artifacts, usage records and backups separately; there is
 * no silent "retain forever" default — a missing, infinite, or zero value is
 * a configuration failure, not an open-ended grant (ADR-0008).
 *
 * Deletion and expiry leave a minimal tombstone and append to an audit trail
 * that nothing here ever rewrites: past audit entries are immutable history,
 * and tombstones carry opaque identity and reason only — no content, hashes,
 * or provenance. Legal holds — and with them exceptional retention — need an
 * explicit enterprise policy and a grant minted by it; a held record is never
 * expired and never deleted.
 */
import { TraceValidationError } from "./errors.js";
import { isTimestamp } from "./schema.js";

/** Record classes whose retention the enterprise configures separately. */
export const RETENTION_CLASSES = ["evidence", "trace", "content", "usage", "backup"] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Finite per-class retention in whole days (>= 1). */
export interface RetentionConfig {
  readonly evidence_days: number;
  readonly trace_days: number;
  readonly content_days: number;
  readonly usage_days: number;
  readonly backup_days: number;
}

const DAY_MS = 86_400_000;

export class RetentionConfigError extends Error {
  readonly code = "RETENTION_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

/** Lifecycle failures on one retained record, keyed by a stable code. */
export class RetentionRecordError extends Error {
  readonly code: "RETENTION_RECORD_UNKNOWN" | "RETENTION_RECORD_CONFLICT" | "LEGAL_HOLD_ACTIVE";

  constructor(
    code: "RETENTION_RECORD_UNKNOWN" | "RETENTION_RECORD_CONFLICT" | "LEGAL_HOLD_ACTIVE",
    message: string,
  ) {
    super(message);
    this.name = "RetentionRecordError";
    this.code = code;
  }
}

export class RetentionAdminDenied extends Error {
  readonly code = "RETENTION_ADMIN_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "RetentionAdminDenied";
  }
}

const RETENTION_CLASS_VOCABULARY: Record<RetentionClass, true> = {
  evidence: true,
  trace: true,
  content: true,
  usage: true,
  backup: true,
};

function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === "string" && Object.hasOwn(RETENTION_CLASS_VOCABULARY, value);
}

/**
 * Fail-closed parse of the enterprise retention configuration. Every class
 * needs its own finite whole-day bound; anything else — missing fields,
 * `Infinity`, zero, negatives, fractional days — is refused instead of being
 * read as "keep forever" or "keep nothing".
 */
export function parseRetentionConfig(value: unknown): RetentionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RetentionConfigError("retention config must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const config: Record<string, number> = {};
  for (const recordClass of RETENTION_CLASSES) {
    const key = `${recordClass}_days`;
    const days = record[key];
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
      throw new RetentionConfigError(
        `retention config "${key}" must be a finite whole number of days (>= 1); ` +
          "there is no retain-forever default",
      );
    }
    config[key] = days;
  }
  return config as unknown as RetentionConfig;
}

// ---------------------------------------------------------------------------
// Explicit administration policy (legal holds and deletion)
// ---------------------------------------------------------------------------

export type RetentionAdminAction = "place_legal_hold" | "release_legal_hold" | "delete";

/**
 * Server-side role check for retention administration. The policy — injected
 * at service bootstrap, not supplied per call — decides whether an
 * authenticated subject may hold, release, or delete.
 */
export interface RetentionAdminPolicy {
  mayAct(subject: string, action: RetentionAdminAction): boolean;
}

/** Fail-closed default: nobody administers retention until a policy says so. */
export const DENY_ALL_RETENTION_ADMIN: RetentionAdminPolicy = Object.freeze({
  mayAct: (_subject: string, _action: RetentionAdminAction): boolean => false,
});

/**
 * A capability to perform one retention administration action. Instances are
 * only valid when {@link RetentionAuthority} mints them after its policy
 * check; a caller-constructed instance is just an object and is refused.
 */
export class RetentionAdminGrant {
  readonly subject: string;
  readonly action: RetentionAdminAction;

  constructor(subject: string, action: RetentionAdminAction) {
    this.subject = subject;
    this.action = action;
  }
}

const issuedGrants = new WeakSet<RetentionAdminGrant>();
const grantIssuers = new WeakMap<RetentionAdminGrant, RetentionAuthority>();

/** The trusted minting authority for retention administration grants. */
export class RetentionAuthority {
  private readonly policy: RetentionAdminPolicy;

  constructor(policy: RetentionAdminPolicy = DENY_ALL_RETENTION_ADMIN) {
    this.policy = policy;
  }

  authorize(subject: string, action: RetentionAdminAction): RetentionAdminGrant {
    if (typeof subject !== "string" || subject.length === 0) {
      throw new RetentionAdminDenied("an authenticated subject is required");
    }
    if (this.policy.mayAct(subject, action) !== true) {
      throw new RetentionAdminDenied(
        "the retention administration policy does not grant this subject this action",
      );
    }
    const grant = new RetentionAdminGrant(subject, action);
    issuedGrants.add(grant);
    grantIssuers.set(grant, this);
    return grant;
  }

  /** Whether this authority minted the grant (schedule binding check). */
  owns(grant: RetentionAdminGrant | null | undefined): boolean {
    return grant != null && grantIssuers.get(grant) === this;
  }
}

function isIssuedGrant(
  grant: RetentionAdminGrant | null | undefined,
): grant is RetentionAdminGrant {
  return grant instanceof RetentionAdminGrant && issuedGrants.has(grant);
}

// ---------------------------------------------------------------------------
// Records, tombstones, and the append-only audit trail
// ---------------------------------------------------------------------------

/** An active legal hold: exceptional retention under explicit policy. */
export interface LegalHold {
  readonly placed_at: string;
  readonly placed_by: string;
  readonly reason: string;
}

export interface RetainedRecord {
  readonly id: string;
  readonly record_class: RetentionClass;
  readonly captured_at: string;
  readonly legal_hold: LegalHold | null;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly record_class: RetentionClass;
  readonly reason: "expired" | "deleted";
  readonly at: string;
  readonly by: string;
}

export type RetentionAuditAction =
  "captured" | "expired" | "deleted" | "legal_hold_placed" | "legal_hold_released";

export interface RetentionAuditEntry {
  readonly at: string;
  readonly action: RetentionAuditAction;
  readonly record_id: string;
  readonly actor: string;
  readonly detail: string | null;
}

export interface RetentionScheduleOptions {
  config: RetentionConfig;
  /** Authority whose grants this schedule accepts for hold/delete actions. */
  authority: RetentionAuthority;
  now?: () => Date;
}

interface InternalRecord {
  id: string;
  record_class: RetentionClass;
  captured_at: string;
  capturedMs: number;
  expiresMs: number;
  legal_hold: LegalHold | null;
}

/**
 * The retention schedule for one enterprise configuration. It holds record
 * identity and timing only — never record content — and every destructive
 * outcome is tombstoned and audited without touching earlier audit entries.
 */
export class RetentionSchedule {
  private readonly config: RetentionConfig;
  private readonly authority: RetentionAuthority;
  private readonly now: () => Date;
  private readonly recordById = new Map<string, InternalRecord>();
  private readonly tombstoneList: RetentionTombstone[] = [];
  private readonly auditLog: RetentionAuditEntry[] = [];

  constructor(options: RetentionScheduleOptions) {
    this.config = parseRetentionConfig(options.config);
    this.authority = options.authority;
    this.now = options.now ?? (() => new Date());
  }

  /** The finite retention bound for one record class, in days. */
  daysFor(recordClass: RetentionClass): number {
    switch (recordClass) {
      case "evidence":
        return this.config.evidence_days;
      case "trace":
        return this.config.trace_days;
      case "content":
        return this.config.content_days;
      case "usage":
        return this.config.usage_days;
      case "backup":
        return this.config.backup_days;
    }
  }

  register(input: {
    id: string;
    record_class: RetentionClass;
    captured_at: string;
  }): RetainedRecord {
    if (typeof input.id !== "string" || input.id.length === 0) {
      throw new TraceValidationError("retention record id must be a non-empty string");
    }
    if (!isRetentionClass(input.record_class)) {
      throw new TraceValidationError(
        `retention record class ${JSON.stringify(input.record_class)} is not recognized`,
      );
    }
    if (!isTimestamp(input.captured_at)) {
      throw new TraceValidationError("retention record captured_at must be an RFC 3339 timestamp");
    }
    if (this.recordById.has(input.id) || this.tombstoneList.some((t) => t.id === input.id)) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_CONFLICT",
        `retention record ${input.id} is already registered`,
      );
    }
    const capturedMs = Date.parse(input.captured_at);
    const record: InternalRecord = {
      id: input.id,
      record_class: input.record_class,
      captured_at: input.captured_at,
      capturedMs,
      expiresMs: capturedMs + this.daysFor(input.record_class) * DAY_MS,
      legal_hold: null,
    };
    this.recordById.set(record.id, record);
    this.appendAudit(
      "captured",
      record.id,
      "system",
      `${record.record_class} retention registered`,
    );
    return copyRecord(record);
  }

  /**
   * Expire every record past its class retention window that is not under a
   * legal hold. Each expiry leaves a tombstone and an audit entry; the
   * records themselves are dropped from the schedule, never rewritten.
   */
  expire(): RetentionTombstone[] {
    const nowMs = Date.parse(this.now().toISOString());
    const expired: RetentionTombstone[] = [];
    for (const record of [...this.recordById.values()]) {
      if (record.legal_hold !== null || record.expiresMs > nowMs) {
        continue;
      }
      this.recordById.delete(record.id);
      const tombstone = this.appendTombstone(record, "expired", "system");
      this.appendAudit(
        "expired",
        record.id,
        "system",
        `${record.record_class} retention of ${this.daysFor(record.record_class)} days elapsed`,
      );
      expired.push(tombstone);
    }
    return expired;
  }

  /**
   * Delete one record under an explicit grant. A record under legal hold is
   * never deleted — the hold is exactly the promise that it survives.
   */
  delete(
    id: string,
    actor: string,
    grant: RetentionAdminGrant | null | undefined,
    reason?: string,
  ): RetentionTombstone {
    this.assertAdmin(actor, "delete", grant);
    const record = this.recordById.get(id);
    if (record === undefined) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_UNKNOWN",
        `retention record ${id} is not registered (it may already be tombstoned)`,
      );
    }
    if (record.legal_hold !== null) {
      throw new RetentionRecordError(
        "LEGAL_HOLD_ACTIVE",
        `retention record ${id} is under a legal hold and cannot be deleted`,
      );
    }
    this.recordById.delete(id);
    const tombstone = this.appendTombstone(record, "deleted", actor);
    this.appendAudit("deleted", id, actor, reason ?? null);
    return tombstone;
  }

  /** Place a legal hold under an explicit grant; held records never expire. */
  placeLegalHold(
    id: string,
    actor: string,
    grant: RetentionAdminGrant | null | undefined,
    reason: string,
  ): RetainedRecord {
    this.assertAdmin(actor, "place_legal_hold", grant);
    const record = this.recordById.get(id);
    if (record === undefined) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_UNKNOWN",
        `retention record ${id} is not registered`,
      );
    }
    if (record.legal_hold !== null) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_CONFLICT",
        `retention record ${id} already has an active legal hold`,
      );
    }
    record.legal_hold = { placed_at: this.now().toISOString(), placed_by: actor, reason };
    this.appendAudit("legal_hold_placed", id, actor, reason);
    return copyRecord(record);
  }

  /** Release a legal hold under an explicit grant; expiry applies again. */
  releaseLegalHold(
    id: string,
    actor: string,
    grant: RetentionAdminGrant | null | undefined,
    reason?: string,
  ): RetainedRecord {
    this.assertAdmin(actor, "release_legal_hold", grant);
    const record = this.recordById.get(id);
    if (record === undefined) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_UNKNOWN",
        `retention record ${id} is not registered`,
      );
    }
    if (record.legal_hold === null) {
      throw new RetentionRecordError(
        "RETENTION_RECORD_CONFLICT",
        `retention record ${id} has no active legal hold to release`,
      );
    }
    record.legal_hold = null;
    this.appendAudit("legal_hold_released", id, actor, reason ?? null);
    return copyRecord(record);
  }

  /** The currently retained records, as defensive copies. */
  records(): RetainedRecord[] {
    return [...this.recordById.values()].map(copyRecord);
  }

  /** The minimal tombstones kept after expiry or deletion. */
  tombstones(): RetentionTombstone[] {
    return this.tombstoneList.map((entry) => ({ ...entry }));
  }

  /**
   * The append-only audit trail as defensive copies. Nothing in this class
   * mutates or removes an existing entry: deletion, expiry and tombstones
   * record history, they never rewrite it.
   */
  audit(): RetentionAuditEntry[] {
    return this.auditLog.map((entry) => ({ ...entry }));
  }

  private assertAdmin(
    actor: string,
    action: RetentionAdminAction,
    grant: RetentionAdminGrant | null | undefined,
  ): void {
    if (
      !isIssuedGrant(grant) ||
      grant.subject !== actor ||
      grant.action !== action ||
      !this.authority.owns(grant)
    ) {
      throw new RetentionAdminDenied(
        `retention ${action} requires a grant minted for this actor and action by this schedule's authority`,
      );
    }
  }

  private appendTombstone(
    record: InternalRecord,
    reason: "expired" | "deleted",
    by: string,
  ): RetentionTombstone {
    const tombstone: RetentionTombstone = {
      id: record.id,
      record_class: record.record_class,
      reason,
      at: this.now().toISOString(),
      by,
    };
    this.tombstoneList.push(tombstone);
    return { ...tombstone };
  }

  private appendAudit(
    action: RetentionAuditAction,
    recordId: string,
    actor: string,
    detail: string | null,
  ): void {
    this.auditLog.push({
      at: this.now().toISOString(),
      action,
      record_id: recordId,
      actor,
      detail,
    });
  }
}

function copyRecord(record: InternalRecord): RetainedRecord {
  return {
    id: record.id,
    record_class: record.record_class,
    captured_at: record.captured_at,
    legal_hold: record.legal_hold === null ? null : { ...record.legal_hold },
  };
}
