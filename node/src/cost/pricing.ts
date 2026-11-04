/**
 * Per-category cost computation and posting construction (DAT-228, ADR-0008
 * "Compute cost per category as chargeable units times its bound rate and
 * unit divisor").
 *
 * Pricing is computed exactly once per invocation attempt (or infrastructure
 * charge) and snapshots the bound rate revision per category on the posting:
 * later rate configuration never reprices a recorded posting. Recomputation
 * with a changed rate card produces a NEW posting for a new charge — history
 * keeps what it was written with.
 *
 * Honesty rules:
 * - A category whose usage figure is missing is an unknown component
 *   (`cost: null`), never a zero. A category with no rate revision is unknown
 *   the same way — unpriced models never default to a zero rate.
 * - Categories the provider already counts inside another figure
 *   (`included_in`) are recorded but never charged again.
 * - Estimated usage yields an estimated component; posting rollup keeps
 *   known, estimated and unknown distinguishable. Nothing here produces an
 *   invoiced amount: a posting is always provisional cost evidence.
 */
import { CostValidationError } from "./errors.js";
import { assertCanonicalAmount, computeChargeScaled, formatAmount, parseAmount } from "./money.js";
import { bindRate, type RateBindingContext } from "./rate-card.js";
import {
  COST_CATEGORIES,
  COST_SCHEMA_VERSION,
  INFRASTRUCTURE_CATEGORY,
  RATE_UNITS,
  TOKEN_COST_CATEGORIES,
  type CostClass,
  type CostCategory,
  type CostComponent,
  type CostCompleteness,
  type CostPosting,
  type CostableInvocation,
  type CostableUsageFigure,
  type InfrastructureCostInput,
  type RateCardRevision,
  type RateTarget,
  type RateUnit,
  type TokenCostCategory,
} from "./types.js";
import {
  asCurrency,
  asNonEmptyString,
  asNullableString,
  asOneOf,
  asPositiveInteger,
  asRecord,
  asTimestamp,
  asUnitCount,
} from "./validate.js";

/**
 * The cost class of a charge: provider-metered tokens, self-hosted tokens
 * priced by administrator allocation rates, or measured infrastructure. The
 * classes are kept apart everywhere — token cost is never total worker cost.
 */
function costClassOf(target: RateTarget, category: string): CostClass {
  if (category === INFRASTRUCTURE_CATEGORY) {
    return "infrastructure";
  }
  return target === "self_hosted" ? "self_hosted_tokens" : "provider_tokens";
}

/** Line identity of an invocation posting: one ledger join key per attempt. */
function invocationPostingId(invocationId: string, attempt: number): string {
  return `cost-inv:${invocationId}:${attempt}`;
}

export function rollupCompleteness(components: readonly CostComponent[]): CostCompleteness {
  if (
    components.some((component) => component.chargeable && component.completeness === "unknown")
  ) {
    return "unknown";
  }
  if (components.some((component) => component.completeness === "estimated")) {
    return "estimated";
  }
  return "known";
}

/**
 * The single currency of a posting, or null when priced components disagree.
 * Mixed postings are never merged into one amount.
 */
export function postingCurrency(components: readonly CostComponent[]): string | null {
  const currencies = new Set(
    components
      .map((component) => component.currency)
      .filter((currency): currency is string => currency !== null),
  );
  if (currencies.size === 1) {
    return [...currencies][0] as string;
  }
  return null;
}

interface PricedCharge {
  category: CostCategory;
  unit: RateUnit;
  chargeable: boolean;
  included_in: TokenCostCategory | null;
  chargeable_units: number | null;
  figure_completeness: CostCompleteness;
}

/**
 * Price one charge against the recorded revisions, snapshotting the bound
 * revision. Usage and rate are both required for a priced component; either
 * missing keeps the component unknown with its reason.
 */
function priceCharge(
  charge: PricedCharge,
  context: Omit<RateBindingContext, "category" | "unit">,
  revisions: readonly RateCardRevision[],
): CostComponent {
  const base = {
    category: charge.category,
    chargeable: charge.chargeable,
    included_in: charge.included_in,
    chargeable_units: charge.chargeable_units,
    unit: charge.unit,
    cost_class: costClassOf(context.target, charge.category),
    currency: null,
    rate_revision_id: null,
    rate: null,
    divisor: null,
    cost: null,
  };
  if (!charge.chargeable) {
    // Included in another category's figure: recorded for reconciliation,
    // never charged again — and never a zero-charge pretense.
    return { ...base, completeness: "known", unknown_reason: null };
  }
  const binding = bindRate(revisions, {
    ...context,
    category: charge.category,
    unit: charge.unit,
  });
  const bound = binding.status === "bound" ? binding.revision : null;
  const snapshot = {
    currency: bound?.currency ?? null,
    rate_revision_id: bound?.revision_id ?? null,
    rate: bound?.rate ?? null,
    divisor: bound?.divisor ?? null,
  };
  if (charge.chargeable_units === null) {
    // Missing usage is unknown, never zero. The rate snapshot is still
    // recorded so reconciled usage can be priced later without repricing.
    return {
      ...base,
      ...snapshot,
      completeness: "unknown",
      unknown_reason: "usage_unknown",
    };
  }
  if (binding.status === "unbound") {
    return {
      ...base,
      completeness: "unknown",
      unknown_reason: binding.reason,
    };
  }
  const revision = binding.revision;
  const scaled = computeChargeScaled(
    charge.chargeable_units,
    parseAmount(revision.rate),
    revision.divisor,
  );
  return {
    ...base,
    currency: revision.currency,
    rate_revision_id: revision.revision_id,
    rate: revision.rate,
    divisor: revision.divisor,
    cost: formatAmount(scaled),
    completeness: charge.figure_completeness,
    unknown_reason: null,
  };
}

function validateCostableInvocation(value: unknown): CostableInvocation {
  const record = asRecord(value, "invocation");
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  asNonEmptyString(record["invocation_id"], "invocation_id");
  asPositiveInteger(record["attempt"], "attempt");
  asNonEmptyString(record["endpoint_id"], "endpoint_id");
  asNonEmptyString(record["provider"], "provider");
  asNonEmptyString(record["requested_model"], "requested_model");
  asNullableString(record["returned_model"], "returned_model");
  if (typeof record["internal"] !== "boolean") {
    throw new CostValidationError('cost field "internal" must be a boolean');
  }
  asTimestamp(record["started_at"], "started_at");
  asTimestamp(record["ended_at"], "ended_at");
  const metering = asRecord(record["metering"], "metering");
  const unit = asNonEmptyString(metering["unit"], "metering.unit");
  if (unit !== "tokens") {
    throw new CostValidationError(
      'invocation metering is priced per token; metering.unit must be "tokens"',
    );
  }
  const meteringCurrency = metering["currency"];
  if (meteringCurrency !== null) {
    asCurrency(meteringCurrency, "metering.currency");
  }
  const usage = asRecord(record["usage"], "usage");
  for (const category of TOKEN_COST_CATEGORIES) {
    const figure = asRecord(usage[category], `usage.${category}`);
    const tokens = figure["tokens"];
    if (tokens !== null) {
      asUnitCount(tokens, `usage.${category}.tokens`);
    }
    const completeness = asOneOf(
      figure["completeness"],
      ["known", "estimated", "unknown"] as const,
      `usage.${category}.completeness`,
    );
    if (tokens === null && completeness !== "unknown") {
      throw new CostValidationError(
        `usage.${category} has no figure and must be complete "unknown", never a stand-in value`,
      );
    }
    if (tokens !== null && completeness === "unknown") {
      throw new CostValidationError(
        `usage.${category} reports a figure and cannot be complete "unknown"`,
      );
    }
    const includedIn = figure["included_in"];
    if (includedIn !== null) {
      asOneOf(includedIn, TOKEN_COST_CATEGORIES, `usage.${category}.included_in`);
    }
  }
  asOneOf(usage["completeness"], ["known", "estimated", "unknown"] as const, "usage.completeness");
  return value as CostableInvocation;
}

/**
 * Price one invocation attempt into an immutable posting. Every token
 * category is priced or explicitly kept unknown; included categories are
 * recorded but not charged.
 */
export function computeInvocationCost(
  invocation: CostableInvocation,
  revisions: readonly RateCardRevision[],
  recordedAt: string,
): CostPosting {
  const record = validateCostableInvocation(invocation);
  const target: RateTarget = record.internal ? "self_hosted" : "provider";
  const modelId = record.returned_model ?? record.requested_model;
  const context = {
    target,
    endpoint_id: record.endpoint_id,
    model_id: modelId,
    currency: record.metering.currency,
    at: record.started_at,
  };
  const charges: PricedCharge[] = TOKEN_COST_CATEGORIES.map((category) => {
    const figure: CostableUsageFigure = record.usage[category];
    return {
      category,
      unit: "tokens",
      chargeable: figure.included_in === null,
      included_in: figure.included_in,
      chargeable_units: figure.tokens,
      figure_completeness: figure.tokens === null ? "unknown" : figure.completeness,
    };
  });
  const components = charges.map((charge) => priceCharge(charge, context, revisions));
  return {
    schema_version: COST_SCHEMA_VERSION,
    posting_id: invocationPostingId(record.invocation_id, record.attempt),
    enterprise_id: record.enterprise_id,
    workspace_id: record.workspace_id,
    kind: "invocation",
    invocation_id: record.invocation_id,
    attempt: record.attempt,
    target,
    endpoint_id: record.endpoint_id,
    model_id: modelId,
    requested_model: record.requested_model,
    returned_model: record.returned_model,
    applicable_time: record.started_at,
    currency: postingCurrency(components),
    completeness: rollupCompleteness(components),
    components,
    recorded_at: recordedAt,
  };
}

/**
 * Price one measured (or administrator-entered) self-hosted infrastructure
 * charge. Infrastructure cost stays its own class: it is never folded into
 * token cost and token cost is never presented as total worker cost.
 */
export function computeInfrastructureCost(
  input: InfrastructureCostInput,
  revisions: readonly RateCardRevision[],
  recordedAt: string,
): CostPosting {
  const charge: PricedCharge = {
    category: INFRASTRUCTURE_CATEGORY,
    unit: input.unit,
    chargeable: true,
    included_in: null,
    chargeable_units: input.chargeable_units,
    figure_completeness: input.chargeable_units === null ? "unknown" : input.completeness,
  };
  const context = {
    target: "self_hosted" as RateTarget,
    endpoint_id: input.endpoint_id,
    model_id: input.model_id,
    currency: input.currency,
    at: input.applicable_time,
  };
  const components = [priceCharge(charge, context, revisions)];
  return {
    schema_version: COST_SCHEMA_VERSION,
    posting_id: `cost-infra:${input.entry_key}`,
    enterprise_id: input.enterprise_id,
    workspace_id: input.workspace_id,
    kind: "infrastructure",
    invocation_id: null,
    attempt: null,
    target: "self_hosted",
    endpoint_id: input.endpoint_id,
    model_id: input.model_id,
    requested_model: null,
    returned_model: null,
    applicable_time: input.applicable_time,
    currency: postingCurrency(components),
    completeness: rollupCompleteness(components),
    components,
    recorded_at: recordedAt,
  };
}

/**
 * Validate one fully-shaped current-version posting. Used on store loads so a
 * persisted posting is exactly as trustworthy as a freshly computed one.
 */
export function validateCostPosting(value: unknown): CostPosting {
  const record = asRecord(value, "posting");
  const version = record["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CostValidationError(`cost field "schema_version" must be an integer`);
  }
  if (version > COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost posting schema ${version} is newer than ${COST_SCHEMA_VERSION}`,
    );
  }
  if (version !== COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost posting schema ${version} must be migrated to ${COST_SCHEMA_VERSION} first`,
    );
  }
  asNonEmptyString(record["posting_id"], "posting_id");
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  asOneOf(record["kind"], ["invocation", "infrastructure"] as const, "kind");
  asNullableString(record["invocation_id"], "invocation_id");
  const attempt = record["attempt"];
  if (attempt !== null) {
    asPositiveInteger(attempt, "attempt");
  }
  asOneOf(record["target"], ["provider", "self_hosted"] as const, "target");
  asNullableString(record["endpoint_id"], "endpoint_id");
  asNullableString(record["model_id"], "model_id");
  asNullableString(record["requested_model"], "requested_model");
  asNullableString(record["returned_model"], "returned_model");
  asTimestamp(record["applicable_time"], "applicable_time");
  const currency = record["currency"];
  if (currency !== null) {
    asCurrency(currency, "currency");
  }
  asOneOf(record["completeness"], ["known", "estimated", "unknown"] as const, "completeness");
  const components = record["components"];
  if (!Array.isArray(components) || components.length === 0) {
    throw new CostValidationError('cost field "components" must be a non-empty array');
  }
  for (const component of components) {
    validateCostComponent(component);
  }
  asTimestamp(record["recorded_at"], "recorded_at");
  return value as CostPosting;
}

function validateCostComponent(value: unknown): void {
  const record = asRecord(value, "component");
  const category = asOneOf(record["category"], COST_CATEGORIES, "component.category");
  if (typeof record["chargeable"] !== "boolean") {
    throw new CostValidationError('cost field "component.chargeable" must be a boolean');
  }
  const includedIn = record["included_in"];
  if (includedIn !== null) {
    asOneOf(includedIn, TOKEN_COST_CATEGORIES, "component.included_in");
  }
  const units = record["chargeable_units"];
  if (units !== null) {
    asUnitCount(units, "component.chargeable_units");
  }
  const unit = asOneOf(record["unit"], RATE_UNITS, "component.unit");
  if (category === INFRASTRUCTURE_CATEGORY && unit === "tokens") {
    throw new CostValidationError(
      "infrastructure components are metered in explicit non-token units",
    );
  }
  if (category !== INFRASTRUCTURE_CATEGORY && unit !== "tokens") {
    throw new CostValidationError(`component category ${category} is metered in tokens`);
  }
  asOneOf(
    record["cost_class"],
    ["provider_tokens", "self_hosted_tokens", "infrastructure"] as const,
    "component.cost_class",
  );
  const currency = record["currency"];
  if (currency !== null) {
    asCurrency(currency, "component.currency");
  }
  asNullableString(record["rate_revision_id"], "component.rate_revision_id");
  const rate = record["rate"];
  if (rate !== null) {
    assertCanonicalAmount(asNonEmptyString(rate, "component.rate"), "component.rate");
  }
  const divisor = record["divisor"];
  if (divisor !== null) {
    asPositiveInteger(divisor, "component.divisor");
  }
  const cost = record["cost"];
  if (cost !== null) {
    assertCanonicalAmount(asNonEmptyString(cost, "component.cost"), "component.cost");
  }
  asOneOf(
    record["completeness"],
    ["known", "estimated", "unknown"] as const,
    "component.completeness",
  );
  const unknownReason = record["unknown_reason"];
  if (unknownReason !== null) {
    asOneOf(
      unknownReason,
      ["usage_unknown", "rate_unknown", "currency_mismatch", "currency_ambiguous"] as const,
      "component.unknown_reason",
    );
  }
  if (category === INFRASTRUCTURE_CATEGORY && record["cost_class"] !== "infrastructure") {
    throw new CostValidationError(
      'infrastructure components must carry cost_class "infrastructure"',
    );
  }
}
