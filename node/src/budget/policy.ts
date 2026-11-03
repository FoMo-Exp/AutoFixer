/**
 * Budget policy resolution and validation (DAT-229).
 *
 * The policy is configuration, never caller input: the gateway asks the
 * resolver for the policy of the authenticated enterprise/workspace scope and
 * denies when none resolves. A malformed policy fails at startup instead of
 * at the first dispatch, and the token-only exception must be stated
 * explicitly — a monetary limit is never silently reinterpreted.
 */
import fs from "node:fs";

import { assertCurrency, formatAmount, normalizeCurrencyAmounts, parseAmount } from "./amount.js";
import { BudgetValidationError } from "./errors.js";
import type {
  BudgetCostCeiling,
  BudgetLimits,
  BudgetPolicy,
  BudgetPolicyResolver,
  BudgetScope,
} from "./types.js";

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BudgetValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BudgetValidationError(`${label} must be a positive integer`);
  }
  return value;
}

export function validateBudgetLimits(raw: unknown, label: string): BudgetLimits {
  const entry = requireObject(raw, label);
  const monetaryRaw = entry["monetary"];
  if (!Array.isArray(monetaryRaw)) {
    throw new BudgetValidationError(`${label}.monetary must be an array (empty for token-only)`);
  }
  const monetary = normalizeCurrencyAmounts(
    monetaryRaw.map((amount, index) => {
      const amountEntry = requireObject(amount, `${label}.monetary[${index}]`);
      return {
        currency: requireString(amountEntry["currency"], `${label}.monetary[${index}].currency`),
        amount: requireString(amountEntry["amount"], `${label}.monetary[${index}].amount`),
      };
    }),
    `${label}.monetary`,
  );
  for (const [index, amount] of monetary.entries()) {
    if (parseAmount(amount.amount) <= 0n) {
      throw new BudgetValidationError(`${label}.monetary[${index}].amount must be positive`);
    }
  }
  const tokensRaw = entry["tokens"];
  let tokens: number | null = null;
  if (tokensRaw !== null && tokensRaw !== undefined) {
    tokens = requirePositiveInteger(tokensRaw, `${label}.tokens`);
  }
  return { monetary, tokens };
}

function validateCeiling(raw: unknown, label: string): BudgetCostCeiling {
  const entry = requireObject(raw, label);
  const endpointId = entry["endpoint_id"];
  const modelId = entry["model_id"];
  if (endpointId !== null && typeof endpointId !== "string") {
    throw new BudgetValidationError(`${label}.endpoint_id must be a string or null`);
  }
  if (modelId !== null && typeof modelId !== "string") {
    throw new BudgetValidationError(`${label}.model_id must be a string or null`);
  }
  const currency = assertCurrency(entry["currency"], `${label}.currency`);
  const rate = formatAmount(
    parseAmount(
      requireString(entry["amount_per_1000_tokens"], `${label}.amount_per_1000_tokens`),
      `${label}.amount_per_1000_tokens`,
    ),
  );
  if (parseAmount(rate) <= 0n) {
    throw new BudgetValidationError(`${label}.amount_per_1000_tokens must be positive`);
  }
  return {
    endpoint_id: endpointId === null ? null : requireString(endpointId, `${label}.endpoint_id`),
    model_id: modelId === null ? null : requireString(modelId, `${label}.model_id`),
    currency,
    amount_per_1000_tokens: rate,
  };
}

function hasAnyLimit(limits: BudgetLimits | null): boolean {
  return limits !== null && (limits.tokens !== null || limits.monetary.length > 0);
}

/**
 * Parse and validate a budget policy. Anything ambiguous or contradictory is
 * rejected: a zero/negative ceiling, a duplicate ceiling, a token-only flag
 * next to monetary caps, or a monetary policy with no conservative ceiling.
 */
export function validateBudgetPolicy(raw: unknown): BudgetPolicy {
  const entry = requireObject(raw, "budget policy");
  const revision = requireString(entry["revision"], "budget policy revision");
  const enterprise = validateBudgetLimits(entry["enterprise"], "budget policy enterprise");
  const workspace = validateBudgetLimits(entry["workspace"], "budget policy workspace");
  const runRaw = entry["run"];
  const run =
    runRaw === undefined || runRaw === null
      ? null
      : validateBudgetLimits(runRaw, "budget policy run");

  const tokenOnlyRaw = entry["token_only"];
  let tokenOnly: BudgetPolicy["token_only"] = null;
  if (tokenOnlyRaw !== undefined && tokenOnlyRaw !== null) {
    const tokenOnlyEntry = requireObject(tokenOnlyRaw, "budget policy token_only");
    if (tokenOnlyEntry["enabled"] !== true) {
      throw new BudgetValidationError("budget policy token_only.enabled must be true when present");
    }
    tokenOnly = {
      enabled: true,
      reason: requireString(tokenOnlyEntry["reason"], "budget policy token_only.reason"),
    };
  }

  const ceilingsRaw = entry["cost_ceilings"];
  if (ceilingsRaw !== undefined && !Array.isArray(ceilingsRaw)) {
    throw new BudgetValidationError("budget policy cost_ceilings must be an array");
  }
  const costCeilings = (ceilingsRaw ?? []).map((ceiling, index) =>
    validateCeiling(ceiling, `budget policy cost_ceilings[${index}]`),
  );
  const ceilingKeys = new Set<string>();
  for (const ceiling of costCeilings) {
    const key = JSON.stringify([ceiling.endpoint_id, ceiling.model_id, ceiling.currency]);
    if (ceilingKeys.has(key)) {
      throw new BudgetValidationError(`budget policy declares cost ceiling ${key} more than once`);
    }
    ceilingKeys.add(key);
  }

  const anyMonetary =
    enterprise.monetary.length > 0 ||
    workspace.monetary.length > 0 ||
    (run !== null && run.monetary.length > 0);
  if (!hasAnyLimit(enterprise) && !hasAnyLimit(workspace) && !hasAnyLimit(run)) {
    throw new BudgetValidationError("budget policy must declare at least one limit");
  }
  if (tokenOnly !== null) {
    if (anyMonetary) {
      throw new BudgetValidationError(
        "a token-only budget policy must not declare monetary limits",
      );
    }
    if (costCeilings.length > 0) {
      throw new BudgetValidationError(
        "a token-only budget policy must not declare monetary cost ceilings",
      );
    }
  } else {
    if (!anyMonetary) {
      throw new BudgetValidationError(
        "a budget policy without an explicit token_only mode must declare a monetary limit",
      );
    }
    if (costCeilings.length === 0) {
      throw new BudgetValidationError(
        "a monetary budget policy must declare conservative cost ceilings",
      );
    }
  }

  const ceilingTokensRaw = entry["max_tokens_per_invocation"];
  const maxTokensPerInvocation =
    ceilingTokensRaw === undefined || ceilingTokensRaw === null
      ? null
      : requirePositiveInteger(ceilingTokensRaw, "budget policy max_tokens_per_invocation");

  return {
    revision,
    enterprise,
    workspace,
    run,
    max_tokens_per_invocation: maxTokensPerInvocation,
    token_only: tokenOnly,
    cost_ceilings: costCeilings,
  };
}

/** Serve one validated policy for exactly one authenticated scope. */
export function createStaticBudgetPolicyResolver(
  policy: BudgetPolicy,
  scope: BudgetScope,
): BudgetPolicyResolver {
  const frozen = validateBudgetPolicy(policy);
  return {
    resolve(requested: BudgetScope): BudgetPolicy | undefined {
      return requested.enterpriseId === scope.enterpriseId &&
        requested.workspaceId === scope.workspaceId
        ? frozen
        : undefined;
    },
  };
}

/** Fail-closed default: no policy resolves, so no invocation is admitted. */
export const denyAllBudgetPolicyResolver: BudgetPolicyResolver = {
  resolve(): BudgetPolicy | undefined {
    return undefined;
  },
};

/** Load, validate, and scope-bind a budget policy JSON file. */
export function loadBudgetPolicyFile(file: string, scope: BudgetScope): BudgetPolicyResolver {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return createStaticBudgetPolicyResolver(validateBudgetPolicy(parsed), scope);
}
