import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Usage } from "@mariozechner/pi-ai";
import { describe, expect, test, vi } from "vitest";

import type { GatewayPolicy } from "../src/index.js";
import { DATA_CLASSES } from "../src/gateway/index.js";
import { UsageLedgerStore } from "../src/ledger/index.js";
import type { InvocationUsageRecord, LedgerAccessScope } from "../src/ledger/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_BINDING,
  TEST_CREDENTIAL_REF,
  TEST_ENDPOINT_BASE_URL,
  scriptedGateway,
  testPolicyFor,
} from "./helpers/test-gateway.js";

const SCOPE: LedgerAccessScope = {
  enterprise_id: TEST_BINDING.enterpriseId,
  workspace_id: TEST_BINDING.workspaceId,
  subject: "gateway-usage-test",
};

function usage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: usage({}),
    timestamp: Date.now(),
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    ...overrides,
  };
}

/** A stream that completes with a provider terminal message. */
function doneStream(terminal: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: terminal });
  });
  return stream;
}

/** A stream that fails before any content: the retryable pre-content path. */
function errorBeforeContentStream(terminal: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: terminal });
  });
  return stream;
}

/** Content flows and the stream completes normally (post-handoff path). */
function contentThenDoneStream(terminal: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = message({ content: [{ type: "text", text: "hello" }] });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...partial, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
    stream.push({ type: "done", reason: "stop", message: terminal });
  });
  return stream;
}

/** Content is flowing, then the provider stream dies mid-flight. */
function contentThenErrorStream(terminal: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = message({ content: [{ type: "text", text: "partial" }] });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...partial, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
    stream.push({ type: "error", reason: "error", error: terminal });
  });
  return stream;
}

function ledgerWith(): { ledger: UsageLedgerStore; records: () => InvocationUsageRecord[] } {
  const ledger = new UsageLedgerStore();
  return { ledger, records: () => ledger.query(SCOPE) };
}

function one(records: InvocationUsageRecord[]): InvocationUsageRecord {
  const record = records[0];
  if (!record) {
    throw new Error("expected exactly one ledger record");
  }
  return record;
}

async function waitForRecorded(
  records: () => InvocationUsageRecord[],
  count: number,
): Promise<InvocationUsageRecord[]> {
  await vi.waitFor(() => expect(records()).toHaveLength(count));
  return records();
}

describe("the gateway meters every actual invocation attempt", () => {
  test("a successful dispatch records identity, timing, finish status and usage", async () => {
    const { ledger, records } = ledgerWith();
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        doneStream(
          message({
            usage: usage({ input: 800, output: 200, totalTokens: 1000 }),
            responseId: "req_123",
          }),
        ),
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const record = one(await waitForRecorded(records, 1));
    expect(record).toMatchObject({
      enterprise_id: TEST_BINDING.enterpriseId,
      workspace_id: TEST_BINDING.workspaceId,
      issue_id: TEST_BINDING.issueId,
      run_id: TEST_BINDING.runId,
      trace_id: TEST_BINDING.traceId,
      attempt: 1,
      endpoint_id: "ep_test",
      provider: "openai",
      api: "openai-completions",
      requested_model: "scripted",
      provider_request_id: "req_123",
      finish_status: "stop",
    });
    expect(record.usage).toMatchObject({
      input: { tokens: 800, completeness: "known" },
      output: { tokens: 200, completeness: "known" },
      total_tokens: 1000,
      completeness: "known",
      provenance: "transport_reported",
    });
    // Timing is traceable on the record itself.
    expect(Date.parse(record.ended_at)).toBeGreaterThanOrEqual(Date.parse(record.started_at));
  });

  test("provider request id and the discovered model stay apart from the request", async () => {
    const ledger = new UsageLedgerStore();
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        doneStream(
          message({
            usage: usage({ input: 10, output: 5, totalTokens: 15 }),
            responseId: "req_discovered",
            responseModel: "gpt-4o-2024-08-06",
          }),
        ),
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const record = one(
      await vi.waitFor(() => {
        const found = ledger.query(SCOPE);
        expect(found).toHaveLength(1);
        return Promise.resolve(found);
      }),
    );
    expect(record.requested_model).toBe("scripted");
    expect(record.returned_model).toBe("gpt-4o-2024-08-06");
    expect(record.provider_request_id).toBe("req_discovered");
  });

  test("retries each produce their own ledger entry", async () => {
    const ledger = new UsageLedgerStore();
    let call = 0;
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        call += 1;
        return call === 1
          ? errorBeforeContentStream(
              message({
                content: [],
                stopReason: "error",
                errorMessage: "connection reset",
                usage: usage({}),
              }),
            )
          : doneStream(message({ usage: usage({ input: 50, output: 10, totalTokens: 60 }) }));
      },
      {
        policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
        usageLedger: ledger,
      },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const entries = await vi.waitFor(() => {
      const found = ledger.query(SCOPE);
      expect(found).toHaveLength(2);
      return Promise.resolve(found);
    });
    const [primary, retry] = entries;
    expect([primary?.attempt, primary?.finish_status]).toEqual([1, "error"]);
    expect([retry?.attempt, retry?.finish_status]).toEqual([2, "stop"]);
    // Distinct invocation ids per attempt: retry consumption is auditable.
    expect(primary?.invocation_id).not.toBe(retry?.invocation_id);
    expect(primary?.usage.completeness).toBe("unknown");
    expect(retry?.usage.completeness).toBe("known");
  });

  test("a fallback attempt records its own entry on the fallback destination", async () => {
    const ledger = new UsageLedgerStore();
    const policy: GatewayPolicy = {
      revision: "test-policy-1",
      endpoints: [
        {
          endpointId: "ep_test",
          provider: "openai",
          api: "openai-completions",
          baseUrl: TEST_ENDPOINT_BASE_URL,
          internal: false,
          credentialRef: TEST_CREDENTIAL_REF,
          models: ["scripted"],
          permittedDataClasses: [...DATA_CLASSES],
        },
        {
          endpointId: "ep_fallback",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://fallback.test/v1",
          internal: false,
          credentialRef: TEST_CREDENTIAL_REF,
          models: ["gpt-4o-mini"],
          permittedDataClasses: [...DATA_CLASSES],
        },
      ],
      retry: { maxAttempts: 1 },
      fallbacks: [{ endpointId: "ep_fallback", modelId: "gpt-4o-mini" }],
    };
    let call = 0;
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        call += 1;
        return call === 1
          ? errorBeforeContentStream(
              message({
                content: [],
                stopReason: "error",
                errorMessage: "connection reset",
                usage: usage({}),
              }),
            )
          : doneStream(message({ usage: usage({ input: 30, output: 20, totalTokens: 50 }) }));
      },
      { policy, usageLedger: ledger },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const entries = await vi.waitFor(() => {
      const found = ledger.query(SCOPE);
      expect(found).toHaveLength(2);
      return Promise.resolve(found);
    });
    const [primary, fallback] = entries;
    expect(primary).toMatchObject({
      attempt: 1,
      endpoint_id: "ep_test",
      requested_model: "scripted",
    });
    expect(fallback).toMatchObject({
      attempt: 2,
      endpoint_id: "ep_fallback",
      requested_model: "gpt-4o-mini",
      finish_status: "stop",
    });
    expect(fallback?.usage.total_tokens).toBe(50);
  });
});

describe("missing usage is unknown, never zero", () => {
  test("a completed stream whose provider sent no usage records unknown", async () => {
    const ledger = new UsageLedgerStore();
    // All-zero usage is the transport's unreported-usage zero-fill.
    const gw = scriptedGateway(TEST_MODEL, () => doneStream(message()), {
      usageLedger: ledger,
    }).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const record = one(
      await vi.waitFor(() => {
        const found = ledger.query(SCOPE);
        expect(found).toHaveLength(1);
        return Promise.resolve(found);
      }),
    );
    expect(record.usage.input.tokens).toBeNull();
    expect(record.usage.output.tokens).toBeNull();
    expect(record.usage.total_tokens).toBeNull();
    expect(record.usage.completeness).toBe("unknown");
    expect(record.usage.provenance).toBe("transport_reported");
  });

  test("a mid-stream interruption records estimated partial figures, not zero-fill", async () => {
    const ledger = new UsageLedgerStore();
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        contentThenErrorStream(
          message({
            content: [],
            stopReason: "error",
            errorMessage: "stream interrupted",
            // The provider reported the prompt before the stream died; the
            // output count never arrived.
            usage: usage({ input: 800, totalTokens: 800 }),
          }),
        ),
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    const stream = await gw(TEST_MODEL, { messages: [] }, undefined);
    for await (const _event of stream) {
      // Drain the handed-off stream so the background terminal is reached.
    }

    const record = one(
      await vi.waitFor(() => {
        const found = ledger.query(SCOPE);
        expect(found).toHaveLength(1);
        return Promise.resolve(found);
      }),
    );
    expect(record.finish_status).toBe("error");
    // The request-metered figure survives as an estimate; output is only
    // finalized at stream end, so it stays unknown — never a zero-fill.
    expect(record.usage.input).toMatchObject({ tokens: 800, completeness: "estimated" });
    expect(record.usage.output).toMatchObject({ tokens: null, completeness: "unknown" });
    expect(record.usage.completeness).toBe("estimated");
    expect(record.usage.total_tokens).toBeNull();
  });

  test("an interruption that reported nothing records unknown usage", async () => {
    const ledger = new UsageLedgerStore();
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        contentThenErrorStream(
          message({ content: [], stopReason: "error", errorMessage: "stream interrupted" }),
        ),
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    const stream = await gw(TEST_MODEL, { messages: [] }, undefined);
    for await (const _event of stream) {
      // Drain.
    }

    const record = one(
      await vi.waitFor(() => {
        const found = ledger.query(SCOPE);
        expect(found).toHaveLength(1);
        return Promise.resolve(found);
      }),
    );
    expect(record.usage.completeness).toBe("unknown");
    expect(record.usage.input.tokens).toBeNull();
    expect(record.usage.total_tokens).toBeNull();
  });

  test("a dispatch failure records transport_failed with unknown usage", async () => {
    const ledger = new UsageLedgerStore();
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    await expect(gw(TEST_MODEL, { messages: [] }, undefined)).rejects.toThrow(
      /model dispatch failed/,
    );

    const record = one(
      await vi.waitFor(() => {
        const found = ledger.query(SCOPE);
        expect(found).toHaveLength(1);
        return Promise.resolve(found);
      }),
    );
    expect(record.finish_status).toBe("transport_failed");
    expect(record.usage.completeness).toBe("unknown");
    expect(record.usage.provenance).toBe("absent");
    expect(record.provider_request_id).toBeNull();
  });

  test("attempts denied before dispatch record no usage", async () => {
    const ledger = new UsageLedgerStore();
    const gw = scriptedGateway(TEST_MODEL, () => doneStream(message()), {
      // The policy approves only an unrelated model: the request is denied
      // before any dispatch, so no attempt ever runs.
      policy: testPolicyFor({ ...TEST_MODEL, id: "unrelated-model" }),
      usageLedger: ledger,
    }).bind(TEST_BINDING);
    await expect(gw(TEST_MODEL, { messages: [] }, undefined)).rejects.toMatchObject({
      name: "ModelEgressDeniedError",
    });
    expect(ledger.query(SCOPE)).toHaveLength(0);
  });
});

describe("usage records feed independent completeness queries", () => {
  test("known, estimated and unknown attempts separate cleanly", async () => {
    const ledger = new UsageLedgerStore();
    let call = 0;
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        call += 1;
        if (call === 1) {
          return doneStream(message({ usage: usage({ input: 10, output: 5, totalTokens: 15 }) }));
        }
        if (call === 2) {
          return doneStream(message());
        }
        return contentThenErrorStream(
          message({
            content: [],
            stopReason: "error",
            errorMessage: "boom",
            usage: usage({ input: 40, totalTokens: 40 }),
          }),
        );
      },
      {
        policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 1 }, fallbacks: [] }),
        usageLedger: ledger,
      },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);
    await gw(TEST_MODEL, { messages: [] }, undefined);
    const stream = await gw(TEST_MODEL, { messages: [] }, undefined);
    for await (const _event of stream) {
      // Drain.
    }

    await vi.waitFor(() => expect(ledger.query(SCOPE)).toHaveLength(3));
    expect(ledger.query(SCOPE, { completeness: "known" })).toHaveLength(1);
    expect(ledger.query(SCOPE, { completeness: "unknown" })).toHaveLength(1);
    expect(ledger.query(SCOPE, { completeness: "estimated" })).toHaveLength(1);
    expect(
      ledger
        .query(SCOPE, { completeness: "known" })
        .map((r: InvocationUsageRecord) => r.usage.total_tokens),
    ).toEqual([15]);
  });
});

describe("ledger writes are awaited, durable and fail closed", () => {
  test("the dispatch settles only after the usage record is persisted", async () => {
    const inner = new UsageLedgerStore();
    let settled = false;
    const slowLedger = {
      recordAttempt(observation: Parameters<UsageLedgerStore["recordAttempt"]>[0]) {
        // An async sink that persists later than the dispatch would return.
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            inner.recordAttempt(observation);
            settled = true;
            resolve();
          }, 20);
        });
      },
    };
    const gw = scriptedGateway(TEST_MODEL, () => doneStream(message()), {
      usageLedger: slowLedger,
    }).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    // No waiting games: if the gateway did not await the sink, the record
    // would still be missing here.
    expect(settled).toBe(true);
    expect(inner.query(SCOPE)).toHaveLength(1);
  });

  test("a ledger write failure fails the dispatch without re-dispatching", async () => {
    let calls = 0;
    const failingLedger = {
      recordAttempt() {
        throw new Error("ledger disk full");
      },
    };
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        calls += 1;
        return doneStream(message({ usage: usage({ input: 10, output: 5, totalTokens: 15 }) }));
      },
      { usageLedger: failingLedger },
    ).bind(TEST_BINDING);

    // The provider answered, but its usage could not be recorded: the call is
    // not handed back as a recorded success.
    await expect(gw(TEST_MODEL, { messages: [] }, undefined)).rejects.toThrow(
      /usage ledger write failed/,
    );
    // An accounting failure is never retried: no second provider dispatch.
    expect(calls).toBe(1);
  });

  test("a ledger write failure never rewrites a transport failure's retry verdict", async () => {
    let calls = 0;
    const failingLedger = {
      recordAttempt() {
        throw new Error("ledger disk full");
      },
    };
    const gw = scriptedGateway(
      TEST_MODEL,
      () => {
        calls += 1;
        return errorBeforeContentStream(
          message({ content: [], stopReason: "error", errorMessage: "connection reset" }),
        );
      },
      {
        policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
        usageLedger: failingLedger,
      },
    ).bind(TEST_BINDING);

    // The transport failure decides retryability; the broken ledger write is
    // an incident on the side, not a new verdict.
    await expect(gw(TEST_MODEL, { messages: [] }, undefined)).rejects.toThrow(
      /model dispatch failed after 2 attempt/,
    );
    expect(calls).toBe(2);
  });

  test("post-handoff, a delivered stream stands when the ledger write fails", async () => {
    const failingLedger = {
      recordAttempt() {
        throw new Error("ledger disk full");
      },
    };
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        contentThenDoneStream(message({ usage: usage({ input: 10, output: 5, totalTokens: 15 }) })),
      { usageLedger: failingLedger },
    ).bind(TEST_BINDING);
    const stream = await gw(TEST_MODEL, { messages: [] }, undefined);
    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    // Content already delivered cannot be retracted by an accounting failure.
    expect(events).toContain("text_delta");
    expect(events).toContain("done");
  });
});

describe("the ledger keeps the actual reported provider usage", () => {
  test("the transport's usage report is preserved verbatim on the record", async () => {
    const ledger = new UsageLedgerStore();
    const reported = {
      input: 800,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1000,
      cost: { input: 0.0024, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.0054 },
    };
    const gw = scriptedGateway(TEST_MODEL, () => doneStream(message({ usage: reported })), {
      usageLedger: ledger,
    }).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const records = ledger.query(SCOPE);
    expect(records).toHaveLength(1);
    expect(records[0]?.raw_usage).toEqual(reported);
    expect(records[0]?.usage.provenance).toBe("transport_reported");
  });

  test("a wire-exposing transport's provider usage is recorded as provider_wire", async () => {
    const ledger = new UsageLedgerStore();
    const wire = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 300 },
      completion_tokens_details: { reasoning_tokens: 120 },
    };
    const gw = scriptedGateway(
      TEST_MODEL,
      () =>
        doneStream(
          message({
            diagnostics: [{ type: "provider_usage", timestamp: Date.now(), details: wire }],
          }),
        ),
      { usageLedger: ledger },
    ).bind(TEST_BINDING);
    await gw(TEST_MODEL, { messages: [] }, undefined);

    const records = ledger.query(SCOPE);
    expect(records).toHaveLength(1);
    // The provider's own usage payload is kept verbatim and mapped with the
    // provider's native metering semantics.
    expect(records[0]?.raw_usage).toEqual(wire);
    expect(records[0]?.usage.provenance).toBe("provider_wire");
    expect(records[0]?.usage.input).toMatchObject({ tokens: 1000, included_in: null });
    expect(records[0]?.usage.cache_read).toMatchObject({ tokens: 300, included_in: "input" });
    expect(records[0]?.usage.reasoning).toMatchObject({ tokens: 120, included_in: "output" });
    expect(records[0]?.usage.total_tokens).toBe(1500);
  });
});
