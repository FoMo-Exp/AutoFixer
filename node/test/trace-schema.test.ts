import { describe, expect, test } from "vitest";

import {
  TRACE_SCHEMA_VERSION,
  TraceValidationError,
  migrateTraceEvent,
  validateTraceEvent,
} from "../src/trace/schema.js";
import type { TraceEvent } from "../src/trace/schema.js";

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    source: "worker-1",
    event_id: "evt-1",
    version: TRACE_SCHEMA_VERSION,
    sequence: 1,
    event_time: "2026-11-03T00:00:01.000Z",
    ingest_time: "2026-11-03T00:00:02.000Z",
    record_class: "operational_trace",
    kind: "agent.run_started",
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    task_id: "tsk-1",
    run_id: "run-1",
    attempt_id: "att-1",
    agent_id: "agent-1",
    agent_config_revision: "cfg-1",
    invocation_id: null,
    tool_id: null,
    artifact_id: null,
    delivery_id: null,
    trace_id: "trace-1",
    span_id: "span-1",
    parent_span_id: null,
    causation_id: null,
    evidence_refs: [],
    labels: {},
    payload: null,
    truncated: false,
    ...overrides,
  };
}

describe("trace event envelope validation", () => {
  test("a complete event validates and round-trips unchanged", () => {
    const event = makeEvent();
    expect(validateTraceEvent(event)).toEqual(event);
  });

  test("a missing writer identity is rejected", () => {
    const raw = makeEvent() as unknown as Record<string, unknown>;
    delete raw["source"];
    expect(() => validateTraceEvent(raw)).toThrow(TraceValidationError);
  });

  test("unknown event kinds and record classes are rejected", () => {
    expect(() => validateTraceEvent(makeEvent({ kind: "made.up" as TraceEvent["kind"] }))).toThrow(
      TraceValidationError,
    );
    expect(() =>
      validateTraceEvent(makeEvent({ record_class: "billing" as TraceEvent["record_class"] })),
    ).toThrow(TraceValidationError);
  });

  test("empty scope identifiers are rejected", () => {
    expect(() => validateTraceEvent(makeEvent({ enterprise_id: "" }))).toThrow(
      TraceValidationError,
    );
    expect(() => validateTraceEvent(makeEvent({ workspace_id: "" }))).toThrow(TraceValidationError);
  });

  test("a malformed event_time is rejected", () => {
    expect(() => validateTraceEvent(makeEvent({ event_time: "not-a-timestamp" }))).toThrow(
      TraceValidationError,
    );
  });

  test("labels outside the metric vocabulary are rejected at the envelope", () => {
    expect(() =>
      validateTraceEvent(makeEvent({ labels: { error_message: "boom at foo.ts:12" } })),
    ).toThrow(TraceValidationError);
  });
});

describe("schema version and migration strategy", () => {
  test("an unversioned legacy event migrates to the current schema with explicit defaults", () => {
    const legacy = {
      source: "worker-legacy",
      event_id: "evt-legacy",
      sequence: 4,
      event_time: "2026-11-03T00:00:01.000Z",
      kind: "queue.enqueued",
      enterprise_id: "ent-1",
      workspace_id: "ws-1",
      trace_id: "trace-1",
      span_id: "span-1",
    };
    const migrated = migrateTraceEvent(legacy);
    expect(migrated.version).toBe(TRACE_SCHEMA_VERSION);
    expect(migrated.record_class).toBe("operational_trace");
    expect(migrated.truncated).toBe(false);
    expect(migrated.evidence_refs).toEqual([]);
    expect(migrated.labels).toEqual({});
    expect(migrated.payload).toBeNull();
    // ingest_time falls back to the writer's event time so the record stays
    // honest about when it happened even when its arrival was never recorded.
    expect(migrated.ingest_time).toBe(legacy.event_time);
    expect(migrated.parent_span_id).toBeNull();
    expect(migrated.causation_id).toBeNull();
    expect(migrated.issue_id).toBeNull();
    expect(migrated.agent_config_revision).toBeNull();
  });

  test("a current-version event passes through migration unchanged", () => {
    const event = makeEvent();
    expect(migrateTraceEvent(event)).toEqual(event);
  });

  test("a future schema version is rejected loudly instead of misread", () => {
    const future = makeEvent({ version: TRACE_SCHEMA_VERSION + 1 });
    expect(() => migrateTraceEvent(future)).toThrow(TraceValidationError);
    expect(() => migrateTraceEvent(future)).toThrow(/newer/);
    expect(() => validateTraceEvent(future)).toThrow(TraceValidationError);
  });
});
