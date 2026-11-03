import { describe, expect, test } from "vitest";

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context } from "@mariozechner/pi-ai";

import {
  BudgetStore,
  createBudgetAuthority,
  createStaticBudgetPolicyResolver,
  type BudgetAuthority,
  type BudgetPolicy,
} from "../src/budget/index.js";
import {
  ModelBudgetReconciliationError,
  ModelEgressDeniedError,
  createModelGateway,
  createPatternSecretScanner,
  createStaticCredentialStore,
  createScopeBackedPolicyResolver,
} from "../src/index.js";
import type { GatewayPolicy, ProviderAdapter } from "../src/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_BINDING,
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_ENDPOINT_BASE_URL,
  TEST_SCOPE,
  memorySink,
  securityStubs,
  testPolicyFor,
} from "./helpers/test-gateway.js";
import { BUDGET_ACCESS, BUDGET_SCOPE, testBudgetPolicy } from "./helpers/budget-fixtures.js";

const CONTEXT: Context = { messages: [] };

function assistantMessage(text: string, totalTokens = 0): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: {
      input: Math.floor(totalTokens / 2),
      output: totalTokens - Math.floor(totalTokens / 2),
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
}

function okStream(text = "ok", totalTokens = 15): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: assistantMessage(text, totalTokens) });
  });
  return stream;
}

function providerErrorStream(detail: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: {
        ...assistantMessage(""),
        content: [],
        stopReason: "error",
        errorMessage: detail,
      },
    });
  });
  return stream;
}

function emptyStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.end();
  });
  return stream;
}

function contentThenEndStream(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(text, 10);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
    stream.end();
  });
  return stream;
}

function abortedStream(text?: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const aborted: AssistantMessage = {
    ...assistantMessage(text ?? ""),
    content: [],
    stopReason: "aborted",
    errorMessage: "aborted by caller",
  };
  queueMicrotask(() => {
    if (text !== undefined) {
      const message = assistantMessage(text, 10);
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
    }
    stream.push({ type: "error", reason: "aborted", error: aborted });
  });
  return stream;
}

function transportError(code: string): Error {
  return Object.assign(new Error(`socket ${code}`), { code });
}

function spyAdapter(behavior: (call: number) => AssistantMessageEventStream | Error): {
  adapter: ProviderAdapter;
  calls: () => number;
} {
  let count = 0;
  return {
    adapter: {
      stream() {
        count += 1;
        const result = behavior(count);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    },
    calls: () => count,
  };
}

function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `inv_${n}`;
  };
}

function buildGateway(options: {
  policy?: BudgetPolicy;
  gatewayPolicy?: GatewayPolicy;
  adapter: ProviderAdapter;
  budget?: BudgetAuthority | undefined;
  withoutBudget?: boolean;
  onIncident?: (message: string) => void;
}) {
  const store = new BudgetStore();
  const budget = options.withoutBudget
    ? undefined
    : (options.budget ??
      createBudgetAuthority({
        store,
        policyResolver: createStaticBudgetPolicyResolver(
          options.policy ?? testBudgetPolicy(),
          BUDGET_SCOPE,
        ),
      }));
  const gateway = createModelGateway({
    policyResolver: createScopeBackedPolicyResolver([
      { scope: TEST_SCOPE, policy: options.gatewayPolicy ?? testPolicyFor(TEST_MODEL) },
    ]),
    credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
    adapter: options.adapter,
    scanner: createPatternSecretScanner(),
    sink: memorySink().sink,
    newInvocationId: counterIds(),
    now: () => new Date("2026-11-03T00:00:00Z"),
    ...securityStubs(),
    ...(budget ? { budget } : {}),
    ...(options.onIncident ? { onIncident: options.onIncident } : {}),
  });
  return { gateway, store, budget };
}

function dispatch(gateway: ReturnType<typeof buildGateway>["gateway"]) {
  const streamFn = gateway.bind(TEST_BINDING);
  return streamFn({ ...TEST_MODEL, baseUrl: TEST_ENDPOINT_BASE_URL }, CONTEXT, {});
}

describe("gateway budget enforcement", () => {
  test("reserves before dispatch and settles observed usage", async () => {
    const { adapter } = spyAdapter(() => okStream("ok", 15));
    const { gateway, store } = buildGateway({ adapter });
    const stream = await dispatch(gateway);
    await stream.result();

    const reservations = store.list(BUDGET_ACCESS);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("settled");
    expect(reservations[0]?.tokens.used).toBe(15);
    expect(reservations[0]?.tokens.bound).toBe(208_192);
    // 15 tokens at the conservative ceiling is an internal estimate, labelled
    // as such; it is not presented as a bill.
    expect(reservations[0]?.money[0]).toMatchObject({
      used: "0.00015",
      completeness: "estimated",
      source: "bound_ceiling",
    });
  });

  test("blocks a dispatch when a budget scope is exhausted, without calling the provider", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const { gateway } = buildGateway({
      adapter,
      policy: testBudgetPolicy({
        workspace: { monetary: [{ currency: "USD", amount: "1" }], tokens: null },
      }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      name: "ModelEgressDeniedError",
      code: "MODEL_BUDGET_EXHAUSTED",
      reason: "BUDGET_EXHAUSTED",
      retryable: false,
    });
    expect(calls()).toBe(0);
  });

  test("blocks a budget with no finite conservative bound for the model", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const { gateway } = buildGateway({
      adapter,
      policy: testBudgetPolicy({
        cost_ceilings: [
          {
            endpoint_id: null,
            model_id: "another-model",
            currency: "USD",
            amount_per_1000_tokens: "0.01",
          },
        ],
      }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      code: "MODEL_BUDGET_UNAVAILABLE",
      reason: "BUDGET_BOUND_UNKNOWN",
      retryable: false,
    });
    expect(calls()).toBe(0);
  });

  test("blocks a dispatch whose conservative token bound exceeds the ceiling", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const { gateway } = buildGateway({
      adapter,
      policy: testBudgetPolicy({ max_tokens_per_invocation: 100_000 }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      code: "MODEL_TOKEN_CEILING_EXCEEDED",
      reason: "TOKEN_CEILING_EXCEEDED",
      retryable: false,
    });
    expect(calls()).toBe(0);
  });

  test("keeps the reservation and refuses to retry an unknown provider outcome", async () => {
    const { adapter, calls } = spyAdapter(() => transportError("ECONNRESET"));
    const { gateway, store } = buildGateway({
      adapter,
      gatewayPolicy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 3 } }),
    });
    await expect(dispatch(gateway)).rejects.toBeInstanceOf(ModelBudgetReconciliationError);
    expect(calls()).toBe(1);
    const reservation = store.list(BUDGET_ACCESS)[0];
    expect(reservation?.status).toBe("reconciling");
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(208_192);
  });

  test("refunds an attempt that provably never left the gateway", async () => {
    const { adapter, calls } = spyAdapter(() => transportError("ENOTFOUND"));
    const { gateway, store } = buildGateway({
      adapter,
      gatewayPolicy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({ name: "ModelDispatchError" });
    expect(calls()).toBe(2);
    const reservations = store.list(BUDGET_ACCESS);
    expect(reservations.map((reservation) => reservation.status)).toEqual(["released", "released"]);
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace")).toMatchObject({
      tokens: 0,
      monetary: [],
    });
  });

  test("every retry reserves and settles its own attempt", async () => {
    const { adapter, calls } = spyAdapter((call) =>
      call === 1 ? providerErrorStream("temporary upstream outage") : okStream("ok", 20),
    );
    const { gateway, store } = buildGateway({
      adapter,
      gatewayPolicy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    const stream = await dispatch(gateway);
    await stream.result();
    expect(calls()).toBe(2);
    const reservations = store.list(BUDGET_ACCESS);
    expect(reservations).toHaveLength(2);
    // The failed attempt reported no usage: its bound stays committed as
    // unknown instead of becoming a free retry.
    expect(reservations[0]?.status).toBe("reconciling");
    expect(reservations[1]?.status).toBe("settled");
    expect(reservations[1]?.tokens.used).toBe(20);
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(208_192 + 20);
  });

  test("a settlement failure never breaks the delivered stream", async () => {
    const incidents: string[] = [];
    const store = new BudgetStore();
    const authority = createBudgetAuthority({
      store,
      policyResolver: createStaticBudgetPolicyResolver(testBudgetPolicy(), BUDGET_SCOPE),
    });
    const faulty: BudgetAuthority = Object.create(authority) as BudgetAuthority;
    (faulty as unknown as { settleUsage: () => never }).settleUsage = () => {
      throw new Error("journal unavailable");
    };
    const { adapter } = spyAdapter(() => okStream("ok", 5));
    const { gateway } = buildGateway({
      adapter,
      budget: faulty,
      onIncident: (message) => incidents.push(message),
    });
    const stream = await dispatch(gateway);
    const message = await stream.result();
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(incidents.join("\n")).toContain("budget settlement failed");
    // The reservation keeps its conservative bound.
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(208_192);
  });

  test("a stream that ends without a terminal event fails with MODEL_USAGE_UNKNOWN", async () => {
    const { adapter, calls } = spyAdapter(() => emptyStream());
    const { gateway, store } = buildGateway({
      adapter,
      gatewayPolicy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 3 } }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      name: "ModelBudgetReconciliationError",
      code: "MODEL_USAGE_UNKNOWN",
      retryable: false,
    });
    expect(calls()).toBe(1);
    const reservation = store.list(BUDGET_ACCESS)[0];
    expect(reservation?.status).toBe("reconciling");
    expect(store.scopeUsage(BUDGET_ACCESS, "workspace").tokens).toBe(208_192);
  });

  test("a handed-off stream that ends without a terminal event ends in MODEL_USAGE_UNKNOWN", async () => {
    const { adapter } = spyAdapter(() => contentThenEndStream("partial"));
    const { gateway, store } = buildGateway({ adapter });
    const stream = await dispatch(gateway);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.reason).toBe("error");
      expect(last.error.errorMessage).toContain("MODEL_USAGE_UNKNOWN");
    }
    expect(store.list(BUDGET_ACCESS)[0]?.status).toBe("reconciling");
  });

  test("a caller abort is surfaced as MODEL_USAGE_UNKNOWN and never retried", async () => {
    const { adapter, calls } = spyAdapter(() => abortedStream());
    const { gateway, store } = buildGateway({
      adapter,
      gatewayPolicy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 3 } }),
    });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      name: "ModelBudgetReconciliationError",
      code: "MODEL_USAGE_UNKNOWN",
    });
    expect(calls()).toBe(1);
    expect(store.list(BUDGET_ACCESS)[0]?.status).toBe("reconciling");
  });

  test("a caller abort after content ends the handed-off stream in MODEL_USAGE_UNKNOWN", async () => {
    const { adapter } = spyAdapter(() => abortedStream("partial"));
    const { gateway } = buildGateway({ adapter });
    const stream = await dispatch(gateway);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.reason).toBe("error");
      expect(last.error.errorMessage).toContain("MODEL_USAGE_UNKNOWN");
    }
  });

  test("the unknown-outcome contract also holds without a budget authority", async () => {
    const { adapter } = spyAdapter(() => emptyStream());
    const { gateway } = buildGateway({ adapter, withoutBudget: true });
    await expect(dispatch(gateway)).rejects.toMatchObject({
      code: "MODEL_USAGE_UNKNOWN",
      retryable: false,
    });
  });

  test("denies an invalid policy as a budget configuration refusal", async () => {
    const store = new BudgetStore();
    const gateway = createModelGateway({
      policyResolver: createScopeBackedPolicyResolver([
        { scope: TEST_SCOPE, policy: testPolicyFor(TEST_MODEL) },
      ]),
      credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
      adapter: spyAdapter(() => okStream()).adapter,
      scanner: createPatternSecretScanner(),
      sink: memorySink().sink,
      ...securityStubs(),
      budget: createBudgetAuthority({
        store,
        policyResolver: {
          resolve() {
            return undefined;
          },
        },
      }),
    });
    await expect(dispatch(gateway)).rejects.toBeInstanceOf(ModelEgressDeniedError);
    await expect(dispatch(gateway)).rejects.toMatchObject({
      code: "MODEL_BUDGET_UNAVAILABLE",
      reason: "BUDGET_UNAVAILABLE",
    });
  });
});
