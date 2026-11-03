/**
 * Cross-currency separation and explicit versioned FX conversion (DAT-228):
 * totals never merge across currencies without a named FX source, revision
 * and time, and every converted amount records the quote that produced it.
 */
import { describe, expect, test } from "vitest";

import {
  CostValidationError,
  buildFxQuote,
  computeInvocationCost,
  convertSummary,
  summarizeCosts,
  validateFxQuote,
} from "../src/cost/index.js";
import type { CostLedgerEntry, RateCardRevision } from "../src/cost/index.js";
import { fxQuoteInput, invocationInput, rateInput } from "./helpers/cost-fixtures.js";
import { buildRateCardRevision } from "../src/cost/index.js";

function built(overrides: Parameters<typeof rateInput>[0] = {}): RateCardRevision {
  return buildRateCardRevision(rateInput(overrides), "2026-05-01T00:00:00.000Z");
}

const SELECTION = {
  source: "test-fx",
  source_revision: "2026-06-01",
  quoted_at: "2026-06-01T00:00:00.000Z",
};

function eurAndUsdPostings(): CostLedgerEntry[] {
  const eur = computeInvocationCost(
    invocationInput({
      invocation_id: "inv-eur",
      metering: { unit: "tokens", currency: "EUR" },
    }),
    [built({ revision_id: "rev-eur", currency: "EUR", rate: "0.003" })],
    "2026-06-02T00:00:00.000Z",
  );
  const usd = computeInvocationCost(
    invocationInput({
      invocation_id: "inv-usd",
      metering: { unit: "tokens", currency: "USD" },
    }),
    [built({ revision_id: "rev-usd", currency: "USD", rate: "0.003" })],
    "2026-06-02T00:00:00.000Z",
  );
  return [
    { posting: eur, adjustments: [] },
    { posting: usd, adjustments: [] },
  ];
}

describe("FX quotes", () => {
  test("quotes are versioned, positive and span two currencies", () => {
    const quote = buildFxQuote(fxQuoteInput({ rate: "1.1" }), "2026-06-01T01:00:00.000Z");
    expect(quote.rate).toBe("1.100000000000");
    expect(() =>
      validateFxQuote({ ...quote, base_currency: "USD", quote_currency: "USD" }),
    ).toThrow(CostValidationError);
    expect(() => validateFxQuote({ ...quote, rate: "0.000000000000" })).toThrow(
      CostValidationError,
    );
    expect(() => validateFxQuote({ ...quote, rate: "1.1" })).toThrow(CostValidationError);
  });
});

describe("cross-currency conversion", () => {
  test("summaries never merge currencies", () => {
    const summary = summarizeCosts(eurAndUsdPostings(), []);
    const currencies = summary.lines
      .filter((line) => line.currency !== null)
      .map((line) => line.currency)
      .sort();
    expect(currencies).toEqual(["EUR", "USD"]);
    // Unpriced components live on their own uncurrencyed line, never folded in.
    expect(summary.lines.filter((line) => line.currency === null)).toHaveLength(1);
  });

  test("conversion without an explicit versioned FX source/time is refused", () => {
    const summary = summarizeCosts(eurAndUsdPostings(), []);
    expect(() => convertSummary(summary, "USD", [], SELECTION)).toThrow(CostValidationError);
    // A quote at another time is not silently substituted.
    const otherTime = buildFxQuote(
      fxQuoteInput({ rate: "1.1", quoted_at: "2026-06-02T00:00:00.000Z" }),
      "2026-06-02T01:00:00.000Z",
    );
    expect(() => convertSummary(summary, "USD", [otherTime], SELECTION)).toThrow(
      CostValidationError,
    );
  });

  test("a named quote converts and merges — and records which quote produced it", () => {
    const summary = summarizeCosts(eurAndUsdPostings(), []);
    const quote = buildFxQuote(fxQuoteInput({ rate: "1.1" }), "2026-06-01T01:00:00.000Z");
    const converted = convertSummary(summary, "USD", [quote], SELECTION);
    expect(converted.target_currency).toBe("USD");
    expect(converted.fx).toEqual(SELECTION);
    expect(converted.lines.find((line) => line.currency === "USD")).toEqual({
      currency: "USD",
      cost_class: "provider_tokens",
      // 0.003 USD + 0.003 EUR × 1.1 = 0.0063 USD.
      known_cost: "0.006300000000",
      estimated_cost: "0.000000000000",
      unknown_components: 0,
      components: 1 + 1, // the priced input lines of both postings
      postings: 2,
      fx_quote_ids: ["fx-1"],
    });
    // The uncurrencyed unknown line carries over untouched.
    expect(converted.lines.find((line) => line.currency === null)).toMatchObject({
      known_cost: "0.000000000000",
      unknown_components: 4 + 4, // the unpriced output/cache/reasoning lines
      fx_quote_ids: [],
    });
  });

  test("an inverted quote converts back through the same explicit selection", () => {
    const summary = summarizeCosts(eurAndUsdPostings(), []);
    const quote = buildFxQuote(fxQuoteInput({ rate: "1.1" }), "2026-06-01T01:00:00.000Z");
    const converted = convertSummary(summary, "EUR", [quote], SELECTION);
    // 0.003 EUR + 0.003 USD / 1.1 = 0.005727272727 EUR (half-up at the scale).
    expect(converted.lines.find((line) => line.currency === "EUR")).toEqual(
      expect.objectContaining({
        currency: "EUR",
        known_cost: "0.005727272727",
        fx_quote_ids: ["fx-1"],
      }),
    );
  });

  test("two quotes for one pair at one selection are ambiguous and refused", () => {
    const summary = summarizeCosts(eurAndUsdPostings(), []);
    const first = buildFxQuote(
      fxQuoteInput({ quote_id: "fx-a", rate: "1.1" }),
      "2026-06-01T01:00:00.000Z",
    );
    const second = buildFxQuote(
      fxQuoteInput({ quote_id: "fx-b", rate: "1.2" }),
      "2026-06-01T01:00:00.000Z",
    );
    expect(() => convertSummary(summary, "USD", [first, second], SELECTION)).toThrow(
      CostValidationError,
    );
  });

  test("estimated buckets convert provisionally and stay separate from known", () => {
    const estimated = computeInvocationCost(
      invocationInput({
        invocation_id: "inv-est",
        metering: { unit: "tokens", currency: "EUR" },
        usage: {
          input: {
            tokens: 1000,
            completeness: "estimated",
            included_in: null,
          },
        },
      }),
      [built({ revision_id: "rev-eur", currency: "EUR", rate: "0.003" })],
      "2026-06-02T00:00:00.000Z",
    );
    const summary = summarizeCosts([{ posting: estimated, adjustments: [] }], []);
    const quote = buildFxQuote(fxQuoteInput({ rate: "2" }), "2026-06-01T01:00:00.000Z");
    const converted = convertSummary(summary, "USD", [quote], SELECTION);
    expect(converted.lines.find((line) => line.currency === "USD")).toEqual(
      expect.objectContaining({
        currency: "USD",
        known_cost: "0.000000000000",
        estimated_cost: "0.006000000000", // 0.003 EUR × 2, still provisional
      }),
    );
  });
});
