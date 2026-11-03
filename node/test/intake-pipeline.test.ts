import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { CollabMachine } from "../src/collab/machine.js";
import { ConnectorUnavailableError } from "../src/intake/connector.js";
import type {
  ConnectorBatch,
  LogSourceConnector,
  ProviderLogEvent,
} from "../src/intake/connector.js";
import { LogIntake } from "../src/intake/pipeline.js";
import type { SourceConfig } from "../src/intake/pipeline.js";
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
  source_max_new_issues: 100,
  workspace_max_new_issues: 100,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 20,
  backpressure_high_water: 16,
};

function fixedClock(startIso = "2026-11-03T12:00:00.000Z", stepMs = 1000): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}

function event(overrides: Partial<ProviderLogEvent> = {}): ProviderLogEvent {
  return {
    provider_event_id: "evt-1",
    event_time: "2026-11-03T12:00:00Z",
    schema_version: 1,
    provider_severity: "ERR",
    provider_service: "checkout-api",
    provider_environment: "prod-1",
    message: "checkout 1234 timed out in /api/orders",
    error: { class: "TimeoutError", stack_locations: ["/srv/checkout.ts:10 in processOrder"] },
    ...overrides,
  };
}

function batch(events: ProviderLogEvent[], extra: Partial<ConnectorBatch> = {}): ConnectorBatch {
  return { events, cursor: { value: "c-next" }, has_more: false, ...extra };
}

function scriptedConnector(steps: (ConnectorBatch | Error)[]): {
  connector: LogSourceConnector;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    connector: {
      sourceId: "src",
      async poll(_after, _limit) {
        state.calls += 1;
        const step = steps[Math.min(state.calls - 1, steps.length - 1)];
        if (step === undefined) {
          throw new Error("scripted connector has no steps left");
        }
        if (step instanceof Error) {
          throw step;
        }
        return step;
      },
    },
  };
}

interface MakeOptions {
  rules?: RuleConfig;
  budgets?: BudgetConfig;
  connector?: LogSourceConnector;
  machinePath?: string;
  storePath?: string;
}

function makeIntake(options: MakeOptions = {}): {
  machine: CollabMachine;
  store: IntakeStore;
  intake: LogIntake;
} {
  const machine = new CollabMachine(
    options.machinePath ? { persistencePath: options.machinePath } : {},
  );
  const store = new IntakeStore(
    options.storePath
      ? { persistencePath: options.storePath, now: fixedClock() }
      : { now: fixedClock() },
  );
  const intake = new LogIntake({
    machine,
    store,
    rules: options.rules ?? RULES,
    budgets: options.budgets ?? BUDGETS,
    now: fixedClock(),
  });
  const source: SourceConfig = {
    source_id: "src",
    workspace: { enterprise_id: "ent", workspace_id: "ws" },
    connector: options.connector ?? scriptedConnector([batch([])]).connector,
    max_events_per_poll: 100,
  };
  intake.registerSource(source);
  return { machine, store, intake };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "autofixer-intake-"));
}

describe("issue creation and deduplication", () => {
  test("creates exactly one triage issue for a new signal", () => {
    const { machine, intake } = makeIntake();
    const report = intake.applyBatch("src", batch([event()]));

    expect(report.outcomes[0]?.kind).toBe("issue_created");
    const signalKey = report.outcomes[0]?.signal_key ?? "";
    expect(signalKey).toMatch(/^fp2:/);
    const issues = machine.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.product_state).toBe("triage");
    expect(issues[0]?.dedupe_key).toBe(signalKey);
    expect(issues[0]?.repository).toEqual(REPO);
    expect(issues[0]?.workspace).toEqual({ enterprise_id: "ent", workspace_id: "ws" });
    expect(report.persisted).toBe(true);
  });

  test("a replayed provider event id is a duplicate and changes nothing", () => {
    const { machine, store, intake } = makeIntake();
    const first = intake.applyBatch("src", batch([event()]));
    const signalKey = first.outcomes[0]?.signal_key ?? "";

    const replay = intake.applyBatch("src", batch([event()]));

    expect(replay.outcomes[0]?.kind).toBe("duplicate_event");
    expect(replay.replayed).toBe(1);
    expect(machine.listIssues()).toHaveLength(1);
    expect(store.getSignal(signalKey)?.occurrences).toBe(1);
  });

  test("a repeated alert of the same fingerprint updates evidence instead of a new issue", () => {
    const { machine, store, intake } = makeIntake();
    const report = intake.applyBatch(
      "src",
      batch([event({ provider_event_id: "evt-1" }), event({ provider_event_id: "evt-2" })]),
    );

    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual([
      "issue_created",
      "evidence_updated",
    ]);
    expect(report.outcomes[1]?.occurrences).toBe(2);
    expect(machine.listIssues()).toHaveLength(1);
    const signal = store.getSignal(report.outcomes[0]?.signal_key ?? "");
    expect(signal?.occurrences).toBe(2);
    expect(signal?.evidence).toHaveLength(2);
    expect(signal?.issue_id).toBe(machine.listIssues()[0]?.issue_id);
  });

  test("out-of-order arrivals are processed, flagged, and never duplicate issues", () => {
    const { machine, intake } = makeIntake();
    intake.applyBatch(
      "src",
      batch([event({ provider_event_id: "e2", event_time: "2026-11-03T12:05:00Z" })]),
    );

    const late = intake.applyBatch(
      "src",
      batch([event({ provider_event_id: "e1", event_time: "2026-11-03T12:01:00Z" })]),
    );

    expect(late.outcomes[0]?.kind).toBe("evidence_updated");
    expect(late.outcomes[0]?.out_of_order).toBe(true);
    expect(late.out_of_order).toBe(1);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("invalid events are explicit outcomes and do not stop the batch", () => {
    const { machine, intake } = makeIntake();
    const broken = {
      provider_event_id: "",
      event_time: "not-a-time",
    } as unknown as ProviderLogEvent;

    const report = intake.applyBatch("src", batch([broken, event({ provider_event_id: "ok-1" })]));

    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual([
      "invalid_event",
      "issue_created",
    ]);
    expect(report.outcomes[0]?.reason).toBeTruthy();
    expect(machine.listIssues()).toHaveLength(1);
  });
});

describe("durability and replay safety", () => {
  test("persists events and checkpoint together before reporting success", () => {
    const dir = tempDir();
    const machinePath = path.join(dir, "machine.json");
    const storePath = path.join(dir, "intake.json");
    const first = makeIntake({ machinePath, storePath });
    const report = first.intake.applyBatch("src", batch([event()], { cursor: { value: "c-7" } }));
    expect(report.checkpoint?.value).toBe("c-7");

    const restarted = makeIntake({ machinePath, storePath });
    expect(restarted.store.checkpoint("src")?.value).toBe("c-7");

    const replay = restarted.intake.applyBatch(
      "src",
      batch([event()], { cursor: { value: "c-7" } }),
    );
    expect(replay.outcomes[0]?.kind).toBe("duplicate_event");
    expect(restarted.machine.listIssues()).toHaveLength(1);
  });

  test("a crash before persisting intake state never duplicates issues on replay", () => {
    const dir = tempDir();
    const machinePath = path.join(dir, "machine.json");
    const before = makeIntake({ machinePath });
    const created = before.intake.applyBatch("src", batch([event()]));
    const issueId = before.machine.listIssues()[0]?.issue_id;

    // The intake store was never persisted — as if the process died before
    // its write. The collaboration machine's issue survives its own log.
    const after = makeIntake({ machinePath });
    const replay = after.intake.applyBatch("src", batch([event()]));

    expect(after.machine.listIssues()).toHaveLength(1);
    expect(after.machine.listIssues()[0]?.issue_id).toBe(issueId);
    expect(replay.outcomes[0]?.signal_key).toBe(created.outcomes[0]?.signal_key);
    expect(replay.outcomes[0]?.issue_id).toBe(issueId);
  });
});

describe("gaps, disconnects and backpressure", () => {
  test("declared retention gaps are recorded once and surfaced", () => {
    const { store, intake } = makeIntake();
    const gap = {
      from: "2026-11-03T10:00:00Z",
      to: "2026-11-03T11:00:00Z",
      reason: "provider retention expired",
    };

    const report = intake.applyBatch("src", batch([], { gap }));
    expect(report.gap).not.toBeNull();
    expect(intake.sourceStatus("src").gaps).toHaveLength(1);

    const replay = intake.applyBatch("src", batch([], { gap }));
    expect(replay.gap).toBeNull();
    expect(intake.sourceStatus("src").gaps).toHaveLength(1);
    expect(store.gaps("src")).toHaveLength(1);
  });

  test("a connector outage is explicit and the cursor does not move", async () => {
    const scripted = scriptedConnector([
      new ConnectorUnavailableError("connection reset"),
      batch([event()], { cursor: { value: "c-1" } }),
    ]);
    const { store, intake } = makeIntake({ connector: scripted.connector });

    const down = await intake.pollSource("src");
    expect(down.status).toBe("disconnected");
    expect(store.checkpoint("src")).toBeNull();
    const status = intake.sourceStatus("src");
    expect(status.connection).toBe("disconnected");
    expect(status.last_error).toBeTruthy();

    const up = await intake.pollSource("src");
    expect(up.status).toBe("polled");
    if (up.status === "polled") {
      expect(up.batch.connection).toBe("reconnected");
      expect(up.batch.checkpoint?.value).toBe("c-1");
    }
    expect(intake.sourceStatus("src").connection).toBe("connected");
  });

  test("backpressure stops polling at the high-water mark", async () => {
    const budgets: BudgetConfig = {
      ...BUDGETS,
      source_max_new_issues: 0,
      workspace_max_new_issues: 0,
      backpressure_high_water: 2,
    };
    const scripted = scriptedConnector([batch([event()])]);
    const { store, intake } = makeIntake({ budgets, connector: scripted.connector });

    intake.applyBatch(
      "src",
      batch([
        event({ provider_event_id: "d1", message: "alpha service failed" }),
        event({ provider_event_id: "d2", message: "beta service failed" }),
      ]),
    );
    expect(store.deferredCount()).toBe(2);

    const report = await intake.pollSource("src");
    expect(report.status).toBe("backpressure");
    expect(scripted.calls).toBe(0);
  });
});

describe("repository triage", () => {
  const noMapping: RuleConfig = { version: "rules-1", rules: [] };

  test("an unmapped repository queues triage instead of guessing", () => {
    const { machine, intake } = makeIntake({ rules: noMapping });
    const report = intake.applyBatch("src", batch([event()]));

    expect(report.outcomes[0]?.kind).toBe("triage_queued");
    expect(report.outcomes[0]?.triage_id).toBeTruthy();
    expect(machine.listIssues()).toHaveLength(0);
  });

  test("repeated alerts of a triaged signal update its evidence", () => {
    const { machine, store, intake } = makeIntake({ rules: noMapping });
    const first = intake.applyBatch("src", batch([event({ provider_event_id: "t1" })]));
    const again = intake.applyBatch("src", batch([event({ provider_event_id: "t2" })]));

    expect(again.outcomes[0]?.kind).toBe("evidence_updated");
    expect(again.outcomes[0]?.triage_id).toBe(first.outcomes[0]?.triage_id);
    expect(machine.listIssues()).toHaveLength(0);
    expect(store.getSignal(first.outcomes[0]?.signal_key ?? "")?.occurrences).toBe(2);
  });

  test("resolving a triage record opens the issue against the chosen repository", () => {
    const { machine, store, intake } = makeIntake({ rules: noMapping });
    const report = intake.applyBatch("src", batch([event()]));
    const triageId = report.outcomes[0]?.triage_id ?? "";

    const resolved = intake.resolveTriage({
      triage_id: triageId,
      repository: REPO,
      actor: "human",
    });

    const issues = machine.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issue_id).toBe(resolved.issue_id);
    expect(issues[0]?.repository).toEqual(REPO);
    expect(store.getSignal(report.outcomes[0]?.signal_key ?? "")?.issue_id).toBe(resolved.issue_id);
  });
});
