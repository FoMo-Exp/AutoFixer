import { describe, expect, test } from "vitest";

import { projectTraceEvents } from "../src/trace/projection.js";
import { TRACE_SCHEMA_VERSION } from "../src/trace/schema.js";
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

describe("projection completeness markers", () => {
  test("sequence gaps are visible as missing records", () => {
    const projection = projectTraceEvents([
      makeEvent({ event_id: "e1", sequence: 1 }),
      makeEvent({ event_id: "e2", sequence: 2 }),
      makeEvent({ event_id: "e5", sequence: 5, span_id: "span-5" }),
    ]);
    expect(projection.completeness.missing).toEqual([
      { source: "worker-1", from_sequence: 3, to_sequence: 4 },
    ]);
    expect(projection.completeness.complete).toBe(false);
  });

  test("out-of-order arrival is flagged late without losing the record", () => {
    const projection = projectTraceEvents([
      makeEvent({ event_id: "e1", sequence: 1, event_time: "2026-11-03T00:00:01.000Z" }),
      makeEvent({
        event_id: "e3",
        sequence: 3,
        span_id: "span-3",
        event_time: "2026-11-03T00:00:03.000Z",
      }),
      makeEvent({
        event_id: "e2",
        sequence: 2,
        span_id: "span-2",
        event_time: "2026-11-03T00:00:02.000Z",
      }),
    ]);
    expect(projection.completeness.late_event_ids).toEqual(["e2"]);
    expect(projection.events.find((event) => event.event_id === "e2")?.late).toBe(true);
    expect(projection.events.find((event) => event.event_id === "e1")?.late).toBe(false);
    expect(projection.completeness.missing).toEqual([]);
  });

  test("truncated records are labeled instead of silently dropped", () => {
    const projection = projectTraceEvents([makeEvent({ event_id: "e1", truncated: true })]);
    expect(projection.completeness.truncated_event_ids).toEqual(["e1"]);
    expect(projection.completeness.complete).toBe(false);
    expect(projection.events).toHaveLength(1);
  });

  test("a clean projection reports complete", () => {
    const projection = projectTraceEvents([
      makeEvent({ event_id: "e1", sequence: 1 }),
      makeEvent({ event_id: "e2", sequence: 2, span_id: "span-2" }),
    ]);
    expect(projection.completeness).toEqual({
      complete: true,
      missing: [],
      late_event_ids: [],
      truncated_event_ids: [],
    });
    expect(projection.events.every((event) => event.late === false)).toBe(true);
  });
});

describe("projection freshness", () => {
  test("watermarks reflect the known event and ingest times", () => {
    const projection = projectTraceEvents([
      makeEvent({
        event_id: "e1",
        event_time: "2026-11-03T00:00:01.000Z",
        ingest_time: "2026-11-03T00:00:05.000Z",
      }),
      makeEvent({
        event_id: "e2",
        sequence: 2,
        span_id: "span-2",
        event_time: "2026-11-03T00:00:02.000Z",
        ingest_time: "2026-11-03T00:00:06.000Z",
      }),
    ]);
    expect(projection.freshness).toEqual({
      as_of: "2026-11-03T00:00:06.000Z",
      event_time_watermark: "2026-11-03T00:00:02.000Z",
      ingest_time_watermark: "2026-11-03T00:00:06.000Z",
    });
  });

  test("the caller may pin as_of", () => {
    const projection = projectTraceEvents([makeEvent()], { as_of: "2026-11-03T00:01:00.000Z" });
    expect(projection.freshness.as_of).toBe("2026-11-03T00:01:00.000Z");
  });

  test("an empty projection is explicit about having no data", () => {
    const projection = projectTraceEvents([]);
    expect(projection.events).toEqual([]);
    expect(projection.freshness.event_time_watermark).toBeNull();
    expect(projection.freshness.ingest_time_watermark).toBeNull();
    expect(projection.completeness.complete).toBe(true);
  });
});

describe("ordering is a display merge, not a global authority", () => {
  test("the merged view follows event time across sources", () => {
    const projection = projectTraceEvents([
      makeEvent({
        source: "writer-a",
        event_id: "a1",
        span_id: "s-a1",
        event_time: "2026-11-03T00:00:01.000Z",
        ingest_time: "2026-11-03T00:00:01.100Z",
      }),
      makeEvent({
        source: "writer-b",
        event_id: "b1",
        span_id: "s-b1",
        event_time: "2026-11-03T00:00:02.000Z",
        ingest_time: "2026-11-03T00:00:02.100Z",
      }),
      makeEvent({
        source: "writer-a",
        event_id: "a2",
        sequence: 2,
        span_id: "s-a2",
        event_time: "2026-11-03T00:00:03.000Z",
        ingest_time: "2026-11-03T00:00:03.100Z",
      }),
    ]);
    expect(projection.events.map((event) => event.event_id)).toEqual(["a1", "b1", "a2"]);
  });

  test("a late record is shown at its event time while its arrival stays visible", () => {
    const projection = projectTraceEvents([
      makeEvent({
        event_id: "e1",
        sequence: 1,
        event_time: "2026-11-03T00:00:01.000Z",
        ingest_time: "2026-11-03T00:00:01.100Z",
      }),
      makeEvent({
        event_id: "e3",
        sequence: 3,
        span_id: "span-3",
        event_time: "2026-11-03T00:00:03.000Z",
        ingest_time: "2026-11-03T00:00:03.100Z",
      }),
      makeEvent({
        event_id: "e2",
        sequence: 2,
        span_id: "span-2",
        event_time: "2026-11-03T00:00:02.000Z",
        ingest_time: "2026-11-03T00:00:09.000Z",
      }),
    ]);
    expect(projection.events.map((event) => event.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(projection.events.map((event) => event.late)).toEqual([false, true, false]);
  });
});
