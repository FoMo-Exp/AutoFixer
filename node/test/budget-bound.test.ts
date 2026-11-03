import { describe, expect, test } from "vitest";

import { computeBudgetBound, estimateCostFromCeilings } from "../src/budget/index.js";
import { reserveRequest, testBudgetPolicy, tokenOnlyPolicy } from "./helpers/budget-fixtures.js";

describe("conservative budget bounds", () => {
  test("bounds monetary cost at the conservative ceiling", () => {
    const result = computeBudgetBound(testBudgetPolicy(), reserveRequest({ token_bound: 10_000 }));
    expect(result.status).toBe("bounded");
    if (result.status !== "bounded") return;
    expect(result.bound.token_bound).toBe(10_000);
    // 10_000 tokens * 0.01 USD / 1000 = 0.1 USD
    expect(result.bound.monetary_bound).toEqual([{ currency: "USD", amount: "0.1" }]);
  });

  test("rounds the monetary bound up so it never under-reserves", () => {
    const result = computeBudgetBound(testBudgetPolicy(), reserveRequest({ token_bound: 10_001 }));
    expect(result.status).toBe("bounded");
    if (result.status !== "bounded") return;
    // 10.001 cents -> 0.10001 USD
    expect(result.bound.monetary_bound).toEqual([{ currency: "USD", amount: "0.10001" }]);
  });

  test("uses the highest matching ceiling for a currency", () => {
    const policy = testBudgetPolicy({
      cost_ceilings: [
        {
          endpoint_id: null,
          model_id: "scripted",
          currency: "USD",
          amount_per_1000_tokens: "0.01",
        },
        {
          endpoint_id: "ep_test",
          model_id: null,
          currency: "USD",
          amount_per_1000_tokens: "0.02",
        },
      ],
    });
    const result = computeBudgetBound(policy, reserveRequest({ token_bound: 10_000 }));
    expect(result.status).toBe("bounded");
    if (result.status !== "bounded") return;
    expect(result.bound.monetary_bound).toEqual([{ currency: "USD", amount: "0.2" }]);
    expect(result.bound.cost_ceilings).toEqual([
      { currency: "USD", amount_per_1000_tokens: "0.02" },
    ]);
  });

  test("denies a monetary policy with no ceiling for the model or currency", () => {
    const noModel = computeBudgetBound(
      testBudgetPolicy(),
      reserveRequest({ model_id: "undiscovered" }),
    );
    expect(noModel).toMatchObject({ status: "denied", reason: "BUDGET_BOUND_UNKNOWN" });

    const eurPolicy = testBudgetPolicy({
      workspace: {
        monetary: [
          { currency: "USD", amount: "50" },
          { currency: "EUR", amount: "50" },
        ],
        tokens: null,
      },
    });
    const noCurrency = computeBudgetBound(eurPolicy, reserveRequest());
    expect(noCurrency).toMatchObject({ status: "denied", reason: "BUDGET_BOUND_UNKNOWN" });
  });

  test("denies a token bound above the per-invocation ceiling instead of clamping", () => {
    const policy = testBudgetPolicy({ max_tokens_per_invocation: 5_000 });
    const result = computeBudgetBound(policy, reserveRequest({ token_bound: 10_000 }));
    expect(result).toMatchObject({
      status: "denied",
      reason: "BUDGET_TOKEN_CEILING_EXCEEDED",
    });
  });

  test("denies a non-finite token bound", () => {
    for (const tokenBound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = computeBudgetBound(
        testBudgetPolicy(),
        reserveRequest({ token_bound: tokenBound }),
      );
      expect(result).toMatchObject({ status: "denied", reason: "BUDGET_BOUND_UNKNOWN" });
    }
  });

  test("an explicit token-only policy reserves tokens without inventing cost", () => {
    const result = computeBudgetBound(tokenOnlyPolicy(), reserveRequest({ token_bound: 10_000 }));
    expect(result).toMatchObject({
      status: "bounded",
      bound: { token_bound: 10_000, monetary_bound: [], cost_ceilings: [] },
    });
  });

  test("cost estimates from ceilings are conservative and labelled by the caller", () => {
    expect(
      estimateCostFromCeilings([{ currency: "USD", amount_per_1000_tokens: "0.01" }], 12_345),
    ).toEqual([{ currency: "USD", amount: "0.12345" }]);
    expect(estimateCostFromCeilings([], 12_345)).toEqual([]);
  });
});
