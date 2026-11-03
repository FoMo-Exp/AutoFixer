/**
 * Trace/event envelope shared by every AutoFixer writer (DAT-224).
 *
 * Three record classes keep authority where it already lives: dsh's
 * control-plane audit chain and worker evidence each keep their own
 * authoritative writers and event IDs, and operational traces only reference
 * them (`evidence_refs`) — nothing here rewrites or reorders dsh evidence,
 * and nothing claims a single global order. Ordering authority is per source
 * (`sequence`); `event_time` and `ingest_time` stay distinct so views can be
 * honest about freshness and late arrival.
 *
 * Schema policy: `version` is the event schema version. Writers emit the
 * current version; `migrateTraceEvent` upgrades older records forward one
 * step at a time and rejects newer versions loudly instead of misreading
 * them, so history can never be silently reinterpreted.
 */
import { TraceValidationError } from "./errors.js";
import { validateMetricLabels } from "./labels.js";

export { TraceValidationError } from "./errors.js";

export const TRACE_SCHEMA_VERSION = 1;

export const TRACE_RECORD_CLASSES = [
  "control_plane_audit",
  "worker_evidence",
  "operational_trace",
] as const;

export type TraceRecordClass = (typeof TRACE_RECORD_CLASSES)[number];

export const TRACE_EVENT_KINDS = [
  "queue.enqueued",
  "queue.retried",
  "gateway.invocation_started",
  "gateway.invocation_finished",
  "agent.run_started",
  "agent.run_finished",
  "agent.handoff",
  "tool.executed",
  "dsh.evidence_recorded",
  "sandbox.executed",
  "delivery.attempted",
  "delivery.finished",
  "error.raised",
] as const;

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

/** Correlation chain carried across queues, workers, gateway, dsh, sandbox and delivery. */
export interface TraceEvent {
  /** Authoritative writer identity; with `event_id` it forms the dedup identity. */
  source: string;
  event_id: string;
  /** Schema version of this record. */
  version: number;
  /** Order within this source's stream; the only ordering authority. */
  sequence: number;
  /** RFC 3339 time the event happened, per the writer's clock. */
  event_time: string;
  /** RFC 3339 time this store first recorded the event. */
  ingest_time: string;
  record_class: TraceRecordClass;
  kind: TraceEventKind;
  enterprise_id: string;
  workspace_id: string;
  issue_id: string | null;
  task_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  agent_id: string | null;
  agent_config_revision: string | null;
  invocation_id: string | null;
  tool_id: string | null;
  artifact_id: string | null;
  delivery_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  /** `source/event_id` of the record that caused this one, when known. */
  causation_id: string | null;
  /** References to authoritative evidence; the store never copies or rewrites it. */
  evidence_refs: string[];
  /** Metric-safe labels only; see labels.ts. */
  labels: Record<string, string>;
  /** Free-form detail; never readable by metrics or labels. */
  payload: Record<string, unknown> | null;
  /** Writer-marked payload truncation; projections surface it, never hide it. */
  truncated: boolean;
}

/** Writer-supplied fields; the store stamps `ingest_time` and schema defaults. */
export interface NewTraceEvent {
  source: string;
  event_id: string;
  sequence: number;
  event_time: string;
  record_class: TraceRecordClass;
  kind: TraceEventKind;
  enterprise_id: string;
  workspace_id: string;
  trace_id: string;
  span_id: string;
  version?: number;
  ingest_time?: string;
  parent_span_id?: string | null;
  issue_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  attempt_id?: string | null;
  agent_id?: string | null;
  agent_config_revision?: string | null;
  invocation_id?: string | null;
  tool_id?: string | null;
  artifact_id?: string | null;
  delivery_id?: string | null;
  causation_id?: string | null;
  evidence_refs?: string[];
  labels?: Record<string, string>;
  payload?: Record<string, unknown> | null;
  truncated?: boolean;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TraceValidationError(`trace ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceValidationError(`trace event field "${field}" must be a non-empty string`);
  }
  return value;
}

function asNullableId(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asNonEmptyString(value, field);
}

function asTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new TraceValidationError(`trace event field "${field}" must be an RFC 3339 timestamp`);
  }
  return value;
}

function asSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TraceValidationError(`trace event field "sequence" must be an integer starting at 1`);
  }
  return value;
}

/**
 * Validate one fully-shaped current-version event. Returns the input object;
 * a missing required field, an unknown kind, or a label outside the metric
 * vocabulary is a control failure, not a defaulted value.
 */
export function validateTraceEvent(value: unknown): TraceEvent {
  const record = asRecord(value, "event");
  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new TraceValidationError(`trace event field "version" must be an integer`);
  }
  if (version > TRACE_SCHEMA_VERSION) {
    throw new TraceValidationError(
      `trace event schema ${version} is newer than ${TRACE_SCHEMA_VERSION}`,
    );
  }
  if (version !== TRACE_SCHEMA_VERSION) {
    throw new TraceValidationError(
      `trace event schema ${version} must be migrated to ${TRACE_SCHEMA_VERSION} first`,
    );
  }
  asNonEmptyString(record["source"], "source");
  asNonEmptyString(record["event_id"], "event_id");
  asSequence(record["sequence"]);
  asTimestamp(record["event_time"], "event_time");
  asTimestamp(record["ingest_time"], "ingest_time");
  const recordClass = asNonEmptyString(record["record_class"], "record_class");
  if (!TRACE_RECORD_CLASSES.includes(recordClass as TraceRecordClass)) {
    throw new TraceValidationError(`trace event field "record_class" has unknown value`);
  }
  const kind = asNonEmptyString(record["kind"], "kind");
  if (!TRACE_EVENT_KINDS.includes(kind as TraceEventKind)) {
    throw new TraceValidationError(`trace event field "kind" has unknown value`);
  }
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  asNullableId(record["issue_id"], "issue_id");
  asNullableId(record["task_id"], "task_id");
  asNullableId(record["run_id"], "run_id");
  asNullableId(record["attempt_id"], "attempt_id");
  asNullableId(record["agent_id"], "agent_id");
  asNullableId(record["agent_config_revision"], "agent_config_revision");
  asNullableId(record["invocation_id"], "invocation_id");
  asNullableId(record["tool_id"], "tool_id");
  asNullableId(record["artifact_id"], "artifact_id");
  asNullableId(record["delivery_id"], "delivery_id");
  asNonEmptyString(record["trace_id"], "trace_id");
  asNonEmptyString(record["span_id"], "span_id");
  asNullableId(record["parent_span_id"], "parent_span_id");
  asNullableId(record["causation_id"], "causation_id");
  const evidenceRefs = record["evidence_refs"];
  if (!Array.isArray(evidenceRefs)) {
    throw new TraceValidationError(`trace event field "evidence_refs" must be an array`);
  }
  for (const ref of evidenceRefs) {
    asNonEmptyString(ref, "evidence_refs[]");
  }
  validateMetricLabels(record["labels"]);
  const payload = record["payload"];
  if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new TraceValidationError(`trace event field "payload" must be an object or null`);
  }
  if (typeof record["truncated"] !== "boolean") {
    throw new TraceValidationError(`trace event field "truncated" must be a boolean`);
  }
  return record as unknown as TraceEvent;
}

/**
 * Upgrade one stored record to the current schema and validate it.
 *
 * Version 0 is the unversioned legacy shape; it receives explicit defaults
 * (an operational trace with no payload, no evidence refs, and `ingest_time`
 * falling back to `event_time`) rather than being guessed as authority it
 * never claimed. Newer versions are refused instead of misread.
 */
export function migrateTraceEvent(raw: unknown): TraceEvent {
  const record = asRecord(raw, "event");
  const version = record["version"];
  if (version !== undefined && version !== null) {
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new TraceValidationError(`trace event field "version" must be an integer`);
    }
    if (version > TRACE_SCHEMA_VERSION) {
      throw new TraceValidationError(
        `trace event schema ${version} is newer than ${TRACE_SCHEMA_VERSION}`,
      );
    }
  }
  const upgraded = {
    source: record["source"],
    event_id: record["event_id"],
    version: TRACE_SCHEMA_VERSION,
    sequence: record["sequence"],
    event_time: record["event_time"],
    ingest_time: record["ingest_time"] ?? record["event_time"],
    record_class: record["record_class"] ?? "operational_trace",
    kind: record["kind"],
    enterprise_id: record["enterprise_id"],
    workspace_id: record["workspace_id"],
    issue_id: record["issue_id"] ?? null,
    task_id: record["task_id"] ?? null,
    run_id: record["run_id"] ?? null,
    attempt_id: record["attempt_id"] ?? null,
    agent_id: record["agent_id"] ?? null,
    agent_config_revision: record["agent_config_revision"] ?? null,
    invocation_id: record["invocation_id"] ?? null,
    tool_id: record["tool_id"] ?? null,
    artifact_id: record["artifact_id"] ?? null,
    delivery_id: record["delivery_id"] ?? null,
    trace_id: record["trace_id"],
    span_id: record["span_id"],
    parent_span_id: record["parent_span_id"] ?? null,
    causation_id: record["causation_id"] ?? null,
    evidence_refs: record["evidence_refs"] ?? [],
    labels: record["labels"] ?? {},
    payload: record["payload"] ?? null,
    truncated: record["truncated"] ?? false,
  };
  return validateTraceEvent(upgraded);
}
