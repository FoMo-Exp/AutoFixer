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
   * Load the durable ledger: one record per line (JSONL).
   *
   * Every newline-terminated line is a complete write and must parse AND
   * validate — either failure is corruption and refuses startup, never a torn
   * append. Only the unterminated tail can hold an interrupted append, and it
   * is tolerated only when its bytes are confirmed-incomplete JSON (a proper
   * prefix of a record): complete-but-invalid JSON there is corruption too.
   * Recovery truncates the file to the last complete record boundary, so a
   * later append can never run into dropped debris.
   */
  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const segments = fs.readFileSync(this.persistencePath, "utf8").split("\n");
    const tail = segments[segments.length - 1] ?? "";
    const lines = segments.slice(0, -1);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line === "") {
        continue;
      }
      let record: InvocationUsageRecord;
      try {
        record = migrateInvocationUsageRecord(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `usage ledger record on line ${index + 1} is corrupt; refusing to drop history: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      this.insertLoaded(record);
    }
    if (tail === "") {
      return;
    }
    // Only the unterminated tail can hold an interrupted append.
    let tailRecord: InvocationUsageRecord | null = null;
    let tailText: string | null = tail;
    try {
      tailRecord = migrateInvocationUsageRecord(JSON.parse(tail));
    } catch (error) {
      if (scanJsonPrefix(tail) !== "incomplete") {
        throw new Error(
          `usage ledger tail record is corrupt; refusing to drop history: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // Confirmed incomplete: the debris of an append whose write already
      // failed loudly at `recordAttempt`. Dropped at the record boundary so
      // later appends cannot merge into it, and visible instead of silent.
      tailRecord = null;
      tailText = null;
      console.error(
        "usage ledger: dropping interrupted trailing append (its write failed when it happened)",
      );
    }
    if (tailRecord) {
      this.insertLoaded(tailRecord);
    }
    // Repair the durable file to the accepted record boundary: re-terminate
    // the complete tail record whose newline was lost, or truncate away the
    // confirmed-incomplete tail.
    this.rewriteDurable(
      lines
        .filter((line) => line !== "")
        .map((line) => `${line}\n`)
        .join("") + (tailText !== null ? `${tailText}\n` : ""),
    );
  }

  private insertLoaded(record: InvocationUsageRecord): void {
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
      return;
    }
    this.entries.set(key, { record, fingerprint });
  }

  /** Atomically rewrite the durable ledger to a known record boundary. */
  private rewriteDurable(canonical: string): void {
    if (!this.persistencePath) {
      return;
    }
    const temporary = `${this.persistencePath}.${process.pid}.repair.tmp`;
    fs.writeFileSync(temporary, canonical, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }
}

type JsonScan = "complete" | "incomplete" | "invalid";

/**
 * Classify a JSON text as a complete value, a confirmed-incomplete prefix
 * (every byte so far can still continue into valid JSON, but the value is
 * unfinished — the signature of an append interrupted mid-write), or invalid
 * bytes. Only "incomplete" qualifies for torn-tail tolerance; anything else
 * is corruption.
 */
function scanJsonPrefix(text: string): JsonScan {
  type Phase = "value" | "valueOrClose" | "key" | "keyOrClose" | "colon" | "after" | "done";
  const containers: Array<"object" | "array"> = [];
  let phase: Phase = "value";
  let i = 0;
  const length = text.length;

  const isWhitespace = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

  while (i < length) {
    const ch = text[i] ?? "";
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (phase === "done") {
      return "invalid";
    }
    if (phase === "colon") {
      if (ch !== ":") return "invalid";
      phase = "value";
      i += 1;
      continue;
    }
    if (phase === "after") {
      const top = containers[containers.length - 1];
      if (ch === ",") {
        phase = top === "object" ? "key" : "value";
        i += 1;
        continue;
      }
      if ((ch === "}" && top === "object") || (ch === "]" && top === "array")) {
        containers.pop();
        i += 1;
        phase = containers.length > 0 ? "after" : "done";
        continue;
      }
      return "invalid";
    }
    const forKey = phase === "key" || phase === "keyOrClose";
    if (forKey && ch === "}" && phase === "keyOrClose") {
      containers.pop();
      i += 1;
      phase = containers.length > 0 ? "after" : "done";
      continue;
    }
    if (phase === "valueOrClose" && ch === "]") {
      containers.pop();
      i += 1;
      phase = containers.length > 0 ? "after" : "done";
      continue;
    }
    if (forKey && ch !== '"') {
      return "invalid";
    }
    if (ch === "{") {
      containers.push("object");
      phase = "keyOrClose";
      i += 1;
      continue;
    }
    if (ch === "[") {
      containers.push("array");
      phase = "valueOrClose";
      i += 1;
      continue;
    }
    if (ch === '"') {
      const stringScan = scanJsonString(text, i);
      if (stringScan.state !== "complete") return stringScan.state;
      i = stringScan.next;
      if (forKey) {
        phase = "colon";
      } else {
        phase = containers.length > 0 ? "after" : "done";
      }
      continue;
    }
    if (ch === "t" || ch === "f" || ch === "n") {
      const literal = ch === "t" ? "true" : ch === "f" ? "false" : "null";
      const start = i;
      while (i < length && i - start < literal.length && text[i] === literal[i - start]) {
        i += 1;
      }
      if (i - start < literal.length) {
        return i === length ? "incomplete" : "invalid";
      }
      phase = containers.length > 0 ? "after" : "done";
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const numberScan = scanJsonNumber(text, i);
      if (numberScan.state !== "complete") return numberScan.state;
      i = numberScan.next;
      phase = containers.length > 0 ? "after" : "done";
      continue;
    }
    return "invalid";
  }
  return phase === "done" ? "complete" : "incomplete";
}

function scanJsonString(text: string, start: number): { state: JsonScan; next: number } {
  let i = start + 1;
  const length = text.length;
  while (i < length) {
    const ch = text[i] ?? "";
    if (ch === "\\") {
      const escape = i + 1 < length ? text[i + 1] : undefined;
      if (escape === undefined) return { state: "incomplete", next: i };
      if (escape === "u") {
        for (let h = 0; h < 4; h += 1) {
          const hex = text[i + 2 + h];
          if (hex === undefined) return { state: "incomplete", next: i };
          if (!/^[0-9a-fA-F]$/.test(hex)) return { state: "invalid", next: i };
        }
        i += 6;
        continue;
      }
      if ('"\\/bfnrt'.includes(escape)) {
        i += 2;
        continue;
      }
      return { state: "invalid", next: i };
    }
    if (ch === '"') {
      return { state: "complete", next: i + 1 };
    }
    if (ch.charCodeAt(0) < 0x20) {
      return { state: "invalid", next: i };
    }
    i += 1;
  }
  return { state: "incomplete", next: i };
}

function scanJsonNumber(text: string, start: number): { state: JsonScan; next: number } {
  let i = start;
  const length = text.length;
  const peek = (): string | undefined => (i < length ? text[i] : undefined);
  const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
  if (peek() === "-") {
    i += 1;
  }
  const first = peek();
  if (first === undefined) return { state: "incomplete", next: i };
  if (first === "0") {
    i += 1;
  } else if (first >= "1" && first <= "9") {
    i += 1;
    while (isDigit(peek())) i += 1;
  } else {
    return { state: "invalid", next: i };
  }
  if (peek() === ".") {
    i += 1;
    if (peek() === undefined) return { state: "incomplete", next: i };
    if (!isDigit(peek())) return { state: "invalid", next: i };
    while (isDigit(peek())) i += 1;
  }
  const exponent = peek();
  if (exponent === "e" || exponent === "E") {
    i += 1;
    const sign = peek();
    if (sign === "+" || sign === "-") i += 1;
    if (peek() === undefined) return { state: "incomplete", next: i };
    if (!isDigit(peek())) return { state: "invalid", next: i };
    while (isDigit(peek())) i += 1;
  }
  return { state: "complete", next: i };
}

/** Convenience constructor mirroring the other store modules. */
export function createUsageLedgerStore(options: UsageLedgerStoreOptions = {}): UsageLedgerStore {
  return new UsageLedgerStore(options);
}
