import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { applyRunFacts } from "../src/api/task-service.js";
import type { PiSummary } from "../src/api/pi-summary.js";
import type { TaskRecord } from "../src/api/task-store.js";
import { createTaskRecord, TaskStore, toTaskResource } from "../src/api/task-store.js";
import type { DshRunResponse } from "../src/dsh/types.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "forgepilot-state-"));
}

function makeRecord(id = "tsk_unit"): TaskRecord {
  return createTaskRecord({
    id,
    repository: {
      id: "github:Luthiel/AutoFixer",
      display_name: "Luthiel/AutoFixer",
      base_ref: "main",
      base_sha: "52081ea",
    },
    summary: "s",
    sourceReference: null,
    acceptanceCriteria: [],
  });
}

function makeRun(overrides: Partial<DshRunResponse> = {}): DshRunResponse {
  return {
    run_id: "run_1",
    task_id: "tsk_unit",
    issue_id: "42",
    state: "running",
    risk_assessment: {
      contract_version: "task-evidence-contract-v1",
      task_id: "tsk_unit",
      run_id: "run_1",
      assessed_at: "2026-10-27T00:00:00Z",
      assessor_identity: "dsh",
      risk_class: "elevated",
      decision_code: "risk_elevated",
      rationale_reference: "evidence://risk/run_1",
      policy_version: "v1",
      elevated_approval_reference: null,
    },
    grant_status: { state: "active", scope_digest: "sha256:x", grant: null },
    execution_counts: { actions_total: 0, actions_allowed: 0, actions_denied: 0 },
    patch_report: null,
    approval_snapshot: null,
    bundle_available: false,
    created_at: "2026-10-27T00:00:00Z",
    ...overrides,
  };
}

describe("durable task projection (M3 persistence)", () => {
  test("restored cancelled tasks remain unarchived across store restarts", () => {
    const stateFile = path.join(tempDir(), "task-state.json");
    const store = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    record.status = "cancelled";
    record.terminal = true;
    store.put(record);
    expect(toTaskResource(record).archived).toBe(true);
    record.archived = false;
    store.save(record);
    store.flushSync();
    const restored = new TaskStore({ persistencePath: stateFile }).get(record.id)!;
    expect(toTaskResource(restored)).toMatchObject({ status: "cancelled", archived: false });
  });

  test("a new store instance restores tasks, events, and idempotency keys", () => {
    const stateFile = path.join(tempDir(), "task-state.json");
    const first = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    first.put(record);
    first.appendEvent(record, "task.status_changed", { from: "queued", to: "executing" });
    first.appendEvent(record, "pi.text_delta", { delta: "hello" });
    first.rememberIdempotentTask("key-1", "fp-1", record.id);
    first.flushSync();

    const second = new TaskStore({ persistencePath: stateFile });
    const restored = second.get(record.id);
    expect(restored).toBeDefined();
    expect(restored?.events).toHaveLength(2);
    expect(restored?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(restored?.events.map((event) => event.type)).toEqual([
      "task.status_changed",
      "pi.text_delta",
    ]);
    // Event ids survive so a client's Last-Event-ID anchor stays valid across
    // a restart.
    expect(restored?.events.map((event) => event.event_id)).toEqual(
      record.events.map((event) => event.event_id),
    );
    // Subscribers are process-local and must never round-trip.
    expect(restored?.subscribers.size).toBe(0);
    expect(second.getIdempotentTask("key-1", "fp-1")?.id).toBe(record.id);
    expect(() => second.getIdempotentTask("key-1", "fp-2")).toThrow(/different payload/);
  });

  test("events appended after a reload continue the persisted sequence", () => {
    const stateFile = path.join(tempDir(), "task-state.json");
    const first = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    first.put(record);
    first.appendEvent(record, "task.status_changed", { from: "queued", to: "executing" });
    first.flushSync();

    const second = new TaskStore({ persistencePath: stateFile });
    const restored = second.get(record.id);
    const event = second.appendEvent(restored!, "pi.turn_settled", {});
    // The next sequence is 2, not 1: a restart must never renumber or
    // duplicate already-delivered business events.
    expect(event.sequence).toBe(2);
  });

  test("the projection file is user-private (0600) in a 0700 directory", () => {
    const dir = tempDir();
    const stateFile = path.join(dir, "task-state.json");
    const store = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    store.put(record);
    store.flushSync();
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // No temporary files are left behind by the atomic replace.
    expect(readdirSync(dir)).toEqual(["task-state.json"]);
  });

  test("an unversioned (pre-schema) file loads with safe defaults", () => {
    const dir = tempDir();
    const stateFile = path.join(dir, "task-state.json");
    const base = makeRecord();
    // Simulate an M2-era document: no schema_version, no M3 fields.
    writeFileSync(
      stateFile,
      JSON.stringify({
        tasks: [
          {
            ...base,
            subscribers: undefined,
            events: [
              {
                event_id: "evt_old",
                sequence: 1,
                occurred_at: "2026-10-26T00:00:00Z",
                task_id: base.id,
                task_version: 2,
                type: "task.status_changed",
                data: {},
              },
            ],
            status: "stopped",
          },
        ],
      }),
      "utf8",
    );
    const store = new TaskStore({ persistencePath: stateFile });
    const restored = store.get(base.id);
    expect(restored?.status).toBe("stopped");
    // Load flags the record terminal without inventing the closing frame;
    // recovery records it exactly once (see recovery.test.ts), so a replay
    // can never end without the closing frame.
    expect(restored?.terminal).toBe(true);
    expect(restored?.terminalEventRecorded).toBe(false);
    expect(restored?.governanceValid).toBe(true);
    expect(restored?.artifactIndex).toEqual([]);
    // Pre-DAT-191 documents predate the summary projection entirely.
    expect(restored?.piSummary).toBeNull();
  });

  test("a recorded summary survives a restart unchanged with its event and id", () => {
    const stateFile = path.join(tempDir(), "task-state.json");
    const first = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    // DAT-193 does not rewrite history, and neither does DAT-194: a summary
    // recorded before the provenance contract (an `available` projection in
    // the DAT-191/192 shape — no `source` field at all, free text and all)
    // reloads byte-for-byte, event included. The store is not where the
    // provenance decision is made; the read gate is.
    const legacySummary = {
      task_id: record.id,
      run_id: "run_persisted",
      turn_id: "turn_1",
      status: "available",
      text: "Checked the echo tool and confirmed it prints hello.",
      unavailable_reason: null,
      updated_at: "2099-01-01T00:00:00.000Z",
    } as PiSummary;
    record.piSummary = legacySummary;
    first.put(record);
    const publishedEvent = first.appendEvent(record, "pi.summary.updated", {
      summary: { ...record.piSummary },
    });
    first.flushSync();

    const second = new TaskStore({ persistencePath: stateFile });
    const restored = second.get(record.id);
    expect(restored?.piSummary).toEqual(record.piSummary);
    // Reloading never backfills a source: the legacy record keeps the exact
    // shape the old version wrote, so no old record can grow a provenance
    // claim it never had.
    expect(restored?.piSummary).not.toHaveProperty("source");
    const replayed = restored?.events.find((event) => event.type === "pi.summary.updated");
    expect(replayed?.event_id).toBe(publishedEvent.event_id);
    expect(replayed?.data["summary"]).toEqual(record.piSummary);

    // The API projection is where DAT-194 fails closed: the same stored
    // `available` summary is served unavailable, with no text and no source.
    expect(toTaskResource(restored!).pi_summary).toEqual({
      task_id: record.id,
      run_id: "run_persisted",
      turn_id: "turn_1",
      status: "unavailable",
      text: null,
      unavailable_reason: "untrusted_source",
      source: null,
      updated_at: "2099-01-01T00:00:00.000Z",
    });
    // …while the stored bytes stay exactly as written: provenance is decided
    // on read, never by editing history.
    expect(restored?.piSummary).toEqual(legacySummary);
  });

  test("a future schema version refuses to load instead of guessing", () => {
    const dir = tempDir();
    const stateFile = path.join(dir, "task-state.json");
    writeFileSync(stateFile, JSON.stringify({ schema_version: 99, tasks: [] }), "utf8");
    expect(() => new TaskStore({ persistencePath: stateFile })).toThrow(/newer than 1/);
  });

  test("a corrupt projection fails startup rather than dropping history", () => {
    const dir = tempDir();
    const stateFile = path.join(dir, "task-state.json");
    writeFileSync(stateFile, "{not json", "utf8");
    expect(() => new TaskStore({ persistencePath: stateFile })).toThrow();
  });

  test("the persisted document never contains live subscribers", () => {
    const stateFile = path.join(tempDir(), "task-state.json");
    const store = new TaskStore({ persistencePath: stateFile });
    const record = makeRecord();
    record.subscribers.add(() => undefined);
    store.put(record);
    store.flushSync();
    const document = JSON.parse(readFileSync(stateFile, "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(Object.keys(document.tasks[0] ?? {})).not.toContain("subscribers");
  });
});

describe("governance head binding (M3 acceptance 2)", () => {
  test("a snapshot bound to the current head keeps eligibility", () => {
    const record = makeRecord();
    applyRunFacts(
      record,
      makeRun({
        state: "approved_for_merge",
        patch_report: { head_sha: "aaa", report_digest: "sha256:report" },
        approval_snapshot: { head_sha: "aaa", merge_queue_eligible: true },
      }),
    );
    expect(record.headSha).toBe("aaa");
    expect(record.governanceValid).toBe(true);
    expect(record.mergeQueueEligible).toBe(true);
  });

  test("approvals and checks observed against an old head are invalidated", () => {
    const record = makeRecord();
    applyRunFacts(
      record,
      makeRun({
        patch_report: { head_sha: "aaa" },
        approval_snapshot: { head_sha: "aaa", merge_queue_eligible: true },
      }),
    );
    expect(record.mergeQueueEligible).toBe(true);

    // The run advanced to a new head while the approval snapshot still
    // describes the old one: the old head's approvals must not carry over.
    applyRunFacts(
      record,
      makeRun({
        patch_report: { head_sha: "bbb" },
        approval_snapshot: { head_sha: "aaa", merge_queue_eligible: true },
      }),
    );
    expect(record.headSha).toBe("bbb");
    expect(record.governanceValid).toBe(false);
    expect(record.mergeQueueEligible).toBe(false);
  });

  test("without an observed head nothing is eligible, nothing is stale", () => {
    const record = makeRecord();
    applyRunFacts(record, makeRun());
    expect(record.headSha).toBeNull();
    expect(record.governanceValid).toBe(true);
    expect(record.mergeQueueEligible).toBe(false);
  });

  test("the artifact index records dsh-reported artifacts with their head", () => {
    const record = makeRecord();
    applyRunFacts(
      record,
      makeRun({
        bundle_available: true,
        patch_report: { head_sha: "aaa", report_digest: "sha256:report" },
        approval_snapshot: { head_sha: "aaa", merge_queue_eligible: false },
      }),
    );
    expect(record.artifactIndex).toEqual([
      { artifact_id: "patch_report", available: true, digest: "sha256:report", head_sha: "aaa" },
      { artifact_id: "evidence_bundle", available: true, digest: null, head_sha: "aaa" },
    ]);
  });
});
