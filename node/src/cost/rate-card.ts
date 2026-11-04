/**
 * Immutable effective-dated rate-card revisions and deterministic rate
 * binding (DAT-228, ADR-0008 "Invocation ledger, rate cards, and budgets").
 *
 * A revision is a price for one endpoint/model scope, category, unit and
 * currency that applies over a half-open effective window
 * (`effective_from <= t < effective_to`). Revisions are immutable: a rate
 * change records a NEW revision and history keeps the revision it was priced
 * with.
 *
 * Binding at a time `t` is deterministic:
 * 1. Scope: a revision matches when its endpoint and model scope are equal to
 *    the context or wildcard (`null`).
 * 2. Specificity beats recency: a model-scoped rate always wins over an
 *    endpoint-scoped or wildcard rate, so a blanket revision never silently
 *    reprices a model that carries its own rates.
 * 3. Within one specificity, the revision with the latest `effective_from`
 *    that is still effective at `t` wins. Revisions with the same binding key
 *    and the same `effective_from` are refused at record time, so the winner
 *    is never ambiguous.
 * 4. Currency: a rate only prices a currency it declares. An invocation
 *    metered in currency C binds only C rates; an invocation that declares no
 *    currency binds only when exactly one candidate currency exists.
 *
 * A missing rate is an unknown cost component — new or unpriced models never
 * default to a zero rate.
 */
import { CostValidationError } from "./errors.js";
import { assertCanonicalAmount, formatAmount, parseRateValue } from "./money.js";
import {
  COST_CATEGORIES,
  COST_SCHEMA_VERSION,
  RATE_SOURCES,
  RATE_UNITS,
  type CostCategory,
  type CostUnknownReason,
  type RateCardRevision,
  type RateCardRevisionInput,
  type RateTarget,
  type RateUnit,
} from "./types.js";
import {
  asCurrency,
  asNonEmptyString,
  asNullableString,
  asOneOf,
  asPositiveInteger,
  asRecord,
  asTimestamp,
} from "./validate.js";

const RATE_TARGETS: readonly RateTarget[] = ["provider", "self_hosted"];

/** Categories whose figures are token counts; always priced per token. */
const TOKEN_CATEGORY_TABLE: Record<string, true> = {
  input: true,
  output: true,
  cache_read: true,
  cache_write: true,
  reasoning: true,
};

/**
 * Validate one fully-shaped current-version revision. Returns the input
 * object; a missing field, an unknown enum value, a non-canonical amount, or
 * a zero rate is a control failure, not a defaulted value.
 */
export function validateRateCardRevision(value: unknown): RateCardRevision {
  const record = asRecord(value, "rate revision");
  const version = record["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CostValidationError(`cost field "schema_version" must be an integer`);
  }
  if (version > COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost rate revision schema ${version} is newer than ${COST_SCHEMA_VERSION}`,
    );
  }
  if (version !== COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost rate revision schema ${version} must be migrated to ${COST_SCHEMA_VERSION} first`,
    );
  }
  asNonEmptyString(record["revision_id"], "revision_id");
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  const target = asOneOf(record["target"], RATE_TARGETS, "target");
  asNullableString(record["endpoint_id"], "endpoint_id");
  asNullableString(record["model_id"], "model_id");
  const category = asOneOf(record["category"], COST_CATEGORIES, "category");
  const unit = asOneOf(record["unit"], RATE_UNITS, "unit");
  const isTokenCategory = TOKEN_CATEGORY_TABLE[category] === true;
  if (isTokenCategory && unit !== "tokens") {
    throw new CostValidationError(
      `cost rate revision category ${category} is metered in tokens, got unit ${unit}`,
    );
  }
  if (!isTokenCategory && unit === "tokens") {
    throw new CostValidationError(
      'cost rate revision category "infrastructure" is metered in explicit non-token units',
    );
  }
  asCurrency(record["currency"], "currency");
  asPositiveInteger(record["divisor"], "divisor");
  const rateScaled = assertCanonicalAmount(asNonEmptyString(record["rate"], "rate"), "rate");
  if (rateScaled <= 0n) {
    throw new CostValidationError(
      "cost rate revision rate must be strictly positive; an unpriced model stays unknown instead of a zero rate",
    );
  }
  const source = asOneOf(record["source"], RATE_SOURCES, "source");
  if (target === "self_hosted" && isTokenCategory && source !== "administrator") {
    throw new CostValidationError(
      "self-hosted token rates are administrator-assigned allocation rates; " +
        `source ${source} cannot price them`,
    );
  }
  if (
    target === "self_hosted" &&
    !isTokenCategory &&
    source !== "administrator" &&
    source !== "measured"
  ) {
    throw new CostValidationError(
      "infrastructure rates come from measurement or administrator allocation; " +
        `source ${source} cannot price them`,
    );
  }
  if (target === "provider" && source === "measured") {
    throw new CostValidationError(
      'source "measured" prices self-hosted infrastructure, not provider metering',
    );
  }
  asTimestamp(record["effective_from"], "effective_from");
  const effectiveTo = asNullableString(record["effective_to"], "effective_to");
  if (effectiveTo !== null) {
    asTimestamp(effectiveTo, "effective_to");
    if (Date.parse(effectiveTo) <= Date.parse(record["effective_from"] as string)) {
      throw new CostValidationError(
        "cost rate revision effective_to must be strictly after effective_from",
      );
    }
  }
  asTimestamp(record["recorded_at"], "recorded_at");
  asNullableString(record["note"], "note");
  return value as RateCardRevision;
}

/**
 * Build a complete current-version revision from writer input and validate
 * it. The rate is normalized to the canonical fixed-precision form; the
 * effective window is taken as written.
 */
export function buildRateCardRevision(
  input: RateCardRevisionInput,
  recordedAt: string,
): RateCardRevision {
  const normalizedRate = formatAmount(parseRateValue(input.rate));
  return validateRateCardRevision({
    schema_version: COST_SCHEMA_VERSION,
    revision_id: input.revision_id,
    enterprise_id: input.enterprise_id,
    workspace_id: input.workspace_id,
    target: input.target,
    endpoint_id: input.endpoint_id,
    model_id: input.model_id,
    category: input.category,
    unit: input.unit,
    currency: input.currency,
    divisor: input.divisor,
    rate: normalizedRate,
    source: input.source,
    effective_from: input.effective_from,
    effective_to: input.effective_to,
    recorded_at: recordedAt,
    note: input.note,
  });
}

/**
 * The binding identity of a revision. Two revisions with the same key and the
 * same effective start would make binding ambiguous, so record time refuses
 * the second.
 */
export function rateRevisionKey(revision: RateCardRevision): string {
  const identity: unknown[] = [
    revision.enterprise_id,
    revision.workspace_id,
    revision.target,
    revision.endpoint_id,
    revision.model_id,
    revision.category,
    revision.unit,
    revision.currency,
  ];
  return JSON.stringify(identity);
}

/** What a pricing pass knows about the charge it wants a rate for. */
export interface RateBindingContext {
  target: RateTarget;
  endpoint_id: string | null;
  model_id: string | null;
  category: CostCategory;
  unit: RateUnit;
  /** Currency the charge is metered in; null when the provider declares none. */
  currency: string | null;
  /** Applicable time: the instant the charge happened. */
  at: string;
}

export type RateBinding =
  | { status: "bound"; revision: RateCardRevision }
  | { status: "unbound"; reason: CostUnknownReason };

/**
 * Bind the governing rate revision for one charge. Never guesses: when the
 * binding is not uniquely determined the result is an unbound reason, and the
 * caller keeps the cost component unknown.
 */
export function bindRate(
  revisions: readonly RateCardRevision[],
  context: RateBindingContext,
): RateBinding {
  const atMs = Date.parse(asTimestamp(context.at, "applicable_time"));
  const candidates = revisions.filter((revision) => {
    if (revision.target !== context.target || revision.category !== context.category) {
      return false;
    }
    if (revision.unit !== context.unit) {
      return false;
    }
    if (revision.endpoint_id !== null && revision.endpoint_id !== context.endpoint_id) {
      return false;
    }
    if (revision.model_id !== null && revision.model_id !== context.model_id) {
      return false;
    }
    const fromMs = Date.parse(revision.effective_from);
    const toMs = revision.effective_to === null ? Infinity : Date.parse(revision.effective_to);
    return fromMs <= atMs && atMs < toMs;
  });
  if (candidates.length === 0) {
    return { status: "unbound", reason: "rate_unknown" };
  }
  let priced: RateCardRevision[];
  if (context.currency !== null) {
    const wanted = asCurrency(context.currency, "metering.currency");
    priced = candidates.filter((revision) => revision.currency === wanted);
    if (priced.length === 0) {
      return { status: "unbound", reason: "currency_mismatch" };
    }
  } else {
    const currencies = new Set(candidates.map((revision) => revision.currency));
    if (currencies.size > 1) {
      return { status: "unbound", reason: "currency_ambiguous" };
    }
    priced = [...candidates];
  }
  const specificity = (revision: RateCardRevision): number =>
    (revision.model_id !== null ? 2 : 0) + (revision.endpoint_id !== null ? 1 : 0);
  const topSpecificity = Math.max(...priced.map(specificity));
  let winners = priced.filter((revision) => specificity(revision) === topSpecificity);
  const latestStart = Math.max(...winners.map((revision) => Date.parse(revision.effective_from)));
  winners = winners.filter((revision) => Date.parse(revision.effective_from) === latestStart);
  if (winners.length !== 1) {
    throw new CostValidationError(
      "cost rate binding is ambiguous: several recorded revisions share the same " +
        "scope and effective start; record time must have refused them",
    );
  }
  return { status: "bound", revision: winners[0] as RateCardRevision };
}
