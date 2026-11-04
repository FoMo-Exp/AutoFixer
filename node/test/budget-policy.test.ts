import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createStaticBudgetPolicyResolver,
  loadBudgetPolicyFile,
  validateBudgetPolicy,
} from "../src/budget/index.js";
import { BudgetValidationError } from "../src/budget/index.js";
import { BUDGET_SCOPE, testBudgetPolicy, tokenOnlyPolicy } from "./helpers/budget-fixtures.js";

describe("budget policy", () => {
  test("accepts a monetary policy with conservative ceilings", () => {
    const policy = validateBudgetPolicy(testBudgetPolicy());
    expect(policy.revision).toBe("budget-policy-1");
    expect(policy.token_only).toBeNull();
    expect(policy.workspace.monetary).toEqual([{ currency: "USD", amount: "50" }]);
  });

  test("accepts an explicit token-only policy", () => {
    const policy = validateBudgetPolicy(tokenOnlyPolicy());
    expect(policy.token_only).toEqual({
      enabled: true,
      reason: "deployment meters tokens only",
    });
    expect(policy.cost_ceilings).toEqual([]);
  });

  test("refuses monetary limits without a finite conservative ceiling", () => {
    expect(() => validateBudgetPolicy(testBudgetPolicy({ cost_ceilings: [] }))).toThrow(
      BudgetValidationError,
    );
  });

  test("refuses a monetary policy without any monetary limit", () => {
    expect(() =>
      validateBudgetPolicy(
        testBudgetPolicy({
          enterprise: { monetary: [], tokens: 1000 },
          workspace: { monetary: [], tokens: 1000 },
          run: null,
        }),
      ),
    ).toThrow(BudgetValidationError);
  });

  test("refuses a token-only policy that still declares monetary limits", () => {
    expect(() =>
      validateBudgetPolicy(
        tokenOnlyPolicy({
          workspace: { monetary: [{ currency: "USD", amount: "5" }], tokens: null },
        }),
      ),
    ).toThrow(BudgetValidationError);
  });

  test("refuses a token-only policy that still declares cost ceilings", () => {
    expect(() =>
      validateBudgetPolicy(
        tokenOnlyPolicy({
          cost_ceilings: [
            {
              endpoint_id: null,
              model_id: null,
              currency: "USD",
              amount_per_1000_tokens: "1",
            },
          ],
        }),
      ),
    ).toThrow(BudgetValidationError);
  });

  test("refuses zero, negative and duplicate ceilings", () => {
    const ceiling = {
      endpoint_id: null,
      model_id: null,
      currency: "USD",
      amount_per_1000_tokens: "0",
    };
    expect(() => validateBudgetPolicy(testBudgetPolicy({ cost_ceilings: [ceiling] }))).toThrow(
      BudgetValidationError,
    );
    expect(() =>
      validateBudgetPolicy(
        testBudgetPolicy({
          cost_ceilings: [
            { ...ceiling, amount_per_1000_tokens: "1" },
            { ...ceiling, amount_per_1000_tokens: "2" },
          ],
        }),
      ),
    ).toThrow(BudgetValidationError);
  });

  test("refuses a policy with no limits at all", () => {
    expect(() =>
      validateBudgetPolicy(
        testBudgetPolicy({
          enterprise: { monetary: [], tokens: null },
          workspace: { monetary: [], tokens: null },
          run: null,
          cost_ceilings: [
            { endpoint_id: null, model_id: null, currency: "USD", amount_per_1000_tokens: "1" },
          ],
        }),
      ),
    ).toThrow(BudgetValidationError);
  });

  test("a static resolver serves only its configured scope", async () => {
    const resolver = createStaticBudgetPolicyResolver(testBudgetPolicy(), BUDGET_SCOPE);
    const resolved = await resolver.resolve(BUDGET_SCOPE);
    expect(resolved?.revision).toBe("budget-policy-1");
    expect(
      await resolver.resolve({ enterpriseId: "ent_other", workspaceId: "ws_test" }),
    ).toBeUndefined();
    expect(
      await resolver.resolve({ enterpriseId: "ent_test", workspaceId: "ws_other" }),
    ).toBeUndefined();
  });

  test("loads and validates a policy file, refusing a malformed one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-policy-"));
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify(testBudgetPolicy()));
    const resolver = loadBudgetPolicyFile(good, BUDGET_SCOPE);
    const loaded = await resolver.resolve(BUDGET_SCOPE);
    expect(loaded?.revision).toBe("budget-policy-1");

    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ revision: "broken" }));
    expect(() => loadBudgetPolicyFile(bad, BUDGET_SCOPE)).toThrow(BudgetValidationError);
  });
});
