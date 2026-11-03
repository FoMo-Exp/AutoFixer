/**
 * Trace exporter boundary (DAT-225).
 *
 * External tracing/analytics exporters are an egress path, so they follow
 * ADR-0005 like any other: a destination is only trusted when it is
 * explicitly registered with an approval reference and the data classes it
 * is approved to receive, and a record whose classes the destination is not
 * authorized for is refused before any byte leaves. The authorization rule
 * is the gateway's own `authorizeRequestDataClasses`, so trace export and
 * model dispatch can never disagree about what a destination may see.
 *
 * Mandatory records — required action/decision/error evidence — are never
 * lost while a remote exporter is unavailable: durable local capture holds
 * them and pending-mandatory delivery recovers them even when the bounded
 * delivery buffer had to drop them. The buffer bounds high-volume debug
 * delivery with explicit drop counters, and capture capacity exhaustion
 * stops the actions that need the evidence instead of silently proceeding
 * without it (`EvidenceGate`). Export re-scans every string before delivery;
 * an export can never become a second leak surface.
 */
import fs from "node:fs";
import path from "node:path";

import { authorizeRequestDataClasses } from "../gateway/scan.js";
import type { DataClass } from "../gateway/types.js";

import { redactContentStrings } from "./content.js";
import { TraceConflictError, TraceValidationError } from "./errors.js";

/** One record on its way to durable capture and external export. */
export interface ExportItem {
  /** Writer identity; with `event_id` the record's dedup identity. */
  source: string;
  event_id: string;
  /** Content classes this record carries (DAT-209 vocabulary). */
  data_classes: DataClass[];
  /**
   * Required action/decision/error evidence. Mandatory records are never
   * dropped from durable capture; capacity exhaustion for them blocks.
   */
  mandatory: boolean;
  /** JSON-safe record body (e.g. a trace event); string values are scanned. */
  record: Record<string, unknown>;
}

/**
 * A deployment-registered, ADR-0005-approved export destination, mirroring
 * the gateway's `ApprovedEndpoint` rule: registration is the only evidence
 * of trust, and missing permitted data classes fail closed at export time.
 */
export interface ApprovedExportDestination {
  readonly destination_id: string;
  /** ADR-0005 destination approval reference recorded by the enterprise. */
  readonly approval_ref: string;
  /** Data classes explicitly permitted at this destination. */
  readonly permitted_data_classes?: readonly DataClass[];
}

/**
 * Trusted ADR-0005 export-destination authority, injected at service
 * bootstrap — never supplied per call. Callers assert a destination id and
 * never their own approval: a non-empty approval string or a caller-built
 * destination object is not a credential, only this authority is.
 */
export interface ExportDestinationAuthority {
  /** The approved registration for this destination id, or nothing. */
  approved(destinationId: string): ApprovedExportDestination | undefined;
}

/**
 * Fail-closed destination registry. Its contents come from the
 * deployment-owned export-approval configuration (see
 * {@link parseApprovedExportDestinations}); an unapproved or unknown id
 * resolves to nothing and is refused at export.
 */
export class ExportApprovalRegistry implements ExportDestinationAuthority {
  private readonly byId = new Map<string, ApprovedExportDestination>();

  constructor(options: { destinations: readonly ApprovedExportDestination[] }) {
    for (const destination of options.destinations) {
      if (
        typeof destination.destination_id !== "string" ||
        destination.destination_id.length === 0
      ) {
        throw new TraceValidationError("export destination_id must be a non-empty string");
      }
      if (typeof destination.approval_ref !== "string" || destination.approval_ref.length === 0) {
        throw new ExportDestinationNotApprovedError(
          `export destination ${destination.destination_id} has no ADR-0005 approval reference`,
        );
      }
      if (destination.permitted_data_classes !== undefined) {
        assertDataClasses(destination.permitted_data_classes, "export destination");
      }
      if (this.byId.has(destination.destination_id)) {
        throw new TraceValidationError(
          `export destination ${destination.destination_id} is already registered`,
        );
      }
      this.byId.set(
        destination.destination_id,
        Object.freeze({
          ...destination,
          permitted_data_classes: destination.permitted_data_classes
            ? Object.freeze([...destination.permitted_data_classes])
            : undefined,
        }),
      );
    }
  }

  approved(destinationId: string): ApprovedExportDestination | undefined {
    return this.byId.get(destinationId);
  }
}

/**
 * Parse the deployment-owned export-approval configuration (a protected
 * file assembled at bootstrap, like the gateway policy). The parsed records
 * feed {@link ExportApprovalRegistry}; nothing parsed from a per-call
 * object can ever approve itself.
 */
export function parseApprovedExportDestinations(value: unknown): ApprovedExportDestination[] {
  if (!Array.isArray(value)) {
    throw new TraceValidationError("export approval config must be an array");
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TraceValidationError("export approval config entries must be JSON objects");
    }
    const record = entry as Record<string, unknown>;
    const destinationId = record["destination_id"];
    const approvalRef = record["approval_ref"];
    if (typeof destinationId !== "string" || destinationId.length === 0) {
      throw new TraceValidationError(
        "export approval entry destination_id must be a non-empty string",
      );
    }
    if (typeof approvalRef !== "string" || approvalRef.length === 0) {
      throw new ExportDestinationNotApprovedError(
        `export destination ${destinationId} has no ADR-0005 approval reference`,
      );
    }
    const permitted = record["permitted_data_classes"];
    if (permitted !== undefined) {
      return {
        destination_id: destinationId,
        approval_ref: approvalRef,
        permitted_data_classes: assertDataClasses(permitted, "export destination"),
      };
    }
    return { destination_id: destinationId, approval_ref: approvalRef };
  });
}

/** The remote exporter. Throwing marks it unavailable; records stay pending. */
export interface ExportTransport {
  deliver(items: readonly ExportItem[]): void;
}

export class ExportDestinationNotApprovedError extends Error {
  readonly code = "EXPORT_DESTINATION_NOT_APPROVED";

  constructor(message: string) {
    super(message);
    this.name = "ExportDestinationNotApprovedError";
  }
}

/** Mandatory evidence cannot be captured: the action needing it must stop. */
export class CaptureCapacityExhaustedError extends Error {
  readonly code = "CAPTURE_CAPACITY_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "CaptureCapacityExhaustedError";
  }
}

/** JSON pair encoding so delimiters inside source or event ids cannot collide. */
function identityKey(source: string, eventId: string): string {
  return JSON.stringify([source, eventId]);
}

function totalBytesOf(state: ReadonlyMap<string, { bytes: number }>): number {
  let bytes = 0;
  for (const stored of state.values()) {
    bytes += stored.bytes;
  }
  return bytes;
}

/** Evict the oldest non-mandatory record from a planned state; returns its key. */
function evictOldestDebug(state: Map<string, StoredCapture>): string | null {
  for (const [key, stored] of state.entries()) {
    if (!stored.item.mandatory) {
      state.delete(key);
      return key;
    }
  }
  return null;
}

/** Closed DAT-209 data-class vocabulary; own-property membership only. */
const DATA_CLASS_VOCABULARY: Record<DataClass, true> = {
  system: true,
  user_input: true,
  history: true,
  code: true,
  logs: true,
  diffs: true,
  tool_results: true,
  derived_summaries: true,
};

/** Own-property membership in the closed DAT-209 data-class vocabulary. */
function isDataClass(value: unknown): value is DataClass {
  return typeof value === "string" && Object.hasOwn(DATA_CLASS_VOCABULARY, value);
}

/** Validate the closed DAT-209 data-class vocabulary; returns the classes. */
function assertDataClasses(value: unknown, where: string): DataClass[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TraceValidationError(`${where} must carry at least one data class`);
  }
  const classes: DataClass[] = [];
  for (const entry of value) {
    if (!isDataClass(entry)) {
      throw new TraceValidationError(
        `${where} data class ${JSON.stringify(entry)} is not recognized`,
      );
    }
    classes.push(entry);
  }
  return classes;
}

function assertExportItem(item: ExportItem): void {
  if (typeof item.source !== "string" || item.source.length === 0) {
    throw new TraceValidationError("export item source must be a non-empty string");
  }
  if (typeof item.event_id !== "string" || item.event_id.length === 0) {
    throw new TraceValidationError("export item event_id must be a non-empty string");
  }
  if (typeof item.mandatory !== "boolean") {
    throw new TraceValidationError("export item mandatory must be a boolean");
  }
  if (item.record === null || typeof item.record !== "object" || Array.isArray(item.record)) {
    throw new TraceValidationError("export item record must be a JSON object");
  }
  assertDataClasses(item.data_classes, "export item");
}

// ---------------------------------------------------------------------------
// Durable local capture
// ---------------------------------------------------------------------------

export type CaptureOutcome = "captured" | "duplicate" | "dropped";

export interface DurableCaptureOptions {
  /** Durable JSONL file (0600 in a 0700 directory). Omit for process-local tests. */
  path?: string;
  /** Maximum live captured records. */
  maxRecords: number;
  /** Maximum bytes the durable capture file may hold. */
  maxBytes: number;
}

export interface DurableCaptureCounters {
  captured: number;
  duplicates: number;
  /** Debug records dropped at capacity. */
  dropped: number;
  /** Debug records evicted to make room for mandatory evidence. */
  evicted: number;
  delivered: number;
}

interface StoredCapture {
  item: ExportItem;
  /** Writer-owned content identity; a conflicting redelivery is refused. */
  fingerprint: string;
  bytes: number;
}

/**
 * Append-only durable capture for export records: the lossless local layer
 * mandatory records live in while remote exporters are unavailable. The file
 * always holds exactly the live records (it is compacted when a debug record
 * is evicted), so the capacity bounds are real bounds. Every record is
 * scanned and redacted before it is written. Debug records drop or evict
 * with explicit counters; mandatory capture at exhaustion throws so the
 * caller can stop the action that needs the evidence. Delivery marks are
 * process-local: after a restart undelivered records are re-delivered
 * (at-least-once; consumers deduplicate by source/event identity).
 */
export class DurableLocalCapture {
  private stored = new Map<string, StoredCapture>();
  private readonly deliveredKeys = new Set<string>();
  private readonly filePath: string | undefined;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly counts: DurableCaptureCounters = {
    captured: 0,
    duplicates: 0,
    dropped: 0,
    evicted: 0,
    delivered: 0,
  };

  constructor(options: DurableCaptureOptions) {
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new TraceValidationError("capture maxRecords must be a positive integer");
    }
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TraceValidationError("capture maxBytes must be a positive integer");
    }
    this.filePath = options.path;
    this.maxRecords = options.maxRecords;
    this.maxBytes = options.maxBytes;
    this.load();
  }

  /**
   * Capture one record, scanning and redacting it first. Duplicate delivery
   * of identical content is deduplicated; a redelivery that changes content
   * is refused, so capture can never rewrite what it already holds.
   */
  append(input: ExportItem): CaptureOutcome {
    assertExportItem(input);
    const item: ExportItem = {
      ...input,
      data_classes: [...input.data_classes],
      record: redactContentStrings(input.record) as Record<string, unknown>,
    };
    const key = identityKey(item.source, item.event_id);
    const fingerprint = JSON.stringify(item);
    const existing = this.stored.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new TraceConflictError(
          `capture record ${item.source}/${item.event_id} is already captured with different content`,
        );
      }
      this.counts.duplicates += 1;
      return "duplicate";
    }
    const bytes = Buffer.byteLength(`${JSON.stringify(item)}\n`, "utf8");
    // Plan the next state and commit memory only together with durable
    // state: a failed write leaves nothing in memory, so the retry of a
    // failed write re-attempts the write instead of being misjudged as an
    // already-persisted duplicate.
    const next = new Map(this.stored);
    const evictedKeys: string[] = [];
    while (next.size >= this.maxRecords || totalBytesOf(next) + bytes > this.maxBytes) {
      if (!item.mandatory) {
        this.counts.dropped += 1;
        return "dropped";
      }
      const evicted = evictOldestDebug(next);
      if (evicted === null) {
        throw new CaptureCapacityExhaustedError(
          `durable capture is at capacity and holds no evictable debug records; ` +
            `mandatory evidence ${item.source}/${item.event_id} cannot be captured`,
        );
      }
      evictedKeys.push(evicted);
    }
    next.set(key, { item, fingerprint, bytes });
    this.writeAll(next);
    this.stored = next;
    for (const evicted of evictedKeys) {
      this.deliveredKeys.delete(evicted);
    }
    this.counts.evicted += evictedKeys.length;
    this.counts.captured += 1;
    return "captured";
  }

  /** Live records not yet delivered, in capture order. */
  pending(): ExportItem[] {
    return [...this.stored.entries()]
      .filter(([key]) => !this.deliveredKeys.has(key))
      .map(([, stored]) => structuredClone(stored.item));
  }

  /** Mandatory records not yet delivered — the not-lost guarantee. */
  pendingMandatory(): ExportItem[] {
    return this.pending().filter((item) => item.mandatory);
  }

  markDelivered(items: readonly ExportItem[]): void {
    for (const item of items) {
      const key = identityKey(item.source, item.event_id);
      if (this.stored.has(key) && !this.deliveredKeys.has(key)) {
        this.deliveredKeys.add(key);
        this.counts.delivered += 1;
      }
    }
  }

  /** Every live record, delivered or not. */
  readAll(): ExportItem[] {
    return [...this.stored.values()].map((stored) => structuredClone(stored.item));
  }

  counters(): DurableCaptureCounters {
    return { ...this.counts };
  }

  /** The file holds exactly the live records of the committed state; writes are atomic. */
  private writeAll(state: ReadonlyMap<string, StoredCapture>): void {
    if (this.filePath === undefined) {
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { mode: 0o700, recursive: true });
    const lines = [...state.values()].map((stored) => JSON.stringify(stored.item)).join("\n");
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, lines.length > 0 ? `${lines}\n` : "", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup; the original write failure is what matters.
      }
      throw error;
    }
  }

  private load(): void {
    if (this.filePath === undefined || !fs.existsSync(this.filePath)) {
      return;
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    for (const rawLine of raw.split("\n")) {
      if (rawLine.length === 0) {
        continue;
      }
      let item: ExportItem;
      try {
        item = JSON.parse(rawLine) as ExportItem;
      } catch {
        // Corrupt capture state fails startup; it is never quietly read as empty.
        throw new Error(
          "durable capture file contains an unparseable line; refusing to drop records",
        );
      }
      assertExportItem(item);
      const safe: ExportItem = {
        ...item,
        data_classes: [...item.data_classes],
        record: redactContentStrings(item.record) as Record<string, unknown>,
      };
      const key = identityKey(safe.source, safe.event_id);
      const fingerprint = JSON.stringify(safe);
      const existing = this.stored.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new TraceConflictError(
            `durable capture file holds ${safe.source}/${safe.event_id} twice with different content`,
          );
        }
        continue;
      }
      this.stored.set(key, {
        item: safe,
        fingerprint,
        bytes: Buffer.byteLength(`${rawLine}\n`, "utf8"),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded delivery buffer
// ---------------------------------------------------------------------------

export interface ExportBufferOptions {
  /** Maximum records awaiting delivery; overflow drops are counted explicitly. */
  maxRecords: number;
}

/**
 * The bounded delivery queue in front of a remote exporter. It bounds
 * high-volume debug delivery; dropped records are counted, and mandatory
 * records stay recoverable from durable capture regardless.
 */
export class ExportBuffer {
  private readonly pendingByKey = new Map<string, ExportItem>();
  private readonly maxRecords: number;
  private readonly counts = { queued: 0, dropped: 0 };

  constructor(options: ExportBufferOptions) {
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new TraceValidationError("export buffer maxRecords must be a positive integer");
    }
    this.maxRecords = options.maxRecords;
  }

  enqueue(item: ExportItem): "queued" | "dropped" {
    const key = identityKey(item.source, item.event_id);
    if (this.pendingByKey.has(key)) {
      return "queued";
    }
    if (this.pendingByKey.size >= this.maxRecords) {
      this.counts.dropped += 1;
      return "dropped";
    }
    this.pendingByKey.set(key, item);
    this.counts.queued += 1;
    return "queued";
  }

  /** Records awaiting delivery, in queue order. */
  peek(): ExportItem[] {
    return [...this.pendingByKey.values()].map((item) => structuredClone(item));
  }

  remove(items: readonly ExportItem[]): void {
    for (const item of items) {
      this.pendingByKey.delete(identityKey(item.source, item.event_id));
    }
  }

  counters(): { queued: number; dropped: number } {
    return { ...this.counts };
  }

  get size(): number {
    return this.pendingByKey.size;
  }
}

// ---------------------------------------------------------------------------
// Exporter boundary
// ---------------------------------------------------------------------------

export interface ExportRefusal {
  item: ExportItem;
  reason: "AUTHORIZATION_MISSING" | "DATA_CLASS_NOT_AUTHORIZED";
  detail: string;
}

export type FlushOutcome =
  | { status: "delivered"; delivered: number; refused: ExportRefusal[] }
  | { status: "unavailable"; delivered: number; refused: ExportRefusal[] };

export interface TraceExporterCounters {
  captured: number;
  capture_dropped: number;
  capture_evicted: number;
  buffer_dropped: number;
  delivered: number;
  refused: number;
  failed_flushes: number;
}

export interface TraceExporterOptions {
  capture: DurableLocalCapture;
  buffer: ExportBuffer;
  transport: ExportTransport;
  /**
   * Trusted ADR-0005 destination authority, injected at service bootstrap.
   * It is the only evidence of trust: a caller cannot approve itself.
   */
  destinations: ExportDestinationAuthority;
}

/**
 * The exporter boundary: destination approval, per-record data-class
 * authorization, export-time re-scan, and pending-mandatory recovery. The
 * durable capture stays authoritative for mandatory records; the buffer is
 * only a bounded delivery optimization in front of it.
 */
export class TraceExporter {
  private readonly capture: DurableLocalCapture;
  private readonly buffer: ExportBuffer;
  private readonly transport: ExportTransport;
  private readonly destinations: ExportDestinationAuthority;
  private readonly counts = { delivered: 0, refused: 0, failed_flushes: 0 };

  constructor(options: TraceExporterOptions) {
    this.capture = options.capture;
    this.buffer = options.buffer;
    this.transport = options.transport;
    this.destinations = options.destinations;
  }

  /**
   * Capture one record: scan and redact before any persistence, then queue
   * it for delivery. Mandatory capture failures propagate so the caller can
   * stop the action that needs this evidence.
   */
  captureItem(item: ExportItem): { capture: CaptureOutcome; queued: boolean } {
    const safe: ExportItem = {
      ...item,
      data_classes: [...item.data_classes],
      record: redactContentStrings(item.record) as Record<string, unknown>,
    };
    const outcome = this.capture.append(safe);
    const queued = outcome === "captured" ? this.buffer.enqueue(safe) === "queued" : false;
    return { capture: outcome, queued };
  }

  /**
   * Deliver pending records to one approved destination. The batch is the
   * bounded buffer plus every undelivered mandatory record from durable
   * capture, so a record the buffer dropped is still delivered. Each record
   * is authorized against the destination's permitted data classes and
   * re-scanned before delivery; a refusal keeps the record pending for a
   * destination that is approved for it, and a failing transport keeps
   * everything pending.
   */
  flush(destination_id: string): FlushOutcome {
    // Approval comes from the injected authority, never from the caller.
    const destination = this.destinations.approved(destination_id);
    if (destination === undefined) {
      throw new ExportDestinationNotApprovedError(
        `export destination ${destination_id} is not approved for export`,
      );
    }
    const batch = new Map<string, ExportItem>();
    for (const item of [...this.buffer.peek(), ...this.capture.pendingMandatory()]) {
      batch.set(identityKey(item.source, item.event_id), item);
    }
    const refused: ExportRefusal[] = [];
    const deliverable: ExportItem[] = [];
    for (const item of batch.values()) {
      const verdict = authorizeRequestDataClasses(item.data_classes, {
        permittedDataClasses: destination.permitted_data_classes
          ? [...destination.permitted_data_classes]
          : undefined,
      });
      if (verdict.ok) {
        deliverable.push(item);
      } else {
        refused.push({ item, reason: verdict.reason, detail: verdict.detail });
      }
    }
    this.counts.refused += refused.length;
    const payload = deliverable.map((item) => ({
      ...item,
      data_classes: [...item.data_classes],
      record: redactContentStrings(item.record) as Record<string, unknown>,
    }));
    if (payload.length > 0) {
      try {
        this.transport.deliver(payload);
      } catch {
        this.counts.failed_flushes += 1;
        return { status: "unavailable", delivered: 0, refused };
      }
    }
    this.buffer.remove(deliverable);
    this.capture.markDelivered(deliverable);
    this.counts.delivered += deliverable.length;
    return { status: "delivered", delivered: deliverable.length, refused };
  }

  counters(): TraceExporterCounters {
    const capture = this.capture.counters();
    const buffer = this.buffer.counters();
    return {
      captured: capture.captured,
      capture_dropped: capture.dropped,
      capture_evicted: capture.evicted,
      buffer_dropped: buffer.dropped,
      delivered: this.counts.delivered,
      refused: this.counts.refused,
      failed_flushes: this.counts.failed_flushes,
    };
  }
}

/**
 * The evidence gate in front of actions whose evidence is mandatory: the
 * evidence is durably captured first, and capture capacity exhaustion is an
 * action-stopping failure, never a silent gap (ADR-0008: exhaustion stops
 * actions needing that evidence).
 */
export class EvidenceGate {
  private readonly capture: DurableLocalCapture;

  constructor(capture: DurableLocalCapture) {
    this.capture = capture;
  }

  /** Durably capture one action's required evidence before the action runs. */
  requireEvidence(evidence: Omit<ExportItem, "mandatory">): ExportItem {
    const item: ExportItem = {
      source: evidence.source,
      event_id: evidence.event_id,
      data_classes: [...evidence.data_classes],
      mandatory: true,
      record: evidence.record,
    };
    this.capture.append(item);
    return item;
  }
}
