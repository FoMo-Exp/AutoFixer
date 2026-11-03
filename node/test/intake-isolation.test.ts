import { describe, expect, test } from "vitest";

import { CollabMachine } from "../src/collab/machine.js";
import type { ConnectorBatch, ProviderLogEvent } from "../src/intake/connector.js";
import { LogIntake } from "../src/intake/pipeline.js";
import type { RuleConfig } from "../src/intake/rules.js";
import { IntakeStore } from "../src/intake/store.js";
import type { BudgetConfig } from "../src/intake/store.js";

const REPO = {
  repository_id: "repo_a",
  url: "https://example.com/a.git",
  base_ref: "main",
  base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const RULES: RuleConfig = {
  version: "rules-1",
  rules: [{ rule_id: "map", match: {}, decision: { repositories: [REPO] } }],
};

const BUDGETS: BudgetConfig = {
  source_max_new_issues: 10,
  workspace_max_new_issues: 10,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 10,
  backpressure_high_water: 8,
};

const WORKSPACE_A = { enterprise_id: "ent-a", workspace_id: "ws-a" };
const WORKSPACE_B = { enterprise_id: "ent-b", workspace_id: "ws-b" };

function fixedClock(): () => Date {
  let current = Date.parse("2026-11-03T12:00:00.000Z");
  return () => {
    const value = new Date(current);
    current += 1000;
    return value;
  };
}

function event(id: string): ProviderLogEvent {
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

function batch(events: ProviderLogEvent[]): ConnectorBatch {
  return { events, cursor: { value: "c-next" }, has_more: false };
}

/**
 * One shared deployment (one machine, one store) with two workspace-scoped
 * sources — the multi-tenant shape where cross-workspace leaks would appear.
 */
function makeIntake(): {
  machine: CollabMachine;
  store: IntakeStore;
  intake: LogIntake;
} {
  const machine = new CollabMachine();
  const store = new IntakeStore({ now: fixedClock() });
  const intake = new LogIntake({
    machine,
    store,
    rules: RULES,
    budgets: BUDGETS,
    now: fixedClock(),
  });
  for (const [source_id, workspace] of [
    ["src-a", WORKSPACE_A],
    ["src-b", WORKSPACE_B],
  ] as const) {
    intake.registerSource({
      source_id,
      workspace,
      connector: { sourceId: source_id, poll: async () => batch([]) },
      max_events_per_poll: 100,
    });
  }
  return { machine, store, intake };
}

describe("cross-workspace signal isolation", () => {
  test("the same error in two workspaces yields two isolated signals and issues", () => {
    const { machine, intake } = makeIntake();

    const first = intake.applyBatch("src-a", batch([event("e1")]));
    const second = intake.applyBatch("src-b", batch([event("e1")]));

    expect(first.outcomes[0]?.kind).toBe("issue_created");
    expect(second.outcomes[0]?.kind).toBe("issue_created");
    expect(second.outcomes[0]?.signal_key).not.toBe(first.outcomes[0]?.signal_key);
    expect(second.outcomes[0]?.issue_id).not.toBe(first.outcomes[0]?.issue_id);

    const issues = machine.listIssues();
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.workspace.workspace_id).sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("a later workspace's alert never reuses the earlier workspace's issue", () => {
    const { store, intake } = makeIntake();
    const first = intake.applyBatch("src-a", batch([event("e1")]));
    const second = intake.applyBatch("src-b", batch([event("e2")]));

    const signalA = store.getSignal(first.outcomes[0]?.signal_key ?? "");
    const signalB = store.getSignal(second.outcomes[0]?.signal_key ?? "");
    expect(signalA?.issue_id).toBe(first.outcomes[0]?.issue_id);
    expect(signalB?.issue_id).toBe(second.outcomes[0]?.issue_id);
    expect(signalA?.identity.workspace_id).toBe("ws-a");
    expect(signalB?.identity.workspace_id).toBe("ws-b");
    expect(signalA?.occurrences).toBe(1);
  });

  test("manual submissions with the same id in two workspaces are both processed", () => {
    const { machine, intake } = makeIntake();

    const a = intake.submitManual({
      actor: "human-a",
      workspace: WORKSPACE_A,
      submission_id: "m-1",
      provider_severity: "error",
      provider_service: "checkout-api",
      provider_environment: "prod-1",
      message: "checkout 1234 timed out",
      error: { class: "TimeoutError" },
    });
    const b = intake.submitManual({
      actor: "human-b",
      workspace: WORKSPACE_B,
      submission_id: "m-1",
      provider_severity: "error",
      provider_service: "checkout-api",
      provider_environment: "prod-1",
      message: "checkout 1234 timed out",
      error: { class: "TimeoutError" },
    });

    expect(a.kind).toBe("issue_created");
    expect(b.kind).toBe("issue_created");
    expect(b.signal_key).not.toBe(a.signal_key);
    expect(machine.listIssues()).toHaveLength(2);
  });

  test("a manual report in another workspace never attaches to the first workspace's issue", () => {
    const { machine, intake } = makeIntake();
    const fromSource = intake.applyBatch("src-a", batch([event("e1")]));

    const manual = intake.submitManual({
      actor: "human-b",
      workspace: WORKSPACE_B,
      provider_severity: "error",
      provider_service: "checkout-api",
      provider_environment: "prod-1",
      message: "checkout 1234 timed out",
      error: { class: "TimeoutError" },
    });

    expect(manual.kind).toBe("issue_created");
    expect(manual.issue_id).not.toBe(fromSource.outcomes[0]?.issue_id);
    expect(machine.listIssues()).toHaveLength(2);
  });

  test("workspace budgets do not consume each other", () => {
    const machine = new CollabMachine();
    const store = new IntakeStore({ now: fixedClock() });
    const intake = new LogIntake({
      machine,
      store,
      rules: RULES,
      budgets: { ...BUDGETS, workspace_max_new_issues: 1 },
      now: fixedClock(),
    });
    for (const [source_id, workspace] of [
      ["src-a", WORKSPACE_A],
      ["src-b", WORKSPACE_B],
    ] as const) {
      intake.registerSource({
        source_id,
        workspace,
        connector: { sourceId: source_id, poll: async () => batch([]) },
        max_events_per_poll: 100,
      });
    }

    const first = intake.applyBatch("src-a", batch([event("e1")]));
    const second = intake.applyBatch("src-b", batch([event("e2")]));

    expect(first.outcomes[0]?.kind).toBe("issue_created");
    expect(second.outcomes[0]?.kind).toBe("issue_created");
  });
});
