import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { CollabMachine } from "../src/collab/machine.js";
import { signalFingerprint } from "../src/intake/fingerprint.js";
import { LogIntake } from "../src/intake/pipeline.js";
import type { ProviderLogEvent } from "../src/intake/connector.js";
import { IntakeStore } from "../src/intake/store.js";
import type { BudgetConfig } from "../src/intake/store.js";

/**
 * Schema-migration coverage (DAT-216 QA round 3): the intake store must boot
 * state files written by earlier revisions of this PR without crashing,
 * silently corrupting counters, or losing checkpoint, budget and dedup
 * semantics — and must re-persist as the current schema.
 */

const fixturePath = fileURLToPath(new URL("./fixtures/intake-state-v1.json", import.meta.url));

function v1State(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

function writeTempState(state: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "autofixer-intake-mig-"));
  const file = path.join(dir, "intake-state.json");
  writeFileSync(file, JSON.stringify(state));
  return file;
}

const WS = { enterprise_id: "ent", workspace_id: "ws" };
const WS_B = { enterprise_id: "ent-b", workspace_id: "ws-b" };

const REPO = {
  repository_id: "repo_a",
  url: "https://example.com/a.git",
  base_ref: "main",
  base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const limits: BudgetConfig = {
  source_max_new_issues: 100,
  workspace_max_new_issues: 100,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 10,
  backpressure_high_water: 8,
};

function fixedClock(startIso = "2026-11-03T12:00:00.000Z", stepMs = 1000): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}

function repeatEvent(id: string): ProviderLogEvent {
  return {
    provider_event_id: id,
    event_time: "2026-11-03T12:00:00Z",
    schema_version: 1,
    provider_severity: "ERR",
    provider_service: "checkout-api",
    provider_environment: "prod-1",
    message: "checkout 1234 timed out",
    error: { class: "TimeoutError" },
  };
}

function makeIntake(store: IntakeStore): { machine: CollabMachine; intake: LogIntake } {
  const machine = new CollabMachine();
  const intake = new LogIntake({
    machine,
    store,
    // New signals map to a repository so acceptance outcomes are issues, not
    // triage records.
    rules: {
      version: "rules-1",
      rules: [{ rule_id: "map", match: {}, decision: { repositories: [REPO] } }],
    },
    budgets: limits,
    now: fixedClock(),
  });
  intake.registerSource({
    source_id: "src",
    workspace: WS,
    connector: {
      sourceId: "src",
      poll: async () => ({ events: [], cursor: null, has_more: false }),
    },
    max_events_per_poll: 100,
  });
  return { machine, intake };
}

describe("booting the previous revision's state", () => {
  test("keeps the checkpoint and source state", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });

    expect(store.checkpoint("src")?.value).toBe("c-9");
    expect(store.source("src")?.workspace).toEqual(WS);
  });

  test("boots when the legacy global cooldown stamp is null instead of crashing", () => {
    const state = v1State();
    (state["budget"] as Record<string, unknown>)["last_workspace_creation"] = null;
    const store = new IntakeStore({ persistencePath: writeTempState(state) });

    expect(store.checkpoint("src")?.value).toBe("c-9");
    // The attributable signal was rekeyed to the workspace-scoped fingerprint.
    const expectedKey = signalFingerprint({
      enterprise_id: "ent",
      workspace_id: "ws",
      service: "checkout-api",
      environment: "prod-1",
      error_signature: "TimeoutError | checkout <n> timed out | ",
    });
    expect(store.getSignal(expectedKey)?.issue_id).toBe("iss_1");
  });

  test("rejects a newer schema version explicitly", () => {
    const state = v1State();
    state["schema_version"] = 3;

    expect(() => new IntakeStore({ persistencePath: writeTempState(state) })).toThrow(
      /schema 3 is not supported/,
    );
  });
});

describe("preserved budget and cooldown semantics", () => {
  test("pre-upgrade creations still constrain the workspace budget", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const tight: BudgetConfig = { ...limits, workspace_max_new_issues: 3 };

    // Three pre-upgrade creations (one attributed to this workspace's source,
    // two from the unattributed manual source) all count conservatively.
    const denial = store.budgetCheck("fresh", WS, tight, "2026-11-03T11:35:00.000Z");
    expect(denial?.reason).toBe("workspace_window_exhausted");
  });

  test("pre-upgrade creations still constrain their own source budget", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const tight: BudgetConfig = { ...limits, source_max_new_issues: 1 };

    const denial = store.budgetCheck("src", WS, tight, "2026-11-03T11:35:00.000Z");
    expect(denial?.reason).toBe("source_window_exhausted");
  });

  test("a pre-upgrade cooldown stamp still delays creations after boot", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const cooldown: BudgetConfig = { ...limits, workspace_cooldown_seconds: 60 };

    expect(store.budgetCheck("src", WS, cooldown, "2026-11-03T11:30:30.000Z")?.reason).toBe(
      "workspace_cooldown",
    );
    expect(store.budgetCheck("src", WS, cooldown, "2026-11-03T11:32:00.000Z")).toBeNull();
  });
});

describe("preserved dedup semantics", () => {
  test("attributable pre-upgrade events hit the dedup registry within their workspace", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });

    // evt-1 attributes through its source binding; m-2 attributes through its
    // signal's triage linkage. Both stay idempotent in their own workspace.
    expect(store.findEvent(WS, "src", "evt-1")).toBeDefined();
    expect(store.findEvent(WS, "manual", "m-2")).toBeDefined();
    expect(store.findEvent(WS, "src", "evt-unknown")).toBeUndefined();
  });

  test("an unattributable pre-upgrade manual event is quarantined, not globally deduplicating", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });

    // m-1's signal has no source binding, triage or deferred linkage, so the
    // event is quarantined instead of staying in the dedup index. No workspace
    // — its own included — may ever hit another record's dedup key through it.
    expect(store.findEvent(WS, "manual", "m-1")).toBeUndefined();
    expect(store.findEvent(WS_B, "manual", "m-1")).toBeUndefined();
    const quarantined = store.quarantinedLegacyEvents();
    expect(quarantined.map((event) => event.provider_event_id)).toEqual(["m-1"]);
  });

  test("dedup keys never cross workspaces", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });

    // The same provider event id in another workspace is never a duplicate of
    // this workspace's history.
    expect(store.findEvent(WS_B, "src", "evt-1")).toBeUndefined();
    expect(store.findEvent(WS_B, "manual", "m-2")).toBeUndefined();
  });

  test("a replayed pre-upgrade event is a duplicate and creates nothing", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const report = intake.applyBatch("src", {
      events: [repeatEvent("evt-1")],
      cursor: { value: "c-10" },
      has_more: false,
    });

    expect(report.outcomes[0]?.kind).toBe("duplicate_event");
    expect(machine.listIssues()).toHaveLength(0);
  });

  test("a post-upgrade repeat of a pre-upgrade incident updates evidence instead of a new issue", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const report = intake.applyBatch("src", {
      events: [repeatEvent("evt-2")],
      cursor: { value: "c-10" },
      has_more: false,
    });

    expect(report.outcomes[0]?.kind).toBe("evidence_updated");
    expect(report.outcomes[0]?.issue_id).toBe("iss_1");
    expect(machine.listIssues()).toHaveLength(0);
    // The migrated signal was rekeyed to the workspace-scoped fingerprint the
    // pipeline computes for this incident.
    const expectedKey = signalFingerprint({
      enterprise_id: "ent",
      workspace_id: "ws",
      service: "checkout-api",
      environment: "prod-1",
      error_signature: "TimeoutError | checkout <n> timed out | ",
    });
    expect(report.outcomes[0]?.signal_key).toBe(expectedKey);
    expect(store.getSignal(expectedKey)?.occurrences).toBe(2);
  });

  test("a post-upgrade repeat of a pre-upgrade triaged incident attaches to its triage", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const result = intake.submitManual({
      actor: "human",
      workspace: WS,
      provider_severity: "error",
      provider_service: "search-api",
      provider_environment: "prod-1",
      message: "query 77 timed out",
      error: { class: "QueryError" },
    });

    expect(result.kind).toBe("evidence_updated");
    expect(result.triage_id).toBe("tri_1");
    expect(machine.listIssues()).toHaveLength(0);
    const triage = store.getTriage("tri_1");
    expect(store.getSignal(triage?.signal_key ?? "")?.triage_id).toBe("tri_1");
  });

  test("an unattributable pre-upgrade signal stays readable under its legacy key", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });

    const legacy = store.getSignal(
      "fp1:04526c2ceebc5c4995b2b6554d6ced38d5d711a9e87112d6680aae7fcb301fe6",
    );
    expect(legacy?.issue_id).toBe("iss_2");
  });
});

/**
 * Architect ruling (DAT-216): workspace isolation outranks unconditional
 * legacy dedup. A workspace must never hit another workspace's dedup key;
 * unattributable legacy manual events are replayed as new submissions (at
 * most one extra issue) and never reuse the original records.
 */
describe("cross-workspace idempotency isolation", () => {
  function manual(submission_id: string, workspace = WS) {
    return {
      actor: "human",
      workspace,
      submission_id,
      provider_severity: "error",
      provider_service: "billing-api",
      provider_environment: "prod-1",
      message: "refund 55 failed",
      error: { class: "RefundError" },
    };
  }

  test("a quarantined pre-upgrade manual id reused in another workspace is a new submission", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const result = intake.submitManual(manual("m-1", WS_B));

    expect(result.kind).toBe("issue_created");
    expect(result.issue_id).not.toBe("iss_2");
    expect(result.triage_id).toBeNull();
    const issues = machine.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.workspace).toEqual(WS_B);
    // The quarantined record is untouched and nothing references the original
    // workspace's issue.
    expect(store.quarantinedLegacyEvents().map((event) => event.provider_event_id)).toEqual([
      "m-1",
    ]);
    expect(store.getSignal(result.signal_key ?? "")?.issue_id).not.toBe("iss_2");
  });

  test("an attributed pre-upgrade manual id reused in another workspace is also a new submission", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const result = intake.submitManual(manual("m-2", WS_B));

    expect(result.kind).toBe("issue_created");
    expect(result.issue_id).not.toBe("iss_2");
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("an attributed pre-upgrade manual id replayed in its own workspace stays idempotent", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    const result = intake.submitManual(manual("m-2"));

    expect(result.kind).toBe("duplicate_event");
    expect(machine.listIssues()).toHaveLength(0);
  });

  test("a quarantined pre-upgrade manual id replayed anywhere is processed as a new submission", () => {
    const store = new IntakeStore({ persistencePath: writeTempState(v1State()) });
    const { machine, intake } = makeIntake(store);

    // Accepted cost of isolation: at most one extra issue, never a reuse of
    // the original workspace's signal, issue or triage.
    const result = intake.submitManual(manual("m-1"));

    expect(result.kind).toBe("issue_created");
    expect(result.issue_id).not.toBe("iss_2");
    expect(machine.listIssues()).toHaveLength(1);
    expect(result.signal_key).not.toBe(
      "fp1:04526c2ceebc5c4995b2b6554d6ced38d5d711a9e87112d6680aae7fcb301fe6",
    );
    expect(
      store.getSignal("fp1:04526c2ceebc5c4995b2b6554d6ced38d5d711a9e87112d6680aae7fcb301fe6")
        ?.issue_id,
    ).toBe("iss_2");
  });
});

describe("the intermediate revision's state shape", () => {
  test("loads scoped events and rekeys its signals to the current fingerprint version", () => {
    const identity = {
      enterprise_id: "ent",
      workspace_id: "ws",
      service: "checkout-api",
      environment: "prod-1",
      error_signature: "TimeoutError | checkout <n> timed out | ",
    };
    const state = {
      schema_version: 1,
      sources: [
        {
          source_id: "src",
          workspace: WS,
          checkpoint: { value: "c-5" },
          connection: "connected",
          last_error: null,
          last_event_time: "2026-11-03T11:30:00Z",
          last_poll_at: "2026-11-03T11:30:05.000Z",
          counts: {
            events: 1,
            duplicates: 0,
            invalid: 0,
            out_of_order: 0,
            issues_created: 1,
            evidence_updates: 0,
            triaged: 0,
            suppressed: 0,
            deferred: 0,
          },
        },
      ],
      events: [
        {
          enterprise_id: "ent",
          workspace_id: "ws",
          source_id: "src",
          provider_event_id: "evt-1",
          event_time: "2026-11-03T11:30:00Z",
          signal_key: "fp1:placeholder",
          outcome: "issue_created",
        },
      ],
      signals: [
        {
          signal_key: "fp1:placeholder",
          source_id: "src",
          identity,
          summary: "checkout-api/prod-1: TimeoutError checkout <n> timed out",
          issue_id: "iss_9",
          triage_id: null,
          first_seen_at: "2026-11-03T11:30:00.000Z",
          last_seen_at: "2026-11-03T11:30:00.000Z",
          occurrences: 1,
          current_severity: "error",
          evidence: [
            {
              event_identity: '["ent","ws","src","evt-1"]',
              provider_event_id: "evt-1",
              event_time: "2026-11-03T11:30:00Z",
              severity: "error",
              rate_count: 1,
              rule_ids: [],
            },
          ],
        },
      ],
      triage: [],
      suppressions: [],
      gaps: [],
      deferred: [],
      budget: {
        source_creations: [["src", ["2026-11-03T11:30:00.000Z"]]],
        workspace_creations: [["ent|ws", ["2026-11-03T11:30:00.000Z"]]],
        last_source_creation: [["src", "2026-11-03T11:30:00.000Z"]],
        last_workspace_creation: [["ent|ws", "2026-11-03T11:30:00.000Z"]],
      },
    };
    const store = new IntakeStore({ persistencePath: writeTempState(state) });

    expect(store.checkpoint("src")?.value).toBe("c-5");
    expect(store.findEvent(WS, "src", "evt-1")).toBeDefined();
    const expectedKey = signalFingerprint(identity);
    expect(store.getSignal(expectedKey)?.issue_id).toBe("iss_9");
  });
});

describe("re-persisting after migration", () => {
  test("writes the current schema, keeps the quarantine observable and reloads cleanly", () => {
    const file = writeTempState(v1State());
    const store = new IntakeStore({ persistencePath: file, now: fixedClock() });
    expect(store.quarantinedLegacyEvents()).toHaveLength(1);
    store.flushSync();

    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["schema_version"]).toBe(2);

    const reloaded = new IntakeStore({ persistencePath: file });
    expect(reloaded.checkpoint("src")?.value).toBe("c-9");
    expect(reloaded.findEvent(WS, "src", "evt-1")).toBeDefined();
    expect(reloaded.quarantinedLegacyEvents().map((event) => event.provider_event_id)).toEqual([
      "m-1",
    ]);
  });
});
