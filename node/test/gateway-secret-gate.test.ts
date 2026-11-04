import type { Api, Context, Message, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";

import type {
  GatewayAttemptEvent,
  GatewayEventSink,
  GatewayPolicy,
  ProviderAdapter,
  SecretFinding,
  SecretScanPolicy,
  SecretScanReport,
  SecretScanner,
} from "../src/index.js";
import {
  DATA_CLASSES,
  ModelDispatchError,
  ModelEgressDeniedError,
  createModelGateway,
  createPatternSecretScanner,
  createStaticCredentialStore,
  createStaticPolicyResolver,
  tagDerivedSummary,
} from "../src/index.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_BINDING,
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_SCOPE,
  memorySink,
  securityStubs,
  testPolicyFor,
} from "./helpers/test-gateway.js";

const CONTEXT: Context = { messages: [] };
const CLEAN_CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function okStream(): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
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
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      },
    });
  });
  return stream;
}

interface SpyAdapter {
  adapter: ProviderAdapter;
  calls: { model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined }[];
}

function spyAdapter(behavior?: (call: number) => void): SpyAdapter {
  const calls: SpyAdapter["calls"] = [];
  return {
    adapter: {
      stream(model, context, options) {
        calls.push({ model, context, options });
        behavior?.(calls.length);
        return okStream();
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

function gatewayWith(
  adapter: ProviderAdapter,
  extras: {
    policy?: GatewayPolicy;
    scanner?: SecretScanner;
    scanPolicy?: SecretScanPolicy;
    scanTimeoutMs?: number;
    sink?: GatewayEventSink;
    onIncident?: (message: string) => void;
  } = {},
) {
  return createModelGateway({
    policyResolver: createStaticPolicyResolver(
      extras.policy ?? testPolicyFor(TEST_MODEL),
      TEST_SCOPE,
    ),
    credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
    adapter,
    scanner: extras.scanner ?? createPatternSecretScanner(),
    ...(extras.scanPolicy ? { scanPolicy: extras.scanPolicy } : {}),
    ...(extras.scanTimeoutMs !== undefined ? { scanTimeoutMs: extras.scanTimeoutMs } : {}),
    // Dispatch needs its required audit sink; default an in-memory one unless
    // the test deliberately omits it.
    sink: extras.sink ?? memorySink().sink,
    ...(extras.onIncident ? { onIncident: extras.onIncident } : {}),
    ...securityStubs(),
    newInvocationId: () => "inv_test",
    now: () => new Date("2026-11-03T00:00:00Z"),
  });
}

async function expectScanDenial(
  promise: unknown,
  reason: string,
  code: string,
): Promise<ModelEgressDeniedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelEgressDeniedError);
    const denial = error as ModelEgressDeniedError;
    expect(denial.code).toBe(code);
    expect(denial.reason).toBe(reason);
    expect(denial.retryable).toBe(false);
    return denial;
  }
  throw new Error("expected a model egress denial");
}

/**
 * Adversarial secret corpus: realistic secret shapes planted at every kind of
 * request position. Each must send zero bytes wherever the request goes.
 * The literals are assembled at runtime on purpose: repository secret
 * scanning must not flag the fixtures themselves.
 */
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GITHUB_PAT = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const PRIVATE_KEY =
  `-----BEGIN RSA PRIVATE ` +
  `KEY-----\nMIIEpAIBAAKCAq8dQzT1pQ\n-----END RSA PRIVATE ` +
  `KEY-----`;
const OPENAI_VALUE = "sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
const OPENAI_ASSIGNMENT = "OPENAI_API_KEY=" + OPENAI_VALUE;
const JWT =
  "eyJhbGciOiJIUzI1NiJ9." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkdmVyc2FyaWFsIn0." +
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const SLACK_TOKEN = "xoxb" + "-123456789012-123456789012-abcdefghijklmnopqrstuvwx";
const BEARER = "Bearer " + "dXNlcjpwYXNzd29yZC1zdHJpbmctMDAxMjM0NTY3ODk";
const HIGH_ENTROPY = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW";

function toolResult(content: string, details?: unknown): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "dsh_request_action",
    content: [{ type: "text", text: content }],
    ...(details !== undefined ? { details } : {}),
    isError: false,
    timestamp: 1,
  };
}

function assistant(text: string, thinking?: string): Message {
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
    stopReason: "stop",
    timestamp: 1,
    content: [
      ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
      { type: "text", text },
    ],
  };
}

const ADVERSARIAL_PLACEMENTS: { name: string; secret: string; context: Context }[] = [
  {
    name: "AWS key in a log line of a tool result",
    secret: AWS_KEY,
    context: { messages: [toolResult(`2026-11-03T10:00:00Z INFO deploy key=${AWS_KEY}`)] },
  },
  {
    name: "GitHub PAT in history",
    secret: GITHUB_PAT,
    context: { messages: [assistant(`found ${GITHUB_PAT} in the old log`)] },
  },
  {
    name: "private key block in a code fence of the user message",
    secret: PRIVATE_KEY,
    context: {
      messages: [
        { role: "user", content: `please inspect:\n\`\`\`\n${PRIVATE_KEY}\n\`\`\``, timestamp: 1 },
      ],
    },
  },
  {
    name: "API key assignment inside a diff in tool result details",
    secret: OPENAI_VALUE,
    context: {
      messages: [
        toolResult("diff --git a/.env b/.env\n-KEY=x\n+KEY=y", { patch: OPENAI_ASSIGNMENT }),
      ],
    },
  },
  {
    name: "JWT in assistant thinking",
    secret: JWT,
    context: { messages: [assistant("continuing", `token is ${JWT}`)] },
  },
  {
    name: "Slack token in tool call arguments",
    secret: SLACK_TOKEN,
    context: {
      messages: [
        {
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
          stopReason: "toolUse",
          timestamp: 1,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "dsh_request_action",
              arguments: { rationale: `rotate ${SLACK_TOKEN}` },
            },
          ],
        },
      ],
    },
  },
  {
    name: "bearer token in the system prompt",
    secret: BEARER,
    context: { systemPrompt: `credentials for review: ${BEARER}`, messages: [] },
  },
  {
    name: "high-entropy token in the user message",
    secret: HIGH_ENTROPY,
    context: { messages: [{ role: "user", content: `blob ${HIGH_ENTROPY}`, timestamp: 1 }] },
  },
  {
    name: "secret in tool result content",
    secret: GITHUB_PAT,
    context: { messages: [toolResult(`exported ${GITHUB_PAT}`)] },
  },
  {
    name: "secret in a tool definition description",
    secret: AWS_KEY,
    context: {
      messages: [],
      tools: [
        {
          name: "t",
          description: `authenticates with ${AWS_KEY}`,
          parameters: { type: "object" } as never,
        },
      ],
    },
  },
];

describe("adversarial secrets send zero request bytes (DAT-209 acceptance 1)", () => {
  for (const placement of ADVERSARIAL_PLACEMENTS) {
    test(`${placement.name} — external endpoint`, async () => {
      const { adapter, calls } = spyAdapter();
      const gateway = gatewayWith(adapter);
      await expectScanDenial(
        gateway.bind(TEST_BINDING)(TEST_MODEL, placement.context, undefined),
        "SENSITIVE_DATA_UNCERTAIN",
        "SENSITIVE_DATA_UNCERTAIN",
      );
      expect(calls).toHaveLength(0);
    });

    test(`${placement.name} — internal endpoint`, async () => {
      const { adapter, calls } = spyAdapter();
      const internalPolicy: GatewayPolicy = {
        ...testPolicyFor(TEST_MODEL),
        revision: "test-policy-internal",
        endpoints: [
          {
            endpointId: "ep_internal",
            provider: TEST_MODEL.provider,
            api: TEST_MODEL.api,
            baseUrl: "http://10.0.0.9/v1",
            internal: true,
            credentialRef: TEST_CREDENTIAL_REF,
            models: [TEST_MODEL.id],
            permittedDataClasses: [...DATA_CLASSES],
          },
        ],
      };
      const gateway = gatewayWith(adapter, { policy: internalPolicy });
      await expectScanDenial(
        gateway.bind(TEST_BINDING)(
          { ...TEST_MODEL, baseUrl: "http://10.0.0.9/v1" },
          placement.context,
          undefined,
        ),
        "SENSITIVE_DATA_UNCERTAIN",
        "SENSITIVE_DATA_UNCERTAIN",
      );
      expect(calls).toHaveLength(0);
    });
  }

  test("retries and fallbacks cannot bypass the gate", async () => {
    for (const placement of ADVERSARIAL_PLACEMENTS) {
      const { adapter, calls } = spyAdapter();
      const policy: GatewayPolicy = {
        ...testPolicyFor(TEST_MODEL),
        retry: { maxAttempts: 3 },
        fallbacks: [{ endpointId: "ep_test", modelId: TEST_MODEL.id }],
      };
      const gateway = gatewayWith(adapter, { policy });
      await expectScanDenial(
        gateway.bind(TEST_BINDING)(TEST_MODEL, placement.context, undefined),
        "SENSITIVE_DATA_UNCERTAIN",
        "SENSITIVE_DATA_UNCERTAIN",
      );
      expect(calls).toHaveLength(0);
    }
  });

  test("model switching cannot bypass the gate", async () => {
    const { adapter, calls } = spyAdapter();
    const policy = testPolicyFor(TEST_MODEL);
    const twoModels: GatewayPolicy = {
      ...policy,
      endpoints: [{ ...policy.endpoints[0]!, models: ["m-one", "m-two"] }],
    };
    const gateway = gatewayWith(adapter, { policy: twoModels });
    const context: Context = {
      messages: [{ role: "user", content: `key ${AWS_KEY}`, timestamp: 1 }],
    };
    for (const modelId of ["m-one", "m-two"]) {
      await expectScanDenial(
        gateway.bind(TEST_BINDING)({ ...TEST_MODEL, id: modelId }, context, undefined),
        "SENSITIVE_DATA_UNCERTAIN",
        "SENSITIVE_DATA_UNCERTAIN",
      );
    }
    expect(calls).toHaveLength(0);
  });

  test("a later retry re-runs the gate; tightened scanner rules block the retry", async () => {
    // Attempt 1 scans clean and fails transport-classified; between attempts
    // the scanner starts flagging (e.g. a rule update). The retry is a fresh
    // invocation: it re-scans and blocks — the fallback never dispatches.
    let scans = 0;
    const escalating: SecretScanner = {
      id: "escalating",
      ruleVersion: "1",
      scan(request): SecretScanReport {
        scans += 1;
        const findings: SecretFinding[] =
          scans > 1
            ? request.segments.map((segment) => ({
                classification: "secret_suspected" as const,
                detector: "late-detector",
                ruleVersion: "1",
                segmentId: segment.id,
              }))
            : [];
        return {
          scanner: "escalating",
          ruleVersion: "1",
          classification: findings.length > 0 ? "secret_suspected" : "clean",
          findings,
        };
      },
    };
    const { adapter, calls } = spyAdapter(() => {
      throw new ModelDispatchError("transient", true);
    });
    const policy: GatewayPolicy = {
      ...testPolicyFor(TEST_MODEL),
      retry: { maxAttempts: 2 },
      fallbacks: [{ endpointId: "ep_test", modelId: TEST_MODEL.id }],
    };
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, { policy, scanner: escalating, sink });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SENSITIVE_DATA_UNCERTAIN",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    // Only the first (clean) attempt reached the provider; the retry and the
    // fallback sent nothing.
    expect(calls).toHaveLength(1);
    expect(scans).toBe(2);
    const denials = events.filter(
      (event) => event.phase === "outcome" && event.outcome === "denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ denyReason: "SENSITIVE_DATA_UNCERTAIN" });
  });
});

describe("scanner failure, unknown classification, missing audit sink block (acceptance 2)", () => {
  test("a failing scanner blocks with zero bytes", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanner: {
        id: "broken",
        ruleVersion: "1",
        scan() {
          throw new Error("scanner backend down");
        },
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("a hung scanner blocks with zero bytes", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanTimeoutMs: 10,
      scanner: {
        id: "hang",
        ruleVersion: "1",
        scan: () => new Promise<SecretScanReport>(() => undefined),
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("a scanner report inventing material not in the request blocks with zero bytes", async () => {
    // QA B1: a reported match that does not occur in its segment can never be
    // removed — the report is invalid and the untouched request is never sent.
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanner: {
        id: "inventing",
        ruleVersion: "1",
        scan: (request) => ({
          scanner: "inventing",
          ruleVersion: "1",
          classification: "secret_suspected",
          findings: [
            {
              classification: "secret_suspected",
              detector: "inventing-detector",
              ruleVersion: "1",
              segmentId: request.segments[0]?.id ?? "",
              match: "made-up-material-never-in-the-request",
            },
          ],
        }),
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("an unknown classification blocks with zero bytes", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanner: {
        id: "opaque",
        ruleVersion: "1",
        scan: (request) => ({
          scanner: "opaque",
          ruleVersion: "1",
          classification: "unknown",
          findings: [
            {
              classification: "unknown",
              detector: "opaque-detector",
              ruleVersion: "1",
              segmentId: request.segments[0]?.id ?? "",
            },
          ],
        }),
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "CLASSIFICATION_UNKNOWN",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("a missing required audit sink blocks with zero bytes", async () => {
    const { adapter, calls } = spyAdapter();
    // Deliberately constructed without a sink: required pre-dispatch evidence
    // has nowhere to go, so nothing may be sent.
    const gateway = createModelGateway({
      policyResolver: createStaticPolicyResolver(testPolicyFor(TEST_MODEL), TEST_SCOPE),
      credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
      adapter,
      scanner: createPatternSecretScanner(),
      ...securityStubs(),
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "AUDIT_UNAVAILABLE",
      "MODEL_EGRESS_DENIED",
    );
    expect(calls).toHaveLength(0);
  });

  test("a failing pre-dispatch audit write blocks the dispatch", async () => {
    const { adapter, calls } = spyAdapter();
    const sink: GatewayEventSink = {
      record(event: GatewayAttemptEvent) {
        if (event.phase === "pre_dispatch") throw new Error("audit store down");
      },
    };
    const gateway = gatewayWith(adapter, { sink });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "AUDIT_UNAVAILABLE",
      "MODEL_EGRESS_DENIED",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("destination data-class authorization", () => {
  test("an endpoint with no permitted data classes is denied (missing authorization)", async () => {
    const { adapter, calls } = spyAdapter();
    const policy = testPolicyFor(TEST_MODEL);
    const unauthorized: GatewayPolicy = {
      ...policy,
      endpoints: [
        {
          ...policy.endpoints[0]!,
          permittedDataClasses: undefined,
        },
      ],
    };
    const gateway = gatewayWith(adapter, { policy: unauthorized });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "AUTHORIZATION_MISSING",
      "MODEL_EGRESS_DENIED",
    );
    expect(calls).toHaveLength(0);
  });

  test("a request class the destination is not authorized for is denied", async () => {
    const { adapter, calls } = spyAdapter();
    const policy = testPolicyFor(TEST_MODEL);
    const narrow: GatewayPolicy = {
      ...policy,
      endpoints: [{ ...policy.endpoints[0]!, permittedDataClasses: ["user_input"] }],
    };
    const gateway = gatewayWith(adapter, { policy: narrow });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, { messages: [toolResult("tool output")] }, undefined),
      "DATA_CLASS_NOT_AUTHORIZED",
      "MODEL_EGRESS_DENIED",
    );
    expect(calls).toHaveLength(0);
  });

  test("authorized classes dispatch normally", async () => {
    const { adapter, calls } = spyAdapter();
    const policy = testPolicyFor(TEST_MODEL);
    const narrow: GatewayPolicy = {
      ...policy,
      endpoints: [{ ...policy.endpoints[0]!, permittedDataClasses: ["user_input"] }],
    };
    const gateway = gatewayWith(adapter, { policy: narrow });
    await (
      await gateway.bind(TEST_BINDING)(
        TEST_MODEL,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        undefined,
      )
    ).result();
    expect(calls).toHaveLength(1);
  });
});

describe("summarization cannot bypass the gate (acceptance, classification inheritance)", () => {
  const summaryContext = (
    sourceClassifications: Array<"clean" | "secret_suspected" | "secret_confirmed" | "unknown">,
    classificationPolicy?: { id: string; version: string },
  ): Context => ({
    messages: [
      { role: "user", content: "earlier work happened", timestamp: 1 },
      tagDerivedSummary(
        { role: "user", content: "summary: earlier work happened", timestamp: 3 },
        { sourceClassifications, ...(classificationPolicy ? { classificationPolicy } : {}) },
      ),
    ],
  });

  test("a derived summary of secret-bearing history sends zero bytes", async () => {
    const { adapter, calls } = spyAdapter();
    // The literal secret is nowhere in the request text; the summary derives
    // from secret-bearing sources and inherits their classification.
    const gateway = gatewayWith(adapter);
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, summaryContext(["secret_confirmed"]), undefined),
      "SENSITIVE_DATA_UNCERTAIN",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("an unauthorized claimed policy cannot launder the classification", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanPolicy: {
        derivedClassification: { id: "summ-1", version: "1", authorized: false },
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(
        TEST_MODEL,
        summaryContext(["secret_suspected"], { id: "summ-1", version: "1" }),
        undefined,
      ),
      "AUTHORIZATION_MISSING",
      "MODEL_EGRESS_DENIED",
    );
    expect(calls).toHaveLength(0);
  });

  test("an authorized deterministic policy may change the classification", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanPolicy: {
        derivedClassification: { id: "summ-1", version: "1", authorized: true },
      },
    });
    await (
      await gateway.bind(TEST_BINDING)(
        TEST_MODEL,
        summaryContext(["secret_confirmed"], { id: "summ-1", version: "1" }),
        undefined,
      )
    ).result();
    expect(calls).toHaveLength(1);
  });
});

describe("minimized requests dispatch only the verified-minimized content", () => {
  test("authorized minimization sends the request with the secret removed", async () => {
    const { adapter, calls } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      scanPolicy: {
        minimization: {
          id: "min-1",
          version: "1",
          authorized: true,
          appliesTo: { detectors: ["high-entropy-token"] },
        },
      },
    });
    // Suspected (high-entropy) material, not a confirmed secret shape:
    // confirmed secrets always block for human handling and are never
    // auto-minimized.
    const context: Context = {
      messages: [
        {
          role: "user",
          content: `dump env ${HIGH_ENTROPY} now`,
          timestamp: 1,
        },
      ],
    };
    await (await gateway.bind(TEST_BINDING)(TEST_MODEL, context, undefined)).result();
    expect(calls).toHaveLength(1);
    // The adapter received the minimized request: the secret value is gone.
    const dispatched = JSON.stringify(calls[0]?.context);
    expect(dispatched).not.toContain(HIGH_ENTROPY);
    expect(dispatched).toContain("[redacted]");
    const pre = events.find((event) => event.phase === "pre_dispatch");
    expect(pre && "scan" in pre ? pre.scan.minimization : undefined).toMatchObject({
      policyId: "min-1",
      verified: true,
    });
    // The original context object was never mutated.
    expect(JSON.stringify(context)).toContain(HIGH_ENTROPY);
  });
});

describe("errors, logs, and analytics contain no secrets (acceptance 3)", () => {
  test("denial errors, audit events, and incidents never carry secret material", async () => {
    const secrets = ADVERSARIAL_PLACEMENTS.map((placement) => placement.secret);
    const incidents: string[] = [];
    const { adapter } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      onIncident: (message) => incidents.push(message),
    });
    for (const placement of ADVERSARIAL_PLACEMENTS) {
      const denial = await expectScanDenial(
        gateway.bind(TEST_BINDING)(TEST_MODEL, placement.context, undefined),
        "SENSITIVE_DATA_UNCERTAIN",
        "SENSITIVE_DATA_UNCERTAIN",
      );
      for (const secret of secrets) {
        expect(denial.message).not.toContain(secret);
      }
    }
    const serialized = JSON.stringify(events) + JSON.stringify(incidents);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    // Scan evidence carries detector identities and counts only.
    const denial = events.find((event) => event.phase === "outcome" && event.outcome === "denied");
    expect(denial && "scan" in denial && denial.scan ? denial.scan.detectors : []).toContain(
      "aws-access-key-id",
    );
    expect(denial && "detail" in denial ? denial.detail : "").not.toContain(AWS_KEY);
  });

  test("scanner error text is never propagated into errors or events", async () => {
    const { adapter } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      scanner: {
        id: "leaky",
        ruleVersion: "1",
        scan() {
          throw new Error(`scanner failed on ${AWS_KEY}`);
        },
      },
    });
    const denial = await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(denial.message).not.toContain(AWS_KEY);
    expect(JSON.stringify(events)).not.toContain(AWS_KEY);
  });

  test("detector identifiers cannot smuggle secrets into errors or audit events", async () => {
    // QA B2: detector names are scanner-provided text. A report stuffing a
    // secret into the detector field is invalid; neither the denial nor the
    // audit/analytics event stream ever contains it.
    const leak = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const { adapter, calls } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      scanner: {
        id: "smuggler",
        ruleVersion: "1",
        scan: (request) => ({
          scanner: "smuggler",
          ruleVersion: "1",
          classification: "secret_suspected",
          findings: [
            {
              classification: "secret_suspected",
              detector: `detector ${leak}`,
              ruleVersion: "1",
              segmentId: request.segments[0]?.id ?? "",
            },
          ],
        }),
      },
    });
    const denial = await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
    expect(denial.message).not.toContain(leak);
    expect(JSON.stringify(events)).not.toContain(leak);
  });

  test("an AWS access key ID cannot pass as a scanner id or detector id", async () => {
    // QA round-2 B2: credential-shaped identifiers (AKIA + 16 characters pass
    // token-shape alone) are rejected; nothing reaches errors or audit events.
    const awsId = "AKIA" + "IOSFODNN7EXAMPLE";
    const { adapter, calls } = spyAdapter();
    const { sink, events } = recordingSink();
    const asScannerId = gatewayWith(adapter, {
      sink,
      scanner: {
        id: awsId,
        ruleVersion: "1",
        scan: () => ({
          scanner: "ignored",
          ruleVersion: "1",
          classification: "clean",
          findings: [],
        }),
      },
    });
    await expectScanDenial(
      asScannerId.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    const asDetectorId = gatewayWith(adapter, {
      sink,
      scanner: {
        id: "smuggler",
        ruleVersion: "1",
        scan: (request) => ({
          scanner: "smuggler",
          ruleVersion: "1",
          classification: "secret_suspected",
          findings: [
            {
              classification: "secret_suspected",
              detector: awsId,
              ruleVersion: "1",
              segmentId: request.segments[0]?.id ?? "",
            },
          ],
        }),
      },
    });
    await expectScanDenial(
      asDetectorId.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(awsId);
  });

  test("a prototype-property classification never lets a request through", async () => {
    // QA round-2 B1: `classification: "toString"` with no findings used to
    // join to clean and dispatch; it must block like any malformed report.
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter, {
      scanner: {
        id: "proto",
        ruleVersion: "1",
        scan: () =>
          ({
            scanner: "proto",
            ruleVersion: "1",
            classification: "toString",
            findings: [],
          }) as unknown as SecretScanReport,
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the complete request is scanned, not just the latest message (acceptance 4)", () => {
  test("a secret only in old history blocks while the latest message is clean", async () => {
    const { adapter, calls } = spyAdapter();
    const gateway = gatewayWith(adapter);
    const context: Context = {
      messages: [
        assistant(`earlier turn leaked ${GITHUB_PAT}`),
        { role: "user", content: "what is the current status?", timestamp: 2 },
      ],
    };
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, context, undefined),
      "SENSITIVE_DATA_UNCERTAIN",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(calls).toHaveLength(0);
  });

  test("every request segment is offered to the scanner, including tools and history", async () => {
    const seen: string[] = [];
    const recorder: SecretScanner = {
      id: "recording",
      ruleVersion: "1",
      scan(request) {
        seen.push(...request.segments.map((segment) => segment.text));
        return { scanner: "recording", ruleVersion: "1", classification: "clean", findings: [] };
      },
    };
    const { adapter } = spyAdapter();
    const gateway = gatewayWith(adapter, { scanner: recorder });
    const context: Context = {
      systemPrompt: "system-leaf",
      tools: [
        { name: "t", description: "tool-desc-leaf", parameters: { type: "object" } as never },
      ],
      messages: [
        { role: "user", content: "user-leaf", timestamp: 1 },
        assistant("history-leaf"),
        toolResult("tool-result-leaf", { nested: "tool-details-leaf" }),
      ],
    };
    await (await gateway.bind(TEST_BINDING)(TEST_MODEL, context, undefined)).result();
    for (const leaf of [
      "system-leaf",
      "tool-desc-leaf",
      "user-leaf",
      "history-leaf",
      "tool-result-leaf",
      "tool-details-leaf",
    ]) {
      expect(seen).toContain(leaf);
    }
  });
});

describe("untrusted report accessors cannot leak into denials or audit events (QA round-3)", () => {
  test("a detector getter fires once and its second-read text never reaches sink events", async () => {
    // Regression bullet 1 at the gateway: first read a valid detector token,
    // second read arbitrary request text. The invocation blocks with zero
    // bytes; neither the denial nor the audit/analytics event stream carries
    // the second-read text.
    const second = "kernel panic in production";
    let detectorReads = 0;
    const finding: Record<string, unknown> = {
      classification: "secret_suspected",
      ruleVersion: "1",
      segmentId: "messages[0].content",
    };
    Object.defineProperty(finding, "detector", {
      get() {
        detectorReads += 1;
        return detectorReads === 1 ? "stub-detector" : second;
      },
      enumerable: true,
      configurable: true,
    });
    const { adapter, calls } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      scanner: {
        id: "flipper",
        ruleVersion: "1",
        scan: () =>
          ({
            scanner: "flipper",
            ruleVersion: "1",
            classification: "secret_suspected",
            findings: [finding],
          }) as unknown as SecretScanReport,
      },
    });
    const denial = await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(detectorReads).toBe(1);
    expect(calls).toHaveLength(0);
    expect(denial.message).not.toContain(second);
    expect(JSON.stringify(events)).not.toContain(second);
    expect(JSON.stringify(events)).not.toContain("stub-detector");
  });

  test("an index accessor on findings cannot smuggle a minimizable finding through", async () => {
    // QA re-review zero-byte case: if the index getter's finding were
    // accepted, it would be eligible for authorized minimization, the second
    // (clean) scan would verify the removal, and the request would be
    // dispatched. The descriptor pre-check rejects it before the getter ever
    // runs — the provider sees nothing.
    let scans = 0;
    let indexReads = 0;
    const findings: unknown[] = ["placeholder"];
    Object.defineProperty(findings, "0", {
      get() {
        indexReads += 1;
        return {
          classification: "secret_suspected",
          detector: "high-entropy-token",
          ruleVersion: "1",
          segmentId: "messages[0].content",
          match: "hello",
        };
      },
      enumerable: true,
      configurable: true,
    });
    const { adapter, calls: adapterCalls } = spyAdapter();
    const { sink, events } = recordingSink();
    const gateway = gatewayWith(adapter, {
      sink,
      scanPolicy: {
        minimization: {
          id: "min-1",
          version: "1",
          authorized: true,
          appliesTo: { detectors: ["high-entropy-token"] },
        },
      },
      scanner: {
        id: "flipper",
        ruleVersion: "1",
        scan: () => {
          scans += 1;
          return scans === 1
            ? ({
                scanner: "flipper",
                ruleVersion: "1",
                classification: "secret_suspected",
                findings,
              } as unknown as SecretScanReport)
            : { scanner: "flipper", ruleVersion: "1", classification: "clean", findings: [] };
        },
      },
    });
    await expectScanDenial(
      gateway.bind(TEST_BINDING)(TEST_MODEL, CLEAN_CONTEXT, undefined),
      "SCANNER_UNAVAILABLE",
      "SENSITIVE_DATA_UNCERTAIN",
    );
    expect(indexReads).toBe(0);
    expect(scans).toBe(1);
    expect(adapterCalls).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("high-entropy-token");
  });
});
