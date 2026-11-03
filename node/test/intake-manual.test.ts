import { describe, expect, test } from "vitest";

import { CollabMachine } from "../src/collab/machine.js";
import type { ConnectorBatch, ProviderLogEvent } from "../src/intake/connector.js";
import { LogIntake } from "../src/intake/pipeline.js";
import type { ManualSubmissionInput } from "../src/intake/pipeline.js";
import type { RepositoryCandidate, RuleConfig } from "../src/intake/rules.js";
import { IntakeStore } from "../src/intake/store.js";
import type { BudgetConfig } from "../src/intake/store.js";

const REPO_A: RepositoryCandidate = {
  repository_id: "repo_a",
  url: "https://example.com/a.git",
  base_ref: "main",
  base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const REPO_B: RepositoryCandidate = {
  repository_id: "repo_b",
  url: "https://example.com/b.git",
  base_ref: "main",
  base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const MAPPED: RuleConfig = {
  version: "rules-1",
  rules: [{ rule_id: "map", match: {}, decision: { repositories: [REPO_A] } }],
};

const AMBIGUOUS: RuleConfig = {
  version: "rules-1",
  rules: [
    {
      rule_id: "a",
      match: { provider_service_in: ["checkout-api"] },
      decision: { repositories: [REPO_A] },
    },
    { rule_id: "b", match: {}, decision: { repositories: [REPO_B] } },
  ],
};

const budgets: BudgetConfig = {
  source_max_new_issues: 10,
  workspace_max_new_issues: 10,
  window_seconds: 3600,
  source_cooldown_seconds: 0,
  workspace_cooldown_seconds: 0,
  max_deferred: 10,
  backpressure_high_water: 8,
};

function fixedClock(): () => Date {
  let current = Date.parse("2026-11-03T12:00:00.000Z");
  return () => {
    const value = new Date(current);
    current += 1000;
    return value;
  };
}

function batch(events: ProviderLogEvent[]): ConnectorBatch {
  return { events, cursor: { value: "c-next" }, has_more: false };
}

function makeIntake(rules: RuleConfig = MAPPED): {
  machine: CollabMachine;
  intake: LogIntake;
} {
  const machine = new CollabMachine();
  const intake = new LogIntake({
    machine,
    store: new IntakeStore({ now: fixedClock() }),
    rules,
    budgets,
    now: fixedClock(),
  });
  intake.registerSource({
    source_id: "src",
    workspace: { enterprise_id: "ent", workspace_id: "ws" },
    connector: { sourceId: "src", poll: async () => batch([]) },
    max_events_per_poll: 100,
  });
  return { machine, intake };
}

function submission(overrides: Partial<ManualSubmissionInput> = {}): ManualSubmissionInput {
  return {
    actor: "human-operator",
    workspace: { enterprise_id: "ent", workspace_id: "ws" },
    provider_severity: "error",
    provider_service: "checkout-api",
    provider_environment: "prod-1",
    message: "checkout 1234 timed out",
    error: { class: "TimeoutError" },
    ...overrides,
  };
}

describe("manual submission", () => {
  test("creates an issue through the same dedup path as source alerts", () => {
    const { machine, intake } = makeIntake();
    const result = intake.submitManual(submission());

    expect(result.kind).toBe("issue_created");
    expect(result.signal_key).toMatch(/^fp2:/);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("a manual report of a known signal updates evidence instead of a new issue", () => {
    const { machine, intake } = makeIntake();
    intake.submitManual(submission({ submission_id: "m1" }));

    const again = intake.submitManual(submission({ submission_id: "m2" }));

    expect(again.kind).toBe("evidence_updated");
    expect(again.occurrences).toBe(2);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("a manual report correlates with an issue created from a source alert", () => {
    const { machine, intake } = makeIntake();
    intake.applyBatch(
      "src",
      batch([
        {
          provider_event_id: "evt-1",
          event_time: "2026-11-03T11:00:00Z",
          schema_version: 1,
          provider_severity: "ERR",
          provider_service: "checkout-api",
          provider_environment: "prod-1",
          message: "checkout 1234 timed out",
          error: { class: "TimeoutError" },
        },
      ]),
    );

    const result = intake.submitManual(submission());

    expect(result.kind).toBe("evidence_updated");
    expect(result.issue_id).toBe(machine.listIssues()[0]?.issue_id);
    expect(machine.listIssues()).toHaveLength(1);
  });

  test("the same submission id is idempotent", () => {
    const { intake } = makeIntake();
    const first = intake.submitManual(submission({ submission_id: "same" }));
    const retry = intake.submitManual(submission({ submission_id: "same" }));

    expect(first.kind).toBe("issue_created");
    expect(retry.kind).toBe("duplicate_event");
    expect(retry.event_ref).toBe("same");
  });

  test("an ambiguous mapping queues triage instead of guessing", () => {
    const { machine, intake } = makeIntake(AMBIGUOUS);
    const result = intake.submitManual(submission());

    expect(result.kind).toBe("triage_queued");
    expect(result.reason).toBe("repository_ambiguous");
    expect(machine.listIssues()).toHaveLength(0);
  });

  test("a human-declared repository resolves the ambiguity", () => {
    const { machine, intake } = makeIntake(AMBIGUOUS);
    const result = intake.submitManual(submission({ repository: REPO_B }));

    expect(result.kind).toBe("issue_created");
    const issues = machine.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.repository).toEqual(REPO_B);
  });

  test("an invalid manual submission is an explicit outcome", () => {
    const { machine, intake } = makeIntake();
    const result = intake.submitManual(submission({ message: "" }));

    expect(result.kind).toBe("invalid_event");
    expect(result.reason).toBeTruthy();
    expect(machine.listIssues()).toHaveLength(0);
  });
});
