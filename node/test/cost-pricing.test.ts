/**
 * Per-category cost computation (DAT-228): the exact cost formula, rate
 * snapshots, honest unknowns, estimate labeling, currency and cost-class
 * separation, and the central invariant — a rate change never reprices
 * history.
 */
import { describe, expect, test } from "vitest";

import {
  computeInfrastructureCost,
  computeInvocationCost,
  summarizeCosts,
} from "../src/cost/index.js";
import type { CostComponent, CostPosting, RateCardRevision } from "../src/cost/index.js";
import {
  figure,
  infrastructureInput,
  invocationInput,
  rateInput,
} from "./helpers/cost-fixtures.js";
import { buildRateCardRevision } from "../src/cost/index.js";

function built(overrides: Parameters<typeof rateInput>[0] = {}): RateCardRevision {
  return buildRateCardRevision(rateInput(overrides), "2026-05-01T00:00:00.000Z");
}

function component(posting: CostPosting, category: string): CostComponent {
  const found = posting.components.find((line) => line.category === category);
  if (!found) {
    throw new Error(`posting has no ${category} component`);
  }
  return found;
}

const REV_INPUT = built({ revision_id: "rev-in", category: "input", rate: "0.003" });
const REV_OUTPUT = built({ revision_id: "rev-out", category: "output", rate: "0.006" });
const REV_CACHE_READ = built({ revision_id: "rev-cr", category: "cache_read", rate: "0.001" });
const REV_CACHE_WRITE = built({ revision_id: "rev-cw", category: "cache_write", rate: "0.002" });
const REV_REASONING = built({ revision_id: "rev-re", category: "reasoning", rate: "0.012" });
const ALL_RATES = [REV_INPUT, REV_OUTPUT, REV_CACHE_READ, REV_CACHE_WRITE, REV_REASONING];

describe("per-category cost = chargeable units × bound rate / divisor", () => {
  test("every category prices exactly and snapshots its bound revision", () => {
    const posting = computeInvocationCost(invocationInput(), ALL_RATES, "2026-06-02T00:00:00.000Z");
    const input = component(posting, "input");
    expect(input).toMatchObject({
      chargeable: true,
      chargeable_units: 1000,
      cost: "0.003000000000",
      currency: "USD",
      rate_revision_id: "rev-in",
      rate: "0.003000000000",
      divisor: 1000,
      completeness: "known",
      unknown_reason: null,
      cost_class: "provider_tokens",
    });
    // 500 tokens at 0.006 per 1000 = 0.003 — the formula, not a lookup.
    expect(component(posting, "output").cost).toBe("0.003000000000");
    // Known zero usage is a real computed zero, not a missing figure.
    expect(component(posting, "cache_read").cost).toBe("0.000000000000");
    expect(posting.posting_id).toBe("cost-inv:inv-1:1");
    expect(posting.currency).toBe("USD");
    expect(posting.completeness).toBe("known");
    expect(posting.kind).toBe("invocation");
    expect(posting.model_id).toBe("model-a");
    expect(posting.applicable_time).toBe("2026-06-01T00:00:00.000Z");
  });

  test("categories included in another figure are recorded but never charged again", () => {
    // The provider meters reasoning inside its output total: output's 500
    // already contains the 200 reasoning tokens.
    const posting = computeInvocationCost(
      invocationInput({ usage: { reasoning: figure(200, "output") } }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    const reasoning = component(posting, "reasoning");
    expect(reasoning.chargeable).toBe(false);
    expect(reasoning.included_in).toBe("output");
    expect(reasoning.cost).toBeNull();
    expect(reasoning.completeness).toBe("known");
    // Output prices its full figure exactly once — no double-billing.
    expect(component(posting, "output").chargeable_units).toBe(500);
    expect(component(posting, "output").cost).toBe("0.003000000000");
    expect(component(posting, "output").unknown_reason).toBeNull();
    // Summaries skip the included line entirely: it is not cost evidence.
    const summary = summarizeCosts([{ posting, adjustments: [] }], ALL_RATES);
    expect(summary.lines.find((line) => line.currency === "USD")).toMatchObject({
      components: 4,
      unknown_components: 0,
      known_cost: "0.006000000000",
    });
  });

  test("the effective model is the returned model when the provider exposes one", () => {
    const posting = computeInvocationCost(
      invocationInput({ returned_model: "model-a-2026-05" }),
      [built({ revision_id: "rev-ret", model_id: "model-a-2026-05" })],
      "2026-06-02T00:00:00.000Z",
    );
    expect(posting.model_id).toBe("model-a-2026-05");
    expect(component(posting, "input").rate_revision_id).toBe("rev-ret");
  });
});

describe("honest unknowns — no fake zero cost", () => {
  test("missing usage yields an unknown component, never zero", () => {
    const posting = computeInvocationCost(
      invocationInput({ usage: { input: figure(null), completeness: "unknown" } }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    const input = component(posting, "input");
    expect(input.cost).toBeNull();
    expect(input.chargeable_units).toBeNull();
    expect(input.completeness).toBe("unknown");
    expect(input.unknown_reason).toBe("usage_unknown");
    expect(posting.completeness).toBe("unknown");
    // The rate snapshot is still recorded so reconciliation can proceed.
    expect(input.rate_revision_id).toBe("rev-in");
  });

  test("a model without any rate keeps unknown components — never a default zero rate", () => {
    const posting = computeInvocationCost(
      invocationInput({ requested_model: "model-brand-new" }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    for (const line of posting.components) {
      expect(line.cost).toBeNull();
      expect(line.unknown_reason).toBe("rate_unknown");
      expect(line.completeness).toBe("unknown");
    }
    expect(posting.completeness).toBe("unknown");
    expect(posting.currency).toBeNull();
  });

  test("a foreign-currency-only rate card keeps the component unknown in the metered currency", () => {
    const eurOnly = [
      built({ revision_id: "rev-eur", category: "input", currency: "EUR", rate: "0.003" }),
    ];
    const posting = computeInvocationCost(invocationInput(), eurOnly, "2026-06-02T00:00:00.000Z");
    expect(component(posting, "input")).toMatchObject({
      cost: null,
      completeness: "unknown",
      unknown_reason: "currency_mismatch",
    });
    // Priced in the metered currency when the rate card has it.
    const usd = [built({ revision_id: "rev-usd", category: "input", rate: "0.003" })];
    expect(
      component(computeInvocationCost(invocationInput(), usd, "2026-06-02T00:00:00.000Z"), "input")
        .cost,
    ).toBe("0.003000000000");
    // An invocation with no declared currency refuses a multi-currency card.
    const both = [
      built({ revision_id: "rev-usd", category: "input", rate: "0.003" }),
      built({ revision_id: "rev-eur", category: "input", currency: "EUR", rate: "0.003" }),
    ];
    const undeclared = computeInvocationCost(
      invocationInput({ metering: { unit: "tokens", currency: null } }),
      both,
      "2026-06-02T00:00:00.000Z",
    );
    expect(component(undeclared, "input").unknown_reason).toBe("currency_ambiguous");
    // …but a single unambiguous currency is usable even undeclared.
    const single = computeInvocationCost(
      invocationInput({ metering: { unit: "tokens", currency: null } }),
      [built({ revision_id: "rev-usd", category: "input", rate: "0.003" })],
      "2026-06-02T00:00:00.000Z",
    );
    expect(component(single, "input")).toMatchObject({ cost: "0.003000000000", currency: "USD" });
  });
});

describe("estimates are labeled and never invoiced amounts", () => {
  test("estimated usage yields an estimated component and posting", () => {
    const posting = computeInvocationCost(
      invocationInput({ usage: { input: figure(1000, null, "estimated") } }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    expect(component(posting, "input")).toMatchObject({
      cost: "0.003000000000",
      completeness: "estimated",
    });
    expect(posting.completeness).toBe("estimated");
  });

  test("summaries keep estimated amounts out of known amounts", () => {
    const posting = computeInvocationCost(
      invocationInput({ usage: { input: figure(1000, null, "estimated") } }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    const summary = summarizeCosts([{ posting, adjustments: [] }], ALL_RATES);
    const pricedLine = summary.lines.find((line) => line.currency === "USD");
    expect(pricedLine).toMatchObject({
      known_cost: "0.003000000000", // output's known 0.003 only
      estimated_cost: "0.003000000000", // input's estimate stays provisional
      unknown_components: 0,
    });
    expect(summary.lines).toHaveLength(1);
  });

  test("summaries count unknown components instead of folding them in as zeros", () => {
    const posting = computeInvocationCost(
      invocationInput({ usage: { input: figure(null), completeness: "unknown" } }),
      ALL_RATES,
      "2026-06-02T00:00:00.000Z",
    );
    const summary = summarizeCosts([{ posting, adjustments: [] }], ALL_RATES);
    // The unknown input line is counted as unknown on its snapshot-currency
    // line — never folded into the known amount as a zero.
    expect(summary.lines.find((line) => line.currency === "USD")).toMatchObject({
      known_cost: "0.003000000000",
      estimated_cost: "0.000000000000",
      unknown_components: 1,
    });
    expect(summary.lines).toHaveLength(1);
  });
});

describe("rate changes never rewrite history", () => {
  const ratesOverTime = [
    built({
      revision_id: "rev-old",
      category: "input",
      rate: "0.003",
      effective_from: "2026-01-01T00:00:00.000Z",
    }),
    built({
      revision_id: "rev-new",
      category: "input",
      rate: "0.010",
      effective_from: "2026-07-01T00:00:00.000Z",
    }),
  ];

  test("a new revision prices new invocations and leaves old postings untouched", () => {
    const early = computeInvocationCost(
      invocationInput({ invocation_id: "inv-early" }),
      ratesOverTime,
      "2026-06-02T00:00:00.000Z",
    );
    const late = computeInvocationCost(
      invocationInput({ invocation_id: "inv-late", started_at: "2026-08-01T00:00:00.000Z" }),
      ratesOverTime,
      "2026-08-02T00:00:00.000Z",
    );
    expect(component(early, "input")).toMatchObject({
      cost: "0.003000000000",
      rate_revision_id: "rev-old",
    });
    expect(component(late, "input")).toMatchObject({
      cost: "0.010000000000",
      rate_revision_id: "rev-new",
    });
    // Repricing the early invocation after the change reproduces the same
    // posting content: the applicable time keeps it on the old revision.
    const repriced = computeInvocationCost(
      invocationInput({ invocation_id: "inv-early" }),
      ratesOverTime,
      "2026-06-02T00:00:00.000Z",
    );
    expect(repriced).toEqual(early);
  });
});

describe("currency and cost-class separation", () => {
  test("a multi-currency posting never merges its amounts", () => {
    const posting = computeInvocationCost(
      invocationInput({ metering: { unit: "tokens", currency: null } }),
      [
        built({ revision_id: "rev-usd", category: "input", rate: "0.003", currency: "USD" }),
        built({ revision_id: "rev-eur", category: "output", rate: "0.006", currency: "EUR" }),
      ],
      "2026-06-02T00:00:00.000Z",
    );
    expect(posting.currency).toBeNull();
    expect(component(posting, "input").currency).toBe("USD");
    expect(component(posting, "output").currency).toBe("EUR");
    const summary = summarizeCosts([{ posting, adjustments: [] }], []);
    const currencies = summary.lines
      .filter((line) => line.currency !== null)
      .map((line) => line.currency)
      .sort();
    expect(currencies).toEqual(["EUR", "USD"]);
    // No line sums across currencies.
    expect(
      summary.lines
        .filter((line) => line.currency !== null)
        .every((line) => line.known_cost.startsWith("0.003")),
    ).toBe(true);
  });

  test("self-hosted tokens price only through administrator allocation rates", () => {
    const allocation = built({
      revision_id: "rev-alloc",
      target: "self_hosted",
      source: "administrator",
      rate: "0.001",
    });
    const providerRate = REV_INPUT;
    const selfHosted = invocationInput({ internal: true });
    const posting = computeInvocationCost(
      selfHosted,
      [allocation, providerRate],
      "2026-06-02T00:00:00.000Z",
    );
    expect(component(posting, "input")).toMatchObject({
      cost: "0.001000000000",
      rate_revision_id: "rev-alloc",
      cost_class: "self_hosted_tokens",
    });
    // Without an allocation rate the self-hosted model stays unknown.
    const unpriced = computeInvocationCost(selfHosted, [providerRate], "2026-06-02T00:00:00.000Z");
    expect(component(unpriced, "input")).toMatchObject({
      cost: null,
      unknown_reason: "rate_unknown",
    });
  });

  test("measured infrastructure cost is priced and summarized as its own class", () => {
    const infraRate = built({
      revision_id: "rev-infra",
      target: "self_hosted",
      source: "measured",
      category: "infrastructure",
      unit: "gpu_seconds",
      divisor: 1,
      rate: "0.0001",
    });
    const posting = computeInfrastructureCost(
      infrastructureInput({ chargeable_units: 3600 }),
      [infraRate],
      "2026-06-02T00:00:00.000Z",
    );
    expect(posting.kind).toBe("infrastructure");
    expect(posting.posting_id.startsWith("cost-infra:")).toBe(true);
    expect(component(posting, "infrastructure")).toMatchObject({
      cost: "0.360000000000",
      cost_class: "infrastructure",
      unit: "gpu_seconds",
      rate_revision_id: "rev-infra",
    });
    const summary = summarizeCosts([{ posting, adjustments: [] }], [infraRate]);
    expect(summary.lines).toEqual([
      expect.objectContaining({ cost_class: "infrastructure", known_cost: "0.360000000000" }),
    ]);
  });

  test("a self-hosted infrastructure charge with unknown units stays unknown", () => {
    const posting = computeInfrastructureCost(
      infrastructureInput({ chargeable_units: null }),
      [],
      "2026-06-02T00:00:00.000Z",
    );
    expect(component(posting, "infrastructure")).toMatchObject({
      cost: null,
      completeness: "unknown",
      unknown_reason: "usage_unknown",
    });
  });
});
