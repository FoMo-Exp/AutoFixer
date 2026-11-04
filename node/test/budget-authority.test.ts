import { describe, expect, test } from "vitest";

import {
  BudgetConflictError,
  BudgetStore,
  createBudgetAuthority,
  createStaticBudgetPolicyResolver,
} from "../src/budget/index.js";
import type { BudgetAuthority } from "../src/budget/index.js";
import {
  BUDGET_ACCESS,
  BUDGET_SCOPE,
  knownUsage,
  reserveRequest,
  testBudgetPolicy,
  tokenOnlyPolicy,
  unknownUsage,
} from "./helpers/budget-fixtures.js";

function authorityWith(policy = testBudgetPolicy()): {
  authority: BudgetAuthority;
  store: BudgetStore;
} {
  const store = new BudgetStore();
  return {
    store,
    authority: createBudgetAuthority({
      store,
      policyResolver: createStaticBudgetPolicyResolver(policy, BUDGET_SCOPE),
    }),
  };
}

describe("budget authority", () => {
  test("admits a bounded attempt and reports a redelivery", async () => {
    const { authority } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    expect(decision).toMatchObject({ status: "reserved", replayed: false });
    const replay = await authority.reserve(reserveRequest());
    expect(replay).toMatchObject({ status: "reserved", replayed: true });
    if (decision.status !== "reserved" || replay.status !== "reserved") return;
    expect(replay.reservation_id).toBe(decision.reservation_id);
  });

  test("denies when no policy resolves for the scope", async () => {
    const { authority } = authorityWith();
    const decision = await authority.reserve(reserveRequest({ workspace_id: "ws_unconfigured" }));
    expect(decision).toEqual({
      status: "denied",
      reason: "BUDGET_POLICY_UNAVAILABLE",
      detail: "no budget policy is configured for this scope",
    });
  });

  test("denies exhausted scope budget with a safe detail", async () => {
    const { authority } = authorityWith(
      testBudgetPolicy({
        workspace: { monetary: [{ currency: "USD", amount: "0.05" }], tokens: null },
      }),
    );
    const decision = await authority.reserve(reserveRequest());
    expect(decision).toMatchObject({ status: "denied", reason: "BUDGET_LIMIT_EXCEEDED" });
    if (decision.status !== "denied") return;
    expect(decision.detail).toContain("workspace");
    expect(decision.detail).not.toContain("0.1");
  });

  test("denies a monetary limit that has no finite conservative bound", async () => {
    const { authority } = authorityWith();
    const decision = await authority.reserve(reserveRequest({ model_id: "undiscovered" }));
    expect(decision).toMatchObject({ status: "denied", reason: "BUDGET_BOUND_UNKNOWN" });
  });

  test("denies a token bound above the per-invocation ceiling", async () => {
    const { authority } = authorityWith(testBudgetPolicy({ max_tokens_per_invocation: 5_000 }));
    const decision = await authority.reserve(reserveRequest({ token_bound: 10_000 }));
    expect(decision).toMatchObject({
      status: "denied",
      reason: "BUDGET_TOKEN_CEILING_EXCEEDED",
    });
  });

  test("settles usage and prices the monetary dimension at the bound ceiling", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.settleUsage(decision.reservation_id, knownUsage(3_000));
    const reservation = store.inspect(decision.reservation_id);
    expect(reservation?.status).toBe("settled");
    expect(reservation?.tokens.used).toBe(3_000);
    expect(reservation?.money[0]).toMatchObject({
      used: "0.03",
      completeness: "estimated",
      source: "bound_ceiling",
    });
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 3_000,
      monetary: [{ currency: "USD", amount: "0.03" }],
    });
  });

  test("never turns missing usage into zero cost", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.settleUsage(decision.reservation_id, unknownUsage());
    const reservation = store.inspect(decision.reservation_id);
    expect(reservation?.status).toBe("reconciling");
    expect(reservation?.tokens.used).toBeNull();
    expect(reservation?.money[0]?.used).toBeNull();
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 10_000,
      monetary: [{ currency: "USD", amount: "0.1" }],
    });
  });

  test("retains the reservation for an unknown provider outcome", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.requireReconciliation(decision.reservation_id, "transport outcome unknown");
    const reservation = store.inspect(decision.reservation_id);
    expect(reservation?.status).toBe("reconciling");
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(10_000);
    expect(() => authority.release(decision.reservation_id, "no")).toThrow(BudgetConflictError);
  });

  test("refunds a provably unsent attempt", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.release(decision.reservation_id, "connection refused");
    expect(store.inspect(decision.reservation_id)?.status).toBe("released");
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 0,
      monetary: [],
    });
  });

  test("reconciles the monetary dimension to exact provider cost", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.settleUsage(decision.reservation_id, knownUsage(3_000));
    authority.reconcileCost(
      decision.reservation_id,
      [{ currency: "USD", amount: "0.025" }],
      "known",
      "provider invoice correction",
    );
    const reservation = store.inspect(decision.reservation_id);
    expect(reservation?.status).toBe("settled");
    expect(reservation?.money[0]).toMatchObject({
      used: "0.025",
      completeness: "known",
      source: "cost",
    });
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace").monetary).toEqual([
      { currency: "USD", amount: "0.025" },
    ]);
    expect(store.auditEntries(BUDGET_ACCESS).map((entry) => entry.kind)).toEqual([
      "reserve",
      "settle",
      "reconcile",
    ]);
  });

  test("charges the actual cost when the provider exceeds the bound", async () => {
    const { authority, store } = authorityWith();
    const decision = await authority.reserve(reserveRequest({ token_bound: 1_000 }));
    if (decision.status !== "reserved") throw new Error("expected admission");
    authority.settleUsage(decision.reservation_id, knownUsage(2_000));
    const reservation = store.inspect(decision.reservation_id);
    // 2_000 tokens at the conservative ceiling = 0.02, above the 0.01 bound.
    expect(reservation?.money[0]?.used).toBe("0.02");
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace").monetary).toEqual([
      { currency: "USD", amount: "0.02" },
    ]);
  });

  test("token-only policy never invents a monetary reservation", async () => {
    const { authority, store } = authorityWith(tokenOnlyPolicy());
    const decision = await authority.reserve(reserveRequest());
    if (decision.status !== "reserved") throw new Error("expected admission");
    const reservation = store.inspect(decision.reservation_id);
    expect(reservation?.money).toEqual([]);
    authority.settleUsage(decision.reservation_id, knownUsage(3_000));
    expect(store.inspect(decision.reservation_id)?.status).toBe("settled");
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({ tokens: 3_000 });
  });

  test("concurrent admission through the authority cannot overspend", async () => {
    const { authority, store } = authorityWith(
      testBudgetPolicy({
        workspace: { monetary: [{ currency: "USD", amount: "0.5" }], tokens: null },
      }),
    );
    const decisions = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        authority.reserve(reserveRequest({ invocation_id: `inv_concurrent_${index}` })),
      ),
    );
    expect(decisions.filter((decision) => decision.status === "reserved")).toHaveLength(5);
    expect(decisions.filter((decision) => decision.status === "denied")).toHaveLength(20);
    expect(authority.scopeUsage(BUDGET_ACCESS, "workspace").monetary).toEqual([
      { currency: "USD", amount: "0.5" },
    ]);
    expect(store.entryCount).toBe(5);
  });
});
