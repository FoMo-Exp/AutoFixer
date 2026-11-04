/**
 * Shared fixtures for the cost-domain tests (DAT-228): one obvious default
 * per record kind, overridden per test to isolate the invariant under it.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AdjustmentInput,
  CostableInvocation,
  CostableUsageFigure,
  FxQuoteInput,
  InfrastructureCostInput,
  RateCardRevisionInput,
} from "../../src/cost/index.js";
import { CostStore, type CostAccessScope } from "../../src/cost/index.js";

export const SCOPE: CostAccessScope = {
  enterprise_id: "ent-1",
  workspace_id: "ws-1",
  subject: "tester",
};

export const OTHER_SCOPE: CostAccessScope = {
  enterprise_id: "ent-1",
  workspace_id: "ws-2",
  subject: "tester",
};

export function rateInput(overrides: Partial<RateCardRevisionInput> = {}): RateCardRevisionInput {
  return {
    revision_id: "rev-1",
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    target: "provider",
    endpoint_id: "ep-1",
    model_id: "model-a",
    category: "input",
    unit: "tokens",
    currency: "USD",
    divisor: 1000,
    rate: "0.003",
    source: "provider_list",
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
    note: null,
    ...overrides,
  };
}

export function figure(
  tokens: number | null,
  includedIn: CostableUsageFigure["included_in"] = null,
  completeness: CostableUsageFigure["completeness"] = tokens === null ? "unknown" : "known",
): CostableUsageFigure {
  return { tokens, completeness, included_in: includedIn };
}

export function invocationInput(
  overrides: Omit<Partial<CostableInvocation>, "usage"> & {
    usage?: Partial<CostableInvocation["usage"]>;
  } = {},
): CostableInvocation {
  const { usage: usageOverrides, ...rest } = overrides;
  return {
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    invocation_id: "inv-1",
    attempt: 1,
    endpoint_id: "ep-1",
    provider: "test",
    requested_model: "model-a",
    returned_model: null,
    internal: false,
    started_at: "2026-06-01T00:00:00.000Z",
    ended_at: "2026-06-01T00:00:01.000Z",
    metering: { unit: "tokens", currency: "USD" },
    usage: {
      input: figure(1000),
      output: figure(500),
      cache_read: figure(0),
      cache_write: figure(0),
      reasoning: figure(0),
      completeness: "known",
      ...usageOverrides,
    },
    ...rest,
  };
}

export function infrastructureInput(
  overrides: Partial<InfrastructureCostInput> = {},
): InfrastructureCostInput {
  return {
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    entry_key: `infra-${randomUUID()}`,
    endpoint_id: "ep-1",
    model_id: "model-a",
    unit: "gpu_seconds",
    chargeable_units: 3600,
    completeness: "known",
    currency: "USD",
    applicable_time: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

export function adjustmentInput(
  overrides: Partial<AdjustmentInput> & { components?: AdjustmentInput["components"] } = {},
): AdjustmentInput {
  const { components: componentOverrides, ...rest } = overrides;
  return {
    adjustment_id: "adj-1",
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    target_posting_id: "cost-inv:inv-1:1",
    reason: "provider_correction",
    source: "provider",
    note: null,
    components: componentOverrides ?? [
      {
        category: "input",
        completeness: "known",
        corrected_units: 1200,
        corrected_rate_revision_id: null,
        corrected_cost: null,
        corrected_currency: null,
        note: null,
      },
    ],
    ...rest,
  };
}

export function fxQuoteInput(overrides: Partial<FxQuoteInput> = {}): FxQuoteInput {
  return {
    quote_id: "fx-1",
    enterprise_id: "ent-1",
    workspace_id: "ws-1",
    source: "test-fx",
    source_revision: "2026-06-01",
    quoted_at: "2026-06-01T00:00:00.000Z",
    base_currency: "EUR",
    quote_currency: "USD",
    rate: "1.1",
    ...overrides,
  };
}

/** Fixed-clock store, optionally durable in a fresh temp directory. */
export function makeStore(
  iso: string = "2026-06-01T00:00:00.000Z",
  persistencePath?: string,
): CostStore {
  return new CostStore({ now: () => new Date(iso), persistencePath });
}

export function tempCostFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cost-test-"));
  return path.join(directory, "cost.jsonl");
}
