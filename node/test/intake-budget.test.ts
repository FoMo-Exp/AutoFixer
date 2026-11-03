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

type TestClock = (() => Date) & { advance: (ms: number) => void };

function fixedClock(startIso = "2026-11-03T12:00:00.000Z", stepMs = 1000): TestClock {
  let current = Date.parse(startIso);
  const clock = (() => {
    const value = new Date(current);
    current += stepMs;
    return value;
  }) as TestClock;
  clock.advance = (ms) => {
    current += ms;
  };
  return clock;
}

function event(id: string, message = `${id} exploded`): ProviderLogEvent {
  return {
    provider_event_id: id,
    event_time: "2026-11-03T12:00:00Z",
    schema_version: 1,
    provider_severity: "ERR",
    provider_service: "checkout-api",
    provider_environment: "prod-1",
    message,
  };
}

function batch(events: ProviderLogEvent[]): ConnectorBatch {
  return { events, cursor: { value: "c-next" }, has_more: false };
}

const budgets: BudgetConfig = {
  source_max_new_issues: 1,
  workspace_max_new_issues: 2,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 10,
  backpressure_high_water: 8,
};

function makeIntake(overrides: Partial<BudgetConfig> = {}): {
  machine: CollabMachine;
  store: IntakeStore;
  intake: LogIntake;
  clock: TestClock;
} {
  const machine = new CollabMachine();
  const clock = fixedClock();
  const store = new IntakeStore({ now: clock });
  const intake = new LogIntake({
    machine,
    store,
    rules: RULES,
    budgets: { ...budgets, ...overrides },
    now: clock,
  });
  intake.registerSource({
    source_id: "src",
    workspace: { enterprise_id: "ent", workspace_id: "ws" },
    connector: {
      sourceId: "src",
      poll: async () => batch([]),
    },
    max_events_per_poll: 100,
  });
  return { machine, store, intake, clock };
}

describe("source and workspace budgets", () => {
  test("new issues beyond the source window are deferred with an explicit reason", () => {
    const { machine, intake } = makeIntake();
    const first = intake.applyBatch("src", batch([event("b1", "alpha failed")]));
    const second = intake.applyBatch("src", batch([event("b2", "beta failed")]));

    expect(first.outcomes[0]?.kind).toBe("issue_created");
    expect(second.outcomes[0]?.kind).toBe("budget_deferred");
    expect(second.outcomes[0]?.reason).toBe("source_window_exhausted");
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("repeated alerts still update evidence while the budget defers new issues", () => {
    const { machine, store, intake } = makeIntake();
    intake.applyBatch("src", batch([event("b1", "alpha failed")]));
    intake.applyBatch("src", batch([event("b2", "beta failed")]));
    const repeat = intake.applyBatch("src", batch([event("b3", "alpha failed")]));

    expect(repeat.outcomes[0]?.kind).toBe("evidence_updated");
    expect(machine.listIssues()).toHaveLength(1);
    const signal = store.getSignal(repeat.outcomes[0]?.signal_key ?? "");
    expect(signal?.occurrences).toBe(2);
  });

  test("the workspace budget is shared across sources", () => {
    const { machine, intake } = makeIntake({ source_max_new_issues: 5 });
    intake.registerSource({
      source_id: "src-b",
      workspace: { enterprise_id: "ent", workspace_id: "ws" },
      connector: { sourceId: "src-b", poll: async () => batch([]) },
      max_events_per_poll: 100,
    });

    intake.applyBatch("src", batch([event("w1", "alpha failed")]));
    intake.applyBatch("src-b", batch([event("w2", "beta failed")]));
    const third = intake.applyBatch("src", batch([event("w3", "gamma failed")]));

    expect(third.outcomes[0]?.kind).toBe("budget_deferred");
    expect(third.outcomes[0]?.reason).toBe("workspace_window_exhausted");
    expect(machine.listIssues()).toHaveLength(2);
  });
});

describe("cooldowns and deferred draining", () => {
  test("the source cooldown defers creations until it elapses", () => {
    const { intake } = makeIntake({
      source_max_new_issues: 5,
      workspace_max_new_issues: 5,
      source_cooldown_seconds: 3600,
    });

    const first = intake.applyBatch("src", batch([event("c1", "alpha failed")]));
    const second = intake.applyBatch("src", batch([event("c2", "beta failed")]));

    expect(first.outcomes[0]?.kind).toBe("issue_created");
    expect(second.outcomes[0]?.kind).toBe("budget_deferred");
    expect(second.outcomes[0]?.reason).toBe("source_cooldown");
  });

  test("draining opens parked issues once the window allows", () => {
    const { machine, intake, clock } = makeIntake();
    intake.applyBatch("src", batch([event("d1", "alpha failed")]));
    const parked = intake.applyBatch("src", batch([event("d2", "beta failed")]));
    expect(parked.outcomes[0]?.kind).toBe("budget_deferred");

    clock.advance(2 * 3600 * 1000);
    const drained = intake.drainDeferred();

    expect(drained.remaining).toBe(0);
    expect(drained.drained).toHaveLength(1);
    expect(drained.drained[0]?.outcome.kind).toBe("issue_created");
    expect(machine.listIssues()).toHaveLength(2);
  });

  test("draining keeps entries parked while the budget still denies", () => {
    const { machine, intake } = makeIntake({
      source_max_new_issues: 0,
      workspace_max_new_issues: 0,
    });
    intake.applyBatch("src", batch([event("e1", "alpha failed"), event("e2", "beta failed")]));

    const drained = intake.drainDeferred();

    expect(drained.drained).toHaveLength(0);
    expect(drained.remaining).toBe(2);
    expect(machine.listIssues()).toHaveLength(0);
  });
});

describe("budget observability", () => {
  test("status exposes window usage, cooldowns and the deferred backlog", () => {
    const { intake } = makeIntake();
    intake.applyBatch("src", batch([event("o1", "alpha failed")]));
    intake.applyBatch("src", batch([event("o2", "beta failed")]));

    const status = intake.budgetStatus("src");
    expect(status.source_used).toBe(1);
    expect(status.source_limit).toBe(1);
    expect(status.workspace_used).toBe(1);
    expect(status.workspace_limit).toBe(2);
    expect(status.deferred_count).toBe(1);
    expect(status.last_source_creation).toBeTruthy();
    expect(status.window_seconds).toBe(3600);
  });

  test("source status counts every explicit outcome", () => {
    const { intake } = makeIntake({ source_max_new_issues: 5, workspace_max_new_issues: 5 });
    intake.applyBatch("src", batch([event("s1", "alpha failed"), event("s1", "alpha failed")]));

    const status = intake.sourceStatus("src");
    expect(status.counts.events).toBe(2);
    expect(status.counts.issues_created).toBe(1);
    expect(status.counts.duplicates).toBe(1);
  });
});
