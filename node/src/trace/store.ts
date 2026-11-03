/**
 * Append-only trace store (DAT-224).
 *
 * Records are immutable once written: delivery retries are deduplicated by
 * `(source, event_id)`, and a redelivery that changes content is refused
 * instead of overwriting evidence. Each writer owns its own sequence, so the
 * store never forces a single global order. Every read — query, stream,
 * export, aggregate — runs inside the caller's authenticated enterprise/
 * workspace scope; asking for another workspace is refused, not filtered
 * into silence.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { TraceAccessError, TraceConflictError, TraceValidationError } from "./errors.js";
import { METRIC_DIMENSION_KEYS } from "./labels.js";
import { TRACE_SCHEMA_VERSION, migrateTraceEvent } from "./schema.js";
import type { NewTraceEvent, TraceEvent, TraceEventKind, TraceRecordClass } from "./schema.js";

export { TraceAccessError, TraceConflictError } from "./errors.js";

/** Authenticated caller context; reads are confined to this enterprise/workspace. */
export interface AccessScope {
  enterprise_id: string;
  workspace_id: string;
  /** Who is asking; kept for downstream audit of exports and reads. */
  subject: string;
}

export interface TraceFilter {
  enterprise_id?: string;
  workspace_id?: string;
  issue_id?: string;
  task_id?: string;
  run_id?: string;
  attempt_id?: string;
  trace_id?: string;
  source?: string;
  record_class?: TraceRecordClass;
  kind?: TraceEventKind;
  /** Inclusive RFC 3339 bounds on event_time. */
  since?: string;
  until?: string;
}

export type AppendResult =
  { status: "recorded"; event: TraceEvent } | { status: "duplicate"; event: TraceEvent };

export interface TraceExport {
  schema_version: number;
  exported_at: string;
  events: TraceEvent[];
}

export interface TraceAggregateBucket {
  key: Record<string, string>;
  count: number;
}

export interface TraceAggregate {
  dimensions: string[];
  buckets: TraceAggregateBucket[];
  total: number;
}

export interface TraceStoreOptions {
  /** A private durable trace file. Omit for a process-local store in tests. */
  persistencePath?: string;
  /** Clock used for ingest stamps and export times. */
  now?: () => Date;
}

interface StoredEntry {
  event: TraceEvent;
  /** Writer-owned content; excludes the store-stamped ingest_time. */
  fingerprint: string;
}

interface Listener {
  scope: AccessScope;
  filter: TraceFilter | undefined;
  onEvent: (event: TraceEvent) => void;
}

interface PersistedState {
  schema_version: number;
  events: TraceEvent[];
}

/** JSON pair encoding so delimiters inside source or event ids cannot collide. */
function identityKey(source: string, eventId: string): string {
  return JSON.stringify([source, eventId]);
}

function fingerprintOf(event: TraceEvent): string {
  const { ingest_time: _ingestTime, ...writerFields } = event;
  return JSON.stringify(writerFields);
}

function matchesFilter(filter: TraceFilter | undefined, event: TraceEvent): boolean {
  if (!filter) {
    return true;
  }
  const exact: Array<[string | undefined, string | null]> = [
    [filter.enterprise_id, event.enterprise_id],
    [filter.workspace_id, event.workspace_id],
    [filter.issue_id, event.issue_id],
    [filter.task_id, event.task_id],
    [filter.run_id, event.run_id],
    [filter.attempt_id, event.attempt_id],
    [filter.trace_id, event.trace_id],
    [filter.source, event.source],
    [filter.record_class, event.record_class],
    [filter.kind, event.kind],
  ];
  for (const [wanted, actual] of exact) {
    if (wanted !== undefined && wanted !== actual) {
      return false;
    }
  }
  if (filter.since !== undefined && Date.parse(event.event_time) < Date.parse(filter.since)) {
    return false;
  }
  if (filter.until !== undefined && Date.parse(event.event_time) > Date.parse(filter.until)) {
    return false;
  }
  return true;
}

function dimensionValue(event: TraceEvent, dimension: string): string {
  switch (dimension) {
    case "source":
      return event.source;
    case "kind":
      return event.kind;
    case "record_class":
      return event.record_class;
    default:
      return event.labels[dimension] ?? "(absent)";
  }
}

export class TraceStore {
  /** Insertion order is arrival order; identity is (source, event_id). */
  private readonly entries = new Map<string, StoredEntry>();
  private readonly listeners = new Set<Listener>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(options: TraceStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /**
   * Record one event. Redelivery of identical content is deduplicated and
   * re-notifies nobody; redelivery that changes content is refused so
   * recorded evidence can never be rewritten through the delivery path.
   */
  append(input: NewTraceEvent): AppendResult {
    const event = migrateTraceEvent({
      ...input,
      ingest_time: input.ingest_time ?? this.now().toISOString(),
    });
    const key = identityKey(event.source, event.event_id);
    const fingerprint = fingerprintOf(event);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TraceConflictError(
          `trace event ${event.source}/${event.event_id} is already recorded with different content`,
        );
      }
      return { status: "duplicate", event: structuredClone(existing.event) };
    }
    this.entries.set(key, { event, fingerprint });
    this.schedulePersist();
    for (const listener of this.listeners) {
      if (this.isVisible(listener.scope, listener.filter, event)) {
        listener.onEvent(structuredClone(event));
      }
    }
    return { status: "recorded", event: structuredClone(event) };
  }

  /** Arrival-ordered records visible to the scope, as defensive copies. */
  query(scope: AccessScope, filter?: TraceFilter): TraceEvent[] {
    this.assertAuthenticated(scope);
    this.assertScopeTarget(scope, filter);
    const out: TraceEvent[] = [];
    for (const { event } of this.entries.values()) {
      if (this.isVisible(scope, filter, event)) {
        out.push(structuredClone(event));
      }
    }
    return out;
  }

  /** Live records for the scope; returns an unsubscribe function. */
  stream(
    scope: AccessScope,
    filter: TraceFilter | undefined,
    onEvent: (event: TraceEvent) => void,
  ): () => void {
    this.assertAuthenticated(scope);
    this.assertScopeTarget(scope, filter);
    const listener: Listener = { scope, filter, onEvent };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Serialized bundle of the scoped records, versioned for consumers. */
  export(scope: AccessScope, filter?: TraceFilter): TraceExport {
    return {
      schema_version: TRACE_SCHEMA_VERSION,
      exported_at: this.now().toISOString(),
      events: this.query(scope, filter),
    };
  }

  /** Counts grouped by metric-safe dimensions only. */
  aggregate(
    scope: AccessScope,
    filter: TraceFilter | undefined,
    dimensions: readonly string[],
  ): TraceAggregate {
    this.assertAuthenticated(scope);
    this.assertScopeTarget(scope, filter);
    for (const dimension of dimensions) {
      if (!METRIC_DIMENSION_KEYS.includes(dimension)) {
        throw new TraceValidationError(
          `aggregate dimension "${dimension}" is outside the metric vocabulary`,
        );
      }
    }
    const events = this.query(scope, filter);
    const buckets = new Map<string, TraceAggregateBucket>();
    for (const event of events) {
      const key: Record<string, string> = {};
      for (const dimension of dimensions) {
        key[dimension] = dimensionValue(event, dimension);
      }
      const bucketId = JSON.stringify(dimensions.map((dimension) => key[dimension] ?? ""));
      const bucket = buckets.get(bucketId);
      if (bucket) {
        bucket.count += 1;
      } else {
        buckets.set(bucketId, { key: { ...key }, count: 1 });
      }
    }
    return {
      dimensions: [...dimensions],
      buckets: [...buckets.values()],
      total: events.length,
    };
  }

  /** Write the durable trace now if it is dirty; idempotent. */
  flushSync(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistencePath || !this.dirty) {
      return;
    }
    const state: PersistedState = {
      schema_version: TRACE_SCHEMA_VERSION,
      events: [...this.entries.values()].map((entry) => structuredClone(entry.event)),
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
    this.dirty = false;
  }

  private assertAuthenticated(scope: AccessScope): void {
    const fields = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TraceValidationError(`access scope ${name} must be a non-empty string`);
      }
    }
  }

  private assertScopeTarget(scope: AccessScope, filter: TraceFilter | undefined): void {
    if (!filter) {
      return;
    }
    if (filter.enterprise_id !== undefined && filter.enterprise_id !== scope.enterprise_id) {
      throw new TraceAccessError(
        `trace reads are scoped to enterprise ${scope.enterprise_id}; refusing cross-enterprise query`,
      );
    }
    if (filter.workspace_id !== undefined && filter.workspace_id !== scope.workspace_id) {
      throw new TraceAccessError(
        `trace reads are scoped to workspace ${scope.workspace_id}; refusing cross-workspace query`,
      );
    }
  }

  private isVisible(
    scope: AccessScope,
    filter: TraceFilter | undefined,
    event: TraceEvent,
  ): boolean {
    if (event.enterprise_id !== scope.enterprise_id || event.workspace_id !== scope.workspace_id) {
      return false;
    }
    return matchesFilter(filter, event);
  }

  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as unknown;
    for (const serialized of migratePersistedState(raw).events) {
      const event = migrateTraceEvent(serialized);
      const key = identityKey(event.source, event.event_id);
      const fingerprint = fingerprintOf(event);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new TraceConflictError(
            `persisted trace event ${event.source}/${event.event_id} appears twice with different content`,
          );
        }
        continue;
      }
      this.entries.set(key, { event, fingerprint });
    }
  }

  /** Coalesce mutations into one write per tick; delta storms stay cheap. */
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

/** Version-0 was the unversioned shape; migrate before reading anything. */
function migratePersistedState(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("trace store is not a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const version = typeof value["schema_version"] === "number" ? value["schema_version"] : 0;
  if (version > TRACE_SCHEMA_VERSION) {
    throw new Error(`trace store schema ${version} is newer than ${TRACE_SCHEMA_VERSION}`);
  }
  const events = Array.isArray(value["events"]) ? (value["events"] as TraceEvent[]) : [];
  return { schema_version: TRACE_SCHEMA_VERSION, events };
}
