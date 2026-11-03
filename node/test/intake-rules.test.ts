import { describe, expect, test } from "vitest";

import { evaluateRules } from "../src/intake/rules.js";
import type {
  RateObservation,
  RepositoryCandidate,
  RuleConfig,
  RuleEvaluationInput,
} from "../src/intake/rules.js";

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

const input: RuleEvaluationInput = {
  provider_severity: "ERR",
  provider_service: "checkout-api",
  provider_environment: "prod-1",
  error_class: "TimeoutError",
  error_signature: "TimeoutError | checkout <n> timed out | checkout.ts:processOrder",
  labels: { team: "payments", tier: "web" },
};

const idleRate: RateObservation = { count_in_window: 1 };

function configWith(rules: RuleConfig["rules"]): RuleConfig {
  return { version: "rules-1", rules };
}

describe("severity selection", () => {
  test("first matching rule that sets severity wins", () => {
    const decision = evaluateRules(
      configWith([
        {
          rule_id: "r1",
          match: { provider_severity_in: ["err"] },
          decision: { severity: "critical" },
        },
        { rule_id: "r2", match: {}, decision: { severity: "info" } },
      ]),
      input,
      idleRate,
    );
    expect(decision.severity).toBe("critical");
  });

  test("falls back to the provider severity table when no rule matches", () => {
    const base = configWith([]);
    expect(evaluateRules(base, { ...input, provider_severity: "fatal" }, idleRate).severity).toBe(
      "critical",
    );
    expect(evaluateRules(base, { ...input, provider_severity: "ERR" }, idleRate).severity).toBe(
      "error",
    );
    expect(evaluateRules(base, { ...input, provider_severity: "warn" }, idleRate).severity).toBe(
      "warning",
    );
    expect(evaluateRules(base, { ...input, provider_severity: "info" }, idleRate).severity).toBe(
      "info",
    );
  });

  test("maps an unknown provider severity to error without inventing a level", () => {
    const decision = evaluateRules(
      configWith([]),
      { ...input, provider_severity: "bogus" },
      idleRate,
    );
    expect(decision.severity).toBe("error");
  });
});

describe("service and environment selection", () => {
  test("rule-matched service and environment override the provider values", () => {
    const decision = evaluateRules(
      configWith([
        {
          rule_id: "map",
          match: { provider_service_in: ["CHECKOUT-API"] },
          decision: { service: "checkout", environment: "production" },
        },
      ]),
      input,
      idleRate,
    );
    expect(decision.service).toBe("checkout");
    expect(decision.environment).toBe("production");
  });

  test("falls back to provider-native service and environment verbatim", () => {
    const decision = evaluateRules(configWith([]), input, idleRate);
    expect(decision.service).toBe("checkout-api");
    expect(decision.environment).toBe("prod-1");
  });

  test("matches labels exactly and case-sensitively", () => {
    const rules = configWith([
      {
        rule_id: "by-label",
        match: { label_equals: { team: "payments" } },
        decision: { service: "payments" },
      },
    ]);
    expect(evaluateRules(rules, input, idleRate).service).toBe("payments");
    expect(evaluateRules(rules, { ...input, labels: { team: "Payments" } }, idleRate).service).toBe(
      "checkout-api",
    );
  });
});

describe("rate and window selection", () => {
  test("the first matching rule sets the window and escalation threshold", () => {
    const decision = evaluateRules(
      configWith([
        {
          rule_id: "rate",
          match: {},
          decision: { rate_window_seconds: 60, rate_escalate_at: 5 },
        },
      ]),
      input,
      idleRate,
    );
    expect(decision.rate_window_seconds).toBe(60);
    expect(decision.rate_escalate_at).toBe(5);
    expect(decision.rate_count).toBe(1);
  });

  test("defaults to a 300 second window with no escalation", () => {
    const decision = evaluateRules(configWith([]), input, idleRate);
    expect(decision.rate_window_seconds).toBe(300);
    expect(decision.rate_escalate_at).toBeNull();
  });

  test("escalates severity one step when the window count reaches the threshold", () => {
    const rules = configWith([
      {
        rule_id: "rate",
        match: {},
        decision: { severity: "warning", rate_window_seconds: 60, rate_escalate_at: 5 },
      },
    ]);
    expect(evaluateRules(rules, input, { count_in_window: 4 }).severity).toBe("warning");
    expect(evaluateRules(rules, input, { count_in_window: 5 }).severity).toBe("error");
  });

  test("does not escalate past critical", () => {
    const rules = configWith([
      {
        rule_id: "rate",
        match: {},
        decision: { severity: "critical", rate_window_seconds: 60, rate_escalate_at: 1 },
      },
    ]);
    expect(evaluateRules(rules, input, { count_in_window: 10 }).severity).toBe("critical");
  });
});

describe("suppression selection", () => {
  test("records the first matching suppression rule with its reason", () => {
    const decision = evaluateRules(
      configWith([
        {
          rule_id: "quiet",
          match: { error_class_in: ["timeouterror"] },
          decision: { suppress: { reason: "known noisy timeout" } },
        },
        {
          rule_id: "quiet2",
          match: {},
          decision: { suppress: { reason: "later rule" } },
        },
      ]),
      input,
      idleRate,
    );
    expect(decision.suppression).toEqual({
      rule_id: "quiet",
      reason: "known noisy timeout",
    });
  });

  test("leaves suppression empty when no rule suppresses", () => {
    expect(evaluateRules(configWith([]), input, idleRate).suppression).toBeNull();
  });
});

describe("repository mapping", () => {
  test("maps to the single repository of the matching rule", () => {
    const decision = evaluateRules(
      configWith([{ rule_id: "map", match: {}, decision: { repositories: [REPO_A] } }]),
      input,
      idleRate,
    );
    expect(decision.repository_mapping.status).toBe("mapped");
    expect(decision.repository_mapping.repository).toEqual(REPO_A);
    expect(decision.repository_mapping.rule_ids).toEqual(["map"]);
  });

  test("stays unmapped when no rule names a repository", () => {
    const decision = evaluateRules(configWith([]), input, idleRate);
    expect(decision.repository_mapping.status).toBe("unmapped");
    expect(decision.repository_mapping.repository).toBeNull();
    expect(decision.repository_mapping.candidates).toEqual([]);
  });

  test("conflicting rules are ambiguous and never pick one", () => {
    const decision = evaluateRules(
      configWith([
        { rule_id: "a", match: {}, decision: { repositories: [REPO_A] } },
        { rule_id: "b", match: {}, decision: { repositories: [REPO_B] } },
      ]),
      input,
      idleRate,
    );
    expect(decision.repository_mapping.status).toBe("ambiguous");
    expect(decision.repository_mapping.repository).toBeNull();
    expect(decision.repository_mapping.candidates).toEqual([REPO_A, REPO_B]);
    expect(decision.repository_mapping.rule_ids).toEqual(["a", "b"]);
  });

  test("consistent rules agreeing on one repository still map", () => {
    const decision = evaluateRules(
      configWith([
        { rule_id: "a", match: {}, decision: { repositories: [REPO_A] } },
        {
          rule_id: "b",
          match: { label_equals: { tier: "web" } },
          decision: { repositories: [REPO_A] },
        },
      ]),
      input,
      idleRate,
    );
    expect(decision.repository_mapping.status).toBe("mapped");
    expect(decision.repository_mapping.repository).toEqual(REPO_A);
    expect(decision.repository_mapping.rule_ids).toEqual(["a", "b"]);
  });

  test("one rule listing two candidates is ambiguous", () => {
    const decision = evaluateRules(
      configWith([{ rule_id: "map", match: {}, decision: { repositories: [REPO_A, REPO_B] } }]),
      input,
      idleRate,
    );
    expect(decision.repository_mapping.status).toBe("ambiguous");
    expect(decision.repository_mapping.repository).toBeNull();
    expect(decision.repository_mapping.candidates).toEqual([REPO_A, REPO_B]);
  });
});

describe("decision provenance and determinism", () => {
  test("records every matching rule id in order", () => {
    const decision = evaluateRules(
      configWith([
        { rule_id: "r1", match: {}, decision: {} },
        { rule_id: "r2", match: { provider_severity_in: ["err"] }, decision: {} },
        { rule_id: "r3", match: { provider_severity_in: ["warn"] }, decision: {} },
      ]),
      input,
      idleRate,
    );
    expect(decision.rule_ids).toEqual(["r1", "r2"]);
    expect(decision.policy_version).toBe("rules-1");
  });

  test("identical inputs produce identical decisions", () => {
    const rules = configWith([
      {
        rule_id: "r1",
        match: { label_equals: { team: "payments" } },
        decision: {
          severity: "error",
          service: "checkout",
          environment: "production",
          rate_window_seconds: 60,
          rate_escalate_at: 3,
          repositories: [REPO_A],
        },
      },
    ]);
    expect(evaluateRules(rules, input, idleRate)).toEqual(evaluateRules(rules, input, idleRate));
  });
});
