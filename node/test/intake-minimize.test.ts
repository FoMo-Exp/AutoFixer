import { describe, expect, test } from "vitest";

import {
  ModelEgressDeniedError,
  createModelGateway,
  createStaticCredentialStore,
  denyAllPolicyResolver,
} from "../src/gateway/index.js";
import { buildAnalysisContext, dispatchBriefing } from "../src/intake/analysis.js";
import { minimizeSignal } from "../src/intake/minimize.js";
import type { MinimizeInput, ModelSignalBriefing } from "../src/intake/minimize.js";
import { TEST_MODEL, scriptedStream } from "./helpers/scripted-stream.js";
import { TEST_BINDING, scriptedGateway, securityStubs } from "./helpers/test-gateway.js";

const rawInput: MinimizeInput = {
  signal_key: "fp1:abc",
  severity: "error",
  service: "checkout",
  environment: "prod",
  error_class: "TimeoutError",
  error_signature: "TimeoutError | checkout <n> timed out | checkout.ts:processOrder",
  message:
    "checkout 1234 timed out reading /var/app/secrets/key.pem with Bearer sk-live-abcdef123456",
  stack_locations: ["/var/app/src/services/checkout.ts:42 in processOrder"],
  occurrences: 3,
  rate: { count: 3, window_seconds: 300 },
};

describe("signal minimization", () => {
  test("keeps only the allowlisted briefing fields", () => {
    const briefing = minimizeSignal({
      ...rawInput,
      // Extra provider noise that must never reach a model.
      ...({
        payload: { token: "sk-secret-value" },
        labels: { team: "payments" },
        provider_event_id: "evt-1",
      } as object),
    });

    expect(Object.keys(briefing).sort()).toEqual(
      [
        "environment",
        "error_class",
        "error_signature",
        "message_excerpt",
        "occurrences",
        "rate",
        "service",
        "severity",
        "signal_key",
        "stack_locations",
      ].sort(),
    );
    expect(JSON.stringify(briefing)).not.toContain("sk-secret-value");
    expect(JSON.stringify(briefing)).not.toContain("evt-1");
    expect(JSON.stringify(briefing)).not.toContain("payments");
  });

  test("scrubs secrets and host paths from the message excerpt", () => {
    const briefing = minimizeSignal(rawInput);
    expect(briefing.message_excerpt).not.toContain("sk-live-abcdef123456");
    expect(briefing.message_excerpt).not.toContain("/var/app/secrets/key.pem");
    expect(briefing.message_excerpt).not.toContain("1234");
  });

  test("reduces stack locations to canonical file:function frames", () => {
    const briefing = minimizeSignal(rawInput);
    expect(briefing.stack_locations).toEqual(["checkout.ts:processOrder"]);
    expect(JSON.stringify(briefing.stack_locations)).not.toContain("/var/app");
  });

  test("truncates long message excerpts", () => {
    const briefing = minimizeSignal({ ...rawInput, message: "x".repeat(1000) });
    expect(briefing.message_excerpt.length).toBeLessThanOrEqual(160);
  });

  test("scrubs credential material from every raw-derived briefing field", () => {
    const briefing = minimizeSignal({
      ...rawInput,
      error_class: "sk-live-abcdef123456",
      error_signature:
        "sk-live-abcdef123456 | failed with API_KEY=prod-secret-value | ghp_abcdef1234567890.ts:run",
      message: "failed with API_KEY=prod-secret-value",
      stack_locations: ["run (/var/app/ghp_abcdef1234567890.ts:1)"],
    });
    const serialized = JSON.stringify(briefing);

    expect(serialized).not.toContain("sk-live-abcdef123456");
    expect(serialized).not.toContain("prod-secret-value");
    expect(serialized).not.toContain("ghp_abcdef1234567890");
    expect(serialized).not.toContain("/var/app");
  });
});

describe("model dispatch through the ADR-0005 gateway", () => {
  const briefing: ModelSignalBriefing = minimizeSignal(rawInput);

  test("the analysis context carries only briefing content", () => {
    const context = buildAnalysisContext(briefing);
    const text = context.messages.map((message) => String(message.content)).join("\n");

    expect(text).toContain(briefing.message_excerpt);
    expect(text).toContain(briefing.error_signature);
    expect(text).toContain("fp1:abc");
    expect(text).not.toContain("1234");
    expect(text).not.toContain("/var/app");
  });

  test("briefings are dispatched through the gateway and nothing else", async () => {
    const scripted = scriptedStream([{ kind: "text", text: "analyzed" }]);
    const gateway = scriptedGateway(TEST_MODEL, scripted.streamFn);

    const stream = await dispatchBriefing({
      gateway,
      model: TEST_MODEL,
      identity: TEST_BINDING,
      briefing,
    });
    await stream.result();

    expect(scripted.calls).toHaveLength(1);
    const visible = (scripted.calls[0] ?? []).join("\n");
    expect(visible).toContain(briefing.message_excerpt);
    expect(visible).not.toContain("1234");
    expect(visible).not.toContain("sk-live-abcdef123456");
  });

  test("the analysis context scrubs credentials even from a hand-built briefing", () => {
    const poisoned: ModelSignalBriefing = {
      ...briefing,
      error_class: "sk-live-abcdef123456",
      error_signature: "TimeoutError | Bearer sk-live-abcdef123456 | f",
      message_excerpt: "token ghp_abcdef1234567890 and API_KEY=prod-secret-value",
    };

    const text = buildAnalysisContext(poisoned)
      .messages.map((message) => String(message.content))
      .join("\n");

    expect(text).not.toContain("sk-live-abcdef123456");
    expect(text).not.toContain("ghp_abcdef1234567890");
    expect(text).not.toContain("prod-secret-value");
  });

  test("credentials in a briefing never reach the provider stream", async () => {
    const scripted = scriptedStream([{ kind: "text", text: "analyzed" }]);
    const gateway = scriptedGateway(TEST_MODEL, scripted.streamFn);
    const poisoned: ModelSignalBriefing = {
      ...briefing,
      error_signature: "TimeoutError | Bearer sk-live-abcdef123456 | f",
    };

    const stream = await dispatchBriefing({
      gateway,
      model: TEST_MODEL,
      identity: TEST_BINDING,
      briefing: poisoned,
    });
    await stream.result();

    const visible = (scripted.calls[0] ?? []).join("\n");
    expect(visible).not.toContain("sk-live-abcdef123456");
  });

  test("a gateway denial fails closed and reaches no provider", async () => {
    const scripted = scriptedStream([{ kind: "text", text: "analyzed" }]);
    // No policy resolves for this scope: every dispatch is denied.
    const gateway = createModelGateway({
      policyResolver: denyAllPolicyResolver,
      credentials: createStaticCredentialStore({}),
      adapter: { stream: scripted.streamFn },
      ...securityStubs(),
    });

    await expect(
      dispatchBriefing({
        gateway,
        model: TEST_MODEL,
        identity: TEST_BINDING,
        briefing,
      }),
    ).rejects.toBeInstanceOf(ModelEgressDeniedError);
    expect(scripted.calls).toHaveLength(0);
  });
});
