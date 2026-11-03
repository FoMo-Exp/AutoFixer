/**
 * Immutable rate cards, cost postings, adjustments and FX quotes (DAT-228,
 * ADR-0008 "Invocation ledger, rate cards, and budgets").
 *
 * The record classes of the cost domain:
 *
 * - A `RateCardRevision` is an immutable, effective-dated price: endpoint/
 *   model scope, currency, category, unit, source and applicable time. New
 *   revisions never rewrite old ones; later configuration never silently
 *   reprices history.
 * - A `CostPosting` prices one invocation attempt (or one measured
 *   infrastructure charge) and snapshots the exact rate revision bound per
 *   category. It is computed once and stays as written.
 * - An `AdjustmentEntry` is a linked correction — a provider correction posts
 *   a new entry pointing at the original posting; it never overwrites it.
 * - An `FxQuote` is a versioned conversion rate with an explicit source and
 *   time. Currencies are never merged without one.
 *
 * Honesty rules enforced across the domain:
 * - Unknown usage or an unknown rate yields an unknown cost component
 *   (`cost: null`), never a zero. A model without a rate keeps an unknown
 *   component; it never defaults to a zero rate.
 * - Estimated figures are labeled `estimated` and are never presented as an
 *   invoiced amount. Nothing in this domain produces invoiced amounts at all.
 * - Amounts are fixed-precision scaled integers (see `money.ts`); no floats.
 * - Cross-currency totals stay separated per currency unless an explicit
 *   versioned FX source and time is supplied.
 */

/** Schema version of every cost-domain record. */
export const COST_SCHEMA_VERSION = 1;

/** Categories priced on their own chargeable line. */
export const TOKEN_COST_CATEGORIES = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
] as const;

export type TokenCostCategory = (typeof TOKEN_COST_CATEGORIES)[number];

/**
 * Measured infrastructure of self-hosted execution. Kept strictly separate
 * from token cost: token cost is never presented as total worker cost.
 */
export const INFRASTRUCTURE_CATEGORY = "infrastructure";

export type CostCategory = TokenCostCategory | typeof INFRASTRUCTURE_CATEGORY;

export const COST_CATEGORIES: readonly CostCategory[] = [
  ...TOKEN_COST_CATEGORIES,
  INFRASTRUCTURE_CATEGORY,
];

/**
 * Units a rate is metered in. Token categories are always priced per token
 * count; infrastructure is priced in explicit non-token units.
 */
export type RateUnit = "tokens" | "requests" | "seconds" | "core_seconds" | "gpu_seconds" | "bytes";

export const RATE_UNITS: readonly RateUnit[] = [
  "tokens",
  "requests",
  "seconds",
  "core_seconds",
  "gpu_seconds",
  "bytes",
];

/** Where a rate comes from. Allocation rates for self-hosted usage are administrator-assigned. */
export type RateSource = "provider_list" | "contract" | "administrator" | "measured";

export const RATE_SOURCES: readonly RateSource[] = [
  "provider_list",
  "contract",
  "administrator",
  "measured",
];

/**
 * What the rate prices: metered provider invocations, or self-hosted usage
 * (administrator-assigned allocation rates and measured infrastructure).
 */
export type RateTarget = "provider" | "self_hosted";

/** Completeness of a usage figure or a derived cost figure. */
export type CostCompleteness = "known" | "estimated" | "unknown";

/** Which cost class a component belongs to; classes are never silently merged. */
export type CostClass = "provider_tokens" | "self_hosted_tokens" | "infrastructure";

export const COST_CLASSES: readonly CostClass[] = [
  "provider_tokens",
  "self_hosted_tokens",
  "infrastructure",
];

/** Why a chargeable component could not be priced. */
export type CostUnknownReason =
  /** The usage figure was never reported. */
  | "usage_unknown"
  /** No rate revision covers this scope/category/time at all. */
  | "rate_unknown"
  /** Rates exist for the scope but none in the currency the invocation was metered in. */
  | "currency_mismatch"
  /** The invocation declares no currency and more than one candidate currency exists. */
  | "currency_ambiguous";

/**
 * One immutable, effective-dated price. `rate` is a fixed-precision decimal
 * per `divisor` chargeable `unit`s (e.g. rate per 1000 tokens has
 * `divisor: 1000`). The effective window is half-open: a revision applies
 * when `effective_from <= t < effective_to`; `null` effective_to is open-ended.
 */
export interface RateCardRevision {
  schema_version: number;
  revision_id: string;
  enterprise_id: string;
  workspace_id: string;
  target: RateTarget;
  /** Endpoint scope; null matches any endpoint. */
  endpoint_id: string | null;
  /** Model scope; null matches any model. */
  model_id: string | null;
  category: CostCategory;
  unit: RateUnit;
  /** ISO 4217 currency the rate is expressed in. */
  currency: string;
  /** Chargeable units per rate application; positive integer. */
  divisor: number;
  /** Canonical fixed-precision decimal, strictly positive. */
  rate: string;
  source: RateSource;
  effective_from: string;
  effective_to: string | null;
  /** Store-stamped time this revision was recorded. */
  recorded_at: string;
  note: string | null;
}

/** Writer-owned fields of a rate revision; `recorded_at` is store-stamped. */
export type RateCardRevisionInput = Omit<RateCardRevision, "schema_version" | "recorded_at">;

/** One priced category line of a posting. */
export interface CostComponent {
  category: CostCategory;
  /**
   * False for categories whose units are already inside another category's
   * figure (`included_in`): they are recorded for reconciliation but never
   * charged again.
   */
  chargeable: boolean;
  /** Included-category relation exactly as the usage record reported it. */
  included_in: TokenCostCategory | null;
  /** Chargeable units priced; null when usage was never reported. */
  chargeable_units: number | null;
  unit: RateUnit;
  cost_class: CostClass;
  /** Currency of `cost`; null while the component is unpriced. */
  currency: string | null;
  /** Snapshot of the rate revision bound at pricing time; null when unpriced. */
  rate_revision_id: string | null;
  /** Snapshot of the bound revision's rate value (canonical decimal); null when unpriced. */
  rate: string | null;
  /** Snapshot of the bound revision's divisor; null when unpriced. */
  divisor: number | null;
  /**
   * Fixed-precision amount (canonical decimal). `null` means unknown — never
   * a stand-in zero.
   */
  cost: string | null;
  completeness: CostCompleteness;
  unknown_reason: CostUnknownReason | null;
}

/**
 * The priced record of one invocation attempt or one infrastructure charge.
 * Immutable once recorded: a rate change later never rewrites it.
 */
export interface CostPosting {
  schema_version: number;
  /** Deterministic identity; the idempotency key of the posting. */
  posting_id: string;
  enterprise_id: string;
  workspace_id: string;
  kind: "invocation" | "infrastructure";
  /** Ledger join key for invocation postings; null for infrastructure. */
  invocation_id: string | null;
  attempt: number | null;
  target: RateTarget;
  endpoint_id: string | null;
  /** Effective model (returned model when exposed, else the requested model). */
  model_id: string | null;
  requested_model: string | null;
  returned_model: string | null;
  /** The applicable time rate binding used (the attempt's start). */
  applicable_time: string;
  /**
   * Single currency when every priced component shares one; null when the
   * posting mixes currencies or holds no priced component. Mixed postings are
   * never merged into one amount.
   */
  currency: string | null;
  /**
   * Rollup of component completeness: `known` when every chargeable component
   * is priced from known usage, `estimated` when any priced component derives
   * from estimated usage, `unknown` when any chargeable component is unpriced.
   */
  completeness: CostCompleteness;
  components: CostComponent[];
  /** Store-stamped time this posting was recorded. */
  recorded_at: string;
}

/** One corrected category line of an adjustment. */
export interface AdjustmentComponent {
  category: CostCategory;
  /**
   * How the corrected figure reads: `known`/`estimated` restate it,
   * `unknown` voids it back to unknown — never a zeroed charge.
   */
  completeness: CostCompleteness;
  /**
   * Recompute path: replacement chargeable units (null keeps the posting's
   * units). Recomputation uses the posting's bound rate snapshot unless
   * `corrected_rate_revision_id` rebinds it.
   */
  corrected_units: number | null;
  /** Rebind the recompute to another recorded rate revision; null keeps the snapshot. */
  corrected_rate_revision_id: string | null;
  /**
   * Explicit replacement amount. When set it supersedes the units/recompute
   * path and must carry its currency.
   */
  corrected_cost: string | null;
  /** Currency of `corrected_cost`; non-null exactly when `corrected_cost` is. */
  corrected_currency: string | null;
  note: string | null;
}

/**
 * A linked correction. Corrections append; the original posting keeps every
 * figure it was written with, so the trail from posting to final net amount
 * is fully replayable.
 */
export interface AdjustmentEntry {
  schema_version: number;
  adjustment_id: string;
  enterprise_id: string;
  workspace_id: string;
  target_posting_id: string;
  reason: "provider_correction" | "administrator_correction";
  /** Who asserts the correction. */
  source: "provider" | "administrator";
  created_at: string;
  note: string | null;
  components: AdjustmentComponent[];
}

export type AdjustmentInput = Omit<AdjustmentEntry, "schema_version" | "created_at">;

/**
 * A versioned FX conversion rate. Cross-currency merging requires an explicit
 * source and time; quotes are immutable records, so a conversion can always
 * name exactly which quote produced it.
 */
export interface FxQuote {
  schema_version: number;
  quote_id: string;
  enterprise_id: string;
  workspace_id: string;
  /** Versioned FX source identity (e.g. "ecb-daily"). */
  source: string;
  /** Version of that source's snapshot. */
  source_revision: string;
  /** The explicit time the quote speaks for. */
  quoted_at: string;
  base_currency: string;
  quote_currency: string;
  /** Canonical fixed-precision decimal, strictly positive: 1 base = rate quote. */
  rate: string;
  recorded_at: string;
}

export type FxQuoteInput = Omit<FxQuote, "schema_version" | "recorded_at">;

/**
 * The usage shape the pricing engine consumes. Structurally satisfied by the
 * invocation usage ledger's records: every figure carries its own inclusion
 * relation and completeness, so included categories are never double-charged
 * and missing usage is never read as zero.
 */
export interface CostableUsageFigure {
  tokens: number | null;
  completeness: CostCompleteness;
  included_in: TokenCostCategory | null;
}

export interface CostableInvocation {
  enterprise_id: string;
  workspace_id: string;
  invocation_id: string;
  /** 1-based attempt number within the dispatch call. */
  attempt: number;
  endpoint_id: string;
  provider: string;
  requested_model: string;
  returned_model: string | null;
  /** Self-hosted execution: priced only by administrator allocation rates. */
  internal: boolean;
  /** Attempt start; the applicable time for rate binding. */
  started_at: string;
  ended_at: string;
  metering: {
    unit: string;
    /** Currency the provider meters in; null when the provider exposes none. */
    currency: string | null;
  };
  usage: {
    input: CostableUsageFigure;
    output: CostableUsageFigure;
    cache_read: CostableUsageFigure;
    cache_write: CostableUsageFigure;
    reasoning: CostableUsageFigure;
    completeness: CostCompleteness;
  };
}

/** A measured (or administrator-entered) self-hosted infrastructure charge. */
export interface InfrastructureCostInput {
  enterprise_id: string;
  workspace_id: string;
  /** Idempotency key of the charge, stable across redeliveries. */
  entry_key: string;
  endpoint_id: string | null;
  model_id: string | null;
  unit: Exclude<RateUnit, "tokens">;
  /** Chargeable units measured; null records the charge as unknown. */
  chargeable_units: number | null;
  /** Completeness of the measured units; unknown units ignore the value. */
  completeness: Extract<CostCompleteness, "known" | "estimated">;
  currency: string | null;
  /** The time the charge applies to. */
  applicable_time: string;
}

/** Per (currency, cost class) totals; classes and currencies are never merged. */
export interface CostClassTotals {
  currency: string | null;
  cost_class: CostClass;
  /** Sum of components priced from known usage (canonical decimal). */
  known_cost: string;
  /** Sum of components priced from estimated usage — provisional, never invoiced. */
  estimated_cost: string;
  unknown_components: number;
  components: number;
  postings: number;
}

export interface CostSummary {
  lines: CostClassTotals[];
}

/** One priced posting with the adjustments linked to it. */
export interface CostLedgerEntry {
  posting: CostPosting;
  adjustments: AdjustmentEntry[];
}
