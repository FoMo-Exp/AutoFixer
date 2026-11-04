import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { projectTraceEvents } from "../src/trace/projection.js";
import { TRACE_SCHEMA_VERSION, TraceValidationError } from "../src/trace/schema.js";
import type { NewTraceEvent } from "../src/trace/schema.js";
import { TraceAccessError, TraceConflictError, TraceStore } from "../src/trace/store.js";
import type { AccessScope } from "../src/trace/store.js";

const scopeA: AccessScope = {
  enterprise_id: "ent-1",
  workspace_id: "ws-1",
  subject: "user-1",
};

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "autofixer-trace-"));
}

/** Deterministic store clock: first call 00:00:10Z, then one second per call. */
function fixedNow(): () => Date {
  let step = 0;
  return () => new Date(Date.UTC(2026, 10, 3, 0, 0, 10 + step++, 0));
}

function newEvent(overrides: Partial<NewTraceEvent> = {}): NewTraceEvent {
  return {
    source: "worker-1",
    event_id: "evt-1",
    sequence: 1,
    event_time: "2026-11-03T00:00:01.000Z",
    record_class: "operational_trace",
    kind: "agent.run_started",
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    trace_id: "trace-1",
    span_id: "span-1",
    ...overrides,
  };
}

describe("append and duplicate delivery deduplication", () => {
  test("the store stamps ingest_time from its own clock", () => {
    const store = new TraceStore({ now: fixedNow() });
    const result = store.append(newEvent({ event_id: "e1" }));
    expect(result.status).toBe("recorded");
    expect(result.event.ingest_time).toBe("2026-11-03T00:00:10.000Z");
  });

  test("redelivery of the same source/event identity is deduplicated", () => {
    const store = new TraceStore({ now: fixedNow() });
    const seen: string[] = [];
    store.stream(scopeA, undefined, (event) => seen.push(event.event_id));
    const first = store.append(newEvent({ event_id: "e1" }));
    const second = store.append(newEvent({ event_id: "e1" }));
    expect(first.status).toBe("recorded");
    expect(second.status).toBe("duplicate");
    expect(second.event).toEqual(first.event);
    expect(store.query(scopeA)).toHaveLength(1);
    expect(seen).toEqual(["e1"]);
  });

  test("event identity is the source/event pair, not the bare id", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "e1", source: "worker-1" }));
    store.append(newEvent({ event_id: "e1", source: "worker-2", span_id: "span-2" }));
    expect(store.query(scopeA)).toHaveLength(2);
  });

  test("identity never conflates delimiters inside source or event id", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ source: "writer a", event_id: "evt b" }));
    store.append(newEvent({ source: "writer", event_id: "a evt b", span_id: "span-2" }));
    expect(store.query(scopeA)).toHaveLength(2);
  });

  test("a conflicting redelivery cannot rewrite recorded evidence", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "e1", payload: { note: "first" } }));
    expect(() =>
      store.append(newEvent({ event_id: "e1", payload: { note: "rewritten" } })),
    ).toThrow(TraceConflictError);
    expect(store.query(scopeA)[0]?.payload).toEqual({ note: "first" });
    expect(store.query(scopeA)).toHaveLength(1);
  });

  test("payload and label text is scanned and redacted before persistence", () => {
    // DAT-225 gate at the write boundary. Assembled fixtures on purpose:
    // runnable secret-shaped literals would trip push protection.
    const store = new TraceStore({ now: fixedNow() });
    const assigned = ["api_", "key=verysecret", "value123"].join("");
    const keyLike = ["sk-", "DEADBEEFDEADBEEFDEADBEEF"].join("");
    const recorded = store.append(
      newEvent({ event_id: "e1", payload: { note: assigned }, labels: { model: keyLike } }),
    );
    expect(recorded.event.payload).toEqual({ note: "api_key=[redacted]" });
    expect(recorded.event.labels["model"]).toBe("[redacted]");

    // A redelivery of the raw writer content deduplicates against the
    // stored redacted form instead of reintroducing the secret.
    const redelivery = store.append(
      newEvent({ event_id: "e1", payload: { note: assigned }, labels: { model: keyLike } }),
    );
    expect(redelivery.status).toBe("duplicate");
    expect(store.query(scopeA)[0]?.payload).toEqual({ note: "api_key=[redacted]" });
  });

  test("append rejects payload-shaped metric labels", () => {
    const store = new TraceStore({ now: fixedNow() });
    expect(() =>
      store.append(newEvent({ event_id: "e1", labels: { error_message: "boom at foo.ts:12" } })),
    ).toThrow(TraceValidationError);
    expect(store.query(scopeA)).toHaveLength(0);
  });

  test("readers cannot mutate recorded evidence", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "e1" }));
    const copy = store.query(scopeA)[0];
    if (copy) {
      copy.source = "forged";
      copy.labels["status"] = "tampered";
    }
    const fresh = store.query(scopeA)[0];
    expect(fresh?.source).toBe("worker-1");
    expect(fresh?.labels).toEqual({});
  });
});

describe("authenticated access scope", () => {
  test("queries cannot cross workspace boundaries", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "a1" }));
    store.append(newEvent({ event_id: "b1", workspace_id: "ws-2", span_id: "span-b1" }));
    // Unfiltered reads are implicitly scoped to the caller's workspace.
    expect(store.query(scopeA).map((event) => event.event_id)).toEqual(["a1"]);
    expect(() => store.query(scopeA, { workspace_id: "ws-2" })).toThrow(TraceAccessError);
    expect(() => store.export(scopeA, { workspace_id: "ws-2" })).toThrow(TraceAccessError);
    expect(() => store.stream(scopeA, { workspace_id: "ws-2" }, () => undefined)).toThrow(
      TraceAccessError,
    );
    expect(() => store.aggregate(scopeA, { workspace_id: "ws-2" }, ["kind"])).toThrow(
      TraceAccessError,
    );
  });

  test("queries cannot cross enterprise boundaries", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "a1" }));
    store.append(
      newEvent({
        event_id: "c1",
        enterprise_id: "ent-2",
        workspace_id: "ws-2",
        span_id: "span-c1",
      }),
    );
    expect(store.query(scopeA).map((event) => event.event_id)).toEqual(["a1"]);
    expect(() => store.query(scopeA, { enterprise_id: "ent-2" })).toThrow(TraceAccessError);
  });

  test("an unauthenticated scope is rejected", () => {
    const store = new TraceStore({ now: fixedNow() });
    expect(() =>
      store.query({ enterprise_id: "", workspace_id: "ws-1", subject: "user-1" }),
    ).toThrow(TraceValidationError);
    expect(() =>
      store.query({ enterprise_id: "ent-1", workspace_id: "ws-1", subject: "" }),
    ).toThrow(TraceValidationError);
    expect(() =>
      store.query({ enterprise_id: "ent-1", workspace_id: "", subject: "user-1" }),
    ).toThrow(TraceValidationError);
  });

  test("invalid time bounds are rejected instead of silently disabling the filter", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "a1" }));
    expect(() => store.query(scopeA, { since: "not-a-timestamp" })).toThrow(TraceValidationError);
    expect(() => store.query(scopeA, { until: "yesterday" })).toThrow(TraceValidationError);
    expect(() => store.stream(scopeA, { since: "" }, () => undefined)).toThrow(
      TraceValidationError,
    );
    expect(() => store.aggregate(scopeA, { until: "2026-13-99" }, ["kind"])).toThrow(
      TraceValidationError,
    );
  });

  test("a scoped stream only delivers its own workspace's events", () => {
    const store = new TraceStore({ now: fixedNow() });
    const seen: string[] = [];
    const stop = store.stream(scopeA, undefined, (event) => seen.push(event.event_id));
    store.append(newEvent({ event_id: "a1" }));
    store.append(newEvent({ event_id: "b1", workspace_id: "ws-2", span_id: "span-b1" }));
    expect(seen).toEqual(["a1"]);
    stop();
    store.append(newEvent({ event_id: "a2", sequence: 2, span_id: "span-a2" }));
    expect(seen).toEqual(["a1"]);
  });

  test("export carries the schema version and only scoped events", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "a1" }));
    store.append(newEvent({ event_id: "b1", workspace_id: "ws-2", span_id: "span-b1" }));
    const bundle = store.export(scopeA);
    expect(bundle.schema_version).toBe(TRACE_SCHEMA_VERSION);
    expect(typeof bundle.exported_at).toBe("string");
    expect(bundle.events.map((event) => event.event_id)).toEqual(["a1"]);
  });
});

describe("aggregation stays inside the metric dimension vocabulary", () => {
  test("groups counts by allowlisted dimensions", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "e1", kind: "queue.enqueued" }));
    store.append(newEvent({ event_id: "e2", kind: "queue.enqueued", source: "worker-2" }));
    store.append(newEvent({ event_id: "e3", kind: "tool.executed", labels: { status: "ok" } }));
    const byKind = store.aggregate(scopeA, undefined, ["kind"]);
    expect(byKind.total).toBe(3);
    expect(byKind.buckets).toContainEqual({ key: { kind: "queue.enqueued" }, count: 2 });
    expect(byKind.buckets).toContainEqual({ key: { kind: "tool.executed" }, count: 1 });
    const byStatus = store.aggregate(scopeA, undefined, ["status"]);
    expect(byStatus.buckets).toContainEqual({ key: { status: "ok" }, count: 1 });
    expect(byStatus.buckets).toContainEqual({ key: { status: "(absent)" }, count: 2 });
  });

  test("rejects high-cardinality or payload dimensions", () => {
    const store = new TraceStore({ now: fixedNow() });
    store.append(newEvent({ event_id: "e1" }));
    for (const dimension of ["error_message", "payload", "prompt"]) {
      expect(() => store.aggregate(scopeA, undefined, [dimension])).toThrow(TraceValidationError);
    }
  });
});

describe("persistence and envelope migration", () => {
  test("persisted traces reload with identical events", () => {
    const file = path.join(tempDir(), "trace.json");
    const store = new TraceStore({ persistencePath: file, now: fixedNow() });
    store.append(newEvent({ event_id: "e1" }));
    store.append(newEvent({ event_id: "e2", source: "worker-2", span_id: "span-2" }));
    store.flushSync();
    const reloaded = new TraceStore({ persistencePath: file });
    expect(reloaded.query(scopeA)).toEqual(store.query(scopeA));
  });

  test("an unversioned persisted envelope migrates its events on load", () => {
    const file = path.join(tempDir(), "trace.json");
    writeFileSync(
      file,
      JSON.stringify({
        events: [
          {
            source: "worker-1",
            event_id: "e-legacy",
            sequence: 1,
            event_time: "2026-11-03T00:00:01.000Z",
            kind: "queue.enqueued",
            enterprise_id: "ent-1",
            workspace_id: "ws-1",
            trace_id: "trace-1",
            span_id: "span-1",
          },
        ],
      }),
    );
    const store = new TraceStore({ persistencePath: file });
    const events = store.query(scopeA);
    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(TRACE_SCHEMA_VERSION);
    expect(events[0]?.record_class).toBe("operational_trace");
  });

  test("a newer persisted envelope fails startup instead of dropping history", () => {
    const file = path.join(tempDir(), "trace.json");
    writeFileSync(file, JSON.stringify({ schema_version: TRACE_SCHEMA_VERSION + 1, events: [] }));
    expect(() => new TraceStore({ persistencePath: file })).toThrow(/newer/);
  });

  test("corrupt persisted events fail startup instead of silently dropping history", () => {
    const file = path.join(tempDir(), "trace.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1, events: { corrupt: true } }));
    expect(() => new TraceStore({ persistencePath: file })).toThrow(/corrupt|not an array/);
  });

  test("a persisted envelope without events fails startup instead of loading empty", () => {
    const file = path.join(tempDir(), "trace.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1 }));
    expect(() => new TraceStore({ persistencePath: file })).toThrow(/corrupt|not an array/);
  });
});

describe("one issue across retries, agents, gateway, dsh, sandbox and delivery", () => {
  test("follows the issue end to end without rewriting evidence", () => {
    const store = new TraceStore({ now: fixedNow() });
    const base = {
      enterprise_id: "ent-1",
      workspace_id: "ws-1",
      issue_id: "issue-1",
      task_id: "tsk-1",
      trace_id: "trace-1",
    };
    store.append(
      newEvent({
        ...base,
        source: "queue-1",
        event_id: "q-1",
        sequence: 1,
        kind: "queue.enqueued",
        span_id: "span-q1",
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "gateway-1",
        event_id: "g-1",
        sequence: 1,
        kind: "gateway.invocation_started",
        span_id: "span-g1",
        invocation_id: "inv-1",
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "worker-1",
        event_id: "w-1",
        sequence: 1,
        kind: "agent.run_started",
        span_id: "span-w1",
        run_id: "run-1",
        attempt_id: "att-1",
        agent_id: "agent-a",
        record_class: "worker_evidence",
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "queue-1",
        event_id: "q-2",
        sequence: 2,
        kind: "queue.retried",
        span_id: "span-q2",
        attempt_id: "att-2",
        causation_id: "worker-1:w-1",
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "worker-2",
        event_id: "w-2",
        sequence: 1,
        kind: "agent.run_started",
        span_id: "span-w2",
        run_id: "run-1",
        attempt_id: "att-2",
        agent_id: "agent-b",
        record_class: "worker_evidence",
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "dsh-1",
        event_id: "d-1",
        sequence: 1,
        kind: "dsh.evidence_recorded",
        span_id: "span-d1",
        run_id: "run-1",
        attempt_id: "att-2",
        record_class: "control_plane_audit",
        evidence_refs: ["evidence://events/run-1/3"],
      }),
    );
    store.append(
      newEvent({
        ...base,
        source: "sandbox-1",
        event_id: "s-1",
        sequence: 1,
        kind: "sandbox.executed",
        span_id: "span-s1",
        attempt_id: "att-2",
      }),
    );
    const delivery = newEvent({
      ...base,
      source: "delivery-1",
      event_id: "dl-1",
      sequence: 1,
      kind: "delivery.attempted",
      span_id: "span-dl1",
      delivery_id: "del-1",
    });
    store.append(delivery);
    expect(store.append(delivery).status).toBe("duplicate");

    const events = store.query(scopeA, { issue_id: "issue-1" });
    expect(events).toHaveLength(8);
    expect(new Set(events.map((event) => event.source))).toEqual(
      new Set(["queue-1", "gateway-1", "worker-1", "worker-2", "dsh-1", "sandbox-1", "delivery-1"]),
    );
    expect(
      new Set(events.flatMap((event) => (event.attempt_id ? [event.attempt_id] : []))),
    ).toEqual(new Set(["att-1", "att-2"]));
    for (const event of events) {
      expect(event.issue_id).toBe("issue-1");
      expect(event.task_id).toBe("tsk-1");
      expect(event.trace_id).toBe("trace-1");
    }

    // Reading, projecting, and exporting must leave evidence bytes untouched.
    const evidenceBefore = JSON.stringify(
      events.filter((event) => event.record_class !== "operational_trace"),
    );
    projectTraceEvents(events);
    store.export(scopeA, { issue_id: "issue-1" });
    const evidenceAfter = JSON.stringify(
      store
        .query(scopeA, { issue_id: "issue-1" })
        .filter((event) => event.record_class !== "operational_trace"),
    );
    expect(evidenceAfter).toBe(evidenceBefore);
  });
});
