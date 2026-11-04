import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BudgetAccessError,
  BudgetConflictError,
  BudgetQuotaError,
  BudgetStore,
  BudgetValidationError,
  type BudgetReserveInput,
} from "../src/budget/index.js";
import { BUDGET_ACCESS } from "./helpers/budget-fixtures.js";

function storeInput(overrides: Partial<BudgetReserveInput> = {}): BudgetReserveInput {
  return {
    identity: {
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
    },
    policy_revision: "budget-policy-1",
    limits: {
      enterprise: { monetary: [{ currency: "USD", amount: "100" }], tokens: null },
      workspace: { monetary: [{ currency: "USD", amount: "50" }], tokens: null },
      run: { monetary: [{ currency: "USD", amount: "20" }], tokens: null },
    },
    cost_ceilings: [{ currency: "USD", amount_per_1000_tokens: "0.01" }],
    token_bound: 10_000,
    monetary_bound: [{ currency: "USD", amount: "0.1" }],
    ...overrides,
  };
}

function freshStore(options: { persistencePath?: string } = {}): BudgetStore {
  return new BudgetStore(options);
}

describe("budget store", () => {
  test("reserves a conservative bound and commits it at every scope level", () => {
    const store = freshStore();
    const { reservation, replayed } = store.reserve(storeInput());
    expect(replayed).toBe(false);
    expect(reservation.status).toBe("held");
    expect(reservation.tokens).toEqual({ bound: 10_000, used: null, completeness: null });
    expect(reservation.money).toEqual([
      {
        currency: "USD",
        bound: "0.1",
        used: null,
        completeness: null,
        source: null,
      },
    ]);
    expect(store.scopeUsage(BUDGET_ACCESS, "enterprise")).toMatchObject({
      tokens: 10_000,
      monetary: [{ currency: "USD", amount: "0.1" }],
    });
    expect(store.scopeUsage(BUDGET_ACCESS, "run", "run_test").tokens).toBe(10_000);
    expect(store.entryCount).toBe(1);
  });

  test("settles known usage and refunds the unused reservation", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    const settled = store.settle(reservation.reservation_id, {
      usage: { tokens: 3_000, completeness: "known" },
      cost: {
        amounts: [{ currency: "USD", amount: "0.03" }],
        completeness: "estimated",
        source: "bound_ceiling",
      },
    });
    expect(settled.status).toBe("settled");
    expect(settled.tokens.used).toBe(3_000);
    expect(settled.money[0]).toMatchObject({
      used: "0.03",
      completeness: "estimated",
      source: "bound_ceiling",
    });
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace")).toEqual({
      level: "workspace",
      enterprise_id: "ent_test",
      workspace_id: "ws_test",
      run_id: null,
      tokens: 3_000,
      monetary: [{ currency: "USD", amount: "0.03" }],
    });
    expect(store.auditEntries(BUDGET_ACCESS).map((entry) => entry.kind)).toEqual([
      "reserve",
      "settle",
    ]);
  });

  test("keeps the full reservation when usage is unknown, never zero", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    const settled = store.settle(reservation.reservation_id, {
      usage: { tokens: null, completeness: "unknown" },
      cost: { amounts: [], completeness: "unknown", source: "bound_ceiling" },
    });
    expect(settled.status).toBe("reconciling");
    expect(settled.tokens.used).toBeNull();
    expect(settled.money[0]?.used).toBeNull();
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(10_000);
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").monetary).toEqual([
      { currency: "USD", amount: "0.1" },
    ]);
  });

  test("reconciliation retains the bound and blocks release", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    const reconciling = store.requireReconciliation(
      reservation.reservation_id,
      "provider outcome unknown",
    );
    expect(reconciling.status).toBe("reconciling");
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(10_000);
    expect(() => store.release(reservation.reservation_id, "too late")).toThrow(
      BudgetConflictError,
    );
  });

  test("releases only a provably unsent attempt and refunds it fully", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    const released = store.release(reservation.reservation_id, "connection refused");
    expect(released.status).toBe("released");
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 0,
      monetary: [],
    });
  });

  test("a redelivered reservation is idempotent; a changed one conflicts", () => {
    const store = freshStore();
    const first = store.reserve(storeInput());
    const replay = store.reserve(storeInput());
    expect(replay.replayed).toBe(true);
    expect(replay.reservation.reservation_id).toBe(first.reservation.reservation_id);
    expect(store.entryCount).toBe(1);
    expect(() => store.reserve(storeInput({ token_bound: 20_000 }))).toThrow(BudgetConflictError);
  });

  test("redelivered settlements are idempotent and different values must be reconciled", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    const settlement = {
      usage: { tokens: 3_000, completeness: "known" as const },
      cost: {
        amounts: [{ currency: "USD", amount: "0.03" }],
        completeness: "estimated" as const,
        source: "bound_ceiling" as const,
      },
    };
    store.settle(reservation.reservation_id, settlement);
    store.settle(reservation.reservation_id, settlement);
    expect(store.entryCount).toBe(2);
    expect(() =>
      store.settle(reservation.reservation_id, {
        ...settlement,
        usage: { tokens: 4_000, completeness: "known" },
      }),
    ).toThrow(BudgetConflictError);
    expect(store.entryCount).toBe(2);

    const reconciled = store.reconcile(reservation.reservation_id, {
      usage: { tokens: 4_000, completeness: "known" },
      reason: "provider correction",
    });
    expect(reconciled.tokens.used).toBe(4_000);
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(4_000);
    expect(store.auditEntries(BUDGET_ACCESS).at(-1)?.kind).toBe("reconcile");
  });

  test("refuses a settlement in a currency that was never reserved", () => {
    const store = freshStore();
    const { reservation } = store.reserve(storeInput());
    expect(() =>
      store.settle(reservation.reservation_id, {
        cost: {
          amounts: [{ currency: "EUR", amount: "1" }],
          completeness: "known",
          source: "cost",
        },
      }),
    ).toThrow(BudgetValidationError);
  });

  test("enforces all three scope levels and names the exhausted one", () => {
    const store = freshStore();
    store.reserve(storeInput({ identity: { ...storeInput().identity, invocation_id: "inv_1" } }));
    expect(() =>
      store.reserve(
        storeInput({
          identity: { ...storeInput().identity, invocation_id: "inv_2" },
          limits: {
            ...storeInput().limits,
            run: { monetary: [{ currency: "USD", amount: "0.15" }], tokens: null },
          },
        }),
      ),
    ).toThrowError(BudgetQuotaError);

    expect(() =>
      store.reserve(
        storeInput({
          identity: { ...storeInput().identity, invocation_id: "inv_3" },
          limits: {
            ...storeInput().limits,
            workspace: { monetary: [{ currency: "USD", amount: "0.15" }], tokens: null },
          },
        }),
      ),
    ).toThrowError(/workspace USD budget/);

    // A tight enterprise cap is enforced even when workspace/run have room.
    expect(() =>
      store.reserve(
        storeInput({
          identity: { ...storeInput().identity, invocation_id: "inv_4" },
          limits: {
            ...storeInput().limits,
            enterprise: { monetary: [{ currency: "USD", amount: "0.15" }], tokens: null },
          },
        }),
      ),
    ).toThrowError(/enterprise USD budget/);
  });

  test("enforces scope token caps", () => {
    const store = freshStore();
    store.reserve(
      storeInput({
        limits: {
          enterprise: { monetary: [], tokens: 100_000 },
          workspace: { monetary: [], tokens: 15_000 },
          run: null,
        },
        cost_ceilings: [],
        monetary_bound: [],
      }),
    );
    expect(() =>
      store.reserve(
        storeInput({
          identity: { ...storeInput().identity, invocation_id: "inv_2" },
          limits: {
            enterprise: { monetary: [], tokens: 100_000 },
            workspace: { monetary: [], tokens: 15_000 },
            run: null,
          },
          cost_ceilings: [],
          monetary_bound: [],
        }),
      ),
    ).toThrowError(/workspace token budget/);
  });

  test("scopes reads and filters, refusing another workspace", () => {
    const store = freshStore();
    store.reserve(storeInput());
    expect(
      store.get(BUDGET_ACCESS, store.list(BUDGET_ACCESS)[0]?.reservation_id ?? ""),
    ).toBeDefined();
    expect(() =>
      store.get(
        { ...BUDGET_ACCESS, workspace_id: "ws_other" },
        store.list(BUDGET_ACCESS)[0]?.reservation_id ?? "",
      ),
    ).toThrow(BudgetAccessError);
    expect(() => store.list(BUDGET_ACCESS, { workspace_id: "ws_other" })).toThrow(
      BudgetAccessError,
    );
    expect(store.list(BUDGET_ACCESS, { run_id: "run_other" })).toEqual([]);
    expect(store.list(BUDGET_ACCESS, { needs_reconciliation: true })).toEqual([]);
  });

  test("persists the journal and replays it exactly after a restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-store-"));
    const file = path.join(dir, "journal.jsonl");
    const store = new BudgetStore({ persistencePath: file });
    const { reservation } = store.reserve(storeInput());
    store.settle(reservation.reservation_id, {
      usage: { tokens: 3_000, completeness: "known" },
      cost: {
        amounts: [{ currency: "USD", amount: "0.03" }],
        completeness: "estimated",
        source: "bound_ceiling",
      },
    });
    const reopened = new BudgetStore({ persistencePath: file });
    expect(reopened.entryCount).toBe(2);
    expect(reopened.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 3_000,
      monetary: [{ currency: "USD", amount: "0.03" }],
    });
    // The reopened journal keeps accepting transitions.
    reopened.reserve(
      storeInput({ identity: { ...storeInput().identity, invocation_id: "inv_2" } }),
    );
    expect(reopened.entryCount).toBe(3);
  });

  test("repairs a torn final record instead of reading half a transition", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-store-"));
    const file = path.join(dir, "journal.jsonl");
    const store = new BudgetStore({ persistencePath: file });
    store.reserve(storeInput());
    appendFileSync(file, '{"sequence":2,"kind":"settle"');
    const reopened = new BudgetStore({ persistencePath: file });
    expect(reopened.repairedTornTail).toBe(true);
    expect(reopened.entryCount).toBe(1);
    expect(reopened.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(10_000);
    reopened.reserve(
      storeInput({ identity: { ...storeInput().identity, invocation_id: "inv_2" } }),
    );
    expect(reopened.entryCount).toBe(2);
  });

  test("refuses a corrupt journal record instead of reinterpreting it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-store-"));
    const file = path.join(dir, "journal.jsonl");
    const store = new BudgetStore({ persistencePath: file });
    store.reserve(storeInput());
    appendFileSync(file, "not-json\n");
    expect(() => new BudgetStore({ persistencePath: file })).toThrow(BudgetValidationError);
  });

  test("refuses a non-contiguous journal sequence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-store-"));
    const file = path.join(dir, "journal.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        sequence: 2,
        kind: "release",
        at: "2026-11-03T00:00:00Z",
        reservation_id: "budget:inv_test:1",
        reason: "test",
      })}\n`,
    );
    expect(() => new BudgetStore({ persistencePath: file })).toThrow(BudgetValidationError);
  });

  test("serialized reservations survive concurrent admission without overspending", async () => {
    const store = freshStore();
    const limits = {
      enterprise: { monetary: [{ currency: "USD", amount: "1" }], tokens: null },
      workspace: { monetary: [{ currency: "USD", amount: "0.5" }], tokens: null },
      run: null,
    };
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        Promise.resolve().then(() => {
          try {
            store.reserve(
              storeInput({
                identity: {
                  ...storeInput().identity,
                  invocation_id: `inv_concurrent_${index}`,
                },
                limits,
              }),
            );
            return "reserved";
          } catch (error) {
            return error instanceof BudgetQuotaError ? "denied" : "error";
          }
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === "reserved")).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === "denied")).toHaveLength(35);
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").monetary).toEqual([
      { currency: "USD", amount: "0.5" },
    ]);
  });
});
