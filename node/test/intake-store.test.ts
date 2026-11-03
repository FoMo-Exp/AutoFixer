import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { IntakeStore } from "../src/intake/store.js";
import type { BudgetConfig } from "../src/intake/store.js";

const budgets: BudgetConfig = {
  source_max_new_issues: 2,
  workspace_max_new_issues: 3,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 10,
  backpressure_high_water: 8,
};

function tempFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "autofixer-intake-")), "intake-state.json");
}

function fixedNow(startIso = "2026-11-03T12:00:00.000Z", stepMs = 1000): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}

describe("event registry", () => {
  test("records and finds events by (source, provider event id)", () => {
    const store = new IntakeStore();
    expect(store.findEvent("src", "evt-1")).toBeUndefined();
    store.recordEvent({
      source_id: "src",
      provider_event_id: "evt-1",
      event_time: "2026-11-03T12:00:00Z",
      signal_key: "fp1:x",
      outcome: "issue_created",
    });
    expect(store.findEvent("src", "evt-1")?.signal_key).toBe("fp1:x");
    expect(store.findEvent("src", "evt-2")).toBeUndefined();
  });
});

describe("signals and evidence", () => {
  test("stores the signal index and accumulates evidence", () => {
    const store = new IntakeStore({ now: fixedNow() });
    store.putSignal({
      signal_key: "fp1:a",
      source_id: "src",
      identity: {
        service: "checkout",
        environment: "prod",
        error_signature: "TimeoutError | x | f",
      },
      summary: "checkout/prod: TimeoutError x",
      issue_id: "iss_1",
      triage_id: null,
      first_seen_at: "2026-11-03T12:00:00Z",
      last_seen_at: "2026-11-03T12:00:00Z",
      occurrences: 1,
      current_severity: "error",
      evidence: [
        {
          event_identity: "evt-0",
          provider_event_id: "0",
          event_time: "2026-11-03T11:59:00Z",
          severity: "error",
          rate_count: 1,
          rule_ids: ["r1"],
        },
      ],
    });
    store.appendEvidence("fp1:a", {
      event_identity: "evt-a",
      provider_event_id: "a",
      event_time: "2026-11-03T12:00:00Z",
      severity: "error",
      rate_count: 1,
      rule_ids: ["r1"],
    });
    const signal = store.getSignal("fp1:a");
    expect(signal?.occurrences).toBe(2);
    expect(signal?.evidence).toHaveLength(2);
    expect(signal?.issue_id).toBe("iss_1");
  });
});

describe("gap records", () => {
  test("records a declared gap once even when replayed", () => {
    const store = new IntakeStore({ now: fixedNow() });
    const gap = { from: "10:00", to: "11:00", reason: "retention" };
    const first = store.recordGap("src", gap);
    const replay = store.recordGap("src", gap);
    expect(first).not.toBeNull();
    expect(replay).toBeNull();
    expect(store.gaps("src")).toHaveLength(1);
  });
});

describe("budget counters", () => {
  test("allows creation under the window limit and denies beyond it", () => {
    const store = new IntakeStore({ now: fixedNow() });
    expect(store.budgetCheck("src", budgets)).toBeNull();
    store.recordCreation("src", "2026-11-03T12:00:00.000Z");
    store.recordCreation("src", "2026-11-03T12:00:01.000Z");
    expect(store.budgetCheck("src", budgets)).toEqual({
      reason: "source_window_exhausted",
      source_id: "src",
    });
  });

  test("denies on source cooldown until it elapses", () => {
    const store = new IntakeStore({ now: fixedNow() });
    const cooldown: BudgetConfig = { ...budgets, source_cooldown_seconds: 60 };
    store.recordCreation("src", "2026-11-03T12:00:00.000Z");
    expect(store.budgetCheck("src", cooldown)?.reason).toBe("source_cooldown");
    expect(store.budgetCheck("src", cooldown, "2026-11-03T12:01:00.000Z")).toBeNull();
  });

  test("counts the workspace budget across sources", () => {
    const store = new IntakeStore({ now: fixedNow() });
    store.recordCreation("src-a", "2026-11-03T12:00:00.000Z");
    store.recordCreation("src-a", "2026-11-03T12:00:01.000Z");
    store.recordCreation("src-b", "2026-11-03T12:00:02.000Z");
    expect(store.budgetCheck("src-c", budgets)?.reason).toBe("workspace_window_exhausted");
  });
});

describe("deferred backlog", () => {
  test("holds and releases deferred signals", () => {
    const store = new IntakeStore({ now: fixedNow() });
    store.addDeferred({
      deferred_id: "def_1",
      signal_key: "fp1:a",
      source_id: "src",
      identity: { service: "s", environment: "e", error_signature: "sig" },
      summary: "s/e: sig",
      reason: "source_window_exhausted",
      workspace: { enterprise_id: "ent", workspace_id: "ws" },
      requested_at: "2026-11-03T12:00:00.000Z",
      occurrences: 1,
      decision: {
        policy_version: "rules-1",
        rule_ids: [],
        severity: "error",
        service: "s",
        environment: "e",
        error_signature: "sig",
        rate_window_seconds: 300,
        rate_escalate_at: null,
        rate_count: 1,
        suppression: null,
        repository_mapping: {
          status: "mapped",
          repository: {
            repository_id: "repo",
            url: "https://example.com/repo.git",
            base_ref: "main",
            base_sha: "abc",
          },
          candidates: [],
          rule_ids: [],
        },
      },
    });
    expect(store.deferred()).toHaveLength(1);
    store.removeDeferred("def_1");
    expect(store.deferred()).toHaveLength(0);
  });
});

describe("durable restart", () => {
  test("reloads checkpoint, dedup, signals and budget state from disk", () => {
    const file = tempFile();
    const store = new IntakeStore({ persistencePath: file, now: fixedNow() });
    store.setCheckpoint("src", { value: "c-1" }, "2026-11-03T12:00:00.000Z");
    store.recordEvent({
      source_id: "src",
      provider_event_id: "evt-1",
      event_time: "2026-11-03T12:00:00Z",
      signal_key: "fp1:a",
      outcome: "issue_created",
    });
    store.recordCreation("src", "2026-11-03T12:00:00.000Z");
    store.flushSync();

    const reloaded = new IntakeStore({ persistencePath: file });
    expect(reloaded.checkpoint("src")?.value).toBe("c-1");
    expect(reloaded.findEvent("src", "evt-1")?.outcome).toBe("issue_created");
    expect(reloaded.budgetCheck("src", budgets)).toBeNull(); // 1 of 2 used
  });
});
