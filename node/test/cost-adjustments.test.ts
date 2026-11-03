/**
 * Linked adjustment entries (DAT-228): corrections append and never rewrite,
 * the net view replays them over the untouched original, and a voided figure
 * becomes unknown — never a zeroed charge.
 */
import { describe, expect, test } from "vitest";

import {
  CostValidationError,
  buildAdjustment,
  computeInvocationCost,
  netPosting,
  summarizeCosts,
} from "../src/cost/index.js";
import type { AdjustmentEntry, CostPosting, RateCardRevision } from "../src/cost/index.js";
import { adjustmentInput, figure, invocationInput, rateInput } from "./helpers/cost-fixtures.js";
import { buildRateCardRevision } from "../src/cost/index.js";

function built(overrides: Parameters<typeof rateInput>[0] = {}): RateCardRevision {
  return buildRateCardRevision(rateInput(overrides), "2026-05-01T00:00:00.000Z");
}

const REV_IN = built({ revision_id: "rev-in", category: "input", rate: "0.003" });
const REV_OUT = built({ revision_id: "rev-out", category: "output", rate: "0.006" });
const RATES = [REV_IN, REV_OUT];

function priced(): CostPosting {
  return computeInvocationCost(invocationInput(), RATES, "2026-06-02T00:00:00.000Z");
}

function recorded(overrides: Parameters<typeof adjustmentInput>[0] = {}): AdjustmentEntry {
  return buildAdjustment(adjustmentInput(overrides), "2026-06-03T00:00:00.000Z");
}

describe("adjustment validation", () => {
  test("a correction must restate something; a void restates nothing", () => {
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: null,
            corrected_rate_revision_id: null,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "unknown",
            corrected_units: 10,
            corrected_rate_revision_id: null,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
  });

  test("explicit amounts carry their currency and cannot be negative", () => {
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: null,
            corrected_rate_revision_id: null,
            corrected_cost: "0.005000000000",
            corrected_currency: null,
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: null,
            corrected_rate_revision_id: null,
            corrected_cost: "-0.005000000000",
            corrected_currency: "USD",
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: null,
            corrected_rate_revision_id: null,
            corrected_cost: null,
            corrected_currency: "USD",
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
  });

  test("one entry cannot correct the same category twice", () => {
    expect(() =>
      recorded({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: 1,
            corrected_rate_revision_id: null,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
          {
            category: "input",
            completeness: "known",
            corrected_units: 2,
            corrected_rate_revision_id: null,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
        ],
      }),
    ).toThrow(CostValidationError);
  });

  test("reason and source must agree about who asserts the correction", () => {
    expect(() => recorded({ reason: "provider_correction", source: "administrator" })).toThrow(
      CostValidationError,
    );
    expect(() =>
      recorded({
        reason: "administrator_correction",
        source: "administrator",
        target_posting_id: "cost-inv:inv-1:1",
      }),
    ).not.toThrow();
  });
});

describe("the net view replays corrections over an untouched original", () => {
  test("corrected units recompute under the posting's own bound rate snapshot", () => {
    const posting = priced();
    const originalCost = posting.components.find((line) => line.category === "input")?.cost;
    expect(originalCost).toBe("0.003000000000");
    const adjustment = recorded();
    const view = netPosting({ posting, adjustments: [adjustment] }, RATES);
    const corrected = view.components.find((line) => line.category === "input");
    // 1200 tokens at the snapshot rate 0.003 per 1000 = 0.0036.
    expect(corrected).toMatchObject({
      chargeable_units: 1200,
      cost: "0.003600000000",
      rate_revision_id: "rev-in",
      completeness: "known",
    });
    // The original posting keeps every figure it was written with.
    expect(posting.components.find((line) => line.category === "input")?.cost).toBe(
      "0.003000000000",
    );
    expect(view.posting).toBe(posting);
    expect(view.adjustments).toEqual([adjustment]);
  });

  test("an explicit corrected amount supersedes the recompute path", () => {
    const posting = priced();
    const adjustment = recorded({
      components: [
        {
          category: "input",
          completeness: "known",
          corrected_units: null,
          corrected_rate_revision_id: null,
          corrected_cost: "0.005000000000",
          corrected_currency: "USD",
          note: "provider rebilling",
        },
      ],
    });
    const view = netPosting({ posting, adjustments: [adjustment] }, RATES);
    expect(view.components.find((line) => line.category === "input")).toMatchObject({
      cost: "0.005000000000",
      currency: "USD",
    });
  });

  test("a rebinding correction recomputes under the corrected revision", () => {
    const posting = priced();
    const rebound = built({ revision_id: "rev-rebind", category: "input", rate: "0.010" });
    const adjustment = recorded({
      components: [
        {
          category: "input",
          completeness: "known",
          corrected_units: 1000,
          corrected_rate_revision_id: "rev-rebind",
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    const view = netPosting({ posting, adjustments: [adjustment] }, [...RATES, rebound]);
    expect(view.components.find((line) => line.category === "input")).toMatchObject({
      cost: "0.010000000000",
      rate_revision_id: "rev-rebind",
    });
    // …and refuses to invent a figure when the rebound revision is unrecorded.
    expect(() => netPosting({ posting, adjustments: [adjustment] }, RATES)).toThrow(
      CostValidationError,
    );
  });

  test("a voided figure becomes unknown again — never a zeroed charge", () => {
    const posting = priced();
    const adjustment = recorded({
      components: [
        {
          category: "input",
          completeness: "unknown",
          corrected_units: null,
          corrected_rate_revision_id: null,
          corrected_cost: null,
          corrected_currency: null,
          note: "provider could not substantiate the figure",
        },
      ],
    });
    const view = netPosting({ posting, adjustments: [adjustment] }, RATES);
    expect(view.components.find((line) => line.category === "input")).toMatchObject({
      cost: null,
      completeness: "unknown",
      unknown_reason: "usage_unknown",
    });
    expect(view.completeness).toBe("unknown");
    // The summary counts it as unknown instead of folding in a zero.
    const summary = summarizeCosts([{ posting, adjustments: [adjustment] }], RATES);
    const usdLine = summary.lines.find((line) => line.currency === "USD");
    expect(usdLine?.unknown_components).toBe(1);
  });

  test("summaries use net figures; corrections move totals without rewriting history", () => {
    const posting = priced();
    const adjustment = recorded();
    const before = summarizeCosts([{ posting, adjustments: [] }], RATES);
    const after = summarizeCosts([{ posting, adjustments: [adjustment] }], RATES);
    const beforeLine = before.lines.find((line) => line.currency === "USD");
    const afterLine = after.lines.find((line) => line.currency === "USD");
    // output 0.003 + input 0.003 → 0.006 before; input corrected to 0.0036 after.
    expect(beforeLine?.known_cost).toBe("0.006000000000");
    expect(afterLine?.known_cost).toBe("0.006600000000");
    // The original figures survive for the audit trail.
    expect(posting.components.find((line) => line.category === "input")?.cost).toBe(
      "0.003000000000",
    );
  });

  test("the replay boundary re-vets rebinds even when the revision is recorded", () => {
    const posting = priced();
    // An output rate must never reprice the input line, even if recorded.
    const wrongCategory = recorded({
      components: [
        {
          category: "input",
          completeness: "known",
          corrected_units: 1000,
          corrected_rate_revision_id: "rev-out",
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    expect(() => netPosting({ posting, adjustments: [wrongCategory] }, RATES)).toThrow(
      CostValidationError,
    );
    // A foreign-workspace revision is out of scope for this correction.
    const foreignScope = built({
      revision_id: "rev-elsewhere",
      category: "input",
      workspace_id: "ws-2",
    });
    const wrongScope = recorded({
      components: [
        {
          category: "input",
          completeness: "known",
          corrected_units: 1000,
          corrected_rate_revision_id: "rev-elsewhere",
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    expect(() =>
      netPosting({ posting, adjustments: [wrongScope] }, [...RATES, foreignScope]),
    ).toThrow(CostValidationError);
  });

  test("replay binds the adjustment to its target posting and workspace", () => {
    const posting = priced();
    // A same-shaped correction recorded in another workspace must never
    // replay onto this posting — even though its target id, target,
    // category and unit all line up.
    const foreign = recorded({ enterprise_id: "ent-1", workspace_id: "ws-2" });
    expect(() => netPosting({ posting, adjustments: [foreign] }, RATES)).toThrow(
      CostValidationError,
    );
    // A correction recorded against a different posting never replays here.
    const otherTarget = recorded({ target_posting_id: "cost-inv:inv-other:1" });
    expect(() => netPosting({ posting, adjustments: [otherTarget] }, RATES)).toThrow(
      CostValidationError,
    );
    // The adjustment/posting/rate-revision scope is one three-way contract.
    const foreignRebind = recorded({
      workspace_id: "ws-2",
      components: [
        {
          category: "input",
          completeness: "known",
          corrected_units: 1000,
          corrected_rate_revision_id: "rev-elsewhere",
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    const foreignRevision = built({
      revision_id: "rev-elsewhere",
      category: "input",
      workspace_id: "ws-2",
    });
    expect(() =>
      netPosting({ posting, adjustments: [foreignRebind] }, [...RATES, foreignRevision]),
    ).toThrow(CostValidationError);
  });

  test("an unpriced category can be corrected; a category the posting lacks is refused", () => {
    const posting = computeInvocationCost(
      invocationInput({ usage: { cache_read: figure(null), completeness: "unknown" } }),
      RATES,
      "2026-06-02T00:00:00.000Z",
    );
    // The posting still carries the (unpriced) cache_read line, so it is correctable.
    const correctingUnknown = recorded({
      components: [
        {
          category: "cache_read",
          completeness: "known",
          corrected_units: 10,
          corrected_rate_revision_id: null,
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    const corrected = netPosting({ posting, adjustments: [correctingUnknown] }, RATES).components;
    // Restated units with no rate snapshot anywhere: the figure stays honest.
    expect(corrected).toContainEqual(
      expect.objectContaining({
        category: "cache_read",
        chargeable_units: 10,
        cost: null,
        unknown_reason: "rate_unknown",
      }),
    );
    // An invocation posting has no infrastructure line to correct.
    const wrongCategory = recorded({
      components: [
        {
          category: "infrastructure",
          completeness: "known",
          corrected_units: 1,
          corrected_rate_revision_id: null,
          corrected_cost: null,
          corrected_currency: null,
          note: null,
        },
      ],
    });
    expect(() => netPosting({ posting, adjustments: [wrongCategory] }, RATES)).toThrow(
      CostValidationError,
    );
  });
});
