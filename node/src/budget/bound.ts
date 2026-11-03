/**
 * Conservative reservation bounds (DAT-229).
 *
 * Before dispatch the authority must know the largest amount this attempt may
 * consume. The token bound comes from the caller (input context plus output
 * ceiling); the monetary bound comes from the policy's conservative internal
 * cost ceilings. A monetary limit with no finite safe bound is denied, or the
 * deployment must explicitly configure a bounded token-only policy — cost is
 * never assumed to be zero.
 *
 * The bound is deliberately conservative: every matching ceiling in a
 * currency is considered and the highest one is used, so an extra generic
 * ceiling can only make the reservation larger.
 */
import {
  ceilDiv,
  compareAmounts,
  formatAmount,
  normalizeCurrencyAmounts,
  parseAmount,
  type CurrencyAmount,
} from "./amount.js";
import type {
  BudgetCostCeiling,
  BudgetDenyReason,
  BudgetPolicy,
  BudgetReserveRequest,
} from "./types.js";

export interface BudgetBound {
  token_bound: number;
  monetary_bound: CurrencyAmount[];
  /** Bound rate per currency, snapshotted for settlement estimates. */
  cost_ceilings: { currency: string; amount_per_1000_tokens: string }[];
}

export type BudgetBoundResult =
  | { status: "bounded"; bound: BudgetBound }
  | { status: "denied"; reason: BudgetDenyReason; detail: string };

function monetaryCapCurrencies(policy: BudgetPolicy): string[] {
  const currencies = new Set<string>();
  for (const limits of [policy.enterprise, policy.workspace, policy.run]) {
    if (!limits) continue;
    for (const cap of limits.monetary) {
      currencies.add(cap.currency);
    }
  }
  return [...currencies].sort();
}

function applies(ceiling: BudgetCostCeiling, endpointId: string, modelId: string): boolean {
  return (
    (ceiling.endpoint_id === null || ceiling.endpoint_id === endpointId) &&
    (ceiling.model_id === null || ceiling.model_id === modelId)
  );
}

/** The highest matching conservative ceiling for one currency, or null. */
function conservativeCeiling(
  policy: BudgetPolicy,
  endpointId: string,
  modelId: string,
  currency: string,
): BudgetCostCeiling | null {
  let selected: BudgetCostCeiling | null = null;
  for (const ceiling of policy.cost_ceilings) {
    if (ceiling.currency !== currency || !applies(ceiling, endpointId, modelId)) {
      continue;
    }
    if (
      selected === null ||
      compareAmounts(
        parseAmount(ceiling.amount_per_1000_tokens),
        parseAmount(selected.amount_per_1000_tokens),
      ) > 0
    ) {
      selected = ceiling;
    }
  }
  return selected;
}

/**
 * Compute the bound this attempt needs. The token ceiling is a hard limit on
 * the conservative bound; it is denied rather than clamped so a run never
 * believes it requested more output than the service will allow.
 */
export function computeBudgetBound(
  policy: BudgetPolicy,
  request: BudgetReserveRequest,
): BudgetBoundResult {
  if (!Number.isSafeInteger(request.token_bound) || request.token_bound <= 0) {
    return {
      status: "denied",
      reason: "BUDGET_BOUND_UNKNOWN",
      detail: "the attempt has no finite positive token bound",
    };
  }
  if (
    policy.max_tokens_per_invocation !== null &&
    request.token_bound > policy.max_tokens_per_invocation
  ) {
    return {
      status: "denied",
      reason: "BUDGET_TOKEN_CEILING_EXCEEDED",
      detail: `the conservative token bound exceeds the per-invocation ceiling (${policy.max_tokens_per_invocation})`,
    };
  }
  if (policy.token_only !== null) {
    return {
      status: "bounded",
      bound: { token_bound: request.token_bound, monetary_bound: [], cost_ceilings: [] },
    };
  }

  const monetary: CurrencyAmount[] = [];
  const snapshots: { currency: string; amount_per_1000_tokens: string }[] = [];
  for (const currency of monetaryCapCurrencies(policy)) {
    const ceiling = conservativeCeiling(policy, request.endpoint_id, request.model_id, currency);
    if (ceiling === null) {
      return {
        status: "denied",
        reason: "BUDGET_BOUND_UNKNOWN",
        detail: `no conservative cost ceiling covers model ${request.model_id} in ${currency}`,
      };
    }
    const rate = parseAmount(ceiling.amount_per_1000_tokens);
    // rate is per 1000 tokens; round the bound up so it can never under-reserve.
    const amount = ceilDiv(BigInt(request.token_bound) * rate, 1000n);
    monetary.push({ currency, amount: formatAmount(amount) });
    snapshots.push({ currency, amount_per_1000_tokens: ceiling.amount_per_1000_tokens });
  }
  return {
    status: "bounded",
    bound: {
      token_bound: request.token_bound,
      monetary_bound: normalizeCurrencyAmounts(monetary, "monetary bound"),
      cost_ceilings: snapshots,
    },
  };
}

/**
 * The monetary part of an observed usage: chargeable tokens priced at the
 * snapshotted conservative ceiling. Always labelled `estimated` by callers —
 * it is an internal bound, never a provider invoice.
 */
export function estimateCostFromCeilings(
  ceilings: readonly { currency: string; amount_per_1000_tokens: string }[],
  tokens: number,
): CurrencyAmount[] {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError("chargeable tokens must be a non-negative safe integer");
  }
  return ceilings
    .map((ceiling) => ({
      currency: ceiling.currency,
      amount: formatAmount(
        ceilDiv(BigInt(tokens) * parseAmount(ceiling.amount_per_1000_tokens), 1000n),
      ),
    }))
    .sort((a, b) => (a.currency < b.currency ? -1 : 1));
}
