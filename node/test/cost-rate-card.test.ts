/**
 * Immutable effective-dated rate cards and deterministic binding (DAT-228):
 * window boundaries, specificity, currency resolution, and the refusal to
 * invent a zero rate for anything unpriced.
 */
import { describe, expect, test } from "vitest";

import {
  CostConflictError,
  CostStore,
  CostValidationError,
  bindRate,
  buildRateCardRevision,
  validateRateCardRevision,
} from "../src/cost/index.js";
import type { RateCardRevision } from "../src/cost/index.js";
import { rateInput } from "./helpers/cost-fixtures.js";

function built(overrides: Parameters<typeof rateInput>[0] = {}): RateCardRevision {
  return buildRateCardRevision(rateInput(overrides), "2026-05-01T00:00:00.000Z");
}

const bindingContext = {
  target: "provider" as const,
  endpoint_id: "ep-1",
  model_id: "model-a",
  category: "input" as const,
  unit: "tokens" as const,
  currency: "USD",
  at: "2026-06-01T00:00:00.000Z",
};

describe("rate revision validation", () => {
  test("writer rates are normalized to canonical fixed precision", () => {
    const revision = built({ rate: "0.003" });
    expect(revision.rate).toBe("0.003000000000");
  });

  test("zero and negative rates are refused — unpriced models stay unknown", () => {
    expect(() => built({ rate: "0" })).toThrow(CostValidationError);
    expect(() => built({ rate: "0.000000000000" })).toThrow(CostValidationError);
    expect(() => built({ rate: "-0.003" })).toThrow(CostValidationError);
  });

  test("token categories are metered in tokens; infrastructure in explicit units", () => {
    expect(() => built({ category: "input", unit: "gpu_seconds" })).toThrow(CostValidationError);
    expect(() => built({ category: "infrastructure", unit: "tokens" })).toThrow(
      CostValidationError,
    );
    expect(() => built({ category: "infrastructure", unit: "requests" })).not.toThrow();
  });

  test("self-hosted token allocation rates are administrator-assigned only", () => {
    expect(() =>
      built({ target: "self_hosted", source: "provider_list", category: "input" }),
    ).toThrow(CostValidationError);
    expect(() => built({ target: "self_hosted", source: "measured", category: "input" })).toThrow(
      CostValidationError,
    );
    expect(() =>
      built({ target: "self_hosted", source: "administrator", category: "input" }),
    ).not.toThrow();
    expect(() => built({ target: "provider", source: "measured", category: "input" })).toThrow(
      CostValidationError,
    );
  });

  test("effective windows must be well-ordered and timestamps real", () => {
    expect(() =>
      built({
        effective_from: "2026-02-01T00:00:00.000Z",
        effective_to: "2026-02-01T00:00:00.000Z",
      }),
    ).toThrow(CostValidationError);
    expect(() =>
      built({
        effective_from: "2026-02-01T00:00:00.000Z",
        effective_to: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(CostValidationError);
    expect(() => built({ effective_from: "yesterday" })).toThrow(CostValidationError);
  });

  test("currency is ISO 4217 and amounts stay canonical on load", () => {
    expect(() => built({ currency: "usd" })).toThrow(CostValidationError);
    expect(() => built({ currency: "DOLLARS" })).toThrow(CostValidationError);
    expect(() => validateRateCardRevision({ ...built({}), rate: "0.5" })).toThrow(
      CostValidationError,
    );
    expect(() => validateRateCardRevision({ ...built({}), schema_version: 99 })).toThrow(
      CostValidationError,
    );
  });
});

describe("rate binding", () => {
  test("the effective window is half-open: from inclusive, to exclusive", () => {
    const first = built({
      revision_id: "rev-1",
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: "2026-03-01T00:00:00.000Z",
      rate: "0.001",
    });
    const second = built({
      revision_id: "rev-2",
      effective_from: "2026-03-01T00:00:00.000Z",
      effective_to: null,
      rate: "0.002",
    });
    const revisions = [first, second];
    expect(
      bindRate(revisions, { ...bindingContext, at: "2026-01-01T00:00:00.000Z" }),
    ).toMatchObject({ status: "bound", revision: { revision_id: "rev-1" } });
    expect(
      bindRate(revisions, { ...bindingContext, at: "2026-02-28T23:59:59.999Z" }),
    ).toMatchObject({ status: "bound", revision: { revision_id: "rev-1" } });
    // Exactly at effective_to: the next revision governs — no gap, no double.
    expect(
      bindRate(revisions, { ...bindingContext, at: "2026-03-01T00:00:00.000Z" }),
    ).toMatchObject({ status: "bound", revision: { revision_id: "rev-2" } });
    // Before the first window ever opens: unpriced, not free.
    expect(bindRate(revisions, { ...bindingContext, at: "2025-12-31T23:59:59.999Z" })).toEqual({
      status: "unbound",
      reason: "rate_unknown",
    });
  });

  test("an expired revision stops governing even without a successor", () => {
    const expiring = built({
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: "2026-03-01T00:00:00.000Z",
    });
    expect(bindRate([expiring], { ...bindingContext, at: "2026-04-01T00:00:00.000Z" })).toEqual({
      status: "unbound",
      reason: "rate_unknown",
    });
  });

  test("within one scope the latest effective start wins over an older open window", () => {
    const older = built({
      revision_id: "rev-old",
      rate: "0.001",
      effective_from: "2026-01-01T00:00:00.000Z",
    });
    const newer = built({
      revision_id: "rev-new",
      rate: "0.002",
      effective_from: "2026-05-01T00:00:00.000Z",
    });
    expect(
      bindRate([older, newer], { ...bindingContext, at: "2026-04-30T23:59:59.999Z" }),
    ).toMatchObject({ status: "bound", revision: { revision_id: "rev-old" } });
    expect(bindRate([older, newer], bindingContext)).toMatchObject({
      status: "bound",
      revision: { revision_id: "rev-new" },
    });
  });

  test("model scope beats recency: a blanket revision never silently reprices a model", () => {
    const modelScoped = built({
      revision_id: "rev-model",
      model_id: "model-a",
      rate: "0.001",
      effective_from: "2026-01-01T00:00:00.000Z",
    });
    const blanket = built({
      revision_id: "rev-blanket",
      model_id: null,
      rate: "0.009",
      effective_from: "2026-05-01T00:00:00.000Z",
    });
    expect(bindRate([modelScoped, blanket], bindingContext)).toMatchObject({
      status: "bound",
      revision: { revision_id: "rev-model" },
    });
    // A model without its own rates falls back to the blanket revision.
    expect(
      bindRate([modelScoped, blanket], { ...bindingContext, model_id: "model-b" }),
    ).toMatchObject({ status: "bound", revision: { revision_id: "rev-blanket" } });
  });

  test("endpoint scope beats wildcard model scope on equal model specificity", () => {
    const endpointScoped = built({
      revision_id: "rev-ep",
      endpoint_id: "ep-1",
      model_id: null,
      rate: "0.001",
    });
    const modelWildcard = built({
      revision_id: "rev-any",
      endpoint_id: null,
      model_id: null,
      rate: "0.002",
      effective_from: "2026-05-01T00:00:00.000Z",
    });
    expect(bindRate([endpointScoped, modelWildcard], bindingContext)).toMatchObject({
      status: "bound",
      revision: { revision_id: "rev-ep" },
    });
  });

  test("a rate only prices its own target, category and unit", () => {
    const providerRate = built();
    expect(bindRate([providerRate], { ...bindingContext, target: "self_hosted" })).toEqual({
      status: "unbound",
      reason: "rate_unknown",
    });
    expect(bindRate([providerRate], { ...bindingContext, category: "output" })).toEqual({
      status: "unbound",
      reason: "rate_unknown",
    });
    expect(bindRate([providerRate], { ...bindingContext, unit: "gpu_seconds" })).toEqual({
      status: "unbound",
      reason: "rate_unknown",
    });
  });

  test("currency: metered currency binds only its own rates", () => {
    const eurRate = built({ currency: "EUR", rate: "0.001" });
    expect(bindRate([eurRate], bindingContext)).toEqual({
      status: "unbound",
      reason: "currency_mismatch",
    });
    expect(bindRate([eurRate], { ...bindingContext, currency: "EUR" })).toMatchObject({
      status: "bound",
    });
  });

  test("currency: an invocation without a declared currency binds one unambiguous currency", () => {
    const usd = built({ revision_id: "rev-usd", currency: "USD", rate: "0.001" });
    const eur = built({ revision_id: "rev-eur", currency: "EUR", rate: "0.001" });
    expect(bindRate([usd], { ...bindingContext, currency: null })).toMatchObject({
      status: "bound",
      revision: { revision_id: "rev-usd" },
    });
    expect(bindRate([usd, eur], { ...bindingContext, currency: null })).toEqual({
      status: "unbound",
      reason: "currency_ambiguous",
    });
  });

  test("two revisions with identical scope and effective start are ambiguous and throw", () => {
    const first = built({ revision_id: "rev-a", rate: "0.001" });
    const second = built({ revision_id: "rev-b", rate: "0.002" });
    // The store refuses this pair at record time; the pure binder also
    // refuses to guess if it ever sees one.
    expect(() => bindRate([first, second], bindingContext)).toThrow(CostValidationError);
  });

  test("an ambiguous pair is refused at record time too", () => {
    const store = new CostStore({ now: () => new Date("2026-05-01T00:00:00.000Z") });
    store.addRateRevision(rateInput({ revision_id: "rev-a", rate: "0.001" }));
    expect(() => store.addRateRevision(rateInput({ revision_id: "rev-b", rate: "0.002" }))).toThrow(
      CostConflictError,
    );
    // A different effective start is a legitimate later revision.
    expect(() =>
      store.addRateRevision(
        rateInput({
          revision_id: "rev-b",
          rate: "0.002",
          effective_from: "2026-05-01T00:00:00.000Z",
        }),
      ),
    ).not.toThrow();
  });
});
