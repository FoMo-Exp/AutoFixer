import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";

import type { OrchestratorConfig } from "../src/config.js";
import type { PiSessionOptions } from "../src/pi/session.js";
import { PiSession } from "../src/pi/session.js";
import {
  ModelDispatchError,
  ModelEgressDeniedError,
  PROVIDER_CREDENTIAL_ENV_VARS,
  buildAdapterOptions,
  createModelGateway,
  createStaticCredentialStore,
  createStaticPolicyResolver,
  createOrchestrator,
  denyAllPolicyResolver,
  validateGatewayPolicy,
} from "../src/index.js";
import type {
  GatewayAttemptEvent,
  GatewayEventSink,
  GatewayPolicy,
  ProviderAdapter,
} from "../src/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_BINDING,
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_ENDPOINT_BASE_URL,
  TEST_SCOPE,
  testPolicyFor,
} from "./helpers/test-gateway.js";

const CONTEXT: Context = { messages: [] };

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
}

function okStream(text = "ok"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
  });
  return stream;
}

function failingStream(detail: string): AssistantMessageEventStream {
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

function contentThenFailingStream(text: string, detail: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(text);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
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

interface AdapterCall {
  model: Model<Api>;
  options: SimpleStreamOptions | undefined;
}

function spyAdapter(behavior: (call: number, model: Model<Api>) => AssistantMessageEventStream): {
  adapter: ProviderAdapter;
  calls: AdapterCall[];
} {
  const calls: AdapterCall[] = [];
  return {
    adapter: {
      stream(model: Model<Api>, _context: Context, options?: SimpleStreamOptions) {
        calls.push({ model, options });
        return behavior(calls.length, model);
      },
    },
    calls,
  };
}

function recordingSink(): { sink: GatewayEventSink; events: GatewayAttemptEvent[] } {
  const events: GatewayAttemptEvent[] = [];
  return {
    sink: {
      record(event: GatewayAttemptEvent) {
        events.push(event);
      },
    },
    events,
  };
}

function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `inv_${n}`;
  };
}

function gatewayWith(
  adapter: ProviderAdapter,
  extras: {
    policy?: GatewayPolicy;
    credentials?: Record<string, string>;
    sink?: GatewayEventSink;
    onIncident?: (message: string) => void;
  } = {},
) {
  return createModelGateway({
    policyResolver: extras.policy
      ? createStaticPolicyResolver(extras.policy, TEST_SCOPE)
      : createStaticPolicyResolver(testPolicyFor(TEST_MODEL), TEST_SCOPE),
    credentials: createStaticCredentialStore(
      extras.credentials ?? { [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL },
    ),
    adapter,
    ...(extras.sink ? { sink: extras.sink } : {}),
    ...(extras.onIncident ? { onIncident: extras.onIncident } : {}),
    newInvocationId: counterIds(),
    now: () => new Date("2026-11-03T00:00:00Z"),
  });
}

describe("gateway dispatch", () => {
  test("pins the registered endpoint and credential, records identity, sanitizes options", async () => {
    const { adapter, calls } = spyAdapter(() => okStream("hello"));
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, { sink });
    const streamFn = gateway.bind(TEST_BINDING);

    const stream = await streamFn({ ...TEST_MODEL, baseUrl: TEST_ENDPOINT_BASE_URL }, CONTEXT, {
      temperature: 0.5,
      maxRetries: 7,
      headers: { "x-smuggled": "1" },
      onPayload: () => undefined,
      metadata: { user_id: "leak" },
    });
    const message = await stream.result();

    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.baseUrl).toBe(TEST_ENDPOINT_BASE_URL);
    expect(calls[0]?.model.provider).toBe("openai");
    expect(calls[0]?.options?.apiKey).toBe(TEST_CREDENTIAL);
    // Caller retry knobs and payload hooks never reach the provider protocol.
    expect(calls[0]?.options?.maxRetries).toBe(0);
    expect(calls[0]?.options?.temperature).toBe(0.5);
    expect(calls[0]?.options).not.toHaveProperty("headers");
    expect(calls[0]?.options).not.toHaveProperty("onPayload");
    expect(calls[0]?.options).not.toHaveProperty("metadata");

    expect(events.map((event) => event.phase)).toEqual(["pre_dispatch", "outcome"]);
    expect(events[0]).toMatchObject({ phase: "pre_dispatch", attempt: 1 });
    expect(events[0]?.identity).toEqual({
      ...TEST_BINDING,
      invocationId: "inv_1",
    });
    expect(events[0]).toMatchObject({
      policyRevision: "test-policy-1",
      destination: {
        endpointId: "ep_test",
        provider: "openai",
        modelId: "scripted",
        internal: false,
      },
    });
    expect(events[1]).toMatchObject({ phase: "outcome", outcome: "dispatched" });
    expect(events[1]?.identity.invocationId).toBe("inv_1");
    expect(events[1]).toMatchObject({ timestamp: "2026-11-03T00:00:00.000Z" });
  });

  test("every attempt carries its own invocation id under one trace", async () => {
    const { adapter, calls } = spyAdapter((call) =>
      call === 1 ? okStream("one") : okStream("two"),
    );
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    const streamFn = gateway.bind(TEST_BINDING);

    await (await streamFn(TEST_MODEL, CONTEXT, undefined)).result();
    await (await streamFn(TEST_MODEL, CONTEXT, undefined)).result();

    expect(calls).toHaveLength(2);
    const planned = events.filter((event) => event.phase === "pre_dispatch");
    expect(planned.map((event) => event.identity.invocationId)).toEqual(["inv_1", "inv_2"]);
    for (const event of planned) {
      expect(event.identity.traceId).toBe(TEST_BINDING.traceId);
      expect(event.identity.issueId).toBe(TEST_BINDING.issueId);
      expect(event.identity.runId).toBe(TEST_BINDING.runId);
    }
  });
});

describe("gateway denials", () => {
  async function expectDenial(promise: unknown, reason: string): Promise<ModelEgressDeniedError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ModelEgressDeniedError);
      const denial = error as ModelEgressDeniedError;
      expect(denial.code).toBe("MODEL_EGRESS_DENIED");
      expect(denial.reason).toBe(reason);
      expect(denial.retryable).toBe(false);
      return denial;
    }
    throw new Error("expected a model egress denial");
  }

  test("missing policy fails closed", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const gateway = createModelGateway({
      policyResolver: denyAllPolicyResolver,
      credentials: createStaticCredentialStore({}),
      adapter,
      newInvocationId: counterIds(),
    });
    await expectDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "POLICY_UNAVAILABLE",
    );
    expect(calls).toHaveLength(0);
  });

  test("unapproved model and unapproved endpoint are rejected", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const gateway = gatewayWith(adapter);
    const streamFn = gateway.bind(TEST_BINDING);

    await expectDenial(
      streamFn({ ...TEST_MODEL, id: "not-approved" }, CONTEXT, undefined),
      "MODEL_NOT_APPROVED",
    );
    await expectDenial(
      streamFn({ ...TEST_MODEL, baseUrl: "https://evil.example.com/v1" }, CONTEXT, undefined),
      "ENDPOINT_NOT_APPROVED",
    );
    expect(calls).toHaveLength(0);
  });

  test("an unregistered internal-looking endpoint is rejected like any other", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const gateway = gatewayWith(adapter);
    await expectDenial(
      gateway.bind(TEST_BINDING)(
        { ...TEST_MODEL, baseUrl: "http://10.0.0.9/v1" },
        CONTEXT,
        undefined,
      ),
      "ENDPOINT_NOT_APPROVED",
    );
    expect(calls).toHaveLength(0);
  });

  test("missing credentials fail closed and ambient env keys are never used", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, { credentials: {}, sink });
    process.env["OPENAI_API_KEY"] = "ambient-env-secret";
    try {
      const denial = await expectDenial(
        gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
        "CREDENTIAL_MISSING",
      );
      expect(denial.message).not.toContain("ambient-env-secret");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
    expect(calls).toHaveLength(0);
    const outcome = events.find((event) => event.phase === "outcome");
    expect(outcome).toMatchObject({
      outcome: "denied",
      denyReason: "CREDENTIAL_MISSING",
      policyRevision: "test-policy-1",
      destination: {
        endpointId: "ep_test",
        provider: "openai",
        modelId: "scripted",
        internal: false,
      },
    });
  });

  test("a caller-supplied credential is an attempted bypass and is rejected", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const gateway = gatewayWith(adapter);
    await expectDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, { apiKey: "attacker-key" }),
      "CALLER_CREDENTIAL_SUPPLIED",
    );
    expect(calls).toHaveLength(0);
  });

  test("a policy switch mid-retries cannot move the call to another endpoint", async () => {
    const policy = testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } });
    const moved: GatewayPolicy = {
      revision: "test-policy-2",
      endpoints: [
        {
          endpointId: "ep_other",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://other.test/v1",
          internal: false,
          credentialRef: "cred_other",
          models: [TEST_MODEL.id],
        },
      ],
      retry: { maxAttempts: 2 },
    };
    const { adapter, calls } = spyAdapter((call) => {
      if (call === 1) throw new ModelDispatchError("transient", true);
      return okStream();
    });
    const gateway = createModelGateway({
      policyResolver: {
        // The schedule read and the first attempt see the original policy;
        // the retry sees a policy that moved the model to another endpoint.
        resolve: () => {
          reads += 1;
          return reads <= 2 ? policy : moved;
        },
      },
      credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
      adapter,
      newInvocationId: counterIds(),
    });
    let reads = 0;
    await expectDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "ENDPOINT_NOT_APPROVED",
    );
    expect(calls.map((call) => call.model.baseUrl)).toEqual([TEST_ENDPOINT_BASE_URL]);
  });
});

describe("gateway retry, fallback, and model switching", () => {
  test("retries only retryable failures, each as its own checked invocation", async () => {
    const { adapter, calls } = spyAdapter((call) => {
      if (call === 1) throw new ModelDispatchError("transient", true);
      return okStream("recovered");
    });
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    const message = await (
      await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)
    ).result();

    expect(message.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(calls).toHaveLength(2);
    expect(events.map((event) => [event.phase, event.attempt])).toEqual([
      ["pre_dispatch", 1],
      ["outcome", 1],
      ["pre_dispatch", 2],
      ["outcome", 2],
    ]);
    const outcomes = events.filter((event) => event.phase === "outcome");
    expect(outcomes[0]).toMatchObject({ outcome: "failed" });
    expect(outcomes[1]).toMatchObject({ outcome: "dispatched" });
  });

  test("non-retryable failures are not retried and not fallen back", async () => {
    const policy = testPolicyFor(TEST_MODEL, {
      retry: { maxAttempts: 3 },
      fallbacks: [{ endpointId: "ep_test", modelId: TEST_MODEL.id }],
    });
    const { adapter, calls } = spyAdapter(() => {
      throw new ModelDispatchError("401 unauthorized", false);
    });
    const gateway = gatewayWith(adapter, { policy });
    await expect(
      Promise.resolve(gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)),
    ).rejects.toMatchObject({
      code: "MODEL_DISPATCH_FAILED",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  test("a failed stream before content is retried; one with content is not replayed", async () => {
    const retried = spyAdapter((call) =>
      call === 1 ? failingStream("connection reset") : okStream("second try"),
    );
    const gateway = gatewayWith(retried.adapter, {
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    const message = await (
      await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)
    ).result();
    expect(message.content).toEqual([{ type: "text", text: "second try" }]);
    expect(retried.calls).toHaveLength(2);

    const streamed = spyAdapter(() => contentThenFailingStream("partial work", "late failure"));
    const { sink, events: sinkEvents } = recordingSink();
    const strictGateway = gatewayWith(streamed.adapter, {
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 3 } }),
      sink,
    });
    const stream = await strictGateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined);
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    expect(streamed.calls).toHaveLength(1);
    expect(events).toContain("text_start");
    expect(events).toContain("error");
    // A stream that terminates in an error is a failed invocation, not a
    // dispatch — even though content already flowed.
    const outcome = sinkEvents.find((event) => event.phase === "outcome");
    expect(outcome).toMatchObject({ outcome: "failed", detail: "late failure" });
  });

  test("hands the stream to the caller while the provider is still generating", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "start", partial: { ...assistantMessage("first"), content: [] } });
    inner.push({ type: "text_start", contentIndex: 0, partial: assistantMessage("first") });
    const { adapter } = spyAdapter(() => inner);
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, { sink });

    // No terminal event exists on `inner` yet: a buffered implementation could
    // never resolve this call, only a streaming handoff at first content does.
    const stream = await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined);
    // The attempt's outcome is not knowable before the terminal event.
    expect(events.some((event) => event.phase === "outcome")).toBe(false);

    const seen: string[] = [];
    const consumed = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") seen.push(event.delta);
      }
    })();
    inner.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "first",
      partial: assistantMessage("first"),
    });
    inner.push({ type: "done", reason: "stop", message: assistantMessage("first") });
    await consumed;

    expect(seen).toEqual(["first"]);
    const outcome = events.find((event) => event.phase === "outcome");
    expect(outcome).toMatchObject({ outcome: "dispatched" });
  });

  test("retry classification only reads structured client-error markers", async () => {
    const retried = spyAdapter((call) =>
      call === 1 ? failingStream("404 tests failed in CI") : okStream("recovered"),
    );
    const gateway = gatewayWith(retried.adapter, {
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 2 } }),
    });
    await (await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)).result();
    // Bare numbers in prose are not client errors: the attempt retried.
    expect(retried.calls).toHaveLength(2);

    const auth = spyAdapter(() => failingStream("HTTP 401 from provider"));
    const authGateway = gatewayWith(auth.adapter, {
      policy: testPolicyFor(TEST_MODEL, { retry: { maxAttempts: 3 } }),
    });
    await expect(
      Promise.resolve(authGateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)),
    ).rejects.toMatchObject({ code: "MODEL_DISPATCH_FAILED", retryable: false });
    expect(auth.calls).toHaveLength(1);
  });

  test("exhausted retryable failures fall back to the approved fallback destination", async () => {
    const policy: GatewayPolicy = {
      revision: "test-policy-fallback",
      endpoints: [
        {
          endpointId: "ep_a",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://a.test/v1",
          internal: false,
          credentialRef: "cred_a",
          models: ["m-a"],
        },
        {
          endpointId: "ep_b",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://b.test/v1",
          internal: false,
          credentialRef: "cred_b",
          models: ["m-b"],
        },
      ],
      retry: { maxAttempts: 2 },
      fallbacks: [{ endpointId: "ep_b", modelId: "m-b" }],
    };
    const { adapter, calls } = spyAdapter((call, model) => {
      if (model.id === "m-a") throw new ModelDispatchError("transient", true);
      return okStream("from fallback");
    });
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      policy,
      credentials: { cred_a: "secret-a", cred_b: "secret-b" },
      sink,
    });
    const message = await (
      await gateway.bind(TEST_BINDING)({ ...TEST_MODEL, id: "m-a" }, CONTEXT, undefined)
    ).result();

    expect(message.content).toEqual([{ type: "text", text: "from fallback" }]);
    expect(calls.map((call) => [call.model.id, call.model.baseUrl, call.options?.apiKey])).toEqual([
      ["m-a", "https://a.test/v1", "secret-a"],
      ["m-a", "https://a.test/v1", "secret-a"],
      ["m-b", "https://b.test/v1", "secret-b"],
    ]);
    const destinations = events
      .filter((event) => event.phase === "pre_dispatch")
      .map((event) => event.destination?.endpointId);
    expect(destinations).toEqual(["ep_a", "ep_a", "ep_b"]);
  });

  test("fallback destinations pass the same checks; missing fallback credential denies", async () => {
    const policy = testPolicyFor(TEST_MODEL, {
      retry: { maxAttempts: 1 },
      fallbacks: [{ endpointId: "ep_test", modelId: TEST_MODEL.id }],
    });
    const { adapter } = spyAdapter(() => {
      throw new ModelDispatchError("transient", true);
    });
    const gateway = gatewayWith(adapter, { policy, credentials: {} });
    await expect(
      Promise.resolve(gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)),
    ).rejects.toBeInstanceOf(ModelEgressDeniedError);
  });

  test("model switching re-resolves destination and cannot bypass checks", async () => {
    const policy: GatewayPolicy = {
      revision: "test-policy-switch",
      endpoints: [
        {
          endpointId: "ep_1",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://one.test/v1",
          internal: false,
          credentialRef: "cred_1",
          models: ["m-1"],
        },
        {
          endpointId: "ep_2",
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://two.test/v1",
          internal: false,
          credentialRef: "cred_2",
          models: ["m-2"],
        },
      ],
      retry: { maxAttempts: 1 },
    };
    const { adapter, calls } = spyAdapter(() => okStream());
    const gateway = gatewayWith(adapter, {
      policy,
      credentials: { cred_1: "secret-1", cred_2: "secret-2" },
    });
    const streamFn = gateway.bind(TEST_BINDING);

    await (await streamFn({ ...TEST_MODEL, id: "m-1" }, CONTEXT, undefined)).result();
    await (await streamFn({ ...TEST_MODEL, id: "m-2" }, CONTEXT, undefined)).result();
    await expect(streamFn({ ...TEST_MODEL, id: "m-3" }, CONTEXT, undefined)).rejects.toMatchObject({
      code: "MODEL_EGRESS_DENIED",
      reason: "MODEL_NOT_APPROVED",
    });
    await (await streamFn({ ...TEST_MODEL, id: "m-1" }, CONTEXT, undefined)).result();

    expect(calls.map((call) => [call.model.id, call.model.baseUrl, call.options?.apiKey])).toEqual([
      ["m-1", "https://one.test/v1", "secret-1"],
      ["m-2", "https://two.test/v1", "secret-2"],
      ["m-1", "https://one.test/v1", "secret-1"],
    ]);
  });
});

describe("gateway redaction and audit sink", () => {
  test("provider credentials never surface in errors or events", async () => {
    const { adapter, calls } = spyAdapter(() => {
      throw new Error(`boom with key ${TEST_CREDENTIAL} and sk-abcdef1234567890`);
    });
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, { sink });
    try {
      await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined);
      throw new Error("expected dispatch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelDispatchError);
      const message = (error as Error).message;
      expect(message).not.toContain(TEST_CREDENTIAL);
      expect(message).not.toContain("sk-abcdef1234567890");
      expect(message).toContain("[redacted]");
    }
    expect(calls).toHaveLength(1);
    const outcome = events.find((event) => event.phase === "outcome");
    expect(outcome).toMatchObject({ outcome: "failed" });
    if (outcome && "detail" in outcome && outcome.detail) {
      expect(outcome.detail).not.toContain(TEST_CREDENTIAL);
      expect(outcome.detail).not.toContain("sk-abcdef1234567890");
    }
  });

  test("a failing pre-dispatch audit write blocks the dispatch", async () => {
    const { adapter, calls } = spyAdapter(() => okStream());
    const sink: GatewayEventSink = {
      record(event: GatewayAttemptEvent) {
        if (event.phase === "pre_dispatch") throw new Error("audit store down");
      },
    };
    const gateway = gatewayWith(adapter, { sink });
    try {
      await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined);
      throw new Error("expected a denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelEgressDeniedError);
      expect((error as ModelEgressDeniedError).reason).toBe("AUDIT_UNAVAILABLE");
    }
    expect(calls).toHaveLength(0);
  });

  test("a failing outcome audit write raises an incident without failing the dispatch", async () => {
    const { adapter } = spyAdapter(() => okStream("sent"));
    const incidents: string[] = [];
    const sink: GatewayEventSink = {
      record(event: GatewayAttemptEvent) {
        if (event.phase === "outcome") throw new Error("audit store down");
      },
    };
    const gateway = gatewayWith(adapter, {
      sink,
      onIncident: (message) => {
        incidents.push(message);
      },
    });
    const message = await (
      await gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)
    ).result();
    expect(message.content).toEqual([{ type: "text", text: "sent" }]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toContain("outcome audit write failed");
  });
});

describe("policy registration", () => {
  const baseEndpoint = {
    endpointId: "ep",
    provider: "openai",
    api: "openai-completions",
    internal: false,
    credentialRef: "cred",
    models: ["m"],
  };

  test("fallbacks cannot name unregistered endpoints or unapproved models", () => {
    expect(() =>
      validateGatewayPolicy({
        revision: "r",
        endpoints: [{ ...baseEndpoint, baseUrl: "https://ok.test/v1" }],
        retry: { maxAttempts: 1 },
        fallbacks: [{ endpointId: "ep-missing", modelId: "m" }],
      }),
    ).toThrow(/not a registered endpoint/);
    expect(() =>
      validateGatewayPolicy({
        revision: "r",
        endpoints: [{ ...baseEndpoint, baseUrl: "https://ok.test/v1" }],
        retry: { maxAttempts: 1 },
        fallbacks: [{ endpointId: "ep", modelId: "other" }],
      }),
    ).toThrow(/not approved/);
  });

  test("registration validates endpoint hygiene", () => {
    expect(() =>
      validateGatewayPolicy({
        revision: "r",
        endpoints: [{ ...baseEndpoint, baseUrl: "http://plain.test/v1" }],
        retry: { maxAttempts: 1 },
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateGatewayPolicy({
        revision: "r",
        endpoints: [{ ...baseEndpoint, baseUrl: "https://user:pass@ok.test/v1" }],
        retry: { maxAttempts: 1 },
      }),
    ).toThrow(/credentials/);
    // An explicitly registered internal instance may be plain HTTP.
    expect(() =>
      validateGatewayPolicy({
        revision: "r",
        endpoints: [{ ...baseEndpoint, baseUrl: "http://10.0.0.9/v1", internal: true }],
        retry: { maxAttempts: 1 },
      }),
    ).not.toThrow();
  });
});

describe("adapter option hardening", () => {
  test("buildAdapterOptions keeps only safe knobs and forces the credential", () => {
    const controller = new AbortController();
    const options = buildAdapterOptions(
      {
        apiKey: "caller",
        maxRetries: 9,
        headers: { "x-smuggled": "1" },
        onPayload: () => undefined,
        onResponse: () => undefined,
        metadata: { user_id: "leak" },
        temperature: 0.2,
        maxTokens: 128,
        signal: controller.signal,
        reasoning: "low",
        sessionId: "sess",
        timeoutMs: 5000,
      },
      "gateway-secret",
    );
    expect(options).toEqual({
      apiKey: "gateway-secret",
      maxRetries: 0,
      temperature: 0.2,
      maxTokens: 128,
      signal: controller.signal,
      reasoning: "low",
      sessionId: "sess",
      timeoutMs: 5000,
    });
  });
});

describe("pi session egress boundary", () => {
  test("PiSession refuses to run without the gateway-bound streamFn", () => {
    // Deliberately erase the type for this runtime-guard test: JS callers and
    // type assertions can still hand the constructor options without streamFn.
    const withoutStreamFn = {
      sessionId: "session_test",
      systemPrompt: "prompt",
      model: TEST_MODEL,
      tools: [],
      listener: () => undefined,
    } as unknown as PiSessionOptions;
    expect(() => new PiSession(withoutStreamFn)).toThrow(/gateway-bound streamFn/);
  });
});

describe("deployment-layer env bypass guard", () => {
  function minimalConfig(tokenFile: string): OrchestratorConfig {
    return {
      dshSocketPath: path.join(tokenFile, "dsh.sock"),
      apiHost: "127.0.0.1",
      apiPort: 0,
      apiTokenFile: path.join(tokenFile, "api-token"),
      repositoryId: "github:Luthiel/AutoFixer",
      repositoryUrl: "https://github.com/Luthiel/AutoFixer.git",
      baseRef: "main",
      baseSha: "52081eaddca099967fd8be13b3060337fde50d3f",
      actorId: "usr_test",
      actorDisplayName: "Test",
      approverIdentity: "github:test",
      pathHints: ["node"],
      toolCapabilities: ["echo"],
      maxWallClockSeconds: 60,
      enterpriseId: "ent_test",
      workspaceId: "ws_test",
    };
  }

  test("the orchestrator refuses to start while ambient provider credentials exist", () => {
    const tokenDir = mkdtempSync(path.join(tmpdir(), "forgepilot-gateway-guard-"));
    process.env["ANTHROPIC_API_KEY"] = "ambient-secret";
    try {
      expect(() => createOrchestrator({ config: minimalConfig(tokenDir) })).toThrow(
        /provider credentials must not be configured via the environment/,
      );
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  test("without gateway files the deployment gateway denies every call", async () => {
    const tokenDir = mkdtempSync(path.join(tmpdir(), "forgepilot-gateway-deny-"));
    // The guard tests the deployment contract, not this machine's ambient
    // shell: scrub provider credential variables for the duration of the call.
    const saved = PROVIDER_CREDENTIAL_ENV_VARS.map((name) => [name, process.env[name]] as const);
    for (const [name] of saved) delete process.env[name];
    try {
      const orchestrator = createOrchestrator({ config: minimalConfig(tokenDir) });
      await expect(
        Promise.resolve(orchestrator.gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined)),
      ).rejects.toMatchObject({ code: "MODEL_EGRESS_DENIED", reason: "POLICY_UNAVAILABLE" });
    } finally {
      for (const [name, value] of saved) {
        if (value !== undefined) process.env[name] = value;
      }
    }
  });
});
