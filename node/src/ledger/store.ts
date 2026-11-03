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
 * Durability contract: `recordAttempt` appends the record to the durable
 * ledger before it returns, so its return is the confirmation that the record
 * is persisted and its throw is the confirmation that nothing was. There is
 * no deferred buffer and no shutdown flush to forget — an attempt is either
 * durably recorded or its write failed loudly.
 *
 * `completeness` is a first-class query field: known/estimated/unknown usage
 * is distinguishable without inspecting token figures.
 */
import fs from "node:fs";
import path from "node:path";

import { LedgerAccessError, LedgerConflictError, LedgerValidationError } from "./errors.js";
import { buildInvocationUsageRecord, migrateInvocationUsageRecord } from "./record.js";
import type {
  InvocationAttemptObservation,
  InvocationUsageRecord,
  LedgerFinishStatus,
  UsageCompleteness,
  UsageProvenance,
} from "./record.js";

export {
  LedgerAccessError,
  LedgerConflictError,
  LedgerValidationError,
  UsageLedgerWriteError,
} from "./errors.js";

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
 *
 * Durability contract: the call settles only once the record is durably
 * persisted. A throw or rejection means the attempt is NOT recorded — callers
 * must never treat it as recorded, and must not retry the write in a way that
 * re-dispatches the model.
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

  constructor(options: UsageLedgerStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /**
   * Record one observed invocation attempt. A redelivery of identical content
   * is deduplicated; a redelivery with different content is refused so the
   * financial evidence of an attempt can never be rewritten.
   *
   * The record is appended to the durable ledger before this returns. A
   * persistence failure throws without keeping an in-memory copy: the attempt
   * is not recorded, loudly.
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
    if (this.persistencePath) {
      // Durable first: if this throws, the attempt is not recorded anywhere.
      this.appendDurable(record);
    }
    this.entries.set(key, { record, fingerprint });
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

  /** One durable append per record; the only write path, and it is synchronous. */
  private appendDurable(record: InvocationUsageRecord): void {
    if (!this.persistencePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.persistencePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
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

  /**
   * Load the durable ledger: one record per line (JSONL). A line that will
   * not parse or validate is corruption and fails startup — history is never
   * quietly dropped. The one tolerated artifact is a torn FINAL line: the
   * debris of an interrupted append whose write already failed loudly at
   * `recordAttempt`, so no record was ever confirmed and none is lost here.
   */
  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const lines = fs.readFileSync(this.persistencePath, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line === "") {
        continue;
      }
      let record: InvocationUsageRecord;
      try {
        record = migrateInvocationUsageRecord(JSON.parse(line));
      } catch (error) {
        const tornTail = lines.slice(index + 1).every((rest) => rest === "");
        if (tornTail) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`usage ledger: ignoring torn final record: ${detail}`);
          continue;
        }
        throw new Error(
          `usage ledger record on line ${index + 1} is corrupt; refusing to drop history`,
        );
      }
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
}

/** Convenience constructor mirroring the other store modules. */
export function createUsageLedgerStore(options: UsageLedgerStoreOptions = {}): UsageLedgerStore {
  return new UsageLedgerStore(options);
}
