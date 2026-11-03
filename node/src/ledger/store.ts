/**
 * Append-only invocation usage ledger store (DAT-227).
 *
 * Records are immutable once written: a redelivery of the same attempt with
 * identical content is deduplicated by `(invocation_id, attempt)`, and a
 * redelivery that changes content is refused instead of rewriting financial
 * evidence. Every read runs inside the caller's authenticated enterprise/
 * workspace scope; asking for another workspace is refused, not filtered into
 * silence (financial access is scoped like the trace store, and — per
 * ADR-0008 — never implies prompt-content access).
 *
 * `completeness` is a first-class query field: known/estimated/unknown usage
 * is distinguishable without inspecting token figures.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LedgerAccessError, LedgerConflictError, LedgerValidationError } from "./errors.js";
import {
  USAGE_RECORD_SCHEMA_VERSION,
  buildInvocationUsageRecord,
  migrateInvocationUsageRecord,
} from "./record.js";
import type {
  InvocationAttemptObservation,
  InvocationUsageRecord,
  LedgerFinishStatus,
  UsageCompleteness,
  UsageProvenance,
} from "./record.js";

export { LedgerAccessError, LedgerConflictError, LedgerValidationError } from "./errors.js";

/** Authenticated caller context; reads are confined to this enterprise/workspace. */
export interface LedgerAccessScope {
  enterprise_id: string;
  workspace_id: string;
  /** Who is asking; kept for downstream audit of exports and reads. */
  subject: string;
}

export interface UsageLedgerFilter {
  /** Refused when it disagrees with the authenticated scope. */
  enterprise_id?: string;
  /** Refused when it disagrees with the authenticated scope. */
  workspace_id?: string;
  issue_id?: string;
  run_id?: string;
  invocation_id?: string;
  trace_id?: string;
  attempt?: number;
  endpoint_id?: string;
  provider?: string;
  requested_model?: string;
  returned_model?: string;
  provider_request_id?: string;
  finish_status?: LedgerFinishStatus;
  /** The independent completeness field: known, estimated, or unknown. */
  completeness?: UsageCompleteness;
  provenance?: UsageProvenance;
  /** Inclusive RFC 3339 bounds on the attempt's started_at. */
  since?: string;
  until?: string;
}

/**
 * The gateway's metering seam: one observation per actual invocation attempt
 * (success, failure, retry, or fallback). Implementations build and store the
 * immutable ledger record.
 */
export interface UsageLedgerSink {
  recordAttempt(observation: InvocationAttemptObservation): void | Promise<void>;
}

export interface UsageLedgerStoreOptions {
  /** A private durable ledger file. Omit for a process-local store in tests. */
  persistencePath?: string;
  /** Clock used for store-stamped recorded_at and validation defaults. */
  now?: () => Date;
}

interface StoredEntry {
  record: InvocationUsageRecord;
  /** Writer-owned content; excludes the store-stamped recorded_at. */
  fingerprint: string;
}

interface PersistedState {
  schema_version: number;
  records: InvocationUsageRecord[];
}

function identityKey(invocationId: string, attempt: number): string {
  return JSON.stringify([invocationId, attempt]);
}

function fingerprintOf(record: InvocationUsageRecord): string {
  const { recorded_at: _recordedAt, ...writerFields } = record;
  return JSON.stringify(writerFields);
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function matchesFilter(
  filter: UsageLedgerFilter | undefined,
  record: InvocationUsageRecord,
): boolean {
  if (!filter) {
    return true;
  }
  const exact: Array<[string | undefined, string | null]> = [
    [filter.issue_id, record.issue_id],
    [filter.run_id, record.run_id],
    [filter.invocation_id, record.invocation_id],
    [filter.trace_id, record.trace_id],
    [filter.endpoint_id, record.endpoint_id],
    [filter.provider, record.provider],
    [filter.requested_model, record.requested_model],
    [filter.returned_model, record.returned_model],
    [filter.provider_request_id, record.provider_request_id],
  ];
  for (const [wanted, actual] of exact) {
    if (wanted !== undefined && wanted !== actual) {
      return false;
    }
  }
  if (filter.attempt !== undefined && filter.attempt !== record.attempt) {
    return false;
  }
  if (filter.finish_status !== undefined && filter.finish_status !== record.finish_status) {
    return false;
  }
  if (filter.completeness !== undefined && filter.completeness !== record.usage.completeness) {
    return false;
  }
  if (filter.provenance !== undefined && filter.provenance !== record.usage.provenance) {
    return false;
  }
  if (filter.since !== undefined && Date.parse(record.started_at) < Date.parse(filter.since)) {
    return false;
  }
  if (filter.until !== undefined && Date.parse(record.started_at) > Date.parse(filter.until)) {
    return false;
  }
  return true;
}

export class UsageLedgerStore implements UsageLedgerSink {
  /** Insertion order is arrival order; identity is (invocation_id, attempt). */
  private readonly entries = new Map<string, StoredEntry>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(options: UsageLedgerStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /**
   * Record one observed invocation attempt. A redelivery of identical content
   * is deduplicated; a redelivery with different content is refused so the
   * financial evidence of an attempt can never be rewritten.
   */
  recordAttempt(observation: InvocationAttemptObservation): void {
    const record = buildInvocationUsageRecord(observation, this.now().toISOString());
    const key = identityKey(record.invocation_id, record.attempt);
    const fingerprint = fingerprintOf(record);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new LedgerConflictError(
          `usage record for invocation ${record.invocation_id} attempt ${record.attempt} ` +
            "is already recorded with different content",
        );
      }
      return;
    }
    this.entries.set(key, { record, fingerprint });
    this.schedulePersist();
  }

  /** Arrival-ordered records visible to the scope, as defensive copies. */
  query(scope: LedgerAccessScope, filter?: UsageLedgerFilter): InvocationUsageRecord[] {
    this.assertAuthenticated(scope);
    this.assertReadPreconditions(scope, filter);
    const out: InvocationUsageRecord[] = [];
    for (const { record } of this.entries.values()) {
      if (this.isVisible(scope, record)) {
        if (matchesFilter(filter, record)) {
          out.push(structuredClone(record));
        }
      }
    }
    return out;
  }

  /** Write the durable ledger now if it is dirty; idempotent. */
  flushSync(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistencePath || !this.dirty) {
      return;
    }
    const state: PersistedState = {
      schema_version: USAGE_RECORD_SCHEMA_VERSION,
      records: [...this.entries.values()].map((entry) => structuredClone(entry.record)),
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
    this.dirty = false;
  }

  private assertAuthenticated(scope: LedgerAccessScope): void {
    const fields = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new LedgerValidationError(`access scope ${name} must be a non-empty string`);
      }
    }
  }

  private assertReadPreconditions(
    scope: LedgerAccessScope,
    filter: UsageLedgerFilter | undefined,
  ): void {
    if (!filter) {
      return;
    }
    if (filter.enterprise_id !== undefined && filter.enterprise_id !== scope.enterprise_id) {
      throw new LedgerAccessError(
        `usage reads are scoped to enterprise ${scope.enterprise_id}; refusing cross-enterprise query`,
      );
    }
    if (filter.workspace_id !== undefined && filter.workspace_id !== scope.workspace_id) {
      throw new LedgerAccessError(
        `usage reads are scoped to workspace ${scope.workspace_id}; refusing cross-workspace query`,
      );
    }
    // A malformed bound would silently match nothing; refuse it instead.
    if (filter.since !== undefined && !TIMESTAMP_PATTERN.test(filter.since)) {
      throw new LedgerValidationError(`usage filter "since" must be an RFC 3339 timestamp`);
    }
    if (filter.until !== undefined && !TIMESTAMP_PATTERN.test(filter.until)) {
      throw new LedgerValidationError(`usage filter "until" must be an RFC 3339 timestamp`);
    }
    if (filter.attempt !== undefined && (!Number.isInteger(filter.attempt) || filter.attempt < 1)) {
      throw new LedgerValidationError(`usage filter "attempt" must be an integer starting at 1`);
    }
  }

  private isVisible(scope: LedgerAccessScope, record: InvocationUsageRecord): boolean {
    return (
      record.enterprise_id === scope.enterprise_id && record.workspace_id === scope.workspace_id
    );
  }

  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as unknown;
    for (const serialized of migratePersistedState(raw).records) {
      const record = migrateInvocationUsageRecord(serialized);
      const key = identityKey(record.invocation_id, record.attempt);
      const fingerprint = fingerprintOf(record);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new LedgerConflictError(
            `persisted usage record for invocation ${record.invocation_id} attempt ` +
              `${record.attempt} appears twice with different content`,
          );
        }
        continue;
      }
      this.entries.set(key, { record, fingerprint });
    }
  }

  /** Coalesce mutations into one write per tick; attempt storms stay cheap. */
  private schedulePersist(): void {
    if (!this.persistencePath) {
      return;
    }
    this.dirty = true;
    if (this.persistTimer !== null) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushSync();
    }, 25);
    this.persistTimer.unref?.();
  }
}

/** Corrupt state fails startup; it is never quietly read as an empty ledger. */
function migratePersistedState(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("usage ledger store is not a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const version = typeof value["schema_version"] === "number" ? value["schema_version"] : 0;
  if (version > USAGE_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `usage ledger store schema ${version} is newer than ${USAGE_RECORD_SCHEMA_VERSION}`,
    );
  }
  const records = value["records"];
  if (!Array.isArray(records)) {
    throw new Error(
      "usage ledger store records are corrupt (missing or not an array); refusing to drop history",
    );
  }
  return {
    schema_version: USAGE_RECORD_SCHEMA_VERSION,
    records: records as InvocationUsageRecord[],
  };
}

/** Convenience constructor mirroring the other store modules. */
export function createUsageLedgerStore(options: UsageLedgerStoreOptions = {}): UsageLedgerStore {
  return new UsageLedgerStore(options);
}
