/**
 * The durable cost store (DAT-228): immutability under redelivery, link
 * integrity of adjustments, scope isolation, and honest torn-tail recovery —
 * financial evidence is either durably recorded or refused loudly.
 */
import fs from "node:fs";

import { describe, expect, test } from "vitest";

import {
  CostAccessError,
  CostConflictError,
  CostStore,
  CostValidationError,
  CostWriteError,
  netPosting,
} from "../src/cost/index.js";
import {
  SCOPE,
  OTHER_SCOPE,
  adjustmentInput,
  fxQuoteInput,
  infrastructureInput,
  invocationInput,
  makeStore,
  rateInput,
  tempCostFile,
} from "./helpers/cost-fixtures.js";

describe("immutable writes", () => {
  test("a redelivery of identical content deduplicates; changed content is refused", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    const first = store.recordInvocationCost(invocationInput());
    const second = store.recordInvocationCost(invocationInput());
    expect(second).toEqual(first);
    expect(store.postings(SCOPE)).toHaveLength(1);
    // Different content under the same invocation identity: refused, never
    // rewritten over the recorded financial evidence.
    expect(() =>
      store.recordInvocationCost(
        invocationInput({
          usage: { input: { tokens: 9999, completeness: "known", included_in: null } },
        }),
      ),
    ).toThrow(CostConflictError);
  });

  test("a rate change never reprices an already-recorded posting", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-old", category: "input", rate: "0.003" }));
    const before = store.recordInvocationCost(invocationInput());
    store.addRateRevision(
      rateInput({
        revision_id: "rev-new",
        category: "input",
        rate: "0.010",
        effective_from: "2026-06-01T00:00:00.000Z",
      }),
    );
    // The posting still carries its snapshot; new invocations bind the new
    // revision at their own applicable time.
    expect(store.postings(SCOPE)[0]).toEqual(before);
    expect(
      store
        .recordInvocationCost(invocationInput({ invocation_id: "inv-2" }))
        .components.find((line) => line.category === "input"),
    ).toMatchObject({ cost: "0.010000000000", rate_revision_id: "rev-new" });
  });

  test("a second revision with the same scope and effective start is refused", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-a" }));
    expect(() => store.addRateRevision(rateInput({ revision_id: "rev-b" }))).toThrow(
      CostConflictError,
    );
  });

  test("an identical rate-revision redelivery returns the recorded revision unchanged", () => {
    // An advancing clock proves the returned record is the recorded one, not
    // a freshly re-stamped rebuild.
    let tick = 0;
    const store = new CostStore({
      now: () => new Date(Date.parse("2026-06-01T00:00:00.000Z") + tick++ * 1000),
    });
    const first = store.addRateRevision(rateInput({ revision_id: "rev-a" }));
    const second = store.addRateRevision(rateInput({ revision_id: "rev-a" }));
    expect(second).toBe(first);
    expect(store.rateRevisions(SCOPE)).toHaveLength(1);
    // Same identity, changed content: still refused.
    expect(() => store.addRateRevision(rateInput({ revision_id: "rev-a", rate: "0.9" }))).toThrow(
      CostConflictError,
    );
    // Different identity on the same binding key and start: still refused.
    expect(() => store.addRateRevision(rateInput({ revision_id: "rev-b" }))).toThrow(
      CostConflictError,
    );
    expect(store.rateRevisions(SCOPE)).toHaveLength(1);
  });

  test("quote and adjustment identities are immutable too", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.recordInvocationCost(invocationInput());
    store.recordAdjustment(adjustmentInput());
    store.addFxQuote(fxQuoteInput());
    expect(() => store.recordAdjustment(adjustmentInput({ note: "different" }))).toThrow(
      CostConflictError,
    );
    expect(() => store.addFxQuote(fxQuoteInput({ rate: "9" }))).toThrow(CostConflictError);
  });
});

describe("adjustment link integrity", () => {
  test("an adjustment must target a recorded posting of its own scope", () => {
    const store = makeStore();
    expect(() => store.recordAdjustment(adjustmentInput())).toThrow(CostValidationError);
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.recordInvocationCost(invocationInput());
    // Same target identity, different workspace: refused at the boundary.
    expect(() =>
      store.recordAdjustment(adjustmentInput({ enterprise_id: "ent-1", workspace_id: "ws-2" })),
    ).toThrow(CostAccessError);
    expect(() => store.recordAdjustment(adjustmentInput())).not.toThrow();
  });

  test("corrections must land on chargeable lines the posting carries", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.addRateRevision(
      rateInput({ revision_id: "rev-re", category: "reasoning", rate: "0.012" }),
    );
    store.recordInvocationCost(
      invocationInput({
        usage: { reasoning: { tokens: 200, completeness: "known", included_in: "output" } },
      }),
    );
    // Reasoning is recorded as included-in-output: never charged, never correctable.
    expect(() =>
      store.recordAdjustment(
        adjustmentInput({
          components: [
            {
              category: "reasoning",
              completeness: "known",
              corrected_units: 1,
              corrected_rate_revision_id: null,
              corrected_cost: null,
              corrected_currency: null,
              note: null,
            },
          ],
        }),
      ),
    ).toThrow(CostValidationError);
    expect(() =>
      store.recordAdjustment(
        adjustmentInput({
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
        }),
      ),
    ).toThrow(CostValidationError);
  });

  test("adjustment rebinds are vetted at record time and stay replayable", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.addRateRevision(rateInput({ revision_id: "rev-out", category: "output", rate: "0.006" }));
    store.addRateRevision(
      rateInput({ revision_id: "rev-ws2", category: "input", workspace_id: "ws-2" }),
    );
    store.addRateRevision(
      rateInput({
        revision_id: "rev-self",
        category: "input",
        target: "self_hosted",
        source: "administrator",
      }),
    );
    store.recordInvocationCost(invocationInput());

    const rebind = (revisionId: string) =>
      adjustmentInput({
        components: [
          {
            category: "input",
            completeness: "known",
            corrected_units: 1000,
            corrected_rate_revision_id: revisionId,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
        ],
      });

    // Unrecorded revision: refused — a stored adjustment must always replay.
    expect(() => store.recordAdjustment(rebind("rev-missing"))).toThrow(CostValidationError);
    // Another category's rate must never reprice this line.
    expect(() => store.recordAdjustment(rebind("rev-out"))).toThrow(CostValidationError);
    // Foreign workspace scope.
    expect(() => store.recordAdjustment(rebind("rev-ws2"))).toThrow(CostValidationError);
    // Foreign deployment target.
    expect(() => store.recordAdjustment(rebind("rev-self"))).toThrow(CostValidationError);
    // A compatible rebind records — and the recorded correction replays.
    expect(store.recordAdjustment(rebind("rev-in")).components[0]?.corrected_rate_revision_id).toBe(
      "rev-in",
    );
    const entry = store.entries(SCOPE, { invocation_id: "inv-1" })[0];
    expect(entry).toBeDefined();
    const net = netPosting(entry!, store.rateRevisions(SCOPE));
    expect(net.components.find((line) => line.category === "input")).toMatchObject({
      cost: "0.003000000000",
      rate_revision_id: "rev-in",
    });
  });

  test("an infrastructure rebind must match the corrected line's unit", () => {
    const store = makeStore();
    store.addRateRevision(
      rateInput({
        revision_id: "rev-gpu",
        target: "self_hosted",
        source: "measured",
        category: "infrastructure",
        unit: "gpu_seconds",
        divisor: 1,
        rate: "0.0001",
      }),
    );
    store.addRateRevision(
      rateInput({
        revision_id: "rev-core",
        target: "self_hosted",
        source: "measured",
        category: "infrastructure",
        unit: "core_seconds",
        divisor: 1,
        rate: "0.0001",
      }),
    );
    store.recordInfrastructureCost(
      infrastructureInput({ entry_key: "infra-1", unit: "gpu_seconds" }),
    );

    const rebind = (revisionId: string) =>
      adjustmentInput({
        target_posting_id: "cost-infra:infra-1",
        components: [
          {
            category: "infrastructure",
            completeness: "known",
            corrected_units: 10,
            corrected_rate_revision_id: revisionId,
            corrected_cost: null,
            corrected_currency: null,
            note: null,
          },
        ],
      });

    // A core-seconds rate must never reprice a gpu-seconds charge.
    expect(() => store.recordAdjustment(rebind("rev-core"))).toThrow(CostValidationError);
    expect(store.recordAdjustment(rebind("rev-gpu")).components[0]?.corrected_units).toBe(10);
  });
});

describe("scope isolation", () => {
  test("financial reads never cross workspace boundaries silently", () => {
    const store = makeStore();
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.recordInvocationCost(invocationInput());
    expect(store.postings(OTHER_SCOPE)).toEqual([]);
    expect(store.rateRevisions(OTHER_SCOPE)).toEqual([]);
    expect(() => store.postings(SCOPE, { workspace_id: "ws-2" })).toThrow(CostAccessError);
    expect(() => store.postings(SCOPE, { enterprise_id: "ent-2" })).toThrow(CostAccessError);
    expect(() => store.postings({ enterprise_id: "", workspace_id: "ws-1", subject: "s" })).toThrow(
      CostValidationError,
    );
    // Malformed bounds are refused instead of silently matching nothing.
    expect(() => store.postings(SCOPE, { since: "someday" })).toThrow(CostValidationError);
    expect(() => store.postings(SCOPE, { attempt: 0 })).toThrow(CostValidationError);
  });

  test("filters and entry wiring carry posting plus linked adjustments", () => {
    const store = makeStore();
    for (const category of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
      store.addRateRevision(rateInput({ revision_id: `rev-${category}`, category, rate: "0.003" }));
    }
    store.recordInvocationCost(invocationInput());
    store.recordInvocationCost(
      invocationInput({
        invocation_id: "inv-2",
        started_at: "2026-07-01T00:00:00.000Z",
        usage: {
          input: { tokens: null, completeness: "unknown", included_in: null },
          completeness: "unknown",
        },
      }),
    );
    store.recordAdjustment(adjustmentInput());
    expect(store.postings(SCOPE, { invocation_id: "inv-1" })).toHaveLength(1);
    expect(
      store.postings(SCOPE, { since: "2026-06-15T00:00:00.000Z" }).map((p) => p.invocation_id),
    ).toEqual(["inv-2"]);
    expect(store.postings(SCOPE, { completeness: "unknown" }).map((p) => p.invocation_id)).toEqual([
      "inv-2",
    ]);
    const entries = store.entries(SCOPE, { invocation_id: "inv-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.adjustments.map((a) => a.adjustment_id)).toEqual(["adj-1"]);
    expect(store.adjustments(SCOPE, "cost-inv:inv-1:1")).toHaveLength(1);
    expect(store.adjustments(SCOPE, "cost-inv:inv-2:1")).toHaveLength(0);
  });
});

describe("durable persistence", () => {
  test("records round-trip through the durable file and reload intact", () => {
    const file = tempCostFile();
    const store = makeStore("2026-06-01T00:00:00.000Z", file);
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    store.recordInvocationCost(invocationInput());
    store.recordAdjustment(adjustmentInput());
    store.addFxQuote(fxQuoteInput());

    const reloaded = makeStore("2026-06-05T00:00:00.000Z", file);
    expect(reloaded.rateRevisions(SCOPE)).toEqual(store.rateRevisions(SCOPE));
    expect(reloaded.postings(SCOPE)).toEqual(store.postings(SCOPE));
    expect(reloaded.adjustments(SCOPE)).toEqual(store.adjustments(SCOPE));
    expect(reloaded.fxQuotes(SCOPE)).toEqual(store.fxQuotes(SCOPE));
  });

  test("a torn trailing append is dropped at the record boundary and repaired", () => {
    const file = tempCostFile();
    const store = makeStore("2026-06-01T00:00:00.000Z", file);
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    // Simulate an append interrupted mid-write: confirmed-incomplete JSON.
    fs.appendFileSync(file, '{"record_type":"posting","payload":{"TORN_APPEND');

    const reloaded = makeStore("2026-06-05T00:00:00.000Z", file);
    expect(reloaded.rateRevisions(SCOPE)).toHaveLength(1);
    // The repaired file no longer carries the debris.
    expect(fs.readFileSync(file, "utf8")).not.toContain("TORN_APPEND");
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("a complete-but-invalid tail is corruption and refuses startup", () => {
    const file = tempCostFile();
    const store = makeStore("2026-06-01T00:00:00.000Z", file);
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    fs.appendFileSync(file, '{"record_type":"posting","payload":{}}');
    expect(() => makeStore("2026-06-05T00:00:00.000Z", file)).toThrow(CostValidationError);
  });

  test("a corrupt line anywhere is corruption and refuses startup", () => {
    const file = tempCostFile();
    const store = makeStore("2026-06-01T00:00:00.000Z", file);
    store.addRateRevision(rateInput({ revision_id: "rev-in", category: "input" }));
    fs.appendFileSync(file, "not json at all\n");
    expect(() => makeStore("2026-06-05T00:00:00.000Z", file)).toThrow(CostValidationError);
  });

  test("a persistence failure is loud: the record is recorded nowhere", () => {
    const file = tempCostFile();
    // A regular file where a directory must be: every durable write fails.
    fs.writeFileSync(file, "");
    const store = new CostStore({
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      persistencePath: `${file}/nested/cost.jsonl`,
    });
    expect(() => store.addRateRevision(rateInput())).toThrow(CostWriteError);
    // Nothing half-recorded: the store stays empty and honest.
    expect(store.rateRevisions(SCOPE)).toEqual([]);
  });
});
