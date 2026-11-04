import type {
  BudgetPolicy,
  BudgetReserveRequest,
  BudgetUsageObservation,
} from "../../src/budget/index.js";

export const BUDGET_SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };

export const BUDGET_ACCESS = {
  enterprise_id: "ent_test",
  workspace_id: "ws_test",
  subject: "test-subject",
};

/**
 * A monetary policy with a tight workspace cap and a conservative internal
 * ceiling of 0.01 USD per 1000 tokens (10 USD per million).
 */
export function testBudgetPolicy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return {
    revision: "budget-policy-1",
    enterprise: { monetary: [{ currency: "USD", amount: "100" }], tokens: null },
    workspace: { monetary: [{ currency: "USD", amount: "50" }], tokens: null },
    run: { monetary: [{ currency: "USD", amount: "20" }], tokens: null },
    max_tokens_per_invocation: 300_000,
    token_only: null,
    cost_ceilings: [
      {
        endpoint_id: null,
        model_id: "scripted",
        currency: "USD",
        amount_per_1000_tokens: "0.01",
      },
    ],
    ...overrides,
  };
}

/** Explicit token-only policy: the only case where cost is not bounded. */
export function tokenOnlyPolicy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return testBudgetPolicy({
    enterprise: { monetary: [], tokens: 1_000_000 },
    workspace: { monetary: [], tokens: 500_000 },
    run: { monetary: [], tokens: 100_000 },
    cost_ceilings: [],
    token_only: { enabled: true, reason: "deployment meters tokens only" },
    ...overrides,
  });
}

export function reserveRequest(
  overrides: Partial<BudgetReserveRequest> = {},
): BudgetReserveRequest {
  return {
    enterprise_id: "ent_test",
    workspace_id: "ws_test",
    issue_id: "issue_test",
    run_id: "run_test",
    invocation_id: "inv_test",
    trace_id: "trace_test",
    attempt: 1,
    endpoint_id: "ep_test",
    provider: "openai",
    model_id: "scripted",
    token_bound: 10_000,
    ...overrides,
  };
}

export function knownUsage(tokens: number): BudgetUsageObservation {
  return { tokens, completeness: "known" };
}

export function unknownUsage(): BudgetUsageObservation {
  return { tokens: null, completeness: "unknown" };
}
