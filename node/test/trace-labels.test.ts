import { describe, expect, test } from "vitest";

import {
  MAX_METRIC_LABEL_VALUE_LENGTH,
  METRIC_DIMENSION_KEYS,
  metricLabelsFor,
  validateMetricLabels,
} from "../src/trace/labels.js";
import { TRACE_SCHEMA_VERSION, TraceValidationError } from "../src/trace/schema.js";
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

describe("metric label hygiene", () => {
  test("allowlisted low-cardinality labels pass", () => {
    expect(() =>
      validateMetricLabels({
        status: "ok",
        outcome: "accepted",
        reason_code: "rate_limit_cleared",
      }),
    ).not.toThrow();
  });

  test("payload-shaped, content and error-text keys are rejected", () => {
    for (const key of ["error_message", "payload", "file_content", "prompt", "authorization"]) {
      expect(() => validateMetricLabels({ [key]: "x" })).toThrow(TraceValidationError);
    }
  });

  test("high-cardinality values are capped at the boundary", () => {
    expect(() =>
      validateMetricLabels({ status: "a".repeat(MAX_METRIC_LABEL_VALUE_LENGTH) }),
    ).not.toThrow();
    expect(() =>
      validateMetricLabels({ status: "a".repeat(MAX_METRIC_LABEL_VALUE_LENGTH + 1) }),
    ).toThrow(TraceValidationError);
  });

  test("control characters and empty values are rejected", () => {
    expect(() => validateMetricLabels({ status: "line1\nline2" })).toThrow(TraceValidationError);
    expect(() => validateMetricLabels({ status: "" })).toThrow(TraceValidationError);
    expect(() => validateMetricLabels({ status: 12 as unknown as string })).toThrow(
      TraceValidationError,
    );
  });
});

describe("derived metric labels", () => {
  test("labels carry identity fields and safe custom labels, never payload", () => {
    const labels = metricLabelsFor(
      makeEvent({
        labels: { status: "ok" },
        payload: { prompt: "secret instructions", file_content: "diff --git", error_text: "boom" },
      }),
    );
    expect(labels).toEqual({
      source: "worker-1",
      kind: "agent.run_started",
      record_class: "operational_trace",
      status: "ok",
    });
    expect(labels).not.toHaveProperty("prompt");
    expect(labels).not.toHaveProperty("file_content");
    expect(labels).not.toHaveProperty("error_text");
    for (const key of Object.keys(labels)) {
      expect(METRIC_DIMENSION_KEYS).toContain(key);
    }
  });
});
