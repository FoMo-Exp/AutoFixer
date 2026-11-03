import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CaptureCapacityExhaustedError,
  DurableLocalCapture,
  EvidenceGate,
  ExportBuffer,
  ExportDestinationNotApprovedError,
  TraceExporter,
} from "../src/trace/exporter.js";
import type { ExportItem, ExportTransport } from "../src/trace/exporter.js";
import { TraceConflictError, TraceValidationError } from "../src/trace/errors.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "autofixer-export-"));
}

function item(overrides: Partial<ExportItem> = {}): ExportItem {
  return {
    source: "gateway",
    event_id: "evt-1",
    data_classes: ["logs"],
    mandatory: false,
    record: { status: "finished" },
    ...overrides,
  };
}

/** A transport that records every delivery and can be made unavailable. */
function scriptedTransport(): ExportTransport & {
  delivered: ExportItem[][];
  fail: boolean;
} {
  return {
    delivered: [],
    fail: false,
    deliver(items) {
      if (this.fail) {
        throw new Error("exporter unavailable");
      }
      this.delivered.push([...items]);
    },
  };
}

describe("export destination approval", () => {
  test("registration without an ADR-0005 approval reference is refused", () => {
    const exporter = new TraceExporter({
      capture: new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 }),
      buffer: new ExportBuffer({ maxRecords: 10 }),
      transport: scriptedTransport(),
    });
    expect(() =>
      exporter.register({
        destination_id: "vendor",
        approval_ref: "",
        permitted_data_classes: ["logs"],
      }),
    ).toThrow(ExportDestinationNotApprovedError);
  });

  test("flushing to an unregistered destination is refused", () => {
    const exporter = new TraceExporter({
      capture: new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 }),
      buffer: new ExportBuffer({ maxRecords: 10 }),
      transport: scriptedTransport(),
    });
    expect(() => exporter.flush("vendor")).toThrow(ExportDestinationNotApprovedError);
    expect(() =>
      exporter.register({
        destination_id: "vendor",
        approval_ref: "adr5-123",
        permitted_data_classes: ["logs"],
      }),
    ).not.toThrow();
    expect(() =>
      exporter.register({
        destination_id: "vendor",
        approval_ref: "adr5-123",
        permitted_data_classes: ["logs"],
      }),
    ).toThrow(TraceValidationError);
    expect(() =>
      exporter.register({
        destination_id: "other",
        approval_ref: "adr5-124",
        permitted_data_classes: ["nope" as "logs"],
      }),
    ).toThrow(TraceValidationError);
  });
});

describe("data-class authorization at export time", () => {
  function setup(permitted: { permitted_data_classes?: ExportItem["data_classes"] }) {
    const transport = scriptedTransport();
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 });
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 10 }),
      transport,
    });
    exporter.register({ destination_id: "vendor", approval_ref: "adr5-1", ...permitted });
    return { transport, capture, exporter };
  }

  test("a class the destination is not approved for is refused, not sent", () => {
    const { transport, exporter } = setup({ permitted_data_classes: ["logs"] });
    exporter.captureItem(item({ event_id: "ok", data_classes: ["logs"] }));
    exporter.captureItem(item({ event_id: "restricted", data_classes: ["code"] }));

    const outcome = exporter.flush("vendor");
    expect(outcome.status).toBe("delivered");
    expect(outcome.delivered).toBe(1);
    expect(outcome.refused.map((refusal) => refusal.item.event_id)).toEqual(["restricted"]);
    expect(outcome.refused[0]?.reason).toBe("DATA_CLASS_NOT_AUTHORIZED");
    expect(transport.delivered.flat().map((delivered) => delivered.event_id)).toEqual(["ok"]);

    // The refused record stays pending for a destination approved for it.
    exporter.register({
      destination_id: "code-vendor",
      approval_ref: "adr5-2",
      permitted_data_classes: ["code"],
    });
    const second = exporter.flush("code-vendor");
    expect(second.delivered).toBe(1);
  });

  test("missing permitted data classes fail closed", () => {
    const { transport, exporter } = setup({});
    exporter.captureItem(item());
    const outcome = exporter.flush("vendor");
    expect(outcome.delivered).toBe(0);
    expect(outcome.refused[0]?.reason).toBe("AUTHORIZATION_MISSING");
    expect(transport.delivered).toHaveLength(0);
  });
});

describe("exporter unavailability never loses mandatory records", () => {
  test("mandatory records survive the outage and are delivered after recovery", () => {
    const transport = scriptedTransport();
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 });
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 10 }),
      transport,
    });
    exporter.register({
      destination_id: "vendor",
      approval_ref: "adr5-1",
      permitted_data_classes: ["logs"],
    });

    transport.fail = true;
    for (const eventId of ["e1", "e2", "e3"]) {
      exporter.captureItem(item({ event_id: eventId, mandatory: true }));
    }
    const failed = exporter.flush("vendor");
    expect(failed.status).toBe("unavailable");
    expect(exporter.counters().failed_flushes).toBe(1);
    // Nothing was delivered, nothing was lost: the durable capture still
    // holds every mandatory record.
    expect(capture.pendingMandatory().map((record) => record.event_id)).toEqual(["e1", "e2", "e3"]);

    transport.fail = false;
    const recovered = exporter.flush("vendor");
    expect(recovered.status).toBe("delivered");
    expect(recovered.delivered).toBe(3);
    expect(capture.pendingMandatory()).toHaveLength(0);
  });

  test("mandatory records dropped by the bounded buffer are still delivered", () => {
    const transport = scriptedTransport();
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 });
    // The buffer only has room for one record; the rest drop from delivery
    // queueing with an explicit counter.
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 1 }),
      transport,
    });
    exporter.register({
      destination_id: "vendor",
      approval_ref: "adr5-1",
      permitted_data_classes: ["logs"],
    });
    for (const eventId of ["e1", "e2", "e3"]) {
      exporter.captureItem(item({ event_id: eventId, mandatory: true }));
    }
    expect(exporter.counters().buffer_dropped).toBe(2);

    // Pending-mandatory recovery from durable capture closes the gap.
    const outcome = exporter.flush("vendor");
    expect(outcome.delivered).toBe(3);
  });

  test("high-volume debug drops are bounded and counted explicitly", () => {
    const transport = scriptedTransport();
    const capture = new DurableLocalCapture({ maxRecords: 100, maxBytes: 100_000 });
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 2 }),
      transport,
    });
    exporter.register({
      destination_id: "vendor",
      approval_ref: "adr5-1",
      permitted_data_classes: ["logs"],
    });
    for (let index = 0; index < 5; index += 1) {
      exporter.captureItem(item({ event_id: `debug-${index}`, mandatory: false }));
    }
    expect(exporter.counters().buffer_dropped).toBe(3);
    // The records themselves remain in durable capture until retention expiry.
    expect(capture.readAll()).toHaveLength(5);
    expect(exporter.flush("vendor").delivered).toBe(2);
  });
});

describe("capture capacity and the evidence gate", () => {
  test("mandatory evidence capture at exhaustion blocks the action needing it", () => {
    const capture = new DurableLocalCapture({ maxRecords: 2, maxBytes: 10_000 });
    const gate = new EvidenceGate(capture);
    gate.requireEvidence({ source: "worker", event_id: "e1", data_classes: ["logs"], record: {} });
    gate.requireEvidence({ source: "worker", event_id: "e2", data_classes: ["logs"], record: {} });

    let actionRan = false;
    expect(() => {
      gate.requireEvidence({
        source: "worker",
        event_id: "e3",
        data_classes: ["logs"],
        record: {},
      });
      actionRan = true;
    }).toThrow(CaptureCapacityExhaustedError);
    expect(actionRan).toBe(false);
    expect(capture.readAll()).toHaveLength(2);
  });

  test("mandatory capture evicts debug records to make room, with counters", () => {
    const capture = new DurableLocalCapture({ maxRecords: 2, maxBytes: 10_000 });
    expect(capture.append(item({ event_id: "d1" }))).toBe("captured");
    expect(capture.append(item({ event_id: "d2" }))).toBe("captured");
    expect(capture.append(item({ event_id: "d3" }))).toBe("dropped");

    expect(capture.append(item({ event_id: "m1", mandatory: true }))).toBe("captured");
    expect(capture.counters().evicted).toBe(1);
    expect(capture.counters().dropped).toBe(1);
    // The oldest debug record made room for the mandatory one.
    expect(
      capture
        .readAll()
        .map((record) => record.event_id)
        .sort(),
    ).toEqual(["d2", "m1"]);
  });

  test("a byte-exhausted capture blocks mandatory evidence too", () => {
    const evidence = item({ event_id: "m1", mandatory: true, record: { blob: "x".repeat(50) } });
    const bytesPerItem = Buffer.byteLength(`${JSON.stringify(evidence)}\n`, "utf8");
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: bytesPerItem * 2 });
    expect(capture.append(evidence)).toBe("captured");
    expect(
      capture.append(item({ event_id: "m2", mandatory: true, record: { blob: "y".repeat(50) } })),
    ).toBe("captured");
    // Only mandatory records are held, so nothing is evictable: exhaustion
    // blocks instead of silently proceeding without the evidence.
    expect(() =>
      capture.append(item({ event_id: "m3", mandatory: true, record: { blob: "z".repeat(50) } })),
    ).toThrow(CaptureCapacityExhaustedError);
  });

  test("duplicate capture is deduplicated and changed content is refused", () => {
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 });
    expect(capture.append(item())).toBe("captured");
    expect(capture.append(item())).toBe("duplicate");
    expect(() => capture.append(item({ record: { status: "changed" } }))).toThrow(
      TraceConflictError,
    );
    expect(capture.counters().duplicates).toBe(1);
    expect(capture.counters().captured).toBe(1);
  });

  test("invalid capacity bounds and record shapes are refused", () => {
    expect(() => new DurableLocalCapture({ maxRecords: 0, maxBytes: 10 })).toThrow(
      TraceValidationError,
    );
    expect(() => new DurableLocalCapture({ maxRecords: 1, maxBytes: 0 })).toThrow(
      TraceValidationError,
    );
    const capture = new DurableLocalCapture({ maxRecords: 10, maxBytes: 10_000 });
    expect(() => capture.append(item({ data_classes: [] }))).toThrow(TraceValidationError);
    expect(() => capture.append(item({ source: "" }))).toThrow(TraceValidationError);
  });
});

describe("durable capture survives restarts", () => {
  test("records reload from the file and re-deliver at least once", () => {
    const file = path.join(tempDir(), "capture.jsonl");
    const capture = new DurableLocalCapture({ path: file, maxRecords: 10, maxBytes: 10_000 });
    capture.append(item({ event_id: "e1", mandatory: true }));
    capture.append(item({ event_id: "e2", mandatory: true }));
    capture.markDelivered([item({ event_id: "e1", mandatory: true })]);
    expect(capture.pendingMandatory().map((record) => record.event_id)).toEqual(["e2"]);

    // Delivery marks are process-local: after a restart undelivered and
    // already-delivered records alike are pending again (at-least-once;
    // consumers deduplicate by source/event identity).
    const reloaded = new DurableLocalCapture({ path: file, maxRecords: 10, maxBytes: 10_000 });
    expect(
      reloaded
        .pendingMandatory()
        .map((record) => record.event_id)
        .sort(),
    ).toEqual(["e1", "e2"]);
  });
});

describe("export-time scanning", () => {
  // Assembled from pieces on purpose: runnable secret-shaped literals in
  // this file would be rejected by repository push protection.
  const bearerValue = ["0123456789abcdef", "0123456789abcdef"].join("");
  const assignedValue = ["verysecret", "value123"].join("");

  test("delivered records and the durable file carry no secret values", () => {
    const transport = scriptedTransport();
    const file = path.join(tempDir(), "capture.jsonl");
    const capture = new DurableLocalCapture({ path: file, maxRecords: 10, maxBytes: 10_000 });
    const exporter = new TraceExporter({
      capture,
      buffer: new ExportBuffer({ maxRecords: 10 }),
      transport,
    });
    exporter.register({
      destination_id: "vendor",
      approval_ref: "adr5-1",
      permitted_data_classes: ["logs"],
    });
    exporter.captureItem(
      item({
        record: {
          detail: `Bearer ${bearerValue}`,
          nested: [{ note: `api_key=${assignedValue}` }],
        },
      }),
    );
    exporter.flush("vendor");

    for (const batch of transport.delivered) {
      expect(JSON.stringify(batch)).not.toContain(bearerValue);
      expect(JSON.stringify(batch)).not.toContain(assignedValue);
    }
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain(bearerValue);
    expect(persisted).not.toContain(assignedValue);
    expect(persisted).toContain("[redacted]");
  });
});
