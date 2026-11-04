/**
 * Versioned FX quotes and explicit cross-currency conversion (DAT-228,
 * ADR-0008 "Cross-currency totals remain separated unless an explicit
 * versioned FX source/time is supplied").
 *
 * `summarizeCosts` never merges currencies. This module converts only when
 * the caller names the FX source, source revision and quote time it wants —
 * and the resulting totals record exactly which immutable quote produced
 * every converted amount, so a converted total is as replayable as the
 * postings behind it.
 */
import { CostValidationError } from "./errors.js";
import {
  convertScaled,
  formatAmount,
  invertRateScaled,
  parseAmount,
  parseRateValue,
} from "./money.js";
import type { CostClassTotals, CostSummary, FxQuote, FxQuoteInput } from "./types.js";
import { COST_SCHEMA_VERSION } from "./types.js";
import { asCurrency, asNonEmptyString, asRecord, asTimestamp } from "./validate.js";

/**
 * Validate one fully-shaped current-version quote. Returns the input object;
 * a same-currency quote or a non-positive rate is a control failure.
 */
export function validateFxQuote(value: unknown): FxQuote {
  const record = asRecord(value, "fx quote");
  const version = record["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CostValidationError(`cost field "schema_version" must be an integer`);
  }
  if (version > COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost fx quote schema ${version} is newer than ${COST_SCHEMA_VERSION}`,
    );
  }
  if (version !== COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost fx quote schema ${version} must be migrated to ${COST_SCHEMA_VERSION} first`,
    );
  }
  asNonEmptyString(record["quote_id"], "quote_id");
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  asNonEmptyString(record["source"], "source");
  asNonEmptyString(record["source_revision"], "source_revision");
  asTimestamp(record["quoted_at"], "quoted_at");
  const base = asCurrency(record["base_currency"], "base_currency");
  const quote = asCurrency(record["quote_currency"], "quote_currency");
  if (base === quote) {
    throw new CostValidationError("an FX quote must span two different currencies");
  }
  const rate = parseRateValue(asNonEmptyString(record["rate"], "rate"));
  if (formatAmount(rate) !== record["rate"]) {
    throw new CostValidationError(
      'cost field "rate" must be a fixed-precision decimal in canonical form',
    );
  }
  asTimestamp(record["recorded_at"], "recorded_at");
  return value as FxQuote;
}

/** Build a complete quote from writer input; the rate is normalized to canonical form. */
export function buildFxQuote(input: FxQuoteInput, recordedAt: string): FxQuote {
  return validateFxQuote({
    schema_version: COST_SCHEMA_VERSION,
    quote_id: input.quote_id,
    enterprise_id: input.enterprise_id,
    workspace_id: input.workspace_id,
    source: input.source,
    source_revision: input.source_revision,
    quoted_at: input.quoted_at,
    base_currency: input.base_currency,
    quote_currency: input.quote_currency,
    rate: formatAmount(parseRateValue(input.rate)),
    recorded_at: recordedAt,
  });
}

/**
 * The explicit versioned FX source/time a conversion speaks for. A merge that
 * does not name one is refused — currencies never combine implicitly.
 */
export interface FxSelection {
  source: string;
  source_revision: string;
  quoted_at: string;
}

export interface ConvertedClassTotals {
  /** Target currency of the converted amounts; null lines stay unconverted. */
  currency: string | null;
  cost_class: CostClassTotals["cost_class"];
  known_cost: string;
  estimated_cost: string;
  unknown_components: number;
  components: number;
  postings: number;
  /** Immutable quotes used for this line; empty for unconverted carry-over. */
  fx_quote_ids: string[];
}

export interface ConvertedSummary {
  target_currency: string;
  fx: FxSelection;
  lines: ConvertedClassTotals[];
}

/**
 * Convert a summary into one target currency using only quotes that match the
 * named source, source revision and quote time. Lines already in the target
 * currency (or without a currency) carry over unconverted; every other line
 * must find its quote — a missing pair is refused, never silently dropped and
 * never approximated from some other time's rate.
 */
export function convertSummary(
  summary: CostSummary,
  targetCurrency: string,
  quotes: readonly FxQuote[],
  selection: FxSelection,
): ConvertedSummary {
  const target = asCurrency(targetCurrency, "target_currency");
  asNonEmptyString(selection.source, "fx.source");
  asNonEmptyString(selection.source_revision, "fx.source_revision");
  asTimestamp(selection.quoted_at, "fx.quoted_at");
  interface Accumulated {
    currency: string | null;
    cost_class: CostClassTotals["cost_class"];
    known: bigint;
    estimated: bigint;
    unknown: number;
    components: number;
    postings: number;
    quoteIds: Set<string>;
  }
  const lines = new Map<string, Accumulated>();
  const accumulate = (key: string, seed: () => Accumulated): Accumulated => {
    const existing = lines.get(key);
    if (existing) {
      return existing;
    }
    const created = seed();
    lines.set(key, created);
    return created;
  };
  for (const line of summary.lines) {
    const unconverted = line.currency === null || line.currency === target;
    let rateScaled: bigint | null = null;
    let quoteId: string | null = null;
    if (!unconverted) {
      const matching = quotes.filter(
        (quote) =>
          quote.source === selection.source &&
          quote.source_revision === selection.source_revision &&
          quote.quoted_at === selection.quoted_at &&
          ((quote.base_currency === line.currency && quote.quote_currency === target) ||
            (quote.base_currency === target && quote.quote_currency === line.currency)),
      );
      if (matching.length !== 1) {
        throw new CostValidationError(
          `cross-currency conversion of ${String(line.currency)} into ${target} needs exactly one ` +
            `quote from ${selection.source} revision ${selection.source_revision} at ` +
            `${selection.quoted_at}; found ${matching.length}. Currencies stay separated without ` +
            "an explicit versioned FX source/time.",
        );
      }
      const quote = matching[0] as FxQuote;
      const quoted = parseAmount(quote.rate);
      rateScaled = quote.base_currency === target ? invertRateScaled(quoted) : quoted;
      quoteId = quote.quote_id;
    }
    const key = JSON.stringify([unconverted ? line.currency : target, line.cost_class]);
    const bucket = accumulate(key, () => ({
      currency: unconverted ? line.currency : target,
      cost_class: line.cost_class,
      known: 0n,
      estimated: 0n,
      unknown: 0,
      components: 0,
      postings: 0,
      quoteIds: new Set<string>(),
    }));
    const known = parseAmount(line.known_cost);
    const estimated = parseAmount(line.estimated_cost);
    if (rateScaled === null) {
      bucket.known += known;
      bucket.estimated += estimated;
    } else {
      bucket.known += convertScaled(known, rateScaled);
      bucket.estimated += convertScaled(estimated, rateScaled);
    }
    if (quoteId !== null) {
      bucket.quoteIds.add(quoteId);
    }
    bucket.unknown += line.unknown_components;
    bucket.components += line.components;
    bucket.postings += line.postings;
  }
  const converted: ConvertedClassTotals[] = [...lines.values()].map((bucket) => ({
    currency: bucket.currency,
    cost_class: bucket.cost_class,
    known_cost: formatAmount(bucket.known),
    estimated_cost: formatAmount(bucket.estimated),
    unknown_components: bucket.unknown,
    components: bucket.components,
    postings: bucket.postings,
    fx_quote_ids: [...bucket.quoteIds].sort(),
  }));
  converted.sort((left, right) =>
    JSON.stringify([left.currency, left.cost_class]).localeCompare(
      JSON.stringify([right.currency, right.cost_class]),
    ),
  );
  return { target_currency: target, fx: selection, lines: converted };
}
