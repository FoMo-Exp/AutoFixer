import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  LedgerAccessError,
  LedgerConflictError,
  LedgerValidationError,
  USAGE_RECORD_SCHEMA_VERSION,
  UsageLedgerStore,
  buildInvocationUsageRecord,
  validateInvocationUsageRecord,
} from "../src/ledger/index.js";
import type {
  InvocationAttemptObservation,
  LedgerAccessScope,
  UsageLedgerFilter,
} from "../src/ledger/index.js";

const scopeA: LedgerAccessScope = {
  enterprise_id: "ent-1",
  workspace_id: "ws-1",
  subject: "user-1",
};

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "autofixer-usage-"));
}

/** Deterministic store clock: first call 00:00:10Z, then one second per call. */
function fixedNow(): () => Date {
  let step = 0;
  return () => new Date(Date.UTC(2026, 10, 3, 0, 0, 10 + step++, 0));
}

function observation(
  overrides: Partial<InvocationAttemptObservation> & { invocation_id?: string } = {},
): InvocationAttemptObservation {
  const { invocation_id: invocationIdOverride, ...rest } = overrides;
  return {
    identity: {
      enterprise_id: "ent-1",
      workspace_id: "ws-1",
      issue_id: "issue-1",
      run_id: "run-1",
      invocation_id: invocationIdOverride ?? "inv-1",
      trace_id: "trace-1",
    },
    attempt: 1,
    destination: {
      endpoint_id: "ep-1",
      provider: "openai",
      model_id: "gpt-4o",
      internal: false,
    },
    api: "openai-completions",
    started_at: "2026-11-03T00:00:01.000Z",
    ended_at: "2026-11-03T00:00:02.000Z",
    finish_status: "stop",
    provider_request_id: "req_abc",
    returned_model: "gpt-4o-2024-08-06",
    usage_report: {
      source: "transport_reported",
      payload: { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
    },
    ...rest,
  };
}

describe("building one record per invocation attempt", () => {
  test("a completed attempt with reported usage is known and traceable", () => {
    const record = buildInvocationUsageRecord(observation(), "2026-11-03T00:00:03.000Z");
    expect(record.schema_version).toBe(USAGE_RECORD_SCHEMA_VERSION);
    // Identity: enterprise/workspace/issue/run/invocation/trace + attempt.
    expect(record).toMatchObject({
      enterprise_id: "ent-1",
      workspace_id: "ws-1",
      issue_id: "issue-1",
      run_id: "run-1",
      invocation_id: "inv-1",
      trace_id: "trace-1",
      attempt: 1,
    });
    // Provider request id, timing, models and finish status are all recorded.
    expect(record).toMatchObject({
      provider_request_id: "req_abc",
      started_at: "2026-11-03T00:00:01.000Z",
      ended_at: "2026-11-03T00:00:02.000Z",
      finish_status: "stop",
      requested_model: "gpt-4o",
      returned_model: "gpt-4o-2024-08-06",
    });
    expect(record.usage).toMatchObject({
      input: { tokens: 800, completeness: "known" },
      output: { tokens: 200, completeness: "known" },
      total_tokens: 1000,
      completeness: "known",
      provenance: "transport_reported",
    });
    expect(record.metering).toMatchObject({
      adapter_id: "openai-completions",
      unit: "tokens",
      currency: "USD",
      provider_native: true,
    });
  });

  test("model discovery keeps requested and returned model apart", () => {
    const record = buildInvocationUsageRecord(observation(), "2026-11-03T00:00:03.000Z");
    expect(record.requested_model).toBe("gpt-4o");
    expect(record.returned_model).toBe("gpt-4o-2024-08-06");
  });

  test("an unexposed returned model is unknown, not echoed from the request", () => {
    const record = buildInvocationUsageRecord(
      observation({ returned_model: null, provider_request_id: null }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.returned_model).toBeNull();
    expect(record.provider_request_id).toBeNull();
  });

  test("missing usage is unknown, never zero", () => {
    const record = buildInvocationUsageRecord(
      observation({ usage_report: null }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.usage.input).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(record.usage.output.tokens).toBeNull();
    expect(record.usage.cache_read.tokens).toBeNull();
    expect(record.usage.reasoning).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(record.usage.total_tokens).toBeNull();
    expect(record.usage.completeness).toBe("unknown");
    expect(record.usage.provenance).toBe("absent");
  });

  test("a zero-filled transport report is unreported usage, not reported zeros", () => {
    const record = buildInvocationUsageRecord(
      observation({
        usage_report: {
          source: "transport_reported",
          payload: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
      }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.usage.input.tokens).toBeNull();
    expect(record.usage.output.tokens).toBeNull();
    expect(record.usage.completeness).toBe("unknown");
  });

  test("an interrupted attempt's partial figures are estimates, not amounts", () => {
    const record = buildInvocationUsageRecord(
      observation({ finish_status: "error" }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.finish_status).toBe("error");
    // Request-metered figures survive as estimates...
    expect(record.usage.input).toMatchObject({ tokens: 800, completeness: "estimated" });
    // ...but the provider only finalizes output at stream end, so it is
    // unknown — never a stale partial count, never a zero-fill.
    expect(record.usage.output).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(record.usage.total_tokens).toBeNull();
    expect(record.usage.completeness).toBe("estimated");
  });

  test("an interrupted attempt without usage stays unknown", () => {
    const record = buildInvocationUsageRecord(
      observation({ finish_status: "transport_failed", usage_report: null }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.usage.completeness).toBe("unknown");
    expect(record.usage.total_tokens).toBeNull();
  });

  test("provider wire usage is preserved verbatim alongside mapped figures", () => {
    const wire = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 300 },
      completion_tokens_details: { reasoning_tokens: 120 },
    };
    const record = buildInvocationUsageRecord(
      observation({ usage_report: { source: "provider_wire", payload: wire } }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.raw_usage).toEqual(wire);
    expect(record.usage.provenance).toBe("provider_wire");
    // Provider reasoning is mapped distinctly and lives inside output.
    expect(record.usage.reasoning).toMatchObject({ tokens: 120, included_in: "output" });
    expect(record.usage.total_tokens).toBe(1500);
  });

  test("a transport report is preserved verbatim, not just wire payloads", () => {
    const report = { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 };
    const record = buildInvocationUsageRecord(
      observation({ usage_report: { source: "transport_reported", payload: report } }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.raw_usage).toEqual(report);
    expect(record.usage.provenance).toBe("transport_reported");
  });

  test("an unmapped protocol never claims provider-native reconciliation", () => {
    const record = buildInvocationUsageRecord(
      observation({ api: "some-future-protocol" }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.metering).toMatchObject({
      adapter_id: "transport-normalized",
      provider_native: false,
      currency: null,
    });
    // The figures are usable but cannot be reconciled to an invoice frame.
    expect(record.usage.completeness).toBe("estimated");
  });

  test("a wire payload on an unmapped protocol keeps raw evidence but no invented figures", () => {
    const wire = { something_tokens: 42 };
    const record = buildInvocationUsageRecord(
      observation({
        api: "some-future-protocol",
        usage_report: { source: "provider_wire", payload: wire },
      }),
      "2026-11-03T00:00:03.000Z",
    );
    expect(record.raw_usage).toEqual(wire);
    expect(record.usage.input.tokens).toBeNull();
    expect(record.usage.completeness).toBe("unknown");
  });
});

describe("record validation refuses inconsistent figures", () => {
  const base = (): unknown => buildInvocationUsageRecord(observation(), "2026-11-03T00:00:03.000Z");

  test("a total that double-counts an included category is refused", () => {
    const record = base() as Record<string, unknown>;
    const usage = record["usage"] as Record<string, unknown>;
    usage["total_tokens"] = 1800; // 1000 + 500 + 300 cache read counted twice
    expect(() => validateInvocationUsageRecord(record)).toThrow(LedgerValidationError);
  });

  test("a null figure labeled known is refused", () => {
    const record = base() as Record<string, unknown>;
    const usage = record["usage"] as Record<
      string,
      { tokens: number | null; completeness: string }
    >;
    const input = usage["input"];
    if (!input) throw new Error("expected an input figure");
    input.tokens = null;
    expect(() => validateInvocationUsageRecord(record)).toThrow(LedgerValidationError);
  });

  test("a missing total alongside fully known figures is refused", () => {
    const record = base() as Record<string, unknown>;
    const usage = record["usage"] as Record<string, unknown>;
    usage["total_tokens"] = null;
    expect(() => validateInvocationUsageRecord(record)).toThrow(LedgerValidationError);
  });
});

describe("the ledger store records attempts and answers completeness queries", () => {
  test("completeness is an independent query field", () => {
    const store = new UsageLedgerStore({ now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-known" }));
    store.recordAttempt(observation({ invocation_id: "inv-unknown", usage_report: null }));
    store.recordAttempt(observation({ invocation_id: "inv-estimated", finish_status: "error" }));

    const known = store.query(scopeA, { completeness: "known" });
    const unknown = store.query(scopeA, { completeness: "unknown" });
    const estimated = store.query(scopeA, { completeness: "estimated" });
    expect(known.map((r) => r.invocation_id)).toEqual(["inv-known"]);
    expect(unknown.map((r) => r.invocation_id)).toEqual(["inv-unknown"]);
    expect(estimated.map((r) => r.invocation_id)).toEqual(["inv-estimated"]);
  });

  test("retries and fallbacks each produce their own ledger entry", () => {
    const store = new UsageLedgerStore({ now: fixedNow() });
    store.recordAttempt(
      observation({
        invocation_id: "inv-a",
        attempt: 1,
        finish_status: "error",
        usage_report: null,
      }),
    );
    store.recordAttempt(observation({ invocation_id: "inv-b", attempt: 2 }));
    store.recordAttempt(
      observation({
        invocation_id: "inv-c",
        attempt: 3,
        destination: {
          endpoint_id: "ep-fallback",
          provider: "openai",
          model_id: "gpt-4o-mini",
          internal: false,
        },
      }),
    );
    const all = store.query(scopeA);
    expect(all.map((r) => [r.attempt, r.endpoint_id])).toEqual([
      [1, "ep-1"],
      [2, "ep-1"],
      [3, "ep-fallback"],
    ]);
  });

  test("reads are confined to the authenticated scope and cross-workspace asks are refused", () => {
    const store = new UsageLedgerStore({ now: fixedNow() });
    store.recordAttempt(observation());
    expect(store.query(scopeA)).toHaveLength(1);
    expect(store.query({ ...scopeA, workspace_id: "ws-other" })).toHaveLength(0);
    expect(() =>
      store.query(scopeA, { workspace_id: "ws-other" } satisfies UsageLedgerFilter),
    ).toThrow(LedgerAccessError);
    expect(() => store.query(scopeA, { enterprise_id: "ent-other" })).toThrow(LedgerAccessError);
  });

  test("redelivery deduplicates; changed content is refused", () => {
    const store = new UsageLedgerStore({ now: fixedNow() });
    const first = observation();
    store.recordAttempt(first);
    store.recordAttempt(first);
    expect(store.query(scopeA)).toHaveLength(1);
    expect(() => store.recordAttempt(observation({ provider_request_id: "req_other" }))).toThrow(
      LedgerConflictError,
    );
    // A different attempt number is a different entry, never a conflict.
    store.recordAttempt(observation({ attempt: 2 }));
    expect(store.query(scopeA)).toHaveLength(2);
  });

  test("malformed filters are refused instead of silently matching nothing", () => {
    const store = new UsageLedgerStore({ now: fixedNow() });
    expect(() => store.query(scopeA, { since: "yesterday" })).toThrow(LedgerValidationError);
    expect(() => store.query(scopeA, { attempt: 0 })).toThrow(LedgerValidationError);
  });
});

describe("durable ledger persistence", () => {
  test("a record is durable the moment recordAttempt returns — no flush needed", () => {
    const file = path.join(tempDir(), "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation());

    // A second store over the same file — as after a crash or restart — sees
    // the record without any explicit flush or shutdown step.
    const reloaded = new UsageLedgerStore({ persistencePath: file });
    const records = reloaded.query(scopeA);
    expect(records).toHaveLength(1);
    expect(records[0]?.usage.total_tokens).toBe(1000);
  });

  test("a persistence failure fails the record and keeps nothing", () => {
    const dir = tempDir();
    const blocker = path.join(dir, "not-a-directory");
    writeFileSync(blocker, "occupied", "utf8");
    // The parent path is a regular file: neither the directory nor the append
    // can be created, so the write must fail loudly.
    const store = new UsageLedgerStore({
      persistencePath: path.join(blocker, "usage-ledger.jsonl"),
      now: fixedNow(),
    });
    expect(() => store.recordAttempt(observation())).toThrow();
    // The failed attempt is recorded nowhere — not in memory either.
    expect(store.query(scopeA)).toHaveLength(0);
  });

  test("corruption anywhere in the body refuses startup", () => {
    const dir = tempDir();
    const file = path.join(dir, "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-1" }));
    store.recordAttempt(observation({ invocation_id: "inv-2" }));
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "");

    // Garbage between intact records is corruption: history is never dropped
    // silently.
    const midFile = path.join(dir, "mid.jsonl");
    writeFileSync(midFile, [lines[0], "not json", lines[1]].join("\n"), "utf8");
    expect(() => new UsageLedgerStore({ persistencePath: midFile })).toThrow(
      /refusing to drop history/,
    );

    // A complete-but-invalid record line in the body is corruption too — even
    // though its JSON parses.
    const invalidLine = path.join(dir, "invalid-mid.jsonl");
    writeFileSync(invalidLine, [lines[0], '{"schema_version":99}', lines[1]].join("\n"), "utf8");
    expect(() => new UsageLedgerStore({ persistencePath: invalidLine })).toThrow(
      /refusing to drop history/,
    );
  });

  test("a complete but invalid final line refuses startup", () => {
    const dir = tempDir();
    const file = path.join(dir, "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-1" }));
    const [line] = readFileSync(file, "utf8").split("\n");

    // Newline-terminated: a complete write whose record does not validate is
    // corruption, never a torn append.
    const terminated = path.join(dir, "terminated.jsonl");
    writeFileSync(terminated, [line, '{"schema_version":99}', ""].join("\n"), "utf8");
    expect(() => new UsageLedgerStore({ persistencePath: terminated })).toThrow(
      /refusing to drop history/,
    );

    // Unterminated but complete JSON: still corruption — only confirmed
    // incomplete tail bytes are tolerated.
    const unterminated = path.join(dir, "unterminated.jsonl");
    writeFileSync(unterminated, [line, '{"schema_version":99}'].join("\n"), "utf8");
    expect(() => new UsageLedgerStore({ persistencePath: unterminated })).toThrow(
      /refusing to drop history/,
    );
  });

  test("garbage that is not an interrupted append refuses startup", () => {
    const dir = tempDir();
    const file = path.join(dir, "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-1" }));
    const [line] = readFileSync(file, "utf8").split("\n");

    const garbage = path.join(dir, "garbage.jsonl");
    writeFileSync(garbage, [line, "not json"].join("\n"), "utf8");
    expect(() => new UsageLedgerStore({ persistencePath: garbage })).toThrow(
      /refusing to drop history/,
    );
  });

  test("a complete tail record that lost only its newline is kept and re-terminated", () => {
    const dir = tempDir();
    const file = path.join(dir, "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-1" }));
    const [line] = readFileSync(file, "utf8").split("\n");
    // A second record whose bytes are complete but whose newline was lost.
    const second = JSON.stringify(
      buildInvocationUsageRecord(
        observation({ invocation_id: "inv-2" }),
        "2026-11-03T00:00:03.000Z",
      ),
    );
    writeFileSync(file, [line, second].join("\n"), "utf8");

    const recovered = new UsageLedgerStore({ persistencePath: file });
    expect(recovered.query(scopeA).map((r) => r.invocation_id)).toEqual(["inv-1", "inv-2"]);

    // The repair re-terminated it, so a later append and restart stay intact.
    recovered.recordAttempt(observation({ invocation_id: "inv-3" }));
    const restarted = new UsageLedgerStore({ persistencePath: file });
    expect(restarted.query(scopeA).map((r) => r.invocation_id)).toEqual([
      "inv-1",
      "inv-2",
      "inv-3",
    ]);
  });

  test("an interrupted append is dropped at the record boundary and later appends stay readable", () => {
    const dir = tempDir();
    const file = path.join(dir, "usage-ledger.jsonl");
    const store = new UsageLedgerStore({ persistencePath: file, now: fixedNow() });
    store.recordAttempt(observation({ invocation_id: "inv-1" }));
    const [line] = readFileSync(file, "utf8").split("\n");

    // An append interrupted mid-write leaves incomplete tail bytes.
    writeFileSync(file, [line, '{"schema_version":1,"entr'].join("\n"), "utf8");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const recovered = new UsageLedgerStore({ persistencePath: file });
      expect(recovered.query(scopeA).map((r) => r.invocation_id)).toEqual(["inv-1"]);

      // Recovery truncated the debris to the record boundary, so this append
      // cannot merge into it and the next startup stays readable.
      recovered.recordAttempt(observation({ invocation_id: "inv-3" }));
    } finally {
      quiet.mockRestore();
    }
    const restarted = new UsageLedgerStore({ persistencePath: file });
    expect(restarted.query(scopeA).map((r) => r.invocation_id)).toEqual(["inv-1", "inv-3"]);
  });
});
